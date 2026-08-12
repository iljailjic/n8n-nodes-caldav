import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('n8n-workflow', () => {
	throw new Error('The transport-independent iCalendar parser must not import n8n-workflow');
});

import * as parserModule from '../../nodes/CalDav/icalendar/parser';
import {
	CalDavICalendarParseError,
	ICALENDAR_MAX_COMPONENTS,
	ICALENDAR_MAX_DEPTH,
	ICALENDAR_MAX_PROPERTIES,
	ICALENDAR_MAX_RESOURCE_BYTES,
	parseICalendarResource,
} from '../../nodes/CalDav/icalendar/parser';
import type {
	CalDavICalendarParseErrorCode,
	ICalendarComponent,
	ICalendarParameter,
	ICalendarProperty,
	ICalendarResource,
} from '../../nodes/CalDav/icalendar/parser';

const encoder = new TextEncoder();

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const ERROR_CASES = [
	['MAX_RESOURCE_SIZE_EXCEEDED', 'The iCalendar resource exceeds the 5 MiB size limit.'],
	['INVALID_UTF8', 'The iCalendar resource is not valid UTF-8.'],
	['INVALID_LINE_ENDING', 'The iCalendar resource contains an invalid line ending.'],
	['INVALID_LINE_FOLD', 'The iCalendar resource contains an invalid folded line.'],
	['INVALID_CONTENT_LINE', 'The iCalendar resource contains an invalid content line.'],
	['INVALID_PARAMETER', 'The iCalendar resource contains an invalid property parameter.'],
	['INVALID_TEXT_ESCAPE', 'The iCalendar resource contains an invalid TEXT escape.'],
	['INVALID_VALUE_TYPE', 'The iCalendar property contains an invalid VALUE parameter.'],
	['INVALID_ROOT_COMPONENT', 'The iCalendar resource must contain exactly one VCALENDAR object.'],
	['UNEXPECTED_COMPONENT_END', 'The iCalendar resource contains an unexpected component end.'],
	['MISMATCHED_COMPONENT_END', 'The iCalendar resource contains a mismatched component end.'],
	['TRUNCATED_COMPONENT', 'The iCalendar resource ended before all components were closed.'],
	['INVALID_COMPONENT_NESTING', 'The iCalendar resource contains invalid component nesting.'],
	['MISSING_VERSION', 'The VCALENDAR component is missing the required VERSION property.'],
	['DUPLICATE_VERSION', 'The VCALENDAR component contains more than one VERSION property.'],
	['UNSUPPORTED_VERSION', 'The VCALENDAR VERSION is not supported.'],
	['MISSING_CALENDAR_COMPONENT', 'The VCALENDAR component does not contain a calendar component.'],
	['METHOD_NOT_ALLOWED', 'A CalDAV calendar-object resource must not contain METHOD.'],
	[
		'MIXED_COMPONENT_TYPES',
		'A CalDAV calendar-object resource must not mix calendar component types.',
	],
	['MISSING_UID', 'A calendar component is missing the required UID property.'],
	['DUPLICATE_UID', 'A calendar component contains more than one UID property.'],
	['MISMATCHED_UID', 'Calendar components in one resource must have the same UID.'],
	['MAX_COMPONENT_COUNT_EXCEEDED', 'The iCalendar resource exceeds the maximum component count.'],
	['MAX_PROPERTY_COUNT_EXCEEDED', 'The iCalendar resource exceeds the maximum property count.'],
	['MAX_DEPTH_EXCEEDED', 'The iCalendar resource exceeds the maximum nesting depth.'],
] as const satisfies readonly (readonly [CalDavICalendarParseErrorCode, string])[];

function encode(value: string): Uint8Array {
	return encoder.encode(value);
}

function calendar(lines: readonly string[], lineEnding = '\r\n'): string {
	return ['BEGIN:VCALENDAR', ...lines, 'END:VCALENDAR', ''].join(lineEnding);
}

function event(uid: string, extraLines: readonly string[] = []): readonly string[] {
	return ['BEGIN:VEVENT', `UID:${uid}`, ...extraLines, 'END:VEVENT'];
}

function properties(component: ICalendarComponent): readonly ICalendarProperty[] {
	return component.entries.filter((entry): entry is ICalendarProperty => entry.kind === 'property');
}

function components(component: ICalendarComponent): readonly ICalendarComponent[] {
	return component.entries.filter(
		(entry): entry is ICalendarComponent => entry.kind === 'component',
	);
}

function property(component: ICalendarComponent, name: string): ICalendarProperty {
	const match = properties(component).find((entry) => entry.name === name);
	if (match === undefined) throw new Error(`Missing ${name} in synthetic test data`);
	return match;
}

