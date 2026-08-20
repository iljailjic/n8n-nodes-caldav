import { describe, expect, expectTypeOf, it } from 'vitest';

import {
	CalDavCalendarEventReadModelError,
	createCalendarEventPreservationContext,
	mapCalendarEventResource,
} from '../../nodes/CalDav/icalendar/eventReadModel';
import type {
	CalendarEvent,
	CalendarEventStatus,
	CalendarEventTransparency,
	UnsupportedCalendarEventMetadataToken,
} from '../../nodes/CalDav/icalendar/eventReadModel';
import {
	applyCalendarEventPatch,
	CalDavCalendarEventPatchError,
} from '../../nodes/CalDav/icalendar/patcher';
import type {
	CalendarEventPatch,
	CalendarEventPatchField,
	OptionalFieldPatch,
} from '../../nodes/CalDav/icalendar/patcher';
import { parseICalendarResource } from '../../nodes/CalDav/icalendar/parser';
import type {
	ICalendarComponent,
	ICalendarProperty,
	ICalendarResource,
} from '../../nodes/CalDav/icalendar/parser';
import {
	CalDavICalendarSerializeError,
	serializeBasicUtcEvent,
	serializeICalendarResource,
} from '../../nodes/CalDav/icalendar/serializer';
import type {
	BasicUtcEventSerializationField,
	BasicUtcEventSerializationInput,
} from '../../nodes/CalDav/icalendar/serializer';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';

const encoder = new TextEncoder();
const MODIFIED_AT = new Date('2040-01-03T04:05:06Z');
const CALENDAR_URL = validateAbsoluteHttpUrl('https://calendar.example.test/calendars/work/');
const RESOURCE_URL = validateAbsoluteHttpUrl(
	'https://calendar.example.test/calendars/work/metadata.ics',
);

function calendar(lines: readonly string[]): string {
	return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR', ''].join('\r\n');
}

function event(uid: string, lines: readonly string[]): readonly string[] {
	return ['BEGIN:VEVENT', `UID:${uid}`, ...lines, 'END:VEVENT'];
}

function basicEvent(extra: readonly string[] = []): readonly string[] {
	return event('metadata@example.test', [
		'DTSTAMP:20400101T000000Z',
		'DTSTART:20400102T100000Z',
		'DTEND:20400102T103000Z',
		'SUMMARY:Metadata oracle',
		...extra,
	]);
}

function parse(lines: readonly string[]): ICalendarResource {
	return parseICalendarResource(encoder.encode(calendar(lines)));
}

function map(lines: readonly string[]): CalendarEvent {
	return mapCalendarEventResource({
		calendarUrl: CALENDAR_URL,
		resourceUrl: RESOURCE_URL,
		resource: parse(lines),
	}).event;
}

function directProperties(
	component: ICalendarComponent,
	name: string,
): readonly ICalendarProperty[] {
	return component.entries.filter(
		(entry): entry is ICalendarProperty =>
			entry.kind === 'property' && entry.name.toUpperCase() === name,
	);
}

