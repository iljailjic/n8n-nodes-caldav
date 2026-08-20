import type { CalendarDateString, UtcDateTimeString } from './eventReadModel';
import type { ICalendarProperty } from './parser';
import type { LocalDateTimeString } from './timeZones';

export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';

export type RecurrenceWeekday =
	'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

export interface RecurrenceByDay {
	readonly weekday: RecurrenceWeekday;
	readonly ordinal?: number;
}

export type RecurrenceUntil =
	| { readonly kind: 'date'; readonly date: CalendarDateString }
	| { readonly kind: 'dateTime'; readonly dateTime: UtcDateTimeString };

export type RecurrenceEnd =
	| { readonly kind: 'count'; readonly count: number }
	| { readonly kind: 'until'; readonly value: RecurrenceUntil };

export interface RecurrenceRule {
	readonly frequency: RecurrenceFrequency;
	readonly interval?: number;
	readonly end?: RecurrenceEnd;
	readonly byMonth?: readonly number[];
	readonly byMonthDay?: readonly number[];
	readonly byDay?: readonly RecurrenceByDay[];
	readonly weekStart?: RecurrenceWeekday;
}

export interface UnsupportedRecurrence {
	readonly kind: 'unsupported';
	readonly reason: 'unsupportedRulePart' | 'unsupportedCombination' | 'invalidRule';
	readonly ruleParts: readonly string[];
}

export type RecurrenceProjection = RecurrenceRule | UnsupportedRecurrence;

export type RecurrenceStartContext =
	| { readonly timeMode: 'allDay'; readonly startDate: CalendarDateString }
	| {
			readonly timeMode: 'timed';
			readonly timeZoneMode: 'utc';
			readonly start: UtcDateTimeString;
	  }
	| {
			readonly timeMode: 'timed';
			readonly timeZoneMode: 'iana';
			readonly start: UtcDateTimeString;
			readonly startLocal: LocalDateTimeString;
	  };

export type RecurrenceField =
	'frequency' | 'interval' | 'end' | 'byDay' | 'byMonthDay' | 'byMonth' | 'weekStart';

export const RecurrenceRuleErrorCode = Object.freeze({
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
} as const);

export type RecurrenceRuleErrorCode =
	(typeof RecurrenceRuleErrorCode)[keyof typeof RecurrenceRuleErrorCode];

const ERROR_MESSAGES: Readonly<Record<RecurrenceRuleErrorCode, string>> = {
	INVALID_INPUT: 'The recurrence rule input is invalid.',
	UNKNOWN_FIELD: 'The recurrence rule contains an unsupported field.',
	INVALID_FREQUENCY: 'The recurrence frequency is invalid.',
	INVALID_INTERVAL: 'The recurrence interval must be a supported positive integer.',
	INVALID_END: 'The recurrence end is invalid.',
	INVALID_COUNT: 'The recurrence count must be a supported positive integer.',
	INVALID_UNTIL: 'The recurrence Until value does not match the event time mode.',
	UNTIL_BEFORE_START: 'The recurrence Until value must not be before the event start.',
	INVALID_BY_DAY: 'The recurrence By Day value is invalid.',
	INVALID_BY_MONTH_DAY: 'The recurrence By Month Day value is invalid.',
	INVALID_BY_MONTH: 'The recurrence By Month value is invalid.',
	INVALID_WEEK_START: 'The recurrence week start is invalid.',
	DUPLICATE_VALUE: 'The recurrence rule contains a duplicate value.',
	INVALID_COMBINATION: 'The recurrence rule contains an unsupported field combination.',
	UNSYNCHRONIZED_START: 'The event start does not match the recurrence rule filters.',
};

export class CalDavRecurrenceRuleError extends Error {
	readonly code: RecurrenceRuleErrorCode;
	readonly field?: RecurrenceField;

	constructor(code: RecurrenceRuleErrorCode, field?: RecurrenceField) {
		super(ERROR_MESSAGES[code]);
		Object.defineProperty(this, 'name', {
			value: 'CalDavRecurrenceRuleError',
			configurable: true,
		});
		this.code = code;
		if (field !== undefined) this.field = field;
	}
}

export type IanaRecurrenceCoverageClassification =
	| {
			readonly kind: 'finite';
			readonly interval: {
				readonly start: UtcDateTimeString;
				readonly end: UtcDateTimeString;
			};
	  }
	| { readonly kind: 'requiresReference'; readonly bound: 'count' | 'unbounded' };

interface DateParts {
	readonly year: number;
	readonly month: number;
	readonly day: number;
	readonly comparisonKey: string;
}

