import {
	CalDavCalendarEventReadModelError,
	CalendarEventReadModelErrorCode,
	createCalendarEventPreservationContext,
	mapCalendarEventResourceWithTimeZoneContext,
} from '../icalendar/eventReadModel';
import type { CalendarEventReadResult } from '../icalendar/eventReadModel';
import type { CalendarEventTimeZoneExecutionContext } from '../discovery/timeZoneReferences';
import { ICALENDAR_MAX_RESOURCE_BYTES, parseICalendarResource } from '../icalendar/parser';
import type { ICalendarResource } from '../icalendar/parser';
import { CalDavMethod, CalDavNotFoundError, decodeCalDavTextBody } from '../transport/http';
import type { CalDavTransport } from '../transport/http';
import { resolveCalDavHref, validateAbsoluteHttpUrl } from '../transport/url';
import type { AbsoluteHttpUrl } from '../transport/url';
import { CalDavEventUidLookupStrategy } from '../providers/types';
import { parseDavMultiStatus } from '../xml/parser';
import type { DavProperty, DavPropertyResponse } from '../xml/parser';
import {
	buildCalendarMultigetReport,
	buildCalendarUidQueryReport,
	buildPropfindRequest,
} from '../xml/requests';
import {
	calendarEventResourceUrlForBase64Uid,
	calendarEventResourceUrlForEncodedUid,
} from './resourceName';

export const CalendarEventUidResolutionFailureCode = Object.freeze({
	NOT_FOUND: 'CALENDAR_EVENT_UID_NOT_FOUND',
	AMBIGUOUS: 'AMBIGUOUS_CALENDAR_EVENT_UID',
	INCOMPLETE: 'INCOMPLETE_CALENDAR_EVENT_UID_LOOKUP',
	LIMIT_EXCEEDED: 'CALENDAR_EVENT_UID_LOOKUP_LIMIT_EXCEEDED',
	INVALID_RESPONSE: 'INVALID_CALENDAR_EVENT_UID_RESPONSE',
} as const);

export type CalendarEventUidResolutionFailureCode =
	(typeof CalendarEventUidResolutionFailureCode)[keyof typeof CalendarEventUidResolutionFailureCode];

const ERROR_MESSAGES: Readonly<Record<CalendarEventUidResolutionFailureCode, string>> = {
	CALENDAR_EVENT_UID_NOT_FOUND:
		'No calendar event with the requested UID was found in the selected calendar.',
	AMBIGUOUS_CALENDAR_EVENT_UID:
		'More than one calendar event with the requested UID was found in the selected calendar.',
	INCOMPLETE_CALENDAR_EVENT_UID_LOOKUP:
		'The calendar event UID lookup could not be completed safely.',
	CALENDAR_EVENT_UID_LOOKUP_LIMIT_EXCEEDED:
		'The calendar event UID lookup exceeded its safety limits.',
	INVALID_CALENDAR_EVENT_UID_RESPONSE:
		'The CalDAV server returned an invalid calendar-event UID response.',
};

export class CalDavCalendarEventUidResolutionError extends Error {
	readonly code: CalendarEventUidResolutionFailureCode;

	constructor(code: CalendarEventUidResolutionFailureCode) {
		super(ERROR_MESSAGES[code]);
		this.name = 'CalDavCalendarEventUidResolutionError';
		this.code = code;
	}
}

const ICLOUD_UID_LOOKUP_BATCH_SIZE = 50;
const ICLOUD_UID_LOOKUP_MAX_RESOURCES = 1_000;
const ICLOUD_UID_LOOKUP_MAX_BODY_BYTES = 32 * 1024 * 1024;
const ICLOUD_UID_LOOKUP_MAX_ELAPSED_MS = 60_000;

const DAV_NAMESPACE = 'DAV:';
const CALDAV_NAMESPACE = 'urn:ietf:params:xml:ns:caldav';

interface RequestedProperties {
	readonly etag?: string;
	readonly calendarData: string;
}

interface CanonicalResource {
	readonly etag?: string;
	readonly calendarData: string;
}

