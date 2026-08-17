// The accepted TZDIST trust boundary requires DNS results to be validated and pinned
// before the anonymous n8n HTTP helper is allowed to connect.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { lookup } from 'node:dns/promises';

import { discoverCalendarHome } from './calendarHome';
import { discoverCurrentUserPrincipal } from './currentUserPrincipal';
import { parseICalendarResource } from '../icalendar/parser';
import type { ICalendarComponent } from '../icalendar/parser';
import {
	canonicalizeIanaTimeZone,
	projectInstantInTimeZone,
	type IanaTimeZoneId,
} from '../icalendar/timeZones';
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

type TimeZoneDistributionHostResolver = (hostname: string) => Promise<readonly string[]>;

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

interface TimeZoneDistributionTrustContext {
	readonly resolveHost: TimeZoneDistributionHostResolver;
	readonly pinnedAddresses: Map<string, string>;
}

interface TimeZoneDistributionConnectionBinding {
	readonly hostname: string;
	readonly address: string;
	readonly lookup: (
		hostname: string,
		options: { readonly all?: boolean },
		callback: (
			error: NodeJS.ErrnoException | null,
			address: string | readonly { readonly address: string; readonly family: number }[],
			family?: number,
		) => void,
	) => void;
}

interface TrustedServiceTarget {
	readonly url: AbsoluteHttpUrl;
	readonly binding: TimeZoneDistributionConnectionBinding;
}

async function resolveTimeZoneDistributionHost(hostname: string): Promise<readonly string[]> {
	const addresses = await lookup(hostname, { all: true, verbatim: true });
	return Object.freeze(addresses.map(({ address }) => address));
}

function ipv4Bytes(input: string): readonly number[] | undefined {
	const parts = input.split('.');
	if (parts.length !== 4) return undefined;
	const bytes = parts.map((part) => (/^(?:0|[1-9]\d{0,2})$/.test(part) ? Number(part) : -1));
	return bytes.every((byte) => byte >= 0 && byte <= 255) ? bytes : undefined;
}

function isPublicIpv4(input: string): boolean {
	const bytes = ipv4Bytes(input);
	if (bytes === undefined) return false;
	const [first, second, third] = bytes as readonly [number, number, number, number];
	return !(
		first === 0 ||
		first === 10 ||
		first === 127 ||
		(first === 100 && second >= 64 && second <= 127) ||
		(first === 169 && second === 254) ||
		(first === 172 && second >= 16 && second <= 31) ||
		(first === 192 && second === 0 && third === 0) ||
		(first === 192 && second === 0 && third === 2) ||
		(first === 192 && second === 168) ||
		(first === 198 && (second === 18 || second === 19)) ||
		(first === 198 && second === 51 && third === 100) ||
		(first === 203 && second === 0 && third === 113) ||
		first >= 224
	);
}

function ipv6Bytes(input: string): readonly number[] | undefined {
	let value = input.toLowerCase();
	if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
	if (value.includes('%') || !value.includes(':')) return undefined;
	if (value.includes('.')) {
		const delimiter = value.lastIndexOf(':');
		const embedded = ipv4Bytes(value.slice(delimiter + 1));
		if (delimiter < 0 || embedded === undefined) return undefined;
		value = `${value.slice(0, delimiter)}:${((embedded[0]! << 8) | embedded[1]!).toString(16)}:${((embedded[2]! << 8) | embedded[3]!).toString(16)}`;
	}
	const halves = value.split('::');
	if (halves.length > 2) return undefined;
	const left = halves[0] === '' ? [] : halves[0]!.split(':');
	const right = halves.length === 1 || halves[1] === '' ? [] : halves[1]!.split(':');
	const missing = 8 - left.length - right.length;
	if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1))
		return undefined;
	const words = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
	if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return undefined;
	return words.flatMap((word) => {
		const parsed = Number.parseInt(word, 16);
		return [parsed >> 8, parsed & 0xff];
	});
}

function embeddedIpv4IsPublic(bytes: readonly number[], start: number, inverted = false): boolean {
	const address = bytes
		.slice(start, start + 4)
		.map((byte) => (inverted ? byte ^ 0xff : byte))
		.join('.');
	return isPublicIpv4(address);
}

