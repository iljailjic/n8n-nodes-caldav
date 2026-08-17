/* eslint-disable @n8n/community-nodes/require-node-api-error -- The accepted application-service contract propagates sanitized transport errors outside the n8n UI boundary. */
import {
	CalDavAuthorizationError,
	CalDavMethod,
	CalDavNotFoundError,
	CalDavPreconditionFailedError,
} from '../transport/http';
import type {
	CalDavResponseHeaders,
	CalDavTransport,
	CalDavTransportResponse,
} from '../transport/http';
import {
	normalizeCalendarCollectionUrl,
	resolveCalDavHref,
	validateAbsoluteHttpUrl,
} from '../transport/url';
import type { AbsoluteHttpUrl } from '../transport/url';
import { hasCalDavNoUidConflict } from '../xml/parser';

export const CalendarEventMutationFailureCode = Object.freeze({
	OUTSIDE_CALENDAR: 'CALENDAR_EVENT_RESOURCE_OUTSIDE_CALENDAR',
	CREATE_CONFLICT: 'CALENDAR_EVENT_CREATE_CONFLICT',
	CONCURRENCY_CONFLICT: 'CALENDAR_EVENT_CONCURRENCY_CONFLICT',
	MISSING_ETAG: 'CALENDAR_EVENT_MUTATION_ETAG_MISSING',
	INVALID_LOCATION: 'INVALID_CALENDAR_EVENT_RESOURCE_LOCATION',
	INVALID_RESPONSE: 'INVALID_CALENDAR_EVENT_MUTATION_RESPONSE',
} as const);

export type CalendarEventMutationFailureCode =
	(typeof CalendarEventMutationFailureCode)[keyof typeof CalendarEventMutationFailureCode];

const ERROR_MESSAGES: Readonly<Record<CalendarEventMutationFailureCode, string>> = {
	CALENDAR_EVENT_RESOURCE_OUTSIDE_CALENDAR:
		'The event resource URL is outside the selected calendar.',
	CALENDAR_EVENT_CREATE_CONFLICT: 'A calendar event already exists at the requested resource URL.',
	CALENDAR_EVENT_CONCURRENCY_CONFLICT:
		'The calendar event changed before the mutation could be applied.',
	CALENDAR_EVENT_MUTATION_ETAG_MISSING:
		'The calendar event does not provide an ETag required for a safe mutation.',
	INVALID_CALENDAR_EVENT_RESOURCE_LOCATION:
		'The CalDAV server returned an invalid event resource Location.',
	INVALID_CALENDAR_EVENT_MUTATION_RESPONSE:
		'The CalDAV server returned an invalid calendar-event mutation response.',
};

export class CalDavCalendarEventMutationError extends Error {
	readonly code: CalendarEventMutationFailureCode;

	constructor(code: CalendarEventMutationFailureCode) {
		super(ERROR_MESSAGES[code]);
		this.name = 'CalDavCalendarEventMutationError';
		this.code = code;
	}
}

export interface CalendarEventMutationEtag {
	readonly resourceUrl: AbsoluteHttpUrl;
	readonly etag: string;
}

export interface CalendarEventMutationResult {
	readonly statusCode: 200 | 201 | 202 | 204;
	readonly resourceUrl: AbsoluteHttpUrl;
	readonly etag?: string;
}

interface CalendarEventMutationTarget {
	readonly calendarUrl: AbsoluteHttpUrl;
	readonly resourceUrl: AbsoluteHttpUrl;
}

function fail(code: CalendarEventMutationFailureCode): never {
	throw new CalDavCalendarEventMutationError(code);
}

function asciiLowercase(value: string): string {
	return value.replace(/[A-Z]/g, (character) =>
		String.fromCharCode(character.charCodeAt(0) + 0x20),
	);
}

function isDirectCalendarChild(
	calendarUrl: AbsoluteHttpUrl,
	resourceUrl: AbsoluteHttpUrl,
): boolean {
	try {
		const calendar = new URL(calendarUrl);
		const resource = new URL(resourceUrl);
		if (calendar.origin !== resource.origin || !calendar.pathname.endsWith('/')) {
			return false;
		}
		if (!resource.pathname.startsWith(calendar.pathname)) {
			return false;
		}

		const child = resource.pathname.slice(calendar.pathname.length);
		return child.length > 0 && !child.endsWith('/') && !child.includes('/');
	} catch {
		return false;
	}
}

