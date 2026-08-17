import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { mapCalendarEventResource } from '../../nodes/CalDav/icalendar/eventReadModel';
import {
	ICALENDAR_MAX_COMPONENTS,
	ICALENDAR_MAX_DEPTH,
	ICALENDAR_MAX_PROPERTIES,
	ICALENDAR_MAX_RESOURCE_BYTES,
	parseICalendarResource,
} from '../../nodes/CalDav/icalendar/parser';
import type {
	ICalendarComponent,
	ICalendarEntry,
	ICalendarParameter,
	ICalendarProperty,
	ICalendarResource,
} from '../../nodes/CalDav/icalendar/parser';
import * as serializerModule from '../../nodes/CalDav/icalendar/serializer';
import {
	CALDAV_ICALENDAR_PRODID,
	CalDavICalendarSerializeError,
	CalDavICalendarSerializeErrorCode,
	serializeBasicUtcEvent,
	serializeICalendarResource,
} from '../../nodes/CalDav/icalendar/serializer';
import type {
	BasicUtcEventSerializationField,
	BasicUtcEventSerializationInput,
	CalDavICalendarSerializeErrorCode as SerializeErrorCode,
} from '../../nodes/CalDav/icalendar/serializer';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';

const encoder = new TextEncoder();

function textProperty(
	name: string,
	textValues: readonly string[],
	parameters: readonly ICalendarParameter[] = [],
	raw = 'non-authoritative-private-text-sentinel',
): ICalendarProperty {
	return {
		kind: 'property',
		name,
		parameters,
		value: { kind: 'value', valueType: 'TEXT', raw, textValues },
	};
}

function rawProperty(
	name: string,
	valueType: string,
	raw: string,
	parameters: readonly ICalendarParameter[] = [],
): ICalendarProperty {
	return {
		kind: 'property',
		name,
		parameters,
		value: { kind: 'value', valueType, raw, textValues: null },
	};
}

function component(name: string, entries: readonly ICalendarEntry[]): ICalendarComponent {
	return { kind: 'component', name, entries };
}

function resource(entries: readonly ICalendarEntry[]): ICalendarResource {
	return {
		kind: 'resource',
		originalIcs: 'BEGIN:VCALENDAR\r\nX-PRIVATE:must-not-be-used\r\nEND:VCALENDAR\r\n',
		calendar: component('VCALENDAR', entries),
	};
}

function basicAst(eventEntries: readonly ICalendarEntry[] = []): ICalendarResource {
	return resource([
		textProperty('VERSION', ['2.0']),
		textProperty('PRODID', [CALDAV_ICALENDAR_PRODID]),
		component('VEVENT', [
			textProperty('UID', ['ast-oracle@example.test']),
			rawProperty('DTSTAMP', 'DATE-TIME', '20400101T000000Z'),
			rawProperty('DTSTART', 'DATE-TIME', '20400102T100000Z'),
			rawProperty('DTEND', 'DATE-TIME', '20400102T103000Z'),
			textProperty('SUMMARY', ['AST oracle']),
			...eventEntries,
		]),
	]);
}

function basicInput(
	overrides: Partial<BasicUtcEventSerializationInput> = {},
): BasicUtcEventSerializationInput {
	return {
		uid: 'event-33@example.test',
		dtstamp: new Date('2040-01-01T00:00:00.000Z'),
		start: new Date('2040-01-02T10:00:00.000Z'),
		end: new Date('2040-01-02T10:30:00.000Z'),
		summary: 'Contract oracle',
		...overrides,
	};
}

function unfold(ics: string): readonly string[] {
	return ics
		.slice(0, -2)
		.split('\r\n')
		.reduce<string[]>((lines, line) => {
			if (line.startsWith(' ') || line.startsWith('\t')) {
				lines[lines.length - 1] += line.slice(1);
			} else {
				lines.push(line);
			}
			return lines;
		}, []);
}

function thrownBy(operation: () => unknown): CalDavICalendarSerializeError {
	try {
		operation();
	} catch (error) {
		expect(error).toBeInstanceOf(CalDavICalendarSerializeError);
		return error as CalDavICalendarSerializeError;
	}
	throw new Error('Expected the serializer oracle operation to throw.');
}

