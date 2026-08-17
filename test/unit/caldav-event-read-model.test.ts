import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('n8n-workflow', () => {
	throw new Error('The event read model must not import n8n-workflow');
});

vi.mock('../../nodes/CalDav/transport/http', () => {
	throw new Error('The event read model must not execute or import the CalDAV transport');
});

vi.mock('../../nodes/CalDav/xml/parser', () => {
	throw new Error('The event read model must not execute or import the XML parser');
});

import * as eventReadModelModule from '../../nodes/CalDav/icalendar/eventReadModel';
import {
	CalDavCalendarEventReadModelError,
	CalendarEventReadModelErrorCode,
	createCalendarEventPreservationContext,
	mapCalendarEventResource,
} from '../../nodes/CalDav/icalendar/eventReadModel';
import type {
	CalendarEvent,
	CalendarEventExtensions,
	CalendarEventExtensionValue,
	CalendarEventPreservationContext,
	CalendarEventReadModelErrorCode as CalendarEventReadModelErrorCodeType,
	CalendarEventReadResult,
	CalendarEventResourceInput,
	UtcDateTimeString,
} from '../../nodes/CalDav/icalendar/eventReadModel';
import {
	CalDavICalendarParseError,
	parseICalendarResource,
} from '../../nodes/CalDav/icalendar/parser';
import type {
	ICalendarComponent,
	ICalendarEntry,
	ICalendarProperty,
	ICalendarResource,
} from '../../nodes/CalDav/icalendar/parser';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';

const encoder = new TextEncoder();
const CALENDAR_URL = validateAbsoluteHttpUrl(
	'https://calendar.example.test/calendars/synthetic%2Fowner/events/?view=opaque',
);
const RESOURCE_URL = validateAbsoluteHttpUrl(
	'https://partition.example.test/calendars/synthetic%2Fowner/events/resource%2Eics?token=opaque',
);

const ERROR_CASES = [
	['NOT_VEVENT_RESOURCE', 'The calendar object resource does not contain a supported VEVENT set.'],
	['INVALID_EVENT_IDENTITY', 'The calendar object resource has invalid event identity.'],
	['MISSING_MASTER_EVENT', 'The calendar object resource does not contain a master VEVENT.'],
	['MULTIPLE_MASTER_EVENTS', 'The calendar object resource contains more than one master VEVENT.'],
	[
		'AMBIGUOUS_EVENT_PROPERTY',
		'The calendar object resource contains an ambiguous event property.',
	],
	['INVALID_EVENT_PROPERTY', 'The calendar object resource contains an invalid event property.'],
	[
		'UNSUPPORTED_EVENT_TIME',
		'The calendar object resource uses an unsupported event time representation.',
	],
	['INVALID_EVENT_TIME_RANGE', 'The event end must be later than the event start.'],
	['INVALID_EVENT_EXTENSIONS', 'The event provider extensions are invalid.'],
] as const satisfies readonly (readonly [CalendarEventReadModelErrorCodeType, string])[];

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function encode(value: string): Uint8Array {
	return encoder.encode(value);
}

function calendar(lines: readonly string[]): string {
	return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR', ''].join('\r\n');
}

function event(uid: string, extraLines: readonly string[] = []): readonly string[] {
	return ['BEGIN:VEVENT', `UID:${uid}`, ...extraLines, 'END:VEVENT'];
}

function parseEventResource(lines: readonly string[]): ICalendarResource {
	return parseICalendarResource(encode(calendar(lines)));
}

function inputFor(
	resource: ICalendarResource,
	overrides: Partial<Omit<CalendarEventResourceInput, 'resource'>> = {},
): CalendarEventResourceInput {
	return {
		calendarUrl: CALENDAR_URL,
		resourceUrl: RESOURCE_URL,
		resource,
		...overrides,
	};
}

function mapLines(
	lines: readonly string[],
	overrides: Partial<Omit<CalendarEventResourceInput, 'resource'>> = {},
): CalendarEventReadResult {
	return mapCalendarEventResource(inputFor(parseEventResource(lines), overrides));
}

function directComponents(component: ICalendarComponent): readonly ICalendarComponent[] {
	return component.entries.filter(
		(entry): entry is ICalendarComponent => entry.kind === 'component',
	);
}

function directProperties(component: ICalendarComponent): readonly ICalendarProperty[] {
	return component.entries.filter((entry): entry is ICalendarProperty => entry.kind === 'property');
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
	if (typeof value !== 'object' || value === null || seen.has(value)) return value;
	seen.add(value);
	for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key), seen);
	return Object.freeze(value);
}

function expectDeeplyFrozen(value: unknown, seen = new WeakSet<object>()): void {
	if (typeof value !== 'object' || value === null || seen.has(value)) return;
	seen.add(value);
	expect(Object.isFrozen(value)).toBe(true);
	for (const key of Reflect.ownKeys(value)) expectDeeplyFrozen(Reflect.get(value, key), seen);
}

function withCalendarEntries(
	resource: ICalendarResource,
	entries: readonly ICalendarEntry[],
): ICalendarResource {
	return deepFreeze({
		kind: 'resource' as const,
		originalIcs: resource.originalIcs,
		calendar: {
			kind: 'component' as const,
			name: resource.calendar.name,
			entries: [...entries],
		},
	});
}

function withComponentEntries(
	resource: ICalendarResource,
	component: ICalendarComponent,
	entries: readonly ICalendarEntry[],
): ICalendarResource {
	return withCalendarEntries(
		resource,
		resource.calendar.entries.map((entry) =>
			entry === component
				? {
						kind: 'component' as const,
						name: component.name,
						entries: [...entries],
					}
				: entry,
		),
	);
}