function validateMutationTarget(
	calendarUrl: AbsoluteHttpUrl,
	resourceUrl: AbsoluteHttpUrl,
): CalendarEventMutationTarget {
	let normalizedCalendarUrl: AbsoluteHttpUrl;
	let canonicalResourceUrl: AbsoluteHttpUrl;
	try {
		normalizedCalendarUrl = normalizeCalendarCollectionUrl(calendarUrl);
		canonicalResourceUrl = validateAbsoluteHttpUrl(resourceUrl);
	} catch {
		return fail(CalendarEventMutationFailureCode.OUTSIDE_CALENDAR);
	}

	if (!isDirectCalendarChild(normalizedCalendarUrl, canonicalResourceUrl)) {
		return fail(CalendarEventMutationFailureCode.OUTSIDE_CALENDAR);
	}

	return {
		calendarUrl: normalizedCalendarUrl,
		resourceUrl: canonicalResourceUrl,
	};
}

function canonicalizeEffectiveResourceUrl(effectiveUrl: string): AbsoluteHttpUrl {
	let resourceUrl: AbsoluteHttpUrl;
	try {
		resourceUrl = validateAbsoluteHttpUrl(effectiveUrl);
	} catch {
		return fail(CalendarEventMutationFailureCode.INVALID_RESPONSE);
	}
	return resourceUrl;
}

function assertDirectCalendarChild(
	calendarUrl: AbsoluteHttpUrl,
	resourceUrl: AbsoluteHttpUrl,
): AbsoluteHttpUrl {
	if (!isDirectCalendarChild(calendarUrl, resourceUrl)) {
		return fail(CalendarEventMutationFailureCode.OUTSIDE_CALENDAR);
	}

	return resourceUrl;
}

function validateEffectiveResourceUrl(
	calendarUrl: AbsoluteHttpUrl,
	effectiveUrl: string,
): AbsoluteHttpUrl {
	return assertDirectCalendarChild(calendarUrl, canonicalizeEffectiveResourceUrl(effectiveUrl));
}

interface HeaderLookup {
	readonly present: boolean;
	readonly values: readonly string[];
	readonly malformed: boolean;
}

function lookupHeader(headers: CalDavResponseHeaders, headerName: string): HeaderLookup {
	const values: string[] = [];
	let present = false;

	try {
		for (const name of Object.keys(headers)) {
			if (asciiLowercase(name) !== headerName) {
				continue;
			}

			present = true;
			const value = headers[name];
			if (typeof value === 'string') {
				values.push(value);
				continue;
			}
			if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
				return { present, values: Object.freeze(values), malformed: true };
			}
			values.push(...value);
		}
	} catch {
		return { present, values: Object.freeze(values), malformed: true };
	}

	return { present, values: Object.freeze(values), malformed: false };
}

function getCreatedResourceUrl(
	calendarUrl: AbsoluteHttpUrl,
	effectiveResourceUrl: AbsoluteHttpUrl,
	headers: CalDavResponseHeaders,
): AbsoluteHttpUrl {
	const location = lookupHeader(headers, 'location');
	if (!location.present) {
		return effectiveResourceUrl;
	}
	if (location.malformed || location.values.length !== 1 || location.values[0].length === 0) {
		return fail(CalendarEventMutationFailureCode.INVALID_LOCATION);
	}

	let createdResourceUrl: AbsoluteHttpUrl;
	try {
		createdResourceUrl = resolveCalDavHref(effectiveResourceUrl, location.values[0]);
	} catch {
		return fail(CalendarEventMutationFailureCode.INVALID_LOCATION);
	}

	if (!isDirectCalendarChild(calendarUrl, createdResourceUrl)) {
		return fail(CalendarEventMutationFailureCode.OUTSIDE_CALENDAR);
	}

	return createdResourceUrl;
}

function getResponseEtag(response: CalDavTransportResponse): string | undefined {
	if (response.etag === undefined || typeof response.etag === 'string') {
		return response.etag;
	}

	return fail(CalendarEventMutationFailureCode.INVALID_RESPONSE);
}

function mutationResult(
	response: CalDavTransportResponse,
	calendarUrl: AbsoluteHttpUrl,
	acceptedStatusCodes: ReadonlySet<number>,
): CalendarEventMutationResult {
	if (!acceptedStatusCodes.has(response.statusCode)) {
		return fail(CalendarEventMutationFailureCode.INVALID_RESPONSE);
	}

	const canonicalEffectiveResourceUrl = canonicalizeEffectiveResourceUrl(response.effectiveUrl);
	const resourceUrl =
		response.statusCode === 201
			? getCreatedResourceUrl(calendarUrl, canonicalEffectiveResourceUrl, response.headers)
			: canonicalEffectiveResourceUrl;
	assertDirectCalendarChild(calendarUrl, canonicalEffectiveResourceUrl);
	const etag = getResponseEtag(response);

	return {
		statusCode: response.statusCode as 200 | 201 | 202 | 204,
		resourceUrl,
		...(etag === undefined ? {} : { etag }),
	};
}

