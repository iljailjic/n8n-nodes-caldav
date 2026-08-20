import type { INodeProperties } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';

import {
	CalDav,
	normalizeRecurrenceParameter,
	recurrencePatchDescriptor,
	recurrenceRuleDescriptor,
} from '../../nodes/CalDav/CalDav.node';
import type {
	CalendarDateString,
	UtcDateTimeString,
} from '../../nodes/CalDav/icalendar/eventReadModel';
import {
	CalDavRecurrenceRuleError,
	classifyIanaRecurrenceCoverage,
} from '../../nodes/CalDav/icalendar/recurrence';
import type { RecurrenceStartContext } from '../../nodes/CalDav/icalendar/recurrence';
import type { LocalDateTimeString } from '../../nodes/CalDav/icalendar/timeZones';

const ALL_DAY_START: RecurrenceStartContext = {
	timeMode: 'allDay',
	startDate: '2024-01-01' as CalendarDateString,
};
const UTC_START: RecurrenceStartContext = {
	timeMode: 'timed',
	timeZoneMode: 'utc',
	start: '2024-01-01T09:00:00Z' as UtcDateTimeString,
};
const IANA_START = {
	timeMode: 'timed',
	timeZoneMode: 'iana',
	start: '2024-01-01T09:00:00Z' as UtcDateTimeString,
	startLocal: '2024-01-01T10:00:00' as LocalDateTimeString,
} as const satisfies Extract<
	RecurrenceStartContext,
	{ readonly timeMode: 'timed'; readonly timeZoneMode: 'iana' }
>;

function nestedValues(property: INodeProperties): readonly INodeProperties[] {
	const option = property.options?.[0] as unknown as {
		readonly values?: readonly INodeProperties[];
	};
	if (!Array.isArray(option?.values)) throw new Error('Expected one fixed-collection option.');
	return option.values;
}

function byName(properties: readonly INodeProperties[], name: string): INodeProperties {
	const property = properties.find((candidate) => candidate.name === name);
	if (property === undefined) throw new Error(`Missing synthetic descriptor ${name}.`);
	return property;
}

function options(property: INodeProperties): readonly unknown[] {
	return property.options ?? [];
}

describe('reusable recurrence node descriptors', () => {
	it('defines the exact single-rule controls and registers them in the live node', () => {
		const descriptor = recurrenceRuleDescriptor('timed');
		const values = nestedValues(descriptor);

		expect(descriptor).toMatchObject({
			displayName: 'Recurrence',
			name: 'recurrence',
			type: 'fixedCollection',
			typeOptions: { multipleValues: false },
			default: {},
			options: [{ displayName: 'Rule', name: 'rule' }],
		});
		expect(values.map(({ name }) => name)).toEqual([
			'frequency',
			'interval',
			'endMode',
			'count',
			'until',
			'byDay',
			'byMonthDay',
			'byMonth',
			'weekStart',
		]);
		expect(byName(values, 'frequency')).toMatchObject({
			type: 'options',
			required: true,
			default: 'daily',
		});
		expect(options(byName(values, 'frequency'))).toEqual([
			{ name: 'Daily', value: 'daily' },
			{ name: 'Weekly', value: 'weekly' },
			{ name: 'Monthly', value: 'monthly' },
			{ name: 'Yearly', value: 'yearly' },
		]);
		expect(byName(values, 'interval')).toMatchObject({
			type: 'number',
			default: 1,
			typeOptions: { minValue: 1, maxValue: 2_147_483_647 },
		});
		expect(byName(values, 'endMode')).toMatchObject({
			default: 'never',
			options: [
				{ name: 'Never', value: 'never' },
				{ name: 'After Number of Occurrences', value: 'count' },
				{ name: 'On Date/Time', value: 'until' },
			],
		});
		expect(byName(values, 'count').displayOptions).toEqual({ show: { endMode: ['count'] } });
		expect(byName(values, 'until')).toMatchObject({
			type: 'dateTime',
			default: '',
			displayOptions: { show: { endMode: ['until'] } },
		});
		expect(byName(values, 'until')).not.toHaveProperty('typeOptions.dateOnly');
		expect(byName(values, 'weekStart')).toMatchObject({
			default: 'monday',
			displayOptions: { show: { frequency: ['weekly'] } },
		});
		expect(JSON.stringify(new CalDav().description.properties)).toContain('"name":"recurrence"');
	});

	it('defines repeatable BY rows, a month multi-select, and mode-specific Until', () => {
		const timed = nestedValues(recurrenceRuleDescriptor('timed'));
		const allDay = nestedValues(recurrenceRuleDescriptor('allDay'));
		const byDay = byName(timed, 'byDay');
		const byMonthDay = byName(timed, 'byMonthDay');

		expect(byDay).toMatchObject({
			type: 'fixedCollection',
			typeOptions: { multipleValues: true },
			placeholder: 'Add Day',
		});
		expect(nestedValues(byDay).map(({ name }) => name)).toEqual([
			'weekday',
			'ordinalMode',
			'ordinal',
		]);
		expect(byName(nestedValues(byDay), 'ordinal')).toMatchObject({
			typeOptions: { minValue: -53, maxValue: 53 },
			displayOptions: { show: { ordinalMode: ['ordinal'] } },
		});
		expect(byMonthDay).toMatchObject({
			type: 'fixedCollection',
			typeOptions: { multipleValues: true },
			placeholder: 'Add Month Day',
		});
		expect(byName(timed, 'byMonth')).toMatchObject({
			type: 'multiOptions',
			default: [],
		});
		expect(options(byName(timed, 'byMonth'))).toHaveLength(12);
		expect(byName(allDay, 'until')).toMatchObject({ typeOptions: { dateOnly: true } });
	});

	it('defines reusable set/remove semantics only for Update and Upsert integration', () => {
		const patch = recurrencePatchDescriptor('timed');
		const values = nestedValues(patch);

		expect(patch).toMatchObject({
			name: 'recurrence',
			type: 'fixedCollection',
			required: true,
		});
		expect(values.map(({ name }) => name)).toEqual(['action', 'value']);
		expect(byName(values, 'action')).toMatchObject({
			required: true,
			noDataExpression: true,
			default: 'set',
			options: [
				{ name: 'Set', value: 'set' },
				{ name: 'Remove', value: 'remove' },
			],
		});
		expect(byName(values, 'value').displayOptions).toEqual({ show: { action: ['set'] } });
		expect(recurrenceRuleDescriptor('timed')).not.toHaveProperty('required');
	});
});

