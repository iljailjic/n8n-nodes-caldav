import { describe, expect, expectTypeOf, it } from 'vitest';

import { CalDavCalendarAlarmError } from '../../nodes/CalDav/icalendar/alarms';
import type { CalendarAlarm, CalendarAlarmMutation } from '../../nodes/CalDav/icalendar/alarms';
import {
	createCalendarEventPreservationContext,
	mapCalendarEventResource,
} from '../../nodes/CalDav/icalendar/eventReadModel';
import type { CalendarEvent } from '../../nodes/CalDav/icalendar/eventReadModel';
import { applyCalendarEventPatch } from '../../nodes/CalDav/icalendar/patcher';
import type {
	CalendarEventPatch,
	CalendarEventPatchField,
} from '../../nodes/CalDav/icalendar/patcher';
import { parseICalendarResource } from '../../nodes/CalDav/icalendar/parser';
import { serializeICalendarResource } from '../../nodes/CalDav/icalendar/serializer';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';
import {
	calendar,
	event,
	MIXED_SUPPORTED_ALARMS,
	PRESERVATION_ALARMS,
	timedMaster,
} from './fixtures/events/alarm-contract-fixtures';

const encoder = new TextEncoder();
const MODIFIED_AT = new Date('2040-01-03T04:05:06Z');
const CALENDAR_URL = validateAbsoluteHttpUrl('https://calendar.example.test/calendars/work/');
const RESOURCE_URL = validateAbsoluteHttpUrl(
	'https://calendar.example.test/calendars/work/alarms.ics',
);

function parse(lines: readonly string[]) {
	return parseICalendarResource(encoder.encode(calendar(lines)));
}

function map(lines: readonly string[]): CalendarEvent {
	return mapCalendarEventResource({
		calendarUrl: CALENDAR_URL,
		resourceUrl: RESOURCE_URL,
		resource: parse(lines),
	}).event;
}

describe('VALARM event read-model integration', () => {
	it('adds the optional immutable alarms key to the public event and patch models', () => {
		expectTypeOf<CalendarEvent['alarms']>().toEqualTypeOf<readonly CalendarAlarm[] | undefined>();
		expectTypeOf<CalendarEventPatch['alarms']>().toEqualTypeOf<
			readonly CalendarAlarmMutation[] | undefined
		>();
		expectTypeOf<CalendarEventPatchField>().toEqualTypeOf<
			| 'start'
			| 'end'
			| 'startDate'
			| 'endDate'
			| 'timeZone'
			| 'summary'
			| 'description'
			| 'location'
			| 'url'
			| 'categories'
			| 'status'
			| 'transparency'
			| 'alarms'
		>();
	});

	it('projects one immutable element per direct master VALARM in source order', () => {
		const result = map(timedMaster(MIXED_SUPPORTED_ALARMS));
		expect(result.alarms).toHaveLength(3);
		expect(
			result.alarms?.map((alarm) => ('action' in alarm ? alarm.action : alarm.reason)),
		).toEqual(['display', 'audio', 'email']);
		expect(Object.keys(result)).toEqual([
			'calendarUrl',
			'resourceUrl',
			'uid',
			'summary',
			'timeMode',
			'accessMode',
			'start',
			'end',
			'timeZoneMode',
			'startLocal',
			'endLocal',
			'alarms',
		]);
		expect(Object.isFrozen(result.alarms)).toBe(true);
	});

	it('omits alarms for no direct master VALARM and ignores exception-only alarms', () => {
		expect(map(timedMaster())).not.toHaveProperty('alarms');

		const result = map([
			...timedMaster(),
			...event('alarms@example.test', [
				'RECURRENCE-ID:20400109T100000Z',
				'DTSTAMP:20400101T000000Z',
				'DTSTART:20400109T100000Z',
				'DTEND:20400109T110000Z',
				'SUMMARY:Exception',
				'BEGIN:VALARM',
				'ACTION:DISPLAY',
				'TRIGGER:-PT5M',
				'DESCRIPTION:Exception only',
				'END:VALARM',
			]),
		]);
		expect(result).not.toHaveProperty('alarms');
	});

	it('keeps an editable event and supported siblings beside one unsupported alarm', () => {
		const result = map(timedMaster(PRESERVATION_ALARMS));
		expect(result.accessMode).toBe('editable');
		expect(result.alarms).toHaveLength(4);
		expect(
			result.alarms?.map((alarm) => ('action' in alarm ? alarm.action : alarm.reason)),
		).toEqual(['display', 'absoluteTrigger', 'repeatingAlarm', 'attachment']);
	});

	it('returns immutable fresh snapshots without mutating the parser AST', () => {
		const resource = parse(timedMaster(MIXED_SUPPORTED_ALARMS));
		const before = serializeICalendarResource(resource);
		const first = mapCalendarEventResource({
			calendarUrl: CALENDAR_URL,
			resourceUrl: RESOURCE_URL,
			resource,
		}).event;
		const second = mapCalendarEventResource({
			calendarUrl: CALENDAR_URL,
			resourceUrl: RESOURCE_URL,
			resource,
		}).event;
		expect(first.alarms).toEqual(second.alarms);
		expect(first.alarms).not.toBe(second.alarms);
		expect(serializeICalendarResource(resource)).toBe(before);
	});
});

describe('VALARM patch integration', () => {
	it('preserves every alarm on an unrelated event patch', () => {
		const resource = parse(timedMaster(PRESERVATION_ALARMS));
		const context = createCalendarEventPreservationContext(resource);
		const output = applyCalendarEventPatch(
			context,
			{
				timeMode: 'timed',
				summary: { kind: 'set', value: 'Changed event summary' },
			},
			MODIFIED_AT,
		);
		const serialized = serializeICalendarResource(output);
		for (const expected of [
			'UID:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
			'X-WR-ALARMUID:existing-apple-id',
			'TRIGGER;VALUE=DATE-TIME:20400102T090000Z',
			'REPEAT:2',
			'DURATION:PT5M',
			'ATTACH:https://example.test/tone.wav',
		]) {
			expect(serialized).toContain(expected);
		}
	});

	it('treats an omitted alarm mutation as preservation and a present empty list as invalid', () => {
		const resource = parse(timedMaster(MIXED_SUPPORTED_ALARMS));
		const context = createCalendarEventPreservationContext(resource);
		expect(() =>
			applyCalendarEventPatch(context, { timeMode: 'timed', alarms: [] }, MODIFIED_AT),
		).toThrow(CalDavCalendarAlarmError);
	});
});
