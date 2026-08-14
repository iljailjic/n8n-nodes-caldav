import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { createCalendarEventPreservationContext } from '../../nodes/CalDav/icalendar/eventReadModel';
import * as patcherModule from '../../nodes/CalDav/icalendar/patcher';
import {
	applyCalendarEventPatch,
	CalDavCalendarEventPatchError,
	CalendarEventPatchErrorCode,
} from '../../nodes/CalDav/icalendar/patcher';
import type {
	CalendarEventPatch,
	CalendarEventPatchErrorCode as CalendarEventPatchErrorCodeType,
	CalendarEventPatchField,
	OptionalFieldPatch,
	SetPatch,
} from '../../nodes/CalDav/icalendar/patcher';
import { parseICalendarResource } from '../../nodes/CalDav/icalendar/parser';
import type {
	ICalendarComponent,
	ICalendarProperty,
	ICalendarResource,
} from '../../nodes/CalDav/icalendar/parser';
import {
	CalDavICalendarSerializeError,
	serializeICalendarResource,
} from '../../nodes/CalDav/icalendar/serializer';

const encoder = new TextEncoder();
const MODIFIED_AT = new Date('2026-08-14T10:11:12Z');
const ERROR_MESSAGES: Readonly<Record<CalendarEventPatchErrorCodeType, string>> = {
	INVALID_INPUT: 'The calendar event patch input is invalid.',
	UNKNOWN_PATCH_FIELD: 'The calendar event patch contains an unsupported field.',
	IMMUTABLE_FIELD: 'The calendar event identity cannot be changed.',
	NO_CHANGES: 'The calendar event patch does not contain any changes.',
	INVALID_CONTEXT: 'The calendar event preservation context is invalid.',
	AMBIGUOUS_PROPERTY: 'The calendar event contains an ambiguous property.',
	INVALID_DATE: 'The calendar event patch date is invalid.',
	INVALID_TIME_RANGE: 'The event end must be later than its start.',
	INVALID_TEXT: 'The calendar event patch TEXT value is invalid.',
	INVALID_URI: 'The calendar event patch URI value is invalid.',
	UNSUPPORTED_TIME: 'The calendar event uses an unsupported time representation for this patch.',
	INCOMPATIBLE_PARAMETERS:
		'The calendar event property parameters are incompatible with this patch.',
	INVALID_METADATA: 'The calendar event revision metadata is invalid.',
};

function calendar(lines: readonly string[]): string {
	return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR', ''].join('\r\n');
}

function event(uid: string, lines: readonly string[]): readonly string[] {
	return ['BEGIN:VEVENT', `UID:${uid}`, ...lines, 'END:VEVENT'];
}

function parse(lines: readonly string[]): ICalendarResource {
	return parseICalendarResource(encoder.encode(calendar(lines)));
}

function context(lines: readonly string[]) {
	return createCalendarEventPreservationContext(parse(lines));
}

function basicContext(extra: readonly string[] = []) {
	return context(
		event('patch-uid', [
			'DTSTAMP:20260812T080000Z',
			'DTSTART:20260812T090000Z',
			'DTEND:20260812T100000Z',
			'SUMMARY:Original',
			'DESCRIPTION:Original description',
			'LOCATION:Original location',
			'URL:https://events.example.test/original%2Fpath',
			...extra,
		]),
	);
}

function properties(component: ICalendarComponent): readonly ICalendarProperty[] {
	return component.entries.filter((entry): entry is ICalendarProperty => entry.kind === 'property');
}

function property(component: ICalendarComponent, name: string): ICalendarProperty | undefined {
	return properties(component).find((candidate) => candidate.name.toUpperCase() === name);
}

function master(resource: ICalendarResource): ICalendarComponent {
	return resource.calendar.entries.find(
		(entry): entry is ICalendarComponent =>
			entry.kind === 'component' &&
			entry.name.toUpperCase() === 'VEVENT' &&
			property(entry, 'RECURRENCE-ID') === undefined,
	)!;
}

