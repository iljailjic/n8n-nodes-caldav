// Node streams are required for deterministic offline redirect-body tests.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { PassThrough, Readable } from 'node:stream';

import type { IN8nHttpFullResponse } from 'n8n-workflow';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
	CalDavProviderAdapter,
	CalDavProviderRegistry,
} from '../../nodes/CalDav/providers/types';
import {
	CALDAV_MAX_ERROR_EXCERPT_BYTES,
	CALDAV_REQUEST_TIMEOUT_MS,
	CalDavInsecureRedirectError,
	CalDavInvalidRedirectError,
	CalDavMethod,
	CalDavRedirectLimitError,
	CalDavRedirectLoopError,
	CalDavTimeoutError,
	CalDavTransportError,
	CalDavUntrustedTargetError,
	createCalDavTransport,
} from '../../nodes/CalDav/transport/http';
import type {
	CalDavRequestHelperAdapter,
	CalDavRequestHeaders,
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
	implementation: (options: N8nCalDavRequestOptions) => Promise<IN8nHttpFullResponse>,
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

	throw new Error('Expected transport failure');
}

describe('secure redirect target handling', () => {
	it.each([
		['next', 'https://calendar.example.test/base/next'],
		['/root', 'https://calendar.example.test/root'],
		['?view=all', 'https://calendar.example.test/base/current?view=all'],
		['//CALENDAR.EXAMPLE.TEST:443/partition', 'https://calendar.example.test/partition'],
		['https://calendar.example.test/absolute', 'https://calendar.example.test/absolute'],
	] as const)(
		'resolves redirect Location %s against the current effective URL',
		async (location, expected) => {
			let call = 0;
			const adapter = mockAdapter(async () => {
				call += 1;
				return call === 1
					? response(302, Buffer.from('redirect'), { Location: location })
					: response(207);
			});
			const result = await createCalDavTransport(
				'https://calendar.example.test/base/current?old=1',
				adapter,
			).request({ method: CalDavMethod.PROPFIND });

			expect(adapter.request).toHaveBeenCalledTimes(2);
			expect(adapter.request.mock.calls[1][0].url).toBe(expected);
			expect(result.effectiveUrl).toBe(expected);
			expect(resolveCalDavHref(result.effectiveUrl, 'child')).toBe(new URL('child', expected).href);
		},
	);

	it.each([
		['missing', {}],
		['empty string', { Location: '' }],
		['empty array', { Location: [] }],
		['multiple values', { Location: ['/one', '/two'] }],
		['non-string', { Location: 42 }],
		['userinfo', { Location: 'https://user:password@calendar.example.test/private' }],
		['fragment', { Location: '/next#private' }],
		['dot segment', { Location: '../private' }],
		['backslash', { Location: '/private\\target' }],
		['unsupported scheme', { Location: 'ftp://calendar.example.test/private' }],
		['malformed percent', { Location: '/private%GG' }],
	] as const)('rejects %s Location before another helper call', async (_label, headers) => {
		const body = new PassThrough();
		const adapter = mockAdapter(async () => response(302, body, headers));
		const error = await captureError(
			createCalDavTransport('https://calendar.example.test/base/', adapter).request({
				method: CalDavMethod.GET,
			}),
		);

		expect(error).toBeInstanceOf(CalDavInvalidRedirectError);
		expect(error.code).toBe('INVALID_REDIRECT');
		expect(error.statusCode).toBe(302);
		expect(body.destroyed).toBe(true);
		expect(adapter.request).toHaveBeenCalledTimes(1);
	});

	it('accepts a one-element Location array', async () => {
		let call = 0;
		const adapter = mockAdapter(async () => {
			call += 1;
			return call === 1 ? response(301, Buffer.alloc(0), { Location: ['/next'] }) : response(204);
		});

		await createCalDavTransport('https://calendar.example.test/', adapter).request({
			method: CalDavMethod.GET,
		});
		expect(adapter.request.mock.calls[1][0].url).toBe('https://calendar.example.test/next');
	});

	it('maps an inaccessible Location to the stable invalid-redirect error', async () => {
		const body = new PassThrough();
		const headers = Object.create(null) as Record<string, unknown>;
		Object.defineProperty(headers, 'Location', {
			enumerable: true,
			get() {
				throw new Error('location-getter-sentinel');
			},
		});
		const adapter = mockAdapter(async () => response(302, body, headers));
		const error = await captureError(
			createCalDavTransport('https://calendar.example.test/', adapter).request({
				method: CalDavMethod.GET,
			}),
		);

		expect(error).toBeInstanceOf(CalDavInvalidRedirectError);
		expect(error.statusCode).toBe(302);
		expect(body.destroyed).toBe(true);
		expect(`${error.stack}${JSON.stringify(error)}`).not.toContain('location-getter-sentinel');
	});

	it('distinguishes HTTPS downgrade from other invalid redirects', async () => {
		const adapter = mockAdapter(async () =>
			response(308, Buffer.from('private'), { Location: 'http://calendar.example.test/private' }),
		);
		const error = await captureError(
			createCalDavTransport('https://calendar.example.test/', adapter).request({
				method: CalDavMethod.GET,
			}),
		);

		expect(error).toBeInstanceOf(CalDavInsecureRedirectError);
		expect(error.code).toBe('INSECURE_REDIRECT');
		expect(error.statusCode).toBe(308);
		expect(adapter.request).toHaveBeenCalledTimes(1);
	});

	it.each(['https://other.example.test/private', 'https://calendar.example.test:444/private'])(
		'denies an untrusted standard redirect without calling its target: %s',
		async (target) => {
			const adapter = mockAdapter(async () => response(307, Buffer.alloc(0), { Location: target }));
			const error = await captureError(
				createCalDavTransport('https://calendar.example.test/', adapter).request({
					method: CalDavMethod.REPORT,
				}),
			);

			expect(error).toBeInstanceOf(CalDavUntrustedTargetError);
			expect(error.statusCode).toBe(307);
			expect(adapter.request).toHaveBeenCalledTimes(1);
		},
	);

	it('denies an untrusted initial target before any helper call', async () => {
		const adapter = mockAdapter(async () => response());
		const error = await captureError(
			createCalDavTransport('https://calendar.example.test/', adapter).request({
				method: CalDavMethod.GET,
				url: validateAbsoluteHttpUrl('https://other.example.test/private'),
			}),
		);

		expect(error).toBeInstanceOf(CalDavUntrustedTargetError);
		expect(error).not.toHaveProperty('statusCode');
		expect(adapter.request).not.toHaveBeenCalled();
	});

	it('authenticates an approved iCloud entry-to-partition redirect', async () => {
		let call = 0;
		const adapter = mockAdapter(async () => {
			call += 1;
			return call === 1
				? response(302, Buffer.alloc(0), {
						Location: 'https://p42-caldav.icloud.com/account/principal/',
					})
				: response(207);
		});
		const result = await createCalDavTransport(
			'https://caldav.icloud.com/account/',
			adapter,
		).request({
			method: CalDavMethod.PROPFIND,
		});

		expect(adapter.request).toHaveBeenCalledTimes(2);
		expect(adapter.request.mock.calls[1][0].url).toBe(
			'https://p42-caldav.icloud.com/account/principal/',
		);
		expect(result.effectiveUrl).toBe('https://p42-caldav.icloud.com/account/principal/');
		for (const [options] of adapter.request.mock.calls) {
			expect(options.disableFollowRedirect).toBe(true);
			expect(options.sendCredentialsOnCrossOriginRedirect).toBe(false);
		}
	});

	it.each([
		'https://p4-caldav.icloud.com/private',
		'https://p42-caldav.icloud.com.evil.test/private',
		'https://p42-caldav.icloud.com:444/private',
	])('denies iCloud lookalike redirect targets: %s', async (target) => {
		const adapter = mockAdapter(async () => response(302, Buffer.alloc(0), { Location: target }));
		const error = await captureError(
			createCalDavTransport('https://caldav.icloud.com/', adapter).request({
				method: CalDavMethod.GET,
			}),
		);

		expect(error).toBeInstanceOf(CalDavUntrustedTargetError);
		expect(adapter.request).toHaveBeenCalledTimes(1);
	});
});

