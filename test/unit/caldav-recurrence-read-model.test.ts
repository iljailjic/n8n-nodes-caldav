import { describe, expect, it } from 'vitest';

import {
	CalDavCalendarEventReadModelError,
	mapCalendarEventResource,
} from '../../nodes/CalDav/icalendar/eventReadModel';
import type { CalendarEventReadResult } from '../../nodes/CalDav/icalendar/eventReadModel';
import { applyCalendarEventPatch } from '../../nodes/CalDav/icalendar/patcher';
import { parseICalendarResource } from '../../nodes/CalDav/icalendar/parser';
import { serializeICalendarResource } from '../../nodes/CalDav/icalendar/serializer';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';

const encoder = new TextEncoder();
const CALENDAR_URL = validateAbsoluteHttpUrl('https://calendar.example.test/calendars/work/');
const RESOURCE_URL = validateAbsoluteHttpUrl(
	'https://calendar.example.test/calendars/work/recurrence.ics',
);

function calendar(lines: readonly string[]): string {
	return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR', ''].join('\r\n');
}

function event(uid: string, lines: readonly string[]): readonly string[] {
	return ['BEGIN:VEVENT', `UID:${uid}`, ...lines, 'END:VEVENT'];
}

function map(lines: readonly string[], extensions = false): CalendarEventReadResult {
	return mapCalendarEventResource({
		calendarUrl: CALENDAR_URL,
		resourceUrl: RESOURCE_URL,
		resource: parseICalendarResource(encoder.encode(calendar(lines))),
		...(extensions ? { extensions: { synthetic: { retained: true } } } : {}),
	});
}

function unfold(ics: string): readonly string[] {
	return ics
		.slice(0, -2)
		.split('\r\n')
		.reduce<string[]>((lines, line) => {
			if (line.startsWith(' ') || line.startsWith('\t')) lines[lines.length - 1] += line.slice(1);
			else lines.push(line);
			return lines;
		}, []);
}

describe('recurrence event read-model attachment', () => {
	it('omits recurrence when the master has no RRULE', () => {
		const result = map(
			event('no-rule@example.test', ['DTSTART:20240101T090000Z', 'DTEND:20240101T100000Z']),
		);

		expect(result.event).not.toHaveProperty('recurrence');
	});

	it('attaches one canonical timed rule immediately before extensions', () => {
		const result = map(
			event('timed-rule@example.test', [
				'DTSTART:20240101T090000Z',
				'DTEND:20240101T100000Z',
				'RRULE:BYDAY=+1MO,MO;COUNT=3;FREQ=MONTHLY;INTERVAL=1',
			]),
			true,
		);

		expect(result.event).toMatchObject({
			timeMode: 'timed',
			accessMode: 'editable',
			recurrence: {
				frequency: 'monthly',
				end: { kind: 'count', count: 3 },
				byDay: [{ weekday: 'monday' }, { weekday: 'monday', ordinal: 1 }],
			},
			extensions: { synthetic: { retained: true } },
		});
		const keys = Object.keys(result.event);
		expect(keys.indexOf('recurrence')).toBe(keys.indexOf('extensions') - 1);
		expect(Object.isFrozen(result.event.recurrence)).toBe(true);
	});

	it('couples an all-day RRULE Until to the all-day DTSTART', () => {
		const result = map(
			event('all-day-rule@example.test', [
				'DTSTART;VALUE=DATE:20240101',
				'DTEND;VALUE=DATE:20240102',
				'RRULE:FREQ=DAILY;UNTIL=20240101',
			]),
		);

		expect(result.event).toMatchObject({
			timeMode: 'allDay',
			accessMode: 'editable',
			recurrence: {
				frequency: 'daily',
				end: { kind: 'until', value: { kind: 'date', date: '2024-01-01' } },
			},
		});
	});

	it('keeps unsupported recurrence independent from editable time classification', () => {
		const result = map(
			event('unsupported-rule@example.test', [
				'DTSTART:20240101T090000Z',
				'DTEND:20240101T100000Z',
				'RRULE:FREQ=DAILY;BYSETPOS=1;X-PRIVATE=opaque',
			]),
		);

		expect(result.event).toMatchObject({
			timeMode: 'timed',
			accessMode: 'editable',
			recurrence: {
				kind: 'unsupported',
				reason: 'unsupportedRulePart',
				ruleParts: ['BYSETPOS', 'X-PRIVATE'],
			},
		});
		expect(JSON.stringify(result.event.recurrence)).not.toContain('opaque');
	});

	it('retains recurrence projection when the event time itself is read-only', () => {
		const result = map(
			event('floating-rule@example.test', [
				'DTSTART:20240101T090000',
				'DTEND:20240101T100000',
				'RRULE:FREQ=DAILY',
			]),
		);

		expect(result.event).toMatchObject({
			timeMode: 'unsupported',
			accessMode: 'readOnly',
			readOnlyReason: 'unsupportedTimeRepresentation',
			recurrence: { frequency: 'daily' },
		});
	});

	it('projects a remote DTSTART mismatch as unsupported without making time read-only', () => {
		const result = map(
			event('unsynchronized-rule@example.test', [
				'DTSTART:20240101T090000Z',
				'DTEND:20240101T100000Z',
				'RRULE:FREQ=MONTHLY;BYDAY=2MO',
			]),
		);

		expect(result.event).toMatchObject({
			accessMode: 'editable',
			recurrence: {
				kind: 'unsupported',
				reason: 'unsupportedCombination',
				ruleParts: ['BYDAY'],
			},
		});
	});

	it('hard-fails duplicate master RRULE properties even when identical', () => {
		expect(() =>
			map(
				event('ambiguous-rule@example.test', [
					'DTSTART:20240101T090000Z',
					'DTEND:20240101T100000Z',
					'RRULE:FREQ=DAILY',
					'RRULE:FREQ=DAILY',
				]),
			),
		).toThrowError(
			expect.objectContaining<Partial<CalDavCalendarEventReadModelError>>({
				name: 'CalDavCalendarEventReadModelError',
				code: 'AMBIGUOUS_EVENT_PROPERTY',
			}),
		);
	});
});

