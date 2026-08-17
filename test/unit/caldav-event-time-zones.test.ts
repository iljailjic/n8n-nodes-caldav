import { describe, expect, it } from 'vitest';

import {
	createCalendarEventPreservationContext,
	mapCalendarEventResource,
	mapCalendarEventResourceWithTimeZoneContext,
} from '../../nodes/CalDav/icalendar/eventReadModel';
import { parseICalendarResource } from '../../nodes/CalDav/icalendar/parser';
import { applyCalendarEventPatch } from '../../nodes/CalDav/icalendar/patcher';
import type { CalendarEventPatch } from '../../nodes/CalDav/icalendar/patcher';
import {
	serializeBasicTimedEvent,
	serializeBasicUtcEvent,
	serializeICalendarResource,
} from '../../nodes/CalDav/icalendar/serializer';
import type { BasicTimedEventSerializationInput } from '../../nodes/CalDav/icalendar/serializer';
import {
	canonicalizeIanaTimeZone,
	projectInstantInTimeZone,
} from '../../nodes/CalDav/icalendar/timeZones';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';
import {
	PRAGUE_VTIMEZONE,
	READ_ONLY_EVENT_ORACLE,
	SUPPORTED_EMBEDDED_IANA_EVENT,
	SUPPORTED_BARE_IANA_EVENT,
	SUPPORTED_UTC_EVENT,
	TZDIST_ZONE_RESPONSE,
	UNSUPPORTED_UNREFERENCED_VTIMEZONE,
	timedEventIcs,
} from './fixtures/time-zones/synthetic-time-zone-fixtures';

const encoder = new TextEncoder();
const CALENDAR_URL = validateAbsoluteHttpUrl('https://calendar.example.test/calendars/work/');
const RESOURCE_URL = validateAbsoluteHttpUrl(
	'https://calendar.example.test/calendars/work/event.ics',
);

function parse(ics: string) {
	return parseICalendarResource(encoder.encode(ics));
}

function map(ics: string) {
	return mapCalendarEventResource({
		calendarUrl: CALENDAR_URL,
		resourceUrl: RESOURCE_URL,
		etag: '"synthetic-etag"',
		resource: parse(ics),
	}).event;
}

function basicTimedInput(
	overrides: Partial<BasicTimedEventSerializationInput> = {},
): BasicTimedEventSerializationInput {
	return {
		uid: 'synthetic-event',
		dtstamp: new Date('2040-01-01T00:00:00Z'),
		start: new Date('2040-01-15T09:00:00Z'),
		end: new Date('2040-01-15T10:00:00Z'),
		summary: 'Synthetic event',
		timeZone: { timeZoneMode: 'utc' },
		...overrides,
	};
}

