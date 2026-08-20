// Node streams are required for deterministic offline response-boundary tests.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { Readable } from 'node:stream';

import type { IN8nHttpFullResponse } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';

import { getCalendarEventByResourceUrl } from '../../nodes/CalDav/events/getByResourceUrl';
import { resolveCalendarEventByUid } from '../../nodes/CalDav/events/resolveByUid';
import { queryCalendarEventsByTimeRange } from '../../nodes/CalDav/events/timeRangeQuery';
import {
	CalDavICalendarParseError,
	ICALENDAR_MAX_RESOURCE_BYTES,
} from '../../nodes/CalDav/icalendar/parser';
import {
	CALDAV_MAX_RESPONSE_BYTES,
	CalDavMethod,
	CalDavResponseLimitError,
	createCalDavTransport,
} from '../../nodes/CalDav/transport/http';
import type {
	CalDavRequestHelperAdapter,
	CalDavTransport,
	CalDavTransportResponse,
} from '../../nodes/CalDav/transport/http';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';
import {
	RAW_ICS_FIDELITY_FIXTURE,
	RAW_ICS_PRIVATE_SENTINEL,
	compactEventIcs,
	exactSizeEventIcs,
	multiStatus,
	reportResponse,
	xmlText,
} from './fixtures/events/raw-ics-contract-fixtures';

const CALENDAR_URL = validateAbsoluteHttpUrl('https://calendar.example.test/calendars/raw/');
const RESOURCE_URL = validateAbsoluteHttpUrl(
	'https://calendar.example.test/calendars/raw/raw-event.ics',
);
const RANGE = Object.freeze({
	start: new Date('2040-01-01T00:00:00Z'),
	end: new Date('2041-01-01T00:00:00Z'),
});

type MockTransport = CalDavTransport & { readonly request: ReturnType<typeof vi.fn> };

function transportResponse(
	body: Buffer,
	options: {
		readonly statusCode?: number;
		readonly contentType?: string;
		readonly etag?: string;
		readonly effectiveUrl?: string;
	} = {},
): CalDavTransportResponse {
	return {
		statusCode: options.statusCode ?? 200,
		headers: Object.freeze(
			options.contentType === undefined ? {} : { 'content-type': options.contentType },
		),
		effectiveUrl: options.effectiveUrl ?? RESOURCE_URL,
		etag: options.etag ?? ' W/"raw-etag" ',
		body,
	};
}

function mockTransport(response: CalDavTransportResponse): MockTransport {
	return {
		serverUrl: 'https://calendar.example.test/',
		request: vi.fn(async () => response),
	};
}

function rawIcs(result: unknown): string | undefined {
	return (result as { readonly rawIcs?: string }).rawIcs;
}

async function captureFailure(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error('Expected the Raw ICS operation to fail.');
}

