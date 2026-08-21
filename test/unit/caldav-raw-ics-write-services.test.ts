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
import { multiStatus, reportResponse, xmlText } from './fixtures/events/raw-ics-contract-fixtures';

const CALENDAR_URL = validateAbsoluteHttpUrl('https://calendar.example.test/calendars/raw-write/');
const RESOURCE_URL = validateAbsoluteHttpUrl(`${CALENDAR_URL}raw-write.ics`);
const UID = 'raw-write@example.test';
const CLOCK = vi.fn(() => new Date('2040-01-01T00:00:00Z'));

type MockTransport = CalDavTransport & { readonly request: ReturnType<typeof vi.fn> };

function raw(summary: string, extra: readonly string[] = []): string {
	return [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//example.test//Raw service tests//EN',
		'BEGIN:VEVENT',
		`UID:${UID}`,
		'DTSTAMP:20400101T000000Z',
		'DTSTART:20400102T100000Z',
		'DTEND:20400102T110000Z',
		`SUMMARY:${summary}`,
		...extra,
		'END:VEVENT',
		'END:VCALENDAR',
		'',
	].join('\r\n');
}

function mixedCaseRaw(summary: string): string {
	return raw(summary, ['DESCRIPTION;LANGUAGE=en:Case normalized'])
		.replace('BEGIN:VCALENDAR', 'begin:vcalendar')
		.replace('BEGIN:VEVENT', 'begin:vevent')
		.replace('END:VEVENT', 'end:vevent')
		.replace('END:VCALENDAR', 'end:vcalendar')
		.replace('UID:', 'uid:')
		.replace('DTSTAMP:', 'dtstamp:')
		.replace('DTSTART:', 'dtstart:')
		.replace('DTEND:', 'dtend:')
		.replace('SUMMARY:', 'summary:')
		.replace('DESCRIPTION;LANGUAGE=', 'description;language=');
}

