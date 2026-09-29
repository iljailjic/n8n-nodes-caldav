import { describe, expect, it, vi } from 'vitest';

import { createCalendarEvent } from '../../nodes/CalDav/events/create';
import { updateCalendarEvent } from '../../nodes/CalDav/events/update';
import { upsertCalendarEvent } from '../../nodes/CalDav/events/upsert';
import type { CalendarEventUpsertDependencies } from '../../nodes/CalDav/events/upsert';
import { CalDavMethod } from '../../nodes/CalDav/transport/http';
import type {
	CalDavTransport,
	CalDavTransportRequest,
	CalDavTransportResponse,
} from '../../nodes/CalDav/transport/http';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';
import {
	compactEventIcs,
	multiStatus,
	reportResponse,
	xmlText,
} from './fixtures/events/raw-ics-contract-fixtures';

const CALENDAR_URL = validateAbsoluteHttpUrl('https://calendar.example.test/calendars/raw/');
const UID = 'raw-contract-event';
const GENERATED_UID = '00000000-0000-4000-8000-000000000050';
const START = new Date('2040-01-02T10:00:00Z');
const END = new Date('2040-01-02T10:30:00Z');
const CLOCK = new Date('2040-01-01T00:00:00Z');
const SUMMARY = 'Raw contract event';

type MockTransport = CalDavTransport & { readonly request: ReturnType<typeof vi.fn> };

function response(
	statusCode: number,
	effectiveUrl: string,
	options: { readonly body?: string; readonly etag?: string } = {},
): CalDavTransportResponse {
	return {
		statusCode,
		effectiveUrl,
		headers: {},
		etag: options.etag ?? ' W/"raw-etag" ',
		body: Buffer.from(options.body ?? '', 'utf8'),
	};
}

function transport(
	implementation: (request: CalDavTransportRequest) => Promise<CalDavTransportResponse>,
): MockTransport {
	return {
		serverUrl: 'https://calendar.example.test/',
		request: vi.fn(implementation),
	};
}

function methods(value: MockTransport): CalDavMethod[] {
	return value.request.mock.calls.map(([request]) => (request as CalDavTransportRequest).method);
}

function dependencies(): CalendarEventUpsertDependencies {
	return {
		clock: vi.fn(() => CLOCK),
		uidFactory: vi.fn(() => GENERATED_UID),
	};
}

