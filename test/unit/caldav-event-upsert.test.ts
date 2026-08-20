import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import * as upsertModule from '../../nodes/CalDav/events/upsert';
import {
	CalDavCalendarEventUpsertError,
	CalendarEventUpsertFailureCode,
	upsertCalendarEvent,
} from '../../nodes/CalDav/events/upsert';
import type {
	CalendarEventUpsertDependencies,
	CalendarEventUpsertInput,
	CalendarEventUpsertResult,
} from '../../nodes/CalDav/events/upsert';
import {
	CalDavCalendarEventUidResolutionError,
	CalendarEventUidResolutionFailureCode,
} from '../../nodes/CalDav/events/resolveByUid';
import { bindCalendarEventTimeZoneExecutionContext } from '../../nodes/CalDav/events/timeZoneExecutionContext';
import { canonicalizeIanaTimeZone } from '../../nodes/CalDav/icalendar/timeZones';
import {
	CalDavAuthorizationError,
	CalDavMethod,
	CalDavNotFoundError,
	CalDavPreconditionFailedError,
} from '../../nodes/CalDav/transport/http';
import type {
	CalDavResponseHeaders,
	CalDavTransport,
	CalDavTransportRequest,
	CalDavTransportResponse,
} from '../../nodes/CalDav/transport/http';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';
import {
	SUPPORTED_BARE_IANA_EVENT,
	TZDIST_ZONE_RESPONSE,
} from './fixtures/time-zones/synthetic-time-zone-fixtures';

const CALENDAR_URL = validateAbsoluteHttpUrl('https://calendar.example.test/calendars/selected/');
const CLOCK_VALUE = new Date('2040-01-03T00:00:00.987Z');
const GENERATED_UID = '00000000-0000-4000-8000-000000000044';
const SUPPLIED_UID = 'opaque ../UID/🚀?one';

type MockTransport = CalDavTransport & { request: ReturnType<typeof vi.fn> };

const transports: MockTransport[] = [];

