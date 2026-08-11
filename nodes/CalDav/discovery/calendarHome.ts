import { CalDavMethod } from '../transport/http';
import type { CalDavTransport } from '../transport/http';
import { normalizeCalendarCollectionUrl, resolveCalDavHref } from '../transport/url';
import type { AbsoluteHttpUrl } from '../transport/url';
import { parseDavMultiStatus } from '../xml/parser';
import type { DavProperty, DavXmlElement } from '../xml/parser';
import { buildCalendarHomeSetPropfind } from '../xml/requests';

export const CalendarHomeDiscoveryFailureCode = {
	MISSING: 'CALENDAR_HOME_MISSING',
	FORBIDDEN: 'CALENDAR_HOME_FORBIDDEN',
	INVALID_RESPONSE: 'INVALID_CALENDAR_HOME_RESPONSE',
	AMBIGUOUS_RESPONSE: 'AMBIGUOUS_CALENDAR_HOME_RESPONSE',
} as const;
export type CalendarHomeDiscoveryFailureCode =
	(typeof CalendarHomeDiscoveryFailureCode)[keyof typeof CalendarHomeDiscoveryFailureCode];

export interface CalendarHomeDiscoveryOutcome {
	readonly calendarHomeUrl: AbsoluteHttpUrl;
}

const ERROR_MESSAGES: Readonly<Record<CalendarHomeDiscoveryFailureCode, string>> = {
	CALENDAR_HOME_MISSING: 'The CalDAV calendar-home property is unavailable.',
	CALENDAR_HOME_FORBIDDEN: 'The CalDAV calendar-home property is forbidden.',
	INVALID_CALENDAR_HOME_RESPONSE: 'The CalDAV server returned an invalid calendar-home response.',
	AMBIGUOUS_CALENDAR_HOME_RESPONSE:
		'The CalDAV server returned an ambiguous calendar-home response.',
};

export class CalDavCalendarHomeDiscoveryError extends Error {
	readonly code: CalendarHomeDiscoveryFailureCode;

	constructor(code: CalendarHomeDiscoveryFailureCode) {
		super(ERROR_MESSAGES[code]);
		this.name = 'CalDavCalendarHomeDiscoveryError';
		this.code = code;
	}
}

const DAV_NAMESPACE = 'DAV:';
const CALDAV_NAMESPACE = 'urn:ietf:params:xml:ns:caldav';

function fail(code: CalendarHomeDiscoveryFailureCode): never {
	throw new CalDavCalendarHomeDiscoveryError(code);
}

function missing(): never {
	return fail(CalendarHomeDiscoveryFailureCode.MISSING);
}

function invalidResponse(): never {
	return fail(CalendarHomeDiscoveryFailureCode.INVALID_RESPONSE);
}

function ambiguousResponse(): never {
	return fail(CalendarHomeDiscoveryFailureCode.AMBIGUOUS_RESPONSE);
}

function isExpandedName(element: DavXmlElement, namespaceUri: string, localName: string): boolean {
	return element.name.namespaceUri === namespaceUri && element.name.localName === localName;
}

function isCalendarHomeSet(property: DavProperty): boolean {
	return isExpandedName(property, CALDAV_NAMESPACE, 'calendar-home-set');
}

function isXmlWhitespace(value: string): boolean {
	for (const character of value) {
		if (character !== ' ' && character !== '\t' && character !== '\n' && character !== '\r') {
			return false;
		}
	}

	return true;
}

function readHref(element: DavXmlElement): string {
	if (element.attributes.length !== 0) {
		return invalidResponse();
	}

	let href = '';
	for (const child of element.children) {
		if (child.kind === 'element') {
			return invalidResponse();
		}
		href += child.value;
	}

	if (href.length === 0) {
		return invalidResponse();
	}

	return href;
}

function selectHref(property: DavProperty): string {
	if (property.attributes.length !== 0) {
		return invalidResponse();
	}

	const hrefElements: DavXmlElement[] = [];
	for (const child of property.children) {
		if (child.kind === 'text') {
			if (!isXmlWhitespace(child.value)) {
				return invalidResponse();
			}
			continue;
		}

		if (!isExpandedName(child, DAV_NAMESPACE, 'href')) {
			return invalidResponse();
		}
		hrefElements.push(child);
	}

	if (hrefElements.length === 0) {
		return missing();
	}
	if (hrefElements.length > 1) {
		return ambiguousResponse();
	}

	return readHref(hrefElements[0]);
}

export async function discoverCalendarHome(
	transport: CalDavTransport,
	principalUrl: AbsoluteHttpUrl,
): Promise<CalendarHomeDiscoveryOutcome> {
	const response = await transport.request({
		method: CalDavMethod.PROPFIND,
		url: principalUrl,
		headers: {
			Depth: '0',
			'Content-Type': 'application/xml; charset=utf-8',
		},
		body: buildCalendarHomeSetPropfind(),
	});

	if (response.statusCode !== 207) {
		return invalidResponse();
	}

	const multiStatus = parseDavMultiStatus(response.body.toString('utf8'));
	if (multiStatus.responses.length === 0) {
		return missing();
	}
	if (multiStatus.responses.length > 1) {
		return ambiguousResponse();
	}

	const davResponse = multiStatus.responses[0];
	if (davResponse.kind !== 'propstat') {
		return invalidResponse();
	}

	const successfulMatches: DavProperty[] = [];
	let hasForbiddenMatch = false;
	for (const propstat of davResponse.propstats) {
		for (const property of propstat.properties) {
			if (!isCalendarHomeSet(property)) {
				continue;
			}

			if (propstat.status.isSuccessful) {
				successfulMatches.push(property);
			} else if (propstat.status.code === 403) {
				hasForbiddenMatch = true;
			}
		}
	}

	if (successfulMatches.length === 0) {
		return fail(
			hasForbiddenMatch
				? CalendarHomeDiscoveryFailureCode.FORBIDDEN
				: CalendarHomeDiscoveryFailureCode.MISSING,
		);
	}
	if (successfulMatches.length > 1) {
		return ambiguousResponse();
	}

	const href = selectHref(successfulMatches[0]);
	const resolvedUrl = resolveCalDavHref(response.effectiveUrl, href);

	return {
		calendarHomeUrl: normalizeCalendarCollectionUrl(resolvedUrl),
	};
}
