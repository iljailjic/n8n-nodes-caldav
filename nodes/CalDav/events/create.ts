/* eslint-disable @n8n/community-nodes/require-node-api-error -- The accepted application-service contract exposes sanitized domain failures outside the n8n UI boundary. */

import { mapCalendarEventResource } from '../icalendar/eventReadModel';
import type { CalendarDateString, CalendarEvent } from '../icalendar/eventReadModel';
import { parseICalendarResource } from '../icalendar/parser';
import type { ICalendarComponent } from '../icalendar/parser';
import { serializeBasicTimedEvent, serializeBasicUtcEvent } from '../icalendar/serializer';
import type { CalendarEventInstantProjector } from '../icalendar/serializer';
import { projectInstantInTimeZone } from '../icalendar/timeZones';
import type { CalendarEventTimeZone } from '../icalendar/timeZones';
import type { CalendarEventTimeZoneExecutionContext } from '../discovery/timeZoneReferences';
import { CalDavTransportError } from '../transport/http';
import type { CalDavTransport } from '../transport/http';
import { joinCalendarCollectionUrl } from '../transport/url';
import type { AbsoluteHttpUrl } from '../transport/url';
import { getCalendarEventByResourceUrl } from './getByResourceUrl';
import { createCalendarEventResource } from './mutations';
import { resolveCalendarEventTimeZoneAuthoring } from './timeZoneAuthoring';
import { resolveCalendarEventUid } from './uid';

interface CalendarEventCreateCommon {
	readonly calendarUrl: AbsoluteHttpUrl;
	readonly uid?: string;
	readonly summary: string;
	readonly description?: string;
	readonly location?: string;
	readonly url?: string;
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

export const CalendarEventCreateFailureCode = Object.freeze({
	RESOURCE_NAME_TOO_LONG: 'CALENDAR_EVENT_CREATE_RESOURCE_NAME_TOO_LONG',
	INVALID_CLOCK: 'CALENDAR_EVENT_CREATE_INVALID_CLOCK',
	NORMALIZATION_FAILED: 'CALENDAR_EVENT_CREATE_NORMALIZATION_FAILED',
	ETAG_RETRIEVAL_FAILED: 'CALENDAR_EVENT_CREATE_ETAG_RETRIEVAL_FAILED',
} as const);

export type CalendarEventCreateFailureCode =
	(typeof CalendarEventCreateFailureCode)[keyof typeof CalendarEventCreateFailureCode];

const ERROR_MESSAGES: Readonly<Record<CalendarEventCreateFailureCode, string>> = {
	CALENDAR_EVENT_CREATE_RESOURCE_NAME_TOO_LONG:
		'UID is too long to create a safe event resource name.',
	CALENDAR_EVENT_CREATE_INVALID_CLOCK: 'The calendar event clock is invalid.',
	CALENDAR_EVENT_CREATE_NORMALIZATION_FAILED:
		'The serialized calendar event could not be normalized.',
	CALENDAR_EVENT_CREATE_ETAG_RETRIEVAL_FAILED:
		'The event was created, but its required ETag could not be retrieved.',
};

export class CalDavCalendarEventCreateError extends Error {
	readonly code: CalendarEventCreateFailureCode;
	readonly statusCode?: number;

	constructor(code: CalendarEventCreateFailureCode, statusCode?: number) {
		super(ERROR_MESSAGES[code]);
		this.name = 'CalDavCalendarEventCreateError';
		this.code = code;
		if (
			Number.isInteger(statusCode) &&
			(statusCode as number) >= 100 &&
			(statusCode as number) <= 599
		) {
			this.statusCode = statusCode;
		}
	}
}

const MAX_RESOURCE_SEGMENT_BYTES = 255;

function resourceNameForUid(uid: string): string {
	const encoded = Buffer.from(uid, 'utf8')
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/u, '');
	const resourceName = `${encoded}.ics`;
	if (Buffer.byteLength(resourceName, 'ascii') > MAX_RESOURCE_SEGMENT_BYTES) {
		throw new CalDavCalendarEventCreateError(CalendarEventCreateFailureCode.RESOURCE_NAME_TOO_LONG);
	}
	return resourceName;
}

function readClock(clock: CalendarEventCreateClock): Date {
	try {
		const value = clock();
		if (!(value instanceof Date)) {
			throw new CalDavCalendarEventCreateError(CalendarEventCreateFailureCode.INVALID_CLOCK);
		}
		const timestamp = Date.prototype.getTime.call(value);
		if (!Number.isFinite(timestamp)) {
			throw new CalDavCalendarEventCreateError(CalendarEventCreateFailureCode.INVALID_CLOCK);
		}
		const wholeSecond = new Date(Math.floor(timestamp / 1000) * 1000);
		const year = wholeSecond.getUTCFullYear();
		if (year < 1 || year > 9999) {
			throw new CalDavCalendarEventCreateError(CalendarEventCreateFailureCode.INVALID_CLOCK);
		}
		return wholeSecond;
	} catch (error) {
		if (error instanceof CalDavCalendarEventCreateError) throw error;
		throw new CalDavCalendarEventCreateError(CalendarEventCreateFailureCode.INVALID_CLOCK);
	}
}

