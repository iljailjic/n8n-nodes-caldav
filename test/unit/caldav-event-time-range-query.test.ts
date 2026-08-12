// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports -- A foreign Date realm is required by the accepted range-validation contract.
import { runInNewContext } from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vitest';

import * as timeRangeQueryModule from '../../nodes/CalDav/events/timeRangeQuery';
import { queryCalendarEventsByTimeRange } from '../../nodes/CalDav/events/timeRangeQuery';
import type { CalendarEventReadResult } from '../../nodes/CalDav/icalendar/eventReadModel';
import {
	CalDavCalendarEventReadModelError,
	CalendarEventReadModelErrorCode,
} from '../../nodes/CalDav/icalendar/eventReadModel';
import {
	CalDavICalendarParseError,
	ICALENDAR_MAX_RESOURCE_BYTES,
} from '../../nodes/CalDav/icalendar/parser';
import {
	CALDAV_MAX_RESPONSE_BYTES,
	CalDavMethod,
	CalDavResponseLimitError,
} from '../../nodes/CalDav/transport/http';
import type {
	CalDavTransport,
	CalDavTransportRequest,
	CalDavTransportResponse,
} from '../../nodes/CalDav/transport/http';
import {
	CalDavUrlValidationError,
	validateAbsoluteHttpUrl,
} from '../../nodes/CalDav/transport/url';
import { XmlBuildError } from '../../nodes/CalDav/xml/errors';
import { CalDavXmlParseError, CalDavXmlProtocolError } from '../../nodes/CalDav/xml/parser';
import {
	buildCalendarTimeRangeQueryReport,
	type CalendarTimeRangeQueryInput,
} from '../../nodes/CalDav/xml/requests';

const CALENDAR_URL = validateAbsoluteHttpUrl(
	'https://configured.example.test/calendars/synthetic-owner/events/?opaque=calendar',
);
const EFFECTIVE_URL = 'https://partition.example.test/calendars/synthetic-owner/events/';
const RANGE: CalendarTimeRangeQueryInput = Object.freeze({
	start: new Date('2026-01-02T03:04:05Z'),
	end: new Date('2026-12-31T23:59:59Z'),
});

const EXPECTED_REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="20260102T030405Z" end="20261231T235959Z"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

type MockTransport = CalDavTransport & { readonly request: ReturnType<typeof vi.fn> };

interface EventFixtureOptions {
	readonly summary?: string;
	readonly rrule?: string;
	readonly exceptionStart?: string;
}

function xmlText(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
}

function eventIcs(
	uid: string,
	start = '20260102T100000Z',
	end = '20260102T110000Z',
	options: EventFixtureOptions = {},
): string {
	const master = [
		'BEGIN:VEVENT',
		`UID:${uid}`,
		`DTSTART:${start}`,
		`DTEND:${end}`,
		...(options.summary === undefined ? [] : [`SUMMARY:${options.summary}`]),
		...(options.rrule === undefined ? [] : [`RRULE:${options.rrule}`]),
		'END:VEVENT',
	];
	const exception =
		options.exceptionStart === undefined
			? []
			: [
					'BEGIN:VEVENT',
					`UID:${uid}`,
					`RECURRENCE-ID:${options.exceptionStart}`,
					`DTSTART:${options.exceptionStart}`,
					`DTEND:${end}`,
					'SUMMARY:Synthetic recurrence exception',
					'END:VEVENT',
				];

	return [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//example.test//Time range contract//EN',
		...master,
		...exception,
		'END:VCALENDAR',
		'',
	].join('\r\n');
}

function propstat(properties: string, status = 'HTTP/1.1 200 OK'): string {
	return `<d:propstat><d:prop>${properties}</d:prop><d:status>${status}</d:status></d:propstat>`;
}

function calendarData(value: string, prefix = 'c', attributes = ''): string {
	return `<${prefix}:calendar-data${attributes}>${xmlText(value)}</${prefix}:calendar-data>`;
}

function etag(value: string, prefix = 'd'): string {
	return `<${prefix}:getetag>${xmlText(value)}</${prefix}:getetag>`;
}

