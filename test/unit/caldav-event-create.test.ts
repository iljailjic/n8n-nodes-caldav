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
import { CalDavAuthorizationError, CalDavMethod } from '../../nodes/CalDav/transport/http';
import type {
	CalDavResponseHeaders,
	CalDavTransport,
	CalDavTransportRequest,
	CalDavTransportResponse,
} from '../../nodes/CalDav/transport/http';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';

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
		});
		expectTypeOf<CalendarEventCreateClock>().toEqualTypeOf<() => Date>();
		expectTypeOf<CalendarEventCreateInput['uid']>().toEqualTypeOf<string | undefined>();
		expectTypeOf(createCalendarEvent).returns.toEqualTypeOf<Promise<CreatedCalendarEvent>>();
	});

	it('maps an opaque Unicode UID injectively and returns its authoritative read-back', async () => {
		const requests = transport(async (request) =>
			request.method === CalDavMethod.PUT
				? response(201, request.url)
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

	it('generates a distinct identity once for each separate omitted-UID Create execution', async () => {
		const generated = [
			'00000000-0000-4000-8000-000000000001',
			'00000000-0000-4000-8000-000000000002',
			'00000000-0000-4000-8000-000000000003',
		];
		for (const uid of generated) mocks.randomUUID.mockReturnValueOnce(uid);
		let readIndex = 0;
		const requests = transport(async (request) => {
			if (request.method === CalDavMethod.PUT) return response(201, request.url);
			const uid = generated[readIndex++]!;
			return response(200, request.url, { body: eventData(uid) });
		});

		const created = [];
		for (let index = 0; index < generated.length; index += 1) {
			created.push(await createCalendarEvent(requests, omittedUidInput(), () => FIXED_CLOCK));
		}

		expect(mocks.randomUUID).toHaveBeenCalledTimes(3);
		expect(created.map(({ uid }) => uid)).toEqual(generated);
		expect(new Set(created.map(({ resourceUrl }) => resourceUrl)).size).toBe(3);
		expect(readIndex).toBe(3);
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

	it('always performs one authoritative body GET after the valid PUT', async () => {
		const requestedUrls: string[] = [];
		const requests = transport(async (request) => {
			requestedUrls.push(request.url);
			if (request.method === CalDavMethod.PUT) {
				return response(201, request.url, { includeEtag: false });
			}
			return response(
				200,
				'https://calendar.example.test/calendars/selected/canonical-created.ics',
				{ etag: '', body: eventData('opaque ../UID/🚀?one') },
			);
		});

		const result = await createCalendarEvent(requests, input(), () => FIXED_CLOCK);
		expect(requests.request).toHaveBeenCalledTimes(2);
		expect(requests.request.mock.calls[1]?.[0] as CalDavTransportRequest).toEqual({
			method: CalDavMethod.GET,
			url: requestedUrls[0],
		});
		expect(result.resourceUrl).toBe(
			'https://calendar.example.test/calendars/selected/canonical-created.ics',
		);
		expect(result.etag).toBe('');
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

	it('wraps every post-create metadata failure as terminal partial success with only safe status', async () => {
		const requests = transport(async (request) => {
			if (request.method === CalDavMethod.PUT) {
				return response(201, request.url, { includeEtag: false });
			}
			throw new CalDavAuthorizationError(403);
		});
		const error = await captureError(createCalendarEvent(requests, input(), () => FIXED_CLOCK));
		expect(error).toBeInstanceOf(CalDavCalendarEventCreateError);
		expect(error).toMatchObject({
			code: CalendarEventCreateFailureCode.ETAG_RETRIEVAL_FAILED,
			statusCode: 403,
			message: 'The event was created, but its required ETag could not be retrieved.',
		});
		expect(requests.request).toHaveBeenCalledTimes(2);
		expect(Object.keys(error as object).sort()).toEqual(['code', 'name', 'statusCode'].sort());
		expect(JSON.stringify(error)).not.toMatch(/opaque|calendar\.example|private|UID|ICS/i);
	});
});