function expectSerializeError(
	operation: () => unknown,
	code: SerializeErrorCode,
	field?: BasicUtcEventSerializationField,
): CalDavICalendarSerializeError {
	const error = thrownBy(operation);
	expect(error).toMatchObject({
		name: 'CalDavICalendarSerializeError',
		code,
		...(field === undefined ? {} : { field }),
	});
	if (field === undefined) expect(error.field).toBeUndefined();
	expect(error.message).toBeTypeOf('string');
	expect(error.message.length).toBeGreaterThan(0);
	expect((error as Error & { readonly cause?: unknown }).cause).toBeUndefined();
	return error;
}

function semanticComponent(componentValue: ICalendarComponent): unknown {
	return {
		name: componentValue.name,
		entries: componentValue.entries.map((entry) =>
			entry.kind === 'component'
				? semanticComponent(entry)
				: {
						name: entry.name,
						parameters: entry.parameters.map((parameter) => ({
							name: parameter.name,
							values: parameter.values.map(({ value }) => value),
						})),
						valueType: entry.value.valueType,
						value: entry.value.textValues === null ? entry.value.raw : [...entry.value.textValues],
					},
		),
	};
}

describe('iCalendar serializer public contract', () => {
	it('exports exactly the accepted runtime and compile-time surface', () => {
		expect(Object.keys(serializerModule).sort()).toEqual([
			'CALDAV_ICALENDAR_PRODID',
			'CalDavICalendarSerializeError',
			'CalDavICalendarSerializeErrorCode',
			'serializeBasicTimedEvent',
			'serializeBasicUtcEvent',
			'serializeICalendarResource',
		]);
		expect(CALDAV_ICALENDAR_PRODID).toBe('-//iljailjic//n8n-nodes-caldav//EN');
		expect(CalDavICalendarSerializeErrorCode).toEqual({
			INVALID_INPUT: 'INVALID_INPUT',
			MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
			INVALID_DATE: 'INVALID_DATE',
			INVALID_TIME_RANGE: 'INVALID_TIME_RANGE',
			INVALID_TEXT: 'INVALID_TEXT',
			INVALID_URI: 'INVALID_URI',
			RESOURCE_LIMIT_EXCEEDED: 'RESOURCE_LIMIT_EXCEEDED',
		});

		expectTypeOf<Parameters<typeof serializeBasicUtcEvent>>().toEqualTypeOf<
			[input: BasicUtcEventSerializationInput]
		>();
		expectTypeOf<ReturnType<typeof serializeBasicUtcEvent>>().toEqualTypeOf<string>();
		expectTypeOf<BasicUtcEventSerializationInput>().toEqualTypeOf<{
			readonly uid: string;
			readonly dtstamp: Date;
			readonly start: Date;
			readonly end: Date;
			readonly summary: string;
			readonly description?: string;
			readonly location?: string;
			readonly url?: string;
		}>();
		expectTypeOf<Parameters<typeof serializeICalendarResource>>().toEqualTypeOf<
			[resource: ICalendarResource]
		>();
		expectTypeOf<ReturnType<typeof serializeICalendarResource>>().toEqualTypeOf<string>();
		expectTypeOf<BasicUtcEventSerializationField>().toEqualTypeOf<
			'uid' | 'dtstamp' | 'start' | 'end' | 'summary' | 'description' | 'location' | 'url'
		>();
		expectTypeOf<CalDavICalendarSerializeError['code']>().toEqualTypeOf<SerializeErrorCode>();
	});
});

