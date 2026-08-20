import { describe, expect, expectTypeOf, it } from 'vitest';

import {
	applyCalendarAlarmMutations,
	authorCalendarAlarms,
	CalDavCalendarAlarmError,
	CalendarAlarmErrorCode,
	projectCalendarAlarms,
} from '../../nodes/CalDav/icalendar/alarms';
import type {
	AudioCalendarAlarm,
	CalendarAlarm,
	CalendarAlarmAction,
	CalendarAlarmDirection,
	CalendarAlarmEdit,
	CalendarAlarmField,
	CalendarAlarmInput,
	CalendarAlarmMutation,
	CalendarAlarmReference,
	CalendarAlarmSelector,
	CalendarAlarmTrigger,
	CalendarAlarmUidGenerator,
	CalendarAlarmUnit,
	DisplayCalendarAlarm,
	EmailCalendarAlarm,
	SupportedCalendarAlarm,
	UnsupportedCalendarAlarm,
	UnsupportedCalendarAlarmReason,
} from '../../nodes/CalDav/icalendar/alarms';
import { parseICalendarResource } from '../../nodes/CalDav/icalendar/parser';
import type {
	ICalendarComponent,
	ICalendarEntry,
	ICalendarResource,
} from '../../nodes/CalDav/icalendar/parser';
import { serializeICalendarResource } from '../../nodes/CalDav/icalendar/serializer';
import {
	calendar,
	MIXED_SUPPORTED_ALARMS,
	PRESERVATION_ALARMS,
	timedMaster,
	UNSUPPORTED_CLASSIFICATION_ALARMS,
} from './fixtures/events/alarm-contract-fixtures';

const encoder = new TextEncoder();
const GENERATED_UIDS = Object.freeze([
	'44444444-4444-4444-8444-444444444444',
	'55555555-5555-4555-8555-555555555555',
	'66666666-6666-4666-8666-666666666666',
	'77777777-7777-4777-8777-777777777777',
]);

const ERROR_MESSAGES = Object.freeze({
	INVALID_INPUT: 'The calendar alarm input is invalid.',
	UNKNOWN_FIELD: 'The calendar alarm input contains an unsupported field.',
	INVALID_SELECTOR: 'The calendar alarm selector is invalid.',
	STALE_SELECTOR: 'The selected calendar alarm no longer matches the current event.',
	ALARM_NOT_FOUND: 'The selected calendar alarm was not found.',
	AMBIGUOUS_SELECTOR: 'The calendar event contains an ambiguous alarm selector.',
	READ_ONLY_ALARM: 'The selected calendar alarm is read-only in structured mode.',
	ACTION_MISMATCH: 'The selected calendar alarm action does not match the edit.',
	INVALID_ACTION: 'The calendar alarm action is invalid.',
	INVALID_TRIGGER: 'The calendar alarm trigger is invalid.',
	INVALID_TRIGGER_VALUE: 'The calendar alarm trigger value is invalid.',
	INVALID_TEXT: 'The calendar alarm text value is invalid.',
	INVALID_RECIPIENT: 'The calendar alarm recipient must be one mailto URI.',
	DUPLICATE_RECIPIENT: 'The calendar alarm contains a duplicate recipient.',
	DUPLICATE_TARGET: 'A calendar alarm can be targeted only once per mutation.',
	NO_CHANGES: 'The calendar alarm mutation does not contain any changes.',
	INVALID_GENERATED_UID: 'A generated calendar alarm UID is invalid.',
	RESOURCE_LIMIT_EXCEEDED: 'The calendar alarm mutation exceeds an iCalendar resource limit.',
} as const);

function parse(lines: readonly string[]): ICalendarResource {
	return parseICalendarResource(encoder.encode(calendar(lines)));
}