interface ListedResource {
	readonly href: string;
	readonly resourceUrl: AbsoluteHttpUrl;
}

interface ResourceListing {
	readonly resources: readonly ListedResource[];
	readonly bodyBytes: number;
}

interface ResourceCandidate {
	readonly resource: ICalendarResource;
	readonly resourceUrl: AbsoluteHttpUrl;
	readonly etag?: string;
}

interface CandidateGetResult {
	readonly bodyBytes: number;
	readonly candidate?: ResourceCandidate;
}

function fail(code: CalendarEventUidResolutionFailureCode): never {
	throw new CalDavCalendarEventUidResolutionError(code);
}

function invalidResponse(): never {
	return fail(CalendarEventUidResolutionFailureCode.INVALID_RESPONSE);
}

function incomplete(): never {
	return fail(CalendarEventUidResolutionFailureCode.INCOMPLETE);
}

function checkBudget(startedAt: number, resources?: number, bytes?: number): void {
	if (
		Date.now() - startedAt > ICLOUD_UID_LOOKUP_MAX_ELAPSED_MS ||
		(resources !== undefined && resources > ICLOUD_UID_LOOKUP_MAX_RESOURCES) ||
		(bytes !== undefined && bytes > ICLOUD_UID_LOOKUP_MAX_BODY_BYTES)
	) {
		return fail(CalendarEventUidResolutionFailureCode.LIMIT_EXCEEDED);
	}
}

function isExpandedName(property: DavProperty, namespaceUri: string, localName: string): boolean {
	return property.name.namespaceUri === namespaceUri && property.name.localName === localName;
}

function readCharacterText(property: DavProperty, allowAttributes: boolean): string {
	if (!allowAttributes && property.attributes.length !== 0) {
		return invalidResponse();
	}

	let value = '';
	for (const child of property.children) {
		if (child.kind === 'element') {
			return invalidResponse();
		}
		value += child.value;
	}
	return value;
}

function requestedProperties(
	response: DavPropertyResponse,
	allowMissingEtag: boolean,
): RequestedProperties {
	const etags: DavProperty[] = [];
	const calendarDataValues: DavProperty[] = [];
	for (const propstat of response.propstats) {
		if (!propstat.status.isSuccessful) {
			continue;
		}

		for (const property of propstat.properties) {
			if (isExpandedName(property, DAV_NAMESPACE, 'getetag')) {
				etags.push(property);
			} else if (isExpandedName(property, CALDAV_NAMESPACE, 'calendar-data')) {
				calendarDataValues.push(property);
			}
		}
	}

	if (
		etags.length > 1 ||
		(etags.length === 0 && !allowMissingEtag) ||
		calendarDataValues.length !== 1
	) {
		return invalidResponse();
	}

	return {
		...(etags.length === 0 ? {} : { etag: readCharacterText(etags[0], false) }),
		calendarData: readCharacterText(calendarDataValues[0], true),
	};
}

export interface CalendarEventUidResolutionOptions {
	readonly allowMissingEtag?: boolean;
	readonly timeZoneContext?: CalendarEventTimeZoneExecutionContext;
}