function syntheticProperty(
	name: string,
	valueType: string,
	raw: string,
	textValues: readonly string[] | null,
): ICalendarProperty {
	return deepFreeze({
		kind: 'property' as const,
		name,
		parameters: [],
		value: { kind: 'value' as const, valueType, raw, textValues },
	});
}

function expectMapError(
	resource: ICalendarResource,
	code: CalendarEventReadModelErrorCodeType,
	overrides: Partial<Omit<CalendarEventResourceInput, 'resource'>> = {},
): CalDavCalendarEventReadModelError {
	try {
		mapCalendarEventResource(inputFor(resource, overrides));
		expect.unreachable('Expected event read-model mapping to fail');
	} catch (error) {
		expect(error).toBeInstanceOf(CalDavCalendarEventReadModelError);
		const readError = error as CalDavCalendarEventReadModelError;
		expect(readError).toMatchObject({
			name: 'CalDavCalendarEventReadModelError',
			code,
			message: ERROR_CASES.find(([candidate]) => candidate === code)?.[1],
		});
		return readError;
	}
}

describe('event read-model public contract', () => {
	it('exports exactly the accepted runtime surface and error-code object', () => {
		expect(Object.keys(eventReadModelModule).sort()).toEqual([
			'CalDavCalendarEventReadModelError',
			'CalendarEventReadModelErrorCode',
			'createCalendarEventPreservationContext',
			'mapCalendarEventResource',
		]);
		expect(CalendarEventReadModelErrorCode).toEqual(
			Object.fromEntries(ERROR_CASES.map(([code]) => [code, code])),
		);
		expect(Object.isFrozen(CalendarEventReadModelErrorCode)).toBe(true);
	});

	it.each(ERROR_CASES)('constructs the fixed sanitized %s error', (code, message) => {
		const error = new CalDavCalendarEventReadModelError(code);
		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({ name: 'CalDavCalendarEventReadModelError', code, message });
		expect(
			Object.getOwnPropertyNames(error).every((name) =>
				['stack', 'message', 'name', 'code'].includes(name),
			),
		).toBe(true);
		expect(error).not.toHaveProperty('cause');
		expect(error).not.toHaveProperty('url');
		expect(error).not.toHaveProperty('uid');
		expect(error).not.toHaveProperty('etag');
		expect(error).not.toHaveProperty('resource');
		expect(error).not.toHaveProperty('line');
		expect(error).not.toHaveProperty('offset');
	});

	it('satisfies the accepted compile-time model while exposing only four runtime exports', () => {
		const result = mapLines(event('typed-contract', ['DTSTART:20260812T090000Z']));
		const eventModel: CalendarEvent = result.event;
		const context: CalendarEventPreservationContext = result.context;
		const start: UtcDateTimeString = eventModel.start;
		const extensionValue: CalendarEventExtensionValue = [null, true, 1, 'value', { nested: [] }];
		const extensions: CalendarEventExtensions = { synthetic: { extensionValue } };
		const typedResult: CalendarEventReadResult = { event: eventModel, context };

		expect({ start, extensions, typedResult }).toBeDefined();
	});
});

describe('preservation context identity factory', () => {
	it.each([
		['UTC', 'DTSTART:20260812T090000Z', 'RECURRENCE-ID:20260819T090000Z'],
		['DATE', 'DTSTART;VALUE=DATE:20260812', 'RECURRENCE-ID;VALUE=DATE:20260819'],
		['floating', 'DTSTART:20260812T090000', 'RECURRENCE-ID:20260819T090000'],
		[
			'local TZID with a distinct concrete exception TZID',
			'DTSTART;TZID=Europe/Prague:20260812T090000',
			'RECURRENCE-ID;TZID=Europe/London:20260819T080000',
		],
	] as const)('accepts a valid %s recurrence identity form', (_label, start, recurrenceId) => {
		const resource = parseEventResource([
			...event('factory-identity', [start, 'DURATION:PT1H']),
			...event('factory-identity', [recurrenceId, start]),
		]);
		const components = directComponents(resource.calendar);
		const context = createCalendarEventPreservationContext(resource);

		expect(context.resource).toBe(resource);
		expect(context.master).toBe(components[0]);
		expect(context.exceptions).toEqual([components[1]]);
		expectDeeplyFrozen(context);
	});

	it.each([
		[
			'incompatible DATE and DATE-TIME',
			'DTSTART;VALUE=DATE:20260812',
			'RECURRENCE-ID:20260819T090000Z',
			'INVALID_EVENT_PROPERTY',
		],
		[
			'incompatible UTC and floating',
			'DTSTART:20260812T090000Z',
			'RECURRENCE-ID:20260819T090000',
			'INVALID_EVENT_PROPERTY',
		],
		[
			'invalid exception date',
			'DTSTART;VALUE=DATE:20260812',
			'RECURRENCE-ID;VALUE=DATE:20260229',
			'INVALID_EVENT_PROPERTY',
		],
	] as const)('rejects %s', (_label, start, recurrenceId, code) => {
		const resource = parseEventResource([
			...event('factory-invalid', [start]),
			...event('factory-invalid', [recurrenceId, start]),
		]);
		expect(() => createCalendarEventPreservationContext(resource)).toThrowError(
			expect.objectContaining({ code }),
		);
	});

	it('rejects duplicate semantic recurrence identities', () => {
		const resource = parseEventResource([
			...event('factory-duplicate', ['DTSTART:20260812T090000Z']),
			...event('factory-duplicate', ['RECURRENCE-ID:20260819T090000Z', 'DTSTART:20260819T100000Z']),
			...event('factory-duplicate', ['RECURRENCE-ID:20260819T090000Z', 'DTSTART:20260819T110000Z']),
		]);
		expect(() => createCalendarEventPreservationContext(resource)).toThrowError(
			expect.objectContaining({ code: 'INVALID_EVENT_IDENTITY' }),
		);
	});
});

