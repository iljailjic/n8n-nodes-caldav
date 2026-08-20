/* eslint-disable @n8n/community-nodes/require-node-api-error -- Internal application preparation uses domain failures mapped at the node boundary. */

import { randomUUID } from 'node:crypto';

import type { CalendarEventTimeZoneExecutionContext } from '../discovery/timeZoneReferences';
import {
	createCalendarEventPreservationContext,
	mapCalendarEventResource,
} from '../icalendar/eventReadModel';
import type {
	CalendarDateString,
	CalendarEvent,
	UtcDateTimeString,
} from '../icalendar/eventReadModel';
import { authorCalendarAlarms } from '../icalendar/alarms';
import type { CalendarAlarmUidGenerator } from '../icalendar/alarms';
import { parseICalendarResource } from '../icalendar/parser';
import type { ICalendarComponent } from '../icalendar/parser';
import { classifyIanaRecurrenceCoverage, normalizeRecurrenceRule } from '../icalendar/recurrence';
import type { RecurrenceRule, RecurrenceStartContext } from '../icalendar/recurrence';
import {
	serializeBasicTimedEvent,
	serializeBasicUtcEvent,
	serializeICalendarResource,
} from '../icalendar/serializer';
import type { CalendarEventInstantProjector } from '../icalendar/serializer';
import { projectInstantInTimeZone } from '../icalendar/timeZones';
import { joinCalendarCollectionUrl } from '../transport/url';
import type { AbsoluteHttpUrl } from '../transport/url';
import type { CalendarEventCreateClock, CalendarEventCreateInput } from './create';
import { CalDavCalendarEventCreateError, CalendarEventCreateFailureCode } from './createErrors';
import { resolveCalendarEventTimeZoneAuthoring } from './timeZoneAuthoring';
import type { CalendarEventTimeZoneAuthoringCoverage } from './timeZoneAuthoring';
import { resolveCalendarEventUid } from './uid';
import type { CalendarEventUidGenerator } from './uid';

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

export interface PreparedCalendarEventCreate {
	readonly calendarData: string;
	readonly event: CalendarEvent;
	readonly resourceUrl: AbsoluteHttpUrl;
	readonly uid: string;
}

function utcString(value: Date): UtcDateTimeString {
	return value.toISOString().replace('.000Z', 'Z') as UtcDateTimeString;
}

function recurrenceStartContext(input: CalendarEventCreateInput): RecurrenceStartContext {
	if (input.timeMode === 'allDay') {
		return { timeMode: 'allDay', startDate: input.startDate as CalendarDateString };
	}
	const timeZone = input.timeZone ?? { timeZoneMode: 'utc' as const };
	if (timeZone.timeZoneMode === 'utc') {
		return { timeMode: 'timed', timeZoneMode: 'utc', start: utcString(input.start) };
	}
	return {
		timeMode: 'timed',
		timeZoneMode: 'iana',
		start: utcString(input.start),
		startLocal: projectInstantInTimeZone(input.start, timeZone.timeZone),
	};
}

function normalizedRecurrence(
	input: CalendarEventCreateInput,
	start: RecurrenceStartContext,
): RecurrenceRule | undefined {
	return input.recurrence === undefined
		? undefined
		: normalizeRecurrenceRule(input.recurrence, start);
}

function ianaCoverage(
	input: Extract<CalendarEventCreateInput, { readonly timeMode: 'timed' }>,
	recurrence: RecurrenceRule | undefined,
	start: Extract<RecurrenceStartContext, { readonly timeZoneMode: 'iana' }>,
): CalendarEventTimeZoneAuthoringCoverage {
	if (recurrence === undefined) {
		return { kind: 'finite', interval: { start: input.start, end: input.end } };
	}
	const classification = classifyIanaRecurrenceCoverage(recurrence, start);
	if (classification.kind === 'requiresReference') return { kind: classification.bound };
	const duration = input.end.getTime() - input.start.getTime();
	return {
		kind: 'finite',
		interval: {
			start: new Date(classification.interval.start),
			end: new Date(new Date(classification.interval.end).getTime() + duration),
		},
	};
}

export async function prepareCalendarEventCreate(
	input: CalendarEventCreateInput,
	clock: CalendarEventCreateClock,
	timeZoneContext?: CalendarEventTimeZoneExecutionContext,
	uidGenerator?: CalendarEventUidGenerator,
	alarmUidGenerator: CalendarAlarmUidGenerator = randomUUID,
): Promise<PreparedCalendarEventCreate> {
	const recurrenceStart = recurrenceStartContext(input);
	const recurrence = normalizedRecurrence(input, recurrenceStart);
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
			coverage: ianaCoverage(
				input,
				recurrence,
				recurrenceStart as Extract<RecurrenceStartContext, { readonly timeZoneMode: 'iana' }>,
			),
			...(timeZoneContext === undefined ? {} : { referenceContext: timeZoneContext }),
		});
		timeZoneDefinition = selection.definition;
		if (selection.embed) embeddedTimeZoneDefinition = selection.definition;
		const definition = timeZoneDefinition;
		projectInstant = (instant, selectedTimeZone) =>
			projectInstantInTimeZone(instant, selectedTimeZone, definition);
	}
	const uid = resolveCalendarEventUid(input.uid, uidGenerator);
	const resourceUrl = joinCalendarCollectionUrl(input.calendarUrl, resourceNameForUid(uid));
	const dtstamp = readClock(clock);
	const common = {
		uid,
		dtstamp,
		summary: input.summary,
		...(input.description === undefined ? {} : { description: input.description }),
		...(input.location === undefined ? {} : { location: input.location }),
		...(input.url === undefined ? {} : { url: input.url }),
		...(input.categories === undefined ? {} : { categories: input.categories }),
		...(input.status === undefined ? {} : { status: input.status }),
		...(input.transparency === undefined ? {} : { transparency: input.transparency }),
		...(recurrence === undefined ? {} : { recurrence }),
	};
	let calendarData =
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
	if (input.alarms !== undefined) {
		const resource = parseICalendarResource(Buffer.from(calendarData, 'utf8'));
		const context = createCalendarEventPreservationContext(resource);
		const alarmMaster = authorCalendarAlarms(context.master, input.alarms, alarmUidGenerator);
		calendarData = serializeICalendarResource({
			kind: 'resource',
			originalIcs: '',
			calendar: {
				kind: 'component',
				name: resource.calendar.name,
				entries: resource.calendar.entries.map((entry) =>
					entry === context.master ? alarmMaster : entry,
				),
			},
		});
	}
	const event = normalizeCreatedEvent(input, resourceUrl, calendarData, timeZoneDefinition);
	if (
		(input.timeMode === 'timed' &&
			(event.timeMode !== 'timed' ||
				event.start !== input.start.toISOString().replace('.000Z', 'Z') ||
				event.end !== input.end.toISOString().replace('.000Z', 'Z'))) ||
		(input.timeMode === 'allDay' &&
			(event.timeMode !== 'allDay' ||
				event.startDate !== input.startDate ||
				event.endDate !== input.endDate))
	) {
		throw new CalDavCalendarEventCreateError(CalendarEventCreateFailureCode.NORMALIZATION_FAILED);
	}
	return Object.freeze({ calendarData, event, resourceUrl, uid });
}
