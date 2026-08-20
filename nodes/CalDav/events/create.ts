/* eslint-disable @n8n/community-nodes/require-node-api-error -- The accepted application-service contract exposes sanitized domain failures outside the n8n UI boundary. */

import type {
	CalendarDateString,
	CalendarEvent,
	CalendarEventStatus,
	CalendarEventTransparency,
} from '../icalendar/eventReadModel';
import type { CalendarEventTimeZone } from '../icalendar/timeZones';
import type { CalendarEventTimeZoneExecutionContext } from '../discovery/timeZoneReferences';
import type { CalendarAlarmInput } from '../icalendar/alarms';
import type { RecurrenceRule } from '../icalendar/recurrence';
import { CalDavTransportError } from '../transport/http';
import type { CalDavTransport } from '../transport/http';
import type { AbsoluteHttpUrl } from '../transport/url';
import { CalDavCalendarEventCreateError, CalendarEventCreateFailureCode } from './createErrors';
import { prepareCalendarEventCreate } from './createPreparation';
import { getCalendarEventByResourceUrl } from './getByResourceUrl';
import { createCalendarEventResource } from './mutations';

export { CalDavCalendarEventCreateError, CalendarEventCreateFailureCode } from './createErrors';

interface CalendarEventCreateCommon {
	readonly calendarUrl: AbsoluteHttpUrl;
	readonly uid?: string;
	readonly summary: string;
	readonly description?: string;
	readonly location?: string;
	readonly url?: string;
	readonly categories?: readonly string[];
	readonly status?: CalendarEventStatus;
	readonly transparency?: CalendarEventTransparency;
	readonly recurrence?: RecurrenceRule;
	readonly alarms?: readonly CalendarAlarmInput[];
}

export type CalendarEventCreateInput = CalendarEventCreateCommon &
	(
		| {
				readonly timeMode: 'timed';
				readonly start: Date;
				readonly end: Date;
				readonly timeZone?: CalendarEventTimeZone;
		  }
		| {
				readonly timeMode: 'allDay';
				readonly startDate: CalendarDateString;
				readonly endDate: CalendarDateString;
		  }
	);

export type CalendarEventCreateClock = () => Date;

export type CreatedCalendarEvent = CalendarEvent & {
	readonly etag: string;
};

function safeStatusCode(error: unknown): number | undefined {
	return error instanceof CalDavTransportError ? error.statusCode : undefined;
}

function isDirectCalendarChild(
	calendarUrl: AbsoluteHttpUrl,
	resourceUrl: AbsoluteHttpUrl,
): boolean {
	try {
		const calendar = new URL(calendarUrl);
		const resource = new URL(resourceUrl);
		if (calendar.origin !== resource.origin || !resource.pathname.startsWith(calendar.pathname)) {
			return false;
		}
		const child = resource.pathname.slice(calendar.pathname.length);
		return child.length > 0 && !child.endsWith('/') && !child.includes('/');
	} catch {
		return false;
	}
}

export async function createCalendarEvent(
	transport: CalDavTransport,
	input: CalendarEventCreateInput,
	clock: CalendarEventCreateClock,
	timeZoneContext?: CalendarEventTimeZoneExecutionContext,
): Promise<CreatedCalendarEvent> {
	const prepared = await prepareCalendarEventCreate(input, clock, timeZoneContext);
	const created = await createCalendarEventResource(
		transport,
		input.calendarUrl,
		prepared.resourceUrl,
		prepared.calendarData,
	);

	try {
		const confirmed = await getCalendarEventByResourceUrl(
			transport,
			input.calendarUrl,
			created.resourceUrl,
			{ ...(timeZoneContext === undefined ? {} : { timeZoneContext }) },
		);
		if (
			confirmed.event.etag === undefined ||
			confirmed.event.uid !== prepared.uid ||
			!isDirectCalendarChild(input.calendarUrl, confirmed.event.resourceUrl)
		) {
			throw new CalDavCalendarEventCreateError(
				CalendarEventCreateFailureCode.ETAG_RETRIEVAL_FAILED,
			);
		}
		return Object.freeze({ ...confirmed.event, etag: confirmed.event.etag });
	} catch (error) {
		if (
			error instanceof CalDavCalendarEventCreateError &&
			error.code === CalendarEventCreateFailureCode.ETAG_RETRIEVAL_FAILED
		) {
			throw error;
		}
		throw new CalDavCalendarEventCreateError(
			CalendarEventCreateFailureCode.ETAG_RETRIEVAL_FAILED,
			safeStatusCode(error),
		);
	}
}