function value(resource: ICalendarResource, name: string): string | undefined {
	const selected = property(master(resource), name);
	return selected?.value.textValues?.[0] ?? selected?.value.raw;
}

function expectPatchError(
	callback: () => unknown,
	code: CalendarEventPatchErrorCodeType,
	field?: CalendarEventPatchField,
): CalDavCalendarEventPatchError {
	try {
		callback();
		expect.unreachable('Expected patching to fail');
	} catch (error) {
		expect(error).toBeInstanceOf(CalDavCalendarEventPatchError);
		const patchError = error as CalDavCalendarEventPatchError;
		expect(patchError).toMatchObject({
			name: 'CalDavCalendarEventPatchError',
			code,
			message: ERROR_MESSAGES[code],
			...(field === undefined ? {} : { field }),
		});
		if (field === undefined) expect(patchError).not.toHaveProperty('field');
		return patchError;
	}
}

function expectDeeplyFrozen(value: unknown, seen = new WeakSet<object>()): void {
	if (typeof value !== 'object' || value === null || seen.has(value)) return;
	seen.add(value);
	expect(Object.isFrozen(value)).toBe(true);
	for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
		if ('value' in descriptor) expectDeeplyFrozen(descriptor.value, seen);
	}
}

describe('calendar event patch public contract', () => {
	it('exports exactly the accepted runtime and compile-time surface', () => {
		expect(Object.keys(patcherModule).sort()).toEqual([
			'CalDavCalendarEventPatchError',
			'CalendarEventPatchErrorCode',
			'applyCalendarEventPatch',
		]);
		expect(CalendarEventPatchErrorCode).toEqual(
			Object.fromEntries(Object.keys(ERROR_MESSAGES).map((code) => [code, code])),
		);
		expect(Object.isFrozen(CalendarEventPatchErrorCode)).toBe(true);

		expectTypeOf<SetPatch<Date>>().toEqualTypeOf<{
			readonly kind: 'set';
			readonly value: Date;
		}>();
		expectTypeOf<OptionalFieldPatch<string>>().toEqualTypeOf<
			SetPatch<string> | { readonly kind: 'remove' }
		>();
		expectTypeOf<Parameters<typeof applyCalendarEventPatch>>().toEqualTypeOf<
			[
				context: ReturnType<typeof createCalendarEventPreservationContext>,
				patch: CalendarEventPatch,
				modifiedAt: Date,
			]
		>();
		expectTypeOf<ReturnType<typeof applyCalendarEventPatch>>().toEqualTypeOf<ICalendarResource>();
	});

	it.each(Object.entries(ERROR_MESSAGES) as [CalendarEventPatchErrorCodeType, string][])(
		'constructs sanitized %s errors',
		(code, message) => {
			const error = new CalDavCalendarEventPatchError(code, 'summary');
			expect(error).toMatchObject({
				name: 'CalDavCalendarEventPatchError',
				code,
				message,
				field: 'summary',
			});
			expect(error).not.toHaveProperty('cause');
			expect(JSON.stringify(error)).not.toContain('PRIVATE');
		},
	);
});