export async function getCalendarEventMutationEtag(
	transport: CalDavTransport,
	calendarUrl: AbsoluteHttpUrl,
	resourceUrl: AbsoluteHttpUrl,
): Promise<CalendarEventMutationEtag> {
	const target = validateMutationTarget(calendarUrl, resourceUrl);
	const response = await transport.request({
		method: CalDavMethod.GET,
		url: target.resourceUrl,
	});

	if (response.statusCode !== 200) {
		return fail(CalendarEventMutationFailureCode.INVALID_RESPONSE);
	}

	const effectiveResourceUrl = validateEffectiveResourceUrl(
		target.calendarUrl,
		response.effectiveUrl,
	);
	const etag = getResponseEtag(response);
	if (etag === undefined) {
		return fail(CalendarEventMutationFailureCode.MISSING_ETAG);
	}

	return { resourceUrl: effectiveResourceUrl, etag };
}

export async function createCalendarEventResource(
	transport: CalDavTransport,
	calendarUrl: AbsoluteHttpUrl,
	resourceUrl: AbsoluteHttpUrl,
	calendarData: string,
): Promise<CalendarEventMutationResult> {
	const target = validateMutationTarget(calendarUrl, resourceUrl);
	let response: CalDavTransportResponse;
	try {
		response = await transport.request({
			method: CalDavMethod.PUT,
			url: target.resourceUrl,
			headers: {
				'If-None-Match': '*',
				'Content-Type': 'text/calendar; charset=utf-8',
			},
			body: calendarData,
		});
	} catch (error) {
		if (error instanceof CalDavPreconditionFailedError) {
			return fail(CalendarEventMutationFailureCode.CREATE_CONFLICT);
		}
		throw error;
	}
	if (response.statusCode === 403) {
		throw new CalDavAuthorizationError(403, hasCalDavNoUidConflict(response.body.toString('utf8')));
	}
	if (response.statusCode === 404) throw new CalDavNotFoundError(404);
	if (response.statusCode === 412) {
		return fail(CalendarEventMutationFailureCode.CREATE_CONFLICT);
	}

	return mutationResult(response, target.calendarUrl, new Set([201]));
}

async function resolveMutationValidator(
	transport: CalDavTransport,
	target: CalendarEventMutationTarget,
	etag: string | undefined,
): Promise<CalendarEventMutationEtag> {
	if (etag !== undefined) {
		return { resourceUrl: target.resourceUrl, etag };
	}

	return await getCalendarEventMutationEtag(transport, target.calendarUrl, target.resourceUrl);
}

export async function updateCalendarEventResource(
	transport: CalDavTransport,
	calendarUrl: AbsoluteHttpUrl,
	resourceUrl: AbsoluteHttpUrl,
	calendarData: string,
	etag?: string,
): Promise<CalendarEventMutationResult> {
	const target = validateMutationTarget(calendarUrl, resourceUrl);
	let response: CalDavTransportResponse;
	try {
		const validator = await resolveMutationValidator(transport, target, etag);
		response = await transport.request({
			method: CalDavMethod.PUT,
			url: validator.resourceUrl,
			headers: {
				'If-Match': validator.etag,
				'Content-Type': 'text/calendar; charset=utf-8',
			},
			body: calendarData,
		});
	} catch (error) {
		if (error instanceof CalDavPreconditionFailedError) {
			return fail(CalendarEventMutationFailureCode.CONCURRENCY_CONFLICT);
		}
		throw error;
	}

	return mutationResult(response, target.calendarUrl, new Set([200, 204]));
}

export async function deleteCalendarEventResource(
	transport: CalDavTransport,
	calendarUrl: AbsoluteHttpUrl,
	resourceUrl: AbsoluteHttpUrl,
	etag?: string,
): Promise<CalendarEventMutationResult> {
	const target = validateMutationTarget(calendarUrl, resourceUrl);
	let response: CalDavTransportResponse;
	try {
		const validator = await resolveMutationValidator(transport, target, etag);
		response = await transport.request({
			method: CalDavMethod.DELETE,
			url: validator.resourceUrl,
			headers: { 'If-Match': validator.etag },
		});
	} catch (error) {
		if (error instanceof CalDavPreconditionFailedError) {
			return fail(CalendarEventMutationFailureCode.CONCURRENCY_CONFLICT);
		}
		throw error;
	}

	return mutationResult(response, target.calendarUrl, new Set([200, 202, 204]));
}
