import { describe, expect, it, vi } from 'vitest';

import { createCalendarEvent } from '../../nodes/CalDav/events/create';
import { getCalendarEventByResourceUrl } from '../../nodes/CalDav/events/getByResourceUrl';
import { deleteCalendarEventResource } from '../../nodes/CalDav/events/mutations';
import { queryCalendarEventsByTimeRange } from '../../nodes/CalDav/events/timeRangeQuery';
import { updateCalendarEvent } from '../../nodes/CalDav/events/update';
import type { CalendarEventUpdateInput } from '../../nodes/CalDav/events/update';
import type { CalendarEventPatch } from '../../nodes/CalDav/icalendar/patcher';
import { CalDavMethod } from '../../nodes/CalDav/transport/http';
import type {
	CalDavTransport,
	CalDavTransportRequest,
	CalDavTransportResponse,
} from '../../nodes/CalDav/transport/http';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';
import {
	allDayEvent,
	calendarObject,
	durationEvent,
	eventComponent,
	floatingEvent,
	timedEvent,
} from './fixtures/events/all-day-contract-fixtures';

const CALENDAR_URL = validateAbsoluteHttpUrl('https://calendar.example.test/calendars/all-day/');
const RESOURCE_URL = validateAbsoluteHttpUrl(
	'https://calendar.example.test/calendars/all-day/authoritative.ics',
);
const CANONICAL_URL = validateAbsoluteHttpUrl(
	'https://calendar.example.test/calendars/all-day/canonical.ics',
);

type MockTransport = CalDavTransport & { readonly request: ReturnType<typeof vi.fn> };

function response(
	statusCode: number,
	effectiveUrl: string,
	options: { readonly body?: string; readonly etag?: string; readonly includeEtag?: boolean } = {},
): CalDavTransportResponse {
	return {
		statusCode,
		effectiveUrl,
		headers: {},
		...(options.includeEtag === false ? {} : { etag: options.etag ?? '"issue-41-etag"' }),
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

function propstat(properties: string): string {
	return `<d:propstat><d:prop>${properties}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>`;
}

function xmlText(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
}

function resourceResponse(href: string, ics: string, etag = '"query-etag"'): string {
	return `<d:response><d:href>${xmlText(href)}</d:href>${propstat(
		`<d:getetag>${xmlText(etag)}</d:getetag><c:calendar-data>${xmlText(ics)}</c:calendar-data>`,
	)}</d:response>`;
}

function multistatus(resources: readonly string[]): string {
	return `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${resources.join('')}</d:multistatus>`;
}

function issue41CreateInput(timeMode: 'timed' | 'allDay') {
	return {
		calendarUrl: CALENDAR_URL,
		uid: 'authoritative-create',
		timeMode,
		...(timeMode === 'timed'
			? {
					start: new Date('2024-02-29T10:00:00Z'),
					end: new Date('2024-02-29T11:00:00Z'),
				}
			: { startDate: '2024-02-29', endDate: '2024-03-01' }),
		summary: 'Authoritative Create',
	};
}

function issue41Patch(value: Record<string, unknown>): CalendarEventPatch {
	return value as unknown as CalendarEventPatch;
}

describe('issue #41 authoritative Create request flow', () => {
	it('performs exactly conditional PUT then one authoritative GET and returns canonical current state', async () => {
		const requests = transport(async (request) => {
			if (request.method === CalDavMethod.PUT) {
				return response(201, request.url, { etag: '"provisional-put-etag"' });
			}
			return response(200, CANONICAL_URL, {
				etag: ' W/"authoritative-etag" ',
				body: allDayEvent('authoritative-create', '20240229', '20240301').replace(
					'SUMMARY:All-day authoritative-create',
					'SUMMARY:Server authoritative summary',
				),
			});
		});

		const result = await createCalendarEvent(
			requests,
			issue41CreateInput('allDay') as never,
			() => new Date('2040-01-01T00:00:00.987Z'),
		);

		expect(requests.request).toHaveBeenCalledTimes(2);
		const observed = requests.request.mock.calls.map(
			([request]) => request as CalDavTransportRequest,
		);
		expect(observed.map(({ method }) => method)).toEqual([CalDavMethod.PUT, CalDavMethod.GET]);
		expect(observed[0]).toMatchObject({
			headers: {
				'If-None-Match': '*',
				'Content-Type': 'text/calendar; charset=utf-8',
			},
		});
		expect(observed[0]?.body).toContain('DTSTART;VALUE=DATE:20240229\r\n');
		expect(observed[0]?.body).toContain('DTEND;VALUE=DATE:20240301\r\n');
		expect(observed[1]).toEqual({ method: CalDavMethod.GET, url: observed[0]?.url });
		expect(result).toEqual({
			calendarUrl: CALENDAR_URL,
			resourceUrl: CANONICAL_URL,
			etag: ' W/"authoritative-etag" ',
			uid: 'authoritative-create',
			summary: 'Server authoritative summary',
			timeMode: 'allDay',
			accessMode: 'editable',
			startDate: '2024-02-29',
			endDate: '2024-03-01',
		});
	});

	it('treats a safely identified read-only transformation as successful completion', async () => {
		const requests = transport(async (request) =>
			request.method === CalDavMethod.PUT
				? response(201, request.url)
				: response(200, request.url, {
						etag: '"read-only-current"',
						body: floatingEvent('authoritative-create').replace(
							'SUMMARY:Floating authoritative-create',
							'SUMMARY:Server changed representation',
						),
					}),
		);

		await expect(
			createCalendarEvent(
				requests,
				issue41CreateInput('timed') as never,
				() => new Date('2040-01-01T00:00:00Z'),
			),
		).resolves.toMatchObject({
			uid: 'authoritative-create',
			timeMode: 'unsupported',
			accessMode: 'readOnly',
			readOnlyReason: 'unsupportedTimeRepresentation',
		});
		expect(requests.request).toHaveBeenCalledTimes(2);
	});

	it('reports a sanitized partial success for malformed confirmation without retry or rollback', async () => {
		const privateSentinels = [
			'private-create-uid',
			'https://private.example.test/path/event.ics',
			'W/"private-etag"',
			'Private/TZID',
		];
		const malformed = calendarObject([
			...eventComponent('private-create-uid', [
				'DTSTART;TZID=Private/TZID:20240229T100000',
				'DTEND;TZID=Private/TZID:20240229T110000',
			]),
			...eventComponent('conflicting-private-uid', [
				'DTSTART:20240229T100000Z',
				'DTEND:20240229T110000Z',
			]),
		]);
		const requests = transport(async (request) =>
			request.method === CalDavMethod.PUT
				? response(201, request.url)
				: response(200, 'https://private.example.test/path/event.ics', {
						etag: 'W/"private-etag"',
						body: malformed,
					}),
		);

		let failure: unknown;
		try {
			await createCalendarEvent(
				requests,
				{ ...issue41CreateInput('allDay'), uid: 'private-create-uid' } as never,
				() => new Date('2040-01-01T00:00:00Z'),
			);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		expect(requests.request).toHaveBeenCalledTimes(2);
		expect(requests.request.mock.calls.map(([request]) => request.method)).toEqual([
			CalDavMethod.PUT,
			CalDavMethod.GET,
		]);
		expect(requests.request.mock.calls.flat()).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ method: CalDavMethod.DELETE })]),
		);
		for (const sentinel of privateSentinels)
			expect(JSON.stringify(failure)).not.toContain(sentinel);
	});
});

