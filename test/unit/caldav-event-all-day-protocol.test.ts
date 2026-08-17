import { describe, expect, expectTypeOf, it } from 'vitest';

import {
	createCalendarEventPreservationContext,
	mapCalendarEventResource,
} from '../../nodes/CalDav/icalendar/eventReadModel';
import type {
	CalendarEvent,
	CalendarEventReadResult,
} from '../../nodes/CalDav/icalendar/eventReadModel';
import { parseICalendarResource } from '../../nodes/CalDav/icalendar/parser';
import {
	applyCalendarEventPatch,
	CalDavCalendarEventPatchError,
} from '../../nodes/CalDav/icalendar/patcher';
import type { CalendarEventPatch } from '../../nodes/CalDav/icalendar/patcher';
import { serializeICalendarResource } from '../../nodes/CalDav/icalendar/serializer';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';
import {
	allDayEvent,
	calendarObject,
	dateWithTzidEvent,
	durationEvent,
	eventComponent,
	floatingEvent,
	preservationEvent,
	timedEvent,
} from './fixtures/events/all-day-contract-fixtures';

const CALENDAR_URL = validateAbsoluteHttpUrl('https://calendar.example.test/calendars/all-day/');
const RESOURCE_URL = validateAbsoluteHttpUrl(
	'https://calendar.example.test/calendars/all-day/oracle.ics',
);
const MODIFIED_AT = new Date('2041-02-03T04:05:06Z');

type Issue41Patch = {
	readonly timeMode: 'timed' | 'allDay';
	readonly start?: { readonly kind: 'set'; readonly value: Date };
	readonly end?: { readonly kind: 'set'; readonly value: Date };
	readonly startDate?: { readonly kind: 'set'; readonly value: string };
	readonly endDate?: { readonly kind: 'set'; readonly value: string };
	readonly summary?: { readonly kind: 'set'; readonly value: string };
};

function parse(ics: string) {
	return parseICalendarResource(Buffer.from(ics, 'utf8'));
}

function read(
	ics: string,
	extensions?: Record<string, Record<string, string>>,
): CalendarEventReadResult {
	return mapCalendarEventResource({
		calendarUrl: CALENDAR_URL,
		resourceUrl: RESOURCE_URL,
		etag: ' W/"issue-41-etag" ',
		resource: parse(ics),
		...(extensions === undefined ? {} : { extensions }),
	});
}

function patch(ics: string, value: Issue41Patch): string {
	const context = createCalendarEventPreservationContext(parse(ics));
	return serializeICalendarResource(
		applyCalendarEventPatch(context, value as unknown as CalendarEventPatch, MODIFIED_AT),
	);
}

function expectPatchFailure(ics: string, value: Issue41Patch): CalDavCalendarEventPatchError {
	try {
		patch(ics, value);
	} catch (error) {
		expect(error).toBeInstanceOf(CalDavCalendarEventPatchError);
		return error as CalDavCalendarEventPatchError;
	}
	throw new Error('Expected the issue #41 patch to fail.');
}

