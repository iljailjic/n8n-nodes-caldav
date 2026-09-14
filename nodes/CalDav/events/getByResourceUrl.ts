/* eslint-disable @n8n/community-nodes/require-node-api-error -- The accepted application-service contract exposes sanitized parser failures outside the n8n UI boundary. */

import { mapCalendarEventResourceWithTimeZoneContext } from '../icalendar/eventReadModel';
import type { CalendarEventReadResult } from '../icalendar/eventReadModel';
import type { CalendarEventTimeZoneExecutionContext } from '../discovery/timeZoneReferences';
import {
	CalDavICalendarParseError,
	ICALENDAR_MAX_RESOURCE_BYTES,
	parseICalendarResource,
} from '../icalendar/parser';
import { CalDavMethod, decodeCalDavTextBody } from '../transport/http';
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

function canonicalPathForContainment(pathname: string): string {
	return pathname.replace(/%[\dA-Fa-f]{2}/g, (escape) => escape.toUpperCase());
}

function isDirectCalendarChild(
	calendarUrl: AbsoluteHttpUrl,
	resourceUrl: AbsoluteHttpUrl,
): boolean {
	try {
		const calendar = new URL(calendarUrl);
		const resource = new URL(resourceUrl);
		if (calendar.origin !== resource.origin || !calendar.pathname.endsWith('/')) return false;
		const calendarPathname = canonicalPathForContainment(calendar.pathname);
		const resourcePathname = canonicalPathForContainment(resource.pathname);
		if (!resourcePathname.startsWith(calendarPathname)) return false;

		const child = resourcePathname.slice(calendarPathname.length);
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

	try {
		validateAbsoluteHttpUrl(response.effectiveUrl);
	} catch {
		return fail(CalendarEventResourceGetFailureCode.INVALID_RESPONSE);
	}

	if (response.body.byteLength > ICALENDAR_MAX_RESOURCE_BYTES) {
		throw new CalDavICalendarParseError('MAX_RESOURCE_SIZE_EXCEEDED');
	}
	let decodedBody: string;
	try {
		decodedBody = decodeCalDavTextBody(response.body, response.headers);
	} catch {
		throw new CalDavICalendarParseError('INVALID_UTF8');
	}
	const resource = parseICalendarResource(Buffer.from(decodedBody, 'utf8'));
	return await mapCalendarEventResourceWithTimeZoneContext(
		{
			calendarUrl: normalizedCalendarUrl,
			// A redirect target is a transport concern, not a calendar-resource
			// identifier. The requested URL was validated as a direct child before
			// the credential-bearing GET, so retain it as the event identity.
			resourceUrl: canonicalResourceUrl,
			...(response.etag === undefined ? {} : { etag: response.etag }),
			resource,
		},
		options.timeZoneContext,
	);
}
