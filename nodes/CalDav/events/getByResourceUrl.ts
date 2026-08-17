import { mapCalendarEventResourceWithTimeZoneContext } from '../icalendar/eventReadModel';
import type { CalendarEventReadResult } from '../icalendar/eventReadModel';
import type { CalendarEventTimeZoneExecutionContext } from '../discovery/timeZoneReferences';
import { parseICalendarResource } from '../icalendar/parser';
import { CalDavMethod } from '../transport/http';
import type { CalDavTransport } from '../transport/http';
import { normalizeCalendarCollectionUrl, validateAbsoluteHttpUrl } from '../transport/url';
import type { AbsoluteHttpUrl } from '../transport/url';

export const CalendarEventResourceGetFailureCode = Object.freeze({
	OUTSIDE_CALENDAR: 'CALENDAR_EVENT_RESOURCE_OUTSIDE_CALENDAR',
	INVALID_RESPONSE: 'INVALID_CALENDAR_EVENT_RESOURCE_RESPONSE',
} as const);

export type CalendarEventResourceGetFailureCode =
	(typeof CalendarEventResourceGetFailureCode)[keyof typeof CalendarEventResourceGetFailureCode];

const ERROR_MESSAGES: Readonly<Record<CalendarEventResourceGetFailureCode, string>> = {
	CALENDAR_EVENT_RESOURCE_OUTSIDE_CALENDAR:
		'The event resource URL is outside the selected calendar.',
	INVALID_CALENDAR_EVENT_RESOURCE_RESPONSE:
		'The CalDAV server returned an invalid calendar-event resource response.',
};

export class CalDavCalendarEventResourceGetError extends Error {
	readonly code: CalendarEventResourceGetFailureCode;

	constructor(code: CalendarEventResourceGetFailureCode) {
		super(ERROR_MESSAGES[code]);
		this.name = 'CalDavCalendarEventResourceGetError';
		this.code = code;
	}
}

function fail(code: CalendarEventResourceGetFailureCode): never {
	throw new CalDavCalendarEventResourceGetError(code);
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

export interface CalendarEventResourceGetOptions {
	readonly allowMissingEtag?: boolean;
	readonly timeZoneContext?: CalendarEventTimeZoneExecutionContext;
}

export async function getCalendarEventByResourceUrl(
	transport: CalDavTransport,
	calendarUrl: AbsoluteHttpUrl,
	resourceUrl: AbsoluteHttpUrl,
	options: CalendarEventResourceGetOptions = {},
): Promise<CalendarEventReadResult> {
	let normalizedCalendarUrl: AbsoluteHttpUrl;
	let canonicalResourceUrl: AbsoluteHttpUrl;
	try {
		normalizedCalendarUrl = normalizeCalendarCollectionUrl(calendarUrl);
		canonicalResourceUrl = validateAbsoluteHttpUrl(resourceUrl);
	} catch {
		return fail(CalendarEventResourceGetFailureCode.OUTSIDE_CALENDAR);
	}

	if (!isDirectCalendarChild(normalizedCalendarUrl, canonicalResourceUrl)) {
		return fail(CalendarEventResourceGetFailureCode.OUTSIDE_CALENDAR);
	}

	const response = await transport.request({ method: CalDavMethod.GET, url: resourceUrl });
	if (
		response.statusCode !== 200 ||
		(response.etag === undefined && options.allowMissingEtag !== true)
	) {
		return fail(CalendarEventResourceGetFailureCode.INVALID_RESPONSE);
	}

	let effectiveResourceUrl: AbsoluteHttpUrl;
	try {
		effectiveResourceUrl = validateAbsoluteHttpUrl(response.effectiveUrl);
	} catch {
		return fail(CalendarEventResourceGetFailureCode.INVALID_RESPONSE);
	}

	const resource = parseICalendarResource(response.body);
	return await mapCalendarEventResourceWithTimeZoneContext(
		{
			calendarUrl: normalizedCalendarUrl,
			resourceUrl: effectiveResourceUrl,
			...(response.etag === undefined ? {} : { etag: response.etag }),
			resource,
		},
		options.timeZoneContext,
	);
}