describe('issue #41 discriminated event projection', () => {
	it('exposes the compile-time timed, all-day, and read-only branches', () => {
		type ExpectedEventTime =
			| {
					readonly timeMode: 'timed';
					readonly accessMode: 'editable';
					readonly start: string;
					readonly end: string;
			  }
			| {
					readonly timeMode: 'allDay';
					readonly accessMode: 'editable';
					readonly startDate: string;
					readonly endDate: string;
			  }
			| {
					readonly timeMode: 'unsupported';
					readonly accessMode: 'readOnly';
					readonly readOnlyReason: 'unsupportedTimeRepresentation';
			  };

		expectTypeOf<CalendarEvent>().toMatchTypeOf<ExpectedEventTime>();
	});

	it('returns exact ordered, disjoint timed/all-day/read-only keys with extensions last', () => {
		const timed = read(timedEvent('timed-order'), { oracle: { value: 'timed' } }).event;
		const allDay = read(allDayEvent('all-day-order'), { oracle: { value: 'all-day' } }).event;
		const unsupported = read(floatingEvent('unsupported-order'), {
			oracle: { value: 'unsupported' },
		}).event;

		expect(Object.keys(timed)).toEqual([
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
			'extensions',
		]);
		expect(Object.keys(allDay)).toEqual([
			'calendarUrl',
			'resourceUrl',
			'etag',
			'uid',
			'summary',
			'timeMode',
			'accessMode',
			'startDate',
			'endDate',
			'extensions',
		]);
		expect(Object.keys(unsupported)).toEqual([
			'calendarUrl',
			'resourceUrl',
			'etag',
			'uid',
			'summary',
			'timeMode',
			'accessMode',
			'readOnlyReason',
			'extensions',
		]);
		expect(timed).toMatchObject({
			timeMode: 'timed',
			accessMode: 'editable',
			start: '2024-02-29T10:00:00Z',
			end: '2024-02-29T11:00:00Z',
		});
		expect(allDay).toMatchObject({
			timeMode: 'allDay',
			accessMode: 'editable',
			startDate: '2024-02-29',
			endDate: '2024-03-01',
		});
		expect(unsupported).toMatchObject({
			timeMode: 'unsupported',
			accessMode: 'readOnly',
			readOnlyReason: 'unsupportedTimeRepresentation',
		});
		expect(unsupported).not.toHaveProperty('start');
		expect(unsupported).not.toHaveProperty('startDate');
		expect(unsupported).not.toHaveProperty('tzid');
		expect(unsupported).not.toHaveProperty('rawIcs');
	});

	it.each([
		['floating DATE-TIME', floatingEvent('read-only-floating')],
		['DURATION', durationEvent('read-only-duration')],
		['DATE with private TZID', dateWithTzidEvent('read-only-date-tzid')],
	] as const)('returns a safe read-only projection for %s', (_label, ics) => {
		expect(read(ics).event).toMatchObject({
			timeMode: 'unsupported',
			accessMode: 'readOnly',
			readOnlyReason: 'unsupportedTimeRepresentation',
		});
	});

	it.each([
		[
			'conflicting identities',
			calendarObject([
				...eventComponent('one', ['DTSTART:20240229T100000Z', 'DTEND:20240229T110000Z']),
				...eventComponent('two', [
					'RECURRENCE-ID:20240301T100000Z',
					'DTSTART:20240301T100000Z',
					'DTEND:20240301T110000Z',
				]),
			]),
		],
		[
			'multiple masters',
			calendarObject([
				...eventComponent('duplicate-master', [
					'DTSTART:20240229T100000Z',
					'DTEND:20240229T110000Z',
				]),
				...eventComponent('duplicate-master', [
					'DTSTART:20240301T100000Z',
					'DTEND:20240301T110000Z',
				]),
			]),
		],
		['invalid Gregorian DATE', allDayEvent('invalid-date', '21000229', '21000301')],
	] as const)('keeps %s as a hard read failure', (_label, ics) => {
		expect(() => read(ics)).toThrow();
	});
});