describe('event projection and preservation context', () => {
	it('maps a minimal parsed UTC master, defaults end to start, and omits absent optionals', () => {
		const resource = parseEventResource(event('minimal-uid', ['DTSTART:20260228T235959Z']));
		const master = directComponents(resource.calendar)[0]!;
		const result = mapCalendarEventResource(inputFor(resource));

		expect(result.event).toEqual({
			calendarUrl: CALENDAR_URL,
			resourceUrl: RESOURCE_URL,
			uid: 'minimal-uid',
			timeMode: 'timed',
			accessMode: 'editable',
			start: '2026-02-28T23:59:59Z',
			end: '2026-02-28T23:59:59Z',
		});
		expect(result.context).toEqual({ resource, master, exceptions: [] });
		expect(result.context.resource).toBe(resource);
		expect(result.context.master).toBe(master);
		expect(result.event).not.toHaveProperty('etag');
		expect(result.event).not.toHaveProperty('summary');
		expect(result.event).not.toHaveProperty('extensions');
		expect(result.event).not.toHaveProperty('id');
		expect(result).not.toBeInstanceOf(Promise);
		expectDeeplyFrozen(result);
	});

	it('maps all supported fields with decoded TEXT, exact URI, and an opaque weak ETag', () => {
		const etag = '  W/"opaque-tag"  ';
		const result = mapLines(
			event('opaque\\,uid', [
				'SUMMARY:Synthetic\\, planning',
				'DESCRIPTION:Line one\\nLine two',
				'LOCATION:Room\\; 42',
				'URL:https://events.example.test/raw%2Fpath?q=a,b;z',
				'DTSTART:20260812T090000Z',
				'DTEND:20260812T103045Z',
			]),
			{ etag },
		);

		expect(result.event).toEqual({
			calendarUrl: CALENDAR_URL,
			resourceUrl: RESOURCE_URL,
			etag,
			uid: 'opaque,uid',
			summary: 'Synthetic, planning',
			description: 'Line one\nLine two',
			location: 'Room; 42',
			url: 'https://events.example.test/raw%2Fpath?q=a,b;z',
			timeMode: 'timed',
			accessMode: 'editable',
			start: '2026-08-12T09:00:00Z',
			end: '2026-08-12T10:30:45Z',
		});
		expect(result.event).not.toHaveProperty('id');
	});

	it('preserves empty TEXT values while JSON round-trip distinguishes omitted optionals', () => {
		const omitted = mapLines(event('omitted', ['DTSTART:20260812T090000Z'])).event;
		const empty = mapLines(
			event('empty', ['SUMMARY:', 'DESCRIPTION:', 'LOCATION:', 'DTSTART:20260812T090000Z']),
		).event;

		expect(JSON.parse(JSON.stringify(omitted))).not.toHaveProperty('summary');
		expect(JSON.parse(JSON.stringify(empty))).toMatchObject({
			summary: '',
			description: '',
			location: '',
		});
		expect(Object.values(empty)).not.toContain(null);
		expect(Object.values(omitted)).not.toContain(undefined);
	});

	it('keeps calendar URL, resource URL, UID, event URL, and empty ETag exact and distinct', () => {
		const uid = 'https://uid.example.test/not-a-resource';
		const eventUrl = 'https://public.example.test/event?opaque=%2f%2F';
		const result = mapLines(event(uid, [`URL:${eventUrl}`, 'DTSTART:20260812T090000Z']), {
			etag: '',
		});

		expect(result.event).toMatchObject({
			calendarUrl: CALENDAR_URL,
			resourceUrl: RESOURCE_URL,
			etag: '',
			uid,
			url: eventUrl,
		});
		expect(
			new Set([
				result.event.calendarUrl,
				result.event.resourceUrl,
				result.event.uid,
				result.event.url,
			]),
		).toHaveProperty('size', 4);
		expect(result.event).not.toHaveProperty('id');
	});

	it('projects only the master and preserves ordered exceptions and all unprojected AST content', () => {
		const originalIcs = calendar([
			'PRODID:-//Synthetic Preservation//EN',
			'X-CALENDAR;X-PARAM=opaque:calendar-value',
			'BEGIN:VTIMEZONE',
			'TZID:Etc/Synthetic',
			'BEGIN:STANDARD',
			'DTSTART:19700101T000000',
			'TZOFFSETFROM:+0000',
			'TZOFFSETTO:+0000',
			'END:STANDARD',
			'END:VTIMEZONE',
			...event('recurring', [
				'DTSTART;X-UNKNOWN=preserve:20260812T090000Z',
				'DTEND:20260812T100000Z',
				'RRULE:FREQ=WEEKLY;COUNT=3',
				'EXDATE:20260819T090000Z',
				'RDATE:20260820T090000Z',
				'X-PROVIDER:opaque',
				'BEGIN:VALARM',
				'ACTION:DISPLAY',
				'TRIGGER:-PT15M',
				'DESCRIPTION:Synthetic reminder',
				'END:VALARM',
			]),
			...event('recurring', [
				'RECURRENCE-ID:20260819T090000Z',
				'DTSTART:20260819T110000Z',
				'SUMMARY:Second in source',
			]),
			...event('recurring', [
				'RECURRENCE-ID:20260813T090000Z',
				'DTSTART:20260813T120000Z',
				'SUMMARY:Third in source',
			]),
		]);
		const resource = parseICalendarResource(encode(originalIcs));
		const astSnapshot = JSON.stringify(resource);
		const components = directComponents(resource.calendar);
		const [timezone, master, firstException, secondException] = components;
		const result = mapCalendarEventResource(inputFor(resource));

		expect(result.event).toMatchObject({
			uid: 'recurring',
			start: '2026-08-12T09:00:00Z',
			end: '2026-08-12T10:00:00Z',
		});
		expect(result.event).not.toHaveProperty('summary');
		expect(result.context.resource).toBe(resource);
		expect(result.context.master).toBe(master);
		expect(result.context.exceptions).toEqual([firstException, secondException]);
		expect(result.context.exceptions[0]).toBe(firstException);
		expect(result.context.exceptions[1]).toBe(secondException);
		expect(result.context.resource.calendar.entries).toContain(timezone);
		expect(JSON.stringify(resource)).toBe(astSnapshot);
		expect(resource.originalIcs).toBe(originalIcs);
		expectDeeplyFrozen(result);
	});

	it('serializes only public event fields and extensions, never AST or raw source internals', () => {
		const sentinel = 'PRIVATE-ORIGINAL-ICS-SENTINEL-27';
		const result = mapLines(
			event('json-safe', ['DTSTART:20260812T090000Z', `X-RAW:<private>${sentinel}</private>`]),
			{ extensions: { synthetic: { enabled: true } } },
		);
		const serialized = JSON.stringify(result.event);
		const parsed = JSON.parse(serialized) as Record<string, unknown>;

		expect(Object.keys(parsed).sort()).toEqual([
			'accessMode',
			'calendarUrl',
			'end',
			'extensions',
			'resourceUrl',
			'start',
			'timeMode',
			'uid',
		]);
		for (const forbidden of [
			'kind',
			'entries',
			'parameters',
			'textValues',
			'originalIcs',
			'context',
			'BEGIN:VCALENDAR',
			'<private>',
			sentinel,
		]) {
			expect(serialized).not.toContain(forbidden);
		}
	});
});

