import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	randomUUID: vi.fn(),
}));

vi.mock('node:crypto', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:crypto')>()),
	randomUUID: mocks.randomUUID,
}));

import * as createModule from '../../nodes/CalDav/events/create';
import {
	CalDavCalendarEventCreateError,
	CalendarEventCreateFailureCode,
	createCalendarEvent,
} from '../../nodes/CalDav/events/create';
import type {
	CalendarEventCreateClock,
	CalendarEventCreateInput,
	CreatedCalendarEvent,
} from '../../nodes/CalDav/events/create';
import {
	CalDavCalendarEventMutationError,
	CalendarEventMutationFailureCode,
} from '../../nodes/CalDav/events/mutations';
import { CalDavICalendarSerializeError } from '../../nodes/CalDav/icalendar/serializer';
import { mapCalendarEventResource } from '../../nodes/CalDav/icalendar/eventReadModel';
import { parseICalendarResource } from '../../nodes/CalDav/icalendar/parser';
import { canonicalizeIanaTimeZone } from '../../nodes/CalDav/icalendar/timeZones';
import { CalDavAuthorizationError, CalDavMethod } from '../../nodes/CalDav/transport/http';
import type {
	CalDavResponseHeaders,
	CalDavTransport,
	CalDavTransportRequest,
	CalDavTransportResponse,
} from '../../nodes/CalDav/transport/http';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';
import {
	ISSUE_157_PROVIDER_CASES,
	syntheticProviderCalendarData,
} from './fixtures/time-zones/issue-157-provider-captures';

const CALENDAR_URL = validateAbsoluteHttpUrl('https://calendar.example.test/calendars/selected/');
const FIXED_CLOCK = new Date('2040-01-01T00:00:00.987Z');
const GENERATED_UID = '83a91a20-941d-4e5a-a184-2d46871736b4';

type MockTransport = CalDavTransport & { request: ReturnType<typeof vi.fn> };

function response(
	statusCode: number,
	effectiveUrl: string,
	options: {
		readonly etag?: unknown;
		readonly includeEtag?: boolean;
		readonly headers?: CalDavResponseHeaders;
		readonly body?: string;
	} = {},
): CalDavTransportResponse {
	return {
		statusCode,
		effectiveUrl,
		headers: options.headers ?? {},
		...(options.includeEtag === false ? {} : { etag: options.etag ?? '"created-etag"' }),
		body: Buffer.from(options.body ?? '', 'utf8'),
	} as CalDavTransportResponse;
}

function transport(
	implementation: (request: CalDavTransportRequest) => Promise<CalDavTransportResponse>,
): MockTransport {
	return {
		serverUrl: 'https://calendar.example.test/',
		request: vi.fn(implementation),
	};
}

function input(overrides: Partial<CalendarEventCreateInput> = {}): CalendarEventCreateInput {
	return {
		calendarUrl: CALENDAR_URL,
		uid: 'opaque ../UID/🚀?one',
		timeMode: 'timed',
		start: new Date('2040-01-02T10:00:00Z'),
		end: new Date('2040-01-02T11:00:00Z'),
		summary: 'Summary, exact',
		...overrides,
	};
}

function omittedUidInput(
	overrides: Partial<CalendarEventCreateInput> = {},
): CalendarEventCreateInput {
	const createInput: Partial<CalendarEventCreateInput> = { ...input(overrides) };
	delete createInput.uid;
	return createInput as CalendarEventCreateInput;
}

function eventData(uid: string): string {
	return [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//example.test//Create oracle//EN',
		'BEGIN:VEVENT',
		`UID:${uid}`,
		'DTSTAMP:20400101T000000Z',
		'DTSTART:20400102T100000Z',
		'DTEND:20400102T110000Z',
		'SUMMARY:Summary\\, exact',
		'DESCRIPTION:',
		'LOCATION:Brno 🚀',
		'URL:urn:example:opaque%2Fvalue',
		'END:VEVENT',
		'END:VCALENDAR',
		'',
	].join('\r\n');
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error('Expected Event Create to fail.');
}

beforeEach(() => {
	mocks.randomUUID.mockReset().mockReturnValue(GENERATED_UID);
});