function parameter(entry: ICalendarProperty, name: string): ICalendarParameter {
	const match = entry.parameters.find((candidate) => candidate.name === name);
	if (match === undefined) throw new Error(`Missing ${name} in synthetic test data`);
	return match;
}

function expectDeeplyFrozen(value: unknown, seen = new WeakSet<object>()): void {
	if (typeof value !== 'object' || value === null || seen.has(value)) return;
	seen.add(value);
	expect(Object.isFrozen(value)).toBe(true);
	for (const key of Reflect.ownKeys(value)) expectDeeplyFrozen(Reflect.get(value, key), seen);
}

function expectParseError(
	input: string | Uint8Array,
	code: CalDavICalendarParseErrorCode,
): CalDavICalendarParseError {
	try {
		parseICalendarResource(typeof input === 'string' ? encode(input) : input);
		expect.unreachable('Expected iCalendar parsing to fail');
	} catch (error) {
		expect(error).toBeInstanceOf(CalDavICalendarParseError);
		const parseError = error as CalDavICalendarParseError;
		expect(parseError).toMatchObject({
			name: 'CalDavICalendarParseError',
			code,
			message: ERROR_CASES.find(([candidate]) => candidate === code)?.[1],
		});
		return parseError;
	}
}

describe('iCalendar parser public contract', () => {
	it('exports only the accepted runtime surface and fixed inclusive limits', () => {
		expect(Object.keys(parserModule).sort()).toEqual([
			'CalDavICalendarParseError',
			'ICALENDAR_MAX_COMPONENTS',
			'ICALENDAR_MAX_DEPTH',
			'ICALENDAR_MAX_PROPERTIES',
			'ICALENDAR_MAX_RESOURCE_BYTES',
			'parseICalendarResource',
		]);
		expect({
			ICalendarMaxResourceBytes: ICALENDAR_MAX_RESOURCE_BYTES,
			ICalendarMaxComponents: ICALENDAR_MAX_COMPONENTS,
			ICalendarMaxProperties: ICALENDAR_MAX_PROPERTIES,
			ICalendarMaxDepth: ICALENDAR_MAX_DEPTH,
		}).toEqual({
			ICalendarMaxResourceBytes: 5_242_880,
			ICalendarMaxComponents: 100_000,
			ICalendarMaxProperties: 100_000,
			ICalendarMaxDepth: 64,
		});
	});

	it.each(ERROR_CASES)('constructs the fixed sanitized %s error', (code, message) => {
		const error = new CalDavICalendarParseError(code);
		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({ name: 'CalDavICalendarParseError', code, message });
		expect(
			Object.getOwnPropertyNames(error).every((name) =>
				['stack', 'message', 'name', 'code'].includes(name),
			),
		).toBe(true);
		expect(error).not.toHaveProperty('cause');
		expect(error).not.toHaveProperty('source');
		expect(error).not.toHaveProperty('line');
		expect(error).not.toHaveProperty('offset');
	});

	it('parses a minimal resource synchronously into the exact ordered AST shape', () => {
		const originalIcs = calendar([
			'VERSION:2.0',
			'PRODID:-//Synthetic Contract//EN',
			...event('event-1', ['SUMMARY:Planning']),
		]);
		const parsed: ICalendarResource = parseICalendarResource(encode(originalIcs));

		expect(parsed).toEqual({
			kind: 'resource',
			originalIcs,
			calendar: {
				kind: 'component',
				name: 'VCALENDAR',
				entries: [
					{
						kind: 'property',
						name: 'VERSION',
						parameters: [],
						value: { kind: 'value', valueType: 'TEXT', raw: '2.0', textValues: ['2.0'] },
					},
					{
						kind: 'property',
						name: 'PRODID',
						parameters: [],
						value: {
							kind: 'value',
							valueType: 'TEXT',
							raw: '-//Synthetic Contract//EN',
							textValues: ['-//Synthetic Contract//EN'],
						},
					},
					{
						kind: 'component',
						name: 'VEVENT',
						entries: [
							{
								kind: 'property',
								name: 'UID',
								parameters: [],
								value: {
									kind: 'value',
									valueType: 'TEXT',
									raw: 'event-1',
									textValues: ['event-1'],
								},
							},
							{
								kind: 'property',
								name: 'SUMMARY',
								parameters: [],
								value: {
									kind: 'value',
									valueType: 'TEXT',
									raw: 'Planning',
									textValues: ['Planning'],
								},
							},
						],
					},
				],
			},
		});
		expectDeeplyFrozen(parsed);
	});

	it('accepts Buffer structurally without mutating or retaining the input', () => {
		const originalIcs = calendar(['VERSION:2.0', ...event('buffer')]);
		const input = Buffer.from(originalIcs, 'utf8');
		const snapshot = Buffer.from(input);

		const parsed = parseICalendarResource(input);
		expect(input).toEqual(snapshot);
		input.fill(0);
		expect(parsed.originalIcs).toBe(originalIcs);
		expect(parsed).not.toHaveProperty('input');
		expect(parsed).not.toBeInstanceOf(Promise);
	});

	it('preserves source spelling while comparing structural names case-insensitively', () => {
		const originalIcs = [
			'BeGiN:vCaLeNdAr',
			'VeRsIoN:2.0',
			'BEGIN:vEvEnT',
			'uId:case-preserved',
			'sUmMaRy;X-CuStOm=One:Case',
			'EnD:VeVeNt',
			'eNd:VcAlEnDaR',
			'',
		].join('\r\n');

		const parsed = parseICalendarResource(encode(originalIcs));
		const parsedEvent = components(parsed.calendar)[0];
		expect(parsed.calendar.name).toBe('vCaLeNdAr');
		expect(properties(parsed.calendar)[0]?.name).toBe('VeRsIoN');
		expect(parsedEvent?.name).toBe('vEvEnT');
		expect(parsedEvent && properties(parsedEvent).map(({ name }) => name)).toEqual([
			'uId',
			'sUmMaRy',
		]);
		expect(parsedEvent && properties(parsedEvent)[1]?.parameters[0]?.name).toBe('X-CuStOm');
	});
});