describe('omitted, set, remove, and no-op semantics', () => {
	it.each([
		[
			'start',
			{ start: { kind: 'set', value: new Date('2026-08-12T09:15:00Z') } },
			'DTSTART',
			'20260812T091500Z',
		],
		[
			'end',
			{ end: { kind: 'set', value: new Date('2026-08-12T10:15:00Z') } },
			'DTEND',
			'20260812T101500Z',
		],
		['summary', { summary: { kind: 'set', value: '' } }, 'SUMMARY', ''],
		['description', { description: { kind: 'set', value: '' } }, 'DESCRIPTION', ''],
		['location', { location: { kind: 'set', value: '  Room 42  ' } }, 'LOCATION', '  Room 42  '],
		[
			'url',
			{ url: { kind: 'set', value: 'urn:synthetic:opaque%2Fvalue' } },
			'URL',
			'urn:synthetic:opaque%2Fvalue',
		],
	] as const)('sets %s while preserving omitted fields', (_field, patch, name, expected) => {
		const original = basicContext();
		const snapshot = JSON.stringify(original.resource);
		const output = applyCalendarEventPatch(original, patch, MODIFIED_AT);

		expect(value(output, name)).toBe(expected);
		expect(value(output, 'UID')).toBe('patch-uid');
		expect(value(output, 'DTSTAMP')).toBe('20260814T101112Z');
		expect(value(output, 'LAST-MODIFIED')).toBe('20260814T101112Z');
		expect(JSON.stringify(original.resource)).toBe(snapshot);
		expect(output.originalIcs).toBe('');
		expectDeeplyFrozen(output);
	});

	it.each([
		['description', { description: { kind: 'remove' } }, 'DESCRIPTION'],
		['location', { location: { kind: 'remove' } }, 'LOCATION'],
		['url', { url: { kind: 'remove' } }, 'URL'],
	] as const)('explicitly removes only %s', (_field, patch, name) => {
		const output = applyCalendarEventPatch(basicContext(), patch, MODIFIED_AT);
		expect(property(master(output), name)).toBeUndefined();
		expect(value(output, name === 'DESCRIPTION' ? 'LOCATION' : 'DESCRIPTION')).toBeDefined();
	});

	it('rejects empty and wholly semantic no-op patches before modifiedAt validation', () => {
		const original = basicContext();
		const invalidModifiedAt = new Date(Number.NaN);
		expectPatchError(() => applyCalendarEventPatch(original, {}, invalidModifiedAt), 'NO_CHANGES');
		expectPatchError(
			() =>
				applyCalendarEventPatch(
					original,
					{ summary: { kind: 'set', value: 'Original' } },
					invalidModifiedAt,
				),
			'NO_CHANGES',
		);
		const absent = context(
			event('absent', [
				'DTSTAMP:20260812T080000Z',
				'DTSTART:20260812T090000Z',
				'DTEND:20260812T100000Z',
			]),
		);
		expectPatchError(
			() => applyCalendarEventPatch(absent, { location: { kind: 'remove' } }, invalidModifiedAt),
			'NO_CHANGES',
		);
	});

	it('applies an effective operation once while tolerating mixed no-ops', () => {
		const output = applyCalendarEventPatch(
			basicContext(),
			{
				summary: { kind: 'set', value: 'Original' },
				description: { kind: 'remove' },
				location: { kind: 'set', value: 'Changed' },
			},
			MODIFIED_AT,
		);
		expect(value(output, 'LOCATION')).toBe('Changed');
		expect(property(master(output), 'DESCRIPTION')).toBeUndefined();
		expect(
			properties(master(output)).filter((candidate) => candidate.name === 'LAST-MODIFIED'),
		).toHaveLength(1);
	});
});

