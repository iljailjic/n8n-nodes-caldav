import type { INodeProperties } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';

import { CalDav } from '../../nodes/CalDav/CalDav.node';
import { prepareCalendarEventCreate } from '../../nodes/CalDav/events/createPreparation';
import {
	CalDavCalendarEventTimeZoneAuthoringError,
	CalendarEventTimeZoneAuthoringErrorCode,
	resolveCalendarEventTimeZoneAuthoring,
} from '../../nodes/CalDav/events/timeZoneAuthoring';
import { createCalendarEventPreservationContext } from '../../nodes/CalDav/icalendar/eventReadModel';
import { parseICalendarResource } from '../../nodes/CalDav/icalendar/parser';
import {
	applyCalendarEventPatch,
	CalDavCalendarEventPatchError,
	CalendarEventPatchErrorCode,
} from '../../nodes/CalDav/icalendar/patcher';
import type { CalendarEventPatch } from '../../nodes/CalDav/icalendar/patcher';
import type { RecurrenceRule } from '../../nodes/CalDav/icalendar/recurrence';
import {
	serializeBasicUtcEvent,
	serializeICalendarResource,
} from '../../nodes/CalDav/icalendar/serializer';
import {
	assertVTimeZoneCovers,
	canonicalizeIanaTimeZone,
} from '../../nodes/CalDav/icalendar/timeZones';
import type { ICalendarComponent } from '../../nodes/CalDav/icalendar/parser';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';

const CLOCK = new Date('2040-01-01T00:00:00Z');
const CALENDAR_URL = validateAbsoluteHttpUrl('https://calendar.example.test/calendars/work/');
const UNSAFE_MESSAGE =
	'This recurrence change cannot be applied safely. Use Raw ICS to change the complete recurrence set.';
const COUNT_REFERENCE_MESSAGE =
	'A Count-bounded IANA recurrence requires server time-zone reference support.';

function operationValues(property: INodeProperties): readonly string[] {
	const displayOptions = property.displayOptions as
		{ readonly show?: Readonly<Record<string, readonly string[]>> } | undefined;
	return displayOptions?.show?.operation ?? [];
}

function collection(operation: string, name: string): INodeProperties {
	const property = new CalDav().description.properties.find(
		(candidate) => candidate.name === name && operationValues(candidate).includes(operation),
	);
	if (property === undefined) throw new Error(`Missing ${operation} ${name} collection.`);
	return property;
}

function collectionOptions(property: INodeProperties): readonly INodeProperties[] {
	return (property.options ?? []) as readonly INodeProperties[];
}

function fixedValues(property: INodeProperties): readonly INodeProperties[] {
	const option = property.options?.[0] as unknown as {
		readonly values?: readonly INodeProperties[];
	};
	if (!Array.isArray(option?.values)) throw new Error('Expected fixed-collection values.');
	return option.values;
}

function semanticOptionOrder(properties: readonly INodeProperties[]): readonly string[] {
	return properties.reduce<string[]>((result, property) => {
		if (result.at(-1) !== property.name) result.push(property.name);
		return result;
	}, []);
}

function recurrenceVariants(property: INodeProperties): readonly INodeProperties[] {
	return collectionOptions(property).filter(({ name }) => name === 'recurrence');
}

function timeModeVisibility(property: INodeProperties): readonly string[] {
	const displayOptions = property.displayOptions as
		{ readonly show?: Readonly<Record<string, readonly string[]>> } | undefined;
	return displayOptions?.show?.timeMode ?? [];
}

function untilDescriptor(property: INodeProperties): INodeProperties {
	const rule =
		property.name === 'recurrence' && fixedValues(property)[0]?.name === 'action'
			? fixedValues(property).find(({ name }) => name === 'value')
			: property;
	if (rule === undefined) throw new Error('Missing recurrence Set value.');
	const until = fixedValues(rule).find(({ name }) => name === 'until');
	if (until === undefined) throw new Error('Missing recurrence Until control.');
	return until;
}

function context(calendarData: string) {
	return createCalendarEventPreservationContext(
		parseICalendarResource(Buffer.from(calendarData, 'utf8')),
	);
}

function resource(lines: readonly string[]): string {
	return [...lines, ''].join('\r\n');
}

