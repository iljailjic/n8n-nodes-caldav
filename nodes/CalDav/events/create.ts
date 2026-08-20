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
import { CalDavTransportError } from '../transport/http';
import type { CalDavTransport } from '../transport/http';
import type { AbsoluteHttpUrl } from '../transport/url';
import { CalDavCalendarEventCreateError, CalendarEventCreateFailureCode } from './createErrors';
import { prepareCalendarEventCreate } from './createPreparation';
import { createCalendarEventResource, getCalendarEventMutationEtag } from './mutations';

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

	let resourceUrl = created.resourceUrl;
	let etag = created.etag;
	if (etag === undefined) {
		try {
			const metadata = await getCalendarEventMutationEtag(
				transport,
				input.calendarUrl,
				resourceUrl,
			);
			resourceUrl = metadata.resourceUrl;
			etag = metadata.etag;
		} catch (error) {
			throw new CalDavCalendarEventCreateError(
				CalendarEventCreateFailureCode.ETAG_RETRIEVAL_FAILED,
				safeStatusCode(error),
			);
		}
	}
	return Object.freeze({ ...prepared.event, resourceUrl, etag });
}