function response(
	statusCode: number,
	effectiveUrl: string,
	options: { readonly body?: string; readonly etag?: string } = {},
): CalDavTransportResponse {
	return {
		statusCode,
		effectiveUrl,
		headers: {},
		body: Buffer.from(options.body ?? '', 'utf8'),
		...(options.etag === undefined ? {} : { etag: options.etag }),
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

function dependencies(
	uidFactory = vi.fn(() => '00000000-0000-4000-8000-000000000051'),
): CalendarEventUpsertDependencies {
	return { clock: CLOCK, uidFactory };
}

describe('Raw ICS Create, Update and Upsert request branches', () => {
	it.each([
		['impossible date', raw('private-date').replace('20400102T100000Z', '20400230T100000Z')],
		['impossible time', raw('private-time').replace('20400101T000000Z', '20400101T250000Z')],
		['invalid status', raw('private-status', ['STATUS:NOT_A_STATUS'])],
		['invalid transparency', raw('private-transparency', ['TRANSP:IN/VISIBLE'])],
		['invalid URI', raw('private-uri', ['URL:not a uri'])],
		[
			'invalid calendar address',
			raw('private-calendar-address', ['ORGANIZER:not-a-calendar-address']),
		],
		['invalid integer', raw('private-integer', ['SEQUENCE:1.5'])],
		[
			'event duration with a dangling T',
			raw('private-event-duration').replace('DTEND:20400102T110000Z', 'DURATION:P1DT'),
		],
		[
			'alarm trigger duration with a dangling T',
			raw('private-alarm-trigger-duration', [
				'BEGIN:VALARM',
				'ACTION:DISPLAY',
				'TRIGGER:P1DT',
				'DESCRIPTION:private-alarm-description',
				'END:VALARM',
			]),
		],
		[
			'alarm duration with a dangling T',
			raw('private-alarm-duration', [
				'BEGIN:VALARM',
				'ACTION:DISPLAY',
				'TRIGGER:-PT5M',
				'DESCRIPTION:private-alarm-description',
				'DURATION:P1DT',
				'REPEAT:2',
				'END:VALARM',
			]),
		],
		[
			'RDATE period with reversed explicit end',
			raw('private-reversed-period', ['RDATE;VALUE=PERIOD:20400102T120000Z/20400102T110000Z']),
		],
		[
			'RDATE period with an extra slash segment',
			raw('private-extra-period-segment', [
				'RDATE;VALUE=PERIOD:20400102T120000Z/20400102T130000Z/20400102T140000Z',
			]),
		],
		[
			'invalid timezone offset',
			raw('private-offset').replace(
				'BEGIN:VEVENT',
				[
					'BEGIN:VTIMEZONE',
					'TZID:Private/Offset',
					'BEGIN:STANDARD',
					'DTSTART:20400101T020000',
					'TZOFFSETFROM:+2460',
					'TZOFFSETTO:+0100',
					'END:STANDARD',
					'END:VTIMEZONE',
					'BEGIN:VEVENT',
				].join('\r\n'),
			),
		],
		[
			'invalid timezone observance',
			raw('private-observance').replace(
				'BEGIN:VEVENT',
				[
					'BEGIN:VTIMEZONE',
					'TZID:Private/Observance',
					'BEGIN:DAYLIGHT',
					'DTSTART:20400230T020000',
					'TZOFFSETFROM:+0100',
					'TZOFFSETTO:+0200',
					'END:DAYLIGHT',
					'END:VTIMEZONE',
					'BEGIN:VEVENT',
				].join('\r\n'),
			),
		],
		[
			'DATE recurrence with DATE-TIME UNTIL',
			raw('private-date-until', ['RRULE:FREQ=DAILY;UNTIL=20400105T000000Z'])
				.replace('DTSTART:20400102T100000Z', 'DTSTART;VALUE=DATE:20400102')
				.replace('DTEND:20400102T110000Z', 'DTEND;VALUE=DATE:20400103'),
		],
		[
			'VTIMEZONE recurrence with local UNTIL',
			raw('private-timezone-until').replace(
				'BEGIN:VEVENT',
				[
					'BEGIN:VTIMEZONE',
					'TZID:Private/Until',
					'BEGIN:STANDARD',
					'DTSTART:20400101T020000',
					'TZOFFSETFROM:+0200',
					'TZOFFSETTO:+0100',
					'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU;UNTIL=20501030T020000',
					'END:STANDARD',
					'END:VTIMEZONE',
					'BEGIN:VEVENT',
				].join('\r\n'),
			),
		],
		[
			'invalid DISPLAY alarm',
			raw('private-alarm', ['BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT5M', 'END:VALARM']),
		],
		[
			'invalid EMAIL alarm',
			raw('private-email-alarm', [
				'BEGIN:VALARM',
				'ACTION:EMAIL',
				'TRIGGER:-PT5M',
				'DESCRIPTION:private-description',
				'END:VALARM',
			]),
		],
		[
			'generic alarm without trigger',
			raw('private-generic-missing-trigger', [
				'BEGIN:VALARM',
				'ACTION:PROCEDURE',
				'X-PROCEDURE-DATA:private-generic-data',
				'END:VALARM',
			]),
		],
		[
			'generic alarm with duplicate trigger',
			raw('private-generic-duplicate-trigger', [
				'BEGIN:VALARM',
				'ACTION:X-VENDOR-ACTION',
				'TRIGGER:-PT5M',
				'TRIGGER:-PT10M',
				'X-VENDOR-DATA:private-generic-data',
				'END:VALARM',
			]),
		],
		[
			'generic alarm with invalid trigger',
			raw('private-generic-invalid-trigger', [
				'BEGIN:VALARM',
				'ACTION:PROCEDURE',
				'TRIGGER:private-invalid-trigger',
				'END:VALARM',
			]),
		],
	] as const)(
		'rejects %s before any event request without leaking Raw ICS',
		async (_name, rawIcs) => {
			const requests = transport(async () => response(500, CALENDAR_URL));
			let failure: unknown;
			try {
				await createCalendarEvent(requests, {
					calendarUrl: CALENDAR_URL,
					inputMode: 'rawIcs',
					rawIcs,
				});
			} catch (error) {
				failure = error;
			}
			expect(failure).toMatchObject({
				code: 'INVALID_RESOURCE',
				message: 'Raw ICS must contain one valid VCALENDAR event resource.',
			});
			expect(JSON.stringify(failure)).not.toContain('private-');
			expect(requests.request).not.toHaveBeenCalled();
		},
	);

	it('creates the full object conditionally and returns normalized metadata without rawIcs', async () => {
		let put: CalDavTransportRequest | undefined;
		const requests = transport(async (request) => {
			put = request;
			return response(201, request.url!, { etag: '"created"' });
		});

		const result = await createCalendarEvent(
			requests,
			{ calendarUrl: CALENDAR_URL, inputMode: 'rawIcs', rawIcs: raw('Created', ['X-KEPT:yes']) },
			CLOCK,
		);

		expect(methods(requests)).toEqual([CalDavMethod.PUT]);
		expect(put).toMatchObject({
			headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'If-None-Match': '*' },
		});
		expect(put?.body).toContain('X-KEPT:yes');
		expect(result).toMatchObject({ uid: UID, summary: 'Created', etag: '"created"' });
		expect(result).not.toHaveProperty('rawIcs');
		expect(CLOCK).not.toHaveBeenCalled();
	});

	it('replaces by URL with caller ETag and returns the authoritative final GET body', async () => {
		const before = raw('Before', ['DESCRIPTION:removed']);
		const replacement = raw('After', ['X-KEPT:yes']);
		let stored = before;
		const requests = transport(async (request) => {
			if (request.method === CalDavMethod.PUT) {
				expect(request.headers?.['If-Match']).toBe('"caller"');
				stored = request.body!;
				return response(204, RESOURCE_URL);
			}
			return response(200, RESOURCE_URL, {
				body: stored,
				etag: stored === before ? '"snapshot"' : '"confirmed"',
			});
		});

		const result = await updateCalendarEvent(
			requests,
			{
				calendarUrl: CALENDAR_URL,
				identifier: { kind: 'resourceUrl', resourceUrl: RESOURCE_URL },
				etag: '"caller"',
				inputMode: 'rawIcs',
				rawIcs: replacement,
			},
			CLOCK,
		);

		expect(methods(requests)).toEqual([CalDavMethod.GET, CalDavMethod.PUT, CalDavMethod.GET]);
		expect(stored).not.toContain('DESCRIPTION:removed');
		expect(result).toMatchObject({ uid: UID, summary: 'After', etag: '"confirmed"' });
		expect(result.rawIcs).toBe(stored);
		expect(CLOCK).not.toHaveBeenCalled();
	});

	it('rejects a UID-mode mismatch before REPORT and a semantic no-op before PUT', async () => {
		const requests = transport(async () => response(500, CALENDAR_URL));
		await expect(
			updateCalendarEvent(
				requests,
				{
					calendarUrl: CALENDAR_URL,
					identifier: { kind: 'uid', uid: 'different@example.test' },
					inputMode: 'rawIcs',
					rawIcs: raw('Same'),
				},
				CLOCK,
			),
		).rejects.toMatchObject({ code: 'UID_MISMATCH' });
		expect(requests.request).not.toHaveBeenCalled();

		const noOp = transport(async () =>
			response(207, CALENDAR_URL, {
				body: multiStatus(reportResponse('raw-write.ics', '"lookup"', xmlText(raw('Same')))),
			}),
		);
		await expect(
			updateCalendarEvent(
				noOp,
				{
					calendarUrl: CALENDAR_URL,
					identifier: { kind: 'uid', uid: UID },
					inputMode: 'rawIcs',
					rawIcs: raw('Same'),
				},
				CLOCK,
			),
		).rejects.toMatchObject({ code: 'NO_CHANGES' });
		expect(methods(noOp)).toEqual([CalDavMethod.REPORT]);
	});

	it('Upsert uses REPORT zero/create, one/no-op and one/update without reading structured factories', async () => {
		const notFound = transport(async (request) => {
			if (request.method === CalDavMethod.REPORT) {
				return response(207, CALENDAR_URL, { body: multiStatus('') });
			}
			return response(201, request.url!, { etag: '"created"' });
		});
		const deps = dependencies();
		const created = await upsertCalendarEvent(
			notFound,
			{ calendarUrl: CALENDAR_URL, inputMode: 'rawIcs', rawIcs: raw('Create') },
			deps,
		);
		expect(created).toMatchObject({ action: 'create', event: { uid: UID } });
		expect(methods(notFound)).toEqual([CalDavMethod.REPORT, CalDavMethod.PUT]);
		expect(deps.uidFactory).not.toHaveBeenCalled();
		expect(deps.clock).not.toHaveBeenCalled();

		const lookup = raw('Same');
		const noOp = transport(async () =>
			response(207, CALENDAR_URL, {
				body: multiStatus(reportResponse('raw-write.ics', '"lookup"', xmlText(lookup))),
			}),
		);
		const unchanged = await upsertCalendarEvent(
			noOp,
			{ calendarUrl: CALENDAR_URL, inputMode: 'rawIcs', rawIcs: lookup },
			dependencies(),
		);
		expect(unchanged).toMatchObject({ action: 'update', event: { rawIcs: expect.any(String) } });
		expect(methods(noOp)).toEqual([CalDavMethod.REPORT]);

		let stored = lookup;
		const changed = transport(async (request) => {
			if (request.method === CalDavMethod.REPORT) {
				return response(207, CALENDAR_URL, {
					body: multiStatus(reportResponse('raw-write.ics', '"lookup"', xmlText(lookup))),
				});
			}
			if (request.method === CalDavMethod.PUT) {
				stored = request.body!;
				return response(204, RESOURCE_URL);
			}
			return response(200, RESOURCE_URL, { body: stored, etag: '"confirmed"' });
		});
		const updated = await upsertCalendarEvent(
			changed,
			{ calendarUrl: CALENDAR_URL, inputMode: 'rawIcs', rawIcs: raw('Changed') },
			dependencies(),
		);
		expect(updated).toMatchObject({ action: 'update', event: { summary: 'Changed' } });
		expect(methods(changed)).toEqual([CalDavMethod.REPORT, CalDavMethod.PUT, CalDavMethod.GET]);
	});

	it('Upsert compares normalized names case-insensitively for no-op and final read-back', async () => {
		const canonicalSame = raw('Same', ['DESCRIPTION;LANGUAGE=en:Case normalized']);
		const noOp = transport(async () =>
			response(207, CALENDAR_URL, {
				body: multiStatus(reportResponse('raw-write.ics', '"lookup"', xmlText(canonicalSame))),
			}),
		);
		const unchanged = await upsertCalendarEvent(
			noOp,
			{ calendarUrl: CALENDAR_URL, inputMode: 'rawIcs', rawIcs: mixedCaseRaw('Same') },
			dependencies(),
		);
		expect(unchanged).toMatchObject({ action: 'update', event: { summary: 'Same' } });
		expect(methods(noOp)).toEqual([CalDavMethod.REPORT]);

		const canonicalBefore = raw('Before', ['DESCRIPTION;LANGUAGE=en:Case normalized']);
		const canonicalAfter = raw('After', ['DESCRIPTION;LANGUAGE=en:Case normalized']);
		const changed = transport(async (request) => {
			if (request.method === CalDavMethod.REPORT) {
				return response(207, CALENDAR_URL, {
					body: multiStatus(reportResponse('raw-write.ics', '"lookup"', xmlText(canonicalBefore))),
				});
			}
			if (request.method === CalDavMethod.PUT) {
				return response(204, RESOURCE_URL);
			}
			return response(200, RESOURCE_URL, { body: canonicalAfter, etag: '"confirmed"' });
		});
		const updated = await upsertCalendarEvent(
			changed,
			{ calendarUrl: CALENDAR_URL, inputMode: 'rawIcs', rawIcs: mixedCaseRaw('After') },
			dependencies(),
		);
		expect(updated).toMatchObject({
			action: 'update',
			event: { summary: 'After', etag: '"confirmed"' },
		});
		expect(methods(changed)).toEqual([CalDavMethod.REPORT, CalDavMethod.PUT, CalDavMethod.GET]);
	});
});