describe('basic UTC VEVENT golden output', () => {
	it('emits the exact minimal order, UTC shape, CRLF, and final terminator', () => {
		const output = serializeBasicUtcEvent(basicInput());

		expect(output).toBe(
			[
				'BEGIN:VCALENDAR',
				'VERSION:2.0',
				'PRODID:-//iljailjic//n8n-nodes-caldav//EN',
				'BEGIN:VEVENT',
				'UID:event-33@example.test',
				'DTSTAMP:20400101T000000Z',
				'DTSTART:20400102T100000Z',
				'DTEND:20400102T103000Z',
				'SUMMARY:Contract oracle',
				'END:VEVENT',
				'END:VCALENDAR',
				'',
			].join('\r\n'),
		);
		expect(output).not.toMatch(
			/(^|\r\n)(?:CALSCALE|METHOD|TZID|RRULE|BEGIN:VTIMEZONE|BEGIN:VALARM|X-)/,
		);
		expect(output.replaceAll('\r\n', '')).not.toContain('\n');
	});

	it('emits supplied optionals in exact order and preserves allowed empty and whitespace values', () => {
		const output = serializeBasicUtcEvent(
			basicInput({
				uid: '  whitespace uid  ',
				summary: 'Planning, review; path\\name\nsecond line',
				description: '',
				location: ' \t ',
				url: 'CUSTOM+CAL:Opaque/%2f/../item?Port=443',
			}),
		);

		expect(unfold(output)).toEqual([
			'BEGIN:VCALENDAR',
			'VERSION:2.0',
			'PRODID:-//iljailjic//n8n-nodes-caldav//EN',
			'BEGIN:VEVENT',
			'UID:  whitespace uid  ',
			'DTSTAMP:20400101T000000Z',
			'DTSTART:20400102T100000Z',
			'DTEND:20400102T103000Z',
			'SUMMARY:Planning\\, review\\; path\\\\name\\nsecond line',
			'DESCRIPTION:',
			'LOCATION: \t ',
			'URL:CUSTOM+CAL:Opaque/%2f/../item?Port=443',
			'END:VEVENT',
			'END:VCALENDAR',
		]);
	});

	it.each(['', '   ', '\t'] as const)('preserves the allowed summary value %j', (summary) => {
		const output = serializeBasicUtcEvent(basicInput({ summary }));
		expect(unfold(output)).toContain(`SUMMARY:${summary}`);
	});

	it('accepts the inclusive four-digit UTC year boundaries without normalization', () => {
		const output = serializeBasicUtcEvent(
			basicInput({
				dtstamp: new Date('0001-01-01T00:00:00.000Z'),
				start: new Date('9999-12-31T23:59:58.000Z'),
				end: new Date('9999-12-31T23:59:59.000Z'),
			}),
		);

		expect(unfold(output)).toEqual(
			expect.arrayContaining([
				'DTSTAMP:00010101T000000Z',
				'DTSTART:99991231T235958Z',
				'DTEND:99991231T235959Z',
			]),
		);
	});

	it('folds Unicode by UTF-8 octets without corrupting or changing the logical value', () => {
		const summary = 'Résumé 🚀 東京 — '.repeat(24);
		const output = serializeBasicUtcEvent(basicInput({ summary }));
		const physicalLines = output.slice(0, -2).split('\r\n');
		const summaryIndex = physicalLines.findIndex((line) => line.startsWith('SUMMARY:'));
		const continuationLines = physicalLines
			.slice(summaryIndex + 1)
			.filter((line) => line.startsWith(' '));

		expect(summaryIndex).toBeGreaterThan(-1);
		expect(continuationLines.length).toBeGreaterThan(1);
		for (const line of physicalLines) {
			expect(encoder.encode(line).byteLength).toBeLessThanOrEqual(75);
		}
		expect(unfold(output)).toContain(`SUMMARY:${summary}`);
		expect(parseICalendarResource(encoder.encode(output)).calendar).toBeDefined();
	});

	it('is deterministic, snapshots without mutation, and produces no logs', () => {
		const input = basicInput({ description: 'immutable', location: 'desk' });
		const snapshot = {
			...input,
			dtstamp: input.dtstamp.getTime(),
			start: input.start.getTime(),
			end: input.end.getTime(),
		};
		Object.freeze(input);
		const logSpies = [
			vi.spyOn(console, 'log').mockImplementation(() => undefined),
			vi.spyOn(console, 'warn').mockImplementation(() => undefined),
			vi.spyOn(console, 'error').mockImplementation(() => undefined),
		];

		try {
			const first = serializeBasicUtcEvent(input);
			const second = serializeBasicUtcEvent(input);
			expect(second).toBe(first);
			expect({
				...input,
				dtstamp: input.dtstamp.getTime(),
				start: input.start.getTime(),
				end: input.end.getTime(),
			}).toEqual(snapshot);
			for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
		} finally {
			for (const spy of logSpies) spy.mockRestore();
		}
	});
});

