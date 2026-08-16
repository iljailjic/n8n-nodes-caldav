import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	CalDavTimeZoneReferenceError,
	TimeZoneReferenceFailureCode,
	createCalendarEventTimeZoneExecutionContext,
} from '../../nodes/CalDav/discovery/timeZoneReferences';
import type {
	CalendarEventTimeZoneExecutionContext,
	CalendarEventTimeZoneReference,
	TimeZoneDistributionRequest,
} from '../../nodes/CalDav/discovery/timeZoneReferences';
import type { CalDavTransport, CalDavTransportResponse } from '../../nodes/CalDav/transport/http';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';
import {
	PRIVACY_SENTINELS,
	TZDIST_CAPABILITIES,
	TZDIST_ZONE_RESPONSE,
} from './fixtures/time-zones/synthetic-time-zone-fixtures';

const CALENDAR_URL = validateAbsoluteHttpUrl('https://calendar.example.test/calendars/work/');

function response(
	statusCode: number,
	body = '',
	headers: Readonly<Record<string, string | readonly string[]>> = {},
): CalDavTransportResponse {
	return {
		statusCode,
		headers,
		effectiveUrl: CALENDAR_URL,
		body: Buffer.from(body),
	};
}

const principalXml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/principals/synthetic/</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
const homeXml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/principals/synthetic/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/calendars/synthetic/</d:href></c:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;

function serviceSetXml(serviceUrls: readonly string[]): string {
	return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:response><d:href>/calendars/synthetic/</d:href><d:propstat><d:prop><cs:timezone-service-set>${serviceUrls.map((url) => `<d:href>${url}</d:href>`).join('')}</cs:timezone-service-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
}

interface FactoryInput {
	readonly transport: CalDavTransport;
	readonly request: TimeZoneDistributionRequest;
}

interface ReferenceContext {
	resolveReference(calendarUrl: string, timeZone: string): Promise<CalendarEventTimeZoneReference>;
}

function context(
	transport: CalDavTransport,
	request: TimeZoneDistributionRequest,
): ReferenceContext {
	const factory = createCalendarEventTimeZoneExecutionContext as unknown as (
		input: FactoryInput,
	) => CalendarEventTimeZoneExecutionContext;
	return factory({ transport, request }) as unknown as ReferenceContext;
}

function transportForServices(serviceUrls: readonly string[]): CalDavTransport {
	const replies = [
		response(200, '', { dav: '1, calendar-access, calendar-no-timezone' }),
		response(207, principalXml),
		response(207, homeXml),
		response(207, serviceSetXml(serviceUrls)),
	];
	return {
		serverUrl: 'https://calendar.example.test/',
		request: vi.fn(async () => replies.shift() ?? response(500)),
	};
}

function anonymousSuccess(): TimeZoneDistributionRequest {
	return vi.fn(async (input: unknown) => {
		const url = String((input as { readonly url?: unknown }).url ?? '');
		return url.includes('capabilities')
			? response(200, TZDIST_CAPABILITIES, { 'content-type': 'application/json' })
			: response(200, TZDIST_ZONE_RESPONSE, {
					'content-type': 'text/calendar; charset=utf-8',
					etag: '"synthetic-strong-etag"',
				});
	}) as unknown as TimeZoneDistributionRequest;
}

function captureError(promise: Promise<unknown>): Promise<CalDavTimeZoneReferenceError> {
	return promise.then(
		() => {
			throw new Error('Expected reference resolution to fail.');
		},
		(error: unknown) => {
			expect(error).toBeInstanceOf(CalDavTimeZoneReferenceError);
			return error as CalDavTimeZoneReferenceError;
		},
	);
}

beforeEach(() => vi.restoreAllMocks());