function escapeXml(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function eventIcs(
	uid: string,
	options: {
		readonly summary?: string;
		readonly description?: string;
		readonly location?: string;
		readonly url?: string;
		readonly floating?: boolean;
		readonly modified?: boolean;
		readonly unknown?: boolean;
		readonly recurrence?: string;
	} = {},
): string {
	return [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//example.test//Upsert oracle//EN',
		'BEGIN:VEVENT',
		`UID:${uid}`,
		'DTSTAMP:20400101T000000Z',
		...(options.modified === true ? ['LAST-MODIFIED:20400103T000000Z'] : []),
		`DTSTART:20400102T100000${options.floating === true ? '' : 'Z'}`,
		`DTEND:20400102T110000${options.floating === true ? '' : 'Z'}`,
		...(options.recurrence === undefined ? [] : [`RRULE:${options.recurrence}`]),
		`SUMMARY:${options.summary ?? 'Desired summary'}`,
		...(options.description === undefined ? [] : [`DESCRIPTION:${options.description}`]),
		...(options.location === undefined ? [] : [`LOCATION:${options.location}`]),
		...(options.url === undefined ? [] : [`URL:${options.url}`]),
		...(options.unknown === true
			? [
					'X-UNKNOWN;X-SOURCE=MiXeD:preserve-private-shape',
					'BEGIN:VALARM',
					'TRIGGER:-PT15M',
					'ACTION:DISPLAY',
					'DESCRIPTION:Reminder',
					'END:VALARM',
				]
			: []),
		'END:VEVENT',
		'END:VCALENDAR',
		'',
	].join('\r\n');
}

function allDayIcs(uid: string): string {
	return [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//example.test//Upsert all-day oracle//EN',
		'BEGIN:VEVENT',
		`UID:${uid}`,
		'DTSTAMP:20400103T000000Z',
		'DTSTART;VALUE=DATE:20400228',
		'DTEND;VALUE=DATE:20400301',
		'SUMMARY:Leap span',
		'END:VEVENT',
		'END:VCALENDAR',
		'',
	].join('\r\n');
}

function eventResponse(
	href: string,
	uid: string,
	options: {
		readonly etag?: string;
		readonly includeEtag?: boolean;
		readonly ics?: string;
	} = {},
): string {
	const etag =
		options.includeEtag === false
			? ''
			: `<d:getetag>${escapeXml(options.etag ?? ' W/"lookup-etag" ')}</d:getetag>`;
	return [
		'<d:response>',
		`<d:href>${escapeXml(href)}</d:href>`,
		'<d:propstat><d:prop>',
		etag,
		`<c:calendar-data>${escapeXml(options.ics ?? eventIcs(uid))}</c:calendar-data>`,
		'</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>',
		'</d:response>',
	].join('');
}

function multistatus(responses = ''): string {
	return `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${responses}</d:multistatus>`;
}

function response(
	statusCode: number,
	effectiveUrl: string,
	options: {
		readonly etag?: string;
		readonly includeEtag?: boolean;
		readonly headers?: CalDavResponseHeaders;
		readonly body?: string;
	} = {},
): CalDavTransportResponse {
	return {
		statusCode,
		effectiveUrl,
		headers: options.headers ?? {},
		...(options.includeEtag === false ? {} : { etag: options.etag ?? '"mutation-etag"' }),
		body: Buffer.from(options.body ?? '', 'utf8'),
	};
}

function transport(
	implementation: (request: CalDavTransportRequest) => Promise<CalDavTransportResponse>,
): MockTransport {
	const value: MockTransport = {
		serverUrl: 'https://calendar.example.test/',
		request: vi.fn(implementation),
	};
	transports.push(value);
	return value;
}

function timedInput(overrides: Partial<CalendarEventUpsertInput> = {}): CalendarEventUpsertInput {
	return {
		calendarUrl: CALENDAR_URL,
		uid: SUPPLIED_UID,
		timeMode: 'timed',
		start: new Date('2040-01-02T10:00:00Z'),
		end: new Date('2040-01-02T11:00:00Z'),
		summary: 'Desired summary',
		...overrides,
	} as CalendarEventUpsertInput;
}

function omittedUidInput(
	overrides: Partial<CalendarEventUpsertInput> = {},
): CalendarEventUpsertInput {
	const value = { ...timedInput(overrides) } as Partial<CalendarEventUpsertInput>;
	delete value.uid;
	return value as CalendarEventUpsertInput;
}

function dependencies(overrides: Partial<CalendarEventUpsertDependencies> = {}) {
	return {
		clock: vi.fn(() => CLOCK_VALUE),
		uidFactory: vi.fn(() => GENERATED_UID),
		...overrides,
	};
}

function methods(requests: MockTransport): string[] {
	return requests.request.mock.calls.map(
		([request]) => (request as CalDavTransportRequest).method as string,
	);
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error('Expected Event Upsert to fail.');
}

afterEach(() => {
	for (const requests of transports.splice(0)) {
		const history = requests.request.mock.calls.map(
			([request]) => request as CalDavTransportRequest,
		);
		expect(history.filter(({ method }) => method === CalDavMethod.REPORT)).toHaveLength(
			Math.min(1, history.filter(({ method }) => method === CalDavMethod.REPORT).length),
		);
		expect(history.map(({ method }) => method as string)).not.toContain('DELETE');
		expect(history.map(({ method }) => method as string)).not.toContain('MOVE');
		for (const request of history.filter(({ method }) => method === CalDavMethod.PUT)) {
			const ifMatch = request.headers?.['If-Match'];
			const ifNoneMatch = request.headers?.['If-None-Match'];
			expect((ifMatch === undefined) !== (ifNoneMatch === undefined)).toBe(true);
			expect(request.headers?.['Content-Type']).toBe('text/calendar; charset=utf-8');
		}
	}
	vi.restoreAllMocks();
});

describe('calendar-event Upsert public contract', () => {
	it('exports only the coordinator and its immutable typed concurrency failure', () => {
		expect(Object.keys(upsertModule).sort()).toEqual(
			[
				'CalDavCalendarEventUpsertError',
				'CalendarEventUpsertFailureCode',
				'upsertCalendarEvent',
			].sort(),
		);
		expect(CalendarEventUpsertFailureCode).toEqual({
			CONCURRENCY_CONFLICT: 'UPSERT_CONCURRENCY_CONFLICT',
		});
		expect(Object.isFrozen(CalendarEventUpsertFailureCode)).toBe(true);
		expect(upsertCalendarEvent).toHaveLength(3);
		expectTypeOf<CalendarEventUpsertDependencies>().toEqualTypeOf<{
			readonly clock: () => Date;
			readonly uidFactory: () => string;
		}>();
		expectTypeOf(upsertCalendarEvent).returns.toEqualTypeOf<Promise<CalendarEventUpsertResult>>();

		const error = new CalDavCalendarEventUpsertError(
			CalendarEventUpsertFailureCode.CONCURRENCY_CONFLICT,
		);
		expect(error).toMatchObject({
			code: 'UPSERT_CONCURRENCY_CONFLICT',
			message: 'The calendar changed while Event Upsert was in progress.',
		});
		expect(JSON.stringify(error)).not.toMatch(/uid|url|etag|xml|ics|body|private/i);
	});
});

describe('calendar-event Upsert deterministic selection and provenance', () => {
	it('generates one omitted UID, skips REPORT, and returns local authored data with the PUT ETag', async () => {
		const requests = transport(async (request) =>
			response(201, request.url!, { etag: ' W/"put" ' }),
		);
		const deps = dependencies();
		const expectedResourceUrl = new URL(
			`${Buffer.from(GENERATED_UID, 'utf8').toString('base64url')}.ics`,
			CALENDAR_URL,
		).href;

		const result = await upsertCalendarEvent(requests, omittedUidInput(), deps);

		expect(methods(requests)).toEqual(['PUT']);
		expect(requests.request.mock.calls[0]![0]).toMatchObject({
			method: CalDavMethod.PUT,
			url: expectedResourceUrl,
			headers: { 'If-None-Match': '*' },
		});
		expect(requests.request.mock.calls[0]![0].body).toContain(`UID:${GENERATED_UID}\r\n`);
		expect(deps.uidFactory).toHaveBeenCalledOnce();
		expect(deps.clock).toHaveBeenCalledOnce();
		expect(result).toEqual({
			action: 'create',
			event: {
				calendarUrl: CALENDAR_URL,
				resourceUrl: expectedResourceUrl,
				etag: ' W/"put" ',
				uid: GENERATED_UID,
				summary: 'Desired summary',
				timeMode: 'timed',
				accessMode: 'editable',
				start: '2040-01-02T10:00:00Z',
				end: '2040-01-02T11:00:00Z',
				timeZoneMode: 'utc',
				startLocal: '2040-01-02T10:00:00',
				endLocal: '2040-01-02T11:00:00',
			},
		});
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.event)).toBe(true);
	});

	it('performs REPORT then conditional Create for a supplied missing UID without changing it', async () => {
		const requests = transport(async (request) => {
			if (request.method === CalDavMethod.REPORT) {
				return response(207, CALENDAR_URL, { body: multistatus() });
			}
			return response(201, request.url!, { etag: '"created"' });
		});
		const deps = dependencies();

		const result = await upsertCalendarEvent(requests, timedInput(), deps);

		expect(methods(requests)).toEqual(['REPORT', 'PUT']);
		expect(requests.request.mock.calls[0]![0]).toMatchObject({
			method: CalDavMethod.REPORT,
			url: CALENDAR_URL,
			headers: { Depth: '1' },
		});
		const expectedUrl = new URL(
			`${Buffer.from(SUPPLIED_UID, 'utf8').toString('base64url')}.ics`,
			CALENDAR_URL,
		).href;
		expect(requests.request.mock.calls[1]![0]).toMatchObject({
			method: CalDavMethod.PUT,
			url: expectedUrl,
			headers: { 'If-None-Match': '*' },
		});
		expect(result).toMatchObject({
			action: 'create',
			event: { resourceUrl: expectedUrl, etag: '"created"', uid: SUPPLIED_UID },
		});
		expect(deps.uidFactory).not.toHaveBeenCalled();
		expect(deps.clock).toHaveBeenCalledOnce();
	});

	it('returns a unique semantic no-op from the lookup snapshot without clock, PUT, or GET', async () => {
		const requests = transport(async () =>
			response(207, CALENDAR_URL, {
				body: multistatus(eventResponse('existing.ics', SUPPLIED_UID, { etag: ' W/"exact" ' })),
			}),
		);
		const deps = dependencies();

		const result = await upsertCalendarEvent(requests, timedInput(), deps);

		expect(methods(requests)).toEqual(['REPORT']);
		expect(deps.clock).not.toHaveBeenCalled();
		expect(deps.uidFactory).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			action: 'update',
			event: {
				resourceUrl: new URL('existing.ics', CALENDAR_URL).href,
				etag: ' W/"exact" ',
				uid: SUPPLIED_UID,
				summary: 'Desired summary',
			},
		});
		expect(Object.isFrozen(result)).toBe(true);
	});

	it('treats a lexical-only recurrence difference as a REPORT-only semantic no-op', async () => {
		const requests = transport(async () =>
			response(207, CALENDAR_URL, {
				body: multistatus(
					eventResponse('recurring.ics', SUPPLIED_UID, {
						etag: '"recurrence-etag"',
						ics: eventIcs(SUPPLIED_UID, {
							recurrence: 'INTERVAL=2;FREQ=WEEKLY',
						}),
					}),
				),
			}),
		);
		const deps = dependencies();

		await expect(
			upsertCalendarEvent(
				requests,
				timedInput({
					recurrence: { kind: 'set', value: { frequency: 'weekly', interval: 2 } },
				}),
				deps,
			),
		).resolves.toMatchObject({
			action: 'update',
			event: { recurrence: { frequency: 'weekly', interval: 2 } },
		});
		expect(methods(requests)).toEqual(['REPORT']);
		expect(deps.clock).not.toHaveBeenCalled();
		expect(deps.uidFactory).not.toHaveBeenCalled();
	});

	it('updates one unique match with the exact lookup ETag and authoritative GET', async () => {
		const current = eventIcs(SUPPLIED_UID, {
			summary: 'Before update',
			description: 'Preserved description',
			location: 'Remove me',
			url: 'urn:example:old',
			unknown: true,
		});
		const confirmed = eventIcs(SUPPLIED_UID, {
			summary: 'Desired summary',
			description: 'Preserved description',
			url: 'urn:example:new',
			modified: true,
			unknown: true,
		});
		const resourceUrl = new URL('canonical-existing.ics', CALENDAR_URL).href;
		const requests = transport(async (request) => {
			if (request.method === CalDavMethod.REPORT) {
				return response(207, CALENDAR_URL, {
					body: multistatus(
						eventResponse('canonical-existing.ics', SUPPLIED_UID, {
							etag: ' W/"lookup exact" ',
							ics: current,
						}),
					),
				});
			}
			if (request.method === CalDavMethod.PUT) {
				return response(204, resourceUrl, { includeEtag: false });
			}
			return response(200, resourceUrl, { etag: ' "authoritative" ', body: confirmed });
		});
		const deps = dependencies();

		const result = await upsertCalendarEvent(
			requests,
			timedInput({ location: { kind: 'remove' }, url: { kind: 'set', value: 'urn:example:new' } }),
			deps,
		);

		expect(methods(requests)).toEqual(['REPORT', 'PUT', 'GET']);
		const put = requests.request.mock.calls[1]![0];
		expect(put).toMatchObject({
			method: CalDavMethod.PUT,
			url: resourceUrl,
			headers: { 'If-Match': ' W/"lookup exact" ' },
		});
		expect(put.body).toContain('DESCRIPTION:Preserved description');
		expect(put.body).not.toContain('LOCATION:Remove me');
		expect(put.body).toContain('URL:urn:example:new');
		expect(put.body).toContain('X-UNKNOWN;X-SOURCE=MiXeD:preserve-private-shape');
		expect(put.body).toContain('BEGIN:VALARM');
		expect(result).toMatchObject({
			action: 'update',
			event: {
				resourceUrl,
				etag: ' "authoritative" ',
				uid: SUPPLIED_UID,
				summary: 'Desired summary',
				description: 'Preserved description',
				url: 'urn:example:new',
			},
		});
		expect(result.event).not.toHaveProperty('location');
		expect(deps.clock).toHaveBeenCalledOnce();
	});

	it('resolves a reference-only IANA match before applying a requested UTC update', async () => {
		const current = SUPPORTED_BARE_IANA_EVENT.replace(
			'UID:synthetic-time-zone-event',
			`UID:${SUPPLIED_UID}`,
		).replace('SUMMARY:Synthetic event', 'SUMMARY:Reference-only source');
		const resourceUrl = new URL('reference-only.ics', CALENDAR_URL).href;
		let submitted = '';
		const requests = transport(async (request) => {
			if (request.method === CalDavMethod.REPORT) {
				return response(207, CALENDAR_URL, {
					body: multistatus(
						eventResponse('reference-only.ics', SUPPLIED_UID, {
							etag: '"reference-only"',
							ics: current,
						}),
					),
				});
			}
			if (request.method === CalDavMethod.PUT) {
				submitted = request.body!;
				return response(204, resourceUrl, { etag: '"put"' });
			}
			return response(200, resourceUrl, {
				etag: '"confirmed"',
				body: submitted,
			});
		});
		const timeZone = canonicalizeIanaTimeZone('Europe/Prague');
		const resolveReference = vi.fn().mockResolvedValue({
			timeZone,
			etag: '"reference"',
			calendarData: TZDIST_ZONE_RESPONSE,
			ruleSource: 'vtimezone' as const,
		});
		bindCalendarEventTimeZoneExecutionContext(requests, { resolveReference });
		const deps = dependencies();

		const result = await upsertCalendarEvent(
			requests,
			timedInput({
				start: new Date('2040-01-15T08:00:00Z'),
				end: new Date('2040-01-15T09:00:00Z'),
				timeZone: { timeZoneMode: 'utc' },
				summary: 'Converted to UTC',
			}),
			deps,
		);

		expect(result).toMatchObject({
			action: 'update',
			event: {
				resourceUrl,
				uid: SUPPLIED_UID,
				etag: '"confirmed"',
				summary: 'Converted to UTC',
				accessMode: 'editable',
				timeZoneMode: 'utc',
				start: '2040-01-15T08:00:00Z',
				end: '2040-01-15T09:00:00Z',
			},
		});
		expect(resolveReference).toHaveBeenCalledOnce();
		expect(resolveReference).toHaveBeenCalledWith(CALENDAR_URL, timeZone);
		expect(methods(requests)).toEqual(['REPORT', 'PUT', 'GET']);
		expect(methods(requests).filter((method) => method === CalDavMethod.REPORT)).toHaveLength(1);
		expect(methods(requests)).not.toContain(CalDavMethod.DELETE);
		expect(requests.request.mock.calls[1]![0]).toMatchObject({
			url: resourceUrl,
			headers: { 'If-Match': '"reference-only"' },
		});
		expect(submitted).toContain('X-SYNTHETIC-PRESERVE:opaque-value');
		expect(submitted).toContain('DTSTART:20400115T080000Z');
		expect(submitted).not.toContain('TZID=Europe/Prague');
		expect(deps.uidFactory).not.toHaveBeenCalled();
		expect(deps.clock).toHaveBeenCalledOnce();
	});

	it('authors all-day DATE values through the same generated-UID Create branch', async () => {
		const requests = transport(async (request) => response(201, request.url!, { etag: '"date"' }));
		const deps = dependencies();
		const allDay = {
			calendarUrl: CALENDAR_URL,
			timeMode: 'allDay',
			startDate: '2040-02-28',
			endDate: '2040-03-01',
			summary: 'Leap span',
		} as CalendarEventUpsertInput;

		const result = await upsertCalendarEvent(requests, allDay, deps);

		expect(methods(requests)).toEqual(['PUT']);
		const body = requests.request.mock.calls[0]![0].body as string;
		expect(body).toContain('DTSTART;VALUE=DATE:20400228');
		expect(body).toContain('DTEND;VALUE=DATE:20400301');
		expect(body).not.toMatch(/DT(?:START|END)[^\r\n]*(?:TZID|T000000Z)/);
		expect(result).toMatchObject({
			action: 'create',
			event: {
				uid: GENERATED_UID,
				timeMode: 'allDay',
				startDate: '2040-02-28',
				endDate: '2040-03-01',
			},
		});
		expect(allDayIcs(GENERATED_UID)).toContain('DTEND;VALUE=DATE:20400301');
	});

	it('uses the execution-scoped reference-first IANA authoring context', async () => {
		const requests = transport(async (request) => response(201, request.url!, { etag: '"iana"' }));
		const timeZone = canonicalizeIanaTimeZone('Europe/Prague');
		const resolveReference = vi.fn().mockResolvedValue({
			timeZone,
			etag: '"reference"',
			calendarData: TZDIST_ZONE_RESPONSE,
			ruleSource: 'vtimezone' as const,
		});
		bindCalendarEventTimeZoneExecutionContext(requests, { resolveReference });
		const deps = dependencies();

		await upsertCalendarEvent(
			requests,
			omittedUidInput({ timeZone: { timeZoneMode: 'iana', timeZone } }),
			deps,
		);

		expect(resolveReference).toHaveBeenCalledOnce();
		expect(resolveReference).toHaveBeenCalledWith(CALENDAR_URL, timeZone);
		expect(resolveReference.mock.invocationCallOrder[0]).toBeLessThan(
			deps.uidFactory.mock.invocationCallOrder[0]!,
		);
		const body = requests.request.mock.calls[0]![0].body as string;
		expect(body).toMatch(/DTSTART;TZID=Europe\/Prague:\d{8}T\d{6}/);
		expect(body).not.toContain('BEGIN:VTIMEZONE');
	});
});