describe('recurrence node parameter normalization', () => {
	it('removes every UI-only wrapper and canonicalizes a representative expression result', () => {
		const normalized = normalizeRecurrenceParameter(
			{
				rule: {
					frequency: 'monthly',
					interval: 1,
					endMode: 'count',
					count: 10,
					byDay: {
						day: [
							{ weekday: 'monday', ordinalMode: 'ordinal', ordinal: 1 },
							{ weekday: 'monday', ordinalMode: 'every' },
						],
					},
					byMonthDay: { day: [{ value: -31 }, { value: 1 }] },
					byMonth: [12, 1],
					weekStart: 'monday',
				},
			},
			UTC_START,
		);

		expect(normalized).toEqual({
			frequency: 'monthly',
			end: { kind: 'count', count: 10 },
			byMonth: [1, 12],
			byMonthDay: [-31, 1],
			byDay: [{ weekday: 'monday' }, { weekday: 'monday', ordinal: 1 }],
		});
		expect(JSON.stringify(normalized)).not.toMatch(/"rule"|endMode|ordinalMode|"day"/);
	});

	it('maps timed and all-day Until expression values to the coupled public union', () => {
		expect(
			normalizeRecurrenceParameter(
				{
					rule: {
						frequency: 'daily',
						endMode: 'until',
						until: '2024-01-01T09:00:00Z',
					},
				},
				UTC_START,
			),
		).toEqual({
			frequency: 'daily',
			end: {
				kind: 'until',
				value: { kind: 'dateTime', dateTime: '2024-01-01T09:00:00Z' },
			},
		});
		expect(
			normalizeRecurrenceParameter(
				{
					rule: { frequency: 'daily', endMode: 'until', until: '2024-01-01' },
				},
				ALL_DAY_START,
			),
		).toEqual({
			frequency: 'daily',
			end: { kind: 'until', value: { kind: 'date', date: '2024-01-01' } },
		});
	});

	it('passes whole-object and individual expression results through identical strict validation', () => {
		for (const value of [
			{ rule: { frequency: 'daily', unknown: 'private' } },
			{ rule: { frequency: 'daily', interval: '2' } },
			{ rule: { frequency: 'daily', endMode: 'never', count: 2 } },
			{
				rule: {
					frequency: 'monthly',
					byDay: { day: [{ weekday: 'monday', ordinalMode: 'ordinal' }] },
				},
			},
		]) {
			expect(() => normalizeRecurrenceParameter(value, UTC_START)).toThrowError(
				CalDavRecurrenceRuleError,
			);
		}
	});

	it('does not execute accessors supplied by an expression', () => {
		const getter = vi.fn(() => 'daily');
		const rule = Object.defineProperty({}, 'frequency', { enumerable: true, get: getter });

		expect(() => normalizeRecurrenceParameter({ rule }, UTC_START)).toThrowError(
			CalDavRecurrenceRuleError,
		);
		expect(getter).not.toHaveBeenCalled();
	});
});

describe('IANA recurrence authoring coverage classification', () => {
	it('permits generated fallback only for an exact UTC Until interval', () => {
		const result = classifyIanaRecurrenceCoverage(
			{
				frequency: 'daily',
				end: {
					kind: 'until',
					value: { kind: 'dateTime', dateTime: '2024-02-01T09:00:00Z' },
				},
			},
			IANA_START,
		);

		expect(result).toEqual({
			kind: 'finite',
			interval: { start: '2024-01-01T09:00:00Z', end: '2024-02-01T09:00:00Z' },
		});
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.kind === 'finite' ? result.interval : undefined)).toBe(true);
	});

	it.each([
		['COUNT', { frequency: 'daily', end: { kind: 'count', count: 10 } }, 'count'],
		['unbounded', { frequency: 'daily' }, 'unbounded'],
	] as const)(
		'requires a verified reference for %s without expanding occurrences',
		(_label, rule, bound) => {
			expect(classifyIanaRecurrenceCoverage(rule, IANA_START)).toEqual({
				kind: 'requiresReference',
				bound,
			});
		},
	);
});