describe('Raw ICS direct GET provenance, decoding, and fidelity contract', () => {
	it('returns the exact selected GET body with the same UID, URL, and ETag after one request', async () => {
		const response = transportResponse(Buffer.from(RAW_ICS_FIDELITY_FIXTURE, 'utf8'), {
			contentType: 'text/calendar',
		});
		const transport = mockTransport(response);

		const result = await getCalendarEventByResourceUrl(transport, CALENDAR_URL, RESOURCE_URL);

		expect(rawIcs(result)).toBe(RAW_ICS_FIDELITY_FIXTURE);
		expect(result.event).toMatchObject({
			uid: 'raw-fidelity@example.test',
			resourceUrl: RESOURCE_URL,
			etag: ' W/"raw-etag" ',
		});
		expect(result.context.resource.originalIcs).toBe(RAW_ICS_FIDELITY_FIXTURE);
		expect(transport.request).toHaveBeenCalledOnce();
		expect(transport.request).toHaveBeenCalledWith({ method: CalDavMethod.GET, url: RESOURCE_URL });
	});

	it.each(['UTF-8', 'utf8', 'Us-AsCiI'])(
		'accepts the contracted %s charset spelling without changing ASCII content',
		async (charset) => {
			const ics = compactEventIcs('charset@example.test', 'ASCII summary');
			const result = await getCalendarEventByResourceUrl(
				mockTransport(
					transportResponse(Buffer.from(ics, 'ascii'), {
						contentType: `text/calendar; charset=${charset}`,
					}),
				),
				CALENDAR_URL,
				RESOURCE_URL,
			);

			expect(rawIcs(result)).toBe(ics);
		},
	);

	it('removes one leading UTF-8 BOM while retaining mixed Unicode exactly', async () => {
		const ics = compactEventIcs('bom@example.test', 'Žluťoučký — 東京');
		const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(ics, 'utf8')]);
		const result = await getCalendarEventByResourceUrl(
			mockTransport(transportResponse(body, { contentType: 'text/calendar; charset=UTF-8' })),
			CALENDAR_URL,
			RESOURCE_URL,
		);

		expect(rawIcs(result)).toBe(ics);
		expect(result.context.resource.originalIcs).toBe(ics);
	});

	it.each([
		['overlong UTF-8', Buffer.from([0xc0, 0xaf]), 'text/calendar'],
		[
			'non-ASCII octet under US-ASCII',
			Buffer.from(compactEventIcs('ascii@example.test', 'é'), 'utf8'),
			'text/calendar; charset=US-ASCII',
		],
		[
			'unsupported charset',
			Buffer.from(compactEventIcs('latin@example.test', 'private'), 'utf8'),
			'text/calendar; charset=iso-8859-1',
		],
		[
			'conflicting charsets',
			Buffer.from(compactEventIcs('conflict@example.test', 'private'), 'utf8'),
			'text/calendar; charset=utf-8; charset=us-ascii',
		],
		['UTF-16 BOM', Buffer.from([0xff, 0xfe, 0x42, 0x00]), 'text/calendar; charset=utf-8'],
	] as const)('rejects %s without emitting raw data', async (_label, body, contentType) => {
		const error = await captureFailure(
			getCalendarEventByResourceUrl(
				mockTransport(transportResponse(body, { contentType })),
				CALENDAR_URL,
				RESOURCE_URL,
			),
		);

		expect(error).toBeInstanceOf(Error);
		expect(JSON.stringify(error)).not.toContain('private');
		expect(error).not.toHaveProperty('rawIcs');
	});

	it('accepts exactly 5 MiB and rejects the first byte over without truncation', async () => {
		const atLimit = exactSizeEventIcs();
		expect(Buffer.byteLength(atLimit, 'utf8')).toBe(ICALENDAR_MAX_RESOURCE_BYTES);
		const result = await getCalendarEventByResourceUrl(
			mockTransport(transportResponse(Buffer.from(atLimit, 'utf8'))),
			CALENDAR_URL,
			RESOURCE_URL,
		);
		expect(rawIcs(result)?.length).toBe(atLimit.length);
		expect(rawIcs(result)?.slice(0, 64)).toBe(atLimit.slice(0, 64));
		expect(rawIcs(result)?.slice(-64)).toBe(atLimit.slice(-64));

		const error = await captureFailure(
			getCalendarEventByResourceUrl(
				mockTransport(transportResponse(Buffer.from(`${atLimit}x`, 'utf8'))),
				CALENDAR_URL,
				RESOURCE_URL,
			),
		);
		expect(error).toBeInstanceOf(CalDavICalendarParseError);
		expect(error).toMatchObject({ code: 'MAX_RESOURCE_SIZE_EXCEEDED' });
	}, 30_000);
});