describe('calendar-event Upsert branch guards and exact side effects', () => {
	it('fails duplicate exact UIDs after one REPORT without selecting or mutating a resource', async () => {
		const requests = transport(async () =>
			response(207, CALENDAR_URL, {
				body: multistatus(
					eventResponse('first.ics', SUPPLIED_UID) + eventResponse('second.ics', SUPPLIED_UID),
				),
			}),
		);
		const deps = dependencies();

		const error = await captureError(upsertCalendarEvent(requests, timedInput(), deps));

		expect(error).toMatchObject({
			message:
				'More than one calendar event with the requested UID was found in the selected calendar.',
		});
		expect(methods(requests)).toEqual(['REPORT']);
		expect(deps.clock).not.toHaveBeenCalled();
		expect(deps.uidFactory).not.toHaveBeenCalled();
	});

	it('checks read-only before missing ETag and semantic no-op, then never falls through to Create', async () => {
		const requests = transport(async () =>
			response(207, CALENDAR_URL, {
				body: multistatus(
					eventResponse('floating.ics', SUPPLIED_UID, {
						includeEtag: false,
						ics: eventIcs(SUPPLIED_UID, { floating: true }),
					}),
				),
			}),
		);
		const deps = dependencies();

		const error = await captureError(upsertCalendarEvent(requests, timedInput(), deps));

		expect(error).toMatchObject({
			message: 'The calendar event is read-only because its time representation is unsupported.',
		});
		expect(methods(requests)).toEqual(['REPORT']);
		expect(deps.clock).not.toHaveBeenCalled();
	});

	it.each([
		[
			'foreign read-only resource',
			'https://calendar.example.test/calendars/foreign/floating.ics',
			{ ics: eventIcs(SUPPLIED_UID, { floating: true }) },
		],
		['non-direct-child resource without ETag', 'nested/missing-etag.ics', { includeEtag: false }],
	] as const)(
		'rejects a same-UID %s before access and ETag classification',
		async (_label, href, options) => {
			const requests = transport(async () =>
				response(207, CALENDAR_URL, {
					body: multistatus(eventResponse(href, SUPPLIED_UID, options)),
				}),
			);
			const deps = dependencies();

			const error = await captureError(upsertCalendarEvent(requests, timedInput(), deps));

			expect(error).toBeInstanceOf(CalDavCalendarEventUidResolutionError);
			expect(error).toMatchObject({
				code: CalendarEventUidResolutionFailureCode.INVALID_RESPONSE,
				message: 'The CalDAV server returned an invalid calendar-event UID response.',
			});
			expect(methods(requests)).toEqual(['REPORT']);
			expect(deps.clock).not.toHaveBeenCalled();
			expect(deps.uidFactory).not.toHaveBeenCalled();
			expect(JSON.stringify(error)).not.toMatch(/foreign|nested|floating|missing-etag/i);
		},
	);

	it('requires a unique editable lookup ETag, including preserving empty-string presence', async () => {
		const missing = transport(async () =>
			response(207, CALENDAR_URL, {
				body: multistatus(eventResponse('missing-etag.ics', SUPPLIED_UID, { includeEtag: false })),
			}),
		);
		const missingDeps = dependencies();
		await expect(upsertCalendarEvent(missing, timedInput(), missingDeps)).rejects.toMatchObject({
			message: 'The calendar event does not provide an ETag required for a safe mutation.',
		});
		expect(methods(missing)).toEqual(['REPORT']);
		expect(missingDeps.clock).not.toHaveBeenCalled();

		const empty = transport(async () =>
			response(207, CALENDAR_URL, {
				body: multistatus(eventResponse('empty-etag.ics', SUPPLIED_UID, { etag: '' })),
			}),
		);
		const result = await upsertCalendarEvent(empty, timedInput(), dependencies());
		expect(result).toMatchObject({ action: 'update', event: { etag: '' } });
		expect(methods(empty)).toEqual(['REPORT']);
	});

	it('performs the long-UID resource limit only after the sole zero-match lookup', async () => {
		const uid = 'a'.repeat(189);
		const requests = transport(async () => response(207, CALENDAR_URL, { body: multistatus() }));
		const deps = dependencies();

		await expect(upsertCalendarEvent(requests, timedInput({ uid }), deps)).rejects.toMatchObject({
			message: 'UID is too long to create a safe event resource name.',
		});
		expect(methods(requests)).toEqual(['REPORT']);
		expect(deps.clock).not.toHaveBeenCalled();
	});

	it.each([
		['invalid UID', { uid: '' }, 'UID must be a non-empty valid iCalendar text value.'],
		[
			'invalid Calendar',
			{ calendarUrl: 'https://user:secret@calendar.example.test/private/' },
			'The Calendar URL is invalid. Enter an absolute HTTP(S) calendar collection URL.',
		],
		[
			'invalid Summary',
			{ summary: '\u0000private' },
			'Summary must be a valid iCalendar text value.',
		],
		[
			'invalid URL Set',
			{ url: { kind: 'set', value: '' } },
			'URL must be a valid absolute URI without a fragment.',
		],
		[
			'empty-fragment URL Set',
			{ url: { kind: 'set', value: 'urn:example:#' } },
			'URL must be a valid absolute URI without a fragment.',
		],
	] as const)(
		'rejects %s in local preflight before factory, clock, or I/O',
		async (_label, overrides, message) => {
			const requests = transport(async (request) => response(201, request.url!));
			const deps = dependencies();
			const malformed = timedInput(overrides as Partial<CalendarEventUpsertInput>);

			await expect(upsertCalendarEvent(requests, malformed, deps)).rejects.toMatchObject({
				message,
			});
			expect(requests.request).not.toHaveBeenCalled();
			expect(deps.uidFactory).not.toHaveBeenCalled();
			expect(deps.clock).not.toHaveBeenCalled();
		},
	);

	it('reports Summary before the deferred final range consistency check', async () => {
		const requests = transport(async (request) => response(201, request.url!));
		const deps = dependencies();

		await expect(
			upsertCalendarEvent(
				requests,
				timedInput({
					end: new Date('2040-01-02T09:00:00Z'),
					summary: '\u0000private-summary',
				}),
				deps,
			),
		).rejects.toMatchObject({ message: 'Summary must be a valid iCalendar text value.' });
		expect(requests.request).not.toHaveBeenCalled();
		expect(deps.uidFactory).not.toHaveBeenCalled();
		expect(deps.clock).not.toHaveBeenCalled();
	});
});