describe('iCalendar lexical preservation and values', () => {
	it('accepts CRLF, LF, and mixed endings with equal semantic trees and exact originals', () => {
		const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', ...event('line-endings'), 'END:VCALENDAR'];
		const crlf = `${lines.join('\r\n')}\r\n`;
		const lf = `${lines.join('\n')}\n`;
		const mixed = `${lines.slice(0, 3).join('\r\n')}\r\n${lines.slice(3).join('\n')}\n`;

		const crlfParsed = parseICalendarResource(encode(crlf));
		const lfParsed = parseICalendarResource(encode(lf));
		const mixedParsed = parseICalendarResource(encode(mixed));
		expect(crlfParsed.calendar).toEqual(lfParsed.calendar);
		expect(lfParsed.calendar).toEqual(mixedParsed.calendar);
		expect([crlfParsed.originalIcs, lfParsed.originalIcs, mixedParsed.originalIcs]).toEqual([
			crlf,
			lf,
			mixed,
		]);
	});

	it('unfolds SPACE and HTAB by removing the newline and exactly one whitespace', () => {
		const originalIcs =
			'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:folded\r\n' +
			'DESCRIPTION:alpha\r\n  beta\r\n\tgamma\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
		const parsed = parseICalendarResource(encode(originalIcs));
		const description = property(components(parsed.calendar)[0]!, 'DESCRIPTION');

		expect(parsed.originalIcs).toBe(originalIcs);
		expect(description.value).toEqual({
			kind: 'value',
			valueType: 'TEXT',
			raw: 'alpha betagamma',
			textValues: ['alpha betagamma'],
		});
	});

	it('preserves quoted delimiters, repeated parameters, multi-values, and RFC 6868 decoding', () => {
		const attendeeLine =
			'ATTENDEE;MEMBER="mailto:a@example.test","mailto:b@example.test";' +
			'X-P="A:B;C,D";X-P=one,two;CN="A^nB^^C^\'D^x":mailto:c@example.test';
		const parsed = parseICalendarResource(
			encode(calendar(['VERSION:2.0', ...event('parameters', [attendeeLine])])),
		);
		const attendee = property(components(parsed.calendar)[0]!, 'ATTENDEE');

		expect(attendee.parameters.map(({ name }) => name)).toEqual(['MEMBER', 'X-P', 'X-P', 'CN']);
		expect(parameter(attendee, 'MEMBER').values).toEqual([
			{
				kind: 'parameterValue',
				raw: '"mailto:a@example.test"',
				value: 'mailto:a@example.test',
				quoted: true,
			},
			{
				kind: 'parameterValue',
				raw: '"mailto:b@example.test"',
				value: 'mailto:b@example.test',
				quoted: true,
			},
		]);
		expect(attendee.parameters[1]?.values).toEqual([
			{ kind: 'parameterValue', raw: '"A:B;C,D"', value: 'A:B;C,D', quoted: true },
		]);
		expect(attendee.parameters[2]?.values).toEqual([
			{ kind: 'parameterValue', raw: 'one', value: 'one', quoted: false },
			{ kind: 'parameterValue', raw: 'two', value: 'two', quoted: false },
		]);
		expect(attendee.parameters[3]?.values).toEqual([
			{
				kind: 'parameterValue',
				raw: '"A^nB^^C^\'D^x"',
				value: 'A\nB^C"D^x',
				quoted: true,
			},
		]);
		expect(attendee.value).toEqual({
			kind: 'value',
			valueType: 'CAL-ADDRESS',
			raw: 'mailto:c@example.test',
			textValues: null,
		});
	});

	it('decodes effective TEXT only and preserves Unicode, repetitions, and unknown content', () => {
		const parsed = parseICalendarResource(
			encode(
				calendar([
					'VERSION:2.0',
					...event('unicode', [
						'CATEGORIES:one\\,two,three\\;four,five\\\\six,line\\nnext\\Nupper',
						'DESCRIPTION:Žluťoučký kůň 😀; 東京',
						'SUMMARY:First',
						'SUMMARY:Second',
						'X-CUSTOM;X-UNKNOWN=alpha:literal&amp;value',
					]),
				]),
			),
		);
		const parsedEvent = components(parsed.calendar)[0]!;
		const categories = property(parsedEvent, 'CATEGORIES');

		expect(categories.value.raw).toBe('one\\,two,three\\;four,five\\\\six,line\\nnext\\Nupper');
		expect(categories.value.textValues).toEqual([
			'one,two',
			'three;four',
			'five\\six',
			'line\nnext\nupper',
		]);
		expect(property(parsedEvent, 'DESCRIPTION').value.textValues).toEqual([
			'Žluťoučký kůň 😀; 東京',
		]);
		expect(
			properties(parsedEvent)
				.filter(({ name }) => name === 'SUMMARY')
				.map(({ value }) => value.raw),
		).toEqual(['First', 'Second']);
		expect(property(parsedEvent, 'X-CUSTOM')).toMatchObject({
			parameters: [
				{
					name: 'X-UNKNOWN',
					values: [{ raw: 'alpha', value: 'alpha', quoted: false }],
				},
			],
			value: { valueType: 'TEXT', raw: 'literal&amp;value', textValues: ['literal&amp;value'] },
		});
	});

	it('applies explicit VALUE and recognized defaults without interpreting non-TEXT values', () => {
		const parsed = parseICalendarResource(
			encode(
				calendar([
					'VERSION:2.0',
					...event('types', [
						'DTSTART;VALUE=date:20260812',
						'DTEND:20260812T120000Z',
						'RRULE:FREQ=DAILY;COUNT=3',
						'URL:javascript:alert(1)',
						'SEQUENCE:42',
						'X-NUMBER;VALUE=integer:42',
						'IANA-PROPERTY:plain',
					]),
				]),
			),
		);
		const parsedEvent = components(parsed.calendar)[0]!;

		expect(property(parsedEvent, 'DTSTART').value).toMatchObject({
			valueType: 'DATE',
			raw: '20260812',
			textValues: null,
		});
		expect(parameter(property(parsedEvent, 'DTSTART'), 'VALUE').values[0]).toMatchObject({
			raw: 'date',
			value: 'date',
			quoted: false,
		});
		expect(property(parsedEvent, 'DTEND').value.valueType).toBe('DATE-TIME');
		expect(property(parsedEvent, 'RRULE').value.valueType).toBe('RECUR');
		expect(property(parsedEvent, 'URL').value).toMatchObject({
			valueType: 'URI',
			raw: 'javascript:alert(1)',
			textValues: null,
		});
		expect(property(parsedEvent, 'SEQUENCE').value.valueType).toBe('INTEGER');
		expect(property(parsedEvent, 'X-NUMBER').value).toMatchObject({
			valueType: 'INTEGER',
			raw: '42',
			textValues: null,
		});
		expect(property(parsedEvent, 'IANA-PROPERTY').value).toMatchObject({
			valueType: 'TEXT',
			textValues: ['plain'],
		});
	});

	it('does not apply TEXT escape validation to a non-TEXT raw value', () => {
		const parsed = parseICalendarResource(
			encode(calendar(['VERSION:2.0', ...event('uri', ['URL:https://example.test/\\q'])])),
		);
		expect(property(components(parsed.calendar)[0]!, 'URL').value).toEqual({
			kind: 'value',
			valueType: 'URI',
			raw: 'https://example.test/\\q',
			textValues: null,
		});
	});
});

