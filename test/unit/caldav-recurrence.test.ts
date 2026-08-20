import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type {
	CalendarDateString,
	UtcDateTimeString,
} from '../../nodes/CalDav/icalendar/eventReadModel';
import { parseICalendarResource } from '../../nodes/CalDav/icalendar/parser';
import type { ICalendarProperty } from '../../nodes/CalDav/icalendar/parser';
import {
	CalDavRecurrenceRuleError,
	normalizeRecurrenceRule,
	projectRecurrenceRule,
	recurrenceRulesAreSemanticallyEqual,
	RecurrenceRuleErrorCode,
	serializeRecurrenceRule,
} from '../../nodes/CalDav/icalendar/recurrence';
import type {
	RecurrenceByDay,
	RecurrenceEnd,
	RecurrenceField,
	RecurrenceFrequency,
	RecurrenceProjection,
	RecurrenceRule,
	RecurrenceStartContext,
	RecurrenceUntil,
	RecurrenceWeekday,
	UnsupportedRecurrence,
} from '../../nodes/CalDav/icalendar/recurrence';
import type { LocalDateTimeString } from '../../nodes/CalDav/icalendar/timeZones';

const encoder = new TextEncoder();
const START_DATE = '2024-01-01' as CalendarDateString;
const START_INSTANT = '2024-01-01T09:00:00Z' as UtcDateTimeString;
const START_LOCAL = '2024-01-01T10:00:00' as LocalDateTimeString;

const ALL_DAY_START: RecurrenceStartContext = {
	timeMode: 'allDay',
	startDate: START_DATE,
};
const UTC_START: RecurrenceStartContext = {
	timeMode: 'timed',
	timeZoneMode: 'utc',
	start: START_INSTANT,
};
const IANA_START: RecurrenceStartContext = {
	timeMode: 'timed',
	timeZoneMode: 'iana',
	start: START_INSTANT,
	startLocal: START_LOCAL,
};

function rruleProperty(value: string): ICalendarProperty {
	const resource = parseICalendarResource(
		encoder.encode(
			[
				'BEGIN:VCALENDAR',
				'VERSION:2.0',
				'BEGIN:VEVENT',
				'UID:recurrence@example.test',
				'DTSTART:20240101T090000Z',
				`RRULE:${value}`,
				'END:VEVENT',
				'END:VCALENDAR',
				'',
			].join('\r\n'),
		),
	);
	const event = resource.calendar.entries.find(
		(entry) => entry.kind === 'component' && entry.name.toUpperCase() === 'VEVENT',
	);
	if (event?.kind !== 'component') throw new Error('Synthetic VEVENT is missing.');
	const property = event.entries.find(
		(entry) => entry.kind === 'property' && entry.name.toUpperCase() === 'RRULE',
	);
	if (property?.kind !== 'property') throw new Error('Synthetic RRULE is missing.');
	return property;
}

function expectRuleError(
	callback: () => unknown,
	code: keyof typeof RecurrenceRuleErrorCode,
	field?: RecurrenceField,
): CalDavRecurrenceRuleError {
	try {
		callback();
	} catch (error) {
		expect(error).toBeInstanceOf(CalDavRecurrenceRuleError);
		expect(error).toMatchObject({
			name: 'CalDavRecurrenceRuleError',
			code,
			...(field === undefined ? {} : { field }),
		});
		expect((error as Error).message).not.toBe('');
		expect(error).not.toHaveProperty('cause');
		expect(error).not.toHaveProperty('input');
		expect(error).not.toHaveProperty('rule');
		expect(error).not.toHaveProperty('ruleParts');
		return error as CalDavRecurrenceRuleError;
	}
	throw new Error(`Expected ${code}.`);
}

function expectDeeplyFrozen(value: unknown, seen = new WeakSet<object>()): void {
	if (typeof value !== 'object' || value === null || seen.has(value)) return;
	seen.add(value);
	expect(Object.isFrozen(value)).toBe(true);
	for (const key of Reflect.ownKeys(value)) expectDeeplyFrozen(Reflect.get(value, key), seen);
}