describe('timed event serialization and projection', () => {
	it('keeps serializeBasicUtcEvent compatible and emits the exact UTC wire form', () => {
		const legacy = serializeBasicUtcEvent(basicTimedInput());
		const timed = serializeBasicTimedEvent(basicTimedInput());
		expect(timed).toBe(legacy);
		expect(timed).toContain('DTSTART:20400115T090000Z\r\nDTEND:20400115T100000Z');
		expect(timed).not.toMatch(/TZID|VTIMEZONE/);
	});

	it('emits one canonical TZID on local DTSTART/DTEND without Z, offset, or generated VTIMEZONE', () => {
		const output = serializeBasicTimedEvent(
			basicTimedInput({
				timeZone: {
					timeZoneMode: 'iana',
					timeZone: canonicalizeIanaTimeZone('europe/prague'),
				},
			}),
		);
		expect(output).toContain(
			'DTSTART;TZID=Europe/Prague:20400115T100000\r\nDTEND;TZID=Europe/Prague:20400115T110000',
		);
		expect(output).not.toMatch(/BEGIN:VTIMEZONE|20400115T1[01]0000Z|[+-]\d{4}/);
	});

	it('returns exact ordered UTC and IANA model keys with authoritative whole-second instants', () => {
		const utc = map(SUPPORTED_UTC_EVENT);
		const iana = map(SUPPORTED_EMBEDDED_IANA_EVENT);
		expect(Object.keys(utc)).toEqual([
			'calendarUrl',
			'resourceUrl',
			'etag',
			'uid',
			'summary',
			'timeMode',
			'accessMode',
			'start',
			'end',
			'timeZoneMode',
			'startLocal',
			'endLocal',
		]);
		expect(utc).toMatchObject({
			timeMode: 'timed',
			accessMode: 'editable',
			start: '2040-01-15T09:00:00Z',
			end: '2040-01-15T10:00:00Z',
			timeZoneMode: 'utc',
			startLocal: '2040-01-15T09:00:00',
			endLocal: '2040-01-15T10:00:00',
		});
		expect(Object.keys(iana)).toEqual([
			'calendarUrl',
			'resourceUrl',
			'etag',
			'uid',
			'summary',
			'timeMode',
			'accessMode',
			'start',
			'end',
			'timeZoneMode',
			'timeZone',
			'startLocal',
			'endLocal',
		]);
		expect(iana).toMatchObject({
			timeMode: 'timed',
			accessMode: 'editable',
			timeZoneMode: 'iana',
			timeZone: 'Europe/Prague',
			startLocal: '2040-07-15T10:00:00',
			endLocal: '2040-07-15T11:00:00',
		});
	});

	it('uses embedded VTIMEZONE rules instead of current Intl rules', () => {
		const event = map(SUPPORTED_EMBEDDED_IANA_EVENT);
		// The synthetic definition deliberately uses +03:00 in July 2040, unlike real Prague (+02:00).
		expect(event.start).toBe('2040-07-15T07:00:00Z');
		expect(event.end).toBe('2040-07-15T08:00:00Z');
	});

	it('projects authored wire values through authoritative referenced rules without embedding them', () => {
		const resource = parse(SUPPORTED_EMBEDDED_IANA_EVENT);
		const definition = resource.calendar.entries.find(
			(entry) => entry.kind === 'component' && entry.name === 'VTIMEZONE',
		);
		expect(definition).toBeDefined();
		const timeZone = canonicalizeIanaTimeZone('Europe/Prague');
		const serialized = serializeBasicTimedEvent(
			basicTimedInput({
				start: new Date('2040-07-15T07:00:00Z'),
				end: new Date('2040-07-15T08:00:00Z'),
				timeZone: { timeZoneMode: 'iana', timeZone },
			}),
			(instant, selectedTimeZone) =>
				projectInstantInTimeZone(instant, selectedTimeZone, definition!),
		);
		expect(serialized).toContain(
			'DTSTART;TZID=Europe/Prague:20400715T100000\r\nDTEND;TZID=Europe/Prague:20400715T110000',
		);
		expect(serialized).not.toContain('BEGIN:VTIMEZONE');
	});

	it('resolves a bare IANA read through the optional execution context and uses referenced rules', async () => {
		const result = await mapCalendarEventResourceWithTimeZoneContext(
			{
				calendarUrl: CALENDAR_URL,
				resourceUrl: RESOURCE_URL,
				resource: parse(SUPPORTED_BARE_IANA_EVENT),
			},
			{
				resolveReference: async () => ({
					timeZone: canonicalizeIanaTimeZone('Europe/Prague'),
					etag: '"synthetic-reference"',
					calendarData: TZDIST_ZONE_RESPONSE,
					ruleSource: 'vtimezone',
				}),
			},
		);
		expect(result.event).toMatchObject({
			accessMode: 'editable',
			timeZoneMode: 'iana',
			start: '2040-01-15T08:00:00Z',
			end: '2040-01-15T09:00:00Z',
		});
	});

	it('keeps a bare IANA read safe and read-only when reference resolution fails', async () => {
		const result = await mapCalendarEventResourceWithTimeZoneContext(
			{
				calendarUrl: CALENDAR_URL,
				resourceUrl: RESOURCE_URL,
				resource: parse(SUPPORTED_BARE_IANA_EVENT),
			},
			{ resolveReference: async () => Promise.reject(new Error('synthetic failure')) },
		);
		expect(result.event).toMatchObject({
			timeMode: 'unsupported',
			accessMode: 'readOnly',
			readOnlyReason: 'unsupportedTimeRepresentation',
		});
	});
});