interface ParsedRulePart {
	readonly name: string;
	readonly value: string;
}

const MAX_INTEGER = 2_147_483_647;
const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const UTC_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const LOCAL_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;
const WIRE_DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})$/;
const WIRE_DATE_TIME_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
const RULE_PART_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;
const TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;
const WEEKDAY_TOKEN_PATTERN = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i;
const RULE_KEYS = [
	'frequency',
	'interval',
	'end',
	'byMonth',
	'byMonthDay',
	'byDay',
	'weekStart',
] as const;
const APPROVED_PARTS = new Set([
	'FREQ',
	'INTERVAL',
	'COUNT',
	'UNTIL',
	'BYMONTH',
	'BYMONTHDAY',
	'BYDAY',
	'WKST',
]);
const FREQUENCIES: Readonly<Record<string, RecurrenceFrequency>> = {
	DAILY: 'daily',
	WEEKLY: 'weekly',
	MONTHLY: 'monthly',
	YEARLY: 'yearly',
};
const FREQUENCY_TOKENS: Readonly<Record<RecurrenceFrequency, string>> = {
	daily: 'DAILY',
	weekly: 'WEEKLY',
	monthly: 'MONTHLY',
	yearly: 'YEARLY',
};
const WEEKDAYS = [
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
	'sunday',
] as const satisfies readonly RecurrenceWeekday[];
const WEEKDAY_TOKENS: Readonly<Record<RecurrenceWeekday, string>> = {
	monday: 'MO',
	tuesday: 'TU',
	wednesday: 'WE',
	thursday: 'TH',
	friday: 'FR',
	saturday: 'SA',
	sunday: 'SU',
};
const TOKEN_WEEKDAYS: Readonly<Record<string, RecurrenceWeekday>> = Object.freeze(
	Object.fromEntries(Object.entries(WEEKDAY_TOKENS).map(([weekday, token]) => [token, weekday])),
) as Readonly<Record<string, RecurrenceWeekday>>;
const WEEKDAY_RANK = new Map<RecurrenceWeekday, number>(
	WEEKDAYS.map((weekday, index) => [weekday, index]),
);

function fail(code: RecurrenceRuleErrorCode, field?: RecurrenceField): never {
	throw new CalDavRecurrenceRuleError(code, field);
}

function isPlainRecord(value: object): boolean {
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function dataDescriptors(
	value: unknown,
): Readonly<Record<PropertyKey, PropertyDescriptor>> | undefined {
	if (
		typeof value !== 'object' ||
		value === null ||
		Array.isArray(value) ||
		!isPlainRecord(value)
	) {
		return undefined;
	}
	let descriptors: Readonly<Record<PropertyKey, PropertyDescriptor>>;
	try {
		descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Readonly<
			Record<PropertyKey, PropertyDescriptor>
		>;
	} catch {
		return undefined;
	}
	if (Reflect.ownKeys(descriptors).some((key) => !('value' in descriptors[key]!))) return undefined;
	return descriptors;
}

function exactRecord(
	value: unknown,
	allowedKeys: readonly string[],
	invalidCode: RecurrenceRuleErrorCode,
	field?: RecurrenceField,
): Readonly<Record<PropertyKey, PropertyDescriptor>> {
	const descriptors = dataDescriptors(value);
	if (descriptors === undefined) fail(invalidCode, field);
	const allowed = new Set(allowedKeys);
	for (const key of Reflect.ownKeys(descriptors)) {
		if (typeof key !== 'string' || !allowed.has(key)) fail('UNKNOWN_FIELD');
		const descriptor = descriptors[key]!;
		if (!descriptor.enumerable) fail(invalidCode, field);
	}
	return descriptors;
}

function descriptorValue(
	descriptors: Readonly<Record<PropertyKey, PropertyDescriptor>>,
	key: string,
): unknown {
	return descriptors[key]?.value;
}

function snapshotArray(
	value: unknown,
	invalidCode: RecurrenceRuleErrorCode,
	field: RecurrenceField,
): readonly unknown[] {
	if (!Array.isArray(value) || value.length === 0) fail(invalidCode, field);
	let descriptors: Readonly<Record<PropertyKey, PropertyDescriptor>>;
	try {
		descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Readonly<
			Record<PropertyKey, PropertyDescriptor>
		>;
	} catch {
		return fail(invalidCode, field);
	}
	if (Object.getOwnPropertySymbols(value).length > 0) fail(invalidCode, field);
	const expected = new Set(['length']);
	const snapshot: unknown[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const key = String(index);
		expected.add(key);
		const descriptor = descriptors[key];
		if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
			fail(invalidCode, field);
		}
		snapshot.push(descriptor.value);
	}
	if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !expected.has(key))) {
		fail(invalidCode, field);
	}
	return snapshot;
}