function propertyResponse(href: string, propstats: string): string {
	return `<d:response><d:href>${xmlText(href)}</d:href>${propstats}</d:response>`;
}

function statusResponse(href: string, status: string): string {
	return `<d:response><d:href>${xmlText(href)}</d:href><d:status>${status}</d:status></d:response>`;
}

function multistatus(responses = '', namespaces = ''): string {
	return `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"${namespaces}>${responses}</d:multistatus>`;
}

function successfulResource(
	href: string,
	ics: string,
	etagValue?: string,
	additionalProperties = '',
): string {
	return propertyResponse(
		href,
		propstat(
			`${etagValue === undefined ? '' : etag(etagValue)}${calendarData(ics)}${additionalProperties}`,
		),
	);
}

function transportResponse(
	xml: string,
	statusCode = 207,
	effectiveUrl = EFFECTIVE_URL,
): CalDavTransportResponse {
	return {
		statusCode,
		headers: Object.freeze({}),
		effectiveUrl,
		body: Buffer.from(xml, 'utf8'),
	};
}

function mockTransport(
	implementation: (
		request: CalDavTransportRequest,
	) => Promise<CalDavTransportResponse> = async () => transportResponse(multistatus()),
): MockTransport {
	return {
		serverUrl: 'https://configured.example.test/',
		request: vi.fn(implementation),
	};
}

function expectDeeplyFrozen(value: unknown, seen = new WeakSet<object>()): void {
	if (typeof value !== 'object' || value === null || seen.has(value)) return;
	seen.add(value);
	expect(Object.isFrozen(value)).toBe(true);
	for (const key of Reflect.ownKeys(value)) {
		expectDeeplyFrozen(Reflect.get(value, key), seen);
	}
}