describe('issue #41 read-only Update and Delete request boundaries', () => {
	it('rejects structured Update with the exact message after resolution and before patch/PUT', async () => {
		const requests = transport(async (request) =>
			response(200, request.url, {
				etag: '"read-only-etag"',
				body: floatingEvent('read-only-update'),
			}),
		);
		const input: CalendarEventUpdateInput = {
			calendarUrl: CALENDAR_URL,
			identifier: { kind: 'resourceUrl', resourceUrl: RESOURCE_URL },
			patch: issue41Patch({ summary: { kind: 'set', value: 'Forbidden structured edit' } }),
		};

		await expect(
			updateCalendarEvent(requests, input, () => new Date('2040-01-01T00:00:00Z')),
		).rejects.toThrow(
			'The calendar event is read-only because its time representation is unsupported.',
		);
		expect(requests.request).toHaveBeenCalledTimes(1);
		expect(requests.request.mock.calls[0]?.[0]).toMatchObject({ method: CalDavMethod.GET });
	});

	it('stops a recurrence-bearing time change after the mandatory resolution GET and before PUT', async () => {
		const requests = transport(async (request) =>
			response(200, request.url, {
				etag: '"recurrence-etag"',
				body: allDayEvent('recurrence-blocked', '20240229', '20240301', ['RRULE:FREQ=DAILY']),
			}),
		);
		const input: CalendarEventUpdateInput = {
			calendarUrl: CALENDAR_URL,
			identifier: { kind: 'resourceUrl', resourceUrl: RESOURCE_URL },
			patch: issue41Patch({
				timeMode: 'allDay',
				endDate: { kind: 'set', value: '2024-03-02' },
			}),
		};

		await expect(
			updateCalendarEvent(requests, input, () => new Date('2040-01-01T00:00:00Z')),
		).rejects.toThrow();
		expect(requests.request).toHaveBeenCalledTimes(1);
		expect(requests.request.mock.calls[0]?.[0]).toMatchObject({ method: CalDavMethod.GET });
	});

	it('allows exact conditional Delete after a safe read-only identity resolution', async () => {
		const requests = transport(async (request) =>
			request.method === CalDavMethod.GET
				? response(200, request.url, {
						etag: ' W/"read-only-delete" ',
						body: floatingEvent('read-only-delete'),
					})
				: response(204, request.url, { includeEtag: false }),
		);
		const resolved = await getCalendarEventByResourceUrl(requests, CALENDAR_URL, RESOURCE_URL);
		expect(resolved.event).toMatchObject({ accessMode: 'readOnly', uid: 'read-only-delete' });
		await deleteCalendarEventResource(
			requests,
			resolved.event.calendarUrl,
			resolved.event.resourceUrl,
			resolved.event.etag!,
		);
		expect(requests.request).toHaveBeenCalledTimes(2);
		expect(requests.request.mock.calls[1]?.[0]).toEqual({
			method: CalDavMethod.DELETE,
			url: RESOURCE_URL,
			headers: { 'If-Match': ' W/"read-only-delete" ' },
		});
	});
});