function master(resource: ICalendarResource): ICalendarComponent {
	const result = resource.calendar.entries.find(
		(entry): entry is ICalendarComponent =>
			entry.kind === 'component' &&
			entry.name.toUpperCase() === 'VEVENT' &&
			!entry.entries.some(
				(candidate) =>
					candidate.kind === 'property' && candidate.name.toUpperCase() === 'RECURRENCE-ID',
			),
	);
	if (result === undefined) throw new Error('Synthetic master VEVENT is missing.');
	return result;
}

function withMaster(
	resource: ICalendarResource,
	replacement: ICalendarComponent,
): ICalendarResource {
	const entries = resource.calendar.entries.map((entry): ICalendarEntry =>
		entry === master(resource) ? replacement : entry,
	);
	return {
		kind: 'resource',
		originalIcs: '',
		calendar: { kind: 'component', name: resource.calendar.name, entries },
	};
}

function serializeMaster(resource: ICalendarResource, replacement: ICalendarComponent): string {
	return serializeICalendarResource(withMaster(resource, replacement));
}

function uidFactory(values: readonly string[] = GENERATED_UIDS): CalendarAlarmUidGenerator {
	let index = 0;
	return () => values[index++] ?? '88888888-8888-4888-8888-888888888888';
}

function expectAlarmError(
	callback: () => unknown,
	code: keyof typeof CalendarAlarmErrorCode,
	field?: CalendarAlarmField,
): CalDavCalendarAlarmError {
	try {
		callback();
	} catch (error) {
		expect(error).toBeInstanceOf(CalDavCalendarAlarmError);
		expect(error).toMatchObject({
			name: 'CalDavCalendarAlarmError',
			code,
			message: ERROR_MESSAGES[code],
			...(field === undefined ? {} : { field }),
		});
		expect(Object.keys(error as object).sort()).toEqual(
			field === undefined ? ['code', 'name'] : ['code', 'field', 'name'],
		);
		expect(error).not.toHaveProperty('cause');
		expect(error).not.toHaveProperty('input');
		expect(error).not.toHaveProperty('selector');
		expect(error).not.toHaveProperty('uid');
		expect(error).not.toHaveProperty('recipient');
		return error as CalDavCalendarAlarmError;
	}
	throw new Error(`Expected ${code}.`);
}

function expectDeeplyFrozen(value: unknown, seen = new WeakSet<object>()): void {
	if (typeof value !== 'object' || value === null || seen.has(value)) return;
	seen.add(value);
	expect(Object.isFrozen(value)).toBe(true);
	for (const key of Reflect.ownKeys(value)) expectDeeplyFrozen(Reflect.get(value, key), seen);
}