async function captureFailure(
	transport: CalDavTransport,
	range: CalendarTimeRangeQueryInput = RANGE,
): Promise<unknown> {
	try {
		await queryCalendarEventsByTimeRange(transport, CALENDAR_URL, range);
		expect.unreachable('Expected the time-range query to fail');
	} catch (error) {
		return error;
	}
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('event time-range query public surface and request', () => {
	it('exports exactly the accepted runtime service', () => {
		expect(Object.keys(timeRangeQueryModule)).toEqual(['queryCalendarEventsByTimeRange']);
		expect(queryCalendarEventsByTimeRange).toBeTypeOf('function');
	});

	it('sends one exact depth-1 REPORT using the builder-authoritative XML', async () => {
		const transport = mockTransport();

		const result: readonly CalendarEventReadResult[] = await queryCalendarEventsByTimeRange(
			transport,
			CALENDAR_URL,
			RANGE,
		);

		expect(result).toEqual([]);
		expect(transport.request).toHaveBeenCalledTimes(1);
		expect(transport.request).toHaveBeenCalledWith({
			method: CalDavMethod.REPORT,
			url: CALENDAR_URL,
			headers: {
				Depth: '1',
				'Content-Type': 'application/xml; charset=utf-8',
			},
			body: EXPECTED_REPORT,
		});
		expect(EXPECTED_REPORT).toBe(buildCalendarTimeRangeQueryReport(RANGE));
		expect(EXPECTED_REPORT).not.toMatch(/expand|limit|page|recurrence-set/i);
	});

	it.each([
		[
			'DST spring boundary',
			new Date('2026-03-29T00:59:59Z'),
			new Date('2026-03-29T01:00:00Z'),
			'20260329T005959Z',
			'20260329T010000Z',
		],
		[
			'DST autumn boundary',
			new Date('2026-10-25T00:59:59Z'),
			new Date('2026-10-25T01:00:00Z'),
			'20261025T005959Z',
			'20261025T010000Z',
		],
		[
			'one-second exact bound',
			new Date('2026-08-12T12:34:56Z'),
			new Date('2026-08-12T12:34:57Z'),
			'20260812T123456Z',
			'20260812T123457Z',
		],
	] as const)('uses UTC instants across a %s', async (_label, start, end, startText, endText) => {
		const transport = mockTransport();

		await queryCalendarEventsByTimeRange(transport, CALENDAR_URL, { start, end });

		const request = transport.request.mock.calls[0]![0] as CalDavTransportRequest;
		expect(request.body).toContain(`start="${startText}" end="${endText}"`);
	});
});

describe('event time-range validation', () => {
	it.each([
		[
			'invalid start',
			new Date(Number.NaN),
			new Date('2026-01-02T00:00:01Z'),
			'INVALID_DATE',
			'start',
		],
		['invalid end', new Date('2026-01-02T00:00:00Z'), new Date(Number.NaN), 'INVALID_DATE', 'end'],
		[
			'non-Date start',
			'2026-01-02T00:00:00Z',
			new Date('2026-01-02T00:00:01Z'),
			'INVALID_DATE',
			'start',
		],
		[
			'millisecond start',
			new Date('2026-01-02T00:00:00.001Z'),
			new Date('2026-01-02T00:00:01Z'),
			'INVALID_DATE',
			'start',
		],
		[
			'equal bounds',
			new Date('2026-01-02T00:00:00Z'),
			new Date('2026-01-02T00:00:00Z'),
			'INVALID_TIME_RANGE',
			undefined,
		],
		[
			'reversed bounds',
			new Date('2026-01-02T00:00:01Z'),
			new Date('2026-01-02T00:00:00Z'),
			'INVALID_TIME_RANGE',
			undefined,
		],
	] as const)('rejects %s before I/O', async (_label, start, end, code, field) => {
		const transport = mockTransport();
		const error = await captureFailure(transport, {
			start: start as Date,
			end,
		});

		expect(error).toBeInstanceOf(XmlBuildError);
		expect(error).toMatchObject({ code, ...(field === undefined ? {} : { field }) });
		expect(transport.request).not.toHaveBeenCalled();
	});

	it.each([
		['negative start year', -1, 'start'],
		['five-digit end year', 10_000, 'end'],
	] as const)('rejects a %s before I/O', async (_label, year, field) => {
		const transport = mockTransport();
		const start = new Date('2026-01-02T00:00:00Z');
		const end = new Date('2026-01-02T00:00:01Z');
		(field === 'start' ? start : end).setUTCFullYear(year);
		const error = await captureFailure(transport, { start, end });

		expect(error).toBeInstanceOf(XmlBuildError);
		expect(error).toMatchObject({ code: 'INVALID_DATE', field });
		expect(transport.request).not.toHaveBeenCalled();
	});

	it('accepts genuine Dates from another realm and performs one request', async () => {
		const foreignRange = runInNewContext(
			'({ start: new Date("2026-01-02T00:00:00Z"), end: new Date("2026-01-02T00:00:01Z") })',
		) as CalendarTimeRangeQueryInput;
		const transport = mockTransport();

		await expect(
			queryCalendarEventsByTimeRange(transport, CALENDAR_URL, foreignRange),
		).resolves.toEqual([]);
		expect(transport.request).toHaveBeenCalledTimes(1);
	});
});

describe('event resource property selection and mapping', () => {
	it('returns an immutable empty array for an empty successful Multi-Status', async () => {
		const result = await queryCalendarEventsByTimeRange(mockTransport(), CALENDAR_URL, RANGE);

		expect(result).toEqual([]);
		expect(Object.isFrozen(result)).toBe(true);
	});

	it('maps a relative href with exact calendar URL, canonical resource URL, ETag, and context', async () => {
		const ics = eventIcs('synthetic-complete', '20260102T100000Z', '20260102T110000Z', {
			summary: 'Synthetic event',
		});
		const exactEtag = '  W/"synthetic-etag"  ';
		const xml = multistatus(
			propertyResponse(
				'resource%2Eics?opaque=member',
				propstat(
					`${etag(exactEtag, 'x')}${calendarData(
						ics,
						'y',
						' content-type="text/calendar" version="2.0"',
					)}<z:ignored>private-ignored-value</z:ignored>`,
				),
			),
			' xmlns:x="DAV:" xmlns:y="urn:ietf:params:xml:ns:caldav" xmlns:z="urn:example:ignored"',
		);

		const result = await queryCalendarEventsByTimeRange(
			mockTransport(async () => transportResponse(xml)),
			CALENDAR_URL,
			RANGE,
		);

		expect(result).toHaveLength(1);
		expect(result[0]!.event).toEqual({
			calendarUrl: CALENDAR_URL,
			resourceUrl:
				'https://partition.example.test/calendars/synthetic-owner/events/resource%2Eics?opaque=member',
			etag: exactEtag,
			uid: 'synthetic-complete',
			summary: 'Synthetic event',
			start: '2026-01-02T10:00:00Z',
			end: '2026-01-02T11:00:00Z',
		});
		expect(result[0]!.context.resource.originalIcs).toBe(ics.replaceAll('\r\n', '\n'));
		expectDeeplyFrozen(result);
		expect(JSON.stringify(result[0]!.event)).not.toContain('private-ignored-value');
	});

	it.each(['', 'W/"weak-synthetic"', '  "quoted-synthetic"  '] as const)(
		'copies the exact successful ETag %j rather than treating it as absent',
		async (exactEtag) => {
			const xml = multistatus(
				successfulResource('/exact-etag.ics', eventIcs('exact-etag'), exactEtag),
			);

			const [result] = await queryCalendarEventsByTimeRange(
				mockTransport(async () => transportResponse(xml)),
				CALENDAR_URL,
				RANGE,
			);

			expect(result!.event).toHaveProperty('etag', exactEtag);
		},
	);

	it.each([
		[
			'absolute',
			'https://other.example.test/calendars/events/absolute.ics',
			'https://other.example.test/calendars/events/absolute.ics',
		],
		[
			'root-relative',
			'/calendars/events/root.ics',
			'https://partition.example.test/calendars/events/root.ics',
		],
		[
			'scheme-relative',
			'//other.example.test/calendars/events/scheme.ics',
			'https://other.example.test/calendars/events/scheme.ics',
		],
	] as const)(
		'resolves an %s href against only the effective response URL',
		async (_label, href, expected) => {
			const xml = multistatus(successfulResource(href, eventIcs(`uid-${_label}`)));

			const [result] = await queryCalendarEventsByTimeRange(
				mockTransport(async () => transportResponse(xml)),
				CALENDAR_URL,
				RANGE,
			);

			expect(result!.event.calendarUrl).toBe(CALENDAR_URL);
			expect(result!.event.resourceUrl).toBe(expected);
		},
	);

	it.each([
		['empty', '', 'MALFORMED_URL'],
		['malformed', 'https://[invalid.example.test/resource.ics', 'MALFORMED_URL'],
		['fragment', '/resource.ics#private-fragment', 'FRAGMENT_NOT_ALLOWED'],
		['userinfo', 'https://private-user@other.example.test/resource.ics', 'USERINFO_NOT_ALLOWED'],
		['downgrade', 'http://partition.example.test/resource.ics', 'INSECURE_PROTOCOL_DOWNGRADE'],
	] as const)('preserves the sanitized URL failure for an %s href', async (_label, href, code) => {
		const xml = multistatus(successfulResource(href, eventIcs('private-uid-sentinel')));
		const error = await captureFailure(mockTransport(async () => transportResponse(xml)));

		expect(error).toBeInstanceOf(CalDavUrlValidationError);
		expect(error).toMatchObject({ name: 'CalDavUrlValidationError', code });
		expect(String(error)).not.toContain('private-uid-sentinel');
		if (href !== '') expect(String(error)).not.toContain(href);
	});

	it('uses only successful requested properties and omits resources without successful calendar-data', async () => {
		const usableIcs = eventIcs('usable-without-etag');
		const omittedIcs = eventIcs('omitted-with-etag-only');
		const xml = multistatus(
			propertyResponse(
				'/usable.ics',
				propstat(
					`${calendarData(usableIcs)}<x:unknown xmlns:x="urn:synthetic">ignored</x:unknown>`,
				) +
					propstat(
						`${etag('failed-etag')}${calendarData(eventIcs('failed-copy'))}`,
						'HTTP/1.1 404 Not Found',
					),
			) +
				propertyResponse('/omitted.ics', propstat(etag('"supplied-but-unused"'))) +
				statusResponse('/failed.ics', 'HTTP/1.1 404 Not Found'),
		);

		const result = await queryCalendarEventsByTimeRange(
			mockTransport(async () => transportResponse(xml)),
			CALENDAR_URL,
			RANGE,
		);

		expect(result).toHaveLength(1);
		expect(result[0]!.event.uid).toBe('usable-without-etag');
		expect(result[0]!.event).not.toHaveProperty('etag');
		expect(JSON.stringify(result)).not.toContain(omittedIcs);
	});

	it.each([
		['calendar-data', `${calendarData(eventIcs('first'))}${calendarData(eventIcs('second'))}`],
		['ETag', `${etag('"first"')}${etag('"second"')}${calendarData(eventIcs('duplicate-etag'))}`],
		[
			'nested calendar-data',
			'<c:calendar-data><x:private xmlns:x="urn:synthetic">private-sentinel</x:private></c:calendar-data>',
		],
		[
			'nested ETag',
			`<d:getetag><d:private>private-sentinel</d:private></d:getetag>${calendarData(eventIcs('nested-etag'))}`,
		],
	] as const)(
		'rejects invalid successful %s shape with one fixed response error',
		async (_label, properties) => {
			const xml = multistatus(propertyResponse('/invalid.ics', propstat(properties)));
			const error = await captureFailure(mockTransport(async () => transportResponse(xml)));

			expect(error).toBeInstanceOf(CalDavXmlProtocolError);
			expect(error).toMatchObject({
				code: 'INVALID_RESPONSE',
				message: 'A WebDAV response element is invalid.',
			});
			expect(String(error)).not.toContain('private-sentinel');
		},
	);
});

describe('canonical resource deduplication and deterministic ordering', () => {
	it('coalesces identical canonical aliases regardless of wire order or missing duplicate ETag', async () => {
		const ics = eventIcs('canonical-alias');
		const aliasA = successfulResource('/calendars/events/alias.ics', ics, '"same"');
		const aliasB = successfulResource(
			'https://partition.example.test/calendars/events/alias.ics',
			ics,
		);
		const failedAlias = statusResponse('/calendars/events/alias.ics', 'HTTP/1.1 503 Unavailable');

		for (const responses of [aliasA + failedAlias + aliasB, aliasB + aliasA + failedAlias]) {
			const result = await queryCalendarEventsByTimeRange(
				mockTransport(async () => transportResponse(multistatus(responses))),
				CALENDAR_URL,
				RANGE,
			);

			expect(result).toHaveLength(1);
			expect(result[0]!.event).toMatchObject({ uid: 'canonical-alias', etag: '"same"' });
		}
	});

	it.each([
		[
			'calendar-data',
			successfulResource('/conflict.ics', eventIcs('first')) +
				successfulResource('/conflict.ics', eventIcs('second')),
		],
		[
			'ETag',
			successfulResource('/conflict.ics', eventIcs('same'), '"first"') +
				successfulResource('/conflict.ics', eventIcs('same'), '"second"'),
		],
	] as const)('rejects conflicting duplicate %s atomically', async (_label, responses) => {
		const independent = successfulResource('/independent.ics', eventIcs('independent'));

		for (const body of [responses + independent, independent + responses]) {
			const error = await captureFailure(
				mockTransport(async () => transportResponse(multistatus(body))),
			);
			expect(error).toBeInstanceOf(CalDavXmlProtocolError);
			expect(error).toMatchObject({ code: 'INVALID_RESPONSE' });
		}
	});

	it('sorts by start, Unicode-scalar UID, then canonical URL without locale behavior', async () => {
		const entries = [
			successfulResource('/z.ics', eventIcs('same', '20260102T100000Z', '20260102T110000Z')),
			successfulResource('/a.ics', eventIcs('same', '20260102T100000Z', '20260102T110000Z')),
			successfulResource(
				'/astral.ics',
				eventIcs('\u{10000}', '20260102T100000Z', '20260102T110000Z'),
			),
			successfulResource('/bmp.ics', eventIcs('\uE000', '20260102T100000Z', '20260102T110000Z')),
			successfulResource('/early.ics', eventIcs('z', '20260102T090000Z', '20260102T093000Z')),
		];
		vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
			throw new Error('Locale comparison is forbidden.');
		});

		for (const responses of [entries.join(''), [...entries].reverse().join('')]) {
			const result = await queryCalendarEventsByTimeRange(
				mockTransport(async () => transportResponse(multistatus(responses))),
				CALENDAR_URL,
				RANGE,
			);

			expect(result.map(({ event }) => [event.uid, event.resourceUrl])).toEqual([
				['z', 'https://partition.example.test/early.ics'],
				['same', 'https://partition.example.test/a.ics'],
				['same', 'https://partition.example.test/z.ics'],
				['\uE000', 'https://partition.example.test/bmp.ics'],
				['\u{10000}', 'https://partition.example.test/astral.ics'],
			]);
		}
	});
});

