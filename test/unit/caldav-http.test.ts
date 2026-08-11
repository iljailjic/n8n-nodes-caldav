// These Node built-ins are required only for deterministic offline stream and source-boundary tests.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { readFile } from 'node:fs/promises';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { PassThrough, Readable } from 'node:stream';

import type { IExecuteFunctions, IHttpRequestOptions, IN8nHttpFullResponse } from 'n8n-workflow';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CalDavApi } from '../../credentials/CalDavApi.credentials';
import * as httpTransport from '../../nodes/CalDav/transport/http';
import {
	CALDAV_CREDENTIAL_TYPE,
	CALDAV_MAX_ERROR_EXCERPT_BYTES,
	CALDAV_MAX_RESPONSE_BYTES,
	CALDAV_REQUEST_TIMEOUT_MS,
	CalDavAuthenticationError,
	CalDavAuthorizationError,
	CalDavMethod,
	CalDavNetworkError,
	CalDavNotFoundError,
	CalDavRemoteProtocolError,
	CalDavResponseLimitError,
	CalDavTimeoutError,
	CalDavTransportError,
	CalDavTransportErrorCode,
	createCalDavTransport,
	createN8nCalDavRequestHelperAdapter,
	createN8nCalDavTransport,
} from '../../nodes/CalDav/transport/http';
import type {
	CalDavRequestHelperAdapter,
	CalDavTransportRequest,
	N8nCalDavRequestOptions,
} from '../../nodes/CalDav/transport/http';
import { resolveCalDavHref, validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function response(
	statusCode = 200,
	body: Buffer | Readable = Buffer.alloc(0),
	headers: Record<string, unknown> = {},
): IN8nHttpFullResponse {
	return {
		statusCode,
		headers: headers as IN8nHttpFullResponse['headers'],
		body: body instanceof Readable ? body : Readable.from(body.length === 0 ? [] : [body]),
	};
}

function mockAdapter(
	implementation: (options: N8nCalDavRequestOptions) => Promise<IN8nHttpFullResponse> = async () =>
		response(),
): CalDavRequestHelperAdapter & { request: ReturnType<typeof vi.fn> } {
	return { request: vi.fn(implementation) };
}

async function captureError(promise: Promise<unknown>): Promise<CalDavTransportError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(CalDavTransportError);
		return error as CalDavTransportError;
	}

	throw new Error('Expected the transport request to fail');
}

function expectStableError(
	error: CalDavTransportError,
	expectedClass: new (...arguments_: never[]) => CalDavTransportError,
	code: CalDavTransportError['code'],
	message: string,
	statusCode?: number,
): void {
	expect(error).toBeInstanceOf(expectedClass);
	expect(error.name).toBe(expectedClass.name);
	expect(error.code).toBe(code);
	expect(error.message).toBe(message);
	if (statusCode === undefined) {
		expect(error).not.toHaveProperty('statusCode');
	} else {
		expect(error.statusCode).toBe(statusCode);
	}
	expect(error).not.toHaveProperty('cause');
}