function isPublicIpv6(input: string): boolean {
	const bytes = ipv6Bytes(input);
	if (bytes === undefined) return false;
	if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15]! <= 1) return false;
	if ((bytes[0]! & 0xfe) === 0xfc || (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80)) {
		return false;
	}
	if (bytes[0] === 0xff || (bytes[0]! & 0xe0) !== 0x20) return false;
	if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
		return embeddedIpv4IsPublic(bytes, 12);
	}
	if (bytes.slice(0, 12).every((byte) => byte === 0)) return embeddedIpv4IsPublic(bytes, 12);
	if (
		bytes[0] === 0x00 &&
		bytes[1] === 0x64 &&
		bytes[2] === 0xff &&
		bytes[3] === 0x9b &&
		bytes.slice(4, 12).every((byte) => byte === 0)
	) {
		return embeddedIpv4IsPublic(bytes, 12);
	}
	if (bytes[0] === 0x20 && bytes[1] === 0x02) return embeddedIpv4IsPublic(bytes, 2);
	if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0 && bytes[3] === 0) {
		return embeddedIpv4IsPublic(bytes, 12, true);
	}
	if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
		return false;
	}
	return true;
}

function isPublicIpAddress(input: string): boolean {
	return ipv4Bytes(input) !== undefined ? isPublicIpv4(input) : isPublicIpv6(input);
}

function trustedConnectionLookup(
	hostname: string,
	trust: TimeZoneDistributionTrustContext,
): TimeZoneDistributionConnectionBinding['lookup'] {
	return (requestedHostname, options, callback): void => {
		let normalizedRequestedHostname = requestedHostname.toLowerCase();
		if (normalizedRequestedHostname.startsWith('[') && normalizedRequestedHostname.endsWith(']')) {
			normalizedRequestedHostname = normalizedRequestedHostname.slice(1, -1);
		}
		if (normalizedRequestedHostname.endsWith('.')) {
			normalizedRequestedHostname = normalizedRequestedHostname.slice(0, -1);
		}
		if (normalizedRequestedHostname !== hostname) {
			callback(new Error('untrusted anonymous target'), '');
			return;
		}
		hostnameIsTrusted(hostname, trust).then(
			(binding) => {
				if (binding === undefined) {
					callback(new Error('untrusted anonymous target'), '');
					return;
				}
				const family = ipv4Bytes(binding.address) === undefined ? 6 : 4;
				if (options.all === true) {
					callback(null, [{ address: binding.address, family }]);
					return;
				}
				callback(null, binding.address, family);
			},
			() => callback(new Error('untrusted anonymous target'), ''),
		);
	};
}

async function hostnameIsTrusted(
	hostnameInput: string,
	trust: TimeZoneDistributionTrustContext,
): Promise<TimeZoneDistributionConnectionBinding | undefined> {
	let hostname = hostnameInput.toLowerCase();
	if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
	if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
	if (
		hostname.length === 0 ||
		hostname === 'localhost' ||
		hostname.endsWith('.localhost') ||
		hostname.endsWith('.local')
	) {
		return undefined;
	}
	if (ipv4Bytes(hostname) !== undefined || ipv6Bytes(hostname) !== undefined) {
		return isPublicIpAddress(hostname)
			? { hostname, address: hostname, lookup: trustedConnectionLookup(hostname, trust) }
			: undefined;
	}
	let addresses: readonly string[];
	try {
		addresses = await trust.resolveHost(hostname);
	} catch {
		return undefined;
	}
	if (addresses.length === 0 || addresses.length > 32 || !addresses.every(isPublicIpAddress)) {
		return undefined;
	}
	const approvedAddresses = [...new Set(addresses.map((address) => address.toLowerCase()))].sort();
	const identity = approvedAddresses.join('\n');
	const pinned = trust.pinnedAddresses.get(hostname);
	if (pinned !== undefined && pinned !== identity) return undefined;
	trust.pinnedAddresses.set(hostname, identity);
	return {
		hostname,
		address: approvedAddresses[0]!,
		lookup: trustedConnectionLookup(hostname, trust),
	};
}