function utcResource(
	options: {
		readonly rrule?: string;
		readonly recurrenceContent?: readonly string[];
		readonly exception?: boolean;
	} = {},
): string {
	return resource([
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//example.test//recurrence authoring oracle//EN',
		'X-CALENDAR-KEEP:opaque-calendar',
		'BEGIN:VEVENT',
		'UID:recurrence-authoring@example.test',
		'DTSTAMP:20400101T000000Z',
		'DTSTART:20400101T090000Z',
		'DTEND:20400101T100000Z',
		...(options.rrule === undefined ? [] : [options.rrule]),
		...(options.recurrenceContent ?? []),
		'SUMMARY:Before',
		'X-MASTER-KEEP;X-PARAM=MiXeD:opaque-master',
		'BEGIN:VALARM',
		'ACTION:DISPLAY',
		'TRIGGER:-PT10M',
		'DESCRIPTION:Preserve alarm',
		'END:VALARM',
		'END:VEVENT',
		...(options.exception === true
			? [
					'BEGIN:VEVENT',
					'UID:recurrence-authoring@example.test',
					'RECURRENCE-ID:20400108T090000Z',
					'DTSTAMP:20400101T000000Z',
					'DTSTART:20400108T110000Z',
					'DTEND:20400108T120000Z',
					'SUMMARY:Moved exception',
					'X-EXCEPTION-KEEP:opaque-exception',
					'END:VEVENT',
				]
			: []),
		'END:VCALENDAR',
	]);
}

function recurrencePatch(
	recurrence:
		{ readonly kind: 'set'; readonly value: RecurrenceRule } | { readonly kind: 'remove' },
	additional: Readonly<Record<string, unknown>> = {},
): CalendarEventPatch {
	return {
		timeMode: 'timed',
		recurrence,
		...additional,
	} as unknown as CalendarEventPatch;
}

function serializedPatch(calendarData: string, patch: CalendarEventPatch): string {
	return serializeICalendarResource(
		applyCalendarEventPatch(context(calendarData), patch, new Date('2040-01-02T03:04:05Z')),
	);
}

function oneTimeZone(calendarData: string): ICalendarComponent {
	const definitions = parseICalendarResource(
		Buffer.from(calendarData, 'utf8'),
	).calendar.entries.filter(
		(entry): entry is ICalendarComponent =>
			entry.kind === 'component' && entry.name.toUpperCase() === 'VTIMEZONE',
	);
	if (definitions.length !== 1) throw new Error('Expected one authored VTIMEZONE.');
	return definitions[0]!;
}

describe('recurrence controls activate atomically in the n8n node', () => {
	it('registers Create, Update, and Upsert controls in the exact semantic option order', () => {
		const create = collection('create', 'additionalFields');
		const update = collection('update', 'fieldsToUpdate');
		const upsert = collection('upsert', 'additionalFields');

		expect(semanticOptionOrder(collectionOptions(create))).toEqual([
			'categories',
			'description',
			'location',
			'recurrence',
			'status',
			'transparency',
			'url',
		]);
		expect(semanticOptionOrder(collectionOptions(update))).toEqual([
			'timeZone',
			'start',
			'end',
			'startDate',
			'endDate',
			'summary',
			'categories',
			'description',
			'location',
			'recurrence',
			'status',
			'transparency',
			'url',
		]);
		expect(semanticOptionOrder(collectionOptions(upsert))).toEqual([
			'categories',
			'description',
			'location',
			'recurrence',
			'status',
			'transparency',
			'url',
		]);
	});

	it.each([
		['create', 'additionalFields', false],
		['update', 'fieldsToUpdate', true],
		['upsert', 'additionalFields', true],
	] as const)(
		'provides timed and all-day %s variants with the correct Set/Remove boundary',
		(operation, name, patchControl) => {
			const variants = recurrenceVariants(collection(operation, name));
			expect(variants).toHaveLength(2);
			expect(variants.map(timeModeVisibility)).toEqual([['timed'], ['allDay']]);
			expect(untilDescriptor(variants[0]!)).not.toHaveProperty('typeOptions.dateOnly');
			expect(untilDescriptor(variants[1]!)).toMatchObject({ typeOptions: { dateOnly: true } });
			for (const variant of variants) {
				const names = fixedValues(variant).map(({ name: valueName }) => valueName);
				expect(names.includes('action')).toBe(patchControl);
				if (patchControl) {
					expect(
						fixedValues(variant).find(({ name: valueName }) => valueName === 'action'),
					).toMatchObject({
						options: [
							{ name: 'Set', value: 'set' },
							{ name: 'Remove', value: 'remove' },
						],
					});
				}
			}
		},
	);
});