describe('calendar-event Create coordinator public contract', () => {
	it('exports exactly the selected runtime surface and immutable failure codes', () => {
		expect(Object.keys(createModule).sort()).toEqual(
			[
				'CalDavCalendarEventCreateError',
				'CalendarEventCreateFailureCode',
				'createCalendarEvent',
			].sort(),
		);
		expect(Object.isFrozen(CalendarEventCreateFailureCode)).toBe(true);
		expect(CalendarEventCreateFailureCode).toEqual({
			RESOURCE_NAME_TOO_LONG: 'CALENDAR_EVENT_CREATE_RESOURCE_NAME_TOO_LONG',
			INVALID_CLOCK: 'CALENDAR_EVENT_CREATE_INVALID_CLOCK',
			NORMALIZATION_FAILED: 'CALENDAR_EVENT_CREATE_NORMALIZATION_FAILED',
			ETAG_RETRIEVAL_FAILED: 'CALENDAR_EVENT_CREATE_ETAG_RETRIEVAL_FAILED',
			CONFIRMATION_FAILED: 'CALENDAR_EVENT_CREATE_CONFIRMATION_FAILED',
		});
		expectTypeOf<CalendarEventCreateClock>().toEqualTypeOf<() => Date>();
		expectTypeOf<CalendarEventCreateInput['uid']>().toEqualTypeOf<string | undefined>();
		expectTypeOf(createCalendarEvent).returns.toEqualTypeOf<Promise<CreatedCalendarEvent>>();
	});

	it('maps an opaque Unicode UID injectively and returns its authored raw-free state', async () => {
		const requests = transport(async (request) =>
			request.method === CalDavMethod.PUT
				? response(201, request.url, { etag: ' W/"opaque etag" ' })
				: response(200, request.url, {
						etag: ' W/"opaque etag" ',
						body: eventData('opaque ../UID/🚀?one'),
					}),
		);
		const createInput = input({
			description: '',
			location: 'Brno 🚀',
			url: 'urn:example:opaque%2Fvalue',
		});
		const startSnapshot = createInput.start.getTime();
		const endSnapshot = createInput.end.getTime();
		const clock = vi.fn(() => FIXED_CLOCK);
		const expectedName = `${Buffer.from(createInput.uid, 'utf8').toString('base64url')}.ics`;
		const expectedResourceUrl = new URL(expectedName, CALENDAR_URL).href;

		await expect(createCalendarEvent(requests, createInput, clock)).resolves.toEqual({
			calendarUrl: CALENDAR_URL,
			resourceUrl: expectedResourceUrl,
			etag: ' W/"opaque etag" ',
			uid: createInput.uid,
			summary: 'Summary, exact',
			description: '',
			location: 'Brno 🚀',
			url: 'urn:example:opaque%2Fvalue',
			timeMode: 'timed',
			accessMode: 'editable',
			start: '2040-01-02T10:00:00Z',
			end: '2040-01-02T11:00:00Z',
			timeZoneMode: 'utc',
			startLocal: '2040-01-02T10:00:00',
			endLocal: '2040-01-02T11:00:00',
		});

		const request = requests.request.mock.calls[0]?.[0] as CalDavTransportRequest;
		expect(requests.request).toHaveBeenCalledTimes(2);
		expect(request).toMatchObject({
			method: CalDavMethod.PUT,
			url: expectedResourceUrl,
			headers: {
				'If-None-Match': '*',
				'Content-Type': 'text/calendar; charset=utf-8',
			},
		});
		expect(request.body).toContain('DTSTAMP:20400101T000000Z\r\n');
		expect(request.body).toContain('UID:opaque ../UID/🚀?one\r\n');
		expect(clock).toHaveBeenCalledTimes(1);
		expect(mocks.randomUUID).not.toHaveBeenCalled();
		expect(createInput.start.getTime()).toBe(startSnapshot);
		expect(createInput.end.getTime()).toBe(endSnapshot);
		expect(FIXED_CLOCK.getTime()).toBe(new Date('2040-01-01T00:00:00.987Z').getTime());
	});

	it('resolves one omitted UID before the clock and reuses it in the resource, ICS, authoritative GET, and result', async () => {
		const requests = transport(async (request) => {
			if (request.method === CalDavMethod.PUT) {
				return response(201, request.url, { includeEtag: false });
			}
			return response(200, request.url, {
				etag: '"generated-etag"',
				body: eventData(GENERATED_UID),
			});
		});
		const clock = vi.fn(() => FIXED_CLOCK);
		const expectedResourceUrl = new URL(
			`${Buffer.from(GENERATED_UID, 'utf8').toString('base64url')}.ics`,
			CALENDAR_URL,
		).href;

		const created = await createCalendarEvent(requests, omittedUidInput(), clock);

		expect(mocks.randomUUID).toHaveBeenCalledTimes(1);
		expect(mocks.randomUUID.mock.invocationCallOrder[0]).toBeLessThan(
			clock.mock.invocationCallOrder[0]!,
		);
		expect(requests.request).toHaveBeenCalledTimes(2);
		expect(
			requests.request.mock.calls.map(([request]) => (request as CalDavTransportRequest).url),
		).toEqual([expectedResourceUrl, expectedResourceUrl]);
		const put = requests.request.mock.calls[0]?.[0] as CalDavTransportRequest;
		const unfolded = put.body?.replace(/\r\n[ \t]/gu, '');
		expect(unfolded?.split('\r\n').filter((line) => line === `UID:${GENERATED_UID}`)).toHaveLength(
			1,
		);
		expect(created).toMatchObject({
			resourceUrl: expectedResourceUrl,
			uid: GENERATED_UID,
			etag: '"generated-etag"',
		});
		expect(created.uid).not.toBe(created.resourceUrl);
	});

	it('rejects unrepresentable finite IANA fallback before UID generation, clock, serialization, or mutation', async () => {
		const requests = transport(async (request) => response(201, request.url));
		const resolveReference = vi.fn().mockRejectedValue(new Error('private-reference-failure'));
		const clock = vi.fn(() => FIXED_CLOCK);
		const error = await captureError(
			createCalendarEvent(
				requests,
				omittedUidInput({
					start: new Date('0001-01-01T00:00:00Z'),
					end: new Date('9999-12-31T23:59:59Z'),
					timeZone: {
						timeZoneMode: 'iana',
						timeZone: canonicalizeIanaTimeZone('Europe/Prague'),
					},
				}),
				clock,
				{ resolveReference },
			),
		);
		expect(error).toMatchObject({
			code: 'UNREPRESENTABLE_TIME_ZONE',
			message: 'The selected IANA time zone cannot be represented safely for this calendar event.',
		});
		expect(resolveReference).toHaveBeenCalledOnce();
		expect(mocks.randomUUID).not.toHaveBeenCalled();
		expect(clock).not.toHaveBeenCalled();
		expect(requests.request).not.toHaveBeenCalled();
		expect(JSON.stringify(error)).not.toMatch(/Prague|calendar\.example|0001|9999|private/i);
	});

	it('reuses one generated UID across all-day DATE serialization, resource identity, and output', async () => {
		const authoritativeBody = [
			'BEGIN:VCALENDAR',
			'VERSION:2.0',
			'PRODID:-//example.test//All-day Create oracle//EN',
			'BEGIN:VEVENT',
			`UID:${GENERATED_UID}`,
			'DTSTAMP:20400101T000000Z',
			'DTSTART;VALUE=DATE:20400102',
			'DTEND;VALUE=DATE:20400103',
			'SUMMARY:Summary\\, exact',
			'END:VEVENT',
			'END:VCALENDAR',
			'',
		].join('\r\n');
		const expectedResourceUrl = new URL(
			`${Buffer.from(GENERATED_UID, 'utf8').toString('base64url')}.ics`,
			CALENDAR_URL,
		).href;
		const requests = transport(async (request) =>
			response(request.method === CalDavMethod.PUT ? 201 : 200, request.url, {
				etag: '"all-day-generated-etag"',
				body: authoritativeBody,
			}),
		);
		const allDayInput = {
			calendarUrl: CALENDAR_URL,
			timeMode: 'allDay',
			startDate: '2040-01-02',
			endDate: '2040-01-03',
			summary: 'Summary, exact',
		} as CalendarEventCreateInput;

		const created = await createCalendarEvent(requests, allDayInput, () => FIXED_CLOCK);

		expect(mocks.randomUUID).toHaveBeenCalledTimes(1);
		expect(requests.request).toHaveBeenCalledTimes(2);
		const put = requests.request.mock.calls[0]?.[0] as CalDavTransportRequest;
		expect(put).toMatchObject({ method: CalDavMethod.PUT, url: expectedResourceUrl });
		const unfolded = put.body?.replace(/\r\n[ \t]/gu, '');
		expect(unfolded?.split('\r\n').filter((line) => line === `UID:${GENERATED_UID}`)).toHaveLength(
			1,
		);
		expect(unfolded).toContain('DTSTART;VALUE=DATE:20400102\r\n');
		expect(unfolded).toContain('DTEND;VALUE=DATE:20400103\r\n');
		expect(unfolded).not.toContain('DTSTART:20400102T');
		expect(created).toEqual({
			calendarUrl: CALENDAR_URL,
			resourceUrl: expectedResourceUrl,
			etag: '"all-day-generated-etag"',
			uid: GENERATED_UID,
			summary: 'Summary, exact',
			timeMode: 'allDay',
			accessMode: 'editable',
			startDate: '2040-01-02',
			endDate: '2040-01-03',
		});
	});

	it('generates a distinct identity once for each separate omitted-UID Create execution', async () => {
		const generated = [
			'00000000-0000-4000-8000-000000000001',
			'00000000-0000-4000-8000-000000000002',
			'00000000-0000-4000-8000-000000000003',
		];
		for (const uid of generated) mocks.randomUUID.mockReturnValueOnce(uid);
		const stored = new Map<string, string>();
		const requests = transport(async (request) => {
			if (request.method === CalDavMethod.PUT) {
				stored.set(request.url, request.body!);
				return response(201, request.url);
			}
			return response(200, request.url, { body: stored.get(request.url) });
		});

		const created = [];
		for (let index = 0; index < generated.length; index += 1) {
			created.push(await createCalendarEvent(requests, omittedUidInput(), () => FIXED_CLOCK));
		}

		expect(mocks.randomUUID).toHaveBeenCalledTimes(3);
		expect(created.map(({ uid }) => uid)).toEqual(generated);
		expect(new Set(created.map(({ resourceUrl }) => resourceUrl)).size).toBe(3);
		expect(requests.request).toHaveBeenCalledTimes(6);
	});

	it('accepts the exact 255-octet resource-segment boundary and rejects the first overflow before clock or I/O', async () => {
		const acceptedUid = 'a'.repeat(188);
		const acceptedName = `${Buffer.from(acceptedUid).toString('base64url')}.ics`;
		expect(Buffer.byteLength(acceptedName, 'ascii')).toBe(255);
		const acceptedTransport = transport(async (request) =>
			request.method === CalDavMethod.PUT
				? response(201, request.url)
				: response(200, request.url, { body: eventData(acceptedUid) }),
		);
		await createCalendarEvent(acceptedTransport, input({ uid: acceptedUid }), () => FIXED_CLOCK);
		expect(acceptedTransport.request).toHaveBeenCalledTimes(2);

		const rejectedTransport = transport(async (request) => response(201, request.url));
		const clock = vi.fn(() => FIXED_CLOCK);
		const error = await captureError(
			createCalendarEvent(rejectedTransport, input({ uid: 'a'.repeat(189) }), clock),
		);
		expect(error).toBeInstanceOf(CalDavCalendarEventCreateError);
		expect(error).toMatchObject({
			code: CalendarEventCreateFailureCode.RESOURCE_NAME_TOO_LONG,
			message: 'UID is too long to create a safe event resource name.',
		});
		expect(clock).not.toHaveBeenCalled();
		expect(rejectedTransport.request).not.toHaveBeenCalled();
		expect(mocks.randomUUID).not.toHaveBeenCalled();
	});

	it.each(['', '\ud800private', '\u0000private'])(
		'rejects invalid UID %j through the serializer contract before clock or I/O',
		async (uid) => {
			const requests = transport(async (request) => response(201, request.url));
			const clock = vi.fn(() => FIXED_CLOCK);
			const error = await captureError(createCalendarEvent(requests, input({ uid }), clock));
			expect(error).toBeInstanceOf(CalDavICalendarSerializeError);
			expect(error).toMatchObject({ field: 'uid' });
			expect(clock).not.toHaveBeenCalled();
			expect(requests.request).not.toHaveBeenCalled();
			expect(mocks.randomUUID).not.toHaveBeenCalled();
		},
	);

	it.each([
		[
			'throwing',
			() => {
				throw new Error('private-clock-sentinel');
			},
		],
		['non-Date', () => 'private-clock-sentinel' as unknown as Date],
		['invalid Date', () => new Date(Number.NaN)],
		[
			'year zero',
			() => {
				const value = new Date(0);
				value.setUTCFullYear(0);
				return value;
			},
		],
	] as const)(
		'sanitizes an invalid %s clock after exactly one read and before I/O',
		async (_label, clock) => {
			const requests = transport(async (request) => response(201, request.url));
			const spy = vi.fn(clock);
			const error = await captureError(createCalendarEvent(requests, input(), spy));
			expect(error).toMatchObject({
				code: CalendarEventCreateFailureCode.INVALID_CLOCK,
				message: 'The calendar event clock is invalid.',
			});
			expect(spy).toHaveBeenCalledTimes(1);
			expect(requests.request).not.toHaveBeenCalled();
			expect(JSON.stringify(error)).not.toContain('private-clock-sentinel');
		},
	);

	it('propagates serializer validation without issuing a request', async () => {
		const requests = transport(async (request) => response(201, request.url));
		const error = await captureError(
			createCalendarEvent(requests, input({ summary: '\u0000private-ics' }), () => FIXED_CLOCK),
		);
		expect(error).toBeInstanceOf(CalDavICalendarSerializeError);
		expect(requests.request).not.toHaveBeenCalled();
	});

	it('uses authoritative GET after PUT even when the PUT omits its ETag', async () => {
		const requestedUrls: string[] = [];
		const requests = transport(async (request) => {
			requestedUrls.push(request.url);
			if (request.method === CalDavMethod.PUT) {
				return response(201, request.url, { includeEtag: false });
			}
			return response(200, request.url, {
				etag: '',
				body: eventData('opaque ../UID/🚀?one'),
			});
		});

		const result = await createCalendarEvent(requests, input(), () => FIXED_CLOCK);
		expect(requests.request).toHaveBeenCalledTimes(2);
		expect(requests.request.mock.calls[1]?.[0] as CalDavTransportRequest).toEqual({
			method: CalDavMethod.GET,
			url: requestedUrls[0],
		});
		expect(result.resourceUrl).toBe(requestedUrls[0]);
		expect(result.etag).toBe('');
		expect(result).not.toHaveProperty('rawIcs');
	});

	it('rejects an unsupported read-back after a completed mutation without leaking the body', async () => {
		const readOnlyBody = eventData('opaque ../UID/🚀?one')
			.replace('DTSTART:20400102T100000Z', 'DTSTART:20400102T100000')
			.replace('DTEND:20400102T110000Z', 'DTEND:20400102T110000');
		const requests = transport(async (request) =>
			request.method === CalDavMethod.PUT
				? response(201, request.url)
				: response(200, request.url, { etag: '"read-only-etag"', body: readOnlyBody }),
		);
		const error = await captureError(createCalendarEvent(requests, input(), () => FIXED_CLOCK));
		expect(error).toMatchObject({
			code: CalendarEventCreateFailureCode.CONFIRMATION_FAILED,
		});
		expect(JSON.stringify(error)).not.toContain(readOnlyBody);
		expect(requests.request).toHaveBeenCalledTimes(2);
	});

	it('rejects a Lord Howe provider read-back that collapses an authored 15-minute interval', async () => {
		let submitted = '';
		const requests = transport(async (request) => {
			if (request.method === CalDavMethod.PUT) {
				submitted = request.body!;
				return response(201, request.url, { etag: '"put"' });
			}
			return response(200, request.url, {
				etag: '"read-back"',
				body: submitted.replace(
					'DTEND;TZID=Australia/Lord_Howe:20261006T093500',
					'DTEND;TZID=Australia/Lord_Howe:20261006T092000',
				),
			});
		});
		const error = await captureError(
			createCalendarEvent(
				requests,
				input({
					start: new Date('2026-10-05T22:20:00Z'),
					end: new Date('2026-10-05T22:35:00Z'),
					timeZone: {
						timeZoneMode: 'iana',
						timeZone: canonicalizeIanaTimeZone('Australia/Lord_Howe'),
					},
				}),
				() => FIXED_CLOCK,
			),
		);
		expect(submitted).toContain('DTSTART;TZID=Australia/Lord_Howe:20261006T092000');
		expect(submitted).toContain('DTEND;TZID=Australia/Lord_Howe:20261006T093500');
		expect(error).toMatchObject({ code: CalendarEventCreateFailureCode.CONFIRMATION_FAILED });
		expect(JSON.stringify(error)).not.toMatch(/Lord_Howe|20261006|opaque|selected/i);
		expect(requests.request).toHaveBeenCalledTimes(2);
	});

	function icloudPragueReadBack(submitted: string, changedLaterTransition = false): string {
		const prague = ISSUE_157_PROVIDER_CASES.find(({ id }) => id === '01')!;
		const providerBody = syntheticProviderCalendarData(prague, 'icloud');
		const expandedDefinition = providerBody.match(
			/BEGIN:VTIMEZONE\r\n[\s\S]*?END:VTIMEZONE\r\n/u,
		)?.[0];
		if (!expandedDefinition) throw new Error('Missing sanitized iCloud Prague definition.');
		const returnedDefinition = changedLaterTransition
			? expandedDefinition.replace(
					'DTSTART:19961027T030000\r\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100',
					'DTSTART:19961027T030000\r\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0000',
				)
			: expandedDefinition;
		if (changedLaterTransition && returnedDefinition === expandedDefinition) {
			throw new Error('Missing later Prague transition in sanitized fixture.');
		}
		return submitted.replace(/BEGIN:VTIMEZONE\r\n[\s\S]*?END:VTIMEZONE\r\n/u, returnedDefinition);
	}

	it('accepts iCloud expanded historical rules when finite authored Prague offsets agree', async () => {
		let submitted = '';
		const requests = transport(async (request) => {
			if (request.method === CalDavMethod.PUT) {
				submitted = request.body!;
				return response(201, request.url, { etag: '"put"' });
			}
			return response(200, request.url, {
				etag: '"icloud-expanded"',
				body: icloudPragueReadBack(submitted),
			});
		});
		const created = await createCalendarEvent(
			requests,
			input({
				start: new Date('2026-10-06T07:20:00Z'),
				end: new Date('2026-10-06T07:35:00Z'),
				timeZone: {
					timeZoneMode: 'iana',
					timeZone: canonicalizeIanaTimeZone('Europe/Prague'),
				},
			}),
			() => FIXED_CLOCK,
		);
		expect(submitted.match(/BEGIN:(?:STANDARD|DAYLIGHT)/gu)).toHaveLength(3);
		expect(icloudPragueReadBack(submitted).match(/BEGIN:(?:STANDARD|DAYLIGHT)/gu)).toHaveLength(17);
		expect(created).toMatchObject({
			etag: '"icloud-expanded"',
			start: '2026-10-06T07:20:00Z',
			end: '2026-10-06T07:35:00Z',
		});
		expect(requests.request).toHaveBeenCalledTimes(2);
	});

	it('rejects an expanded Prague history with a later changed transition in recurrence coverage', async () => {
		let submitted = '';
		const requests = transport(async (request) => {
			if (request.method === CalDavMethod.PUT) {
				submitted = request.body!;
				return response(201, request.url, { etag: '"put"' });
			}
			return response(200, request.url, {
				etag: '"icloud-drift"',
				body: icloudPragueReadBack(submitted, true),
			});
		});
		const error = await captureError(
			createCalendarEvent(
				requests,
				input({
					start: new Date('2026-10-06T07:20:00Z'),
					end: new Date('2026-10-06T07:35:00Z'),
					recurrence: {
						frequency: 'daily',
						end: { kind: 'until', value: { kind: 'dateTime', dateTime: '2026-11-02T08:20:00Z' } },
					},
					timeZone: {
						timeZoneMode: 'iana',
						timeZone: canonicalizeIanaTimeZone('Europe/Prague'),
					},
				}),
				() => FIXED_CLOCK,
			),
		);
		expect(submitted).toContain('RRULE:FREQ=DAILY;UNTIL=20261102T082000Z');
		const resourceUrl = (requests.request.mock.calls[0]?.[0] as CalDavTransportRequest).url;
		const readBack = mapCalendarEventResource({
			calendarUrl: CALENDAR_URL,
			resourceUrl: validateAbsoluteHttpUrl(resourceUrl),
			etag: '"icloud-drift"',
			resource: parseICalendarResource(Buffer.from(icloudPragueReadBack(submitted, true))),
		}).event;
		expect(readBack).toMatchObject({
			accessMode: 'editable',
			start: '2026-10-06T07:20:00Z',
			end: '2026-10-06T07:35:00Z',
			recurrence: { frequency: 'daily' },
		});
		expect(error).toMatchObject({ code: CalendarEventCreateFailureCode.CONFIRMATION_FAILED });
		expect(JSON.stringify(error)).not.toMatch(/Prague|19961027|icloud-drift|selected/i);
		expect(requests.request).toHaveBeenCalledTimes(2);
	});

	function icloudTerminalReadBack(submitted: string, id: '05' | '06', altered = false): string {
		const testCase = ISSUE_157_PROVIDER_CASES.find((entry) => entry.id === id)!;
		const providerBody = syntheticProviderCalendarData(testCase, 'icloud');
		const definition = providerBody.match(/BEGIN:VTIMEZONE\r\n[\s\S]*?END:VTIMEZONE\r\n/u)?.[0];
		if (!definition) throw new Error(`Missing sanitized iCloud ${id} definition.`);
		let returnedDefinition = definition;
		if (altered) {
			returnedDefinition = definition.replace(
				'DTSTART:19860101T000000\r\nRDATE:19860101T000000\r\nTZOFFSETFROM:+0530\r\nTZOFFSETTO:+0545',
				'DTSTART:19860101T000000\r\nRDATE:19860101T000000\r\nTZOFFSETFROM:+0530\r\nTZOFFSETTO:+0600',
			);
			if (id !== '05' || returnedDefinition === definition) {
				throw new Error('Missing Kathmandu terminal transition in sanitized fixture.');
			}
		}
		let readBack = submitted.replace(
			/BEGIN:VTIMEZONE\r\n[\s\S]*?END:VTIMEZONE\r\n/u,
			returnedDefinition,
		);
		if (altered) {
			readBack = readBack
				.replace(
					'DTEND;TZID=Asia/Kathmandu:20261006T093500',
					'DTEND;TZID=Asia/Kathmandu:20261006T095000',
				)
				.replace(
					'DTSTART;TZID=Asia/Kathmandu:20261006T092000',
					'DTSTART;TZID=Asia/Kathmandu:20261006T093500',
				);
		}
		return readBack;
	}

	it.each([
		{ id: '05' as const, zone: 'Asia/Kathmandu', start: '2026-10-06T03:35:00Z', observances: 2 },
		{ id: '06' as const, zone: 'Asia/Kolkata', start: '2026-10-06T03:50:00Z', observances: 5 },
	])(
		'accepts iCloud expanded terminal history for $zone after finite Create',
		async ({ id, zone, start, observances }) => {
			let submitted = '';
			const requests = transport(async (request) => {
				if (request.method === CalDavMethod.PUT) {
					submitted = request.body!;
					return response(201, request.url, { etag: '"put"' });
				}
				return response(200, request.url, {
					etag: '"icloud-expanded"',
					body: icloudTerminalReadBack(submitted, id),
				});
			});
			const end = new Date(Date.parse(start) + 15 * 60_000);
			const created = await createCalendarEvent(
				requests,
				input({
					start: new Date(start),
					end,
					timeZone: { timeZoneMode: 'iana', timeZone: canonicalizeIanaTimeZone(zone) },
				}),
				() => FIXED_CLOCK,
			);
			expect(submitted.match(/BEGIN:(?:STANDARD|DAYLIGHT)/gu)).toHaveLength(1);
			expect(
				icloudTerminalReadBack(submitted, id).match(/BEGIN:(?:STANDARD|DAYLIGHT)/gu),
			).toHaveLength(observances);
			expect(created).toMatchObject({
				etag: '"icloud-expanded"',
				start,
				end: end.toISOString().replace('.000Z', 'Z'),
			});
			expect(requests.request).toHaveBeenCalledTimes(2);
		},
	);

	it('rejects a changed Kathmandu terminal offset even when read-back instants agree', async () => {
		let submitted = '';
		const requests = transport(async (request) => {
			if (request.method === CalDavMethod.PUT) {
				submitted = request.body!;
				return response(201, request.url, { etag: '"put"' });
			}
			return response(200, request.url, {
				etag: '"icloud-changed"',
				body: icloudTerminalReadBack(submitted, '05', true),
			});
		});
		const error = await captureError(
			createCalendarEvent(
				requests,
				input({
					start: new Date('2026-10-06T03:35:00Z'),
					end: new Date('2026-10-06T03:50:00Z'),
					timeZone: { timeZoneMode: 'iana', timeZone: canonicalizeIanaTimeZone('Asia/Kathmandu') },
				}),
				() => FIXED_CLOCK,
			),
		);
		const resourceUrl = (requests.request.mock.calls[0]?.[0] as CalDavTransportRequest).url;
		const readBack = mapCalendarEventResource({
			calendarUrl: CALENDAR_URL,
			resourceUrl: validateAbsoluteHttpUrl(resourceUrl),
			etag: '"icloud-changed"',
			resource: parseICalendarResource(Buffer.from(icloudTerminalReadBack(submitted, '05', true))),
		}).event;
		expect(readBack).toMatchObject({
			accessMode: 'editable',
			start: '2026-10-06T03:35:00Z',
			end: '2026-10-06T03:50:00Z',
		});
		expect(error).toMatchObject({ code: CalendarEventCreateFailureCode.CONFIRMATION_FAILED });
		expect(JSON.stringify(error)).not.toMatch(/Kathmandu|19860101|icloud-changed|selected/i);
		expect(requests.request).toHaveBeenCalledTimes(2);
	});

	it('does not repair malformed PUT ETag metadata with GET', async () => {
		const requests = transport(async (request) =>
			response(201, request.url, { etag: ['"one"', '"two"'] }),
		);
		const error = await captureError(createCalendarEvent(requests, input(), () => FIXED_CLOCK));
		expect(error).toMatchObject({
			code: CalendarEventMutationFailureCode.INVALID_RESPONSE,
		});
		expect(error).toBeInstanceOf(CalDavCalendarEventMutationError);
		expect(requests.request).toHaveBeenCalledTimes(1);
	});

	it('wraps every post-create confirmation failure as terminal partial success with only safe status', async () => {
		const requests = transport(async (request) => {
			if (request.method === CalDavMethod.PUT) {
				return response(201, request.url, { includeEtag: false });
			}
			throw new CalDavAuthorizationError(403);
		});
		const error = await captureError(createCalendarEvent(requests, input(), () => FIXED_CLOCK));
		expect(error).toBeInstanceOf(CalDavCalendarEventCreateError);
		expect(error).toMatchObject({
			code: CalendarEventCreateFailureCode.CONFIRMATION_FAILED,
			statusCode: 403,
			message: 'The event was created, but its current state could not be verified.',
		});
		expect(requests.request).toHaveBeenCalledTimes(2);
		expect(Object.keys(error as object).sort()).toEqual(['code', 'name', 'statusCode'].sort());
		expect(JSON.stringify(error)).not.toMatch(/opaque|calendar\.example|private|UID|ICS/i);
	});
});