describe('iCalendar components and recurrence preservation', () => {
	it('retains VTIMEZONE, STANDARD/DAYLIGHT, VALARM, recurrence, and exception order', () => {
		const parsed = parseICalendarResource(
			encode(
				calendar([
					'VERSION:2.0',
					'PRODID:-//Synthetic Recurrence//EN',
					'BEGIN:VTIMEZONE',
					'TZID:Europe/Prague',
					'BEGIN:STANDARD',
					'DTSTART:19701025T030000',
					'TZOFFSETFROM:+0200',
					'TZOFFSETTO:+0100',
					'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
					'END:STANDARD',
					'BEGIN:DAYLIGHT',
					'DTSTART:19700329T020000',
					'TZOFFSETFROM:+0100',
					'TZOFFSETTO:+0200',
					'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
					'END:DAYLIGHT',
					'END:VTIMEZONE',
					'BEGIN:VEVENT',
					'UID:recurring-1',
					'DTSTART;TZID=Europe/Prague:20260812T100000',
					'RRULE:FREQ=WEEKLY;COUNT=4',
					'EXDATE;TZID=Europe/Prague:20260819T100000',
					'RDATE;TZID=Europe/Prague:20260820T100000',
					'SUMMARY:Master',
					'BEGIN:VALARM',
					'ACTION:DISPLAY',
					'TRIGGER:-PT15M',
					'DESCRIPTION:Reminder',
					'END:VALARM',
					'END:VEVENT',
					'BEGIN:VEVENT',
					'UID:recurring-1',
					'RECURRENCE-ID;TZID=Europe/Prague:20260826T100000',
					'DTSTART;TZID=Europe/Prague:20260826T120000',
					'SUMMARY:Moved exception',
					'END:VEVENT',
				]),
			),
		);
		const [timezone, master, exception] = components(parsed.calendar);

		expect(components(parsed.calendar).map(({ name }) => name)).toEqual([
			'VTIMEZONE',
			'VEVENT',
			'VEVENT',
		]);
		expect(timezone?.entries.map(({ name }) => name)).toEqual(['TZID', 'STANDARD', 'DAYLIGHT']);
		expect(components(timezone!).map(({ name }) => name)).toEqual(['STANDARD', 'DAYLIGHT']);
		expect(master?.entries.map(({ name }) => name)).toEqual([
			'UID',
			'DTSTART',
			'RRULE',
			'EXDATE',
			'RDATE',
			'SUMMARY',
			'VALARM',
		]);
		expect(components(master!)[0]?.entries.map(({ name }) => name)).toEqual([
			'ACTION',
			'TRIGGER',
			'DESCRIPTION',
		]);
		expect(exception?.entries.map(({ name }) => name)).toEqual([
			'UID',
			'RECURRENCE-ID',
			'DTSTART',
			'SUMMARY',
		]);
		expect(property(master!, 'RRULE').value).toMatchObject({
			valueType: 'RECUR',
			raw: 'FREQ=WEEKLY;COUNT=4',
			textValues: null,
		});
	});

	it('preserves a homogeneous unknown IANA/X component and its properties', () => {
		const parsed = parseICalendarResource(
			encode(
				calendar([
					'VERSION:2.0',
					'BEGIN:X-SYNTHETIC',
					'X-A;X-ONE="a,b":one\\,two',
					'IANA-PROPERTY:value',
					'END:X-SYNTHETIC',
				]),
			),
		);
		const unknown = components(parsed.calendar)[0]!;

		expect(unknown).toMatchObject({ kind: 'component', name: 'X-SYNTHETIC' });
		expect(unknown.entries.map(({ name }) => name)).toEqual(['X-A', 'IANA-PROPERTY']);
		expect(property(unknown, 'X-A').value).toMatchObject({
			raw: 'one\\,two',
			textValues: ['one,two'],
		});
	});

	it.each([
		['VALARM directly below VCALENDAR', calendar(['VERSION:2.0', 'BEGIN:VALARM', 'END:VALARM'])],
		[
			'STANDARD below VEVENT',
			calendar([
				'VERSION:2.0',
				'BEGIN:VEVENT',
				'UID:nesting',
				'BEGIN:STANDARD',
				'END:STANDARD',
				'END:VEVENT',
			]),
		],
		[
			'an unknown child below an unknown component',
			calendar(['VERSION:2.0', 'BEGIN:X-PARENT', 'BEGIN:X-CHILD', 'END:X-CHILD', 'END:X-PARENT']),
		],
		[
			'a property after a child component',
			calendar([
				'VERSION:2.0',
				'BEGIN:VEVENT',
				'UID:nesting',
				'BEGIN:VALARM',
				'END:VALARM',
				'SUMMARY:too late',
				'END:VEVENT',
			]),
		],
		[
			'a nested VCALENDAR',
			calendar([
				'VERSION:2.0',
				'BEGIN:VCALENDAR',
				'VERSION:2.0',
				...event('nested'),
				'END:VCALENDAR',
			]),
		],
	] as const)('rejects invalid nesting: %s', (_label, input) => {
		expectParseError(input, 'INVALID_COMPONENT_NESTING');
	});
});