async function trustedServiceUrl(
	input: string,
	calendarUrl: AbsoluteHttpUrl,
	trust: TimeZoneDistributionTrustContext,
): Promise<TrustedServiceTarget | undefined> {
	let value: AbsoluteHttpUrl;
	try {
		value = validateAbsoluteHttpUrl(input);
	} catch {
		return undefined;
	}
	const url = new URL(value);
	const calendar = new URL(calendarUrl);
	if (calendar.protocol === 'https:' && url.protocol !== 'https:') return undefined;
	const binding = await hostnameIsTrusted(url.hostname, trust);
	return binding === undefined ? undefined : { url: value, binding };
}

function joinServiceUrl(root: AbsoluteHttpUrl, path: string): AbsoluteHttpUrl {
	const base = root.endsWith('/') ? root : (`${root}/` as AbsoluteHttpUrl);
	return validateAbsoluteHttpUrl(new URL(path, base).href);
}

async function requestFollowingTrustedRedirects(
	request: TimeZoneDistributionRequest,
	initialUrl: AbsoluteHttpUrl,
	calendarUrl: AbsoluteHttpUrl,
	trust: TimeZoneDistributionTrustContext,
	headers?: Readonly<Record<string, string>>,
): Promise<CalDavTransportResponse> {
	let url = initialUrl;
	const visited = new Set<string>([url]);
	let followed = 0;
	while (true) {
		const trustedTarget = await trustedServiceUrl(url, calendarUrl, trust);
		if (trustedTarget === undefined) {
			throw new Error('untrusted anonymous target');
		}
		const response = await (
			request as unknown as (
				input: TimeZoneDistributionRequestInput,
				binding: TimeZoneDistributionConnectionBinding,
			) => Promise<CalDavTransportResponse>
		)(
			{
				method: 'GET',
				url,
				...(headers === undefined ? {} : { headers }),
			},
			trustedTarget.binding,
		);
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
			target = (await trustedServiceUrl(new URL(locations[0]!, url).href, calendarUrl, trust))?.url;
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
	const expected = name.toUpperCase();
	return component.entries
		.filter((entry) => entry.kind === 'property' && entry.name.toUpperCase() === expected)
		.map((entry) => (entry.kind === 'property' ? entry.value.raw : ''));
}

function hasSupportedZoneRules(definition: ICalendarComponent, timeZone: IanaTimeZoneId): boolean {
	const observances = definition.entries.filter(
		(entry): entry is ICalendarComponent => entry.kind === 'component',
	);
	if (observances.length === 0) return false;
	const years: number[] = [];
	for (const observance of observances) {
		const starts = componentProperties(observance, 'DTSTART');
		if (starts.length !== 1) return false;
		const match = /^(\d{4})\d{4}T\d{6}$/.exec(starts[0]!);
		if (match === null) return false;
		const year = Number(match[1]);
		if (year < 1 || year > 9999) return false;
		years.push(year);
	}

	const validationInstant = new Date(0);
	validationInstant.setUTCFullYear(Math.max(...years), 6, 1);
	validationInstant.setUTCHours(0, 0, 0, 0);
	try {
		projectInstantInTimeZone(validationInstant, timeZone, definition);
		return true;
	} catch {
		return false;
	}
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
	if (!hasSupportedZoneRules(definitions[0], timeZone)) {
		return fail(TimeZoneReferenceFailureCode.INVALID_RESPONSE);
	}
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
): CalendarEventTimeZoneExecutionContext;
export function createCalendarEventTimeZoneExecutionContext(
	input: CalendarEventTimeZoneExecutionContextInput,
	resolveHost: TimeZoneDistributionHostResolver = resolveTimeZoneDistributionHost,
): CalendarEventTimeZoneExecutionContext {
	const resultCache = new Map<string, Promise<CalendarEventTimeZoneReference>>();
	const serviceCache = new Map<string, Promise<readonly AbsoluteHttpUrl[]>>();
	const capabilityCache = new Map<string, Promise<boolean>>();
	const trust: TimeZoneDistributionTrustContext = {
		resolveHost,
		pinnedAddresses: new Map<string, string>(),
	};

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
			const trustedService = await trustedServiceUrl(advertised, calendarUrl, trust);
			if (trustedService === undefined) continue;
			const service = trustedService.url;
			sawUsableService = true;
			let capabilityPromise = capabilityCache.get(service);
			if (capabilityPromise === undefined) {
				capabilityPromise = requestFollowingTrustedRedirects(
					input.request,
					joinServiceUrl(service, 'capabilities'),
					calendarUrl,
					trust,
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
					trust,
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