describe('structured recurrence public contract', () => {
	it('exports the exact supported immutable model and stable error codes', () => {
		expectTypeOf<RecurrenceFrequency>().toEqualTypeOf<'daily' | 'weekly' | 'monthly' | 'yearly'>();
		expectTypeOf<RecurrenceWeekday>().toEqualTypeOf<
			'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'
		>();
		expectTypeOf<RecurrenceByDay>().toEqualTypeOf<{
			readonly weekday: RecurrenceWeekday;
			readonly ordinal?: number;
		}>();
		expectTypeOf<RecurrenceUntil>().toEqualTypeOf<
			| { readonly kind: 'date'; readonly date: CalendarDateString }
			| { readonly kind: 'dateTime'; readonly dateTime: UtcDateTimeString }
		>();
		expectTypeOf<RecurrenceEnd>().toEqualTypeOf<
			| { readonly kind: 'count'; readonly count: number }
			| { readonly kind: 'until'; readonly value: RecurrenceUntil }
		>();
		expectTypeOf<RecurrenceRule>().toEqualTypeOf<{
			readonly frequency: RecurrenceFrequency;
			readonly interval?: number;
			readonly end?: RecurrenceEnd;
			readonly byMonth?: readonly number[];
			readonly byMonthDay?: readonly number[];
			readonly byDay?: readonly RecurrenceByDay[];
			readonly weekStart?: RecurrenceWeekday;
		}>();
		expectTypeOf<UnsupportedRecurrence>().toEqualTypeOf<{
			readonly kind: 'unsupported';
			readonly reason: 'unsupportedRulePart' | 'unsupportedCombination' | 'invalidRule';
			readonly ruleParts: readonly string[];
		}>();
		expectTypeOf<RecurrenceProjection>().toEqualTypeOf<RecurrenceRule | UnsupportedRecurrence>();

		expect(RecurrenceRuleErrorCode).toEqual({
			INVALID_INPUT: 'INVALID_INPUT',
			UNKNOWN_FIELD: 'UNKNOWN_FIELD',
			INVALID_FREQUENCY: 'INVALID_FREQUENCY',
			INVALID_INTERVAL: 'INVALID_INTERVAL',
			INVALID_END: 'INVALID_END',
			INVALID_COUNT: 'INVALID_COUNT',
			INVALID_UNTIL: 'INVALID_UNTIL',
			UNTIL_BEFORE_START: 'UNTIL_BEFORE_START',
			INVALID_BY_DAY: 'INVALID_BY_DAY',
			INVALID_BY_MONTH_DAY: 'INVALID_BY_MONTH_DAY',
			INVALID_BY_MONTH: 'INVALID_BY_MONTH',
			INVALID_WEEK_START: 'INVALID_WEEK_START',
			DUPLICATE_VALUE: 'DUPLICATE_VALUE',
			INVALID_COMBINATION: 'INVALID_COMBINATION',
			UNSYNCHRONIZED_START: 'UNSYNCHRONIZED_START',
		});
		expect(Object.isFrozen(RecurrenceRuleErrorCode)).toBe(true);
	});

	it('normalizes the default and serializes only FREQ', () => {
		const rule = normalizeRecurrenceRule({ frequency: 'daily' }, UTC_START);

		expect(rule).toEqual({ frequency: 'daily' });
		expect(Object.keys(rule)).toEqual(['frequency']);
		expect(serializeRecurrenceRule(rule, UTC_START)).toBe('FREQ=DAILY');
		expectDeeplyFrozen(rule);
	});

	it('uses exact canonical JSON, part, and list order without retaining input order', () => {
		const input = {
			byDay: [
				{ weekday: 'friday' },
				{ weekday: 'monday', ordinal: 2 },
				{ weekday: 'monday', ordinal: -2 },
				{ weekday: 'monday' },
			],
			frequency: 'monthly',
			byMonthDay: [31, -1, 1, -31],
			end: { kind: 'count', count: 10 },
			interval: 2,
			byMonth: [12, 1, 6],
		} as const;
		const rule = normalizeRecurrenceRule(input, UTC_START);

		expect(rule).toEqual({
			frequency: 'monthly',
			interval: 2,
			end: { kind: 'count', count: 10 },
			byMonth: [1, 6, 12],
			byMonthDay: [-31, -1, 1, 31],
			byDay: [
				{ weekday: 'monday' },
				{ weekday: 'monday', ordinal: -2 },
				{ weekday: 'monday', ordinal: 2 },
				{ weekday: 'friday' },
			],
		});
		expect(Object.keys(rule)).toEqual([
			'frequency',
			'interval',
			'end',
			'byMonth',
			'byMonthDay',
			'byDay',
		]);
		expect(serializeRecurrenceRule(input, UTC_START)).toBe(
			'FREQ=MONTHLY;INTERVAL=2;COUNT=10;BYMONTH=1,6,12;BYMONTHDAY=-31,-1,1,31;BYDAY=MO,-2MO,2MO,FR',
		);
		expect(input.byMonth).toEqual([12, 1, 6]);
		expect(input.byMonthDay).toEqual([31, -1, 1, -31]);
	});

	it('omits explicit interval and week-start defaults while retaining non-default WKST', () => {
		expect(
			normalizeRecurrenceRule({ frequency: 'weekly', interval: 1, weekStart: 'monday' }, UTC_START),
		).toEqual({ frequency: 'weekly' });
		expect(
			serializeRecurrenceRule({ frequency: 'weekly', interval: 1, weekStart: 'monday' }, UTC_START),
		).toBe('FREQ=WEEKLY');
		expect(serializeRecurrenceRule({ frequency: 'weekly', weekStart: 'sunday' }, UTC_START)).toBe(
			'FREQ=WEEKLY;WKST=SU',
		);
	});
});