describe('iCalendar lexical and structural validation', () => {
	it.each([
		['bare CR', calendar(['VERSION:2.0', ...event('cr')]).replaceAll('\r\n', '\r')],
		['missing final terminator', calendar(['VERSION:2.0', ...event('final')]).slice(0, -2)],
	] as const)('rejects invalid line endings: %s', (_label, input) => {
		expectParseError(input, 'INVALID_LINE_ENDING');
	});

	it.each([
		[' SPACE', ' BEGIN:VCALENDAR\r\n'],
		['HTAB', '\tBEGIN:VCALENDAR\r\n'],
	] as const)('rejects a leading %s continuation', (_label, input) => {
		expectParseError(input, 'INVALID_LINE_FOLD');
	});

	it.each([
		['missing colon', calendar(['VERSION:2.0', ...event('content', ['SUMMARY'])])],
		['empty name', calendar(['VERSION:2.0', ...event('content', [':value'])])],
		['non-ASCII-name grammar', calendar(['VERSION:2.0', ...event('content', ['X_NAME:value'])])],
		['blank physical line', calendar(['VERSION:2.0', ...event('content', [''])])],
	] as const)('rejects an invalid content line: %s', (_label, input) => {
		expectParseError(input, 'INVALID_CONTENT_LINE');
	});

	it.each([
		['missing equals', 'ATTENDEE;CN:mailto:a@example.test'],
		['empty parameter name', 'ATTENDEE;=value:mailto:a@example.test'],
		['unterminated quote', 'ATTENDEE;CN="private:mailto:a@example.test'],
		['raw quote', 'ATTENDEE;CN=a"b:mailto:a@example.test'],
		['characters after quote', 'ATTENDEE;CN="a"b:mailto:a@example.test'],
		['forbidden control', 'ATTENDEE;CN="a\tb":mailto:a@example.test'],
	] as const)('rejects an invalid parameter: %s', (_label, line) => {
		expectParseError(
			calendar(['VERSION:2.0', ...event('parameter-validation', [line])]),
			'INVALID_PARAMETER',
		);
	});

	it.each([
		['unknown escape', 'DESCRIPTION:private\\qvalue'],
		['escaped colon', 'DESCRIPTION:private\\:value'],
		['trailing escape', 'DESCRIPTION:private\\'],
	] as const)('rejects invalid TEXT escaping: %s', (_label, line) => {
		expectParseError(
			calendar(['VERSION:2.0', ...event('text-validation', [line])]),
			'INVALID_TEXT_ESCAPE',
		);
	});

	it.each([
		['duplicate VALUE', 'SUMMARY;VALUE=TEXT;value=TEXT:x'],
		['multi-valued VALUE', 'SUMMARY;VALUE=TEXT,TEXT:x'],
		['empty VALUE', 'SUMMARY;VALUE=:x'],
	] as const)('rejects an invalid VALUE parameter: %s', (_label, line) => {
		expectParseError(
			calendar(['VERSION:2.0', ...event('value-validation', [line])]),
			'INVALID_VALUE_TYPE',
		);
	});

	it('uses the first colon outside a quoted parameter as the value delimiter', () => {
		const parsed = parseICalendarResource(
			encode(
				calendar([
					'VERSION:2.0',
					...event('delimiter', ['ATTENDEE;CN="A:B; C,D":mailto:user@example.test:8443/path']),
				]),
			),
		);
		const attendee = property(components(parsed.calendar)[0]!, 'ATTENDEE');
		expect(parameter(attendee, 'CN').values[0]?.value).toBe('A:B; C,D');
		expect(attendee.value.raw).toBe('mailto:user@example.test:8443/path');
	});

	it.each([
		['unexpected end', 'END:VCALENDAR\r\n', 'UNEXPECTED_COMPONENT_END'],
		[
			'mismatched end',
			'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\nEND:VTODO\r\nEND:VCALENDAR\r\n',
			'MISMATCHED_COMPONENT_END',
		],
		[
			'truncated component',
			'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT\r\n',
			'TRUNCATED_COMPONENT',
		],
	] as const)('classifies delimiter/closure failure: %s', (_label, input, code) => {
		expectParseError(input, code);
	});

	it.each([
		['no VCALENDAR', 'X-PROPERTY:value\r\n'],
		[
			'material before VCALENDAR',
			`X-BEFORE:value\r\n${calendar(['VERSION:2.0', ...event('root')])}`,
		],
		['material after VCALENDAR', `${calendar(['VERSION:2.0', ...event('root')])}X-AFTER:value\r\n`],
		[
			'multiple VCALENDAR roots',
			calendar(['VERSION:2.0', ...event('one')]) + calendar(['VERSION:2.0', ...event('two')]),
		],
	] as const)('requires exactly one outer VCALENDAR: %s', (_label, input) => {
		expectParseError(input, 'INVALID_ROOT_COMPONENT');
	});

	it.each([
		['missing VERSION', calendar(event('version')), 'MISSING_VERSION'],
		[
			'duplicate VERSION',
			calendar(['VERSION:2.0', 'version:2.0', ...event('version')]),
			'DUPLICATE_VERSION',
		],
		['unsupported VERSION', calendar(['VERSION:2.0 ', ...event('version')]), 'UNSUPPORTED_VERSION'],
		['no calendar component', calendar(['VERSION:2.0']), 'MISSING_CALENDAR_COMPONENT'],
		[
			'direct METHOD',
			calendar(['VERSION:2.0', 'METHOD:PUBLISH', ...event('method')]),
			'METHOD_NOT_ALLOWED',
		],
		[
			'mixed component types',
			calendar(['VERSION:2.0', ...event('mixed'), 'BEGIN:VTODO', 'UID:mixed', 'END:VTODO']),
			'MIXED_COMPONENT_TYPES',
		],
		[
			'missing UID',
			calendar(['VERSION:2.0', 'BEGIN:VEVENT', 'SUMMARY:none', 'END:VEVENT']),
			'MISSING_UID',
		],
		['empty UID', calendar(['VERSION:2.0', 'BEGIN:VEVENT', 'UID:', 'END:VEVENT']), 'MISSING_UID'],
		[
			'duplicate UID',
			calendar(['VERSION:2.0', 'BEGIN:VEVENT', 'UID:one', 'uid:one', 'END:VEVENT']),
			'DUPLICATE_UID',
		],
		[
			'different UID',
			calendar(['VERSION:2.0', ...event('Case'), ...event('case')]),
			'MISMATCHED_UID',
		],
	] as const)('enforces calendar-object constraint: %s', (_label, input, code) => {
		expectParseError(input, code);
	});

	it('accepts homogeneous case-insensitive component types with one decoded case-sensitive UID', () => {
		const input = [
			'BEGIN:VCALENDAR',
			'VERSION:2.0',
			'BEGIN:VEVENT',
			'UID:same\\,decoded',
			'END:VEVENT',
			'BEGIN:vevent',
			'uid:same\\,decoded',
			'RECURRENCE-ID:20260812T100000Z',
			'END:vevent',
			'END:VCALENDAR',
			'',
		].join('\r\n');
		const parsed = parseICalendarResource(encode(input));
		expect(components(parsed.calendar).map(({ name }) => name)).toEqual(['VEVENT', 'vevent']);
	});
});

