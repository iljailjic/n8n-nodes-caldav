import { afterEach, describe, expect, it, vi } from 'vitest';

import * as resourceGet from '../../nodes/CalDav/events/getByResourceUrl';
import {
	CalDavCalendarEventResourceGetError,
	CalendarEventResourceGetFailureCode,
	getCalendarEventByResourceUrl,
} from '../../nodes/CalDav/events/getByResourceUrl';
import { CalDavCalendarEventReadModelError } from '../../nodes/CalDav/icalendar/eventReadModel';
import { CalDavICalendarParseError } from '../../nodes/CalDav/icalendar/parser';
import {
	CalDavMethod,
	CalDavNetworkError,
	CalDavNotFoundError,
} from '../../nodes/CalDav/transport/http';
import type {
	CalDavTransport,
	CalDavTransportRequest,
	CalDavTransportResponse,
} from '../../nodes/CalDav/transport/http';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';
import type { AbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';

const CALENDAR_URL = validateAbsoluteHttpUrl(
	'https://Calendar.Example.Test:443/calendars/selected?calendar=opaque',
);

type MockTransport = CalDavTransport & { request: ReturnType<typeof vi.fn> };

function calendar(lines: readonly string[]): Buffer {
	return Buffer.from(
		['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR', ''].join('\r\n'),
	);
}

function eventResource(uid: string, extraLines: readonly string[] = []): Buffer {
	return calendar([
		'BEGIN:VEVENT',
		`UID:${uid}`,
		'DTSTAMP:20400101T000000Z',
		'DTSTART:20400102T100000Z',
		'DTEND:20400102T103000Z',
		...extraLines,
		'END:VEVENT',
	]);
}

function response(
	body = eventResource('resource-get@example.test'),
	options: {
		readonly statusCode?: number;
		readonly effectiveUrl?: string;
		readonly etag?: string;
		readonly includeEtag?: boolean;
		readonly headers?: Readonly<Record<string, string>>;
	} = {},
): CalDavTransportResponse {
	return {
		statusCode: options.statusCode ?? 200,
		headers: options.headers ?? Object.freeze({ 'content-type': 'text/calendar' }),
		effectiveUrl:
			options.effectiveUrl ?? 'https://calendar.example.test/calendars/selected/arbitrary-resource',
		...(options.includeEtag === false ? {} : { etag: options.etag ?? ' W/"opaque-etag" ' }),
		body,
	};
}

function mockTransport(
	implementation: (input: CalDavTransportRequest) => Promise<CalDavTransportResponse> = async () =>
		response(),
): MockTransport {
	return {
		serverUrl: 'https://configured.example.test/private-root/',
		request: vi.fn(implementation),
	};
}

function resourceUrl(
	value = 'https://calendar.example.test/calendars/selected/arbitrary-resource',
): AbsoluteHttpUrl {
	return validateAbsoluteHttpUrl(value);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('calendar-event direct-resource Get public contract', () => {
	it('exports exactly the accepted runtime surface and immutable failure codes', () => {
		expect(Object.keys(resourceGet).sort()).toEqual([
			'CalDavCalendarEventResourceGetError',
			'CalendarEventResourceGetFailureCode',
			'getCalendarEventByResourceUrl',
		]);
		expect(CalendarEventResourceGetFailureCode).toEqual({
			OUTSIDE_CALENDAR: 'CALENDAR_EVENT_RESOURCE_OUTSIDE_CALENDAR',
			INVALID_RESPONSE: 'INVALID_CALENDAR_EVENT_RESOURCE_RESPONSE',
		});
		expect(Object.isFrozen(CalendarEventResourceGetFailureCode)).toBe(true);
		expect(getCalendarEventByResourceUrl).toBeTypeOf('function');
		expect(getCalendarEventByResourceUrl).toHaveLength(3);
	});

	it.each([
		[
			CalendarEventResourceGetFailureCode.OUTSIDE_CALENDAR,
			'The event resource URL is outside the selected calendar.',
		],
		[
			CalendarEventResourceGetFailureCode.INVALID_RESPONSE,
			'The CalDAV server returned an invalid calendar-event resource response.',
		],
	] as const)('constructs the fixed privacy-safe %s error', (code, message) => {
		const error = new CalDavCalendarEventResourceGetError(code);

		expect(error).toMatchObject({
			name: 'CalDavCalendarEventResourceGetError',
			code,
			message,
		});
		expect(
			Object.getOwnPropertyNames(error).every((name) =>
				['stack', 'message', 'name', 'code'].includes(name),
			),
		).toBe(true);
		for (const forbidden of ['url', 'uid', 'etag', 'ics', 'response', 'headers', 'body', 'cause']) {
			expect(error).not.toHaveProperty(forbidden);
		}
	});
});

describe('calendar-event direct-resource containment', () => {
	it.each([
		['arbitrary name', 'arbitrary-resource'],
		['non-ICS name', 'meeting.data'],
		['encoded slash is one opaque segment', 'opaque%2Fname'],
		['encoded slash case is preserved', 'opaque%2fname'],
	] as const)('accepts a direct child with %s', async (_label, child) => {
		const requestedUrl = resourceUrl(
			`https://calendar.example.test/calendars/selected/${child}?resource=opaque`,
		);
		const transport = mockTransport(async () =>
			response(eventResource(child), {
				effectiveUrl: requestedUrl,
			}),
		);

		const result = await getCalendarEventByResourceUrl(transport, CALENDAR_URL, requestedUrl);

		expect(transport.request).toHaveBeenCalledTimes(1);
		expect(transport.request).toHaveBeenCalledWith({
			method: CalDavMethod.GET,
			url: requestedUrl,
		});
		expect(result.event).toMatchObject({
			calendarUrl: 'https://calendar.example.test/calendars/selected/?calendar=opaque',
			resourceUrl: requestedUrl,
			uid: child,
		});
	});

	it.each([
		['different scheme', 'http://calendar.example.test/calendars/selected/event.ics'],
		['different host', 'https://other.example.test/calendars/selected/event.ics'],
		['different effective port', 'https://calendar.example.test:444/calendars/selected/event.ics'],
		['sibling collection', 'https://calendar.example.test/calendars/sibling/event.ics'],
		['calendar itself', 'https://calendar.example.test/calendars/selected/'],
		['calendar without slash', 'https://calendar.example.test/calendars/selected'],
		['ancestor', 'https://calendar.example.test/calendars/event.ics'],
		['nested child', 'https://calendar.example.test/calendars/selected/nested/event.ics'],
		['case mismatch', 'https://calendar.example.test/calendars/Selected/event.ics'],
		['query cannot supply child', 'https://calendar.example.test/calendars/selected/?event.ics'],
	] as const)('rejects %s before any request', async (_label, value) => {
		const transport = mockTransport();
		const promise = getCalendarEventByResourceUrl(transport, CALENDAR_URL, resourceUrl(value));

		await expect(promise).rejects.toMatchObject({
			name: 'CalDavCalendarEventResourceGetError',
			code: CalendarEventResourceGetFailureCode.OUTSIDE_CALENDAR,
			message: 'The event resource URL is outside the selected calendar.',
		});
		expect(transport.request).not.toHaveBeenCalled();
	});
});

describe('calendar-event direct-resource request and mapping', () => {
	it('performs one bodyless GET and maps the normalized calendar, effective URL, exact ETag and ICS once', async () => {
		const requestedUrl = resourceUrl(
			'https://calendar.example.test/calendars/selected/requested-name?opaque=1',
		);
		const effectiveUrl =
			'https://calendar.example.test/calendars/selected/effective%2Fname?opaque=2';
		const etag = '';
		const ics = eventResource('exact uid ', [
			'SUMMARY:',
			'DESCRIPTION:Description',
			'LOCATION:Room',
			'URL:https://public.example.test/event',
			'X-PRIVATE:preservation-only',
		]);
		const transport = mockTransport(async () =>
			response(ics, {
				effectiveUrl,
				etag,
				headers: Object.freeze({
					'content-location': 'https://attacker.invalid/private.ics',
				}),
			}),
		);

		const result = await getCalendarEventByResourceUrl(transport, CALENDAR_URL, requestedUrl);

		expect(transport.request).toHaveBeenCalledTimes(1);
		expect(transport.request).toHaveBeenCalledWith({ method: CalDavMethod.GET, url: requestedUrl });
		expect(result.event).toEqual({
			calendarUrl: 'https://calendar.example.test/calendars/selected/?calendar=opaque',
			resourceUrl: effectiveUrl,
			etag,
			uid: 'exact uid ',
			summary: '',
			description: 'Description',
			location: 'Room',
			url: 'https://public.example.test/event',
			timeMode: 'timed',
			accessMode: 'editable',
			start: '2040-01-02T10:00:00Z',
			end: '2040-01-02T10:30:00Z',
			timeZoneMode: 'utc',
			startLocal: '2040-01-02T10:00:00',
			endLocal: '2040-01-02T10:30:00',
		});
		expect(result.context.resource.originalIcs).toBe(ics.toString('utf8'));
		expect(result.context.exceptions).toEqual([]);
		expect(JSON.stringify(result)).not.toContain('attacker.invalid');
	});

	it.each([
		['non-200 status', response(undefined, { statusCode: 207 })],
		['missing ETag', response(undefined, { includeEtag: false })],
		[
			'malformed effective URL',
			response(undefined, { effectiveUrl: 'https://calendar.example.test/%ZZ' }),
		],
	] as const)('rejects a %s as the fixed invalid response', async (_label, responseValue) => {
		const transport = mockTransport(async () => responseValue);

		await expect(
			getCalendarEventByResourceUrl(transport, CALENDAR_URL, resourceUrl()),
		).rejects.toMatchObject({
			name: 'CalDavCalendarEventResourceGetError',
			code: CalendarEventResourceGetFailureCode.INVALID_RESPONSE,
			message: 'The CalDAV server returned an invalid calendar-event resource response.',
		});
		expect(transport.request).toHaveBeenCalledTimes(1);
	});

	it('propagates the same transport failure without adding response data', async () => {
		const failure = new CalDavNetworkError();
		const transport = mockTransport(async () => {
			throw failure;
		});

		await expect(
			getCalendarEventByResourceUrl(transport, CALENDAR_URL, resourceUrl()),
		).rejects.toBe(failure);
		expect(failure).not.toHaveProperty('cause');
		expect(failure).not.toHaveProperty('response');
	});

	it('propagates transport not-found distinctly from structural response failure', async () => {
		const failure = new CalDavNotFoundError(404);
		const transport = mockTransport(async () => {
			throw failure;
		});

		await expect(
			getCalendarEventByResourceUrl(transport, CALENDAR_URL, resourceUrl()),
		).rejects.toBe(failure);
	});

	it('propagates malformed iCalendar through the existing parser boundary', async () => {
		const transport = mockTransport(async () => response(Buffer.from('private malformed ICS')));

		await expect(
			getCalendarEventByResourceUrl(transport, CALENDAR_URL, resourceUrl()),
		).rejects.toBeInstanceOf(CalDavICalendarParseError);
	});

	it('propagates unsupported event representation through the existing read-model boundary', async () => {
		const body = calendar([
			'BEGIN:VTODO',
			'UID:private-model-sentinel',
			'DTSTAMP:20400101T000000Z',
			'DTSTART:20400102T100000Z',
			'END:VTODO',
		]);
		const transport = mockTransport(async () => response(body));

		await expect(
			getCalendarEventByResourceUrl(transport, CALENDAR_URL, resourceUrl()),
		).rejects.toBeInstanceOf(CalDavCalendarEventReadModelError);
	});

	it('has no fallback, guessed path, logging, or direct protocol side effect', async () => {
		const transport = mockTransport();
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		await getCalendarEventByResourceUrl(transport, CALENDAR_URL, resourceUrl());

		expect(transport.request).toHaveBeenCalledTimes(1);
		expect(transport.request.mock.calls[0][0]).toEqual({
			method: CalDavMethod.GET,
			url: resourceUrl(),
		});
		expect(consoleError).not.toHaveBeenCalled();
		expect(consoleWarn).not.toHaveBeenCalled();
	});
});