describe('recurrence, lower errors, protocol failures, and byte limits', () => {
	it('returns one server-selected recurring resource with its master and exceptions unexpanded', async () => {
		const recurring = eventIcs('recurring-resource', '20260101T100000Z', '20260101T103000Z', {
			rrule: 'FREQ=DAILY;COUNT=3',
			exceptionStart: '20260102T100000Z',
		});
		const xml = multistatus(successfulResource('/recurring.ics', recurring));

		const result = await queryCalendarEventsByTimeRange(
			mockTransport(async () => transportResponse(xml)),
			CALENDAR_URL,
			{
				start: new Date('2026-01-02T09:00:00Z'),
				end: new Date('2026-01-02T11:00:00Z'),
			},
		);

		expect(result).toHaveLength(1);
		expect(result[0]!.event).toMatchObject({
			uid: 'recurring-resource',
			start: '2026-01-01T10:00:00Z',
		});
		expect(result[0]!.context.exceptions).toHaveLength(1);
	});

	it('preserves an iCalendar parse failure and returns no partial results', async () => {
		const malformed = eventIcs('private-malformed-sentinel').slice(0, -2);
		const xml = multistatus(
			successfulResource('/valid.ics', eventIcs('valid')) +
				successfulResource('/malformed.ics', malformed),
		);
		const error = await captureFailure(mockTransport(async () => transportResponse(xml)));

		expect(error).toBeInstanceOf(CalDavICalendarParseError);
		expect(error).toMatchObject({ name: 'CalDavICalendarParseError' });
		expect(String(error)).not.toContain('private-malformed-sentinel');
	});

	it('preserves an unsupported event read-model failure atomically', async () => {
		const unsupported = eventIcs('private-tzid-sentinel').replace(
			'DTSTART:20260102T100000Z',
			'DTSTART;TZID=Private/Sentinel:20260102T100000',
		);
		const xml = multistatus(
			successfulResource('/valid.ics', eventIcs('valid')) +
				successfulResource('/unsupported.ics', unsupported),
		);
		const error = await captureFailure(mockTransport(async () => transportResponse(xml)));

		expect(error).toBeInstanceOf(CalDavCalendarEventReadModelError);
		expect(error).toMatchObject({
			code: CalendarEventReadModelErrorCode.UNSUPPORTED_EVENT_TIME,
		});
		expect(String(error)).not.toContain('private-tzid-sentinel');
		expect(String(error)).not.toContain('Private/Sentinel');
	});

	it('preserves the parser 5 MiB resource bound independently', async () => {
		const oversized = eventIcs('oversized').replace(
			'END:VEVENT',
			`X-SYNTHETIC:${'x'.repeat(ICALENDAR_MAX_RESOURCE_BYTES)}\r\nEND:VEVENT`,
		);
		const xml = multistatus(successfulResource('/oversized.ics', oversized));
		const error = await captureFailure(mockTransport(async () => transportResponse(xml)));

		expect(error).toBeInstanceOf(CalDavICalendarParseError);
		expect(error).toMatchObject({ code: 'MAX_RESOURCE_SIZE_EXCEEDED' });
	});

	it('accepts an exact 10 MiB transport response and preserves a transport +1-byte failure', async () => {
		const base = Buffer.from(multistatus(), 'utf8');
		const exactBody = Buffer.concat([
			base,
			Buffer.alloc(CALDAV_MAX_RESPONSE_BYTES - base.byteLength, 0x20),
		]);
		const exactTransport = mockTransport(async () => ({
			...transportResponse(multistatus()),
			body: exactBody,
		}));

		await expect(
			queryCalendarEventsByTimeRange(exactTransport, CALENDAR_URL, RANGE),
		).resolves.toEqual([]);

		const transportLimit = new CalDavResponseLimitError();
		const rejectingTransport = mockTransport(async () => {
			throw transportLimit;
		});
		await expect(
			queryCalendarEventsByTimeRange(rejectingTransport, CALENDAR_URL, RANGE),
		).rejects.toBe(transportLimit);
		expect(rejectingTransport.request).toHaveBeenCalledTimes(1);
	});

	it.each([
		[
			'non-207 response',
			transportResponse(multistatus(), 200),
			CalDavXmlProtocolError,
			'INVALID_MULTISTATUS',
		],
		[
			'wrong root',
			transportResponse('<d:response xmlns:d="DAV:"/>'),
			CalDavXmlProtocolError,
			'INVALID_MULTISTATUS',
		],
		[
			'malformed XML',
			transportResponse('<d:multistatus xmlns:d="DAV:">'),
			CalDavXmlParseError,
			'TRUNCATED_XML',
		],
		[
			'invalid propstat',
			transportResponse(
				multistatus(
					'<d:response><d:href>/x.ics</d:href><d:propstat><d:prop/></d:propstat></d:response>',
				),
			),
			CalDavXmlProtocolError,
			'INVALID_PROPSTAT',
		],
		[
			'invalid status',
			transportResponse(multistatus(statusResponse('/x.ics', 'private-invalid-status'))),
			CalDavXmlProtocolError,
			'INVALID_STATUS',
		],
		[
			'successful status-form response',
			transportResponse(multistatus(statusResponse('/x.ics', 'HTTP/1.1 204 No Content'))),
			CalDavXmlProtocolError,
			'INVALID_RESPONSE',
		],
		[
			'multiple hrefs in one failed status-form response',
			transportResponse(
				multistatus(
					'<d:response><d:href>/x.ics</d:href><d:href>/y.ics</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>',
				),
			),
			CalDavXmlProtocolError,
			'INVALID_RESPONSE',
		],
	] as const)('preserves the contracted %s failure', async (_label, response, errorType, code) => {
		const error = await captureFailure(mockTransport(async () => response));

		expect(error).toBeInstanceOf(errorType);
		expect(error).toMatchObject({ code });
		expect(String(error)).not.toContain('private-invalid-status');
	});
});