describe('Raw ICS REPORT provenance and XML character semantics', () => {
	it('returns UID REPORT calendar-data after entity, CDATA, and XML newline processing', async () => {
		const markup = [
			'BEGIN:VCALENDAR\r\n',
			'VERSION:2.0\r\n',
			'BEGIN:VEVENT&#13;\n',
			'UID:xml@example.test&#13;\n',
			'DTSTART:20400102T100000Z&#13;\n',
			'DTEND:20400102T103000Z&#13;\n',
			'SUMMARY:Fish &amp; <![CDATA[Chips Ω]]>&#13;\n',
			'END:VEVENT&#13;\n',
			'END:VCALENDAR&#13;\n',
		].join('');
		const expected =
			'BEGIN:VCALENDAR\nVERSION:2.0\n' +
			'BEGIN:VEVENT\r\nUID:xml@example.test\r\nDTSTART:20400102T100000Z\r\n' +
			'DTEND:20400102T103000Z\r\nSUMMARY:Fish & Chips Ω\r\nEND:VEVENT\r\n' +
			'END:VCALENDAR\r\n';
		const xml = multiStatus(reportResponse('/calendars/raw/xml.ics', '"xml-etag"', markup));
		const result = await resolveCalendarEventByUid(
			mockTransport(
				transportResponse(Buffer.from(xml, 'utf8'), {
					statusCode: 207,
					contentType: 'application/xml; charset=utf-8',
					effectiveUrl: CALENDAR_URL,
				}),
			),
			CALENDAR_URL,
			'xml@example.test',
		);

		expect(rawIcs(result)).toBe(expected);
		expect(result.event).toMatchObject({ uid: 'xml@example.test', etag: '"xml-etag"' });
		expect(rawIcs(result)).not.toContain('<d:multistatus');
	});

	it('keeps each Get Many calendar-data value associated with its own resource snapshot', async () => {
		const first = compactEventIcs('a@example.test', 'First & private');
		const second = compactEventIcs('b@example.test', 'Second < private');
		const xml = multiStatus(
			reportResponse('/calendars/raw/a.ics', '"a-etag"', xmlText(first)) +
				reportResponse('/calendars/raw/b.ics', '"b-etag"', xmlText(second)),
		);
		const transport = mockTransport(
			transportResponse(Buffer.from(xml, 'utf8'), {
				statusCode: 207,
				contentType: 'application/xml; charset=utf-8',
				effectiveUrl: CALENDAR_URL,
			}),
		);

		const results = await queryCalendarEventsByTimeRange(transport, CALENDAR_URL, RANGE);

		expect(results.map(({ event }) => event.uid)).toEqual(['a@example.test', 'b@example.test']);
		expect(results.map(rawIcs)).toEqual([
			first.replaceAll('\r\n', '\n'),
			second.replaceAll('\r\n', '\n'),
		]);
		expect(transport.request).toHaveBeenCalledOnce();
	});

	it('fails Get Many atomically when one calendar-data value exceeds 5 MiB', async () => {
		const good = compactEventIcs('good@example.test', 'good');
		const oversized = exactSizeEventIcs(ICALENDAR_MAX_RESOURCE_BYTES + 1);
		const xml = multiStatus(
			reportResponse('/calendars/raw/good.ics', '"good"', xmlText(good)) +
				reportResponse(
					'/calendars/raw/oversized.ics',
					'"oversized"',
					xmlText(oversized).replaceAll('\r\n', '&#13;\n'),
				),
		);
		const error = await captureFailure(
			queryCalendarEventsByTimeRange(
				mockTransport(
					transportResponse(Buffer.from(xml, 'utf8'), {
						statusCode: 207,
						effectiveUrl: CALENDAR_URL,
					}),
				),
				CALENDAR_URL,
				RANGE,
			),
		);

		expect(error).toMatchObject({ code: 'MAX_RESOURCE_SIZE_EXCEEDED' });
		expect(JSON.stringify(error)).not.toContain('good@example.test');
	}, 30_000);

	it('rejects conflicting REPORT encodings without leaking XML or calendar sentinels', async () => {
		const ics = compactEventIcs('encoding@example.test', RAW_ICS_PRIVATE_SENTINEL);
		const xml = multiStatus(
			reportResponse('/calendars/raw/encoding.ics', '"private-etag"', xmlText(ics)),
			'<?xml version="1.0" encoding="UTF-8"?>',
		);
		const consoleSpies = [
			vi.spyOn(console, 'error').mockImplementation(() => undefined),
			vi.spyOn(console, 'warn').mockImplementation(() => undefined),
			vi.spyOn(console, 'log').mockImplementation(() => undefined),
		];
		const error = await captureFailure(
			resolveCalendarEventByUid(
				mockTransport(
					transportResponse(Buffer.from(xml, 'utf8'), {
						statusCode: 207,
						contentType: 'application/xml; charset=US-ASCII',
						effectiveUrl: CALENDAR_URL,
					}),
				),
				CALENDAR_URL,
				'encoding@example.test',
			),
		);

		const serialized = `${String(error)}${JSON.stringify(error)}`;
		expect(serialized).not.toContain(RAW_ICS_PRIVATE_SENTINEL);
		expect(serialized).not.toContain('private-etag');
		expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
	});
});

describe('Raw ICS transport response boundary', () => {
	function response(body: Readable): IN8nHttpFullResponse {
		return { statusCode: 200, headers: {}, body };
	}

	function adapter(body: Readable): CalDavRequestHelperAdapter {
		return {
			request: vi.fn(async () => response(body)),
		};
	}

	it('allows exactly 10 MiB and rejects the first streamed byte over with a safe error', async () => {
		const exact = await createCalDavTransport(
			'https://calendar.example.test/',
			adapter(Readable.from([Buffer.alloc(CALDAV_MAX_RESPONSE_BYTES, 0x61)])),
		).request({ method: CalDavMethod.GET });
		expect(exact.body).toHaveLength(10_485_760);

		const error = await captureFailure(
			createCalDavTransport(
				'https://calendar.example.test/',
				adapter(
					Readable.from([
						Buffer.alloc(CALDAV_MAX_RESPONSE_BYTES, 0x61),
						Buffer.from(RAW_ICS_PRIVATE_SENTINEL),
					]),
				),
			).request({ method: CalDavMethod.GET }),
		);
		expect(error).toBeInstanceOf(CalDavResponseLimitError);
		expect(`${String(error)}${JSON.stringify(error)}`).not.toContain(RAW_ICS_PRIVATE_SENTINEL);
	}, 30_000);
});