async function calendarQuery(
	transport: CalDavTransport,
	calendarUrl: AbsoluteHttpUrl,
	uid: string,
	options: CalendarEventUidResolutionOptions,
): Promise<CalendarEventReadResult> {
	const body = buildCalendarUidQueryReport({ uid });
	const response = await transport.request({
		method: CalDavMethod.REPORT,
		url: calendarUrl,
		headers: {
			Depth: '1',
			'Content-Type': 'application/xml; charset=utf-8',
		},
		body,
	});

	if (response.statusCode !== 207) {
		return invalidResponse();
	}

	let decodedResponse: string;
	try {
		decodedResponse = decodeCalDavTextBody(response.body, response.headers, { xml: true });
	} catch {
		return invalidResponse();
	}
	const multiStatus = parseDavMultiStatus(decodedResponse);
	const canonicalResources = new Map<AbsoluteHttpUrl, CanonicalResource>();
	const exactMatches: CalendarEventReadResult[] = [];

	for (const davResponse of multiStatus.responses) {
		if (davResponse.kind !== 'propstat') {
			return invalidResponse();
		}

		const properties = requestedProperties(davResponse, options.allowMissingEtag === true);
		const resourceUrl = resolveCalDavHref(response.effectiveUrl, davResponse.hrefs[0]);
		const resource = parseICalendarResource(Buffer.from(properties.calendarData, 'utf8'));
		const result = await mapCalendarEventResourceWithTimeZoneContext(
			{
				calendarUrl,
				resourceUrl,
				...(properties.etag === undefined ? {} : { etag: properties.etag }),
				resource,
			},
			options.timeZoneContext,
		);

		const existing = canonicalResources.get(resourceUrl);
		if (existing !== undefined) {
			if (existing.etag !== properties.etag || existing.calendarData !== properties.calendarData) {
				return invalidResponse();
			}
			continue;
		}

		canonicalResources.set(resourceUrl, {
			...(properties.etag === undefined ? {} : { etag: properties.etag }),
			calendarData: properties.calendarData,
		});
		if (result.event.uid === uid) {
			exactMatches.push(result);
		}
	}

	if (exactMatches.length === 0) {
		return fail(CalendarEventUidResolutionFailureCode.NOT_FOUND);
	}
	if (exactMatches.length > 1) {
		return fail(CalendarEventUidResolutionFailureCode.AMBIGUOUS);
	}
	return exactMatches[0];
}

function isDirectChild(calendarUrl: AbsoluteHttpUrl, resourceUrl: AbsoluteHttpUrl): boolean {
	try {
		const calendar = new URL(calendarUrl);
		const resource = new URL(resourceUrl);
		if (calendar.origin !== resource.origin || !calendar.pathname.endsWith('/')) return false;
		const calendarPathname = calendar.pathname.replace(/%[\dA-Fa-f]{2}/g, (escape) =>
			escape.toUpperCase(),
		);
		const resourcePathname = resource.pathname.replace(/%[\dA-Fa-f]{2}/g, (escape) =>
			escape.toUpperCase(),
		);
		if (!resourcePathname.startsWith(calendarPathname)) return false;
		const child = resourcePathname.slice(calendarPathname.length);
		return child.length > 0 && !child.endsWith('/') && !child.includes('/');
	} catch {
		return false;
	}
}

function isCalendarResource(calendarUrl: AbsoluteHttpUrl, resourceUrl: AbsoluteHttpUrl): boolean {
	try {
		const calendar = new URL(calendarUrl);
		const resource = new URL(resourceUrl);
		return (
			calendar.origin === resource.origin &&
			calendar.pathname.replace(/%[\dA-Fa-f]{2}/g, (escape) => escape.toUpperCase()) ===
				resource.pathname.replace(/%[\dA-Fa-f]{2}/g, (escape) => escape.toUpperCase())
		);
	} catch {
		return false;
	}
}

function eventUid(resource: ICalendarResource): string | undefined {
	let context;
	try {
		context = createCalendarEventPreservationContext(resource);
	} catch (error) {
		if (
			error instanceof CalDavCalendarEventReadModelError &&
			error.code === CalendarEventReadModelErrorCode.NOT_VEVENT_RESOURCE
		) {
			return undefined;
		}
		throw error;
	}
	const property = context.master.entries.find(
		(entry) => entry.kind === 'property' && entry.name.toUpperCase() === 'UID',
	);
	if (property === undefined || property.kind !== 'property') return invalidResponse();
	return property.value.textValues?.length === 1
		? property.value.textValues[0]
		: property.value.raw;
}