describe('redirect methods, bodies, and headers', () => {
	const cases = Object.values(CalDavMethod).flatMap((method) =>
		[301, 302, 303, 307, 308].map((statusCode) => [method, statusCode] as const),
	);

	it.each(cases)('applies redirect semantics for %s after HTTP %s', async (method, statusCode) => {
		let call = 0;
		const adapter = mockAdapter(async () => {
			call += 1;
			return call === 1
				? response(statusCode, Buffer.alloc(0), { Location: '/next' })
				: response(200);
		});
		const body = Buffer.from([0, 1, 2, 255]);
		const headers: CalDavRequestHeaders = Object.freeze({
			Host: 'caller-host',
			hOsT: 'duplicate-host',
			'Content-Type': 'application/xml',
			'content-Length': '4',
			Depth: '1',
			Authorization: 'token-sentinel',
		});
		const originalBytes = Buffer.from(body);

		await createCalDavTransport('https://calendar.example.test/', adapter).request({
			method,
			headers,
			body,
		});

		const first = adapter.request.mock.calls[0][0];
		const redirected = adapter.request.mock.calls[1][0];
		expect(first.headers).toBe(headers);
		expect(first.body).toBe(body);
		expect(redirected.method).toBe(statusCode === 303 ? CalDavMethod.GET : method);
		expect(redirected.headers).toEqual(
			statusCode === 303
				? { Depth: '1', Authorization: 'token-sentinel' }
				: {
						'Content-Type': 'application/xml',
						'content-Length': '4',
						Depth: '1',
						Authorization: 'token-sentinel',
					},
		);
		expect(redirected).not.toHaveProperty('Host');
		if (statusCode === 303) {
			expect(redirected).not.toHaveProperty('body');
		} else {
			expect(redirected.body).toBe(body);
		}
		expect(body.equals(originalBytes)).toBe(true);
		expect(headers).toEqual({
			Host: 'caller-host',
			hOsT: 'duplicate-host',
			'Content-Type': 'application/xml',
			'content-Length': '4',
			Depth: '1',
			Authorization: 'token-sentinel',
		});
	});
});