describe('recurrence authoring and preservation wire contract', () => {
	it('authors one canonical UTC master RRULE after DTEND and before SUMMARY', () => {
		const calendarData = serializeBasicUtcEvent({
			uid: 'utc-recurrence@example.test',
			dtstamp: CLOCK,
			start: new Date('2040-01-02T10:00:00Z'),
			end: new Date('2040-01-02T11:00:00Z'),
			summary: 'Recurring UTC event',
			recurrence: {
				frequency: 'monthly',
				interval: 2,
				end: { kind: 'count', count: 4 },
				byMonth: [1, 6],
				byMonthDay: [2],
			},
		} as unknown as Parameters<typeof serializeBasicUtcEvent>[0]);

		const unfolded = calendarData.replace(/\r\n[ \t]/gu, '');
		expect(unfolded.match(/^RRULE:/gmu) ?? []).toHaveLength(1);
		expect(unfolded).toContain(
			'\r\nDTEND:20400102T110000Z\r\nRRULE:FREQ=MONTHLY;INTERVAL=2;COUNT=4;BYMONTH=1,6;BYMONTHDAY=2\r\nSUMMARY:',
		);
		expect(unfolded).not.toMatch(/RECURRENCE-ID|EXDATE|RDATE/iu);
	});

	it('authors an all-day DATE Until without a DATE-TIME recurrence value', () => {
		const calendarData = serializeBasicUtcEvent({
			uid: 'all-day-recurrence@example.test',
			dtstamp: CLOCK,
			timeMode: 'allDay',
			startDate: '2040-01-02',
			endDate: '2040-01-03',
			summary: 'Recurring all-day event',
			recurrence: {
				frequency: 'daily',
				end: { kind: 'until', value: { kind: 'date', date: '2040-02-01' } },
			},
		} as unknown as Parameters<typeof serializeBasicUtcEvent>[0]);

		expect(calendarData.replace(/\r\n[ \t]/gu, '')).toContain(
			'RRULE:FREQ=DAILY;UNTIL=20400201\r\n',
		);
		expect(calendarData).not.toContain('UNTIL=20400201T');
	});

	it('treats a canonical semantic Set as a no-op and preserves every lexical recurrence detail', () => {
		const original = utcResource({
			rrule: 'rrule:count=4;interval=1;freq=daily',
			recurrenceContent: [
				'EXDATE;X-KEEP=yes:20400108T090000Z',
				'RDATE;X-KEEP=yes:20400115T090000Z',
			],
			exception: true,
		});
		const updated = serializedPatch(
			original,
			recurrencePatch(
				{ kind: 'set', value: { frequency: 'daily', end: { kind: 'count', count: 4 } } },
				{ summary: { kind: 'set', value: 'After' } },
			),
		);

		for (const preserved of [
			'rrule:count=4;interval=1;freq=daily',
			'EXDATE;X-KEEP=yes:20400108T090000Z',
			'RDATE;X-KEEP=yes:20400115T090000Z',
			'RECURRENCE-ID:20400108T090000Z',
			'X-MASTER-KEEP;X-PARAM=MiXeD:opaque-master',
			'X-EXCEPTION-KEEP:opaque-exception',
			'BEGIN:VALARM',
		]) {
			expect(updated).toContain(preserved);
		}
		expect(updated).toContain('SUMMARY:After');
	});

	it('replaces and removes only a clean supported master RRULE', () => {
		const original = utcResource({ rrule: 'RRULE:FREQ=DAILY;COUNT=4' });
		const replaced = serializedPatch(
			original,
			recurrencePatch({
				kind: 'set',
				value: { frequency: 'weekly', end: { kind: 'count', count: 3 } },
			}),
		);
		const removed = serializedPatch(replaced, recurrencePatch({ kind: 'remove' }));

		expect(replaced).not.toContain('RRULE:FREQ=DAILY;COUNT=4');
		expect(replaced).toContain(
			'DTEND:20400101T100000Z\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nSUMMARY:Before',
		);
		expect(replaced.match(/RRULE:/g)).toHaveLength(1);
		expect(removed).not.toMatch(/RRULE:/u);
		expect(removed).toContain('X-MASTER-KEEP;X-PARAM=MiXeD:opaque-master');
	});

	it.each([
		[
			'exception recurrence replacement',
			utcResource({ rrule: 'RRULE:FREQ=DAILY;COUNT=4', exception: true }),
			recurrencePatch({
				kind: 'set',
				value: { frequency: 'weekly', end: { kind: 'count', count: 3 } },
			}),
		],
		[
			'EXDATE-bearing time change',
			utcResource({
				rrule: 'RRULE:FREQ=DAILY;COUNT=4',
				recurrenceContent: ['EXDATE:20400108T090000Z'],
			}),
			{
				timeMode: 'timed',
				start: { kind: 'set', value: new Date('2040-01-01T11:00:00Z') },
			} as CalendarEventPatch,
		],
	] as const)(
		'rejects unsafe %s with one exact private-safe error',
		(_label, calendarData, patch) => {
			let error: unknown;
			try {
				applyCalendarEventPatch(context(calendarData), patch, CLOCK);
			} catch (failure) {
				error = failure;
			}

			expect(error).toBeInstanceOf(CalDavCalendarEventPatchError);
			expect(CalendarEventPatchErrorCode as Readonly<Record<string, string>>).toMatchObject({
				UNSAFE_RECURRENCE_MUTATION: 'UNSAFE_RECURRENCE_MUTATION',
			});
			expect(error).toMatchObject({
				code: 'UNSAFE_RECURRENCE_MUTATION',
				field: 'recurrence',
				message: UNSAFE_MESSAGE,
			});
			expect(JSON.stringify(error)).not.toMatch(
				/DAILY|WEEKLY|2040|EXDATE|recurrence-authoring|opaque|calendar\.example/iu,
			);
		},
	);
});