describe('basic input validation and privacy', () => {
	it.each([
		['non-object input', null, 'INVALID_INPUT', undefined],
		['missing UID', {}, 'MISSING_REQUIRED_FIELD', 'uid'],
		['empty UID', { uid: '' }, 'MISSING_REQUIRED_FIELD', 'uid'],
		['wrong UID type', { uid: 7 }, 'INVALID_INPUT', 'uid'],
		['missing DTSTAMP', { uid: 'valid' }, 'MISSING_REQUIRED_FIELD', 'dtstamp'],
		['wrong DTSTAMP type', { uid: 'valid', dtstamp: '2040' }, 'INVALID_INPUT', 'dtstamp'],
		['invalid DTSTAMP', { uid: 'valid', dtstamp: new Date(Number.NaN) }, 'INVALID_DATE', 'dtstamp'],
		[
			'millisecond DTSTAMP',
			{ uid: 'valid', dtstamp: new Date('2040-01-01T00:00:00.001Z') },
			'INVALID_DATE',
			'dtstamp',
		],
		[
			'year zero DTSTAMP',
			{ uid: 'valid', dtstamp: new Date('0000-01-01T00:00:00.000Z') },
			'INVALID_DATE',
			'dtstamp',
		],
		[
			'year 10000 DTSTAMP',
			{ uid: 'valid', dtstamp: new Date('+010000-01-01T00:00:00.000Z') },
			'INVALID_DATE',
			'dtstamp',
		],
		[
			'missing start',
			{ uid: 'valid', dtstamp: new Date('2040-01-01T00:00:00Z') },
			'MISSING_REQUIRED_FIELD',
			'start',
		],
		['wrong start type', { ...basicInput(), start: 1 }, 'INVALID_INPUT', 'start'],
		['wrong end type', { ...basicInput(), end: {} }, 'INVALID_INPUT', 'end'],
		[
			'missing summary',
			{ ...basicInput(), summary: undefined },
			'MISSING_REQUIRED_FIELD',
			'summary',
		],
		['wrong summary type', { ...basicInput(), summary: 1 }, 'INVALID_INPUT', 'summary'],
		[
			'wrong description type',
			{ ...basicInput(), description: null },
			'INVALID_INPUT',
			'description',
		],
		['wrong location type', { ...basicInput(), location: false }, 'INVALID_INPUT', 'location'],
		['wrong URL type', { ...basicInput(), url: 1 }, 'INVALID_INPUT', 'url'],
	] as const)('rejects %s with stable metadata', (_name, input, code, field) => {
		expectSerializeError(
			() => serializeBasicUtcEvent(input as unknown as BasicUtcEventSerializationInput),
			code,
			field,
		);
	});

	it.each([
		['equal bounds', new Date('2040-01-02T10:00:00Z')],
		['reversed bounds', new Date('2040-01-02T09:59:59Z')],
	] as const)('rejects %s only after individual fields are valid', (_name, end) => {
		expectSerializeError(() => serializeBasicUtcEvent(basicInput({ end })), 'INVALID_TIME_RANGE');
	});

	it('uses the exact fail-fast precedence before time-range validation', () => {
		expectSerializeError(
			() =>
				serializeBasicUtcEvent(
					basicInput({
						description: undefined,
						location: '\rprivate-location',
						url: 'relative/private-url',
						end: new Date('2030-01-01T00:00:00Z'),
					}),
				),
			'INVALID_TEXT',
			'location',
		);
		expectSerializeError(
			() =>
				serializeBasicUtcEvent(
					basicInput({
						url: 'relative/private-url',
						end: new Date('2030-01-01T00:00:00Z'),
					}),
				),
			'INVALID_URI',
			'url',
		);
		expectSerializeError(
			() =>
				serializeBasicUtcEvent(
					basicInput({
						description: 'a'.repeat(ICALENDAR_MAX_RESOURCE_BYTES),
						end: new Date('2030-01-01T00:00:00Z'),
					}),
				),
			'INVALID_TIME_RANGE',
		);
	});

	it.each([
		['bare CR', 'private\rvalue'],
		['NUL', 'private\0value'],
		['forbidden control', 'private\u001fvalue'],
		['DEL', 'private\u007fvalue'],
		['unpaired high surrogate', 'private\ud800value'],
		['unpaired low surrogate', 'private\udfffvalue'],
		['physical-line injection', 'safe\r\nX-PRIVATE-INJECTED:true'],
	] as const)('rejects %s in every basic TEXT field', (_name, value) => {
		for (const field of ['uid', 'summary', 'description', 'location'] as const) {
			expectSerializeError(
				() => serializeBasicUtcEvent(basicInput({ [field]: value })),
				'INVALID_TEXT',
				field,
			);
		}
	});

	it('escapes semantic LF so it cannot inject a new content line', () => {
		const output = serializeBasicUtcEvent(basicInput({ summary: 'safe\nX-PRIVATE-INJECTED:true' }));

		expect(unfold(output)).toContain('SUMMARY:safe\\nX-PRIVATE-INJECTED:true');
		expect(unfold(output)).not.toContain('X-PRIVATE-INJECTED:true');
	});

	it.each([
		'mailto:user@example.test',
		'urn:example:calendar:event-33',
		'CUSTOM+CAL:Opaque/%2f/../item?Port=443',
		'https://EXAMPLE.test:443/a/../b?x=%2f',
	] as const)('preserves lexical absolute RFC 3986 URI %s', (url) => {
		const output = serializeBasicUtcEvent(basicInput({ url }));
		expect(unfold(output)).toContain(`URL:${url}`);
	});

	it.each([
		'relative/path',
		'/absolute-path-reference',
		'https://example.test/event#fragment',
		'https://example.test/has raw space',
		'https://example.test/%ZZ',
		'https://[::1',
		'https://example.test/private\nX-INJECTED:true',
	] as const)('rejects invalid or non-absolute URI %s', (url) => {
		expectSerializeError(() => serializeBasicUtcEvent(basicInput({ url })), 'INVALID_URI', 'url');
	});

	it('keeps messages stable within a category and excludes private caller content', () => {
		const firstSecret = 'PRIVATE-URI-CANARY-ONE';
		const secondSecret = 'PRIVATE-URI-CANARY-TWO';
		const first = expectSerializeError(
			() => serializeBasicUtcEvent(basicInput({ url: `relative/${firstSecret}` })),
			'INVALID_URI',
			'url',
		);
		const second = expectSerializeError(
			() => serializeBasicUtcEvent(basicInput({ url: `relative/${secondSecret}` })),
			'INVALID_URI',
			'url',
		);

		expect(second.message).toBe(first.message);
		for (const error of [first, second]) {
			expect(error.message).not.toContain(firstSecret);
			expect(error.message).not.toContain(secondSecret);
			expect(JSON.stringify(error)).not.toContain('PRIVATE-URI-CANARY');
		}
	});
});