describe('structured VALARM public contract', () => {
	it('exports the exact immutable discriminated unions and helper signatures', () => {
		expectTypeOf<CalendarAlarmAction>().toEqualTypeOf<'display' | 'audio' | 'email'>();
		expectTypeOf<CalendarAlarmReference>().toEqualTypeOf<'start' | 'end'>();
		expectTypeOf<CalendarAlarmDirection>().toEqualTypeOf<'before' | 'after' | 'at'>();
		expectTypeOf<CalendarAlarmUnit>().toEqualTypeOf<'minute' | 'hour' | 'day' | 'week'>();
		expectTypeOf<CalendarAlarmTrigger>().toEqualTypeOf<
			| { readonly reference: CalendarAlarmReference; readonly direction: 'at' }
			| {
					readonly reference: CalendarAlarmReference;
					readonly direction: 'before' | 'after';
					readonly value: number;
					readonly unit: CalendarAlarmUnit;
			  }
		>();
		expectTypeOf<CalendarAlarmSelector>().toEqualTypeOf<
			| { readonly kind: 'uid'; readonly uid: string }
			| { readonly kind: 'legacy'; readonly position: number; readonly fingerprint: string }
		>();
		expectTypeOf<DisplayCalendarAlarm>().toEqualTypeOf<{
			readonly selector: CalendarAlarmSelector;
			readonly uid?: string;
			readonly action: 'display';
			readonly trigger: CalendarAlarmTrigger;
			readonly description: string;
		}>();
		expectTypeOf<AudioCalendarAlarm>().toEqualTypeOf<{
			readonly selector: CalendarAlarmSelector;
			readonly uid?: string;
			readonly action: 'audio';
			readonly trigger: CalendarAlarmTrigger;
		}>();
		expectTypeOf<EmailCalendarAlarm>().toEqualTypeOf<{
			readonly selector: CalendarAlarmSelector;
			readonly uid?: string;
			readonly action: 'email';
			readonly trigger: CalendarAlarmTrigger;
			readonly subject: string;
			readonly body: string;
			readonly recipients: readonly string[];
		}>();
		expectTypeOf<SupportedCalendarAlarm>().toEqualTypeOf<
			DisplayCalendarAlarm | AudioCalendarAlarm | EmailCalendarAlarm
		>();
		expectTypeOf<UnsupportedCalendarAlarmReason>().toEqualTypeOf<
			| 'invalidAlarm'
			| 'unsupportedAction'
			| 'absoluteTrigger'
			| 'repeatingAlarm'
			| 'attachment'
			| 'proximityTrigger'
			| 'unsupportedTrigger'
			| 'unsupportedRecipient'
		>();
		expectTypeOf<UnsupportedCalendarAlarm>().toEqualTypeOf<{
			readonly kind: 'unsupported';
			readonly reason: UnsupportedCalendarAlarmReason;
			readonly alarmParts: readonly string[];
		}>();
		expectTypeOf<CalendarAlarm>().toEqualTypeOf<
			SupportedCalendarAlarm | UnsupportedCalendarAlarm
		>();
		expectTypeOf<Parameters<typeof projectCalendarAlarms>>().toEqualTypeOf<
			[master: ICalendarComponent]
		>();
		expectTypeOf<ReturnType<typeof projectCalendarAlarms>>().toEqualTypeOf<
			readonly CalendarAlarm[]
		>();
		expectTypeOf<CalendarAlarmInput>().toEqualTypeOf<
			| {
					readonly action: 'display';
					readonly trigger: CalendarAlarmTrigger;
					readonly description?: string;
			  }
			| { readonly action: 'audio'; readonly trigger: CalendarAlarmTrigger }
			| {
					readonly action: 'email';
					readonly trigger: CalendarAlarmTrigger;
					readonly subject: string;
					readonly body: string;
					readonly recipients: readonly string[];
			  }
		>();
		expectTypeOf<CalendarAlarmEdit>().toEqualTypeOf<
			| {
					readonly action: 'display';
					readonly trigger?: CalendarAlarmTrigger;
					readonly description?: string;
			  }
			| { readonly action: 'audio'; readonly trigger?: CalendarAlarmTrigger }
			| {
					readonly action: 'email';
					readonly trigger?: CalendarAlarmTrigger;
					readonly subject?: string;
					readonly body?: string;
					readonly recipients?: readonly string[];
			  }
		>();
		expectTypeOf<CalendarAlarmMutation>().toMatchTypeOf<
			| { readonly kind: 'add'; readonly alarm: CalendarAlarmInput }
			| {
					readonly kind: 'edit';
					readonly selector: CalendarAlarmSelector;
					readonly alarm: CalendarAlarmEdit;
			  }
			| { readonly kind: 'remove'; readonly selector: CalendarAlarmSelector }
		>();
	});

	it('freezes the complete stable error code table and fixed sanitized messages', () => {
		expect(CalendarAlarmErrorCode).toEqual(
			Object.fromEntries(Object.keys(ERROR_MESSAGES).map((code) => [code, code])),
		);
		expect(Object.isFrozen(CalendarAlarmErrorCode)).toBe(true);

		for (const [code, message] of Object.entries(ERROR_MESSAGES)) {
			const error = new CalDavCalendarAlarmError(code as keyof typeof CalendarAlarmErrorCode);
			expect(error).toMatchObject({
				name: 'CalDavCalendarAlarmError',
				code,
				message,
			});
			expect(error).not.toHaveProperty('cause');
		}
	});
});