describe('recurring IANA timezone coverage', () => {
	it('uses Until plus event duration as the finite fallback coverage without expansion', async () => {
		const resolveReference = vi.fn().mockRejectedValue(new Error('private reference failure'));
		const uidGenerator = vi.fn(() => 'finite-iana-recurrence@example.test');
		const clock = vi.fn(() => CLOCK);
		const prepared = await prepareCalendarEventCreate(
			{
				calendarUrl: CALENDAR_URL,
				timeMode: 'timed',
				start: new Date('2040-01-15T09:00:00Z'),
				end: new Date('2040-01-15T10:00:00Z'),
				timeZone: {
					timeZoneMode: 'iana',
					timeZone: canonicalizeIanaTimeZone('Europe/Prague'),
				},
				summary: 'Finite recurring IANA event',
				recurrence: {
					frequency: 'daily',
					end: {
						kind: 'until',
						value: { kind: 'dateTime', dateTime: '2040-11-01T09:00:00Z' },
					},
				},
			} as unknown as Parameters<typeof prepareCalendarEventCreate>[0],
			clock,
			{ resolveReference },
			uidGenerator,
		);

		const definition = oneTimeZone(prepared.calendarData);
		expect(() =>
			assertVTimeZoneCovers(definition, canonicalizeIanaTimeZone('Europe/Prague'), {
				start: new Date('2040-01-15T09:00:00Z'),
				end: new Date('2040-11-01T10:00:00Z'),
			}),
		).not.toThrow();
		expect(prepared.calendarData).toContain('RRULE:FREQ=DAILY;UNTIL=20401101T090000Z');
		expect(resolveReference).toHaveBeenCalledOnce();
		expect(uidGenerator).toHaveBeenCalledOnce();
		expect(clock).toHaveBeenCalledOnce();
	});

	it('rejects Count fallback with its distinct fixed error', async () => {
		const error = await resolveCalendarEventTimeZoneAuthoring({
			calendarUrl: CALENDAR_URL,
			timeZone: canonicalizeIanaTimeZone('Europe/Prague'),
			coverage: { kind: 'count' },
			referenceContext: {
				resolveReference: vi.fn().mockRejectedValue(new Error('private reference failure')),
			},
		} as unknown as Parameters<typeof resolveCalendarEventTimeZoneAuthoring>[0]).catch(
			(failure: unknown) => failure,
		);

		expect(error).toBeInstanceOf(CalDavCalendarEventTimeZoneAuthoringError);
		expect(
			CalendarEventTimeZoneAuthoringErrorCode as Readonly<Record<string, string>>,
		).toMatchObject({
			COUNT_REQUIRES_REFERENCE: 'COUNT_REQUIRES_REFERENCE',
		});
		expect(error).toMatchObject({
			code: 'COUNT_REQUIRES_REFERENCE',
			message: COUNT_REFERENCE_MESSAGE,
		});
		expect(JSON.stringify(error)).not.toMatch(/private|Prague|calendar\.example/iu);
	});
});