describe('VEVENT set identity, master selection, and singleton validation', () => {
	it.each([
		['VTODO resource', ['BEGIN:VTODO', 'UID:todo', 'DTSTART:20260812T090000Z', 'END:VTODO']],
		['unknown object resource', ['BEGIN:X-SYNTHETIC', 'X-P:one', 'END:X-SYNTHETIC']],
		[
			'VTIMEZONE-only resource',
			[
				'BEGIN:VTIMEZONE',
				'TZID:Etc/Synthetic',
				'BEGIN:STANDARD',
				'DTSTART:19700101T000000',
				'TZOFFSETFROM:+0000',
				'TZOFFSETTO:+0000',
				'END:STANDARD',
				'END:VTIMEZONE',
			],
		],
	] as const)('rejects a non-VEVENT calendar object: %s', (_label, lines) => {
		expectMapError(parseEventResource(lines), 'NOT_VEVENT_RESOURCE');
	});

	it('rejects a structurally supplied VEVENT mixed with another object component first', () => {
		const resource = parseEventResource(event('mixed-structure', ['DTSTART:20260812T090000Z']));
		const other = deepFreeze({ kind: 'component' as const, name: 'VTODO', entries: [] });
		expectMapError(
			withCalendarEntries(resource, [...resource.calendar.entries, other]),
			'NOT_VEVENT_RESOURCE',
			{ extensions: { synthetic: { invalid: Number.NaN } } },
		);
	});

	it.each([
		[
			'missing UID',
			(entries: readonly ICalendarEntry[]) => entries.filter(({ name }) => name !== 'UID'),
		],
		[
			'duplicate UID',
			(entries: readonly ICalendarEntry[]) => [
				...entries,
				syntheticProperty('uid', 'TEXT', 'identity', ['identity']),
			],
		],
		[
			'empty UID',
			(entries: readonly ICalendarEntry[]) =>
				entries.map((entry) =>
					entry.name.toUpperCase() === 'UID' ? syntheticProperty('UID', 'TEXT', '', ['']) : entry,
				),
		],
		[
			'multi-valued UID',
			(entries: readonly ICalendarEntry[]) =>
				entries.map((entry) =>
					entry.name.toUpperCase() === 'UID'
						? syntheticProperty('UID', 'TEXT', 'identity,other', ['identity', 'other'])
						: entry,
				),
		],
		[
			'non-TEXT UID',
			(entries: readonly ICalendarEntry[]) =>
				entries.map((entry) =>
					entry.name.toUpperCase() === 'UID'
						? syntheticProperty('UID', 'URI', 'identity', null)
						: entry,
				),
		],
	] as const)('rejects mapper-only invalid identity: %s', (_label, transform) => {
		const resource = parseEventResource(event('identity', ['DTSTART:20260812T090000Z']));
		const master = directComponents(resource.calendar)[0]!;
		expectMapError(
			withComponentEntries(resource, master, transform(master.entries)),
			'INVALID_EVENT_IDENTITY',
		);
	});

	it('leaves distinct parsed UIDs as a parser error rather than translating it', () => {
		const invalid = calendar([
			...event('first', ['DTSTART:20260812T090000Z']),
			...event('second', ['RECURRENCE-ID:20260813T090000Z', 'DTSTART:20260813T090000Z']),
		]);
		expect(() => parseICalendarResource(encode(invalid))).toThrowError(
			expect.objectContaining({
				name: 'CalDavICalendarParseError',
				code: 'MISMATCHED_UID',
			}),
		);
		try {
			parseICalendarResource(encode(invalid));
			expect.unreachable('Expected parser failure');
		} catch (error) {
			expect(error).toBeInstanceOf(CalDavICalendarParseError);
			expect(error).not.toBeInstanceOf(CalDavCalendarEventReadModelError);
		}
	});

	it('rejects a structurally supplied UID mismatch across VEVENTs', () => {
		const resource = parseEventResource([
			...event('identity', ['DTSTART:20260812T090000Z']),
			...event('identity', ['RECURRENCE-ID:20260813T090000Z', 'DTSTART:20260813T090000Z']),
		]);
		const [master, exception] = directComponents(resource.calendar);
		const mismatchedException = {
			kind: 'component' as const,
			name: exception!.name,
			entries: exception!.entries.map((entry) =>
				entry.name.toUpperCase() === 'UID'
					? syntheticProperty('UID', 'TEXT', 'other', ['other'])
					: entry,
			),
		};
		const entries = resource.calendar.entries.map((entry) =>
			entry === exception ? mismatchedException : entry,
		);

		expect(master).toBeDefined();
		expectMapError(withCalendarEntries(resource, entries), 'INVALID_EVENT_IDENTITY');
	});

	it('rejects zero and multiple masters deterministically', () => {
		const onlyExceptions = parseEventResource([
			...event('recurring', ['RECURRENCE-ID:20260812T090000Z', 'DTSTART:20260812T090000Z']),
			...event('recurring', ['RECURRENCE-ID:20260813T090000Z', 'DTSTART:20260813T090000Z']),
		]);
		const twoMasters = parseEventResource([
			...event('duplicate-master', ['DTSTART:20260812T090000Z']),
			...event('duplicate-master', ['DTSTART:20260813T090000Z']),
		]);

		expectMapError(onlyExceptions, 'MISSING_MASTER_EVENT');
		expectMapError(twoMasters, 'MULTIPLE_MASTER_EVENTS');
	});

	it('rejects duplicate RECURRENCE-ID before projected master validation', () => {
		const resource = parseEventResource([
			...event('recurrence-cardinality', ['SUMMARY:first', 'SUMMARY:second', 'DTSTART:not-a-date']),
			...event('recurrence-cardinality', [
				'RECURRENCE-ID:20260813T090000Z',
				'recurrence-id:20260814T090000Z',
				'DTSTART:20260813T090000Z',
			]),
		]);
		expectMapError(resource, 'AMBIGUOUS_EVENT_PROPERTY');
	});

	it.each(['SUMMARY', 'DESCRIPTION', 'LOCATION', 'URL', 'DTSTART', 'DTEND', 'DURATION'])(
		'rejects duplicate master %s without choosing a value',
		(name) => {
			const lines = [
				'DTSTART:20260812T090000Z',
				...(name === 'DTSTART' ? ['dtstart:20260812T100000Z'] : []),
				...(name === 'DTEND' ? ['DTEND:20260812T100000Z', 'dtend:20260812T110000Z'] : []),
				...(name === 'DURATION' ? ['DURATION:PT1H', 'duration:PT2H'] : []),
				...(['SUMMARY', 'DESCRIPTION', 'LOCATION'].includes(name)
					? [`${name}:first`, `${name.toLowerCase()}:second`]
					: []),
				...(name === 'URL' ? ['URL:https://one.example.test', 'url:https://two.example.test'] : []),
			];
			expectMapError(
				parseEventResource(event(`duplicate-${name}`, lines)),
				'AMBIGUOUS_EVENT_PROPERTY',
			);
		},
	);
});