async function candidateGet(
	transport: CalDavTransport,
	resourceUrl: AbsoluteHttpUrl,
	uid: string,
	allowMissingEtag: boolean,
): Promise<CandidateGetResult> {
	let response;
	try {
		response = await transport.request({ method: CalDavMethod.GET, url: resourceUrl });
	} catch (error) {
		if (error instanceof CalDavNotFoundError) return { bodyBytes: 0 };
		throw error;
	}
	if (response.statusCode !== 200 || response.body.byteLength > ICALENDAR_MAX_RESOURCE_BYTES) {
		return invalidResponse();
	}
	try {
		validateAbsoluteHttpUrl(response.effectiveUrl);
	} catch {
		return invalidResponse();
	}
	let body: string;
	try {
		body = decodeCalDavTextBody(response.body, response.headers);
	} catch {
		return invalidResponse();
	}
	const resource = parseICalendarResource(Buffer.from(body, 'utf8'));
	if (eventUid(resource) !== uid) return { bodyBytes: response.body.byteLength };
	if (response.etag === undefined && !allowMissingEtag) return invalidResponse();
	return Object.freeze({
		bodyBytes: response.body.byteLength,
		candidate: Object.freeze({
			resource,
			resourceUrl,
			...(response.etag === undefined ? {} : { etag: response.etag }),
		}),
	});
}

function collectionResource(property: DavProperty): boolean {
	for (const child of property.children) {
		if (child.kind === 'text') {
			if (child.value.trim().length > 0) return incomplete();
			continue;
		}
		if (child.name.namespaceUri === DAV_NAMESPACE && child.name.localName === 'collection')
			return true;
	}
	return false;
}

async function listResources(
	transport: CalDavTransport,
	calendarUrl: AbsoluteHttpUrl,
	startedAt: number,
): Promise<ResourceListing> {
	checkBudget(startedAt);
	const response = await transport.request({
		method: CalDavMethod.PROPFIND,
		url: calendarUrl,
		headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
		body: buildPropfindRequest(['resourceType', 'getEtag']),
	});
	if (response.statusCode !== 207) return incomplete();
	let decoded: string;
	try {
		decoded = decodeCalDavTextBody(response.body, response.headers, { xml: true });
	} catch {
		return incomplete();
	}
	const result = new Map<AbsoluteHttpUrl, ListedResource>();
	for (const davResponse of parseDavMultiStatus(decoded).responses) {
		if (davResponse.kind !== 'propstat') return incomplete();
		let resourceUrl: AbsoluteHttpUrl;
		try {
			resourceUrl = resolveCalDavHref(response.effectiveUrl, davResponse.hrefs[0]);
		} catch {
			return incomplete();
		}
		if (isCalendarResource(calendarUrl, resourceUrl)) continue;
		if (!isDirectChild(calendarUrl, resourceUrl)) return incomplete();
		const types = davResponse.successfulProperties.filter((property) =>
			isExpandedName(property, DAV_NAMESPACE, 'resourcetype'),
		);
		if (types.length !== 1) return incomplete();
		if (collectionResource(types[0])) continue;
		const previous = result.get(resourceUrl);
		if (previous !== undefined && previous.href !== davResponse.hrefs[0]) return incomplete();
		result.set(resourceUrl, Object.freeze({ href: davResponse.hrefs[0], resourceUrl }));
		checkBudget(startedAt, result.size);
	}
	return Object.freeze({
		resources: Object.freeze([...result.values()]),
		bodyBytes: response.body.byteLength,
	});
}