describe('structured VALARM projection', () => {
	it('projects mixed DISPLAY, AUDIO and EMAIL alarms in stable source order', () => {
		const alarms = projectCalendarAlarms(master(parse(timedMaster(MIXED_SUPPORTED_ALARMS))));

		expect(alarms).toEqual([
			{
				selector: { kind: 'uid', uid: '11111111-1111-4111-8111-111111111111' },
				uid: '11111111-1111-4111-8111-111111111111',
				action: 'display',
				trigger: { reference: 'start', direction: 'before', value: 15, unit: 'minute' },
				description: 'Display reminder',
			},
			{
				selector: { kind: 'uid', uid: '22222222-2222-4222-8222-222222222222' },
				uid: '22222222-2222-4222-8222-222222222222',
				action: 'audio',
				trigger: { reference: 'end', direction: 'after', value: 1, unit: 'hour' },
			},
			{
				selector: { kind: 'uid', uid: '33333333-3333-4333-8333-333333333333' },
				uid: '33333333-3333-4333-8333-333333333333',
				action: 'email',
				trigger: { reference: 'start', direction: 'at' },
				subject: 'Email subject',
				body: 'Email body',
				recipients: ['mailto:first@example.test', 'MAILTO:%73econd@example.test'],
			},
		]);
		expectDeeplyFrozen(alarms);
	});

	it.each([
		['TRIGGER:PT0S', { reference: 'start', direction: 'at' }],
		['TRIGGER:-PT0M', { reference: 'start', direction: 'at' }],
		['TRIGGER:+P0D', { reference: 'start', direction: 'at' }],
		['TRIGGER;RELATED=END:PT0W', { reference: 'end', direction: 'at' }],
		['TRIGGER:-PT1M', { reference: 'start', direction: 'before', value: 1, unit: 'minute' }],
		['TRIGGER:PT2H', { reference: 'start', direction: 'after', value: 2, unit: 'hour' }],
		['TRIGGER;RELATED=END:-P3D', { reference: 'end', direction: 'before', value: 3, unit: 'day' }],
		['TRIGGER;RELATED=END:P4W', { reference: 'end', direction: 'after', value: 4, unit: 'week' }],
	] as const)(
		'projects supported relative form %s without unit conversion',
		(trigger, expected) => {
			const alarms = projectCalendarAlarms(
				master(
					parse(
						timedMaster([
							'BEGIN:VALARM',
							'ACTION:DISPLAY',
							trigger,
							'DESCRIPTION:Trigger oracle',
							'END:VALARM',
						]),
					),
				),
			);
			expect(alarms[0]).toMatchObject({ action: 'display', trigger: expected });
		},
	);

	it('uses unique UID selectors and deterministic semantic legacy selectors', () => {
		const first = projectCalendarAlarms(
			master(
				parse(
					timedMaster([
						'BEGIN:VALARM',
						'ACTION:DISPLAY',
						'TRIGGER:-PT5M',
						'DESCRIPTION:Legacy\\, alarm',
						'END:VALARM',
					]),
				),
			),
		)[0] as SupportedCalendarAlarm;
		const lexicalVariant = projectCalendarAlarms(
			master(
				parse(
					timedMaster([
						'begin:valarm',
						'action:display',
						'trigger:-PT5M',
						'DESCRIPTION:Legacy\\, alarm',
						'end:valarm',
					]),
				),
			),
		)[0] as SupportedCalendarAlarm;

		expect(first.selector).toMatchObject({ kind: 'legacy', position: 1 });
		expect(first.selector).toHaveProperty('fingerprint', expect.stringMatching(/^[0-9a-f]{64}$/));
		expect(lexicalVariant.selector).toEqual(first.selector);
	});

	it('falls back to legacy selectors when otherwise usable UIDs are ambiguous', () => {
		const duplicateUid = [
			'BEGIN:VALARM',
			'UID:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
			'ACTION:AUDIO',
			'TRIGGER:-PT5M',
			'END:VALARM',
		];
		const alarms = projectCalendarAlarms(
			master(parse(timedMaster([...duplicateUid, ...duplicateUid]))),
		) as readonly SupportedCalendarAlarm[];
		expect(alarms.map(({ selector }) => selector)).toEqual([
			expect.objectContaining({ kind: 'legacy', position: 1 }),
			expect.objectContaining({ kind: 'legacy', position: 2 }),
		]);
		expect(alarms.every((alarm) => !Object.hasOwn(alarm, 'uid'))).toBe(true);
	});

	it('classifies unsupported siblings independently with safe precedence and parts only', () => {
		const alarms = projectCalendarAlarms(
			master(parse(timedMaster(UNSUPPORTED_CLASSIFICATION_ALARMS))),
		);
		expect(alarms).toEqual([
			{ kind: 'unsupported', reason: 'invalidAlarm', alarmParts: ['ACTION'] },
			{ kind: 'unsupported', reason: 'unsupportedAction', alarmParts: ['ACTION'] },
			{ kind: 'unsupported', reason: 'absoluteTrigger', alarmParts: ['TRIGGER'] },
			{ kind: 'unsupported', reason: 'repeatingAlarm', alarmParts: ['REPEAT', 'DURATION'] },
			{ kind: 'unsupported', reason: 'attachment', alarmParts: ['ATTACH'] },
			{ kind: 'unsupported', reason: 'proximityTrigger', alarmParts: ['PROXIMITY'] },
			{ kind: 'unsupported', reason: 'unsupportedTrigger', alarmParts: ['TRIGGER'] },
			{ kind: 'unsupported', reason: 'unsupportedRecipient', alarmParts: ['ATTENDEE'] },
		]);
		for (const alarm of alarms) {
			expect(Object.keys(alarm).sort()).toEqual(['alarmParts', 'kind', 'reason']);
			expect(JSON.stringify(alarm)).not.toContain('example.test');
			expect(JSON.stringify(alarm)).not.toContain('20400102');
		}
	});
});