describe('Raw ICS mutation result and request matrix contract', () => {
	it('Structured Create returns authoritative metadata without rawIcs after GET', async () => {
		const requests = transport(async (request) => {
			if (request.method === CalDavMethod.PUT) {
				return response(201, request.url!, { etag: ' W/"created" ' });
			}
			return response(200, request.url!, {
				body: compactEventIcs(UID, SUMMARY),
				etag: ' W/"created" ',
			});
		});

		const result = await createCalendarEvent(
			requests,
			{
				calendarUrl: CALENDAR_URL,
				uid: UID,
				timeMode: 'timed',
				start: START,
				end: END,
				summary: SUMMARY,
			},
			() => CLOCK,
		);

		expect(methods(requests)).toEqual([CalDavMethod.PUT, CalDavMethod.GET]);
		expect(result).not.toHaveProperty('rawIcs');
	});

	it('Upsert structured Create remains raw-free and confirms its authored PUT by GET', async () => {
		const requests = transport(async (request) =>
			request.method === CalDavMethod.PUT
				? response(201, request.url!, { etag: ' W/"created" ' })
				: response(200, request.url!, {
						body: compactEventIcs(GENERATED_UID, SUMMARY),
						etag: ' W/"confirmed" ',
					}),
		);

		const result = await upsertCalendarEvent(
			requests,
			{
				calendarUrl: CALENDAR_URL,
				timeMode: 'timed',
				start: START,
				end: END,
				summary: SUMMARY,
			},
			dependencies(),
		);

		expect(methods(requests)).toEqual([CalDavMethod.PUT, CalDavMethod.GET]);
		expect(result).toMatchObject({ action: 'create' });
		expect(result.event).not.toHaveProperty('rawIcs');
	});

	it('Upsert semantic no-op returns the exact lookup snapshot and performs no PUT or GET', async () => {
		const rawIcs = compactEventIcs(UID, SUMMARY);
		const requests = transport(async () =>
			response(207, CALENDAR_URL, {
				body: multiStatus(
					reportResponse('raw-contract-event.ics', ' W/"lookup" ', xmlText(rawIcs)),
				),
			}),
		);

		const result = await upsertCalendarEvent(
			requests,
			{
				calendarUrl: CALENDAR_URL,
				uid: UID,
				timeMode: 'timed',
				start: START,
				end: END,
				summary: SUMMARY,
			},
			dependencies(),
		);

		expect(methods(requests)).toEqual([CalDavMethod.REPORT]);
		expect(result).toMatchObject({
			action: 'update',
			event: { rawIcs: rawIcs.replaceAll('\r\n', '\n') },
		});
	});

	it('Update returns only the authoritative post-PUT GET body', async () => {
		const initialRawIcs = compactEventIcs(UID, 'Before update');
		let finalRawIcs: string | undefined;
		const resourceUrl = validateAbsoluteHttpUrl(`${CALENDAR_URL}raw-contract-event.ics`);
		const requests = transport(async (request) => {
			if (request.method === CalDavMethod.PUT) {
				finalRawIcs = request.body;
				return response(204, request.url!);
			}
			return response(200, request.url!, {
				body: finalRawIcs ?? initialRawIcs,
				etag: finalRawIcs === undefined ? ' W/"lookup" ' : ' W/"confirmed" ',
			});
		});

		const result = await updateCalendarEvent(
			requests,
			{
				calendarUrl: CALENDAR_URL,
				identifier: { kind: 'resourceUrl', resourceUrl },
				patch: { summary: { kind: 'set', value: SUMMARY } },
			},
			() => CLOCK,
		);

		expect(methods(requests)).toEqual([CalDavMethod.GET, CalDavMethod.PUT, CalDavMethod.GET]);
		expect(finalRawIcs).toBeDefined();
		expect((result as unknown as { rawIcs: string }).rawIcs).toBe(finalRawIcs);
		expect((result as unknown as { rawIcs: string }).rawIcs).not.toBe(initialRawIcs);
	});

	it('Upsert changed Update returns final GET raw data rather than its UID lookup snapshot', async () => {
		const lookupRawIcs = compactEventIcs(UID, 'Before update');
		let finalRawIcs: string | undefined;
		const requests = transport(async (request) => {
			if (request.method === CalDavMethod.REPORT) {
				return response(207, CALENDAR_URL, {
					body: multiStatus(
						reportResponse('raw-contract-event.ics', ' W/"lookup" ', xmlText(lookupRawIcs)),
					),
				});
			}
			if (request.method === CalDavMethod.PUT) {
				finalRawIcs = request.body;
				return response(204, request.url!);
			}
			return response(200, request.url!, {
				body: finalRawIcs!,
				etag: ' W/"confirmed" ',
			});
		});

		const result = await upsertCalendarEvent(
			requests,
			{
				calendarUrl: CALENDAR_URL,
				uid: UID,
				timeMode: 'timed',
				start: START,
				end: END,
				summary: SUMMARY,
			},
			dependencies(),
		);

		expect(methods(requests)).toEqual([CalDavMethod.REPORT, CalDavMethod.PUT, CalDavMethod.GET]);
		expect(finalRawIcs).toBeDefined();
		expect(result).toMatchObject({ action: 'update', event: { rawIcs: finalRawIcs } });
		expect((result.event as unknown as { rawIcs: string }).rawIcs).not.toBe(lookupRawIcs);
	});
});