async function scan(
	transport: CalDavTransport,
	calendarUrl: AbsoluteHttpUrl,
	uid: string,
	options: CalendarEventUidResolutionOptions,
	startedAt: number,
	initialBodyBytes: number,
): Promise<CalendarEventReadResult> {
	const listing = await listResources(transport, calendarUrl, startedAt);
	const listed = listing.resources;
	let bodyBytes = initialBodyBytes + listing.bodyBytes;
	checkBudget(startedAt, listed.length, bodyBytes);
	const matches: CalendarEventReadResult[] = [];
	for (let index = 0; index < listed.length; index += ICLOUD_UID_LOOKUP_BATCH_SIZE) {
		checkBudget(startedAt);
		const batch = listed.slice(index, index + ICLOUD_UID_LOOKUP_BATCH_SIZE);
		const response = await transport.request({
			method: CalDavMethod.REPORT,
			url: calendarUrl,
			headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
			body: buildCalendarMultigetReport({ hrefs: batch.map((entry) => entry.href) }),
		});
		if (response.statusCode !== 207) return incomplete();
		bodyBytes += response.body.byteLength;
		checkBudget(startedAt, undefined, bodyBytes);
		let decoded: string;
		try {
			decoded = decodeCalDavTextBody(response.body, response.headers, { xml: true });
		} catch {
			return incomplete();
		}
		const returned = new Set<AbsoluteHttpUrl>();
		for (const davResponse of parseDavMultiStatus(decoded).responses) {
			if (davResponse.kind !== 'propstat') return incomplete();
			let resourceUrl: AbsoluteHttpUrl;
			try {
				resourceUrl = resolveCalDavHref(response.effectiveUrl, davResponse.hrefs[0]);
			} catch {
				return incomplete();
			}
			if (!batch.some((entry) => entry.resourceUrl === resourceUrl) || returned.has(resourceUrl)) {
				return incomplete();
			}
			returned.add(resourceUrl);
			const properties = requestedProperties(davResponse, options.allowMissingEtag === true);
			const resource = parseICalendarResource(Buffer.from(properties.calendarData, 'utf8'));
			if (eventUid(resource) !== uid) continue;
			matches.push(
				await mapCalendarEventResourceWithTimeZoneContext(
					{
						calendarUrl,
						resourceUrl,
						...(properties.etag === undefined ? {} : { etag: properties.etag }),
						resource,
					},
					options.timeZoneContext,
				),
			);
			checkBudget(startedAt, undefined, bodyBytes);
		}
		if (returned.size !== batch.length) return incomplete();
	}
	if (matches.length === 0) return fail(CalendarEventUidResolutionFailureCode.NOT_FOUND);
	if (matches.length > 1) return fail(CalendarEventUidResolutionFailureCode.AMBIGUOUS);
	return matches[0];
}

async function icloudCandidates(
	transport: CalDavTransport,
	calendarUrl: AbsoluteHttpUrl,
	uid: string,
	options: CalendarEventUidResolutionOptions,
): Promise<CalendarEventReadResult> {
	const startedAt = Date.now();
	const urls = [
		calendarEventResourceUrlForBase64Uid(calendarUrl, uid),
		calendarEventResourceUrlForEncodedUid(calendarUrl, uid),
	].filter((url): url is AbsoluteHttpUrl => url !== undefined);
	const seen = new Set<AbsoluteHttpUrl>();
	let bodyBytes = 0;
	for (const resourceUrl of urls) {
		checkBudget(startedAt);
		if (seen.has(resourceUrl)) continue;
		seen.add(resourceUrl);
		const candidateResult = await candidateGet(
			transport,
			resourceUrl,
			uid,
			options.allowMissingEtag === true,
		);
		bodyBytes += candidateResult.bodyBytes;
		checkBudget(startedAt, undefined, bodyBytes);
		if (candidateResult.candidate === undefined) continue;
		const candidate = candidateResult.candidate;
		return await mapCalendarEventResourceWithTimeZoneContext(
			{
				calendarUrl,
				resourceUrl: candidate.resourceUrl,
				...(candidate.etag === undefined ? {} : { etag: candidate.etag }),
				resource: candidate.resource,
			},
			options.timeZoneContext,
		);
	}
	return await scan(transport, calendarUrl, uid, options, startedAt, bodyBytes);
}

export async function resolveCalendarEventByUid(
	transport: CalDavTransport,
	calendarUrl: AbsoluteHttpUrl,
	uid: string,
	options: CalendarEventUidResolutionOptions = {},
): Promise<CalendarEventReadResult> {
	return transport.providerContext?.eventUidLookupStrategy ===
		CalDavEventUidLookupStrategy.ICLOUD_CANDIDATE_SCAN
		? await icloudCandidates(transport, calendarUrl, uid, options)
		: await calendarQuery(transport, calendarUrl, uid, options);
}