describe('issue #41 strict Gregorian DATE and exclusive-end semantics', () => {
	it.each([
		['minimum year', '00010101', '00010102', '0001-01-01', '0001-01-02'],
		['leap day', '20000229', '20000301', '2000-02-29', '2000-03-01'],
		['month boundary', '20260430', '20260501', '2026-04-30', '2026-05-01'],
		['year boundary', '20261231', '20270103', '2026-12-31', '2027-01-03'],
		['maximum year range', '99991230', '99991231', '9999-12-30', '9999-12-31'],
	] as const)(
		'round-trips %s literally with no hidden day adjustment',
		(_label, start, end, expectedStart, expectedEnd) => {
			const original = allDayEvent(`valid-${start}`, start, end);
			const parsed = parse(original);
			const serialized = serializeICalendarResource(parsed);
			const event = read(serialized).event;

			expect(serialized).toContain(`DTSTART;VALUE=DATE:${start}\r\n`);
			expect(serialized).toContain(`DTEND;VALUE=DATE:${end}\r\n`);
			expect(serialized).not.toMatch(
				/DT(?:START|END)(?:;[^:\r\n]*)?:[^\r\n]*(?:T|Z)|DT(?:START|END)[^:\r\n]*TZID/,
			);
			expect(event).toMatchObject({ startDate: expectedStart, endDate: expectedEnd });
		},
	);

	it.each([
		['year zero', '00000101', '00000102'],
		['non-leap century', '21000229', '21000301'],
		['invalid month', '20261301', '20270101'],
		['invalid day', '20260431', '20260501'],
		['equal range', '20260201', '20260201'],
		['reversed range', '20260202', '20260201'],
	] as const)('rejects %s deterministically', (_label, start, end) => {
		expect(() => read(allDayEvent(`invalid-${_label}`, start, end))).toThrow();
	});
});