function normalizeCreatedEvent(
	input: CalendarEventCreateInput,
	resourceUrl: AbsoluteHttpUrl,
	calendarData: string,
	timeZoneDefinition?: ICalendarComponent,
): CalendarEvent {
	try {
		const resource = parseICalendarResource(Buffer.from(calendarData, 'utf8'));
		const event = mapCalendarEventResource({
			calendarUrl: input.calendarUrl,
			resourceUrl,
			resource,
			...(timeZoneDefinition === undefined ? {} : { timeZoneDefinition }),
		}).event;
		if (event.summary === undefined || event.accessMode !== 'editable') {
			throw new CalDavCalendarEventCreateError(CalendarEventCreateFailureCode.NORMALIZATION_FAILED);
		}
		return event;
	} catch (error) {
		if (
			error instanceof CalDavCalendarEventCreateError &&
			error.code === CalendarEventCreateFailureCode.NORMALIZATION_FAILED
		) {
			throw error;
		}
		throw new CalDavCalendarEventCreateError(CalendarEventCreateFailureCode.NORMALIZATION_FAILED);
	}
}
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
	const timeZone =
		input.timeMode === 'timed'
			? (input.timeZone ?? { timeZoneMode: 'utc' as const })
			: ({ timeZoneMode: 'utc' } as const);
	let timeZoneDefinition: ICalendarComponent | undefined;
	let embeddedTimeZoneDefinition: ICalendarComponent | undefined;
	let projectInstant: CalendarEventInstantProjector | undefined;
	if (timeZone.timeZoneMode === 'iana') {
		if (input.timeMode !== 'timed') {
			throw new CalDavCalendarEventCreateError(CalendarEventCreateFailureCode.NORMALIZATION_FAILED);
		}
		const selection = await resolveCalendarEventTimeZoneAuthoring({
			calendarUrl: input.calendarUrl,
			timeZone: timeZone.timeZone,
			coverage: { kind: 'finite', interval: { start: input.start, end: input.end } },
			...(timeZoneContext === undefined ? {} : { referenceContext: timeZoneContext }),
		});
		timeZoneDefinition = selection.definition;
		if (selection.embed) embeddedTimeZoneDefinition = selection.definition;
		const definition = timeZoneDefinition;
		projectInstant = (instant, selectedTimeZone) =>
			projectInstantInTimeZone(instant, selectedTimeZone, definition);
	}
	const uid = resolveCalendarEventUid(input.uid);
	const resourceUrl = joinCalendarCollectionUrl(input.calendarUrl, resourceNameForUid(uid));
	const dtstamp = readClock(clock);
	const common = {
		uid,
		dtstamp,
		summary: input.summary,
		...(input.description === undefined ? {} : { description: input.description }),
		...(input.location === undefined ? {} : { location: input.location }),
		...(input.url === undefined ? {} : { url: input.url }),
	};
	const calendarData =
		input.timeMode === 'allDay'
			? serializeBasicUtcEvent({
					...common,
					timeMode: 'allDay',
					startDate: input.startDate,
					endDate: input.endDate,
				})
			: serializeBasicTimedEvent(
					{
						...common,
						timeMode: 'timed',
						start: input.start,
						end: input.end,
						timeZone,
					},
					projectInstant,
					embeddedTimeZoneDefinition,
				);
	const normalized = normalizeCreatedEvent(input, resourceUrl, calendarData, timeZoneDefinition);
	if (
		(input.timeMode === 'timed' &&
			(normalized.timeMode !== 'timed' ||
				normalized.start !== input.start.toISOString().replace('.000Z', 'Z') ||
				normalized.end !== input.end.toISOString().replace('.000Z', 'Z'))) ||
		(input.timeMode === 'allDay' &&
			(normalized.timeMode !== 'allDay' ||
				normalized.startDate !== input.startDate ||
				normalized.endDate !== input.endDate))
	) {
		throw new CalDavCalendarEventCreateError(CalendarEventCreateFailureCode.NORMALIZATION_FAILED);
	}
	const created = await createCalendarEventResource(
		transport,
		input.calendarUrl,
		resourceUrl,
		calendarData,
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
			confirmed.event.uid !== uid ||
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