describe('CalDAV transport public contract', () => {
	it('exports exactly the accepted runtime surface and constants', () => {
		expect(Object.keys(httpTransport).sort()).toEqual(
			[
				'CALDAV_CREDENTIAL_TYPE',
				'CALDAV_MAX_ERROR_EXCERPT_BYTES',
				'CALDAV_MAX_RESPONSE_BYTES',
				'CALDAV_REQUEST_TIMEOUT_MS',
				'CalDavAuthenticationError',
				'CalDavAuthorizationError',
				'CalDavMethod',
				'CalDavNetworkError',
				'CalDavNotFoundError',
				'CalDavRemoteProtocolError',
				'CalDavResponseLimitError',
				'CalDavTimeoutError',
				'CalDavTransportError',
				'CalDavTransportErrorCode',
				'createCalDavTransport',
				'createN8nCalDavRequestHelperAdapter',
				'createN8nCalDavTransport',
			].sort(),
		);
		expect(CALDAV_CREDENTIAL_TYPE).toBe('calDavApi');
		expect(CALDAV_REQUEST_TIMEOUT_MS).toBe(30_000);
		expect(CALDAV_MAX_RESPONSE_BYTES).toBe(10_485_760);
		expect(CALDAV_MAX_ERROR_EXCERPT_BYTES).toBe(8_192);
		expect(CalDavMethod).toEqual({
			OPTIONS: 'OPTIONS',
			PROPFIND: 'PROPFIND',
			REPORT: 'REPORT',
			GET: 'GET',
			PUT: 'PUT',
			DELETE: 'DELETE',
		});
		expect(CalDavTransportErrorCode).toEqual({
			AUTHENTICATION_FAILED: 'AUTHENTICATION_FAILED',
			AUTHORIZATION_FAILED: 'AUTHORIZATION_FAILED',
			NOT_FOUND: 'NOT_FOUND',
			TIMEOUT: 'TIMEOUT',
			RESPONSE_LIMIT_EXCEEDED: 'RESPONSE_LIMIT_EXCEEDED',
			REMOTE_PROTOCOL_ERROR: 'REMOTE_PROTOCOL_ERROR',
			NETWORK_ERROR: 'NETWORK_ERROR',
		});
	});

	it.each([
		[
			new CalDavAuthenticationError(),
			CalDavAuthenticationError,
			'AUTHENTICATION_FAILED',
			'CalDAV authentication failed.',
		],
		[
			new CalDavAuthorizationError(),
			CalDavAuthorizationError,
			'AUTHORIZATION_FAILED',
			'The CalDAV request is not authorized.',
		],
		[
			new CalDavNotFoundError(),
			CalDavNotFoundError,
			'NOT_FOUND',
			'The requested CalDAV resource was not found.',
		],
		[
			new CalDavTimeoutError(),
			CalDavTimeoutError,
			'TIMEOUT',
			'The CalDAV request timed out after 30 seconds.',
		],
		[
			new CalDavResponseLimitError(),
			CalDavResponseLimitError,
			'RESPONSE_LIMIT_EXCEEDED',
			'The CalDAV response exceeded the 10 MiB size limit.',
		],
		[
			new CalDavRemoteProtocolError(),
			CalDavRemoteProtocolError,
			'REMOTE_PROTOCOL_ERROR',
			'The CalDAV server returned an unexpected response.',
		],
		[
			new CalDavNetworkError(),
			CalDavNetworkError,
			'NETWORK_ERROR',
			'The CalDAV server could not be reached.',
		],
	] as const)('provides stable %s metadata', (error, errorClass, code, message) => {
		expectStableError(error, errorClass, code, message);
	});
});