describe('projected property types and UTC event times', () => {
	it.each([
		['missing DTSTART', []],
		['SUMMARY is URI', ['SUMMARY;VALUE=URI:https://example.test', 'DTSTART:20260812T090000Z']],
		['SUMMARY has multiple TEXT values', ['SUMMARY:first,second', 'DTSTART:20260812T090000Z']],
		['DESCRIPTION is URI', ['DESCRIPTION;VALUE=URI:urn:synthetic', 'DTSTART:20260812T090000Z']],
		['LOCATION is URI', ['LOCATION;VALUE=URI:urn:synthetic', 'DTSTART:20260812T090000Z']],
		['URL is TEXT', ['URL;VALUE=TEXT:https://example.test', 'DTSTART:20260812T090000Z']],
		['DTSTART is TEXT', ['DTSTART;VALUE=TEXT:20260812T090000Z']],
		[
			'DTEND and DURATION coexist',
			['DTSTART:20260812T090000Z', 'DTEND:20260812T100000Z', 'DURATION:PT1H'],
		],
	] as const)('rejects invalid projected shape: %s', (_label, lines) => {
		expectMapError(parseEventResource(event('invalid-property', lines)), 'INVALID_EVENT_PROPERTY');
	});

	it.each([
		['DATE/all-day', ['DTSTART;VALUE=DATE:20260812']],
		['floating local time', ['DTSTART:20260812T090000']],
		['TZID local time', ['DTSTART;TZID=Europe/Prague:20260812T090000']],
		['TZID on Z time', ['DTSTART;TZID=Etc/UTC:20260812T090000Z']],
		['duration-only end', ['DTSTART:20260812T090000Z', 'DURATION:PT1H']],
	] as const)('projects a safe read-only time representation: %s', (_label, lines) => {
		const mapped = mapCalendarEventResource(
			inputFor(parseEventResource(event('unsupported-time', lines))),
		);
		expect(mapped.event).toMatchObject({
			timeMode: 'unsupported',
			accessMode: 'readOnly',
			readOnlyReason: 'unsupportedTimeRepresentation',
		});
		expect(mapped.event).not.toHaveProperty('start');
	});

	it.each([
		['numeric offset', ['DTSTART:20260812T090000+0200']],
		['hyphenated RFC 3339 input', ['DTSTART:2026-08-12T09:00:00Z']],
		['lowercase z', ['DTSTART:20260812T090000z']],
		['missing seconds', ['DTSTART:20260812T0900Z']],
		['trailing data', ['DTSTART:20260812T090000Zextra']],
		['invalid non-leap February day', ['DTSTART:20260229T090000Z']],
		['invalid leap-century day', ['DTSTART:21000229T090000Z']],
		['month zero', ['DTSTART:20260012T090000Z']],
		['month thirteen', ['DTSTART:20261312T090000Z']],
		['day zero', ['DTSTART:20260800T090000Z']],
		['invalid April day', ['DTSTART:20260431T090000Z']],
		['hour 24', ['DTSTART:20260812T240000Z']],
		['minute 60', ['DTSTART:20260812T096000Z']],
		['second 61', ['DTSTART:20260812T090061Z']],
	] as const)('rejects malformed time representation: %s', (_label, lines) => {
		expectMapError(parseEventResource(event('unsupported-time', lines)), 'INVALID_EVENT_PROPERTY');
	});

	it('maps Gregorian leap day and RFC-valid leap-second spelling mechanically', () => {
		const leapDay = mapLines(
			event('leap-day', ['DTSTART:20000229T235959Z', 'DTEND:20000301T000000Z']),
		);
		const leapSecond = mapLines(
			event('leap-second', ['DTSTART:20161231T235960Z', 'DTEND:20170101T000000Z']),
		);

		expect(leapDay.event).toMatchObject({
			start: '2000-02-29T23:59:59Z',
			end: '2000-03-01T00:00:00Z',
		});
		expect(leapSecond.event).toMatchObject({
			start: '2016-12-31T23:59:60Z',
			end: '2017-01-01T00:00:00Z',
		});
	});

	it('accepts explicit DATE-TIME and unknown parameters without interpreting them', () => {
		const result = mapLines(
			event('effective-type', [
				'DTSTART;VALUE=date-time;X-SYNTHETIC=opaque:20260812T090000Z',
				'DTEND;X-OTHER=preserve:20260812T100000Z',
			]),
		);
		expect(result.event).toMatchObject({
			start: '2026-08-12T09:00:00Z',
			end: '2026-08-12T10:00:00Z',
		});
		expect(result.context.resource.originalIcs).toContain('X-SYNTHETIC=opaque');
	});

	it.each([
		['equal end', '20260812T090000Z', '20260812T090000Z'],
		['earlier second', '20260812T090001Z', '20260812T090000Z'],
		['earlier date', '20260813T000000Z', '20260812T235959Z'],
	] as const)('rejects a non-later end: %s', (_label, start, end) => {
		expectMapError(
			parseEventResource(event('invalid-range', [`DTSTART:${start}`, `DTEND:${end}`])),
			'INVALID_EVENT_TIME_RANGE',
		);
	});

	it('applies the full deterministic validation precedence', () => {
		const badExtensions = {
			synthetic: { invalid: Number.NaN },
		} as unknown as CalendarEventExtensions;
		const vtodo = parseEventResource(['BEGIN:VTODO', 'UID:precedence', 'END:VTODO']);
		expectMapError(vtodo, 'NOT_VEVENT_RESOURCE', { extensions: badExtensions });

		const twoMasters = parseEventResource([
			...event('precedence', ['DTSTART:not-utc']),
			...event('precedence', ['DTSTART:not-utc']),
		]);
		const firstMaster = directComponents(twoMasters.calendar)[0]!;
		const invalidIdentity = withComponentEntries(
			twoMasters,
			firstMaster,
			directProperties(firstMaster).filter(({ name }) => name.toUpperCase() !== 'UID'),
		);
		expectMapError(invalidIdentity, 'INVALID_EVENT_IDENTITY', { extensions: badExtensions });
		expectMapError(twoMasters, 'MULTIPLE_MASTER_EVENTS', { extensions: badExtensions });

		const ambiguous = parseEventResource(
			event('precedence', ['SUMMARY:first', 'SUMMARY;VALUE=URI:second', 'DTSTART:not-utc']),
		);
		expectMapError(ambiguous, 'AMBIGUOUS_EVENT_PROPERTY', { extensions: badExtensions });

		const invalidType = parseEventResource(
			event('precedence', ['SUMMARY;VALUE=URI:invalid', 'DTSTART:not-utc']),
		);
		expectMapError(invalidType, 'INVALID_EVENT_PROPERTY', { extensions: badExtensions });

		const invalidTime = parseEventResource(
			event('precedence', ['DTSTART:20260229T090000Z', 'DTEND:20260228T090000Z']),
		);
		expectMapError(invalidTime, 'INVALID_EVENT_PROPERTY', { extensions: badExtensions });

		const invalidRange = parseEventResource(
			event('precedence', ['DTSTART:20260812T100000Z', 'DTEND:20260812T090000Z']),
		);
		expectMapError(invalidRange, 'INVALID_EVENT_TIME_RANGE', { extensions: badExtensions });

		const validResource = parseEventResource(event('precedence', ['DTSTART:20260812T090000Z']));
		expectMapError(validResource, 'INVALID_EVENT_EXTENSIONS', { extensions: badExtensions });
	});
});

