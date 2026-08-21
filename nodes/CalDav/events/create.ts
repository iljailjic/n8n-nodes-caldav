/* eslint-disable @n8n/community-nodes/require-node-api-error -- The accepted application-service contract exposes sanitized domain failures outside the n8n UI boundary. */

import type {
	CalendarDateString,
	CalendarEvent,
	CalendarEventStatus,
	CalendarEventTransparency,
} from '../icalendar/eventReadModel';
import { mapCalendarEventResource } from '../icalendar/eventReadModel';
import type { CalendarEventTimeZone } from '../icalendar/timeZones';
import type { CalendarEventTimeZoneExecutionContext } from '../discovery/timeZoneReferences';
import type { CalendarAlarmInput } from '../icalendar/alarms';
import type { RecurrenceRule } from '../icalendar/recurrence';
import { CalDavTransportError } from '../transport/http';
import type { CalDavTransport } from '../transport/http';
import type { AbsoluteHttpUrl } from '../transport/url';
import { CalDavCalendarEventCreateError, CalendarEventCreateFailureCode } from './createErrors';
import { calendarEventResourceUrlForUid, prepareCalendarEventCreate } from './createPreparation';
import { createCalendarEventResource, getCalendarEventMutationEtag } from './mutations';
import {
	CalDavRawCalendarEventError,
	RawCalendarEventFailureCode,
	prepareRawCalendarEventWrite,
} from '../icalendar/rawEventWrite';
import type { PreparedRawCalendarEventWrite } from '../icalendar/rawEventWrite';

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

type ExistingCalendarEventCreateInput = CalendarEventCreateCommon &
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

export type StructuredCalendarEventCreateInput = ExistingCalendarEventCreateInput & {
	readonly inputMode?: 'structured';
};

export interface RawCalendarEventCreateInput {
	readonly calendarUrl: AbsoluteHttpUrl;
	readonly inputMode: 'rawIcs';
	readonly rawIcs: string;
}

export type CalendarEventCreateInput =
	StructuredCalendarEventCreateInput | RawCalendarEventCreateInput;

export type CalendarEventCreateClock = () => Date;

export type CreatedCalendarEvent = CalendarEvent & {
	readonly etag: string;
};

function safeStatusCode(error: unknown): number | undefined {
	return error instanceof CalDavTransportError ? error.statusCode : undefined;
}

function assertCreateInputMode(
	input: CalendarEventCreateInput,
): asserts input is StructuredCalendarEventCreateInput | RawCalendarEventCreateInput {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) {
		throw new CalDavRawCalendarEventError(RawCalendarEventFailureCode.INVALID_INPUT_MODE);
	}
	const mode = (input as { readonly inputMode?: unknown }).inputMode;
	if (mode !== undefined && mode !== 'structured' && mode !== 'rawIcs') {
		throw new CalDavRawCalendarEventError(RawCalendarEventFailureCode.INVALID_INPUT_MODE);
	}
	if (mode === 'rawIcs') {
		const allowed = new Set(['calendarUrl', 'inputMode', 'rawIcs']);
		if (Reflect.ownKeys(input).some((key) => typeof key !== 'string' || !allowed.has(key))) {
			throw new CalDavRawCalendarEventError(RawCalendarEventFailureCode.INVALID_INPUT_MODE);
		}
	} else if (Object.prototype.hasOwnProperty.call(input, 'rawIcs')) {
		throw new CalDavRawCalendarEventError(RawCalendarEventFailureCode.INVALID_INPUT_MODE);
	}
}

async function createPreparedRawCalendarEvent(
	transport: CalDavTransport,
	calendarUrl: AbsoluteHttpUrl,
	prepared: PreparedRawCalendarEventWrite,
): Promise<CreatedCalendarEvent> {
	const targetResourceUrl = calendarEventResourceUrlForUid(calendarUrl, prepared.uid);
	const created = await createCalendarEventResource(
		transport,
		calendarUrl,
		targetResourceUrl,
		prepared.calendarData,
	);
	let resourceUrl = created.resourceUrl;
	let etag = created.etag;
	if (etag === undefined) {
		try {
			const metadata = await getCalendarEventMutationEtag(transport, calendarUrl, resourceUrl);
			resourceUrl = metadata.resourceUrl;
			etag = metadata.etag;
		} catch (error) {
			throw new CalDavCalendarEventCreateError(
				CalendarEventCreateFailureCode.ETAG_RETRIEVAL_FAILED,
				safeStatusCode(error),
			);
		}
	}
	const event = mapCalendarEventResource({
		calendarUrl,
		resourceUrl,
		etag,
		resource: prepared.resource,
	}).event;
	return Object.freeze({ ...event, resourceUrl, etag });
}

export async function createCalendarEvent(
	transport: CalDavTransport,
	input: CalendarEventCreateInput,
	clock: CalendarEventCreateClock,
	timeZoneContext?: CalendarEventTimeZoneExecutionContext,
): Promise<CreatedCalendarEvent> {
	assertCreateInputMode(input);
	if (input.inputMode === 'rawIcs') {
		const prepared = prepareRawCalendarEventWrite({ operation: 'create', rawIcs: input.rawIcs });
		return await createPreparedRawCalendarEvent(transport, input.calendarUrl, prepared);
	}
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