describe('structured VALARM authoring', () => {
	it.each([
		['start', 'before', 1, 'minute', 'TRIGGER:-PT1M'],
		['start', 'after', 2, 'hour', 'TRIGGER:PT2H'],
		['end', 'before', 3, 'day', 'TRIGGER;RELATED=END:-P3D'],
		['end', 'after', 4, 'week', 'TRIGGER;RELATED=END:P4W'],
	] as const)(
		'authors %s/%s/%s/%s canonically',
		(reference, direction, value, unit, expectedTrigger) => {
			const source = parse(timedMaster());
			const output = authorCalendarAlarms(
				master(source),
				[
					{
						action: 'audio',
						trigger: { reference, direction, value, unit },
					},
				],
				uidFactory(),
			);
			const serialized = serializeMaster(source, output);
			expect(serialized).toContain(expectedTrigger);
			expect(serialized).toContain(`UID:${GENERATED_UIDS[0]}`);
			expect(serialized).not.toContain('X-WR-ALARMUID');
		},
	);

	it.each(['start', 'end'] as const)('authors explicit at %s as PT0S', (reference) => {
		const source = parse(timedMaster());
		const output = authorCalendarAlarms(
			master(source),
			[{ action: 'audio', trigger: { reference, direction: 'at' } }],
			uidFactory(),
		);
		const serialized = serializeMaster(source, output);
		expect(serialized).toContain(
			reference === 'start' ? 'TRIGGER:PT0S' : 'TRIGGER;RELATED=END:PT0S',
		);
	});

	it('defaults omitted DISPLAY description from the exact non-empty final event Summary', () => {
		const source = parse(timedMaster());
		const output = authorCalendarAlarms(
			master(source),
			[
				{
					action: 'display',
					trigger: { reference: 'start', direction: 'before', value: 10, unit: 'minute' },
				},
			],
			uidFactory(),
		);
		expect(serializeMaster(source, output)).toContain('DESCRIPTION:Alarm oracle');

		const missingSummary = parse(timedMaster().filter((line) => !line.startsWith('SUMMARY:')));
		expectAlarmError(
			() =>
				authorCalendarAlarms(
					master(missingSummary),
					[
						{
							action: 'display',
							trigger: { reference: 'start', direction: 'at' },
						},
					],
					uidFactory(),
				),
			'INVALID_TEXT',
			'description',
		);
	});

	it('authors EMAIL core with exact recipient spelling/order and no VEVENT attendees', () => {
		const source = parse(timedMaster());
		const output = authorCalendarAlarms(
			master(source),
			[
				{
					action: 'email',
					trigger: { reference: 'start', direction: 'before', value: 1, unit: 'day' },
					subject: 'Subject',
					body: 'Body\nsecond line',
					recipients: ['mailto:first.last+tag@example.test', 'MAILTO:%22quoted%22@[192.0.2.1]'],
				},
			],
			uidFactory(),
		);
		const serialized = serializeMaster(source, output);
		const alarmStart = serialized.indexOf('BEGIN:VALARM');
		expect(serialized.slice(0, alarmStart)).not.toContain('ATTENDEE');
		expect(serialized).toContain('SUMMARY:Subject');
		expect(serialized).toContain('DESCRIPTION:Body\\nsecond line');
		expect(serialized.indexOf('ATTENDEE:mailto:first.last+tag@example.test')).toBeLessThan(
			serialized.indexOf('ATTENDEE:MAILTO:%22quoted%22@[192.0.2.1]'),
		);
	});

	it.each([
		['zero', 0],
		['negative', -1],
		['fraction', 1.5],
		['too large', 2_147_483_648],
		['NaN', Number.NaN],
		['infinity', Number.POSITIVE_INFINITY],
	] as const)('rejects %s before/after trigger values', (_label, value) => {
		const source = parse(timedMaster());
		expectAlarmError(
			() =>
				authorCalendarAlarms(
					master(source),
					[
						{
							action: 'audio',
							trigger: { reference: 'start', direction: 'before', value, unit: 'minute' },
						},
					] as CalendarAlarmInput[],
					uidFactory(),
				),
			'INVALID_TRIGGER_VALUE',
			'value',
		);
	});

	it.each([
		['empty list', []],
		['uppercase action', [{ action: 'DISPLAY', trigger: { reference: 'start', direction: 'at' } }]],
		[
			'at with value',
			[{ action: 'audio', trigger: { reference: 'start', direction: 'at', value: 0 } }],
		],
		['end without boundary', [{ action: 'audio', trigger: { reference: 'end', direction: 'at' } }]],
	] as const)('rejects invalid authored shape: %s', (label, alarms) => {
		const source =
			label === 'end without boundary'
				? parse(timedMaster().filter((line) => !line.startsWith('DTEND:')))
				: parse(timedMaster());
		expect(() => authorCalendarAlarms(master(source), alarms, uidFactory())).toThrow(
			CalDavCalendarAlarmError,
		);
	});

	it.each([
		'mailto:',
		'mailto:first@example.test?subject=bad',
		'mailto:first@example.test#fragment',
		'mailto:first@example.test,second@example.test',
		'mailto:first@example.test%0d%0aBcc:private@example.test',
		'mailto:first%ZZ@example.test',
		'http://first@example.test',
	] as const)('rejects unsafe or non-single mailto recipient %s', (recipient) => {
		const source = parse(timedMaster());
		expectAlarmError(
			() =>
				authorCalendarAlarms(
					master(source),
					[
						{
							action: 'email',
							trigger: { reference: 'start', direction: 'at' },
							subject: 'Subject',
							body: 'Body',
							recipients: [recipient],
						},
					],
					uidFactory(),
				),
			'INVALID_RECIPIENT',
			'recipients',
		);
	});

	it('rejects exact authored recipient duplicates without case normalization', () => {
		const source = parse(timedMaster());
		const base = {
			action: 'email',
			trigger: { reference: 'start', direction: 'at' },
			subject: 'Subject',
			body: 'Body',
		} as const;
		expectAlarmError(
			() =>
				authorCalendarAlarms(
					master(source),
					[{ ...base, recipients: ['mailto:a@example.test', 'mailto:a@example.test'] }],
					uidFactory(),
				),
			'DUPLICATE_RECIPIENT',
			'recipients',
		);
		expect(() =>
			authorCalendarAlarms(
				master(source),
				[{ ...base, recipients: ['mailto:a@example.test', 'MAILTO:a@example.test'] }],
				uidFactory(),
			),
		).not.toThrow();
	});

	it('rejects invalid and colliding generated UUIDs without retrying', () => {
		const source = parse(timedMaster(MIXED_SUPPORTED_ALARMS));
		for (const generated of [
			'not-a-uuid',
			'11111111-1111-4111-8111-111111111111',
			'11111111-1111-1111-8111-111111111111',
		]) {
			let calls = 0;
			expectAlarmError(
				() =>
					authorCalendarAlarms(
						master(source),
						[{ action: 'audio', trigger: { reference: 'start', direction: 'at' } }],
						() => {
							calls += 1;
							return generated;
						},
					),
				'INVALID_GENERATED_UID',
				'uid',
			);
			expect(calls).toBe(1);
		}
	});
});