describe('iCalendar defensive limits and precedence', () => {
	it('accepts exactly 5 MiB and rejects the next byte before decoding', () => {
		const prefix = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:size\r\nX-PAD:';
		const suffix = '\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
		const atLimit =
			prefix + 'p'.repeat(ICALENDAR_MAX_RESOURCE_BYTES - prefix.length - suffix.length) + suffix;

		expect(encode(atLimit)).toHaveLength(ICALENDAR_MAX_RESOURCE_BYTES);
		expect(parseICalendarResource(encode(atLimit)).originalIcs).toHaveLength(
			ICALENDAR_MAX_RESOURCE_BYTES,
		);
		const oversizedInvalidUtf8 = new Uint8Array(ICALENDAR_MAX_RESOURCE_BYTES + 1);
		oversizedInvalidUtf8.fill(0xff);
		expectParseError(oversizedInvalidUtf8, 'MAX_RESOURCE_SIZE_EXCEEDED');
	}, 30_000);

	it('accepts exactly 100,000 properties and rejects the next property', () => {
		const withPropertyCount = (count: number) =>
			calendar([
				'VERSION:2.0',
				'BEGIN:VEVENT',
				'UID:properties',
				...Array.from({ length: count - 2 }, () => 'X-P:1'),
				'END:VEVENT',
			]);

		expect(() =>
			parseICalendarResource(encode(withPropertyCount(ICALENDAR_MAX_PROPERTIES))),
		).not.toThrow();
		expectParseError(
			withPropertyCount(ICALENDAR_MAX_PROPERTIES + 1),
			'MAX_PROPERTY_COUNT_EXCEEDED',
		);
	}, 30_000);

	it('accepts exactly 100,000 components and rejects the next component', () => {
		const componentPair = ['BEGIN:X-UNIT', 'END:X-UNIT'] as const;
		const withComponentCount = (count: number) =>
			calendar(['VERSION:2.0', ...Array.from({ length: count - 1 }, () => componentPair).flat()]);

		expect(() =>
			parseICalendarResource(encode(withComponentCount(ICALENDAR_MAX_COMPONENTS))),
		).not.toThrow();
		expectParseError(
			withComponentCount(ICALENDAR_MAX_COMPONENTS + 1),
			'MAX_COMPONENT_COUNT_EXCEEDED',
		);
	}, 30_000);

	it('lets depth 64 reach nesting validation and rejects depth 65 at the bound', () => {
		const withDepth = (depth: number) =>
			calendar([
				'VERSION:2.0',
				...'BEGIN:X-NEST\r\n'
					.repeat(depth - 1)
					.trimEnd()
					.split('\r\n'),
				...'END:X-NEST\r\n'
					.repeat(depth - 1)
					.trimEnd()
					.split('\r\n'),
			]);

		expectParseError(withDepth(ICALENDAR_MAX_DEPTH), 'INVALID_COMPONENT_NESTING');
		expectParseError(withDepth(ICALENDAR_MAX_DEPTH + 1), 'MAX_DEPTH_EXCEEDED');
	});

	it('applies lexical/count failures before closure and semantic validation', () => {
		const invalidContentBeforeTruncation =
			'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\nBROKEN\r\n';
		expectParseError(invalidContentBeforeTruncation, 'INVALID_CONTENT_LINE');

		const tooManyPropertiesBeforeMismatch = calendar([
			'VERSION:2.0',
			'BEGIN:VEVENT',
			'UID:precedence',
			...Array.from({ length: ICALENDAR_MAX_PROPERTIES - 1 }, () => 'X-P:1'),
			'END:VTODO',
		]);
		expectParseError(tooManyPropertiesBeforeMismatch, 'MAX_PROPERTY_COUNT_EXCEEDED');
	}, 30_000);
});

