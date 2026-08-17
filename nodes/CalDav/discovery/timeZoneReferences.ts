import { discoverCalendarHome } from './calendarHome';
import { discoverCurrentUserPrincipal } from './currentUserPrincipal';
import { parseICalendarResource } from '../icalendar/parser';
import type { ICalendarComponent } from '../icalendar/parser';
import { canonicalizeIanaTimeZone, type IanaTimeZoneId } from '../icalendar/timeZones';
import {
	CalDavMethod,
	type CalDavTransport,
	type CalDavTransportResponse,
} from '../transport/http';
import { normalizeCalendarCollectionUrl, validateAbsoluteHttpUrl } from '../transport/url';
import type { AbsoluteHttpUrl } from '../transport/url';
import { parseDavMultiStatus } from '../xml/parser';
import type { DavProperty, DavXmlElement } from '../xml/parser';
import { buildCalendarCollectionListingPropfind } from '../xml/requests';

export const TimeZoneReferenceFailureCode = Object.freeze({
	SERVER_UNSUPPORTED: 'SERVER_UNSUPPORTED',
	ZONE_UNAVAILABLE: 'ZONE_UNAVAILABLE',
	INVALID_RESPONSE: 'INVALID_RESPONSE',
} as const);

export type TimeZoneReferenceFailureCode =
	(typeof TimeZoneReferenceFailureCode)[keyof typeof TimeZoneReferenceFailureCode];

const ERROR_MESSAGES: Readonly<Record<TimeZoneReferenceFailureCode, string>> = {
	SERVER_UNSUPPORTED: 'The CalDAV server does not support IANA time zones by reference.',
	ZONE_UNAVAILABLE:
		'The selected IANA time zone is not available by reference on the CalDAV server.',
	INVALID_RESPONSE: 'The time zone distribution service returned an invalid response.',
};

export class CalDavTimeZoneReferenceError extends Error {
	readonly code: TimeZoneReferenceFailureCode;

	constructor(code: TimeZoneReferenceFailureCode) {
		super(ERROR_MESSAGES[code]);
		this.name = 'CalDavTimeZoneReferenceError';
		this.code = code;
	}
}

export interface TimeZoneDistributionRequestInput {
	readonly method: 'GET';
	readonly url: AbsoluteHttpUrl;
	readonly headers?: Readonly<Record<string, string>>;
}

export type TimeZoneDistributionRequest = (
	input: TimeZoneDistributionRequestInput,
) => Promise<CalDavTransportResponse>;

export interface CalendarEventTimeZoneReference {
	readonly timeZone: IanaTimeZoneId;
	readonly etag: string;
	readonly calendarData: string;
	readonly ruleSource: 'vtimezone';
}

export interface CalendarEventTimeZoneExecutionContext {
	resolveReference(calendarUrl: string, timeZone: string): Promise<CalendarEventTimeZoneReference>;
}

export interface CalendarEventTimeZoneExecutionContextInput {
	readonly transport: CalDavTransport;
	readonly request: TimeZoneDistributionRequest;
}

const TIMEZONE_SERVICE_NAMESPACES = new Set([
	'DAV:',
	'urn:ietf:params:xml:ns:caldav',
	'http://calendarserver.org/ns/',
]);
const PRIVATE_IPV4 = /^(?:127\.|10\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
const STRONG_ETAG = /^"[^"\r\n]+"$/;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_ANONYMOUS_REDIRECTS = 5;

function fail(code: TimeZoneReferenceFailureCode): never {
	throw new CalDavTimeZoneReferenceError(code);
}

function headerValues(response: CalDavTransportResponse, name: string): readonly string[] {
	const value = Object.entries(response.headers).find(
		([candidate]) => candidate.toLowerCase() === name.toLowerCase(),
	)?.[1];
	return value === undefined ? [] : typeof value === 'string' ? [value] : value;
}

function hasDavToken(response: CalDavTransportResponse, token: string): boolean {
	return headerValues(response, 'dav').some((value) =>
		value
			.split(',')
			.map((candidate) => candidate.trim())
			.includes(token),
	);
}