describe('runtime input hardening and deterministic field validation', () => {
	it.each([
		['own undefined', { summary: undefined }, 'INVALID_INPUT', 'summary'],
		['required remove', { start: { kind: 'remove' } }, 'INVALID_INPUT', 'start'],
		['bad discriminant', { summary: { kind: 'delete', value: 'x' } }, 'INVALID_INPUT', 'summary'],
		[
			'extra operation key',
			{ summary: { kind: 'set', value: 'x', extra: true } },
			'INVALID_INPUT',
			'summary',
		],
		['empty URL', { url: { kind: 'set', value: '' } }, 'INVALID_URI', 'url'],
		[
			'fragment URL',
			{ url: { kind: 'set', value: 'https://example.test/#fragment' } },
			'INVALID_URI',
			'url',
		],
		['TEXT bare CR', { summary: { kind: 'set', value: 'one\rtwo' } }, 'INVALID_TEXT', 'summary'],
		['TEXT DEL', { location: { kind: 'set', value: 'one\u007ftwo' } }, 'INVALID_TEXT', 'location'],
		[
			'invalid Date',
			{ start: { kind: 'set', value: new Date(Number.NaN) } },
			'INVALID_DATE',
			'start',
		],
		[
			'fractional Date',
			{ end: { kind: 'set', value: new Date('2026-08-12T10:00:00.001Z') } },
			'INVALID_DATE',
			'end',
		],
	] as const)('rejects %s', (_label, patch, code, field) => {
		expectPatchError(
			() => applyCalendarEventPatch(basicContext(), patch as CalendarEventPatch, MODIFIED_AT),
			code,
			field,
		);
	});

	it('rejects immutable keys before unknown keys and field values', () => {
		expectPatchError(
			() =>
				applyCalendarEventPatch(
					basicContext(),
					{
						unknown: true,
						uid: 'PRIVATE-UID',
						start: { kind: 'set', value: new Date(Number.NaN) },
					} as never,
					MODIFIED_AT,
				),
			'IMMUTABLE_FIELD',
		);
		expectPatchError(
			() => applyCalendarEventPatch(basicContext(), { unknown: true } as never, MODIFIED_AT),
			'UNKNOWN_PATCH_FIELD',
		);
	});

	it('validates fields in start-to-URL order regardless of source key order', () => {
		const patch = {
			url: { kind: 'set', value: '' },
			start: { kind: 'set', value: new Date(Number.NaN) },
		} as const;
		expectPatchError(
			() => applyCalendarEventPatch(basicContext(), patch, MODIFIED_AT),
			'INVALID_DATE',
			'start',
		);
	});

	it('rejects arrays, instances, symbols, non-enumerable fields, accessors, and cycles', () => {
		const getter = vi.fn(() => ({ kind: 'set', value: 'PRIVATE-GETTER' }));
		const accessor = Object.defineProperty({}, 'summary', { enumerable: true, get: getter });
		const withSymbol = { summary: { kind: 'set', value: 'x' }, [Symbol('private')]: true };
		const hidden = Object.defineProperty({}, 'summary', {
			value: { kind: 'set', value: 'x' },
			enumerable: false,
		});
		class PatchInstance {
			summary = { kind: 'set' as const, value: 'x' };
		}
		const cyclic: Record<string, unknown> = {};
		cyclic.summary = cyclic;
		for (const patch of [[], new PatchInstance(), withSymbol, hidden, accessor, cyclic]) {
			try {
				applyCalendarEventPatch(basicContext(), patch as CalendarEventPatch, MODIFIED_AT);
				expect.unreachable('Expected hardened patch input rejection');
			} catch (error) {
				expect(error).toMatchObject({
					code: 'INVALID_INPUT',
					message: ERROR_MESSAGES.INVALID_INPUT,
				});
			}
		}
		expect(getter).not.toHaveBeenCalled();
	});

	it('sanitizes hostile patch Proxy traps and does not trust caller-created public errors', () => {
		const hostileError = new CalDavCalendarEventPatchError('NO_CHANGES');
		hostileError.message = 'PRIVATE-HOSTILE-PATCH';
		const patch = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw hostileError;
				},
			},
		);
		const error = expectPatchError(
			() => applyCalendarEventPatch(basicContext(), patch as CalendarEventPatch, MODIFIED_AT),
			'INVALID_INPUT',
		);
		expect(`${error.message}\n${error.stack ?? ''}\n${JSON.stringify(error)}`).not.toContain(
			'PRIVATE-HOSTILE-PATCH',
		);
		expect(error).not.toHaveProperty('cause');
	});
});