describe('calendar-event Upsert races, strict preconditions, and partial success', () => {
	it.each([
		['stale ETag', new CalDavPreconditionFailedError(412)],
		['disappearance', new CalDavNotFoundError(404)],
	] as const)(
		'maps Update PUT %s to one Upsert concurrency conflict without retry or read-back',
		async (_label, failure) => {
			const requests = transport(async (request) => {
				if (request.method === CalDavMethod.REPORT) {
					return response(207, CALENDAR_URL, {
						body: multistatus(
							eventResponse('race.ics', SUPPLIED_UID, {
								etag: '"stale"',
								ics: eventIcs(SUPPLIED_UID, { summary: 'Before race' }),
							}),
						),
					});
				}
				throw failure;
			});

			const error = await captureError(upsertCalendarEvent(requests, timedInput(), dependencies()));

			expect(error).toBeInstanceOf(CalDavCalendarEventUpsertError);
			expect(error).toMatchObject({
				code: 'UPSERT_CONCURRENCY_CONFLICT',
				message: 'The calendar changed while Event Upsert was in progress.',
			});
			expect(methods(requests)).toEqual(['REPORT', 'PUT']);
			expect(requests.request.mock.calls[1]![0].headers?.['If-Match']).toBe('"stale"');
		},
	);

	it.each([
		[
			'default prefix',
			'<d:error xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><c:no-uid-conflict><d:href>/private/account/event.ics</d:href></c:no-uid-conflict></d:error>',
		],
		[
			'alternate prefix',
			'<x:error xmlns:x="DAV:" xmlns:q="urn:ietf:params:xml:ns:caldav"><q:no-uid-conflict/></x:error>',
		],
	] as const)(
		'recognizes structural no-uid-conflict with %s and leaks no nested href',
		async (_label, body) => {
			const requests = transport(async (request) => response(403, request.url!, { body }));
			const error = await captureError(
				upsertCalendarEvent(requests, omittedUidInput(), dependencies()),
			);

			expect(error).toMatchObject({
				code: 'UPSERT_CONCURRENCY_CONFLICT',
				message: 'The calendar changed while Event Upsert was in progress.',
			});
			expect(methods(requests)).toEqual(['PUT']);
			expect(JSON.stringify(error)).not.toMatch(/private|account|href|no-uid-conflict|body/i);
		},
	);

	it.each([
		['text mention', '<d:error xmlns:d="DAV:">no-uid-conflict</d:error>'],
		[
			'arbitrary root',
			'<x:response xmlns:x="urn:arbitrary" xmlns:c="urn:ietf:params:xml:ns:caldav"><c:no-uid-conflict/></x:response>',
		],
		[
			'nested below DAV error',
			'<d:error xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:responsedescription><c:no-uid-conflict/></d:responsedescription></d:error>',
		],
		[
			'wrong namespace',
			'<d:error xmlns:d="DAV:" xmlns:x="urn:not-caldav"><x:no-uid-conflict/></d:error>',
		],
		['DTD', '<!DOCTYPE d:error [<!ENTITY x "private">]><d:error xmlns:d="DAV:">&x;</d:error>'],
		['malformed', '<d:error xmlns:d="DAV:"><d:no-uid-conflict>'],
	] as const)('does not guess concurrency from %s 403 content', async (_label, body) => {
		const requests = transport(async (request) => response(403, request.url!, { body }));
		const error = await captureError(
			upsertCalendarEvent(requests, omittedUidInput(), dependencies()),
		);

		expect(error).not.toMatchObject({ code: 'UPSERT_CONCURRENCY_CONFLICT' });
		expect(methods(requests)).toEqual(['PUT']);
		expect(JSON.stringify(error)).not.toMatch(/private|DOCTYPE|ENTITY|no-uid-conflict|body/i);
	});

	it('does not classify generic 409 as concurrency', async () => {
		const requests = transport(async (request) => response(409, request.url!, { body: 'private' }));
		const error = await captureError(
			upsertCalendarEvent(requests, omittedUidInput(), dependencies()),
		);

		expect(error).not.toMatchObject({ code: 'UPSERT_CONCURRENCY_CONFLICT' });
		expect(methods(requests)).toEqual(['PUT']);
		expect(JSON.stringify(error)).not.toContain('private');
	});

	it('reports Create partial success only after PUT succeeded without ETag and metadata GET failed', async () => {
		const requests = transport(async (request) => {
			if (request.method === CalDavMethod.PUT) {
				return response(201, request.url!, { includeEtag: false });
			}
			throw new CalDavNotFoundError(404);
		});
		const error = await captureError(
			upsertCalendarEvent(requests, omittedUidInput(), dependencies()),
		);

		expect(error).toMatchObject({
			message: 'The event was created, but its required ETag could not be retrieved.',
			statusCode: 404,
		});
		expect(methods(requests)).toEqual(['PUT', 'GET']);
	});

	it('reports Update partial success when authoritative read-back disappears', async () => {
		const resourceUrl = new URL('partial.ics', CALENDAR_URL).href;
		const requests = transport(async (request) => {
			if (request.method === CalDavMethod.REPORT) {
				return response(207, CALENDAR_URL, {
					body: multistatus(
						eventResponse('partial.ics', SUPPLIED_UID, {
							etag: '"lookup"',
							ics: eventIcs(SUPPLIED_UID, { summary: 'Before' }),
						}),
					),
				});
			}
			if (request.method === CalDavMethod.PUT) {
				return response(204, resourceUrl, { includeEtag: false });
			}
			throw new CalDavNotFoundError(404);
		});
		const error = await captureError(upsertCalendarEvent(requests, timedInput(), dependencies()));

		expect(error).toMatchObject({
			message: 'The event was updated, but its current state could not be verified.',
			statusCode: 404,
		});
		expect(methods(requests)).toEqual(['REPORT', 'PUT', 'GET']);
	});

	it('preserves ordinary authorization as non-concurrency and never retries', async () => {
		const requests = transport(async () => {
			throw new CalDavAuthorizationError(403);
		});
		const error = await captureError(
			upsertCalendarEvent(requests, omittedUidInput(), dependencies()),
		);
		expect(error).toBeInstanceOf(CalDavAuthorizationError);
		expect(error).not.toMatchObject({ code: 'UPSERT_CONCURRENCY_CONFLICT' });
		expect(methods(requests)).toEqual(['PUT']);
	});
});