describe('issue #41 same-mode patching and explicit conversion', () => {
	it('patches one all-day bound, preserves the other and unrelated content, and updates revision once', () => {
		const original = preservationEvent('partial-all-day', [
			'DTSTART;VALUE=DATE;X-ORACLE=one:20261230',
			'DTEND;VALUE=DATE;X-ORACLE=two:20270102',
		]);
		const output = patch(original, {
			timeMode: 'allDay',
			endDate: { kind: 'set', value: '2027-01-03' },
		});

		expect(output).toContain('DTSTART;VALUE=DATE;X-ORACLE=one:20261230');
		expect(output).toContain('DTEND;VALUE=DATE;X-ORACLE=two:20270103');
		expect(output).toContain('DTSTAMP:20410203T040506Z');
		expect(output).toContain('LAST-MODIFIED:20410203T040506Z');
		for (const line of [
			'BEGIN:VTIMEZONE',
			'X-TIMEZONE-OPAQUE:keep',
			'X-OPAQUE;X-PARAM="one,two":opaque-content',
			'BEGIN:VALARM',
			'SEQUENCE:7',
			'ORGANIZER:mailto:organizer@example.test',
			'ATTENDEE:mailto:attendee@example.test',
		]) {
			expect(output).toContain(line);
		}
	});

	it('patches one timed bound while retaining whole-second UTC and parameters', () => {
		const output = patch(
			preservationEvent('partial-timed', [
				'DTSTART;X-ORACLE=one:20261230T100000Z',
				'DTEND;X-ORACLE=two:20261230T110000Z',
			]),
			{
				timeMode: 'timed',
				start: { kind: 'set', value: new Date('2026-12-30T10:30:00Z') },
			},
		);
		expect(output).toContain('DTSTART;X-ORACLE=one:20261230T103000Z');
		expect(output).toContain('DTEND;X-ORACLE=two:20261230T110000Z');
	});

	it('converts timed to all-day only with a complete target pair', () => {
		const output = patch(timedEvent('timed-to-date'), {
			timeMode: 'allDay',
			startDate: { kind: 'set', value: '2024-02-29' },
			endDate: { kind: 'set', value: '2024-03-01' },
		});
		expect(output).toContain('DTSTART;VALUE=DATE:20240229');
		expect(output).toContain('DTEND;VALUE=DATE:20240301');
		expect(output).not.toContain('20240229T100000Z');
	});

	it('converts all-day to timed only with a complete UTC target pair', () => {
		const output = patch(allDayEvent('date-to-timed'), {
			timeMode: 'timed',
			start: { kind: 'set', value: new Date('2024-02-29T10:00:00Z') },
			end: { kind: 'set', value: new Date('2024-02-29T11:00:00Z') },
		});
		expect(output).toContain('DTSTART:20240229T100000Z');
		expect(output).toContain('DTEND:20240229T110000Z');
		expect(output).not.toContain('VALUE=DATE');
	});

	it.each([
		[
			'incomplete conversion',
			timedEvent('incomplete-conversion'),
			{ timeMode: 'allDay', startDate: { kind: 'set', value: '2024-02-29' } },
		],
		[
			'mixed target family',
			timedEvent('mixed-target'),
			{
				timeMode: 'allDay',
				startDate: { kind: 'set', value: '2024-02-29' },
				endDate: { kind: 'set', value: '2024-03-01' },
				start: { kind: 'set', value: new Date('2024-02-29T10:00:00Z') },
			},
		],
		[
			'equal all-day target',
			allDayEvent('equal-target'),
			{
				timeMode: 'allDay',
				startDate: { kind: 'set', value: '2024-03-01' },
				endDate: { kind: 'set', value: '2024-03-01' },
			},
		],
	] as const)('rejects %s before serialization', (_label, ics, value) => {
		expectPatchFailure(ics, value as Issue41Patch);
	});

	it.each(['RRULE:FREQ=DAILY', 'RDATE;VALUE=DATE:20240302', 'EXDATE;VALUE=DATE:20240302'])(
		'rejects a time change when %s is present',
		(recurrenceLine) => {
			expectPatchFailure(
				allDayEvent('recurrence-blocked', undefined, undefined, [recurrenceLine]),
				{
					timeMode: 'allDay',
					endDate: { kind: 'set', value: '2024-03-02' },
				},
			);
		},
	);

	it('rejects a time change when a RECURRENCE-ID exception is present', () => {
		const recurring = calendarObject([
			...eventComponent('exception-blocked', [
				'DTSTART;VALUE=DATE:20240229',
				'DTEND;VALUE=DATE:20240301',
			]),
			...eventComponent('exception-blocked', [
				'RECURRENCE-ID;VALUE=DATE:20240302',
				'DTSTART;VALUE=DATE:20240302',
				'DTEND;VALUE=DATE:20240303',
			]),
		]);
		expectPatchFailure(recurring, {
			timeMode: 'allDay',
			endDate: { kind: 'set', value: '2024-03-02' },
		});
	});

	it('allows a non-time patch and preserves recurrence unchanged', () => {
		const output = patch(
			allDayEvent('recurrence-text', undefined, undefined, ['RRULE:FREQ=DAILY']),
			{
				timeMode: 'allDay',
				summary: { kind: 'set', value: 'Text only' },
			},
		);
		expect(output).toContain('RRULE:FREQ=DAILY');
		expect(output).toContain('SUMMARY:Text only');
	});

	it('rejects conversion when unknown time-property parameters cannot be transferred safely', () => {
		const error = expectPatchFailure(
			allDayEvent('unsafe-parameter').replace(
				'DTSTART;VALUE=DATE:',
				'DTSTART;VALUE=DATE;X-PRIVATE-CONTRACT=opaque:',
			),
			{
				timeMode: 'timed',
				start: { kind: 'set', value: new Date('2024-02-29T10:00:00Z') },
				end: { kind: 'set', value: new Date('2024-02-29T11:00:00Z') },
			},
		);
		expect(error.code).toBe('INCOMPATIBLE_PARAMETERS');
		expect(JSON.stringify(error)).not.toContain('X-PRIVATE-CONTRACT');
	});

	it('keeps semantic no-op metadata byte-equivalent and reports NO_CHANGES', () => {
		const original = allDayEvent('date-no-op');
		const error = expectPatchFailure(original, {
			timeMode: 'allDay',
			startDate: { kind: 'set', value: '2024-02-29' },
		});
		expect(error.code).toBe('NO_CHANGES');
		expect(original).toContain('DTSTAMP:20400101T000000Z');
	});
});