describe('time scope, parameters, ordering, and revision metadata', () => {
	it('sets either or both UTC bounds and enforces the final strict range', () => {
		const startOnly = applyCalendarEventPatch(
			basicContext(),
			{ start: { kind: 'set', value: new Date('2026-08-12T09:30:00Z') } },
			MODIFIED_AT,
		);
		expect(value(startOnly, 'DTSTART')).toBe('20260812T093000Z');
		expect(value(startOnly, 'DTEND')).toBe('20260812T100000Z');
		expectPatchError(
			() =>
				applyCalendarEventPatch(
					basicContext(),
					{ end: { kind: 'set', value: new Date('2026-08-12T09:00:00Z') } },
					MODIFIED_AT,
				),
			'INVALID_TIME_RANGE',
		);
	});

	it.each([
		['recurrence', ['RRULE:FREQ=DAILY;COUNT=2'], 'UNSUPPORTED_TIME'],
		[
			'all day',
			['DTSTART;VALUE=DATE:20260812', 'DTEND;VALUE=DATE:20260813'],
			'INCOMPATIBLE_PARAMETERS',
		],
		[
			'TZID',
			['DTSTART;TZID=Europe/Prague:20260812T090000', 'DTEND;TZID=Europe/Prague:20260812T100000'],
			'INCOMPATIBLE_PARAMETERS',
		],
		['floating', ['DTSTART:20260812T090000', 'DTEND:20260812T100000'], 'UNSUPPORTED_TIME'],
		['DURATION', ['DTSTART:20260812T090000Z', 'DURATION:PT1H'], 'UNSUPPORTED_TIME'],
	] as const)(
		'rejects a %s time patch while allowing a text-only patch',
		(_label, timeLines, code) => {
			const source = context(
				event('unsupported-time', ['DTSTAMP:20260812T080000Z', ...timeLines, 'SUMMARY:Original']),
			);
			expectPatchError(
				() =>
					applyCalendarEventPatch(
						source,
						{ start: { kind: 'set', value: new Date('2026-08-12T09:30:00Z') } },
						MODIFIED_AT,
					),
				code,
				'start',
			);
			const textOnly = applyCalendarEventPatch(
				source,
				{ summary: { kind: 'set', value: 'Preserved time' } },
				MODIFIED_AT,
			);
			expect(value(textOnly, 'SUMMARY')).toBe('Preserved time');
		},
	);

	it('preserves source casing, parameter order/names/values, and position on replacement', () => {
		const source = context(
			event('parameters', [
				'DTSTAMP;X-META=opaque:20260812T080000Z',
				'DTSTART:20260812T090000Z',
				'DTEND:20260812T100000Z',
				'summary;X-FIRST=one;value=text;X-SECOND="two,three":Original',
			]),
		);
		const before = property(source.master, 'SUMMARY')!;
		const output = applyCalendarEventPatch(
			source,
			{ summary: { kind: 'set', value: 'Changed' } },
			MODIFIED_AT,
		);
		const after = property(master(output), 'SUMMARY')!;
		expect(after.name).toBe('summary');
		expect(after.parameters).toBe(before.parameters);
		expect(after.parameters.map((parameter) => parameter.name)).toEqual([
			'X-FIRST',
			'value',
			'X-SECOND',
		]);
		expect(property(master(output), 'DTSTAMP')!.parameters).toEqual(
			property(source.master, 'DTSTAMP')!.parameters,
		);
	});

	it.each([
		['TEXT with TZID', 'SUMMARY;TZID=Europe/Prague:Original', 'summary'],
		['TEXT with URI value', 'SUMMARY;VALUE=URI:urn:old', 'summary'],
		['URL with TEXT value', 'URL;VALUE=TEXT:https://example.test', 'url'],
	] as const)('rejects incompatible parameters: %s', (_label, line, field) => {
		const source = context(
			event('incompatible', [
				'DTSTAMP:20260812T080000Z',
				'DTSTART:20260812T090000Z',
				'DTEND:20260812T100000Z',
				line,
			]),
		);
		const patch =
			field === 'url'
				? { url: { kind: 'set' as const, value: 'https://changed.example.test' } }
				: { summary: { kind: 'set' as const, value: 'Changed' } };
		expectPatchError(
			() => applyCalendarEventPatch(source, patch, MODIFIED_AT),
			'INCOMPATIBLE_PARAMETERS',
			field,
		);
	});

	it('uses canonical insertion anchors without reordering repeated unknown entries', () => {
		const source = context(
			event('anchors', [
				'X-BEFORE:first',
				'DTSTAMP:20260812T080000Z',
				'X-REPEAT:one',
				'DTSTART:20260812T090000Z',
				'DTEND:20260812T100000Z',
				'X-REPEAT:two',
			]),
		);
		const output = applyCalendarEventPatch(
			source,
			{
				summary: { kind: 'set', value: 'Inserted summary' },
				location: { kind: 'set', value: 'Inserted location' },
			},
			MODIFIED_AT,
		);
		const names = properties(master(output)).map((candidate) => candidate.name);
		expect(names.filter((name) => name === 'X-REPEAT')).toEqual(['X-REPEAT', 'X-REPEAT']);
		expect(names.indexOf('SUMMARY')).toBeLessThan(names.indexOf('LOCATION'));
		expect(names.indexOf('LAST-MODIFIED')).toBe(names.indexOf('DTSTAMP') + 1);
	});

	it.each([
		['missing DTSTAMP', [], 'INVALID_METADATA'],
		[
			'duplicate DTSTAMP',
			['DTSTAMP:20260812T080000Z', 'DTSTAMP:20260812T080001Z'],
			'AMBIGUOUS_PROPERTY',
		],
		[
			'duplicate LAST-MODIFIED',
			[
				'DTSTAMP:20260812T080000Z',
				'LAST-MODIFIED:20260812T080000Z',
				'LAST-MODIFIED:20260812T080001Z',
			],
			'AMBIGUOUS_PROPERTY',
		],
		['non-UTC DTSTAMP', ['DTSTAMP:20260812T080000'], 'INVALID_METADATA'],
		['TZID DTSTAMP', ['DTSTAMP;TZID=Etc/UTC:20260812T080000Z'], 'INVALID_METADATA'],
	] as const)('rejects %s before patch validation', (_label, metadata, code) => {
		const source = context(
			event('metadata', [...metadata, 'DTSTART:20260812T090000Z', 'DTEND:20260812T100000Z']),
		);
		expectPatchError(
			() => applyCalendarEventPatch(source, { unknown: true } as never, MODIFIED_AT),
			code,
		);
	});

	it('accepts existing leap-second metadata and validates modifiedAt only for effective patches', () => {
		const source = context(
			event('leap-metadata', [
				'DTSTAMP:20161231T235960Z',
				'LAST-MODIFIED;X-META=opaque:20161231T235960Z',
				'DTSTART:20260812T090000Z',
				'DTEND:20260812T100000Z',
				'SUMMARY:Original',
			]),
		);
		const output = applyCalendarEventPatch(
			source,
			{ summary: { kind: 'set', value: 'Changed' } },
			MODIFIED_AT,
		);
		expect(value(output, 'DTSTAMP')).toBe('20260814T101112Z');
		expect(property(master(output), 'LAST-MODIFIED')!.parameters).toHaveLength(1);
		expectPatchError(
			() =>
				applyCalendarEventPatch(
					source,
					{ summary: { kind: 'set', value: 'Changed' } },
					new Date('2026-08-14T10:11:12.001Z'),
				),
			'INVALID_DATE',
		);
	});
});