describe('parser and read-model round trip', () => {
	it('reproduces every supported basic field and UTC bound', () => {
		const calendarUrl = validateAbsoluteHttpUrl('https://calendar.example.test/home/events/');
		const resourceUrl = validateAbsoluteHttpUrl(
			'https://calendar.example.test/home/events/event-33.ics',
		);
		const output = serializeBasicUtcEvent(
			basicInput({
				summary: 'Résumé, planning; \ud83d\ude80\nline two',
				description: '',
				location: '\tRoom \\ A',
				url: 'urn:example:calendar:event-33',
			}),
		);
		const parsed = parseICalendarResource(encoder.encode(output));
		const result = mapCalendarEventResource({ calendarUrl, resourceUrl, resource: parsed });

		expect(result.event).toEqual({
			calendarUrl,
			resourceUrl,
			uid: 'event-33@example.test',
			summary: 'Résumé, planning; 🚀\nline two',
			description: '',
			location: '\tRoom \\ A',
			url: 'urn:example:calendar:event-33',
			timeMode: 'timed',
			accessMode: 'editable',
			start: '2040-01-02T10:00:00Z',
			end: '2040-01-02T10:30:00Z',
			timeZoneMode: 'utc',
			startLocal: '2040-01-02T10:00:00',
			endLocal: '2040-01-02T10:30:00',
		});
		expect(result.context.resource).toBe(parsed);
	});
});