describe('structured recurrence validation', () => {
	it.each([
		['interval minimum', { frequency: 'daily', interval: 1 }],
		['interval maximum', { frequency: 'daily', interval: 2_147_483_647 }],
		['count minimum', { frequency: 'daily', end: { kind: 'count', count: 1 } }],
		['count maximum', { frequency: 'daily', end: { kind: 'count', count: 2_147_483_647 } }],
		['month bounds', { frequency: 'yearly', byMonth: [1, 12] }],
		['month-day bounds', { frequency: 'monthly', byMonthDay: [-31, 1, 31] }],
		[
			'ordinal bounds',
			{
				frequency: 'monthly',
				byDay: [
					{ weekday: 'monday', ordinal: -53 },
					{ weekday: 'monday', ordinal: 1 },
					{ weekday: 'monday', ordinal: 53 },
				],
			},
		],
	] as const)('accepts %s', (_label, rule) => {
		expect(() => normalizeRecurrenceRule(rule, UTC_START)).not.toThrow();
	});

	it.each([
		['interval', 0],
		['interval', -1],
		['interval', 1.5],
		['interval', 2_147_483_648],
		['interval', Number.NaN],
		['interval', Number.POSITIVE_INFINITY],
	] as const)('rejects invalid %s value %s', (field, value) => {
		expectRuleError(
			() => normalizeRecurrenceRule({ frequency: 'daily', [field]: value }, UTC_START),
			'INVALID_INTERVAL',
			'interval',
		);
	});

	it.each([0, -1, 1.5, 2_147_483_648, Number.NaN, Number.POSITIVE_INFINITY])(
		'rejects invalid COUNT value %s',
		(value) => {
			expectRuleError(
				() =>
					normalizeRecurrenceRule(
						{ frequency: 'daily', end: { kind: 'count', count: value } },
						UTC_START,
					),
				'INVALID_COUNT',
				'end',
			);
		},
	);

	it.each([
		['byMonth', [0], 'INVALID_BY_MONTH'],
		['byMonth', [13], 'INVALID_BY_MONTH'],
		['byMonth', [1.5], 'INVALID_BY_MONTH'],
		['byMonth', [], 'INVALID_BY_MONTH'],
		['byMonthDay', [-32], 'INVALID_BY_MONTH_DAY'],
		['byMonthDay', [0], 'INVALID_BY_MONTH_DAY'],
		['byMonthDay', [32], 'INVALID_BY_MONTH_DAY'],
		['byMonthDay', [1.5], 'INVALID_BY_MONTH_DAY'],
		['byMonthDay', [], 'INVALID_BY_MONTH_DAY'],
		['byDay', [{ weekday: 'monday', ordinal: -54 }], 'INVALID_BY_DAY'],
		['byDay', [{ weekday: 'monday', ordinal: 0 }], 'INVALID_BY_DAY'],
		['byDay', [{ weekday: 'monday', ordinal: 54 }], 'INVALID_BY_DAY'],
		['byDay', [{ weekday: 'monday', ordinal: 1.5 }], 'INVALID_BY_DAY'],
		['byDay', [], 'INVALID_BY_DAY'],
	] as const)('rejects invalid or empty %s list', (field, value, code) => {
		expectRuleError(
			() => normalizeRecurrenceRule({ frequency: 'monthly', [field]: value }, UTC_START),
			code,
			field,
		);
	});

	it.each([
		['byMonth', [1, 1]],
		['byMonthDay', [-1, -1]],
		[
			'byDay',
			[
				{ weekday: 'monday', ordinal: 1 },
				{ weekday: 'monday', ordinal: 1 },
			],
		],
	] as const)('rejects duplicate %s values instead of deduplicating', (field, value) => {
		expectRuleError(
			() => normalizeRecurrenceRule({ frequency: 'monthly', [field]: value }, UTC_START),
			'DUPLICATE_VALUE',
			field,
		);
	});

	it('accepts unnumbered and numbered BYDAY for the same weekday as distinct values', () => {
		expect(
			normalizeRecurrenceRule(
				{
					frequency: 'monthly',
					byDay: [{ weekday: 'monday' }, { weekday: 'monday', ordinal: 1 }],
				},
				UTC_START,
			),
		).toMatchObject({
			byDay: [{ weekday: 'monday' }, { weekday: 'monday', ordinal: 1 }],
		});
	});

	it.each([
		['daily', false, true, true],
		['weekly', false, false, true],
		['monthly', true, true, true],
		['yearly', true, true, true],
	] as const)(
		'enforces the %s frequency matrix',
		(frequency, ordinalAllowed, monthDayAllowed, monthAllowed) => {
			const ordinal = () =>
				normalizeRecurrenceRule(
					{ frequency, byDay: [{ weekday: 'monday', ordinal: 1 }] },
					UTC_START,
				);
			const monthDay = () => normalizeRecurrenceRule({ frequency, byMonthDay: [1] }, UTC_START);
			const month = () => normalizeRecurrenceRule({ frequency, byMonth: [1] }, UTC_START);

			if (ordinalAllowed) expect(ordinal).not.toThrow();
			else expectRuleError(ordinal, 'INVALID_COMBINATION', 'byDay');
			if (monthDayAllowed) expect(monthDay).not.toThrow();
			else expectRuleError(monthDay, 'INVALID_COMBINATION', 'byMonthDay');
			if (monthAllowed) expect(month).not.toThrow();
			else expectRuleError(month, 'INVALID_COMBINATION', 'byMonth');
		},
	);

	it('permits only non-ordinal BYDAY for Daily and Weekly', () => {
		for (const frequency of ['daily', 'weekly'] as const) {
			expect(() =>
				normalizeRecurrenceRule({ frequency, byDay: [{ weekday: 'monday' }] }, UTC_START),
			).not.toThrow();
		}
	});

	it('permits WKST only for Weekly without requiring interval or BYDAY', () => {
		expect(() =>
			normalizeRecurrenceRule({ frequency: 'weekly', weekStart: 'sunday' }, UTC_START),
		).not.toThrow();
		for (const frequency of ['daily', 'monthly', 'yearly'] as const) {
			expectRuleError(
				() => normalizeRecurrenceRule({ frequency, weekStart: 'sunday' }, UTC_START),
				'INVALID_COMBINATION',
				'weekStart',
			);
		}
	});

	it('accepts intersecting BY filters when DTSTART matches one value in each list', () => {
		expect(
			normalizeRecurrenceRule(
				{
					frequency: 'yearly',
					byMonth: [1, 12],
					byMonthDay: [-31, 1],
					byDay: [{ weekday: 'monday' }, { weekday: 'friday', ordinal: -1 }],
				},
				UTC_START,
			),
		).toMatchObject({ frequency: 'yearly', byMonth: [1, 12] });
	});

	it.each([
		['null input', null, 'INVALID_INPUT', undefined],
		['array input', [], 'INVALID_INPUT', undefined],
		['unknown field', { frequency: 'daily', secret: 'private' }, 'UNKNOWN_FIELD', undefined],
		['invalid frequency', { frequency: 'hourly' }, 'INVALID_FREQUENCY', 'frequency'],
		['coercible interval', { frequency: 'daily', interval: '2' }, 'INVALID_INTERVAL', 'interval'],
		['invalid end shape', { frequency: 'daily', end: {} }, 'INVALID_END', 'end'],
		[
			'invalid until shape',
			{ frequency: 'daily', end: { kind: 'until', value: { kind: 'date' } } },
			'INVALID_UNTIL',
			'end',
		],
		['invalid BYDAY shape', { frequency: 'monthly', byDay: 'MO' }, 'INVALID_BY_DAY', 'byDay'],
		[
			'invalid week start',
			{ frequency: 'weekly', weekStart: 'mo' },
			'INVALID_WEEK_START',
			'weekStart',
		],
	] as const)('rejects exact-shape violation: %s', (_label, input, code, field) => {
		expectRuleError(
			() => normalizeRecurrenceRule(input, UTC_START),
			code,
			field as RecurrenceField | undefined,
		);
	});

	it('rejects symbols and accessors without invoking user code', () => {
		const symbolInput = { frequency: 'daily', [Symbol('private')]: true };
		expectRuleError(() => normalizeRecurrenceRule(symbolInput, UTC_START), 'UNKNOWN_FIELD');

		const getter = vi.fn(() => 'daily');
		const accessorInput = Object.defineProperty({}, 'frequency', {
			enumerable: true,
			get: getter,
		});
		expectRuleError(() => normalizeRecurrenceRule(accessorInput, UTC_START), 'INVALID_INPUT');
		expect(getter).not.toHaveBeenCalled();
	});
});

