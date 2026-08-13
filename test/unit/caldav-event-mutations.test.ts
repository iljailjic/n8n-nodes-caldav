// This Node built-in is required only for deterministic offline transport regression responses.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { Readable } from 'node:stream';

import type { IN8nHttpFullResponse } from 'n8n-workflow';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as mutations from '../../nodes/CalDav/events/mutations';
import {
	CalDavCalendarEventMutationError,
	CalendarEventMutationFailureCode,
	createCalendarEventResource,
	deleteCalendarEventResource,
	getCalendarEventMutationEtag,
	updateCalendarEventResource,
} from '../../nodes/CalDav/events/mutations';
import {
	CalDavAuthorizationError,
	CalDavMethod,
	CalDavNetworkError,
	CalDavNotFoundError,
	CalDavPreconditionFailedError,
	createCalDavTransport,
} from '../../nodes/CalDav/transport/http';
import type {
	CalDavRequestHelperAdapter,
	CalDavResponseHeaders,
	CalDavTransport,
	CalDavTransportRequest,
	CalDavTransportResponse,
} from '../../nodes/CalDav/transport/http';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';
import type { AbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';

const CALENDAR_URL = validateAbsoluteHttpUrl(
	'https://Calendar.Example.Test:443/calendars/selected?calendar=opaque',
);
const RESOURCE_URL = validateAbsoluteHttpUrl(
	'https://calendar.example.test/calendars/selected/requested.ics?resource=opaque',
);
const CALENDAR_DATA = 'BEGIN:VCALENDAR\r\nX-PRIVATE:private-ics-sentinel\r\nEND:VCALENDAR\r\n';

type MockTransport = CalDavTransport & { request: ReturnType<typeof vi.fn> };

function resourceUrl(value: string): AbsoluteHttpUrl {
	return validateAbsoluteHttpUrl(value);
}

function response(
	options: {
		readonly statusCode?: number;
		readonly effectiveUrl?: string;
		readonly headers?: CalDavResponseHeaders;
		readonly etag?: string;
		readonly includeEtag?: boolean;
		readonly body?: Buffer;
	} = {},
): CalDavTransportResponse {
	return {
		statusCode: options.statusCode ?? 200,
		headers: options.headers ?? Object.freeze({}),
		effectiveUrl: options.effectiveUrl ?? RESOURCE_URL,
		...(options.includeEtag === false ? {} : { etag: options.etag ?? ' W/"response-etag" ' }),
		body: options.body ?? Buffer.alloc(0),
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

function preconditionTransport(headers: unknown): {
	readonly transport: CalDavTransport;
	readonly request: ReturnType<typeof vi.fn>;
} {
	const request = vi.fn(async (): Promise<IN8nHttpFullResponse> => ({
		statusCode: 412,
		headers: headers as IN8nHttpFullResponse['headers'],
		body: Readable.from([Buffer.from('private-precondition-response')]),
	}));
	const adapter: CalDavRequestHelperAdapter = { request };
	return {
		transport: createCalDavTransport('https://calendar.example.test/', adapter),
		request,
	};
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}

	throw new Error('Expected the mutation to fail');
}

function expectMutationError(
	error: unknown,
	code: (typeof CalendarEventMutationFailureCode)[keyof typeof CalendarEventMutationFailureCode],
	message: string,
): void {
	expect(error).toBeInstanceOf(CalDavCalendarEventMutationError);
	expect(error).toMatchObject({
		name: 'CalDavCalendarEventMutationError',
		code,
		message,
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('calendar-event mutation public contract', () => {
	it('exports exactly the accepted runtime surface and immutable failure codes', () => {
		expect(Object.keys(mutations).sort()).toEqual(
			[
				'CalDavCalendarEventMutationError',
				'CalendarEventMutationFailureCode',
				'createCalendarEventResource',
				'deleteCalendarEventResource',
				'getCalendarEventMutationEtag',
				'updateCalendarEventResource',
			].sort(),
		);
		expect(CalendarEventMutationFailureCode).toEqual({
			OUTSIDE_CALENDAR: 'CALENDAR_EVENT_RESOURCE_OUTSIDE_CALENDAR',
			CREATE_CONFLICT: 'CALENDAR_EVENT_CREATE_CONFLICT',
			CONCURRENCY_CONFLICT: 'CALENDAR_EVENT_CONCURRENCY_CONFLICT',
			MISSING_ETAG: 'CALENDAR_EVENT_MUTATION_ETAG_MISSING',
			INVALID_LOCATION: 'INVALID_CALENDAR_EVENT_RESOURCE_LOCATION',
			INVALID_RESPONSE: 'INVALID_CALENDAR_EVENT_MUTATION_RESPONSE',
		});
		expect(Object.isFrozen(CalendarEventMutationFailureCode)).toBe(true);
		expect(getCalendarEventMutationEtag).toHaveLength(3);
		expect(createCalendarEventResource).toHaveLength(4);
		expect(updateCalendarEventResource).toHaveLength(5);
		expect(deleteCalendarEventResource).toHaveLength(4);
	});

	it.each([
		[
			CalendarEventMutationFailureCode.OUTSIDE_CALENDAR,
			'The event resource URL is outside the selected calendar.',
		],
		[
			CalendarEventMutationFailureCode.CREATE_CONFLICT,
			'A calendar event already exists at the requested resource URL.',
		],
		[
			CalendarEventMutationFailureCode.CONCURRENCY_CONFLICT,
			'The calendar event changed before the mutation could be applied.',
		],
		[
			CalendarEventMutationFailureCode.MISSING_ETAG,
			'The calendar event does not provide an ETag required for a safe mutation.',
		],
		[
			CalendarEventMutationFailureCode.INVALID_LOCATION,
			'The CalDAV server returned an invalid event resource Location.',
		],
		[
			CalendarEventMutationFailureCode.INVALID_RESPONSE,
			'The CalDAV server returned an invalid calendar-event mutation response.',
		],
	] as const)('constructs the fixed privacy-safe %s error', (code, message) => {
		const error = new CalDavCalendarEventMutationError(code);

		expectMutationError(error, code, message);
		expect(Object.keys(error).sort()).toEqual(['code', 'name']);
		expect(
			Object.getOwnPropertyNames(error).every((name) =>
				['stack', 'message', 'name', 'code'].includes(name),
			),
		).toBe(true);
		for (const forbidden of [
			'url',
			'etag',
			'location',
			'ics',
			'response',
			'headers',
			'body',
			'cause',
			'statusCode',
		]) {
			expect(error).not.toHaveProperty(forbidden);
		}
	});
});

describe('calendar-event mutation containment', () => {
	it.each([
		['different scheme', 'http://calendar.example.test/calendars/selected/event.ics'],
		['different host', 'https://other.example.test/calendars/selected/event.ics'],
		['different port', 'https://calendar.example.test:444/calendars/selected/event.ics'],
		['sibling collection', 'https://calendar.example.test/calendars/sibling/event.ics'],
		['calendar itself', 'https://calendar.example.test/calendars/selected/'],
		['ancestor', 'https://calendar.example.test/calendars/event.ics'],
		['nested child', 'https://calendar.example.test/calendars/selected/nested/event.ics'],
		['case mismatch', 'https://calendar.example.test/calendars/Selected/event.ics'],
		['query-only child', 'https://calendar.example.test/calendars/selected/?event.ics'],
	] as const)('rejects %s before a credential-bearing request', async (_label, value) => {
		const target = resourceUrl(value);
		const calls = [
			(transport: CalDavTransport) => getCalendarEventMutationEtag(transport, CALENDAR_URL, target),
			(transport: CalDavTransport) =>
				createCalendarEventResource(transport, CALENDAR_URL, target, CALENDAR_DATA),
			(transport: CalDavTransport) =>
				updateCalendarEventResource(transport, CALENDAR_URL, target, CALENDAR_DATA, '"etag"'),
			(transport: CalDavTransport) =>
				deleteCalendarEventResource(transport, CALENDAR_URL, target, '"etag"'),
		];

		for (const call of calls) {
			const transport = mockTransport();
			await expect(call(transport)).rejects.toMatchObject({
				name: 'CalDavCalendarEventMutationError',
				code: CalendarEventMutationFailureCode.OUTSIDE_CALENDAR,
				message: 'The event resource URL is outside the selected calendar.',
			});
			expect(transport.request).not.toHaveBeenCalled();
		}
	});
});

describe('calendar-event ETag lookup', () => {
	it('performs one bodyless GET and returns its canonical effective URL and exact ETag', async () => {
		const effectiveUrl = 'https://CALENDAR.example.test:443/calendars/selected/opaque%2Fname?x=%2F';
		const etag = ' W/"opaque value" ';
		const transport = mockTransport(async () =>
			response({
				effectiveUrl,
				etag,
				body: Buffer.from('BEGIN:VCALENDAR\r\nPRIVATE:body-sentinel\r\nEND:VCALENDAR\r\n'),
			}),
		);

		await expect(
			getCalendarEventMutationEtag(transport, CALENDAR_URL, RESOURCE_URL),
		).resolves.toEqual({
			resourceUrl: 'https://calendar.example.test/calendars/selected/opaque%2Fname?x=%2F',
			etag,
		});
		expect(transport.request).toHaveBeenCalledTimes(1);
		expect(transport.request).toHaveBeenCalledWith({
			method: CalDavMethod.GET,
			url: RESOURCE_URL,
		});
	});

	it('treats an empty ETag as present', async () => {
		const transport = mockTransport(async () => response({ etag: '' }));

		await expect(
			getCalendarEventMutationEtag(transport, CALENDAR_URL, RESOURCE_URL),
		).resolves.toEqual({ resourceUrl: RESOURCE_URL, etag: '' });
	});

	it('checks status and effective URL before ETag presence', async () => {
		const invalidStatus = mockTransport(async () =>
			response({ statusCode: 207, includeEtag: false }),
		);
		const outside = mockTransport(async () =>
			response({
				effectiveUrl: 'https://other.example.test/private-sentinel',
				includeEtag: false,
			}),
		);

		await expect(
			getCalendarEventMutationEtag(invalidStatus, CALENDAR_URL, RESOURCE_URL),
		).rejects.toMatchObject({ code: CalendarEventMutationFailureCode.INVALID_RESPONSE });
		await expect(
			getCalendarEventMutationEtag(outside, CALENDAR_URL, RESOURCE_URL),
		).rejects.toMatchObject({ code: CalendarEventMutationFailureCode.OUTSIDE_CALENDAR });
	});

	it('maps a malformed effective URL to INVALID_RESPONSE before ETag inspection', async () => {
		const transport = mockTransport(async () =>
			response({ effectiveUrl: 'https://calendar.example.test/private-%ZZ', includeEtag: false }),
		);

		await expect(
			getCalendarEventMutationEtag(transport, CALENDAR_URL, RESOURCE_URL),
		).rejects.toMatchObject({ code: CalendarEventMutationFailureCode.INVALID_RESPONSE });
	});

	it('returns MISSING_ETAG for a valid GET with no ETag', async () => {
		const transport = mockTransport(async () => response({ includeEtag: false }));

		await expect(
			getCalendarEventMutationEtag(transport, CALENDAR_URL, RESOURCE_URL),
		).rejects.toMatchObject({
			name: 'CalDavCalendarEventMutationError',
			code: CalendarEventMutationFailureCode.MISSING_ETAG,
			message: 'The calendar event does not provide an ETag required for a safe mutation.',
		});
		expect(transport.request).toHaveBeenCalledTimes(1);
	});
});

describe('calendar-event conditional create', () => {
	it('sends one exact conditional PUT and maps 201 Location and response ETag', async () => {
		const responseEtag = ' W/"created opaque" ';
		const transport = mockTransport(async () =>
			response({
				statusCode: 201,
				effectiveUrl: RESOURCE_URL,
				etag: responseEtag,
				headers: Object.freeze({ location: 'created%2Fopaque.ics?new=1' }),
				body: Buffer.from('private-response-body'),
			}),
		);

		await expect(
			createCalendarEventResource(transport, CALENDAR_URL, RESOURCE_URL, CALENDAR_DATA),
		).resolves.toEqual({
			statusCode: 201,
			resourceUrl: 'https://calendar.example.test/calendars/selected/created%2Fopaque.ics?new=1',
			etag: responseEtag,
		});
		expect(transport.request).toHaveBeenCalledTimes(1);
		expect(transport.request).toHaveBeenCalledWith({
			method: CalDavMethod.PUT,
			url: RESOURCE_URL,
			headers: {
				'If-None-Match': '*',
				'Content-Type': 'text/calendar; charset=utf-8',
			},
			body: CALENDAR_DATA,
		});
	});

	it('uses the validated effective URL when Location and response ETag are absent', async () => {
		const effectiveUrl = 'https://CALENDAR.example.test:443/calendars/selected/effective.ics';
		const transport = mockTransport(async () =>
			response({ statusCode: 201, effectiveUrl, includeEtag: false }),
		);

		await expect(
			createCalendarEventResource(transport, CALENDAR_URL, RESOURCE_URL, CALENDAR_DATA),
		).resolves.toEqual({
			statusCode: 201,
			resourceUrl: 'https://calendar.example.test/calendars/selected/effective.ics',
		});
	});

	it.each([
		[
			'absolute',
			'https://CALENDAR.example.test:443/calendars/selected/absolute.ics?x=%2F',
			'https://calendar.example.test/calendars/selected/absolute.ics?x=%2F',
		],
		[
			'relative singleton array',
			['singleton.ics'],
			'https://calendar.example.test/calendars/selected/singleton.ics',
		],
	] as const)(
		'accepts a valid %s Location without requesting it',
		async (_label, location, expected) => {
			const transport = mockTransport(async () =>
				response({ statusCode: 201, headers: { location } }),
			);

			await expect(
				createCalendarEventResource(transport, CALENDAR_URL, RESOURCE_URL, CALENDAR_DATA),
			).resolves.toMatchObject({ statusCode: 201, resourceUrl: expected });
			expect(transport.request).toHaveBeenCalledTimes(1);
		},
	);

	it('maps one terminal transport 412 to CREATE_CONFLICT without retry', async () => {
		const transport = mockTransport(async () => {
			throw new CalDavPreconditionFailedError(412);
		});

		await expect(
			createCalendarEventResource(transport, CALENDAR_URL, RESOURCE_URL, CALENDAR_DATA),
		).rejects.toMatchObject({
			name: 'CalDavCalendarEventMutationError',
			code: CalendarEventMutationFailureCode.CREATE_CONFLICT,
			message: 'A calendar event already exists at the requested resource URL.',
		});
		expect(transport.request).toHaveBeenCalledTimes(1);
	});

	it('keeps CREATE_CONFLICT authoritative over duplicate case-variant response ETags', async () => {
		const { transport, request } = preconditionTransport({
			ETag: '"private-first"',
			eTaG: '"private-second"',
		});

		await expect(
			createCalendarEventResource(transport, CALENDAR_URL, RESOURCE_URL, CALENDAR_DATA),
		).rejects.toMatchObject({
			name: 'CalDavCalendarEventMutationError',
			code: CalendarEventMutationFailureCode.CREATE_CONFLICT,
			message: 'A calendar event already exists at the requested resource URL.',
		});
		expect(request).toHaveBeenCalledTimes(1);
	});

	it('keeps CREATE_CONFLICT authoritative over an unrelated malformed response header', async () => {
		const { transport, request } = preconditionTransport({ 'X-Malformed': 42 });

		await expect(
			createCalendarEventResource(transport, CALENDAR_URL, RESOURCE_URL, CALENDAR_DATA),
		).rejects.toMatchObject({
			name: 'CalDavCalendarEventMutationError',
			code: CalendarEventMutationFailureCode.CREATE_CONFLICT,
			message: 'A calendar event already exists at the requested resource URL.',
		});
		expect(request).toHaveBeenCalledTimes(1);
	});
});

describe('calendar-event conditional update', () => {
	it.each([' W/"opaque value" ', '"quoted"', ''])(
		'uses supplied opaque ETag %j exactly and performs no lookup',
		async (etag) => {
			const transport = mockTransport(async () =>
				response({ statusCode: 204, includeEtag: false }),
			);

			await expect(
				updateCalendarEventResource(transport, CALENDAR_URL, RESOURCE_URL, CALENDAR_DATA, etag),
			).resolves.toEqual({ statusCode: 204, resourceUrl: RESOURCE_URL });
			expect(transport.request).toHaveBeenCalledTimes(1);
			expect(transport.request).toHaveBeenCalledWith({
				method: CalDavMethod.PUT,
				url: RESOURCE_URL,
				headers: {
					'If-Match': etag,
					'Content-Type': 'text/calendar; charset=utf-8',
				},
				body: CALENDAR_DATA,
			});
		},
	);

	it('looks up a missing ETag and mutates the validated effective URL once', async () => {
		const effectiveUrl = resourceUrl(
			'https://calendar.example.test/calendars/selected/effective%2Ftarget.ics',
		);
		const fetchedEtag = ' W/"fresh exact" ';
		const transport = mockTransport(async (input) => {
			if (input.method === CalDavMethod.GET) {
				return response({ effectiveUrl, etag: fetchedEtag });
			}
			return response({ statusCode: 200, effectiveUrl, etag: '"updated"' });
		});

		await expect(
			updateCalendarEventResource(transport, CALENDAR_URL, RESOURCE_URL, CALENDAR_DATA),
		).resolves.toEqual({ statusCode: 200, resourceUrl: effectiveUrl, etag: '"updated"' });
		expect(transport.request).toHaveBeenCalledTimes(2);
		expect(transport.request.mock.calls.map(([input]) => input)).toEqual([
			{ method: CalDavMethod.GET, url: RESOURCE_URL },
			{
				method: CalDavMethod.PUT,
				url: effectiveUrl,
				headers: {
					'If-Match': fetchedEtag,
					'Content-Type': 'text/calendar; charset=utf-8',
				},
				body: CALENDAR_DATA,
			},
		]);
	});

	it('stops before PUT when the lookup has no ETag', async () => {
		const transport = mockTransport(async () => response({ includeEtag: false }));

		await expect(
			updateCalendarEventResource(transport, CALENDAR_URL, RESOURCE_URL, CALENDAR_DATA),
		).rejects.toMatchObject({ code: CalendarEventMutationFailureCode.MISSING_ETAG });
		expect(transport.request).toHaveBeenCalledTimes(1);
		expect(transport.request).toHaveBeenCalledWith({ method: CalDavMethod.GET, url: RESOURCE_URL });
	});

	it('maps a helper-GET 412 to CONCURRENCY_CONFLICT without attempting PUT', async () => {
		const transport = mockTransport(async () => {
			throw new CalDavPreconditionFailedError(412);
		});

		await expect(
			updateCalendarEventResource(transport, CALENDAR_URL, RESOURCE_URL, CALENDAR_DATA),
		).rejects.toMatchObject({
			name: 'CalDavCalendarEventMutationError',
			code: CalendarEventMutationFailureCode.CONCURRENCY_CONFLICT,
			message: 'The calendar event changed before the mutation could be applied.',
		});
		expect(transport.request).toHaveBeenCalledTimes(1);
		expect(transport.request).toHaveBeenCalledWith({ method: CalDavMethod.GET, url: RESOURCE_URL });
	});

	it('maps a read-to-write 412 to one terminal CONCURRENCY_CONFLICT', async () => {
		const transport = mockTransport(async (input) => {
			if (input.method === CalDavMethod.GET) {
				return response({ etag: '"stale-after-read"' });
			}
			throw new CalDavPreconditionFailedError(412);
		});

		await expect(
			updateCalendarEventResource(transport, CALENDAR_URL, RESOURCE_URL, CALENDAR_DATA),
		).rejects.toMatchObject({
			code: CalendarEventMutationFailureCode.CONCURRENCY_CONFLICT,
			message: 'The calendar event changed before the mutation could be applied.',
		});
		expect(transport.request).toHaveBeenCalledTimes(2);
		expect(transport.request.mock.calls[1][0].headers?.['If-Match']).toBe('"stale-after-read"');
	});

	it('keeps CONCURRENCY_CONFLICT authoritative over duplicate case-variant response ETags', async () => {
		const { transport, request } = preconditionTransport({
			ETag: '"private-first"',
			eTaG: '"private-second"',
		});

		await expect(
			updateCalendarEventResource(transport, CALENDAR_URL, RESOURCE_URL, CALENDAR_DATA, '"stale"'),
		).rejects.toMatchObject({
			name: 'CalDavCalendarEventMutationError',
			code: CalendarEventMutationFailureCode.CONCURRENCY_CONFLICT,
			message: 'The calendar event changed before the mutation could be applied.',
		});
		expect(request).toHaveBeenCalledTimes(1);
	});
});

describe('calendar-event conditional delete', () => {
	it('sends one bodyless DELETE with the supplied ETag and returns exact 204 metadata', async () => {
		const etag = '"quoted exact"';
		const transport = mockTransport(async () => response({ statusCode: 204, includeEtag: false }));

		await expect(
			deleteCalendarEventResource(transport, CALENDAR_URL, RESOURCE_URL, etag),
		).resolves.toEqual({ statusCode: 204, resourceUrl: RESOURCE_URL });
		expect(transport.request).toHaveBeenCalledTimes(1);
		expect(transport.request).toHaveBeenCalledWith({
			method: CalDavMethod.DELETE,
			url: RESOURCE_URL,
			headers: { 'If-Match': etag },
		});
		expect(transport.request.mock.calls[0][0]).not.toHaveProperty('body');
	});

	it('looks up an absent ETag, targets the effective URL, and preserves exact 202', async () => {
		const effectiveUrl = resourceUrl(
			'https://calendar.example.test/calendars/selected/effective-delete.ics',
		);
		const transport = mockTransport(async (input) =>
			input.method === CalDavMethod.GET
				? response({ effectiveUrl, etag: '"fresh-delete"' })
				: response({ statusCode: 202, effectiveUrl, includeEtag: false }),
		);

		await expect(
			deleteCalendarEventResource(transport, CALENDAR_URL, RESOURCE_URL),
		).resolves.toEqual({ statusCode: 202, resourceUrl: effectiveUrl });
		expect(transport.request.mock.calls.map(([input]) => input)).toEqual([
			{ method: CalDavMethod.GET, url: RESOURCE_URL },
			{
				method: CalDavMethod.DELETE,
				url: effectiveUrl,
				headers: { 'If-Match': '"fresh-delete"' },
			},
		]);
	});

	it('stops before DELETE when the lookup has no ETag', async () => {
		const transport = mockTransport(async () => response({ includeEtag: false }));

		await expect(
			deleteCalendarEventResource(transport, CALENDAR_URL, RESOURCE_URL),
		).rejects.toMatchObject({ code: CalendarEventMutationFailureCode.MISSING_ETAG });
		expect(transport.request).toHaveBeenCalledTimes(1);
		expect(transport.request).toHaveBeenCalledWith({ method: CalDavMethod.GET, url: RESOURCE_URL });
	});

	it('maps a helper-GET 412 to CONCURRENCY_CONFLICT without attempting DELETE', async () => {
		const transport = mockTransport(async () => {
			throw new CalDavPreconditionFailedError(412);
		});

		await expect(
			deleteCalendarEventResource(transport, CALENDAR_URL, RESOURCE_URL),
		).rejects.toMatchObject({
			name: 'CalDavCalendarEventMutationError',
			code: CalendarEventMutationFailureCode.CONCURRENCY_CONFLICT,
			message: 'The calendar event changed before the mutation could be applied.',
		});
		expect(transport.request).toHaveBeenCalledTimes(1);
		expect(transport.request).toHaveBeenCalledWith({ method: CalDavMethod.GET, url: RESOURCE_URL });
	});

	it.each([
		[new CalDavPreconditionFailedError(412), CalendarEventMutationFailureCode.CONCURRENCY_CONFLICT],
		[new CalDavNotFoundError(404), undefined],
		[new CalDavAuthorizationError(403), undefined],
	] as const)('keeps failure %s distinct without retry', async (failure, serviceCode) => {
		const transport = mockTransport(async () => {
			throw failure;
		});

		const error = await captureError(
			deleteCalendarEventResource(transport, CALENDAR_URL, RESOURCE_URL, '"etag"'),
		);
		if (serviceCode === undefined) {
			expect(error).toBe(failure);
		} else {
			expect(error).toMatchObject({ code: serviceCode });
		}
		expect(transport.request).toHaveBeenCalledTimes(1);
	});

	it('rejects a successful mutation whose effective URL leaves the selected calendar', async () => {
		const transport = mockTransport(async () =>
			response({
				statusCode: 204,
				effectiveUrl: 'https://other.example.test/private-effective-url',
			}),
		);

		await expect(
			updateCalendarEventResource(transport, CALENDAR_URL, RESOURCE_URL, CALENDAR_DATA, '"etag"'),
		).rejects.toMatchObject({ code: CalendarEventMutationFailureCode.OUTSIDE_CALENDAR });
		expect(transport.request).toHaveBeenCalledTimes(1);
	});
});

describe('calendar-event mutation response metadata and precedence', () => {
	it.each([
		[
			'create',
			200,
			(transport: CalDavTransport) =>
				createCalendarEventResource(transport, CALENDAR_URL, RESOURCE_URL, CALENDAR_DATA),
		],
		[
			'update',
			201,
			(transport: CalDavTransport) =>
				updateCalendarEventResource(transport, CALENDAR_URL, RESOURCE_URL, CALENDAR_DATA, '"e"'),
		],
		[
			'delete',
			201,
			(transport: CalDavTransport) =>
				deleteCalendarEventResource(transport, CALENDAR_URL, RESOURCE_URL, '"e"'),
		],
	] as const)('rejects unexpected successful status for %s', async (_name, statusCode, call) => {
		const transport = mockTransport(async () => response({ statusCode }));

		await expect(call(transport)).rejects.toMatchObject({
			code: CalendarEventMutationFailureCode.INVALID_RESPONSE,
			message: 'The CalDAV server returned an invalid calendar-event mutation response.',
		});
		expect(transport.request).toHaveBeenCalledTimes(1);
	});

	it.each([200, 204] as const)('accepts exact update status %s', async (statusCode) => {
		const transport = mockTransport(async () => response({ statusCode, etag: '"result"' }));

		await expect(
			updateCalendarEventResource(
				transport,
				CALENDAR_URL,
				RESOURCE_URL,
				CALENDAR_DATA,
				'"request"',
			),
		).resolves.toEqual({ statusCode, resourceUrl: RESOURCE_URL, etag: '"result"' });
	});

	it.each([200, 202, 204] as const)('accepts exact delete status %s', async (statusCode) => {
		const transport = mockTransport(async () => response({ statusCode, etag: '"result"' }));

		await expect(
			deleteCalendarEventResource(transport, CALENDAR_URL, RESOURCE_URL, '"request"'),
		).resolves.toEqual({ statusCode, resourceUrl: RESOURCE_URL, etag: '"result"' });
	});

	it.each([
		['empty', ''],
		['duplicate', ['created.ics', 'other.ics']],
		['empty array', []],
		['malformed percent', 'private-%ZZ-sentinel'],
		['userinfo', 'https://user:password@calendar.example.test/private-location'],
		['fragment', 'created.ics#private-fragment'],
		['downgrade', 'http://calendar.example.test/calendars/selected/private-location'],
		['non-text', 42],
	] as const)('maps %s Location to INVALID_LOCATION', async (_label, location) => {
		const transport = mockTransport(async () =>
			response({
				statusCode: 201,
				headers: { location: location as never },
			}),
		);

		const error = await captureError(
			createCalendarEventResource(transport, CALENDAR_URL, RESOURCE_URL, CALENDAR_DATA),
		);
		expectMutationError(
			error,
			CalendarEventMutationFailureCode.INVALID_LOCATION,
			'The CalDAV server returned an invalid event resource Location.',
		);
	});

	it.each([
		['cross-origin', 'https://other.example.test/private-location'],
		['sibling', 'https://calendar.example.test/calendars/sibling/private-location'],
		['nested', 'nested/private-location'],
	] as const)('maps valid but %s Location to OUTSIDE_CALENDAR', async (_label, location) => {
		const transport = mockTransport(async () =>
			response({ statusCode: 201, headers: { location } }),
		);

		await expect(
			createCalendarEventResource(transport, CALENDAR_URL, RESOURCE_URL, CALENDAR_DATA),
		).rejects.toMatchObject({
			code: CalendarEventMutationFailureCode.OUTSIDE_CALENDAR,
			message: 'The event resource URL is outside the selected calendar.',
		});
		expect(transport.request).toHaveBeenCalledTimes(1);
	});

	it('ignores Location, Content-Location, body, and request validator on non-201 metadata', async () => {
		const transport = mockTransport(async () =>
			response({
				statusCode: 204,
				includeEtag: false,
				headers: {
					location: 'https://attacker.invalid/private-location',
					'content-location': 'https://attacker.invalid/private-content-location',
				},
				body: Buffer.from('ETag: "guessed-from-private-body"'),
			}),
		);

		await expect(
			updateCalendarEventResource(
				transport,
				CALENDAR_URL,
				RESOURCE_URL,
				CALENDAR_DATA,
				'"request-validator"',
			),
		).resolves.toEqual({ statusCode: 204, resourceUrl: RESOURCE_URL });
	});

	it('propagates unrelated transport failures unchanged', async () => {
		const failure = new CalDavNetworkError();
		const transport = mockTransport(async () => {
			throw failure;
		});

		await expect(
			updateCalendarEventResource(transport, CALENDAR_URL, RESOURCE_URL, CALENDAR_DATA, '"etag"'),
		).rejects.toBe(failure);
	});

	it('never leaks private mutation inputs, metadata, transport data, or logs', async () => {
		const logSpies = [
			vi.spyOn(console, 'debug').mockImplementation(() => undefined),
			vi.spyOn(console, 'info').mockImplementation(() => undefined),
			vi.spyOn(console, 'log').mockImplementation(() => undefined),
			vi.spyOn(console, 'warn').mockImplementation(() => undefined),
			vi.spyOn(console, 'error').mockImplementation(() => undefined),
		];
		const sentinels = [
			'private-ics-sentinel',
			'credential-sentinel',
			'private-resource-sentinel',
			'private-location-sentinel',
			'private-etag-sentinel',
			'private-response-body-sentinel',
		];
		const privateResource = resourceUrl(
			'https://calendar.example.test/calendars/selected/private-resource-sentinel',
		);
		const transport = mockTransport(async () =>
			response({
				statusCode: 201,
				headers: { location: 'private-location-sentinel#fragment' },
				etag: '"private-etag-sentinel"',
				body: Buffer.from('private-response-body-sentinel credential-sentinel'),
			}),
		);
		const error = await captureError(
			createCalendarEventResource(transport, CALENDAR_URL, privateResource, CALENDAR_DATA),
		);
		const representations = [
			(error as Error).name,
			(error as Error).message,
			(error as Error).stack ?? '',
			String(error),
			JSON.stringify(error),
			JSON.stringify(Object.getOwnPropertyDescriptors(error)),
			JSON.stringify({ ...(error as object) }),
		].join('\n');

		for (const sentinel of sentinels) {
			expect(representations).not.toContain(sentinel);
		}
		expect(logSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
	});
});