function isLeapYear(year: number): boolean {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
	if (month === 2) return isLeapYear(year) ? 29 : 28;
	if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
	return 31;
}

function validDateParts(year: number, month: number, day: number): boolean {
	return (
		year >= 1 &&
		year <= 9999 &&
		month >= 1 &&
		month <= 12 &&
		day >= 1 &&
		day <= daysInMonth(year, month)
	);
}

function parseDate(value: unknown): DateParts | undefined {
	if (typeof value !== 'string') return undefined;
	const match = CALENDAR_DATE_PATTERN.exec(value);
	if (match === null) return undefined;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (!validDateParts(year, month, day)) return undefined;
	return { year, month, day, comparisonKey: `${match[1]}${match[2]}${match[3]}` };
}

function parseDateTime(
	value: unknown,
	pattern: RegExp,
): (DateParts & { readonly timeKey: string }) | undefined {
	if (typeof value !== 'string') return undefined;
	const match = pattern.exec(value);
	if (match === null) return undefined;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	if (!validDateParts(year, month, day) || hour > 23 || minute > 59 || second > 59) {
		return undefined;
	}
	const comparisonKey = `${match[1]}${match[2]}${match[3]}`;
	return {
		year,
		month,
		day,
		comparisonKey,
		timeKey: `${comparisonKey}${match[4]}${match[5]}${match[6]}`,
	};
}

function validateStart(
	start: RecurrenceStartContext,
): DateParts & { readonly absoluteKey: string } {
	const descriptors = dataDescriptors(start);
	if (descriptors === undefined) fail('INVALID_INPUT');
	const timeMode = descriptorValue(descriptors, 'timeMode');
	if (timeMode === 'allDay') {
		if (Reflect.ownKeys(descriptors).length !== 2 || !('startDate' in descriptors)) {
			fail('INVALID_INPUT');
		}
		const parsed = parseDate(descriptorValue(descriptors, 'startDate'));
		if (parsed === undefined) fail('INVALID_INPUT');
		return { ...parsed, absoluteKey: parsed.comparisonKey };
	}
	if (timeMode !== 'timed') fail('INVALID_INPUT');
	const mode = descriptorValue(descriptors, 'timeZoneMode');
	const expectedKeys = mode === 'iana' ? 4 : mode === 'utc' ? 3 : 0;
	if (Reflect.ownKeys(descriptors).length !== expectedKeys) fail('INVALID_INPUT');
	const absolute = parseDateTime(descriptorValue(descriptors, 'start'), UTC_DATE_TIME_PATTERN);
	if (absolute === undefined) fail('INVALID_INPUT');
	if (mode === 'utc') return { ...absolute, absoluteKey: absolute.timeKey };
	const local = parseDateTime(descriptorValue(descriptors, 'startLocal'), LOCAL_DATE_TIME_PATTERN);
	if (local === undefined) fail('INVALID_INPUT');
	return { ...local, absoluteKey: absolute.timeKey };
}

function positiveInteger(
	value: unknown,
	code: RecurrenceRuleErrorCode,
	field: RecurrenceField,
): number {
	if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_INTEGER) {
		fail(code, field);
	}
	return value as number;
}

function numberList(
	value: unknown,
	field: 'byMonth' | 'byMonthDay',
	minimum: number,
	maximum: number,
	excludeZero: boolean,
): readonly number[] {
	const code = field === 'byMonth' ? 'INVALID_BY_MONTH' : 'INVALID_BY_MONTH_DAY';
	const values = snapshotArray(value, code, field);
	const numbers: number[] = [];
	const seen = new Set<number>();
	for (const item of values) {
		if (
			!Number.isInteger(item) ||
			(item as number) < minimum ||
			(item as number) > maximum ||
			(excludeZero && item === 0)
		) {
			fail(code, field);
		}
		if (seen.has(item as number)) fail('DUPLICATE_VALUE', field);
		seen.add(item as number);
		numbers.push(item as number);
	}
	numbers.sort((left, right) => left - right);
	return Object.freeze(numbers);
}

function weekday(
	value: unknown,
	code: RecurrenceRuleErrorCode,
	field: RecurrenceField,
): RecurrenceWeekday {
	if (typeof value !== 'string' || !WEEKDAYS.includes(value as RecurrenceWeekday)) {
		fail(code, field);
	}
	return value as RecurrenceWeekday;
}