describe('safe unsupported and hard-failure boundaries', () => {
	it.each(READ_ONLY_EVENT_ORACLE)(
		'maps $name to the exact read-only shape without unproven fields',
		({ ics }) => {
			const event = map(ics);
			expect(event).toMatchObject({
				calendarUrl: CALENDAR_URL,
				resourceUrl: RESOURCE_URL,
				uid: 'synthetic-time-zone-event',
				timeMode: 'unsupported',
				accessMode: 'readOnly',
				readOnlyReason: 'unsupportedTimeRepresentation',
			});
			expect(Object.keys(event)).not.toEqual(
				expect.arrayContaining([
					'start',
					'end',
					'timeZoneMode',
					'timeZone',
					'startLocal',
					'endLocal',
				]),
			);
		},
	);

	it.each([
		['malformed ICS', 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:secret'],
		[
			'multiple masters',
			SUPPORTED_UTC_EVENT.replace('END:VCALENDAR', SUPPORTED_UTC_EVENT.slice(17)),
		],
	] as const)('hard-fails atomically for %s', (_label, ics) => {
		expect(() => map(ics)).toThrow();
	});

	it('does not make an unreferenced unsupported VTIMEZONE poison an otherwise supported event', () => {
		const event = map(
			timedEventIcs('DTSTART:20400115T090000Z', 'DTEND:20400115T100000Z', [
				UNSUPPORTED_UNREFERENCED_VTIMEZONE,
			]),
		);
		expect(event).toMatchObject({ timeMode: 'timed', accessMode: 'editable', timeZoneMode: 'utc' });
	});
});

describe('atomic timezone updates and preservation', () => {
	it('preserves exact alias spelling, embedded definition, recurrence, alarms, and unknown properties when timezone is omitted', () => {
		const source = timedEventIcs(
			'DTSTART;TZID=US/Eastern:20400115T090000',
			'DTEND;TZID=US/Eastern:20400115T100000',
			[PRAGUE_VTIMEZONE.replaceAll('Europe/Prague', 'US/Eastern')],
		).replace(
			'SUMMARY:Synthetic event\r\nX-SYNTHETIC-PRESERVE:opaque-value',
			'SUMMARY:Synthetic event\r\nRRULE:FREQ=DAILY;COUNT=2\r\nX-UNKNOWN:preserve\r\nX-SYNTHETIC-PRESERVE:opaque-value\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT5M\r\nEND:VALARM',
		);
		const resource = parse(source);
		const result = mapCalendarEventResource({
			calendarUrl: CALENDAR_URL,
			resourceUrl: RESOURCE_URL,
			resource,
		});
		const patched = applyCalendarEventPatch(
			result.context,
			{ summary: { kind: 'set', value: 'Changed only' } },
			new Date('2040-01-02T00:00:00Z'),
		);
		const serialized = serializeICalendarResource(patched);
		expect(serialized).toContain('TZID=US/Eastern');
		expect(serialized).toContain('BEGIN:VTIMEZONE');
		expect(serialized).toContain('RRULE:FREQ=DAILY;COUNT=2');
		expect(serialized).toContain('BEGIN:VALARM');
		expect(serialized).toContain('X-UNKNOWN:preserve');
	});

	it.each(['start', 'end', 'timeZone'] as const)(
		'rejects %s changes on recurrence data before mutation',
		(field) => {
			const source = SUPPORTED_UTC_EVENT.replace(
				'SUMMARY:Synthetic event',
				'SUMMARY:Synthetic event\r\nRRULE:FREQ=DAILY;COUNT=2',
			);
			const context = createCalendarEventPreservationContext(parse(source));
			const patch =
				field === 'timeZone'
					? ({
							timeZone: { kind: 'set', value: { timeZoneMode: 'iana', timeZone: 'Europe/Prague' } },
						} as CalendarEventPatch)
					: ({
							[field]: { kind: 'set', value: new Date('2040-01-15T12:00:00Z') },
						} as CalendarEventPatch);
			expect(() =>
				applyCalendarEventPatch(context, patch, new Date('2040-01-02T00:00:00Z')),
			).toThrow();
		},
	);

	it('treats an identical explicit representation and no other change as semantic no-op', () => {
		const context = createCalendarEventPreservationContext(parse(SUPPORTED_UTC_EVENT));
		expect(() =>
			applyCalendarEventPatch(
				context,
				{ timeZone: { kind: 'set', value: { timeZoneMode: 'utc' } } } as CalendarEventPatch,
				new Date('2040-01-02T00:00:00Z'),
			),
		).toThrow(/does not contain any changes/i);
	});

	it('keeps one coherent IANA representation when the same zone and bounds are patched together', () => {
		const resource = parse(SUPPORTED_EMBEDDED_IANA_EVENT);
		const context = createCalendarEventPreservationContext(resource);
		const definition = resource.calendar.entries.find(
			(entry) => entry.kind === 'component' && entry.name === 'VTIMEZONE',
		);
		expect(definition).toBeDefined();
		const timeZone = canonicalizeIanaTimeZone('Europe/Prague');
		const patched = applyCalendarEventPatch(
			context,
			{
				timeZone: { kind: 'set', value: { timeZoneMode: 'iana', timeZone } },
				start: { kind: 'set', value: new Date('2040-07-15T06:00:00Z') },
				end: { kind: 'set', value: new Date('2040-07-15T08:00:00Z') },
			},
			new Date('2040-01-02T00:00:00Z'),
			(instant, selectedTimeZone) =>
				projectInstantInTimeZone(instant, selectedTimeZone, definition!),
		);
		const serialized = serializeICalendarResource(patched);
		expect(serialized).toContain(
			'DTSTART;TZID=Europe/Prague:20400715T090000\r\nDTEND;TZID=Europe/Prague:20400715T110000',
		);
		expect(serialized).not.toMatch(/DT(?:START|END):\d{8}T\d{6}Z/);
	});
});