describe('event time-range immutability, privacy, and side effects', () => {
	it('does not mutate inputs or response data and performs no ambient side effects', async () => {
		const start = new Date('2026-01-02T00:00:00Z');
		const end = new Date('2026-01-02T00:00:01Z');
		const range = Object.freeze({ start, end });
		const xml = multistatus(successfulResource('/immutable.ics', eventIcs('immutable')));
		const response = transportResponse(xml);
		const bodySnapshot = Buffer.from(response.body);
		const transport = mockTransport(async () => response);
		const fetchSpy = vi.fn(() => {
			throw new Error('Unexpected ambient fetch.');
		});
		vi.stubGlobal('fetch', fetchSpy);
		const consoleSpies = [
			vi.spyOn(console, 'log').mockImplementation(() => undefined),
			vi.spyOn(console, 'warn').mockImplementation(() => undefined),
			vi.spyOn(console, 'error').mockImplementation(() => undefined),
		];
		const startTime = start.getTime();
		const endTime = end.getTime();

		const result = await queryCalendarEventsByTimeRange(transport, CALENDAR_URL, range);

		expect(start.getTime()).toBe(startTime);
		expect(end.getTime()).toBe(endTime);
		expect(transport.serverUrl).toBe('https://configured.example.test/');
		expect(response.body.equals(bodySnapshot)).toBe(true);
		expect(response.effectiveUrl).toBe(EFFECTIVE_URL);
		expect(fetchSpy).not.toHaveBeenCalled();
		for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
		expectDeeplyFrozen(result);
	});
});