describe('general preservation-AST serialization', () => {
	it('regenerates RFC 6868 parameters and TEXT from semantic fields while raw helpers lose authority', () => {
		const parameters: readonly ICalendarParameter[] = [
			{
				kind: 'parameter',
				name: 'CN',
				values: [
					{
						kind: 'parameterValue',
						raw: 'PRIVATE-RAW-PARAMETER',
						value: 'Doe, John',
						quoted: false,
					},
				],
			},
			{
				kind: 'parameter',
				name: 'X-NOTE',
				values: [
					{
						kind: 'parameterValue',
						raw: 'PRIVATE-RAW-ENCODING',
						value: 'line\ncaret^quote"',
						quoted: true,
					},
				],
			},
			{
				kind: 'parameter',
				name: 'X-REPEATED',
				values: [
					{ kind: 'parameterValue', raw: 'ignored', value: 'one', quoted: true },
					{ kind: 'parameterValue', raw: 'ignored', value: 'two', quoted: true },
				],
			},
		];
		const input = basicAst([
			rawProperty('ATTENDEE', 'CAL-ADDRESS', 'mailto:user@example.test', parameters),
			textProperty('CATEGORIES', ['one,two', 'three;four'], [], 'PRIVATE-TEXT-RAW'),
			rawProperty('URL', 'URI', 'CUSTOM:Lexical/%2f/../value'),
		]);
		const before = structuredClone(input);
		const output = serializeICalendarResource(input);
		const lines = unfold(output);

		expect(lines).toContain(
			'ATTENDEE;CN="Doe, John";X-NOTE=line^ncaret^^quote^\';X-REPEATED=one,two:mailto:user@example.test',
		);
		expect(lines).toContain('CATEGORIES:one\\,two,three\\;four');
		expect(lines).toContain('URL:CUSTOM:Lexical/%2f/../value');
		expect(output).not.toContain('PRIVATE-');
		expect(input).toEqual(before);

		const reparsed = parseICalendarResource(encoder.encode(output));
		const event = reparsed.calendar.entries.find(
			(entry): entry is ICalendarComponent => entry.kind === 'component' && entry.name === 'VEVENT',
		)!;
		const attendee = event.entries.find(
			(entry): entry is ICalendarProperty => entry.kind === 'property' && entry.name === 'ATTENDEE',
		)!;
		expect(
			attendee.parameters.map(({ name, values }) => [name, values.map(({ value }) => value)]),
		).toEqual([
			['CN', ['Doe, John']],
			['X-NOTE', ['line\ncaret^quote"']],
			['X-REPEATED', ['one', 'two']],
		]);
	});

	it('round-trips parser-supported recurrence, exception, timezone, alarm, unknown, and source casing semantics', () => {
		const original = [
			'bEgIn:vCalendar',
			'version:2.0',
			'prodid:-//example.test//Preservation oracle//EN',
			'bEgIn:vTimezone',
			'tzid:Etc/UTC',
			'bEgIn:standard',
			'dtstart:19700101T000000',
			'tzoffsetfrom:+0000',
			'tzoffsetto:+0000',
			'eNd:standard',
			'eNd:vTimezone',
			'bEgIn:vEvent',
			'uid:preserved@example.test',
			'dtstamp:20400101T000000Z',
			'dtstart:20400102T100000Z',
			'dtend:20400102T103000Z',
			'rrule:FREQ=DAILY;COUNT=2',
			'x-unknown;X-P="a,b":opaque',
			'bEgIn:vAlarm',
			'action:DISPLAY',
			'trigger:-PT5M',
			'description:Reminder',
			'eNd:vAlarm',
			'eNd:vEvent',
			'bEgIn:vEvent',
			'uid:preserved@example.test',
			'recurrence-id:20400103T100000Z',
			'dtstamp:20400101T000000Z',
			'dtstart:20400103T110000Z',
			'dtend:20400103T113000Z',
			'eNd:vEvent',
			'eNd:vCalendar',
			'',
		].join('\r\n');
		const parsed = parseICalendarResource(encoder.encode(original));
		const output = serializeICalendarResource(parsed);
		const reparsed = parseICalendarResource(encoder.encode(output));

		expect(semanticComponent(reparsed.calendar)).toEqual(semanticComponent(parsed.calendar));
		expect(output).not.toBe(original);
		expect(output).toContain('BEGIN:vCalendar\r\n');
	});

	it.each([
		['invalid resource discriminant', () => ({ ...basicAst(), kind: 'wrong' })],
		[
			'invalid component discriminant',
			() => ({ ...basicAst(), calendar: { ...basicAst().calendar, kind: 'wrong' } }),
		],
		[
			'invalid component name',
			() => ({ ...basicAst(), calendar: { ...basicAst().calendar, name: 'VCALENDAR\r\nX' } }),
		],
		[
			'non-VCALENDAR root',
			() => ({ ...basicAst(), calendar: { ...basicAst().calendar, name: 'VEVENT' } }),
		],
		['missing VERSION', () => resource([component('VEVENT', [textProperty('UID', ['valid'])])])],
		[
			'duplicate VERSION',
			() =>
				resource([
					textProperty('VERSION', ['2.0']),
					textProperty('VERSION', ['2.0']),
					component('VEVENT', [textProperty('UID', ['valid'])]),
				]),
		],
		[
			'unsupported VERSION',
			() =>
				resource([
					textProperty('VERSION', ['1.0']),
					component('VEVENT', [textProperty('UID', ['valid'])]),
				]),
		],
		[
			'METHOD calendar object',
			() =>
				resource([
					textProperty('VERSION', ['2.0']),
					textProperty('METHOD', ['PUBLISH']),
					component('VEVENT', [textProperty('UID', ['valid'])]),
				]),
		],
		['missing UID', () => resource([textProperty('VERSION', ['2.0']), component('VEVENT', [])])],
		[
			'duplicate UID',
			() =>
				resource([
					textProperty('VERSION', ['2.0']),
					component('VEVENT', [textProperty('UID', ['one']), textProperty('UID', ['one'])]),
				]),
		],
		[
			'mixed component types',
			() =>
				resource([
					textProperty('VERSION', ['2.0']),
					component('VEVENT', [textProperty('UID', ['same'])]),
					component('VTODO', [textProperty('UID', ['same'])]),
				]),
		],
		[
			'invalid child nesting',
			() => basicAst([component('VEVENT', [textProperty('UID', ['nested'])])]),
		],
		[
			'property after child',
			() =>
				resource([
					textProperty('VERSION', ['2.0']),
					component('VEVENT', [
						textProperty('UID', ['valid']),
						component('VALARM', []),
						textProperty('SUMMARY', ['late']),
					]),
				]),
		],
		[
			'invalid property discriminant',
			() =>
				basicAst([
					{ ...textProperty('X-TEST', ['value']), kind: 'wrong' } as unknown as ICalendarEntry,
				]),
		],
		['empty TEXT semantic values', () => basicAst([textProperty('X-TEST', [])])],
		['TEXT with null semantic values', () => basicAst([rawProperty('X-TEST', 'TEXT', 'raw')])],
		[
			'non-TEXT with semantic values',
			() =>
				basicAst([
					{
						...rawProperty('URL', 'URI', 'urn:valid'),
						value: { kind: 'value', valueType: 'URI', raw: 'urn:valid', textValues: ['wrong'] },
					},
				]),
		],
		[
			'VALUE mismatch',
			() =>
				basicAst([
					textProperty(
						'X-TEST',
						['value'],
						[
							{
								kind: 'parameter',
								name: 'VALUE',
								values: [{ kind: 'parameterValue', raw: 'DATE', value: 'DATE', quoted: false }],
							},
						],
					),
				]),
		],
		[
			'invalid parameter discriminant',
			() =>
				basicAst([
					textProperty(
						'X-TEST',
						['value'],
						[
							{
								kind: 'wrong',
								name: 'X-PARAM',
								values: [],
							} as unknown as ICalendarParameter,
						],
					),
				]),
		],
		[
			'invalid parameter name',
			() =>
				basicAst([
					textProperty(
						'X-TEST',
						['value'],
						[{ kind: 'parameter', name: 'X-PARAM\r\nX-INJECTED', values: [] }],
					),
				]),
		],
	] as const)('rejects contradictory hand-built AST: %s', (_name, createInvalid) => {
		const invalid = createInvalid() as unknown as ICalendarResource;
		expectSerializeError(() => serializeICalendarResource(invalid), 'INVALID_INPUT');
	});
});