describe('provider extension snapshots', () => {
	it('omits absent and empty top-level extensions but retains an explicit empty namespace', () => {
		const lines = event('extension-absence', ['DTSTART:20260812T090000Z']);
		expect(mapLines(lines).event).not.toHaveProperty('extensions');
		expect(mapLines(lines, { extensions: {} }).event).not.toHaveProperty('extensions');
		expect(mapLines(lines, { extensions: { synthetic: {} } }).event.extensions).toEqual({
			synthetic: {},
		});
	});

	it('copies a JSON-safe namespaced tree without freezing or retaining caller values', () => {
		const nested = { enabled: true, labels: ['one', { two: 2 }], nullable: null };
		const extensions = { synthetic: nested };
		const result = mapLines(event('extensions', ['DTSTART:20260812T090000Z']), { extensions });
		const snapshot = result.event.extensions!;

		expect(snapshot).toEqual(extensions);
		expect(snapshot).not.toBe(extensions);
		expect(snapshot.synthetic).not.toBe(nested);
		expect(snapshot.synthetic.labels).not.toBe(nested.labels);
		expect(Object.isFrozen(extensions)).toBe(false);
		expect(Object.isFrozen(nested)).toBe(false);
		expect(Object.isFrozen(nested.labels)).toBe(false);
		expectDeeplyFrozen(snapshot);

		nested.enabled = false;
		nested.labels.push('later');
		expect(snapshot).toEqual({
			synthetic: { enabled: true, labels: ['one', { two: 2 }], nullable: null },
		});
	});

	it('accepts at most 32 nested extension containers and rejects the next level', () => {
		const nestedArrays = (levels: number): CalendarEventExtensionValue => {
			let value: CalendarEventExtensionValue = 'leaf';
			for (let index = 0; index < levels; index += 1) value = [value];
			return value;
		};
		const resource = parseEventResource(event('extension-depth', ['DTSTART:20260812T090000Z']));
		const accepted = mapCalendarEventResource(
			inputFor(resource, { extensions: { synthetic: { value: nestedArrays(32) } } }),
		);
		expect(accepted.event.extensions).toBeDefined();
		expectMapError(resource, 'INVALID_EVENT_EXTENSIONS', {
			extensions: { synthetic: { value: nestedArrays(33) } },
		});
	});

	it.each([
		['empty provider key', { '': { enabled: true } }],
		['constructor provider key', { constructor: { enabled: true } }],
		['prototype provider key', { prototype: { enabled: true } }],
		['non-finite NaN', { synthetic: { value: Number.NaN } }],
		['positive infinity', { synthetic: { value: Number.POSITIVE_INFINITY } }],
		['negative infinity', { synthetic: { value: Number.NEGATIVE_INFINITY } }],
		['undefined', { synthetic: { value: undefined } }],
		['function', { synthetic: { value: () => true } }],
		['bigint', { synthetic: { value: 1n } }],
		['Date instance', { synthetic: { value: new Date('2026-08-12T00:00:00Z') } }],
		['non-plain record', { synthetic: { value: Object.create({ inherited: true }) } }],
		['sparse array', { synthetic: { value: Array(1) } }],
	] as const)('rejects a non-JSON extension tree: %s', (_label, extensions) => {
		const resource = parseEventResource(event('invalid-extension', ['DTSTART:20260812T090000Z']));
		expectMapError(resource, 'INVALID_EVENT_EXTENSIONS', {
			extensions: extensions as unknown as CalendarEventExtensions,
		});
	});

	it.each(['__proto__', 'constructor', 'prototype'])(
		'rejects an own unsafe nested key %s',
		(unsafeKey) => {
			const nested = Object.defineProperty({}, unsafeKey, {
				value: { sentinel: 'PRIVATE-UNSAFE-KEY' },
				enumerable: true,
				configurable: true,
			});
			const resource = parseEventResource(
				event('unsafe-extension-key', ['DTSTART:20260812T090000Z']),
			);
			expectMapError(resource, 'INVALID_EVENT_EXTENSIONS', {
				extensions: { synthetic: { nested } } as unknown as CalendarEventExtensions,
			});
		},
	);

	it('rejects an own __proto__ provider key without consulting the prototype chain', () => {
		const extensions = Object.defineProperty({}, '__proto__', {
			value: { sentinel: 'PRIVATE-PROVIDER-KEY' },
			enumerable: true,
			configurable: true,
		});
		const resource = parseEventResource(event('unsafe-provider', ['DTSTART:20260812T090000Z']));
		expectMapError(resource, 'INVALID_EVENT_EXTENSIONS', {
			extensions: extensions as CalendarEventExtensions,
		});
	});

	it('rejects cycles, parser nodes, and accessors without leaking or evaluating values', () => {
		const resource = parseEventResource(event('extension-security', ['DTSTART:20260812T090000Z']));
		const master = directComponents(resource.calendar)[0]!;
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const getter = vi.fn(() => 'PRIVATE-GETTER-SENTINEL');
		const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get: getter });

		for (const value of [resource, master, cyclic, accessor]) {
			const error = expectMapError(resource, 'INVALID_EVENT_EXTENSIONS', {
				extensions: { synthetic: { value } } as unknown as CalendarEventExtensions,
			});
			const exposed = `${error.message}\n${error.stack ?? ''}\n${JSON.stringify(error)}`;
			expect(exposed).not.toContain('PRIVATE-GETTER-SENTINEL');
			expect(error).not.toHaveProperty('cause');
		}
		expect(getter).not.toHaveBeenCalled();
	});

	it.each([
		[
			'getPrototypeOf',
			(getter: ReturnType<typeof vi.fn>) =>
				new Proxy(
					{ synthetic: Object.defineProperty({}, 'secret', { enumerable: true, get: getter }) },
					{
						getPrototypeOf() {
							throw new Error('PRIVATE-PROXY-SENTINEL:getPrototypeOf');
						},
					},
				),
		],
		[
			'ownKeys',
			(getter: ReturnType<typeof vi.fn>) => ({
				synthetic: {
					value: new Proxy(Object.defineProperty({}, 'secret', { enumerable: true, get: getter }), {
						ownKeys() {
							throw new Error('PRIVATE-PROXY-SENTINEL:ownKeys');
						},
					}),
				},
			}),
		],
		[
			'getOwnPropertyDescriptor',
			(getter: ReturnType<typeof vi.fn>) => ({
				synthetic: {
					value: new Proxy(Object.defineProperty({}, 'secret', { enumerable: true, get: getter }), {
						getOwnPropertyDescriptor() {
							throw new Error('PRIVATE-PROXY-SENTINEL:getOwnPropertyDescriptor');
						},
					}),
				},
			}),
		],
	] as const)('sanitizes a throwing extension Proxy %s trap', (_trap, createExtensions) => {
		const resource = parseEventResource(event('extension-proxy', ['DTSTART:20260812T090000Z']));
		const getter = vi.fn(() => 'PRIVATE-ACCESSOR-SENTINEL');
		const extensions = createExtensions(getter);

		const error = expectMapError(resource, 'INVALID_EVENT_EXTENSIONS', {
			extensions: extensions as unknown as CalendarEventExtensions,
		});
		const exposed = `${error.message}\n${error.stack ?? ''}\n${JSON.stringify(error)}`;
		expect(exposed).not.toContain('PRIVATE-PROXY-SENTINEL');
		expect(exposed).not.toContain('PRIVATE-ACCESSOR-SENTINEL');
		expect(error).not.toHaveProperty('cause');
		expect(getter).not.toHaveBeenCalled();
	});

	it('does not trust a public read-model error thrown by an extension Proxy', () => {
		const resource = parseEventResource(
			event('extension-public-error', ['DTSTART:20260812T090000Z']),
		);
		const hostileError = new CalDavCalendarEventReadModelError('NOT_VEVENT_RESOURCE');
		hostileError.message = 'PRIVATE-PUBLIC-ERROR-MESSAGE';
		hostileError.stack = 'PRIVATE-PUBLIC-ERROR-STACK';
		Object.defineProperty(hostileError, 'cause', {
			value: 'PRIVATE-PUBLIC-ERROR-CAUSE',
			enumerable: true,
		});
		const extensions = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw hostileError;
				},
			},
		);

		const error = expectMapError(resource, 'INVALID_EVENT_EXTENSIONS', {
			extensions: extensions as CalendarEventExtensions,
		});
		const exposed = `${error.message}\n${error.stack ?? ''}\n${JSON.stringify(error)}`;
		expect(exposed).not.toContain('PRIVATE-PUBLIC-ERROR');
		expect(error).not.toHaveProperty('cause');
	});
});