function byDayList(value: unknown): readonly RecurrenceByDay[] {
	const values = snapshotArray(value, 'INVALID_BY_DAY', 'byDay');
	const result: RecurrenceByDay[] = [];
	const seen = new Set<string>();
	for (const item of values) {
		const descriptors = exactRecord(item, ['weekday', 'ordinal'], 'INVALID_BY_DAY', 'byDay');
		if (!('weekday' in descriptors)) fail('INVALID_BY_DAY', 'byDay');
		const day = weekday(descriptorValue(descriptors, 'weekday'), 'INVALID_BY_DAY', 'byDay');
		const ordinalValue = descriptorValue(descriptors, 'ordinal');
		let ordinal: number | undefined;
		if ('ordinal' in descriptors) {
			if (
				!Number.isInteger(ordinalValue) ||
				(ordinalValue as number) < -53 ||
				(ordinalValue as number) > 53 ||
				ordinalValue === 0
			) {
				fail('INVALID_BY_DAY', 'byDay');
			}
			ordinal = ordinalValue as number;
		}
		const key = `${day}\u0000${ordinal ?? ''}`;
		if (seen.has(key)) fail('DUPLICATE_VALUE', 'byDay');
		seen.add(key);
		result.push(Object.freeze({ weekday: day, ...(ordinal === undefined ? {} : { ordinal }) }));
	}
	result.sort((left, right) => {
		const weekdayDifference = WEEKDAY_RANK.get(left.weekday)! - WEEKDAY_RANK.get(right.weekday)!;
		if (weekdayDifference !== 0) return weekdayDifference;
		if (left.ordinal === undefined) return -1;
		if (right.ordinal === undefined) return 1;
		if (left.ordinal < 0 && right.ordinal > 0) return -1;
		if (left.ordinal > 0 && right.ordinal < 0) return 1;
		return left.ordinal - right.ordinal;
	});
	return Object.freeze(result);
}

function normalizeUntil(
	value: unknown,
	startParts?: DateParts & { readonly absoluteKey: string },
): RecurrenceUntil {
	const descriptors = exactRecord(value, ['kind', 'date', 'dateTime'], 'INVALID_UNTIL', 'end');
	const kind = descriptorValue(descriptors, 'kind');
	if (kind === 'date') {
		if (Reflect.ownKeys(descriptors).length !== 2 || !('date' in descriptors)) {
			fail('INVALID_UNTIL', 'end');
		}
		const raw = descriptorValue(descriptors, 'date');
		const parsed = parseDate(raw);
		if (parsed === undefined || (startParts !== undefined && 'timeKey' in startParts)) {
			fail('INVALID_UNTIL', 'end');
		}
		if (startParts !== undefined && parsed.comparisonKey < startParts.absoluteKey) {
			fail('UNTIL_BEFORE_START', 'end');
		}
		return Object.freeze({ kind: 'date', date: raw as CalendarDateString });
	}
	if (kind !== 'dateTime') fail('INVALID_UNTIL', 'end');
	if (Reflect.ownKeys(descriptors).length !== 2 || !('dateTime' in descriptors)) {
		fail('INVALID_UNTIL', 'end');
	}
	const raw = descriptorValue(descriptors, 'dateTime');
	const parsed = parseDateTime(raw, UTC_DATE_TIME_PATTERN);
	if (parsed === undefined || (startParts !== undefined && !('timeKey' in startParts))) {
		fail('INVALID_UNTIL', 'end');
	}
	if (startParts !== undefined && parsed.timeKey < startParts.absoluteKey) {
		fail('UNTIL_BEFORE_START', 'end');
	}
	return Object.freeze({ kind: 'dateTime', dateTime: raw as UtcDateTimeString });
}

function normalizeEnd(
	value: unknown,
	startParts?: DateParts & { readonly absoluteKey: string },
): RecurrenceEnd {
	const descriptors = exactRecord(value, ['kind', 'count', 'value'], 'INVALID_END', 'end');
	const kind = descriptorValue(descriptors, 'kind');
	if (kind === 'count') {
		if (Reflect.ownKeys(descriptors).length !== 2 || !('count' in descriptors)) {
			fail('INVALID_COUNT', 'end');
		}
		return Object.freeze({
			kind: 'count',
			count: positiveInteger(descriptorValue(descriptors, 'count'), 'INVALID_COUNT', 'end'),
		});
	}
	if (kind !== 'until') fail('INVALID_END', 'end');
	if (Reflect.ownKeys(descriptors).length !== 2 || !('value' in descriptors)) {
		fail('INVALID_UNTIL', 'end');
	}
	return Object.freeze({
		kind: 'until',
		value: normalizeUntil(descriptorValue(descriptors, 'value'), startParts),
	});
}