describe('DTSTART and UNTIL coupling', () => {
	it('accepts inclusive UNTIL equal to DTSTART and serializes mode-consistent forms', () => {
		expect(
			serializeRecurrenceRule(
				{
					frequency: 'daily',
					end: { kind: 'until', value: { kind: 'date', date: START_DATE } },
				},
				ALL_DAY_START,
			),
		).toBe('FREQ=DAILY;UNTIL=20240101');
		expect(
			serializeRecurrenceRule(
				{
					frequency: 'daily',
					end: {
						kind: 'until',
						value: { kind: 'dateTime', dateTime: START_INSTANT },
					},
				},
				UTC_START,
			),
		).toBe('FREQ=DAILY;UNTIL=20240101T090000Z');
		expect(
			serializeRecurrenceRule(
				{
					frequency: 'daily',
					end: {
						kind: 'until',
						value: { kind: 'dateTime', dateTime: START_INSTANT },
					},
				},
				IANA_START,
			),
		).toBe('FREQ=DAILY;UNTIL=20240101T090000Z');
	});

	it.each([
		['all-day with DATE-TIME', ALL_DAY_START, { kind: 'dateTime', dateTime: START_INSTANT }],
		['timed with DATE', UTC_START, { kind: 'date', date: START_DATE }],
	] as const)('rejects %s UNTIL mismatch', (_label, start, value) => {
		expectRuleError(
			() => normalizeRecurrenceRule({ frequency: 'daily', end: { kind: 'until', value } }, start),
			'INVALID_UNTIL',
			'end',
		);
	});

	it.each([
		'2024-01-01T09:00:00+00:00',
		'2024-01-01T09:00:00',
		'2024-01-01T09:00:00.000Z',
		' 2024-01-01T09:00:00Z',
		'2024-01-01T09:00:00Z ',
	] as const)('rejects non-canonical timed UNTIL %s', (dateTime) => {
		expectRuleError(
			() =>
				normalizeRecurrenceRule(
					{
						frequency: 'daily',
						end: { kind: 'until', value: { kind: 'dateTime', dateTime } },
					},
					UTC_START,
				),
			'INVALID_UNTIL',
			'end',
		);
	});

	it.each(['2024-1-01', '20240101', '2024-02-30', ' 2024-01-01', '2024-01-01 '])(
		'rejects non-canonical all-day UNTIL %s',
		(date) => {
			expectRuleError(
				() =>
					normalizeRecurrenceRule(
						{ frequency: 'daily', end: { kind: 'until', value: { kind: 'date', date } } },
						ALL_DAY_START,
					),
				'INVALID_UNTIL',
				'end',
			);
		},
	);

	it.each([
		[ALL_DAY_START, { kind: 'date', date: '2023-12-31' }],
		[UTC_START, { kind: 'dateTime', dateTime: '2024-01-01T08:59:59Z' }],
	] as const)('rejects UNTIL before DTSTART', (start, value) => {
		expectRuleError(
			() => normalizeRecurrenceRule({ frequency: 'daily', end: { kind: 'until', value } }, start),
			'UNTIL_BEFORE_START',
			'end',
		);
	});

	it('matches authored BY filters against UTC or authoritative IANA local DTSTART parts', () => {
		expect(() =>
			normalizeRecurrenceRule(
				{ frequency: 'daily', byMonth: [1], byMonthDay: [1], byDay: [{ weekday: 'monday' }] },
				UTC_START,
			),
		).not.toThrow();
		expect(() =>
			normalizeRecurrenceRule(
				{ frequency: 'daily', byMonth: [1], byMonthDay: [1], byDay: [{ weekday: 'monday' }] },
				IANA_START,
			),
		).not.toThrow();
	});

	it.each([
		['positive month day', { frequency: 'monthly', byMonthDay: [2] }, 'byMonthDay'],
		['negative month day', { frequency: 'monthly', byMonthDay: [-1] }, 'byMonthDay'],
		['weekday', { frequency: 'monthly', byDay: [{ weekday: 'tuesday' }] }, 'byDay'],
		[
			'monthly ordinal weekday',
			{ frequency: 'monthly', byDay: [{ weekday: 'monday', ordinal: 2 }] },
			'byDay',
		],
		[
			'year-relative ordinal weekday',
			{ frequency: 'yearly', byDay: [{ weekday: 'monday', ordinal: 2 }] },
			'byDay',
		],
		['month', { frequency: 'yearly', byMonth: [2] }, 'byMonth'],
	] as const)('rejects unsynchronized authored DTSTART: %s', (_label, rule, field) => {
		expectRuleError(() => normalizeRecurrenceRule(rule, UTC_START), 'UNSYNCHRONIZED_START', field);
	});
});