describe('recurrence preservation during unrelated patches', () => {
	it('preserves lexical RRULE, EXDATE, RDATE, exceptions, parameters, alarms, and unknown content', () => {
		const source = map([
			...event('preserve-rule@example.test', [
				'DTSTAMP:20240101T000000Z',
				'DTSTART:20240101T090000Z',
				'DTEND:20240101T100000Z',
				'SUMMARY:Original',
				'rrule;X-SOURCE=legacy:freq=daily;interval=1',
				'EXDATE;X-KEEP=yes:20240108T090000Z',
				'RDATE;X-KEEP=yes:20240115T090000Z',
				'X-MASTER;X-PARAM=keep:opaque',
				'BEGIN:VALARM',
				'ACTION:DISPLAY',
				'DESCRIPTION:Reminder',
				'TRIGGER:-PT15M',
				'X-ALARM:keep',
				'END:VALARM',
			]),
			...event('preserve-rule@example.test', [
				'RECURRENCE-ID:20240108T090000Z',
				'DTSTART:20240108T100000Z',
				'DTEND:20240108T110000Z',
				'X-EXCEPTION:keep',
			]),
		]);
		const output = applyCalendarEventPatch(
			source.context,
			{ summary: { kind: 'set', value: 'Changed summary only' } },
			new Date('2024-01-02T00:00:00Z'),
		);
		const lines = unfold(serializeICalendarResource(output));

		expect(lines).toContain('rrule;X-SOURCE=legacy:freq=daily;interval=1');
		expect(lines).toContain('EXDATE;X-KEEP=yes:20240108T090000Z');
		expect(lines).toContain('RDATE;X-KEEP=yes:20240115T090000Z');
		expect(lines).toContain('X-MASTER;X-PARAM=keep:opaque');
		expect(lines).toContain('BEGIN:VALARM');
		expect(lines).toContain('X-ALARM:keep');
		expect(lines).toContain('RECURRENCE-ID:20240108T090000Z');
		expect(lines).toContain('X-EXCEPTION:keep');
		expect(lines).toContain('SUMMARY:Changed summary only');
		expect(lines.filter((line) => line.toUpperCase().startsWith('RRULE'))).toHaveLength(1);
	});
});