describe('canonical context hardening and golden preservation', () => {
	it('rejects mutable, accessor-based, hand-built, and inconsistent contexts without access', () => {
		const canonical = basicContext();
		const getter = vi.fn(() => canonical.resource);
		const accessor = Object.freeze(
			Object.defineProperty(
				{ master: canonical.master, exceptions: canonical.exceptions },
				'resource',
				{ enumerable: true, get: getter },
			),
		);
		const handBuilt = Object.freeze({
			resource: canonical.resource,
			master: canonical.master,
			exceptions: canonical.exceptions,
		});
		const mutable = { ...handBuilt };
		for (const candidate of [accessor, handBuilt, mutable]) {
			expectPatchError(
				() =>
					applyCalendarEventPatch(
						candidate as ReturnType<typeof basicContext>,
						{ summary: { kind: 'set', value: 'Changed' } },
						MODIFIED_AT,
					),
				'INVALID_CONTEXT',
			);
		}
		expect(getter).not.toHaveBeenCalled();
	});

	it('preserves VTIMEZONE, recurrence, ordered exceptions, VALARM, scheduling and unknown data', () => {
		const original = parse([
			'PRODID:-//Synthetic Golden//EN',
			'X-CALENDAR;X-PARAM="opaque,one":calendar',
			'BEGIN:VTIMEZONE',
			'TZID:Europe/Prague',
			'BEGIN:STANDARD',
			'DTSTART:19701025T030000',
			'TZOFFSETFROM:+0200',
			'TZOFFSETTO:+0100',
			'END:STANDARD',
			'END:VTIMEZONE',
			...event('golden', [
				'DTSTAMP:20260812T080000Z',
				'DTSTART;TZID=Europe/Prague:20260812T090000',
				'DURATION:PT1H',
				'RRULE:FREQ=WEEKLY;COUNT=3',
				'EXDATE;TZID=Europe/Prague:20260819T090000',
				'RDATE;TZID=Europe/Prague:20260820T090000',
				'SUMMARY;X-OPAQUE="one,two":Original',
				'ORGANIZER:mailto:owner@example.test',
				'ATTENDEE:mailto:guest@example.test',
				'SEQUENCE:7',
				'X-REPEATED:first',
				'X-REPEATED:second',
				'BEGIN:VALARM',
				'ACTION:DISPLAY',
				'TRIGGER:-PT15M',
				'DESCRIPTION:Reminder',
				'END:VALARM',
			]),
			...event('golden', [
				'RECURRENCE-ID;TZID=Europe/London:20260819T080000',
				'DTSTART;TZID=Europe/London:20260819T100000',
				'SUMMARY:Exception one',
			]),
			...event('golden', [
				'RECURRENCE-ID;TZID=Europe/Prague:20260826T090000',
				'DTSTART;TZID=Europe/Prague:20260826T110000',
				'SUMMARY:Exception two',
			]),
		]);
		const source = createCalendarEventPreservationContext(original);
		const untouchedCalendarEntries = original.calendar.entries.filter(
			(entry) => entry !== source.master,
		);
		const output = applyCalendarEventPatch(
			source,
			{ summary: { kind: 'set', value: 'Changed\nsummary' } },
			MODIFIED_AT,
		);
		const serialized = serializeICalendarResource(output);
		const reparsed = parseICalendarResource(encoder.encode(serialized));

		expect(value(output, 'SUMMARY')).toBe('Changed\nsummary');
		expect(output.calendar.entries.filter((entry) => entry !== master(output))).toEqual(
			untouchedCalendarEntries,
		);
		expect(source.exceptions).toHaveLength(2);
		expect(serialized).toContain('SEQUENCE:7\r\n');
		expect(serialized).toContain('X-REPEATED:first\r\nX-REPEATED:second\r\n');
		expect(serialized).toContain('BEGIN:VALARM\r\n');
		expect(reparsed.calendar.entries).toHaveLength(original.calendar.entries.length);
	});

	it('is synchronous, deterministic, pure, and leaves serializer failures typed', () => {
		const source = basicContext();
		const resourceSnapshot = JSON.stringify(source.resource);
		const patch = { summary: { kind: 'set' as const, value: 'Deterministic' } };
		const first = applyCalendarEventPatch(source, patch, MODIFIED_AT);
		const second = applyCalendarEventPatch(source, patch, MODIFIED_AT);
		expect(first).toEqual(second);
		expect(first).not.toBeInstanceOf(Promise);
		expect(JSON.stringify(source.resource)).toBe(resourceSnapshot);

		const malformed = {
			...first,
			calendar: { ...first.calendar, name: 'INVALID NAME' },
		} as ICalendarResource;
		expect(() => serializeICalendarResource(malformed)).toThrowError(CalDavICalendarSerializeError);
	});
});