describe('RFC 7809 capability and RFC 7808 TZDIST resolution', () => {
	it('exposes the closed error codes and anonymous execution-context surface', () => {
		expect(TimeZoneReferenceFailureCode).toEqual({
			SERVER_UNSUPPORTED: 'SERVER_UNSUPPORTED',
			ZONE_UNAVAILABLE: 'ZONE_UNAVAILABLE',
			INVALID_RESPONSE: 'INVALID_RESPONSE',
		});
		expect(createCalendarEventTimeZoneExecutionContext).toBeTypeOf('function');
	});

	it('uses exactly four authenticated and two anonymous calls on first-service cold success', async () => {
		const transport = transportForServices(['https://tzdist.example.test/']);
		const request = anonymousSuccess();
		const execution = context(transport, request);

		const reference = await execution.resolveReference(CALENDAR_URL, 'Europe/Prague');

		expect(reference).toMatchObject({
			timeZone: 'Europe/Prague',
			etag: '"synthetic-strong-etag"',
		});
		expect(transport.request).toHaveBeenCalledTimes(4);
		expect(request).toHaveBeenCalledTimes(2);
		expect(
			(transport.request as ReturnType<typeof vi.fn>).mock.calls.map(([call]) => call.method),
		).toEqual(['OPTIONS', 'PROPFIND', 'PROPFIND', 'PROPFIND']);
	});

	it('deduplicates positive results for the normalized calendar-zone pair with zero extra calls', async () => {
		const transport = transportForServices(['https://tzdist.example.test/']);
		const request = anonymousSuccess();
		const execution = context(transport, request);
		const first = await execution.resolveReference(CALENDAR_URL, 'Europe/Prague');
		const second = await execution.resolveReference(
			'https://calendar.example.test/calendars/work',
			'europe/prague',
		);
		expect(second).toBe(first);
		expect(transport.request).toHaveBeenCalledTimes(4);
		expect(request).toHaveBeenCalledTimes(2);
	});

	it('makes capability absence one authenticated call and caches the negative result', async () => {
		const transport: CalDavTransport = {
			serverUrl: 'https://calendar.example.test/',
			request: vi.fn().mockResolvedValue(response(200, '', { dav: '1, calendar-access' })),
		};
		const request = anonymousSuccess();
		const execution = context(transport, request);
		for (let index = 0; index < 2; index += 1) {
			const error = await captureError(execution.resolveReference(CALENDAR_URL, 'Europe/Prague'));
			expect(error.code).toBe(TimeZoneReferenceFailureCode.SERVER_UNSUPPORTED);
		}
		expect(transport.request).toHaveBeenCalledTimes(1);
		expect(request).not.toHaveBeenCalled();
	});

	it('tries advertised services in order, skips duplicate/untrusted services, and continues after 404', async () => {
		const transport = transportForServices([
			'http://127.0.0.1/private/',
			'https://tzdist-a.example.test/',
			'https://tzdist-a.example.test/',
			'https://tzdist-b.example.test/',
		]);
		const request = vi.fn(async (input: unknown) => {
			const url = String((input as { readonly url?: unknown }).url ?? '');
			if (url.includes('127.0.0.1')) throw new Error('SSRF target must not be requested');
			if (url.includes('capabilities'))
				return response(200, TZDIST_CAPABILITIES, { 'content-type': 'application/json' });
			if (url.includes('tzdist-a')) return response(404);
			return response(200, TZDIST_ZONE_RESPONSE, {
				'content-type': 'text/calendar',
				etag: '"valid-zone"',
			});
		}) as unknown as TimeZoneDistributionRequest;
		await expect(
			context(transport, request).resolveReference(CALENDAR_URL, 'Europe/Prague'),
		).resolves.toMatchObject({
			timeZone: 'Europe/Prague',
		});
		const requested = (request as ReturnType<typeof vi.fn>).mock.calls.map(([call]) =>
			String((call as { readonly url?: unknown }).url),
		);
		expect(requested).not.toEqual(expect.arrayContaining([expect.stringContaining('127.0.0.1')]));
		expect(requested.filter((url) => url.includes('tzdist-a'))).toHaveLength(2);
		expect(requested.filter((url) => url.includes('tzdist-b'))).toHaveLength(2);
	});

	it.each([
		['weak ETag', { 'content-type': 'text/calendar', etag: 'W/"weak"' }, TZDIST_ZONE_RESPONSE],
		[
			'duplicate ETag',
			{ 'content-type': 'text/calendar', etag: ['"one"', '"two"'] },
			TZDIST_ZONE_RESPONSE,
		],
		[
			'wrong content type',
			{ 'content-type': 'text/plain', etag: '"strong"' },
			TZDIST_ZONE_RESPONSE,
		],
		[
			'malformed calendar',
			{ 'content-type': 'text/calendar', etag: '"strong"' },
			'private-response-body',
		],
	] as const)('rejects %s as an invalid TZDIST zone response', async (_label, headers, body) => {
		const transport = transportForServices(['https://tzdist.example.test/']);
		const request = vi
			.fn()
			.mockResolvedValueOnce(
				response(200, TZDIST_CAPABILITIES, { 'content-type': 'application/json' }),
			)
			.mockResolvedValueOnce(
				response(200, body, headers),
			) as unknown as TimeZoneDistributionRequest;
		const error = await captureError(
			context(transport, request).resolveReference(CALENDAR_URL, 'Europe/Prague'),
		);
		expect(error.code).toBe(TimeZoneReferenceFailureCode.INVALID_RESPONSE);
	});

	it('never forwards CalDAV authentication, cookies, or credential-derived headers to TZDIST', async () => {
		const transport = transportForServices([PRIVACY_SENTINELS.serviceUrl]);
		const request = anonymousSuccess();
		await context(transport, request).resolveReference(CALENDAR_URL, 'Europe/Prague');
		for (const [input] of (request as ReturnType<typeof vi.fn>).mock.calls) {
			const serialized = JSON.stringify(input).toLowerCase();
			expect(serialized).not.toMatch(
				/authorization|cookie|credential|basic-private|private-cookie/,
			);
		}
	});

	it('does not share positive or negative caches between execution contexts', async () => {
		const firstTransport = transportForServices(['https://tzdist.example.test/']);
		const secondTransport = transportForServices(['https://tzdist.example.test/']);
		await context(firstTransport, anonymousSuccess()).resolveReference(
			CALENDAR_URL,
			'Europe/Prague',
		);
		await context(secondTransport, anonymousSuccess()).resolveReference(
			CALENDAR_URL,
			'Europe/Prague',
		);
		expect(firstTransport.request).toHaveBeenCalledTimes(4);
		expect(secondTransport.request).toHaveBeenCalledTimes(4);
	});
});