function weekdayNumber(parts: DateParts): number {
	const date = new Date(0);
	date.setUTCHours(0, 0, 0, 0);
	date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
	return (date.getUTCDay() + 6) % 7;
}

function dayOfYear(parts: DateParts): number {
	let value = parts.day;
	for (let month = 1; month < parts.month; month += 1) value += daysInMonth(parts.year, month);
	return value;
}

function ordinalMatches(parts: DateParts, ordinal: number, yearly: boolean): boolean {
	if (!yearly) {
		const positive = Math.floor((parts.day - 1) / 7) + 1;
		const negative = -(Math.floor((daysInMonth(parts.year, parts.month) - parts.day) / 7) + 1);
		return ordinal === positive || ordinal === negative;
	}
	const ordinalDay = dayOfYear(parts);
	const daysInYear = isLeapYear(parts.year) ? 366 : 365;
	const positive = Math.floor((ordinalDay - 1) / 7) + 1;
	const negative = -(Math.floor((daysInYear - ordinalDay) / 7) + 1);
	return ordinal === positive || ordinal === negative;
}

function assertCombination(rule: RecurrenceRule): void {
	if (
		rule.byDay?.some((entry) => entry.ordinal !== undefined) === true &&
		(rule.frequency === 'daily' || rule.frequency === 'weekly')
	) {
		fail('INVALID_COMBINATION', 'byDay');
	}
	if (rule.byMonthDay !== undefined && rule.frequency === 'weekly') {
		fail('INVALID_COMBINATION', 'byMonthDay');
	}
	if (rule.weekStart !== undefined && rule.frequency !== 'weekly') {
		fail('INVALID_COMBINATION', 'weekStart');
	}
}

function assertSynchronizedStart(
	rule: RecurrenceRule,
	startParts: DateParts & { readonly absoluteKey: string },
): void {
	if (rule.byMonth !== undefined && !rule.byMonth.includes(startParts.month)) {
		fail('UNSYNCHRONIZED_START', 'byMonth');
	}
	if (rule.byMonthDay !== undefined) {
		const negativeDay = startParts.day - daysInMonth(startParts.year, startParts.month) - 1;
		if (!rule.byMonthDay.includes(startParts.day) && !rule.byMonthDay.includes(negativeDay)) {
			fail('UNSYNCHRONIZED_START', 'byMonthDay');
		}
	}
	if (rule.byDay !== undefined) {
		const currentWeekday = WEEKDAYS[weekdayNumber(startParts)]!;
		const matched = rule.byDay.some((entry) => {
			if (entry.weekday !== currentWeekday) return false;
			if (entry.ordinal === undefined) return true;
			return ordinalMatches(
				startParts,
				entry.ordinal,
				rule.frequency === 'yearly' && rule.byMonth === undefined,
			);
		});
		if (!matched) fail('UNSYNCHRONIZED_START', 'byDay');
	}
}

function normalizeInternal(input: unknown, start?: RecurrenceStartContext): RecurrenceRule {
	const descriptors = exactRecord(input, RULE_KEYS, 'INVALID_INPUT');
	if (!('frequency' in descriptors)) fail('INVALID_FREQUENCY', 'frequency');
	const frequencyValue = descriptorValue(descriptors, 'frequency');
	if (
		typeof frequencyValue !== 'string' ||
		!Object.values(FREQUENCIES).includes(frequencyValue as RecurrenceFrequency)
	) {
		fail('INVALID_FREQUENCY', 'frequency');
	}
	const frequency = frequencyValue as RecurrenceFrequency;
	const startParts = start === undefined ? undefined : validateStart(start);
	const interval =
		'interval' in descriptors
			? positiveInteger(descriptorValue(descriptors, 'interval'), 'INVALID_INTERVAL', 'interval')
			: undefined;
	const end =
		'end' in descriptors
			? normalizeEnd(descriptorValue(descriptors, 'end'), startParts)
			: undefined;
	const byMonth =
		'byMonth' in descriptors
			? numberList(descriptorValue(descriptors, 'byMonth'), 'byMonth', 1, 12, false)
			: undefined;
	const byMonthDay =
		'byMonthDay' in descriptors
			? numberList(descriptorValue(descriptors, 'byMonthDay'), 'byMonthDay', -31, 31, true)
			: undefined;
	const byDay =
		'byDay' in descriptors ? byDayList(descriptorValue(descriptors, 'byDay')) : undefined;
	const weekStart =
		'weekStart' in descriptors
			? weekday(descriptorValue(descriptors, 'weekStart'), 'INVALID_WEEK_START', 'weekStart')
			: undefined;
	assertCombination({
		frequency,
		...(byMonth === undefined ? {} : { byMonth }),
		...(byMonthDay === undefined ? {} : { byMonthDay }),
		...(byDay === undefined ? {} : { byDay }),
		...(weekStart === undefined ? {} : { weekStart }),
	});
	const rule = Object.freeze({
		frequency,
		...(interval === undefined || interval === 1 ? {} : { interval }),
		...(end === undefined ? {} : { end }),
		...(byMonth === undefined ? {} : { byMonth }),
		...(byMonthDay === undefined ? {} : { byMonthDay }),
		...(byDay === undefined ? {} : { byDay }),
		...(weekStart === undefined || weekStart === 'monday' ? {} : { weekStart }),
	}) satisfies RecurrenceRule;
	if (startParts !== undefined) assertSynchronizedStart(rule, startParts);
	return rule;
}

