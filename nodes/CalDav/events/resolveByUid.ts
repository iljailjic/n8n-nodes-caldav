import { mapCalendarEventResourceWithTimeZoneContext } from '../icalendar/eventReadModel';
import type { CalendarEventReadResult } from '../icalendar/eventReadModel';
import type { CalendarEventTimeZoneExecutionContext } from '../discovery/timeZoneReferences';
import { parseICalendarResource } from '../icalendar/parser';
import { CalDavMethod } from '../transport/http';
import type { CalDavTransport } from '../transport/http';
import { resolveCalDavHref } from '../transport/url';
import type { AbsoluteHttpUrl } from '../transport/url';
import { parseDavMultiStatus } from '../xml/parser';
import type { DavProperty, DavPropertyResponse } from '../xml/parser';
import { buildCalendarUidQueryReport } from '../xml/requests';

export const CalendarEventUidResolutionFailureCode = Object.freeze({
	NOT_FOUND: 'CALENDAR_EVENT_UID_NOT_FOUND',
	AMBIGUOUS: 'AMBIGUOUS_CALENDAR_EVENT_UID',
	INVALID_RESPONSE: 'INVALID_CALENDAR_EVENT_UID_RESPONSE',
} as const);

export type CalendarEventUidResolutionFailureCode =
	(typeof CalendarEventUidResolutionFailureCode)[keyof typeof CalendarEventUidResolutionFailureCode];

const ERROR_MESSAGES: Readonly<Record<CalendarEventUidResolutionFailureCode, string>> = {
	CALENDAR_EVENT_UID_NOT_FOUND:
		'No calendar event with the requested UID was found in the selected calendar.',
	AMBIGUOUS_CALENDAR_EVENT_UID:
		'More than one calendar event with the requested UID was found in the selected calendar.',
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

function fail(code: CalendarEventUidResolutionFailureCode): never {
	throw new CalDavCalendarEventUidResolutionError(code);
}

function invalidResponse(): never {
	return fail(CalendarEventUidResolutionFailureCode.INVALID_RESPONSE);
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

export async function resolveCalendarEventByUid(
	transport: CalDavTransport,
	calendarUrl: AbsoluteHttpUrl,
	uid: string,
	options: CalendarEventUidResolutionOptions = {},
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

	const multiStatus = parseDavMultiStatus(response.body.toString('utf8'));
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