function isWhitespace(value: string): boolean {
	return /^[\t\n\r ]*$/u.test(value);
}

function elementText(element: DavXmlElement): string {
	if (element.attributes.length !== 0) return fail(TimeZoneReferenceFailureCode.INVALID_RESPONSE);
	let result = '';
	for (const child of element.children) {
		if (child.kind === 'element') return fail(TimeZoneReferenceFailureCode.INVALID_RESPONSE);
		result += child.value;
	}
	if (result.length === 0) return fail(TimeZoneReferenceFailureCode.INVALID_RESPONSE);
	return result;
}

function serviceHrefs(property: DavProperty, effectiveUrl: string): AbsoluteHttpUrl[] {
	if (property.attributes.length !== 0) return fail(TimeZoneReferenceFailureCode.INVALID_RESPONSE);
	const result: AbsoluteHttpUrl[] = [];
	for (const child of property.children) {
		if (child.kind === 'text') {
			if (!isWhitespace(child.value)) return fail(TimeZoneReferenceFailureCode.INVALID_RESPONSE);
			continue;
		}
		if (child.name.namespaceUri !== 'DAV:' || child.name.localName !== 'href') {
			return fail(TimeZoneReferenceFailureCode.INVALID_RESPONSE);
		}
		try {
			result.push(validateAbsoluteHttpUrl(new URL(elementText(child), effectiveUrl).href));
		} catch {
			return fail(TimeZoneReferenceFailureCode.INVALID_RESPONSE);
		}
	}
	return result;
}

function parseServiceSet(response: CalDavTransportResponse): readonly AbsoluteHttpUrl[] {
	if (response.statusCode !== 207) return fail(TimeZoneReferenceFailureCode.INVALID_RESPONSE);
	const parsed = parseDavMultiStatus(response.body.toString('utf8'));
	const matches: DavProperty[] = [];
	for (const davResponse of parsed.responses) {
		if (davResponse.kind !== 'propstat') continue;
		for (const property of davResponse.successfulProperties) {
			if (
				property.name.localName === 'timezone-service-set' &&
				property.name.namespaceUri !== null &&
				TIMEZONE_SERVICE_NAMESPACES.has(property.name.namespaceUri)
			) {
				matches.push(property);
			}
		}
	}
	if (matches.length !== 1) return fail(TimeZoneReferenceFailureCode.SERVER_UNSUPPORTED);
	const deduplicated = new Map<string, AbsoluteHttpUrl>();
	for (const href of serviceHrefs(matches[0], response.effectiveUrl)) {
		deduplicated.set(href, href);
	}
	return [...deduplicated.values()];
}

function trustedServiceUrl(
	input: string,
	calendarUrl: AbsoluteHttpUrl,
): AbsoluteHttpUrl | undefined {
	let value: AbsoluteHttpUrl;
	try {
		value = validateAbsoluteHttpUrl(input);
	} catch {
		return undefined;
	}
	const url = new URL(value);
	const calendar = new URL(calendarUrl);
	if (calendar.protocol === 'https:' && url.protocol !== 'https:') return undefined;
	const hostname = url.hostname.toLowerCase();
	if (
		hostname === 'localhost' ||
		hostname.endsWith('.localhost') ||
		hostname.endsWith('.local') ||
		PRIVATE_IPV4.test(hostname) ||
		hostname === '::1' ||
		hostname.startsWith('fc') ||
		hostname.startsWith('fd') ||
		hostname.startsWith('fe80:')
	) {
		return undefined;
	}
	return value;
}

function joinServiceUrl(root: AbsoluteHttpUrl, path: string): AbsoluteHttpUrl {
	const base = root.endsWith('/') ? root : (`${root}/` as AbsoluteHttpUrl);
	return validateAbsoluteHttpUrl(new URL(path, base).href);
}