export function normalizeRecurrenceRule(
	input: unknown,
	start: RecurrenceStartContext,
): RecurrenceRule {
	return normalizeInternal(input, start);
}

function recurrenceUntilWire(until: RecurrenceUntil): string {
	return until.kind === 'date'
		? until.date.replace(/-/g, '')
		: until.dateTime.replace(/-/g, '').replace(/:/g, '');
}

function byDayWire(entry: RecurrenceByDay): string {
	return `${entry.ordinal ?? ''}${WEEKDAY_TOKENS[entry.weekday]}`;
}

export function serializeRecurrenceRule(input: unknown, start: RecurrenceStartContext): string {
	const rule = normalizeInternal(input, start);
	const parts = [`FREQ=${FREQUENCY_TOKENS[rule.frequency]}`];
	if (rule.interval !== undefined) parts.push(`INTERVAL=${rule.interval}`);
	if (rule.end?.kind === 'count') parts.push(`COUNT=${rule.end.count}`);
	else if (rule.end?.kind === 'until') parts.push(`UNTIL=${recurrenceUntilWire(rule.end.value)}`);
	if (rule.byMonth !== undefined) parts.push(`BYMONTH=${rule.byMonth.join(',')}`);
	if (rule.byMonthDay !== undefined) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(',')}`);
	if (rule.byDay !== undefined) parts.push(`BYDAY=${rule.byDay.map(byDayWire).join(',')}`);
	if (rule.weekStart !== undefined) parts.push(`WKST=${WEEKDAY_TOKENS[rule.weekStart]}`);
	return parts.join(';');
}

function asciiUpperCase(value: string): string {
	let result = '';
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		result +=
			codeUnit >= 0x61 && codeUnit <= 0x7a ? String.fromCharCode(codeUnit - 0x20) : value[index]!;
	}
	return result;
}

function uniqueNames(
	parts: readonly ParsedRulePart[],
	predicate: (part: ParsedRulePart) => boolean,
): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const part of parts) {
		if (!predicate(part) || seen.has(part.name)) continue;
		seen.add(part.name);
		names.push(part.name);
	}
	return names;
}

function unsupported(
	reason: UnsupportedRecurrence['reason'],
	names: readonly string[],
): UnsupportedRecurrence {
	return Object.freeze({ kind: 'unsupported', reason, ruleParts: Object.freeze([...names]) });
}

function propertyRawValue(property: ICalendarProperty): string | undefined {
	const descriptors = dataDescriptors(property);
	if (descriptors === undefined || descriptorValue(descriptors, 'kind') !== 'property')
		return undefined;
	const valueDescriptors = dataDescriptors(descriptorValue(descriptors, 'value'));
	if (valueDescriptors === undefined || descriptorValue(valueDescriptors, 'kind') !== 'value') {
		return undefined;
	}
	const raw = descriptorValue(valueDescriptors, 'raw');
	return typeof raw === 'string' ? raw : undefined;
}

function parseParts(raw: string): readonly ParsedRulePart[] | undefined {
	if (raw.length === 0) return undefined;
	const parts: ParsedRulePart[] = [];
	for (const source of raw.split(';')) {
		const equals = source.indexOf('=');
		if (equals <= 0 || equals !== source.lastIndexOf('=')) return undefined;
		const nameSource = source.slice(0, equals);
		const value = source.slice(equals + 1);
		if (!RULE_PART_NAME_PATTERN.test(nameSource)) return undefined;
		parts.push({ name: asciiUpperCase(nameSource), value });
	}
	return parts;
}

function parseIntegerToken(
	value: string,
	minimum: number,
	maximum: number,
	excludeZero: boolean,
): number | undefined {
	if (!/^[+-]?\d+$/u.test(value)) return undefined;
	const parsed = Number(value);
	if (
		!Number.isSafeInteger(parsed) ||
		parsed < minimum ||
		parsed > maximum ||
		(excludeZero && parsed === 0)
	) {
		return undefined;
	}
	return parsed;
}

function parseNumberPart(
	part: ParsedRulePart,
	minimum: number,
	maximum: number,
	excludeZero: boolean,
): readonly number[] | undefined {
	const values = part.value.split(',');
	if (values.some((value) => value.length === 0)) return undefined;
	const result: number[] = [];
	const seen = new Set<number>();
	for (const value of values) {
		const parsed = parseIntegerToken(value, minimum, maximum, excludeZero);
		if (parsed === undefined || seen.has(parsed)) return undefined;
		seen.add(parsed);
		result.push(parsed);
	}
	return result;
}

function parseByDayPart(part: ParsedRulePart): readonly RecurrenceByDay[] | undefined {
	const result: RecurrenceByDay[] = [];
	const seen = new Set<string>();
	for (const value of part.value.split(',')) {
		const match = WEEKDAY_TOKEN_PATTERN.exec(value);
		if (match === null) return undefined;
		const ordinal = match[1] === undefined ? undefined : Number(match[1]);
		if (ordinal !== undefined && (ordinal === 0 || ordinal < -53 || ordinal > 53)) return undefined;
		const day = TOKEN_WEEKDAYS[asciiUpperCase(match[2]!)]!;
		const key = `${day}\u0000${ordinal ?? ''}`;
		if (seen.has(key)) return undefined;
		seen.add(key);
		result.push({ weekday: day, ...(ordinal === undefined ? {} : { ordinal }) });
	}
	return result.length === 0 ? undefined : result;
}

function parseUntilPart(part: ParsedRulePart): RecurrenceUntil | undefined {
	const date = WIRE_DATE_PATTERN.exec(part.value);
	if (date !== null) {
		const formatted = `${date[1]}-${date[2]}-${date[3]}`;
		return parseDate(formatted) === undefined
			? undefined
			: { kind: 'date', date: formatted as CalendarDateString };
	}
	const dateTime = WIRE_DATE_TIME_PATTERN.exec(part.value);
	if (dateTime === null) return undefined;
	const formatted = `${dateTime[1]}-${dateTime[2]}-${dateTime[3]}T${dateTime[4]}:${dateTime[5]}:${dateTime[6]}Z`;
	return parseDateTime(formatted, UTC_DATE_TIME_PATTERN) === undefined
		? undefined
		: { kind: 'dateTime', dateTime: formatted as UtcDateTimeString };
}

function partMap(parts: readonly ParsedRulePart[]): ReadonlyMap<string, ParsedRulePart> {
	return new Map(parts.map((part) => [part.name, part]));
}

function remoteInput(parts: readonly ParsedRulePart[]): {
	readonly input?: Record<string, unknown>;
	readonly invalidParts: readonly string[];
	readonly unsupportedParts: readonly string[];
} {
	const invalid = new Set<string>();
	const counts = new Map<string, number>();
	for (const part of parts) {
		counts.set(part.name, (counts.get(part.name) ?? 0) + 1);
		if (part.value.length === 0) invalid.add(part.name);
	}
	for (const [name, count] of counts) if (count > 1) invalid.add(name);
	if (!counts.has('FREQ')) invalid.add('FREQ');
	if (counts.has('COUNT') && counts.has('UNTIL')) {
		invalid.add('COUNT');
		invalid.add('UNTIL');
	}
	let unsupportedParts = uniqueNames(parts, (part) => !APPROVED_PARTS.has(part.name));
	const values = partMap(parts);
	const frequencyPart = values.get('FREQ');
	let frequency: RecurrenceFrequency | undefined;
	if (frequencyPart !== undefined) {
		const token = asciiUpperCase(frequencyPart.value);
		frequency = FREQUENCIES[token];
		if (frequency === undefined) {
			if (TOKEN_PATTERN.test(frequencyPart.value)) {
				unsupportedParts = uniqueNames(
					parts,
					(part) => part.name === 'FREQ' || !APPROVED_PARTS.has(part.name),
				);
			} else invalid.add('FREQ');
		}
	}
	const input: Record<string, unknown> = {};
	if (frequency !== undefined) input.frequency = frequency;
	const intervalPart = values.get('INTERVAL');
	if (intervalPart !== undefined) {
		const interval = parseIntegerToken(intervalPart.value, 1, MAX_INTEGER, false);
		if (interval === undefined) invalid.add('INTERVAL');
		else input.interval = interval;
	}
	const countPart = values.get('COUNT');
	if (countPart !== undefined) {
		const count = parseIntegerToken(countPart.value, 1, MAX_INTEGER, false);
		if (count === undefined) invalid.add('COUNT');
		else input.end = { kind: 'count', count };
	}
	const untilPart = values.get('UNTIL');
	if (untilPart !== undefined) {
		const until = parseUntilPart(untilPart);
		if (until === undefined) invalid.add('UNTIL');
		else input.end = { kind: 'until', value: until };
	}
	const monthPart = values.get('BYMONTH');
	if (monthPart !== undefined) {
		const values_ = parseNumberPart(monthPart, 1, 12, false);
		if (values_ === undefined) invalid.add('BYMONTH');
		else input.byMonth = values_;
	}
	const monthDayPart = values.get('BYMONTHDAY');
	if (monthDayPart !== undefined) {
		const values_ = parseNumberPart(monthDayPart, -31, 31, true);
		if (values_ === undefined) invalid.add('BYMONTHDAY');
		else input.byMonthDay = values_;
	}
	const byDayPart = values.get('BYDAY');
	if (byDayPart !== undefined) {
		const values_ = parseByDayPart(byDayPart);
		if (values_ === undefined) invalid.add('BYDAY');
		else input.byDay = values_;
	}
	const weekStartPart = values.get('WKST');
	if (weekStartPart !== undefined) {
		const value = TOKEN_WEEKDAYS[asciiUpperCase(weekStartPart.value)];
		if (value === undefined) invalid.add('WKST');
		else input.weekStart = value;
	}
	const invalidParts = uniqueNames(parts, (part) => invalid.has(part.name));
	if (invalid.has('FREQ') && !invalidParts.includes('FREQ')) invalidParts.unshift('FREQ');
	return {
		...(invalid.size === 0 && unsupportedParts.length === 0 ? { input } : {}),
		invalidParts,
		unsupportedParts: [...new Set(unsupportedParts)],
	};
}

function fieldPart(field: RecurrenceField | undefined): string {
	if (field === 'frequency') return 'FREQ';
	if (field === 'interval') return 'INTERVAL';
	if (field === 'end') return 'UNTIL';
	if (field === 'byMonth') return 'BYMONTH';
	if (field === 'byMonthDay') return 'BYMONTHDAY';
	if (field === 'byDay') return 'BYDAY';
	if (field === 'weekStart') return 'WKST';
	return 'RRULE';
}

export function projectRecurrenceRule(
	property: ICalendarProperty,
	start?: RecurrenceStartContext,
): RecurrenceProjection {
	const raw = propertyRawValue(property);
	const parts = raw === undefined ? undefined : parseParts(raw);
	if (parts === undefined) return unsupported('invalidRule', ['RRULE']);
	const classified = remoteInput(parts);
	if (classified.invalidParts.length > 0) {
		return unsupported('invalidRule', classified.invalidParts);
	}
	if (classified.unsupportedParts.length > 0) {
		return unsupported('unsupportedRulePart', classified.unsupportedParts);
	}
	try {
		return normalizeInternal(classified.input, start);
	} catch (error) {
		if (!(error instanceof CalDavRecurrenceRuleError)) return unsupported('invalidRule', ['RRULE']);
		const name = fieldPart(error.field);
		if (
			error.code === 'INVALID_COMBINATION' ||
			error.code === 'UNSYNCHRONIZED_START' ||
			error.code === 'UNTIL_BEFORE_START' ||
			(error.code === 'INVALID_UNTIL' && start !== undefined)
		) {
			return unsupported('unsupportedCombination', [name]);
		}
		return unsupported('invalidRule', [name]);
	}
}

export function recurrenceRulesAreSemanticallyEqual(
	left: RecurrenceRule,
	right: RecurrenceRule,
): boolean {
	try {
		return JSON.stringify(normalizeInternal(left)) === JSON.stringify(normalizeInternal(right));
	} catch {
		return false;
	}
}

export function classifyIanaRecurrenceCoverage(
	input: unknown,
	start: Extract<
		RecurrenceStartContext,
		{ readonly timeMode: 'timed'; readonly timeZoneMode: 'iana' }
	>,
): IanaRecurrenceCoverageClassification {
	const rule = normalizeInternal(input, start);
	if (rule.end?.kind === 'until') {
		if (rule.end.value.kind !== 'dateTime') fail('INVALID_UNTIL', 'end');
		return Object.freeze({
			kind: 'finite',
			interval: Object.freeze({ start: start.start, end: rule.end.value.dateTime }),
		});
	}
	return Object.freeze({
		kind: 'requiresReference',
		bound: rule.end?.kind === 'count' ? 'count' : 'unbounded',
	});
}