describe('shared inclusive serializer limits', () => {
	it('accepts exactly the component limit and rejects the first overflow', () => {
		const calendarEntries: ICalendarEntry[] = [
			textProperty('VERSION', ['2.0']),
			component('VEVENT', [textProperty('UID', ['component-limit'])]),
		];
		for (let index = 2; index < ICALENDAR_MAX_COMPONENTS; index += 1) {
			calendarEntries.push(component('VTIMEZONE', []));
		}

		const atLimit = resource(calendarEntries);
		const output = serializeICalendarResource(atLimit);
		const parsed = parseICalendarResource(encoder.encode(output));
		expect(parsed.calendar.entries.filter((entry) => entry.kind === 'component')).toHaveLength(
			ICALENDAR_MAX_COMPONENTS - 1,
		);

		calendarEntries.push(component('VTIMEZONE', []));
		expectSerializeError(
			() => serializeICalendarResource(resource(calendarEntries)),
			'RESOURCE_LIMIT_EXCEEDED',
		);
	});

	it('accepts exactly the property limit and rejects the first overflow', () => {
		const eventEntries: ICalendarEntry[] = [textProperty('UID', ['property-limit'])];
		for (let index = 2; index < ICALENDAR_MAX_PROPERTIES; index += 1) {
			eventEntries.push(textProperty('X-LIMIT', ['a']));
		}
		const atLimit = resource([textProperty('VERSION', ['2.0']), component('VEVENT', eventEntries)]);
		const output = serializeICalendarResource(atLimit);
		expect(parseICalendarResource(encoder.encode(output)).calendar).toBeDefined();

		eventEntries.push(textProperty('X-LIMIT', ['overflow']));
		expectSerializeError(
			() =>
				serializeICalendarResource(
					resource([textProperty('VERSION', ['2.0']), component('VEVENT', eventEntries)]),
				),
			'RESOURCE_LIMIT_EXCEEDED',
		);
	});

	it('accepts an exactly 5 MiB folded resource and rejects its first byte overflow', () => {
		// With the fixed 82-byte VCALENDAR envelope, X-BYTE plus 5,038,525 ASCII
		// value octets folds to exactly 5,242,880 bytes under RFC 5545's 75-octet rule.
		const exactValue = 'a'.repeat(5_038_525);
		const atLimit = resource([
			textProperty('VERSION', ['2.0']),
			component('VEVENT', [textProperty('UID', ['limit']), textProperty('X-BYTE', [exactValue])]),
		]);
		const output = serializeICalendarResource(atLimit);

		expect(encoder.encode(output)).toHaveLength(ICALENDAR_MAX_RESOURCE_BYTES);
		expect(parseICalendarResource(encoder.encode(output)).calendar).toBeDefined();
		expectSerializeError(
			() =>
				serializeICalendarResource(
					resource([
						textProperty('VERSION', ['2.0']),
						component('VEVENT', [
							textProperty('UID', ['limit']),
							textProperty('X-BYTE', [`${exactValue}a`]),
						]),
					]),
				),
			'RESOURCE_LIMIT_EXCEEDED',
		);
	});

	it('prioritizes shared depth overflow over nesting semantics for a deep hand-built AST', () => {
		// Parser-supported component relationships cannot reach the shared depth limit.
		// This intentionally invalid neutral shape reaches root-inclusive depth 65 and
		// verifies RESOURCE_LIMIT_EXCEEDED precedence before structural validation.
		let nested: ICalendarComponent = component(`X-DEPTH-${ICALENDAR_MAX_DEPTH}`, []);
		for (let depth = ICALENDAR_MAX_DEPTH - 1; depth >= 1; depth -= 1) {
			nested = component(`X-DEPTH-${depth}`, [nested]);
		}
		const depthOverflowBeforeStructuralValidation = resource([
			textProperty('VERSION', ['2.0']),
			nested,
		]);

		expectSerializeError(
			() => serializeICalendarResource(depthOverflowBeforeStructuralValidation),
			'RESOURCE_LIMIT_EXCEEDED',
		);
	});

	it('applies the final byte limit to the basic serializer without a field', () => {
		expectSerializeError(
			() =>
				serializeBasicUtcEvent(
					basicInput({ description: 'a'.repeat(ICALENDAR_MAX_RESOURCE_BYTES) }),
				),
			'RESOURCE_LIMIT_EXCEEDED',
		);
	});
});