function master(resource: ICalendarResource): ICalendarComponent {
	return resource.calendar.entries.find(
		(entry): entry is ICalendarComponent =>
			entry.kind === 'component' &&
			entry.name.toUpperCase() === 'VEVENT' &&
			directProperties(entry, 'RECURRENCE-ID').length === 0,
	)!;
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

function basicInput(
	overrides: Partial<BasicUtcEventSerializationInput> = {},
): BasicUtcEventSerializationInput {
	return {
		uid: 'metadata@example.test',
		dtstamp: new Date('2040-01-01T00:00:00Z'),
		start: new Date('2040-01-02T10:00:00Z'),
		end: new Date('2040-01-02T10:30:00Z'),
		summary: 'Metadata oracle',
		...overrides,
	};
}

describe('extended VEVENT metadata public types', () => {
	it('adds immutable supported/unsupported projection types and authored input fields', () => {
		expectTypeOf<CalendarEventStatus>().toEqualTypeOf<'tentative' | 'confirmed' | 'cancelled'>();
		expectTypeOf<CalendarEventTransparency>().toEqualTypeOf<'opaque' | 'transparent'>();
		expectTypeOf<UnsupportedCalendarEventMetadataToken>().toEqualTypeOf<{
			readonly kind: 'unsupported';
			readonly token: string;
		}>();
		expectTypeOf<CalendarEvent['categories']>().toEqualTypeOf<readonly string[] | undefined>();
		expectTypeOf<CalendarEvent['status']>().toEqualTypeOf<
			CalendarEventStatus | UnsupportedCalendarEventMetadataToken | undefined
		>();
		expectTypeOf<CalendarEvent['transparency']>().toEqualTypeOf<
			CalendarEventTransparency | UnsupportedCalendarEventMetadataToken | undefined
		>();
		expectTypeOf<BasicUtcEventSerializationInput['categories']>().toEqualTypeOf<
			readonly string[] | undefined
		>();
		expectTypeOf<BasicUtcEventSerializationInput['status']>().toEqualTypeOf<
			CalendarEventStatus | undefined
		>();
		expectTypeOf<BasicUtcEventSerializationInput['transparency']>().toEqualTypeOf<
			CalendarEventTransparency | undefined
		>();
		expectTypeOf<CalendarEventPatch['categories']>().toEqualTypeOf<
			OptionalFieldPatch<readonly string[]> | undefined
		>();
		expectTypeOf<CalendarEventPatch['status']>().toEqualTypeOf<
			OptionalFieldPatch<CalendarEventStatus> | undefined
		>();
		expectTypeOf<CalendarEventPatch['transparency']>().toEqualTypeOf<
			OptionalFieldPatch<CalendarEventTransparency> | undefined
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
		>();
		expectTypeOf<BasicUtcEventSerializationField>().toEqualTypeOf<
			| 'uid'
			| 'dtstamp'
			| 'timeMode'
			| 'start'
			| 'end'
			| 'startDate'
			| 'endDate'
			| 'summary'
			| 'description'
			| 'location'
			| 'url'
			| 'categories'
			| 'status'
			| 'transparency'
		>();
	});
});

describe('extended VEVENT metadata read projection', () => {
	it('flattens decoded Categories in encounter order with exact first-wins deduplication', () => {
		const result = map(
			basicEvent([
				'CATEGORIES:Alpha,with\\,comma,semi\\;colon,path\\\\name,line\\nnext,, Alpha,alpha',
				'CATEGORIES:Alpha,with\\,comma,  ,alpha',
			]),
		);

		expect(result.categories).toEqual([
			'Alpha',
			'with,comma',
			'semi;colon',
			'path\\name',
			'line\nnext',
			' Alpha',
			'alpha',
			'  ',
		]);
		expect(Object.isFrozen(result.categories)).toBe(true);
	});

	it('omits Categories when every decoded value is empty and ignores exception metadata', () => {
		const onlyEmpty = map(basicEvent(['CATEGORIES:,', 'CATEGORIES:']));
		expect(onlyEmpty).not.toHaveProperty('categories');

		const masterOnly = map([
			...basicEvent(),
			...event('metadata@example.test', [
				'RECURRENCE-ID:20400109T100000Z',
				'DTSTAMP:20400101T000000Z',
				'DTSTART:20400109T100000Z',
				'DTEND:20400109T103000Z',
				'CATEGORIES:Exception only',
				'STATUS:CANCELLED',
				'TRANSP:TRANSPARENT',
			]),
		]);
		expect(masterOnly).not.toHaveProperty('categories');
		expect(masterOnly).not.toHaveProperty('status');
		expect(masterOnly).not.toHaveProperty('transparency');
	});

	it.each([
		['STATUS', 'tentative', 'tentative'],
		['STATUS', 'CONFIRMED', 'confirmed'],
		['STATUS', 'CanCeLLeD', 'cancelled'],
		['TRANSP', 'opaque', 'opaque'],
		['TRANSP', 'TRANSPARENT', 'transparent'],
	] as const)('projects supported %s token %s to lowercase', (name, token, expected) => {
		const result = map(basicEvent([`${name}:${token}`]));
		expect(result[name === 'STATUS' ? 'status' : 'transparency']).toBe(expected);
	});

	it('projects one unsupported singleton token exactly and never trims it', () => {
		const result = map(basicEvent(['STATUS;X-SOURCE=MiXeD: X-VENDOR ', 'TRANSP:X-PRIVATE']));
		expect(result.status).toEqual({ kind: 'unsupported', token: ' X-VENDOR ' });
		expect(result.transparency).toEqual({ kind: 'unsupported', token: 'X-PRIVATE' });
		expect(Object.isFrozen(result.status)).toBe(true);
		expect(Object.isFrozen(result.transparency)).toBe(true);
	});

	it.each(['STATUS', 'TRANSP'] as const)(
		'rejects duplicate %s as ambiguous even when tokens are identical',
		(name) => {
			expect(() => map(basicEvent([`${name}:OPAQUE`, `${name}:OPAQUE`]))).toThrowError(
				expect.objectContaining({
					name: 'CalDavCalendarEventReadModelError',
					code: 'AMBIGUOUS_EVENT_PROPERTY',
				}),
			);
		},
	);

	it.each([
		['STATUS', 'STATUS;VALUE=URI:urn:example:invalid'],
		['STATUS', 'STATUS:one,two'],
		['STATUS', 'STATUS:'],
		['TRANSP', 'TRANSP;VALUE=URI:urn:example:invalid'],
		['TRANSP', 'TRANSP:one,two'],
		['TRANSP', 'TRANSP:'],
	] as const)('rejects invalid %s read shape', (_name, line) => {
		expect(() => map(basicEvent([line]))).toThrowError(
			expect.objectContaining({
				name: 'CalDavCalendarEventReadModelError',
				code: 'INVALID_EVENT_PROPERTY',
			}),
		);
	});
});

describe('extended VEVENT metadata authoring', () => {
	it('serializes one escaped, de-duplicated Categories property and uppercase enum tokens', () => {
		const output = serializeBasicUtcEvent(
			basicInput({
				categories: [
					'Alpha',
					'with,comma',
					'semi;colon',
					'path\\name',
					'line\nnext',
					'Alpha',
					'alpha',
					'  ',
				],
				status: 'cancelled',
				transparency: 'transparent',
			}),
		);
		const lines = unfold(output);
		expect(lines.filter((line) => line.startsWith('CATEGORIES'))).toEqual([
			'CATEGORIES:Alpha,with\\,comma,semi\\;colon,path\\\\name,line\\nnext,alpha,  ',
		]);
		expect(lines).toContain('STATUS:CANCELLED');
		expect(lines).toContain('TRANSP:TRANSPARENT');
		const readBack = mapCalendarEventResource({
			calendarUrl: CALENDAR_URL,
			resourceUrl: RESOURCE_URL,
			resource: parseICalendarResource(encoder.encode(output)),
		}).event;
		expect(readBack).toMatchObject({
			categories: ['Alpha', 'with,comma', 'semi;colon', 'path\\name', 'line\nnext', 'alpha', '  '],
			status: 'cancelled',
			transparency: 'transparent',
		});
	});

	it.each([
		['tentative', 'TENTATIVE'],
		['confirmed', 'CONFIRMED'],
		['cancelled', 'CANCELLED'],
	] as const)('serializes supported status %s as %s', (status, wire) => {
		expect(unfold(serializeBasicUtcEvent(basicInput({ status })))).toContain(`STATUS:${wire}`);
	});

	it.each([
		['opaque', 'OPAQUE'],
		['transparent', 'TRANSPARENT'],
	] as const)('serializes supported transparency %s as %s', (transparency, wire) => {
		expect(unfold(serializeBasicUtcEvent(basicInput({ transparency })))).toContain(
			`TRANSP:${wire}`,
		);
	});

	it('omits all three metadata properties when inputs are omitted', () => {
		const lines = unfold(serializeBasicUtcEvent(basicInput()));
		expect(lines.some((line) => /^(?:CATEGORIES|STATUS|TRANSP)[;:]/u.test(line))).toBe(false);
	});

	it.each([
		['empty categories', { categories: [] }, 'INVALID_TEXT', 'categories'],
		['empty category', { categories: ['valid', ''] }, 'INVALID_TEXT', 'categories'],
		['invalid category TEXT', { categories: ['private\rvalue'] }, 'INVALID_TEXT', 'categories'],
		['non-array categories', { categories: 'one,two' }, 'INVALID_INPUT', 'categories'],
		['uppercase status', { status: 'CONFIRMED' }, 'INVALID_INPUT', 'status'],
		['unsupported status', { status: 'X-VENDOR' }, 'INVALID_INPUT', 'status'],
		['uppercase transparency', { transparency: 'OPAQUE' }, 'INVALID_INPUT', 'transparency'],
		['unsupported transparency', { transparency: 'X-VENDOR' }, 'INVALID_INPUT', 'transparency'],
	] as const)('rejects %s with a typed field-safe failure', (_label, metadata, code, field) => {
		try {
			serializeBasicUtcEvent(basicInput(metadata as Partial<BasicUtcEventSerializationInput>));
			expect.unreachable('Expected metadata serialization to fail');
		} catch (error) {
			expect(error).toBeInstanceOf(CalDavICalendarSerializeError);
			expect(error).toMatchObject({ code, field });
			expect(String(error)).not.toMatch(/private|one,two|X-VENDOR/);
		}
	});
});

describe('extended VEVENT metadata preservation-aware patching', () => {
	it('preserves omitted metadata spelling, repetition, parameters, and unsupported tokens', () => {
		const source = parse(
			basicEvent([
				'categories;X-SOURCE=legacy:one,two',
				'CATEGORIES;X-SECOND=MiXeD:three',
				'status;X-STATE=MiXeD:X-VENDOR',
				'transp;X-OPAQUE=keep:OPAQUE',
				'X-UNKNOWN;X-PARAM=keep:opaque',
			]),
		);
		const context = createCalendarEventPreservationContext(source);
		const output = applyCalendarEventPatch(
			context,
			{ summary: { kind: 'set', value: 'Changed only summary' } },
			MODIFIED_AT,
		);
		const lines = unfold(serializeICalendarResource(output));
		expect(lines).toContain('categories;X-SOURCE=legacy:one,two');
		expect(lines).toContain('CATEGORIES;X-SECOND=MiXeD:three');
		expect(lines).toContain('status;X-STATE=MiXeD:X-VENDOR');
		expect(lines).toContain('transp;X-OPAQUE=keep:OPAQUE');
		expect(lines).toContain('X-UNKNOWN;X-PARAM=keep:opaque');
		expect(
			mapCalendarEventResource({
				calendarUrl: CALENDAR_URL,
				resourceUrl: RESOURCE_URL,
				resource: output,
			}).event.status,
		).toEqual({ kind: 'unsupported', token: 'X-VENDOR' });
	});

	it('Set replaces only the selected metadata name with one canonical property', () => {
		const context = createCalendarEventPreservationContext(
			parse(
				basicEvent([
					'CATEGORIES;X-OLD=one:old,duplicate',
					'CATEGORIES;X-OLD=two:duplicate',
					'STATUS;X-KEEP=yes:TENTATIVE',
					'TRANSP;X-KEEP=yes:OPAQUE',
				]),
			),
		);
		const output = applyCalendarEventPatch(
			context,
			{
				categories: { kind: 'set', value: ['new,one', 'new;two', 'new,one'] },
			},
			MODIFIED_AT,
		);
		const selected = directProperties(master(output), 'CATEGORIES');
		expect(selected).toHaveLength(1);
		expect(selected[0]).toMatchObject({
			parameters: [],
			value: { textValues: ['new,one', 'new;two'] },
		});
		expect(directProperties(master(output), 'STATUS')[0]).toMatchObject({
			parameters: [expect.objectContaining({ name: 'X-KEEP' })],
		});
		expect(directProperties(master(output), 'TRANSP')[0]).toMatchObject({
			parameters: [expect.objectContaining({ name: 'X-KEEP' })],
		});
	});

	it.each([
		['categories', 'CATEGORIES'],
		['status', 'STATUS'],
		['transparency', 'TRANSP'],
	] as const)('Remove deletes every direct %s property and nothing else', (field, propertyName) => {
		const context = createCalendarEventPreservationContext(
			parse(
				basicEvent([
					'CATEGORIES:first',
					'CATEGORIES:second',
					'STATUS:CONFIRMED',
					'TRANSP:TRANSPARENT',
				]),
			),
		);
		const output = applyCalendarEventPatch(
			context,
			{ [field]: { kind: 'remove' } } as CalendarEventPatch,
			MODIFIED_AT,
		);
		expect(directProperties(master(output), propertyName)).toHaveLength(0);
		for (const retained of ['UID', 'STATUS', 'TRANSP', 'CATEGORIES'].filter(
			(name) => name !== propertyName,
		)) {
			expect(directProperties(master(output), retained).length).toBeGreaterThan(0);
		}
	});

	it.each([
		['status', { status: { kind: 'set', value: 'confirmed' } }, 'STATUS', 'CONFIRMED'],
		[
			'transparency',
			{ transparency: { kind: 'set', value: 'transparent' } },
			'TRANSP',
			'TRANSPARENT',
		],
	] as const)(
		'Set canonicalizes authored %s without touching other metadata',
		(_field, patch, name, raw) => {
			const output = applyCalendarEventPatch(
				createCalendarEventPreservationContext(
					parse(basicEvent(['CATEGORIES;X-KEEP=yes:one', 'STATUS:TENTATIVE', 'TRANSP:OPAQUE'])),
				),
				patch,
				MODIFIED_AT,
			);
			expect(directProperties(master(output), name)).toEqual([
				expect.objectContaining({
					parameters: [],
					value: expect.objectContaining({ textValues: [raw] }),
				}),
			]);
			expect(directProperties(master(output), 'CATEGORIES')[0]).toMatchObject({
				parameters: [expect.objectContaining({ name: 'X-KEEP' })],
			});
		},
	);

	it.each([
		[
			'empty category list',
			{ categories: { kind: 'set', value: [] } },
			'INVALID_TEXT',
			'categories',
		],
		[
			'empty category entry',
			{ categories: { kind: 'set', value: ['valid', ''] } },
			'INVALID_TEXT',
			'categories',
		],
		[
			'uppercase status',
			{ status: { kind: 'set', value: 'CONFIRMED' } },
			'INVALID_INPUT',
			'status',
		],
		[
			'uppercase transparency',
			{ transparency: { kind: 'set', value: 'OPAQUE' } },
			'INVALID_INPUT',
			'transparency',
		],
	] as const)(
		'rejects %s without mutating the preservation context',
		(_label, patch, code, field) => {
			const context = createCalendarEventPreservationContext(
				parse(basicEvent(['STATUS:TENTATIVE'])),
			);
			const snapshot = JSON.stringify(context.resource);
			expect(() =>
				applyCalendarEventPatch(context, patch as CalendarEventPatch, MODIFIED_AT),
			).toThrowError(
				expect.objectContaining({
					name: 'CalDavCalendarEventPatchError',
					code,
					field,
				}),
			);
			expect(JSON.stringify(context.resource)).toBe(snapshot);
		},
	);

	it.each(['STATUS', 'TRANSP'] as const)(
		'rejects duplicate source %s before applying any metadata patch',
		(name) => {
			const context = createCalendarEventPreservationContext(
				parse(basicEvent([`${name}:OPAQUE`, `${name}:OPAQUE`])),
			);
			expect(() =>
				applyCalendarEventPatch(
					context,
					{ categories: { kind: 'set', value: ['safe'] } },
					MODIFIED_AT,
				),
			).toThrowError(
				expect.objectContaining({
					name: 'CalDavCalendarEventPatchError',
					code: 'AMBIGUOUS_PROPERTY',
				}),
			);
		},
	);

	it('keeps cancellation as metadata and never exposes a delete-like patch result', () => {
		const output = applyCalendarEventPatch(
			createCalendarEventPreservationContext(parse(basicEvent())),
			{ status: { kind: 'set', value: 'cancelled' } },
			MODIFIED_AT,
		);
		expect(unfold(serializeICalendarResource(output))).toContain('STATUS:CANCELLED');
		expect(output).not.toHaveProperty('action');
		expect(output).not.toHaveProperty('delete');
	});
});

it('uses sanitized typed errors without carrying the private token', () => {
	let error: unknown;
	try {
		map(basicEvent(['STATUS:private-token', 'STATUS:private-token']));
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(CalDavCalendarEventReadModelError);
	expect(error).toMatchObject({ code: 'AMBIGUOUS_EVENT_PROPERTY' });
	expect(String(error)).not.toContain('private-token');

	const patchError = new CalDavCalendarEventPatchError('AMBIGUOUS_PROPERTY', 'status');
	expect(String(patchError)).not.toContain('private-token');
});
