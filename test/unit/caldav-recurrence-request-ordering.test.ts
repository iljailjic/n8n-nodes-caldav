import { describe, expect, it, vi } from 'vitest';

import { createCalendarEvent } from '../../nodes/CalDav/events/create';
import type { CalendarEventCreateInput } from '../../nodes/CalDav/events/create';
import type { RecurrenceRule } from '../../nodes/CalDav/icalendar/recurrence';
import { CalDavMethod } from '../../nodes/CalDav/transport/http';
import type {
	CalDavTransport,
	CalDavTransportRequest,
	CalDavTransportResponse,
} from '../../nodes/CalDav/transport/http';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';

const CALENDAR_URL = validateAbsoluteHttpUrl('https://calendar.example.test/calendars/work/');
const RESOURCE_URL = validateAbsoluteHttpUrl(
	'https://calendar.example.test/calendars/work/cmVjdXJyaW5nLXV0Y0BleGFtcGxlLnRlc3Q.ics',
);
const RECURRENCE: RecurrenceRule = Object.freeze({
	frequency: 'daily',
	end: Object.freeze({ kind: 'count', count: 3 }),
});

type MockTransport = CalDavTransport & { request: ReturnType<typeof vi.fn> };

function response(statusCode: number, effectiveUrl: string, body = ''): CalDavTransportResponse {
	return {
		statusCode,
		effectiveUrl,
		headers: {},
		etag: '"authoritative-etag"',
		body: Buffer.from(body, 'utf8'),
	};
}

function recurringInput(): CalendarEventCreateInput {
	return {
		calendarUrl: CALENDAR_URL,
		uid: 'recurring-utc@example.test',
		timeMode: 'timed',
		start: new Date('2040-01-02T10:00:00Z'),
		end: new Date('2040-01-02T11:00:00Z'),
		summary: 'Recurring UTC event',
		recurrence: RECURRENCE,
	} as unknown as CalendarEventCreateInput;
}

describe('recurrence Create request ordering', () => {
	it('validates and authors recurrence before one conditional PUT and uses its authoritative ETag', async () => {
		const requests: MockTransport = {
			serverUrl: 'https://calendar.example.test/',
			request: vi.fn(async (request: CalDavTransportRequest) => {
				if (request.method === CalDavMethod.PUT) return response(201, request.url);
				throw new Error(`Unexpected method ${request.method}.`);
			}),
		};
		const clock = vi.fn(() => new Date('2040-01-01T00:00:00Z'));

		const created = await createCalendarEvent(requests, recurringInput(), clock);

		const history = requests.request.mock.calls.map(
			([request]) => request as CalDavTransportRequest,
		);
		expect(history.map(({ method }) => method)).toEqual([CalDavMethod.PUT]);
		expect(history.every(({ url }) => url === RESOURCE_URL)).toBe(true);
		expect(history[0]).toMatchObject({
			headers: {
				'If-None-Match': '*',
				'Content-Type': 'text/calendar; charset=utf-8',
			},
		});
		const unfolded = history[0]!.body?.replace(/\r\n[ \t]/gu, '') ?? '';
		expect(unfolded.match(/^RRULE:/gmu) ?? []).toHaveLength(1);
		expect(unfolded).toContain(
			'DTEND:20400102T110000Z\r\nRRULE:FREQ=DAILY;COUNT=3\r\nSUMMARY:Recurring UTC event',
		);
		expect(unfolded).not.toMatch(/RECURRENCE-ID|EXDATE|RDATE/iu);
		expect(created).toMatchObject({
			uid: 'recurring-utc@example.test',
			etag: '"authoritative-etag"',
			recurrence: RECURRENCE,
		});
		expect(clock).toHaveBeenCalledOnce();
	});
});