describe('redirect counts, loops, bodies, and deadline', () => {
	it('follows five redirects and returns the sixth response', async () => {
		let call = 0;
		const adapter = mockAdapter(async () => {
			call += 1;
			return call <= 5
				? response(302, Buffer.alloc(0), { Location: `/hop-${call}` })
				: response(207, Buffer.from('done'));
		});
		const result = await createCalDavTransport(
			'https://calendar.example.test/start',
			adapter,
		).request({
			method: CalDavMethod.PROPFIND,
		});

		expect(adapter.request).toHaveBeenCalledTimes(6);
		expect(result.effectiveUrl).toBe('https://calendar.example.test/hop-5');
		expect(result.body.toString()).toBe('done');
	});

	it('rejects a sixth redirect before a seventh helper call', async () => {
		let call = 0;
		const sixthBody = new PassThrough();
		const adapter = mockAdapter(async () => {
			call += 1;
			return response(302, call === 6 ? sixthBody : Buffer.alloc(0), { Location: `/hop-${call}` });
		});
		const error = await captureError(
			createCalDavTransport('https://calendar.example.test/start', adapter).request({
				method: CalDavMethod.GET,
			}),
		);

		expect(error).toBeInstanceOf(CalDavRedirectLimitError);
		expect(error.statusCode).toBe(302);
		expect(adapter.request).toHaveBeenCalledTimes(6);
		expect(sixthBody.destroyed).toBe(true);
	});

	it.each([
		['direct', ['/start']],
		['indirect', ['/middle', '/start']],
		['canonical alias', ['HTTPS://CALENDAR.EXAMPLE.TEST:443/start']],
	] as const)('detects a %s redirect loop before another call', async (_label, locations) => {
		let call = 0;
		const adapter = mockAdapter(async () => {
			const location = locations[Math.min(call, locations.length - 1)];
			call += 1;
			return response(301, Buffer.alloc(0), { Location: location });
		});
		const error = await captureError(
			createCalDavTransport('https://calendar.example.test/start', adapter).request({
				method: CalDavMethod.GET,
			}),
		);

		expect(error).toBeInstanceOf(CalDavRedirectLoopError);
		expect(adapter.request).toHaveBeenCalledTimes(locations.length);
	});

	it('treats distinct queries as distinct redirect identities', async () => {
		let call = 0;
		const adapter = mockAdapter(async () => {
			call += 1;
			return call <= 2
				? response(302, Buffer.alloc(0), { Location: `?page=${call}` })
				: response(200);
		});
		await createCalDavTransport('https://calendar.example.test/start?page=0', adapter).request({
			method: CalDavMethod.GET,
		});

		expect(adapter.request).toHaveBeenCalledTimes(3);
	});

	it('includes the 303 method transformation in loop identity', async () => {
		let call = 0;
		const adapter = mockAdapter(async () => {
			call += 1;
			return call === 1 ? response(303, Buffer.alloc(0), { Location: '/start' }) : response(200);
		});
		await createCalDavTransport('https://calendar.example.test/start', adapter).request({
			method: CalDavMethod.PUT,
			body: 'body',
		});

		expect(adapter.request).toHaveBeenCalledTimes(2);
		expect(adapter.request.mock.calls[1][0].method).toBe(CalDavMethod.GET);
	});

	it.each([0, CALDAV_MAX_ERROR_EXCERPT_BYTES, CALDAV_MAX_ERROR_EXCERPT_BYTES + 1])(
		'bounds and destroys a %s-byte redirect body before the next hop',
		async (size) => {
			let call = 0;
			const body = Readable.from(size === 0 ? [] : [Buffer.alloc(size, 0x61)]);
			const adapter = mockAdapter(async () => {
				call += 1;
				return call === 1 ? response(302, body, { Location: '/next' }) : response(200);
			});

			await createCalDavTransport('https://calendar.example.test/start', adapter).request({
				method: CalDavMethod.GET,
			});
			expect(body.destroyed).toBe(true);
			expect(adapter.request).toHaveBeenCalledTimes(2);
		},
	);

	it('uses one deadline across redirect helper calls', async () => {
		vi.useFakeTimers();
		let call = 0;
		const adapter = mockAdapter(async () => {
			call += 1;
			if (call === 1) {
				return await new Promise<IN8nHttpFullResponse>((resolve) => {
					// Fake timers model latency across multiple authenticated helper calls.
					// eslint-disable-next-line @n8n/community-nodes/no-restricted-globals
					setTimeout(() => resolve(response(302, Buffer.alloc(0), { Location: '/next' })), 20_000);
				});
			}
			return await new Promise<IN8nHttpFullResponse>(() => {});
		});
		const errorAssertion = captureError(
			createCalDavTransport('https://calendar.example.test/start', adapter).request({
				method: CalDavMethod.GET,
			}),
		);

		await vi.advanceTimersByTimeAsync(20_000);
		expect(adapter.request).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(CALDAV_REQUEST_TIMEOUT_MS - 20_000);
		const error = await errorAssertion;
		expect(error).toBeInstanceOf(CalDavTimeoutError);
		expect(adapter.request).toHaveBeenCalledTimes(2);
	});

	it('destroys a blocked redirect stream at the shared deadline and makes no later call', async () => {
		vi.useFakeTimers();
		const body = new PassThrough();
		const adapter = mockAdapter(async () => response(302, body, { Location: '/next' }));
		const errorAssertion = captureError(
			createCalDavTransport('https://calendar.example.test/start', adapter).request({
				method: CalDavMethod.GET,
			}),
		);

		await vi.advanceTimersByTimeAsync(CALDAV_REQUEST_TIMEOUT_MS);
		const error = await errorAssertion;
		expect(error).toBeInstanceOf(CalDavTimeoutError);
		expect(body.destroyed).toBe(true);
		expect(adapter.request).toHaveBeenCalledTimes(1);
	});
});