async function requestFollowingTrustedRedirects(
	request: TimeZoneDistributionRequest,
	initialUrl: AbsoluteHttpUrl,
	calendarUrl: AbsoluteHttpUrl,
	headers?: Readonly<Record<string, string>>,
): Promise<CalDavTransportResponse> {
	let url = initialUrl;
	const visited = new Set<string>([url]);
	let followed = 0;
	while (true) {
		const response = await request({
			method: 'GET',
			url,
			...(headers === undefined ? {} : { headers }),
		});
		if (!REDIRECT_STATUS_CODES.has(response.statusCode)) {
			return { ...response, effectiveUrl: url };
		}
		const locations = headerValues(response, 'location');
		if (
			locations.length !== 1 ||
			locations[0]!.length === 0 ||
			followed >= MAX_ANONYMOUS_REDIRECTS
		) {
			throw new Error('invalid anonymous redirect');
		}
		let target: AbsoluteHttpUrl | undefined;
		try {
			target = trustedServiceUrl(new URL(locations[0]!, url).href, calendarUrl);
		} catch {
			// The sanitized discovery result below remains authoritative.
		}
		if (target === undefined || visited.has(target)) throw new Error('invalid anonymous redirect');
		visited.add(target);
		followed += 1;
		url = target;
	}
}

function validCapabilities(response: CalDavTransportResponse): boolean {
	if (response.statusCode < 200 || response.statusCode >= 300) return false;
	const contentTypes = headerValues(response, 'content-type');
	if (contentTypes.length !== 1 || !contentTypes[0].toLowerCase().startsWith('application/json')) {
		return false;
	}
	try {
		const parsed = JSON.parse(response.body.toString('utf8')) as unknown;
		return (
			typeof parsed === 'object' &&
			parsed !== null &&
			Array.isArray((parsed as { readonly actions?: unknown }).actions) &&
			(parsed as { readonly actions: readonly unknown[] }).actions.includes('get')
		);
	} catch {
		return false;
	}
}

function componentProperties(component: ICalendarComponent, name: string): readonly string[] {
	return component.entries
		.filter((entry) => entry.kind === 'property' && entry.name === name)
		.map((entry) => (entry.kind === 'property' ? entry.value.raw : ''));
}

function validateZoneResponse(
	response: CalDavTransportResponse,
	timeZone: IanaTimeZoneId,
): CalendarEventTimeZoneReference {
	if (response.statusCode < 200 || response.statusCode >= 300) {
		return fail(TimeZoneReferenceFailureCode.INVALID_RESPONSE);
	}
	const etags = headerValues(response, 'etag');
	const contentTypes = headerValues(response, 'content-type');
	if (
		etags.length !== 1 ||
		!STRONG_ETAG.test(etags[0]) ||
		contentTypes.length !== 1 ||
		!contentTypes[0].toLowerCase().startsWith('text/calendar')
	) {
		return fail(TimeZoneReferenceFailureCode.INVALID_RESPONSE);
	}
	let resource;
	try {
		resource = parseICalendarResource(response.body);
	} catch {
		return fail(TimeZoneReferenceFailureCode.INVALID_RESPONSE);
	}
	const definitions = resource.calendar.entries.filter(
		(entry): entry is ICalendarComponent =>
			entry.kind === 'component' && entry.name === 'VTIMEZONE',
	);
	if (definitions.length !== 1) return fail(TimeZoneReferenceFailureCode.INVALID_RESPONSE);
	const identifiers = componentProperties(definitions[0], 'TZID');
	if (identifiers.length !== 1) return fail(TimeZoneReferenceFailureCode.INVALID_RESPONSE);
	let canonical;
	try {
		canonical = canonicalizeIanaTimeZone(identifiers[0]);
	} catch {
		return fail(TimeZoneReferenceFailureCode.INVALID_RESPONSE);
	}
	if (canonical !== timeZone) return fail(TimeZoneReferenceFailureCode.INVALID_RESPONSE);
	return Object.freeze({
		timeZone,
		etag: etags[0],
		calendarData: response.body.toString('utf8'),
		ruleSource: 'vtimezone' as const,
	});
}