describe('remote RRULE projection and semantic equality', () => {
	it('projects supported mixed-case input to a canonical immutable snapshot', () => {
		const projected = projectRecurrenceRule(
			rruleProperty('bYdAy=fr,+1mo,mo;InTeRvAl=1;FrEq=monthly;bYmOnTh=12,1'),
			UTC_START,
		);

		expect(projected).toEqual({
			frequency: 'monthly',
			byMonth: [1, 12],
			byDay: [{ weekday: 'monday' }, { weekday: 'monday', ordinal: 1 }, { weekday: 'friday' }],
		});
		expectDeeplyFrozen(projected);
	});

	it('round-trips every approved part semantically through canonical wire form', () => {
		const input = {
			frequency: 'weekly',
			interval: 2,
			end: {
				kind: 'until',
				value: {
					kind: 'dateTime',
					dateTime: '2024-12-31T09:00:00Z' as UtcDateTimeString,
				},
			},
			byMonth: [12, 1],
			byDay: [{ weekday: 'monday' }, { weekday: 'friday' }],
			weekStart: 'sunday',
		} as const;
		const normalized = normalizeRecurrenceRule(input, UTC_START);
		const projected = projectRecurrenceRule(
			rruleProperty(serializeRecurrenceRule(input, UTC_START)),
			UTC_START,
		);

		expect(projected).toEqual(normalized);
		expect(recurrenceRulesAreSemanticallyEqual(normalized, projected as RecurrenceRule)).toBe(true);
	});

	it('treats only defined lexical differences as semantically equal', () => {
		const left = projectRecurrenceRule(
			rruleProperty('FREQ=MONTHLY;INTERVAL=1;BYMONTH=12,1;BYDAY=FR,+1MO,MO'),
			UTC_START,
		) as RecurrenceRule;
		const right = projectRecurrenceRule(
			rruleProperty('byday=mo,1mo,fr;bymonth=1,12;freq=monthly'),
			UTC_START,
		) as RecurrenceRule;

		expect(recurrenceRulesAreSemanticallyEqual(left, right)).toBe(true);
		expect(
			recurrenceRulesAreSemanticallyEqual(
				projectRecurrenceRule(
					rruleProperty('FREQ=WEEKLY;INTERVAL=1;BYDAY=FR,MO;WKST=MO'),
					UTC_START,
				) as RecurrenceRule,
				projectRecurrenceRule(
					rruleProperty('byday=mo,fr;freq=weekly'),
					UTC_START,
				) as RecurrenceRule,
			),
		).toBe(true);
		expect(
			recurrenceRulesAreSemanticallyEqual(
				normalizeRecurrenceRule({ frequency: 'daily', interval: 7 }, UTC_START),
				normalizeRecurrenceRule({ frequency: 'weekly' }, UTC_START),
			),
		).toBe(false);
		expect(
			recurrenceRulesAreSemanticallyEqual(
				normalizeRecurrenceRule(
					{ frequency: 'daily', end: { kind: 'count', count: 2 } },
					UTC_START,
				),
				normalizeRecurrenceRule(
					{
						frequency: 'daily',
						end: {
							kind: 'until',
							value: {
								kind: 'dateTime',
								dateTime: '2024-01-02T09:00:00Z' as UtcDateTimeString,
							},
						},
					},
					UTC_START,
				),
			),
		).toBe(false);
	});

	it.each([
		['FREQ=HOURLY', ['FREQ']],
		['BYSETPOS=1;FREQ=HOURLY', ['BYSETPOS', 'FREQ']],
		['FREQ=DAILY;BYSETPOS=1;X-PRIVATE=opaque', ['BYSETPOS', 'X-PRIVATE']],
	] as const)('classifies unapproved parts without exposing their values', (wire, ruleParts) => {
		const projected = projectRecurrenceRule(rruleProperty(wire), UTC_START);
		expect(projected).toEqual({
			kind: 'unsupported',
			reason: 'unsupportedRulePart',
			ruleParts,
		});
		expect(JSON.stringify(projected)).not.toContain('opaque');
	});

	it.each([
		['FREQ=WEEKLY;BYMONTHDAY=1', ['BYMONTHDAY']],
		['FREQ=DAILY;BYDAY=1MO', ['BYDAY']],
		['FREQ=MONTHLY;WKST=SU', ['WKST']],
	] as const)('classifies prohibited approved combinations safely', (wire, ruleParts) => {
		expect(projectRecurrenceRule(rruleProperty(wire), UTC_START)).toEqual({
			kind: 'unsupported',
			reason: 'unsupportedCombination',
			ruleParts,
		});
	});

	it.each([
		['COUNT=2', ['FREQ']],
		['FREQ=DAILY;FREQ=DAILY', ['FREQ']],
		['FREQ=DAILY;COUNT=2;UNTIL=20240102T090000Z', ['COUNT', 'UNTIL']],
		['FREQ=DAILY;BYDAY=', ['BYDAY']],
		['FREQ=MONTHLY;BYDAY=1MO,+1MO', ['BYDAY']],
		['FREQ=DAILY;INTERVAL=0', ['INTERVAL']],
	] as const)('classifies malformed or duplicate input as invalidRule', (wire, ruleParts) => {
		expect(projectRecurrenceRule(rruleProperty(wire), UTC_START)).toEqual({
			kind: 'unsupported',
			reason: 'invalidRule',
			ruleParts,
		});
	});

	it('gives invalid remote syntax precedence over unsupported parts', () => {
		expect(
			projectRecurrenceRule(rruleProperty('FREQ=DAILY;BYSETPOS=1;COUNT=invalid'), UTC_START),
		).toEqual({
			kind: 'unsupported',
			reason: 'invalidRule',
			ruleParts: ['COUNT'],
		});
	});

	it('projects a remote DTSTART mismatch as unsupported instead of throwing or repairing', () => {
		expect(projectRecurrenceRule(rruleProperty('FREQ=MONTHLY;BYDAY=2MO'), UTC_START)).toEqual({
			kind: 'unsupported',
			reason: 'unsupportedCombination',
			ruleParts: ['BYDAY'],
		});
	});

	it('never mutates or retains authored input objects', () => {
		const input = {
			frequency: 'monthly',
			byMonth: [12, 1],
			byDay: [{ weekday: 'monday' }],
		};
		const result = normalizeRecurrenceRule(input, UTC_START);
		input.byMonth[0] = 6;
		input.byDay[0]!.weekday = 'friday';

		expect(result).toEqual({
			frequency: 'monthly',
			byMonth: [1, 12],
			byDay: [{ weekday: 'monday' }],
		});
		expectDeeplyFrozen(result);
	});
});