describe('provider selection and redirect leakage', () => {
	it('selects one provider from the configured URL for the transport lifetime', async () => {
		const provider: CalDavProviderAdapter = {
			id: 'test-provider',
			matchesConfiguredServerUrl: vi.fn().mockReturnValue(true),
			allowsCredentialForwarding: vi.fn().mockReturnValue(true),
		};
		const registry: CalDavProviderRegistry = { select: vi.fn().mockReturnValue(provider) };
		let call = 0;
		const adapter = mockAdapter(async () => {
			call += 1;
			return call === 1
				? response(302, Buffer.alloc(0), { Location: 'https://other.example.test/next' })
				: response(200);
		});
		const transport = createCalDavTransport('https://configured.example.test/', adapter, registry);

		await transport.request({ method: CalDavMethod.GET });
		expect(registry.select).toHaveBeenCalledTimes(1);
		expect(registry.select).toHaveBeenCalledWith('https://configured.example.test/');
		expect(provider.matchesConfiguredServerUrl).not.toHaveBeenCalled();
		expect(provider.allowsCredentialForwarding).toHaveBeenCalledTimes(2);
	});

	it('does not expose provider, Location, target, body, or header sentinels', async () => {
		const provider: CalDavProviderAdapter = {
			id: 'provider-id-sentinel',
			matchesConfiguredServerUrl: vi.fn().mockReturnValue(true),
			allowsCredentialForwarding: vi
				.fn()
				.mockReturnValueOnce(true)
				.mockImplementationOnce(() => {
					throw new Error('provider-message-sentinel');
				}),
		};
		const registry: CalDavProviderRegistry = { select: vi.fn().mockReturnValue(provider) };
		const adapter = mockAdapter(async () =>
			response(302, Buffer.from('redirect-body-sentinel'), {
				Location: 'https://target-sentinel.example/private-path?query-sentinel=1',
				Authorization: 'header-sentinel',
			}),
		);
		const error = await captureError(
			createCalDavTransport(
				'https://configured-sentinel.example/account-sentinel/',
				adapter,
				registry,
			).request({ method: CalDavMethod.GET }),
		);
		const publicRepresentation = `${error.stack}\n${JSON.stringify(error)}\n${JSON.stringify(
			Object.getOwnPropertyDescriptors(error),
		)}`;

		expect(error).toBeInstanceOf(CalDavUntrustedTargetError);
		expect(publicRepresentation).not.toMatch(
			/provider-id-sentinel|provider-message-sentinel|target-sentinel|private-path|query-sentinel|redirect-body-sentinel|header-sentinel|configured-sentinel|account-sentinel/,
		);
	});
});