describe('issue #41 fixed-UTC Get Many query and mixed results', () => {
	it('sends one REPORT with fixed UTC CALDAV:timezone and the unchanged half-open UTC range', async () => {
		const requests = transport(async (request) =>
			response(207, request.url, { body: multistatus([]) }),
		);
		await queryCalendarEventsByTimeRange(requests, CALENDAR_URL, {
			start: new Date('2024-02-29T00:00:00Z'),
			end: new Date('2024-03-01T00:00:00Z'),
		});
		const request = requests.request.mock.calls[0]?.[0] as CalDavTransportRequest;
		expect(requests.request).toHaveBeenCalledTimes(1);
		expect(request).toMatchObject({ method: CalDavMethod.REPORT, url: CALENDAR_URL });
		expect(request.body).toContain('<c:timezone>');
		expect(request.body).toContain('BEGIN:VTIMEZONE');
		expect(request.body).toMatch(/TZID:(?:UTC|Etc\/UTC)/);
		expect(request.body).toContain('TZOFFSETFROM:+0000');
		expect(request.body).toContain('TZOFFSETTO:+0000');
		expect(request.body).toContain(
			'<c:time-range start="20240229T000000Z" end="20240301T000000Z"/>',
		);
		expect(request.body).not.toMatch(/startDate|endDate|timeMode|expand/i);
	});

	it('sorts supported events by effective UTC start, then read-only by Unicode UID/URL', async () => {
		const body = multistatus([
			resourceResponse('/calendars/all-day/z-read-only.ics', floatingEvent('z-read-only')),
			resourceResponse(
				'/calendars/all-day/all-day.ics',
				allDayEvent('all-day', '20240229', '20240301'),
			),
			resourceResponse(
				'/calendars/all-day/timed-later.ics',
				timedEvent('timed-later', '20240229T120000Z', '20240229T130000Z'),
			),
			resourceResponse('/calendars/all-day/a-read-only.ics', durationEvent('a-read-only')),
			resourceResponse(
				'/calendars/all-day/timed-earlier.ics',
				timedEvent('timed-earlier', '20240228T230000Z', '20240229T000000Z'),
			),
		]);
		const requests = transport(async (request) => response(207, request.url, { body }));

		const result = await queryCalendarEventsByTimeRange(requests, CALENDAR_URL, {
			start: new Date('2024-02-28T00:00:00Z'),
			end: new Date('2024-03-02T00:00:00Z'),
		});
		expect(result.map(({ event }) => event.uid)).toEqual([
			'timed-earlier',
			'all-day',
			'timed-later',
			'a-read-only',
			'z-read-only',
		]);
		expect(result.slice(-2).map(({ event }) => event.timeMode)).toEqual([
			'unsupported',
			'unsupported',
		]);
	});

	it('keeps a hard per-resource failure atomic even when another resource is valid', async () => {
		const conflicting = calendarObject([
			...eventComponent('identity-one', ['DTSTART:20240229T100000Z', 'DTEND:20240229T110000Z']),
			...eventComponent('identity-two', [
				'RECURRENCE-ID:20240301T100000Z',
				'DTSTART:20240301T100000Z',
				'DTEND:20240301T110000Z',
			]),
		]);
		const body = multistatus([
			resourceResponse('/calendars/all-day/valid.ics', allDayEvent('valid')),
			resourceResponse('/calendars/all-day/invalid.ics', conflicting),
		]);
		const requests = transport(async (request) => response(207, request.url, { body }));

		await expect(
			queryCalendarEventsByTimeRange(requests, CALENDAR_URL, {
				start: new Date('2024-02-28T00:00:00Z'),
				end: new Date('2024-03-02T00:00:00Z'),
			}),
		).rejects.toThrow();
		expect(requests.request).toHaveBeenCalledTimes(1);
	});
});