describe('determinism, immutability, and side-effect boundary', () => {
	it('does not use clock, randomness, locale, console, fetch, or mutate caller objects', () => {
		const resource = parseEventResource(
			event('side-effects', [
				'SUMMARY:Synthetic',
				'DTSTART:20260812T090000Z',
				'DTEND:20260812T100000Z',
			]),
		);
		const extensions = { synthetic: { value: ['stable'] } };
		const input = inputFor(resource, { etag: '"opaque"', extensions });
		const resourceSnapshot = JSON.stringify(resource);
		const inputSnapshot = JSON.stringify(input);
		const fetchSpy = vi.fn().mockRejectedValue(new Error('Network must not run'));
		vi.stubGlobal('fetch', fetchSpy);
		const forbiddenSpies = [
			vi.spyOn(Date, 'now').mockImplementation(() => {
				throw new Error('Clock must not run');
			}),
			vi.spyOn(Date, 'parse').mockImplementation(() => {
				throw new Error('Date parsing must not run');
			}),
			vi.spyOn(Date, 'UTC').mockImplementation(() => {
				throw new Error('Date conversion must not run');
			}),
			vi.spyOn(Math, 'random').mockImplementation(() => {
				throw new Error('Randomness must not run');
			}),
			vi.spyOn(console, 'log').mockImplementation(() => undefined),
			vi.spyOn(console, 'error').mockImplementation(() => undefined),
			vi.spyOn(console, 'warn').mockImplementation(() => undefined),
			vi.spyOn(console, 'info').mockImplementation(() => undefined),
			vi.spyOn(console, 'debug').mockImplementation(() => undefined),
		];

		const first = mapCalendarEventResource(input);
		const second = mapCalendarEventResource(input);

		expect(first.event).toEqual(second.event);
		expect(first.context.resource).toBe(resource);
		expect(JSON.stringify(resource)).toBe(resourceSnapshot);
		expect(JSON.stringify(input)).toBe(inputSnapshot);
		expect(Object.isFrozen(input)).toBe(false);
		expect(Object.isFrozen(extensions)).toBe(false);
		expect(fetchSpy).not.toHaveBeenCalled();
		for (const spy of forbiddenSpies) expect(spy).not.toHaveBeenCalled();
		expectDeeplyFrozen(first);
	});
});