describe('request forwarding and the n8n helper seam', () => {
	it.each(Object.values(CalDavMethod))(
		'forwards the exact %s verb to the supported helper',
		async (method) => {
			const helperThisValues: unknown[] = [];
			const helper = vi.fn(async function (
				this: unknown,
				credentialType: string,
				options: unknown,
			) {
				helperThisValues.push(this);
				expect(credentialType).toBe(CALDAV_CREDENTIAL_TYPE);
				expect((options as N8nCalDavRequestOptions).method).toBe(method);
				return response(204);
			});
			const context = {
				helpers: { httpRequestWithAuthentication: helper },
			} as unknown as IExecuteFunctions;
			const adapter = createN8nCalDavRequestHelperAdapter(context);

			await adapter.request({
				method,
				url: 'https://calendar.example.test/' as N8nCalDavRequestOptions['url'],
				encoding: 'stream',
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
				disableFollowRedirect: true,
				sendCredentialsOnCrossOriginRedirect: false,
				timeout: 30_000,
			});

			expect(helper).toHaveBeenCalledTimes(1);
			expect(helperThisValues).toEqual([context]);
		},
	);

	it.each([
		[CalDavMethod.OPTIONS, undefined],
		[CalDavMethod.PROPFIND, '<propfind />'],
		[CalDavMethod.REPORT, Buffer.from([0, 1, 2, 255])],
		[CalDavMethod.GET, undefined],
		[CalDavMethod.PUT, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'],
		[CalDavMethod.DELETE, Buffer.alloc(0)],
	] as const)('builds a fresh fixed descriptor for %s', async (method, body) => {
		const adapter = mockAdapter(async () => response(200, Buffer.from('ok')));
		const transport = createCalDavTransport('  https://calendar.example.test/root/  ', adapter);
		const headers = Object.freeze({
			Depth: '1',
			Prefer: 'return=minimal',
			'If-Match': 'W/"opaque%2Fetag"',
		});
		const input = Object.freeze({ method, headers, ...(body === undefined ? {} : { body }) });

		await transport.request(input);

		expect(transport.serverUrl).toBe('https://calendar.example.test/root/');
		expect(adapter.request).toHaveBeenCalledTimes(1);
		const options = adapter.request.mock.calls[0][0] as N8nCalDavRequestOptions;
		expect(options).toEqual({
			method,
			url: 'https://calendar.example.test/root/',
			headers,
			...(body === undefined ? {} : { body }),
			encoding: 'stream',
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			disableFollowRedirect: true,
			sendCredentialsOnCrossOriginRedirect: false,
			timeout: 30_000,
		});
		expect(options.headers).toBe(headers);
		if (Buffer.isBuffer(body)) {
			expect(options.body).toBe(body);
		}
		expect(input).toEqual({ method, headers, ...(body === undefined ? {} : { body }) });
	});

	it('passes an explicit opaque AbsoluteHttpUrl unchanged and composes the effective URL', async () => {
		const adapter = mockAdapter(async () => response(207, Buffer.from('<multistatus />')));
		const transport = createCalDavTransport('https://calendar.example.test/root/', adapter);
		const explicitUrl = validateAbsoluteHttpUrl(
			'https://partition.example.test/a%2Fb//principal/?opaque=%2F',
		);

		const result = await transport.request({ method: CalDavMethod.PROPFIND, url: explicitUrl });

		expect(adapter.request.mock.calls[0][0].url).toBe(explicitUrl);
		expect(result.effectiveUrl).toBe(explicitUrl);
		expect(resolveCalDavHref(result.effectiveUrl, 'calendars/work/')).toBe(
			'https://partition.example.test/a%2Fb//principal/calendars/work/',
		);
	});

	it('rejects an unsupported runtime method before calling the adapter', async () => {
		const adapter = mockAdapter();
		const transport = createCalDavTransport('https://calendar.example.test/', adapter);

		const error = await captureError(
			transport.request({ method: 'PATCH' } as unknown as CalDavTransportRequest),
		);

		expectStableError(
			error,
			CalDavRemoteProtocolError,
			'REMOTE_PROTOCOL_ERROR',
			'The CalDAV server returned an unexpected response.',
		);
		expect(adapter.request).not.toHaveBeenCalled();
	});

	it('uses credential preflight and delegates Basic auth and TLS policy to the authenticated helper', async () => {
		const credentials = {
			serverUrl: '  https://credentials.example.test/dav/  ',
			username: 'username-sentinel',
			password: 'password-sentinel',
			allowUnauthorizedCerts: true,
		};
		const authenticate = new CalDavApi().authenticate;
		if (typeof authenticate !== 'function') {
			throw new Error('Expected custom CalDAV credential authentication');
		}
		let authenticatedOptions: IHttpRequestOptions | undefined;
		const helper = vi.fn(async function (
			this: unknown,
			credentialType: string,
			options: IHttpRequestOptions,
		) {
			expect(credentialType).toBe('calDavApi');
			authenticatedOptions = await authenticate(credentials, options);
			return response(200);
		});
		const context = {
			getCredentials: vi.fn().mockResolvedValue(credentials),
			helpers: { httpRequestWithAuthentication: helper },
		} as unknown as IExecuteFunctions;

		const transport = await createN8nCalDavTransport(context);
		await transport.request({ method: CalDavMethod.OPTIONS });

		expect(transport.serverUrl).toBe('https://credentials.example.test/dav/');
		expect(context.getCredentials).toHaveBeenCalledWith('calDavApi');
		expect(helper).toHaveBeenCalledTimes(1);
		expect(authenticatedOptions?.auth).toEqual({
			username: 'username-sentinel',
			password: 'password-sentinel',
		});
		expect(authenticatedOptions?.skipSslCertificateValidation).toBe(true);
		expect(helper.mock.calls[0][1]).not.toHaveProperty('auth');
		expect(helper.mock.calls[0][1]).not.toHaveProperty('Authorization');
	});

	it.each([
		['credential retrieval failure', undefined, new Error('credential-store-secret')],
		[
			'missing username',
			{ serverUrl: 'https://calendar.example.test', password: 'password-sentinel' },
			undefined,
		],
		[
			'empty password',
			{ serverUrl: 'https://calendar.example.test', username: 'username-sentinel', password: '' },
			undefined,
		],
		[
			'non-string password',
			{ serverUrl: 'https://calendar.example.test', username: 'username-sentinel', password: 42 },
			undefined,
		],
		[
			'invalid server URL',
			{
				serverUrl: 'https://url-user:url-password@calendar.example.test/private',
				username: 'username-sentinel',
				password: 'password-sentinel',
			},
			undefined,
		],
	] as const)('fails %s before any helper request', async (_label, credentials, retrievalError) => {
		const helper = vi.fn();
		const getCredentials = retrievalError
			? vi.fn().mockRejectedValue(retrievalError)
			: vi.fn().mockResolvedValue(credentials);
		const context = {
			getCredentials,
			helpers: { httpRequestWithAuthentication: helper },
		} as unknown as IExecuteFunctions;

		const error = await captureError(createN8nCalDavTransport(context));

		expectStableError(
			error,
			CalDavAuthenticationError,
			'AUTHENTICATION_FAILED',
			'CalDAV authentication failed.',
		);
		expect(helper).not.toHaveBeenCalled();
		expect(JSON.stringify(error)).not.toMatch(
			/credential-store-secret|username-sentinel|password-sentinel|url-user|url-password/,
		);
	});
});

describe('successful response normalization', () => {
	it.each([200, 201, 204, 207])(
		'accepts status %s and preserves body bytes',
		async (statusCode) => {
			const bytes = Buffer.from([0, 1, 2, 0x7f, 0x80, 0xfe, 0xff]);
			const transport = createCalDavTransport(
				'https://calendar.example.test/',
				mockAdapter(async () => response(statusCode, bytes)),
			);

			const result = await transport.request({ method: CalDavMethod.GET });

			expect(result.statusCode).toBe(statusCode);
			expect(result.body.equals(bytes)).toBe(true);
			expect(result.effectiveUrl).toBe('https://calendar.example.test/');
		},
	);

	it('returns an empty Buffer for an empty stream', async () => {
		const result = await createCalDavTransport(
			'https://calendar.example.test/',
			mockAdapter(async () => response(204)),
		).request({ method: CalDavMethod.DELETE });

		expect(Buffer.isBuffer(result.body)).toBe(true);
		expect(result.body).toHaveLength(0);
	});

	it('ASCII-lowercases, snapshots, and merges repeated response headers in encounter order', async () => {
		const repeated = ['second', 'third'];
		const rawHeaders = {
			'Content-Type': 'application/xml',
			'X-Repeated': 'first',
			'x-repeated': repeated,
			'X-Percent': '%2F%2f',
		};
		const result = await createCalDavTransport(
			'https://calendar.example.test/',
			mockAdapter(async () => response(207, Buffer.from('ok'), rawHeaders)),
		).request({ method: CalDavMethod.PROPFIND });

		expect(result.headers).toEqual({
			'content-type': 'application/xml',
			'x-repeated': ['first', 'second', 'third'],
			'x-percent': '%2F%2f',
		});
		repeated.push('mutated');
		rawHeaders['Content-Type'] = 'changed';
		expect(result.headers['content-type']).toBe('application/xml');
		expect(result.headers['x-repeated']).toEqual(['first', 'second', 'third']);
	});

	it.each(['"abc"', 'W/"abc"', '""', ' W/"opaque%2F\\sentinel" '])(
		'preserves opaque ETag %j exactly',
		async (etag) => {
			const result = await createCalDavTransport(
				'https://calendar.example.test/',
				mockAdapter(async () => response(200, Buffer.alloc(0), { eTaG: [etag] })),
			).request({ method: CalDavMethod.GET });

			expect(result.etag).toBe(etag);
			expect(result.headers.etag).toEqual([etag]);
		},
	);

	it('omits an absent ETag rather than synthesizing one', async () => {
		const result = await createCalDavTransport(
			'https://calendar.example.test/',
			mockAdapter(),
		).request({ method: CalDavMethod.GET });

		expect(result).not.toHaveProperty('etag');
	});

	it('rejects conflicting ETag values without exposing either value', async () => {
		const body = new PassThrough();
		const error = await captureError(
			createCalDavTransport(
				'https://calendar.example.test/',
				mockAdapter(async () =>
					response(200, body, { ETag: '"etag-secret-one"', etag: '"etag-secret-two"' }),
				),
			).request({ method: CalDavMethod.GET }),
		);

		expectStableError(
			error,
			CalDavRemoteProtocolError,
			'REMOTE_PROTOCOL_ERROR',
			'The CalDAV server returned an unexpected response.',
			200,
		);
		expect(body.destroyed).toBe(true);
		expect(`${error.stack}${JSON.stringify(error)}`).not.toMatch(/etag-secret-one|etag-secret-two/);
	});

	it.each([
		['a non-string header', { 'X-Malformed': 42 }],
		['an empty ETag array', { ETag: [] }],
	] as const)('destroys a never-ending response stream for %s', async (_label, headers) => {
		const body = new PassThrough();
		const error = await captureError(
			createCalDavTransport(
				'https://calendar.example.test/',
				mockAdapter(async () => response(200, body, headers)),
			).request({ method: CalDavMethod.GET }),
		);

		expectStableError(
			error,
			CalDavRemoteProtocolError,
			'REMOTE_PROTOCOL_ERROR',
			'The CalDAV server returned an unexpected response.',
			200,
		);
		expect(body.destroyed).toBe(true);
	});
});

describe('bounded bodies and one shared deadline', () => {
	it('accepts exactly 10 MiB with missing Content-Length', async () => {
		const chunk = Buffer.alloc(1024 * 1024, 0xa5);
		const body = Readable.from(Array.from({ length: 10 }, () => chunk));
		const result = await createCalDavTransport(
			'https://calendar.example.test/',
			mockAdapter(async () => response(200, body)),
		).request({ method: CalDavMethod.GET });

		expect(result.body).toHaveLength(CALDAV_MAX_RESPONSE_BYTES);
		expect(result.body[0]).toBe(0xa5);
		expect(result.body.at(-1)).toBe(0xa5);
	});

	it('destroys the stream on the first nonempty byte over 10 MiB despite a misleading length', async () => {
		const body = Readable.from([
			Buffer.alloc(CALDAV_MAX_RESPONSE_BYTES, 0x61),
			Buffer.alloc(0),
			Buffer.from('overflow-secret'),
		]);
		const error = await captureError(
			createCalDavTransport(
				'https://calendar.example.test/',
				mockAdapter(async () => response(200, body, { 'Content-Length': '1' })),
			).request({ method: CalDavMethod.GET }),
		);

		expectStableError(
			error,
			CalDavResponseLimitError,
			'RESPONSE_LIMIT_EXCEEDED',
			'The CalDAV response exceeded the 10 MiB size limit.',
		);
		expect(body.destroyed).toBe(true);
		expect(`${error.stack}${JSON.stringify(error)}`).not.toContain('overflow-secret');
	});

	it('rejects an oversized declared length before consuming the stream', async () => {
		let reads = 0;
		const body = new Readable({
			read() {
				reads += 1;
				this.push(Buffer.from('private-body'));
			},
		});
		const error = await captureError(
			createCalDavTransport(
				'https://calendar.example.test/',
				mockAdapter(async () =>
					response(200, body, { 'Content-Length': String(CALDAV_MAX_RESPONSE_BYTES + 1) }),
				),
			).request({ method: CalDavMethod.GET }),
		);

		expect(error).toBeInstanceOf(CalDavResponseLimitError);
		expect(body.destroyed).toBe(true);
		expect(reads).toBe(0);
	});

	it('applies one 30-second deadline while the helper is unresolved', async () => {
		vi.useFakeTimers();
		const adapter = mockAdapter(async () => await new Promise<IN8nHttpFullResponse>(() => {}));
		const request = createCalDavTransport('https://calendar.example.test/', adapter).request({
			method: CalDavMethod.OPTIONS,
		});
		const errorAssertion = captureError(request);

		await vi.advanceTimersByTimeAsync(CALDAV_REQUEST_TIMEOUT_MS);
		const error = await errorAssertion;

		expectStableError(
			error,
			CalDavTimeoutError,
			'TIMEOUT',
			'The CalDAV request timed out after 30 seconds.',
		);
		expect(adapter.request).toHaveBeenCalledTimes(1);
	});

	it('uses the remaining shared deadline for stream consumption and destroys the stream', async () => {
		vi.useFakeTimers();
		const body = new PassThrough();
		const adapter = mockAdapter(
			async () =>
				await new Promise<IN8nHttpFullResponse>((resolve) => {
					// The fake-timer scenario deliberately models helper latency.
					// eslint-disable-next-line @n8n/community-nodes/no-restricted-globals
					setTimeout(() => resolve(response(200, body)), 20_000);
				}),
		);
		const request = createCalDavTransport('https://calendar.example.test/', adapter).request({
			method: CalDavMethod.GET,
		});
		const errorAssertion = captureError(request);

		await vi.advanceTimersByTimeAsync(20_000);
		expect(body.destroyed).toBe(false);
		await vi.advanceTimersByTimeAsync(9_999);
		expect(body.destroyed).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		const error = await errorAssertion;

		expect(error).toBeInstanceOf(CalDavTimeoutError);
		expect(body.destroyed).toBe(true);
		expect(adapter.request).toHaveBeenCalledTimes(1);
	});
});

describe('HTTP, network, and malformed-response errors', () => {
	it.each([
		[401, CalDavAuthenticationError, 'AUTHENTICATION_FAILED', 'CalDAV authentication failed.'],
		[
			403,
			CalDavAuthorizationError,
			'AUTHORIZATION_FAILED',
			'The CalDAV request is not authorized.',
		],
		[404, CalDavNotFoundError, 'NOT_FOUND', 'The requested CalDAV resource was not found.'],
		[
			500,
			CalDavRemoteProtocolError,
			'REMOTE_PROTOCOL_ERROR',
			'The CalDAV server returned an unexpected response.',
		],
	] as const)('maps HTTP %s to a stable error', async (status, errorClass, code, message) => {
		const error = await captureError(
			createCalDavTransport(
				'https://calendar.example.test/',
				mockAdapter(async () => response(status, Buffer.from('private-response'))),
			).request({ method: CalDavMethod.GET }),
		);

		expectStableError(error, errorClass, code, message, status);
		expect(`${error.stack}${JSON.stringify(error)}`).not.toContain('private-response');
	});

	it.each([302, 307, 308])('does not follow an HTTP %s redirect', async (statusCode) => {
		const adapter = mockAdapter(async () =>
			response(statusCode, Buffer.from('private-redirect-body'), {
				Location:
					'https://redirect-user:redirect-password@redirect.example.test/private-path?token=secret',
			}),
		);
		const error = await captureError(
			createCalDavTransport('https://calendar.example.test/', adapter).request({
				method: CalDavMethod.PROPFIND,
			}),
		);

		expect(error).toBeInstanceOf(CalDavRemoteProtocolError);
		expect(error.statusCode).toBe(statusCode);
		expect(adapter.request).toHaveBeenCalledTimes(1);
		expect(`${error.stack}${JSON.stringify(error)}`).not.toMatch(
			/redirect-user|redirect-password|redirect\.example|private-path|private-redirect-body/,
		);
	});

	it('retains at most 8 KiB internally for non-2xx and stops the stream', async () => {
		let yieldedChunks = 0;
		async function* chunks() {
			yieldedChunks += 1;
			yield Buffer.alloc(CALDAV_MAX_ERROR_EXCERPT_BYTES, 0x61);
			for (let index = 0; index < 100; index += 1) {
				yieldedChunks += 1;
				yield Buffer.from(`unread-private-ics-${index}`);
			}
		}
		const body = Readable.from(chunks());
		const error = await captureError(
			createCalDavTransport(
				'https://calendar.example.test/',
				mockAdapter(async () => response(500, body)),
			).request({ method: CalDavMethod.REPORT }),
		);

		expect(error).toBeInstanceOf(CalDavRemoteProtocolError);
		expect(yieldedChunks).toBeLessThan(101);
		expect(body.destroyed).toBe(true);
	});

	it.each(['ETIMEDOUT', 'ECONNABORTED'])('maps helper code %s to timeout', async (code) => {
		const adapter = mockAdapter(async () => {
			throw Object.assign(new Error('adapter-private-message'), { code });
		});
		const error = await captureError(
			createCalDavTransport('https://calendar.example.test/', adapter).request({
				method: CalDavMethod.GET,
			}),
		);

		expect(error).toBeInstanceOf(CalDavTimeoutError);
		expect(`${error.stack}${JSON.stringify(error)}`).not.toContain('adapter-private-message');
	});

	it.each(['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', undefined])(
		'maps helper rejection code %s to network failure',
		async (code) => {
			const adapter = mockAdapter(async () => {
				throw Object.assign(new Error('adapter-private-message'), {
					...(code === undefined ? {} : { code }),
					body: '<private-xml />',
				});
			});
			const error = await captureError(
				createCalDavTransport('https://calendar.example.test/', adapter).request({
					method: CalDavMethod.GET,
				}),
			);

			expectStableError(
				error,
				CalDavNetworkError,
				'NETWORK_ERROR',
				'The CalDAV server could not be reached.',
			);
			expect(`${error.stack}${JSON.stringify(error)}`).not.toMatch(
				/adapter-private-message|private-xml/,
			);
		},
	);

	it('normalizes a usable HTTP envelope attached to a helper rejection', async () => {
		const adapter = mockAdapter(async () => {
			throw { response: response(403, Buffer.from('private-body')) };
		});
		const error = await captureError(
			createCalDavTransport('https://calendar.example.test/', adapter).request({
				method: CalDavMethod.GET,
			}),
		);

		expect(error).toBeInstanceOf(CalDavAuthorizationError);
		expect(error.statusCode).toBe(403);
	});

	it.each([
		['invalid status', (body: Readable) => ({ statusCode: 600, headers: {}, body }), undefined],
		[
			'throwing header getter',
			(body: Readable) => ({
				statusCode: 200,
				body,
				get headers() {
					throw new Error('rejected-header-private-message');
				},
			}),
			200,
		],
		['malformed headers', (body: Readable) => ({ statusCode: 200, headers: [], body }), 200],
	] as const)(
		'maps a rejected helper response with %s to protocol failure and destroys its stream',
		async (_label, makeRejectedResponse, expectedStatusCode) => {
			const body = new PassThrough();
			const adapter = mockAdapter(async () => {
				throw { response: makeRejectedResponse(body) };
			});
			const error = await captureError(
				createCalDavTransport('https://calendar.example.test/', adapter).request({
					method: CalDavMethod.GET,
				}),
			);

			expectStableError(
				error,
				CalDavRemoteProtocolError,
				'REMOTE_PROTOCOL_ERROR',
				'The CalDAV server returned an unexpected response.',
				expectedStatusCode,
			);
			expect(body.destroyed).toBe(true);
			expect(`${error.stack}${JSON.stringify(error)}`).not.toContain(
				'rejected-header-private-message',
			);
		},
	);

	it.each([
		['null envelope', null],
		['missing status', { headers: {}, body: Readable.from([]) }],
		['fractional status', { statusCode: 200.5, headers: {}, body: Readable.from([]) }],
		['out-of-range status', { statusCode: 600, headers: {}, body: Readable.from([]) }],
		['array headers', { statusCode: 200, headers: [], body: Readable.from([]) }],
		['non-text header', { statusCode: 200, headers: { secret: 42 }, body: Readable.from([]) }],
		['non-stream body', { statusCode: 200, headers: {}, body: Buffer.from('private-body') }],
		['empty ETag array', { statusCode: 200, headers: { ETag: [] }, body: Readable.from([]) }],
	] as const)('maps malformed %s to remote protocol failure', async (_label, malformed) => {
		const adapter = mockAdapter(async () => malformed as unknown as IN8nHttpFullResponse);
		const error = await captureError(
			createCalDavTransport('https://calendar.example.test/private-path', adapter).request({
				method: CalDavMethod.GET,
			}),
		);

		expect(error).toBeInstanceOf(CalDavRemoteProtocolError);
		expect(`${error.stack}${JSON.stringify(error)}`).not.toMatch(/private-body|private-path/);
	});

	it('maps a rejected response stream to a sanitized remote protocol error', async () => {
		const body = new Readable({
			read() {
				this.destroy(new Error('stream-private-message'));
			},
		});
		const error = await captureError(
			createCalDavTransport(
				'https://calendar.example.test/',
				mockAdapter(async () => response(200, body)),
			).request({ method: CalDavMethod.GET }),
		);

		expect(error).toBeInstanceOf(CalDavRemoteProtocolError);
		expect(error.statusCode).toBe(200);
		expect(`${error.stack}${JSON.stringify(error)}`).not.toContain('stream-private-message');
	});

	it('never logs or exposes request, credential, header, ETag, body, status, or adapter sentinels', async () => {
		const logSpies = [
			vi.spyOn(console, 'debug').mockImplementation(() => {}),
			vi.spyOn(console, 'info').mockImplementation(() => {}),
			vi.spyOn(console, 'log').mockImplementation(() => {}),
			vi.spyOn(console, 'warn').mockImplementation(() => {}),
			vi.spyOn(console, 'error').mockImplementation(() => {}),
		];
		const sentinels = [
			'username-sentinel',
			'password-sentinel',
			'Basic dXNlcm5hbWU6cGFzc3dvcmQ=',
			'account-path-sentinel',
			'query-sentinel',
			'header-sentinel',
			'etag-sentinel',
			'xml-body-sentinel',
			'ics-body-sentinel',
			'status-text-sentinel',
			'adapter-message-sentinel',
		];
		const privateBody = Buffer.from(
			'Authorization: Basic dXNlcm5hbWU6cGFzc3dvcmQ=\u0000<xml-body-sentinel>BEGIN:VCALENDAR:ics-body-sentinel',
		);
		const adapter = mockAdapter(async () => {
			const helperError = new Error('adapter-message-sentinel');
			Object.assign(helperError, {
				response: {
					...response(500, privateBody, {
						Authorization: 'header-sentinel',
						ETag: '"etag-sentinel"',
					}),
					statusMessage: 'status-text-sentinel',
				},
			});
			throw helperError;
		});
		const transport = createCalDavTransport('https://calendar.example.test/', adapter);
		const error = await captureError(
			transport.request({
				method: CalDavMethod.REPORT,
				url: 'https://calendar.example.test/account-path-sentinel/?value=query-sentinel' as CalDavTransportRequest['url'],
				headers: { Authorization: 'Basic dXNlcm5hbWU6cGFzc3dvcmQ=' },
			}),
		);
		const publicRepresentations = [
			error.name,
			error.message,
			error.stack ?? '',
			String(error),
			JSON.stringify(error),
			JSON.stringify(Object.getOwnPropertyDescriptors(error)),
			JSON.stringify({ ...error }),
		].join('\n');

		for (const sentinel of sentinels) {
			expect(publicRepresentations).not.toContain(sentinel);
		}
		expect(Object.keys(error).sort()).toEqual(['code', 'name', 'statusCode']);
		expect(logSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
	});
});

describe('production dependency boundary', () => {
	it('uses only the approved public helper and approved imports', async () => {
		const source = await readFile(
			new URL('../../nodes/CalDav/transport/http.ts', import.meta.url),
			'utf8',
		);
		const importSpecifiers = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(
			([, specifier]) => specifier,
		);

		expect(importSpecifiers).toEqual([
			'node:stream',
			'n8n-workflow',
			'../../../credentials/CalDavApi.credentials',
			'./url',
		]);
		expect(source.match(/as IHttpRequestOptions/g)).toHaveLength(1);
		expect(source).toContain('httpRequestWithAuthentication.call(');
		expect(source).not.toMatch(/\b(?:fetch|axios|requestWithAuthentication)\b/);
		expect(source).not.toMatch(/n8n-core|@n8n\/backend|node_modules/);
	});
});