describe('recurrence error privacy', () => {
	it('provides every granular error code through the approved optional field surface', () => {
		const cases: readonly (readonly [
			keyof typeof RecurrenceRuleErrorCode,
			RecurrenceField | undefined,
			() => unknown,
		])[] = [
			['INVALID_INPUT', undefined, () => normalizeRecurrenceRule(null, UTC_START)],
			[
				'UNKNOWN_FIELD',
				undefined,
				() => normalizeRecurrenceRule({ frequency: 'daily', privateValue: 'sentinel' }, UTC_START),
			],
			[
				'INVALID_FREQUENCY',
				'frequency',
				() => normalizeRecurrenceRule({ frequency: 'sentinel' }, UTC_START),
			],
			[
				'INVALID_INTERVAL',
				'interval',
				() => normalizeRecurrenceRule({ frequency: 'daily', interval: 'sentinel' }, UTC_START),
			],
			[
				'INVALID_END',
				'end',
				() => normalizeRecurrenceRule({ frequency: 'daily', end: 'sentinel' }, UTC_START),
			],
			[
				'INVALID_COUNT',
				'end',
				() =>
					normalizeRecurrenceRule(
						{ frequency: 'daily', end: { kind: 'count', count: 'sentinel' } },
						UTC_START,
					),
			],
			[
				'INVALID_UNTIL',
				'end',
				() =>
					normalizeRecurrenceRule(
						{
							frequency: 'daily',
							end: { kind: 'until', value: { kind: 'dateTime', dateTime: 'sentinel' } },
						},
						UTC_START,
					),
			],
			[
				'UNTIL_BEFORE_START',
				'end',
				() =>
					normalizeRecurrenceRule(
						{
							frequency: 'daily',
							end: {
								kind: 'until',
								value: { kind: 'dateTime', dateTime: '2023-01-01T00:00:00Z' },
							},
						},
						UTC_START,
					),
			],
			[
				'INVALID_BY_DAY',
				'byDay',
				() => normalizeRecurrenceRule({ frequency: 'daily', byDay: 'sentinel' }, UTC_START),
			],
			[
				'INVALID_BY_MONTH_DAY',
				'byMonthDay',
				() => normalizeRecurrenceRule({ frequency: 'daily', byMonthDay: ['sentinel'] }, UTC_START),
			],
			[
				'INVALID_BY_MONTH',
				'byMonth',
				() => normalizeRecurrenceRule({ frequency: 'daily', byMonth: ['sentinel'] }, UTC_START),
			],
			[
				'INVALID_WEEK_START',
				'weekStart',
				() => normalizeRecurrenceRule({ frequency: 'weekly', weekStart: 'sentinel' }, UTC_START),
			],
			[
				'DUPLICATE_VALUE',
				'byMonth',
				() => normalizeRecurrenceRule({ frequency: 'yearly', byMonth: [1, 1] }, UTC_START),
			],
			[
				'INVALID_COMBINATION',
				'weekStart',
				() => normalizeRecurrenceRule({ frequency: 'daily', weekStart: 'sunday' }, UTC_START),
			],
			[
				'UNSYNCHRONIZED_START',
				'byMonth',
				() => normalizeRecurrenceRule({ frequency: 'yearly', byMonth: [2] }, UTC_START),
			],
		];

		for (const [code, field, callback] of cases) {
			const error = expectRuleError(callback, code, field);
			expect(error.message).not.toContain('sentinel');
			expect(error.message).not.toContain('2023');
			expect(Object.keys(error).sort()).toEqual(field === undefined ? ['code'] : ['code', 'field']);
		}
	});
});