describe('iCalendar security, UTF-8, and leakage behavior', () => {
	it.each([
		['overlong', new Uint8Array([0xc0, 0xaf])],
		['truncated', new Uint8Array([0xe2, 0x82])],
		['surrogate', new Uint8Array([0xed, 0xa0, 0x80])],
		['out of range', new Uint8Array([0xf4, 0x90, 0x80, 0x80])],
		['isolated continuation', new Uint8Array([0x80])],
	] as const)('rejects %s UTF-8 without replacement', (_label, input) => {
		expectParseError(input, 'INVALID_UTF8');
	});

	it('keeps declaration, entity, URI, shell, template, and JavaScript-looking data inert', () => {
		const fetchSpy = vi.fn().mockResolvedValue({} as Response);
		vi.stubGlobal('fetch', fetchSpy);
		const consoleSpies = [
			vi.spyOn(console, 'log').mockImplementation(() => undefined),
			vi.spyOn(console, 'error').mockImplementation(() => undefined),
			vi.spyOn(console, 'warn').mockImplementation(() => undefined),
		];
		const marker =
			'<!DOCTYPE private> &entity; $(touch private) {{constructor.constructor("return 1")()}}';
		const parsed = parseICalendarResource(
			encode(
				calendar([
					'VERSION:2.0',
					...event('inert', [`DESCRIPTION:${marker}`, 'URL:javascript:alert(1)']),
				]),
			),
		);
		const parsedEvent = components(parsed.calendar)[0]!;

		expect(property(parsedEvent, 'DESCRIPTION').value.raw).toBe(marker);
		expect(property(parsedEvent, 'URL').value.raw).toBe('javascript:alert(1)');
		expect(fetchSpy).not.toHaveBeenCalled();
		for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
	});

	it('returns deterministic fixed errors without leaking source data or logging', () => {
		const sentinel = 'PRIVATE-SENTINEL-9d98084f';
		const consoleSpies = [
			vi.spyOn(console, 'log').mockImplementation(() => undefined),
			vi.spyOn(console, 'error').mockImplementation(() => undefined),
			vi.spyOn(console, 'warn').mockImplementation(() => undefined),
			vi.spyOn(console, 'info').mockImplementation(() => undefined),
			vi.spyOn(console, 'debug').mockImplementation(() => undefined),
		];
		const invalid = calendar(['VERSION:2.0', ...event('leakage', [`DESCRIPTION:${sentinel}\\q`])]);
		const errors = Array.from({ length: 3 }, () =>
			expectParseError(invalid, 'INVALID_TEXT_ESCAPE'),
		);

		expect(errors.map(({ name, code, message }) => ({ name, code, message }))).toEqual([
			{
				name: 'CalDavICalendarParseError',
				code: 'INVALID_TEXT_ESCAPE',
				message: 'The iCalendar resource contains an invalid TEXT escape.',
			},
			{
				name: 'CalDavICalendarParseError',
				code: 'INVALID_TEXT_ESCAPE',
				message: 'The iCalendar resource contains an invalid TEXT escape.',
			},
			{
				name: 'CalDavICalendarParseError',
				code: 'INVALID_TEXT_ESCAPE',
				message: 'The iCalendar resource contains an invalid TEXT escape.',
			},
		]);
		for (const error of errors) {
			const exposed = `${error.message}\n${error.stack ?? ''}\n${JSON.stringify(error)}`;
			expect(exposed).not.toContain(sentinel);
			expect(error).not.toHaveProperty('cause');
			expect(error).not.toHaveProperty('source');
		}
		for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
	});
});