async function discoverServices(
	transport: CalDavTransport,
	calendarUrl: AbsoluteHttpUrl,
): Promise<readonly AbsoluteHttpUrl[]> {
	const capability = await transport.request({ method: CalDavMethod.OPTIONS, url: calendarUrl });
	if (!hasDavToken(capability, 'calendar-no-timezone')) {
		return fail(TimeZoneReferenceFailureCode.SERVER_UNSUPPORTED);
	}
	const principal = await discoverCurrentUserPrincipal(transport);
	if (principal.kind !== 'authenticated') {
		return fail(TimeZoneReferenceFailureCode.SERVER_UNSUPPORTED);
	}
	const home = await discoverCalendarHome(transport, principal.principalUrl);
	const response = await transport.request({
		method: CalDavMethod.PROPFIND,
		url: home.calendarHomeUrl,
		headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
		body: buildCalendarCollectionListingPropfind([
			{ namespaceUri: 'http://calendarserver.org/ns/', localName: 'timezone-service-set' },
		]),
	});
	return parseServiceSet(response);
}

export function createCalendarEventTimeZoneExecutionContext(
	input: CalendarEventTimeZoneExecutionContextInput,
): CalendarEventTimeZoneExecutionContext {
	const resultCache = new Map<string, Promise<CalendarEventTimeZoneReference>>();
	const serviceCache = new Map<string, Promise<readonly AbsoluteHttpUrl[]>>();
	const capabilityCache = new Map<string, Promise<boolean>>();

	async function resolve(
		calendarUrlInput: string,
		timeZoneInput: string,
	): Promise<CalendarEventTimeZoneReference> {
		const calendarUrl = normalizeCalendarCollectionUrl(calendarUrlInput);
		const timeZone = canonicalizeIanaTimeZone(timeZoneInput);
		let servicesPromise = serviceCache.get(calendarUrl);
		if (servicesPromise === undefined) {
			servicesPromise = discoverServices(input.transport, calendarUrl);
			serviceCache.set(calendarUrl, servicesPromise);
		}
		const services = await servicesPromise;
		let sawUsableService = false;
		for (const advertised of services) {
			const service = trustedServiceUrl(advertised, calendarUrl);
			if (service === undefined) continue;
			sawUsableService = true;
			let capabilityPromise = capabilityCache.get(service);
			if (capabilityPromise === undefined) {
				capabilityPromise = requestFollowingTrustedRedirects(
					input.request,
					joinServiceUrl(service, 'capabilities'),
					calendarUrl,
				).then(validCapabilities, () => false);
				capabilityCache.set(service, capabilityPromise);
			}
			if (!(await capabilityPromise)) continue;
			let response: CalDavTransportResponse;
			try {
				response = await requestFollowingTrustedRedirects(
					input.request,
					joinServiceUrl(service, `zones/${encodeURIComponent(timeZone)}`),
					calendarUrl,
					{ Accept: 'text/calendar' },
				);
			} catch {
				continue;
			}
			if (response.statusCode === 404) continue;
			return validateZoneResponse(response, timeZone);
		}
		return fail(
			sawUsableService
				? TimeZoneReferenceFailureCode.ZONE_UNAVAILABLE
				: TimeZoneReferenceFailureCode.SERVER_UNSUPPORTED,
		);
	}

	return Object.freeze({
		resolveReference(calendarUrl: string, timeZone: string) {
			let normalizedCalendar: AbsoluteHttpUrl;
			let canonical: IanaTimeZoneId;
			try {
				normalizedCalendar = normalizeCalendarCollectionUrl(calendarUrl);
				canonical = canonicalizeIanaTimeZone(timeZone);
			} catch {
				return Promise.reject(
					new CalDavTimeZoneReferenceError(TimeZoneReferenceFailureCode.INVALID_RESPONSE),
				);
			}
			const key = `${normalizedCalendar}\n${canonical}`;
			let cached = resultCache.get(key);
			if (cached === undefined) {
				cached = resolve(normalizedCalendar, canonical);
				resultCache.set(key, cached);
			}
			return cached;
		},
	});
}