describe('structured VALARM targeted mutation and preservation', () => {
	it('adds in mutation order, edits in place, and removes only its selected target', () => {
		const source = parse(timedMaster(MIXED_SUPPORTED_ALARMS));
		const projected = projectCalendarAlarms(master(source)) as readonly SupportedCalendarAlarm[];
		const output = applyCalendarAlarmMutations(
			master(source),
			[
				{
					kind: 'edit',
					selector: projected[0]!.selector,
					alarm: {
						action: 'display',
						trigger: { reference: 'end', direction: 'before', value: 2, unit: 'hour' },
					},
				},
				{ kind: 'remove', selector: projected[1]!.selector },
				{
					kind: 'add',
					alarm: {
						action: 'audio',
						trigger: { reference: 'start', direction: 'after', value: 1, unit: 'minute' },
					},
				},
			],
			uidFactory(),
		);
		const serialized = serializeMaster(source, output);
		expect(serialized).toContain('UID:11111111-1111-4111-8111-111111111111');
		expect(serialized).toContain('TRIGGER;RELATED=END:-PT2H');
		expect(serialized).toContain('DESCRIPTION:Display reminder');
		expect(serialized).not.toContain('UID:22222222-2222-4222-8222-222222222222');
		expect(serialized).toContain('UID:33333333-3333-4333-8333-333333333333');
		expect(serialized).toContain(`UID:${GENERATED_UIDS[0]}`);
		expect(serialized.indexOf('33333333-3333-4333-8333-333333333333')).toBeLessThan(
			serialized.indexOf(GENERATED_UIDS[0]!),
		);
	});

	it('preserves opaque alarm properties and all non-target read-only alarms byte-semantically', () => {
		const source = parse(timedMaster(PRESERVATION_ALARMS));
		const supported = projectCalendarAlarms(master(source))[0] as SupportedCalendarAlarm;
		const output = applyCalendarAlarmMutations(
			master(source),
			[
				{
					kind: 'edit',
					selector: supported.selector,
					alarm: { action: 'display', description: 'Changed' },
				},
			],
			uidFactory(),
		);
		const serialized = serializeMaster(source, output);
		for (const expected of [
			'X-BEFORE;X-PARAM="Keep,Quoted":opaque-before',
			'ACKNOWLEDGED:20400101T010203Z',
			'X-WR-ALARMUID:existing-apple-id',
			'TRIGGER;VALUE=DATE-TIME:20400102T090000Z',
			'X-ABSOLUTE:keep-absolute',
			'REPEAT:2',
			'DURATION:PT5M',
			'X-REPEAT:keep-repeat',
			'ATTACH:https://example.test/tone.wav',
		]) {
			expect(serialized).toContain(expected);
		}
		expect(serialized).toContain('DESCRIPTION:Changed');
	});

	it('preserves a remote empty DISPLAY description during trigger-only edit', () => {
		const source = parse(
			timedMaster([
				'BEGIN:VALARM',
				'ACTION:DISPLAY',
				'TRIGGER:-PT5M',
				'DESCRIPTION:',
				'END:VALARM',
			]),
		);
		const existing = projectCalendarAlarms(master(source))[0] as SupportedCalendarAlarm;
		const output = applyCalendarAlarmMutations(
			master(source),
			[
				{
					kind: 'edit',
					selector: existing.selector,
					alarm: {
						action: 'display',
						trigger: { reference: 'start', direction: 'before', value: 10, unit: 'minute' },
					},
				},
			],
			uidFactory(),
		);
		expect(serializeMaster(source, output)).toContain('DESCRIPTION:\r\n');
		expectAlarmError(
			() =>
				applyCalendarAlarmMutations(
					master(source),
					[
						{
							kind: 'edit',
							selector: existing.selector,
							alarm: { action: 'display', description: '' },
						},
					],
					uidFactory(),
				),
			'INVALID_TEXT',
			'description',
		);
	});

	it('rejects stale legacy selectors, action conversion, duplicate targets, and semantic no-op', () => {
		const source = parse(
			timedMaster([
				'BEGIN:VALARM',
				'ACTION:DISPLAY',
				'TRIGGER:-PT5M',
				'DESCRIPTION:Legacy',
				'END:VALARM',
			]),
		);
		const alarm = projectCalendarAlarms(master(source))[0] as SupportedCalendarAlarm;
		const stale = { ...alarm.selector, fingerprint: '0'.repeat(64) } as CalendarAlarmSelector;
		expectAlarmError(
			() =>
				applyCalendarAlarmMutations(
					master(source),
					[{ kind: 'remove', selector: stale }],
					uidFactory(),
				),
			'STALE_SELECTOR',
			'selector',
		);
		expectAlarmError(
			() =>
				applyCalendarAlarmMutations(
					master(source),
					[
						{
							kind: 'edit',
							selector: alarm.selector,
							alarm: { action: 'audio', trigger: { reference: 'start', direction: 'at' } },
						},
					],
					uidFactory(),
				),
			'ACTION_MISMATCH',
			'action',
		);
		expectAlarmError(
			() =>
				applyCalendarAlarmMutations(
					master(source),
					[
						{ kind: 'remove', selector: alarm.selector },
						{ kind: 'remove', selector: alarm.selector },
					],
					uidFactory(),
				),
			'DUPLICATE_TARGET',
			'selector',
		);
		expectAlarmError(
			() =>
				applyCalendarAlarmMutations(
					master(source),
					[
						{
							kind: 'edit',
							selector: alarm.selector,
							alarm: { action: 'display', description: 'Legacy' },
						},
					],
					uidFactory(),
				),
			'NO_CHANGES',
		);
	});

	it('rejects accessors, symbols, sparse arrays, cycles, unknown keys and own undefined', () => {
		const source = parse(timedMaster());
		const hostileValues: unknown[] = [];
		const accessor = Object.defineProperty({}, 'action', {
			enumerable: true,
			get: () => 'audio',
		});
		const symbol = { action: 'audio', trigger: { reference: 'start', direction: 'at' } };
		Object.defineProperty(symbol, Symbol('private'), { enumerable: true, value: 'private' });
		const sparse = new Array(1);
		const cycle: Record<string, unknown> = { action: 'audio' };
		cycle.trigger = cycle;
		hostileValues.push(
			accessor,
			symbol,
			sparse,
			cycle,
			{ action: 'audio', trigger: { reference: 'start', direction: 'at' }, unknown: true },
			{ action: 'audio', trigger: undefined },
			new (class Alarm {
				action = 'audio';
				trigger = { reference: 'start', direction: 'at' };
			})(),
		);

		for (const value of hostileValues) {
			expect(() => authorCalendarAlarms(master(source), [value], uidFactory())).toThrow(
				CalDavCalendarAlarmError,
			);
		}
	});
});
