// Source reads are required only for deterministic production dependency-boundary checks.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { readFile } from 'node:fs/promises';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { Readable } from 'node:stream';

import { NodeSslError } from 'n8n-workflow';
import type {
	ICredentialDataDecryptedObject,
	ICredentialsDecrypted,
	ICredentialTestFunctions,
	IN8nHttpFullResponse,
} from 'n8n-workflow';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CalDav } from '../../nodes/CalDav/CalDav.node';
import * as credentialTestModule from '../../nodes/CalDav/methods/credentialTest';
import { testCalDavApiCredentials } from '../../nodes/CalDav/methods/credentialTest';
import { CALDAV_MAX_RESPONSE_BYTES, CalDavMethod } from '../../nodes/CalDav/transport/http';

const PRINCIPAL_XML =
	'<multistatus xmlns="DAV:"><response><href>/endpoint-private/</href><propstat><prop>' +
	'<current-user-principal><href>/principals/account-private/</href></current-user-principal>' +
	'</prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>';
const HOME_XML =
	'<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><response>' +
	'<href>/principal-private/</href><propstat><prop><c:calendar-home-set>' +
	'<href>/calendars/account-private/</href></c:calendar-home-set></prop>' +
	'<status>HTTP/1.1 200 OK</status></propstat></response></multistatus>';
const EMPTY_MULTISTATUS = '<multistatus xmlns="DAV:" />';

const MESSAGES = {
	SUCCESS: 'CalDAV connection successful.',
	AUTHENTICATION: 'Authentication failed. Check the CalDAV username and password.',
	FORBIDDEN: 'The CalDAV account is not permitted to access this endpoint.',
	NOT_CALDAV: 'The server URL does not identify a CalDAV endpoint.',
	INCOMPLETE: 'CalDAV discovery did not provide a usable principal and calendar home.',
	INVALID_URL: 'The CalDAV server URL is invalid.',
	TLS: 'TLS certificate validation failed. Check the server certificate or enable Skip TLS Validation only for development.',
	NETWORK: 'The CalDAV server could not be reached.',
	TIMEOUT: 'The CalDAV connection test timed out.',
	LIMIT: 'The CalDAV server response exceeded the allowed size.',
	REDIRECT: 'The CalDAV server returned an unsafe or invalid redirect.',
	PROTOCOL: 'The CalDAV server returned an invalid protocol response.',
	XML: 'The CalDAV server returned invalid XML.',
	RESOURCE_URL: 'The CalDAV server returned an invalid resource URL.',
	UNKNOWN: 'The CalDAV connection test failed.',
} as const;

interface LegacyRequestOptions {
	readonly method?: string;
	readonly url?: string;
	readonly headers?: Record<string, unknown>;
	readonly auth?: { username?: string; password?: string };
	readonly rejectUnauthorized?: boolean;
	readonly followRedirect?: boolean;
	readonly followAllRedirects?: boolean;
	readonly sendCredentialsOnCrossOriginRedirect?: boolean;
}

function response(
	statusCode = 200,
	body = '',
	headers: Record<string, unknown> = {},
): IN8nHttpFullResponse {
	return {
		statusCode,
		headers: headers as IN8nHttpFullResponse['headers'],
		body: Readable.from(body.length === 0 ? [] : [Buffer.from(body)]),
	};
}

function credential(
	overrides: Partial<ICredentialDataDecryptedObject> = {},
): ICredentialsDecrypted<ICredentialDataDecryptedObject> {
	return {
		id: 'credential-id-private',
		name: 'credential-name-private',
		type: 'calDavApi',
		data: {
			serverUrl: 'https://calendar.example.test/dav/',
			username: 'username-sentinel',
			password: 'password-sentinel',
			allowUnauthorizedCerts: false,
			...overrides,
		},
	};
}

function context(request: ReturnType<typeof vi.fn>): ICredentialTestFunctions {
	return { helpers: { request } } as unknown as ICredentialTestFunctions;
}

async function run(
	request: ReturnType<typeof vi.fn>,
	credentials = credential(),
): Promise<Awaited<ReturnType<typeof testCalDavApiCredentials>>> {
	return await testCalDavApiCredentials.call(context(request), credentials);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('CalDAV credential-test registration and successful orchestration', () => {
	it('exports and registers the exact programmatic credential-test method', () => {
		expect(Object.keys(credentialTestModule)).toEqual(['testCalDavApiCredentials']);
		const node = new CalDav();
		expect(node.description.credentials).toEqual([
			{ name: 'calDavApi', required: true, testedBy: 'testCalDavApiCredentials' },
		]);
		expect(node.methods).toEqual({
			credentialTest: { testCalDavApiCredentials },
		});
	});

	it('requires OPTIONS capability, principal, and home in exact read-only order', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(
				response(200, 'ignored-options-private-body', { DAV: '1, calendar-access' }),
			)
			.mockResolvedValueOnce(response(207, PRINCIPAL_XML))
			.mockResolvedValueOnce(response(207, HOME_XML));

		await expect(run(request)).resolves.toEqual({ status: 'OK', message: MESSAGES.SUCCESS });
		expect(request).toHaveBeenCalledTimes(3);
		const calls = request.mock.calls.map(([options]) => options as LegacyRequestOptions);
		expect(calls.map(({ method }) => method)).toEqual([
			CalDavMethod.OPTIONS,
			CalDavMethod.PROPFIND,
			CalDavMethod.PROPFIND,
		]);
		expect(calls[0]).not.toHaveProperty('headers');
		expect(calls[0]).not.toHaveProperty('body');
		expect(calls[1].headers).toEqual({
			Depth: '0',
			'Content-Type': 'application/xml; charset=utf-8',
		});
		expect(calls[2].headers).toEqual(calls[1].headers);
		expect(calls[1].url).toBe('https://calendar.example.test/dav/');
		expect(calls[2].url).toBe('https://calendar.example.test/principals/account-private/');
		expect(
			calls.every(
				(options) =>
					options.auth?.username === 'username-sentinel' &&
					options.auth?.password === 'password-sentinel' &&
					options.rejectUnauthorized === true &&
					options.followRedirect === false &&
					options.followAllRedirects === false &&
					options.sendCredentialsOnCrossOriginRedirect === false &&
					!('Authorization' in options),
			),
		).toBe(true);
		expect(calls.every(({ method }) => ['OPTIONS', 'PROPFIND'].includes(method ?? ''))).toBe(true);
	});

	it('uses the identical orchestration through a synthetic iCloud partition redirect', async () => {
		const partition = 'https://p42-caldav.icloud.com/account-private/';
		const request = vi
			.fn()
			.mockResolvedValueOnce(response(302, 'redirect-private-body', { Location: partition }))
			.mockResolvedValueOnce(response(200, '', { DAV: 'calendar-access' }))
			.mockResolvedValueOnce(response(302, '', { Location: partition }))
			.mockResolvedValueOnce(response(207, PRINCIPAL_XML))
			.mockResolvedValueOnce(response(207, HOME_XML));

		const result = await run(request, credential({ serverUrl: 'https://caldav.icloud.com/' }));

		expect(result).toEqual({ status: 'OK', message: MESSAGES.SUCCESS });
		expect(request.mock.calls.map(([options]) => options.method)).toEqual([
			'OPTIONS',
			'OPTIONS',
			'PROPFIND',
			'PROPFIND',
			'PROPFIND',
		]);
		expect(JSON.stringify(result)).not.toMatch(/p42|account-private|icloud/i);
	});
});

describe('CalDAV credential-test sanitized failure mapping and stopping', () => {
	it.each([
		[
			'401',
			() => vi.fn().mockResolvedValue(response(401, 'private-401-body')),
			MESSAGES.AUTHENTICATION,
		],
		['403', () => vi.fn().mockResolvedValue(response(403, 'private-403-body')), MESSAGES.FORBIDDEN],
		[
			'missing capability',
			() =>
				vi.fn().mockResolvedValue(response(200, 'private-options-body', { DAV: '1, calendar' })),
			MESSAGES.NOT_CALDAV,
		],
		[
			'unsafe redirect',
			() =>
				vi.fn().mockResolvedValue(
					response(302, 'private-redirect-body', {
						Location: 'https://untrusted.example.test/account-private/',
					}),
				),
			MESSAGES.REDIRECT,
		],
		[
			'TLS',
			() =>
				vi
					.fn()
					.mockRejectedValue(new NodeSslError(new Error('native-certificate-private-message'))),
			MESSAGES.TLS,
		],
		[
			'timeout',
			() =>
				vi
					.fn()
					.mockRejectedValue(
						Object.assign(new Error('native-timeout-private-message'), { code: 'ETIMEDOUT' }),
					),
			MESSAGES.TIMEOUT,
		],
		[
			'network',
			() =>
				vi
					.fn()
					.mockRejectedValue(
						Object.assign(new Error('native-network-private-message'), { code: 'ECONNREFUSED' }),
					),
			MESSAGES.NETWORK,
		],
		[
			'response limit',
			() =>
				vi.fn().mockResolvedValue(
					response(200, '', {
						DAV: 'calendar-access',
						'Content-Length': String(CALDAV_MAX_RESPONSE_BYTES + 1),
					}),
				),
			MESSAGES.LIMIT,
		],
	] as const)(
		'maps %s and stops after the first helper call',
		async (_label, requestFactory, message) => {
			const request = requestFactory();
			await expect(run(request)).resolves.toEqual({ status: 'Error', message });
			expect(request).toHaveBeenCalledTimes(1);
		},
	);

	it.each([
		[404, MESSAGES.NOT_CALDAV],
		[200, MESSAGES.NOT_CALDAV],
	] as const)(
		'maps OPTIONS-stage status/capability case %s as non-CalDAV',
		async (status, message) => {
			const request = vi.fn().mockResolvedValue(response(status, '', { DAV: 'not-caldav' }));
			await expect(run(request)).resolves.toEqual({ status: 'Error', message });
			expect(request).toHaveBeenCalledTimes(1);
		},
	);

	it('maps a downstream 404 as incomplete discovery', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(response(200, '', { DAV: 'calendar-access' }))
			.mockResolvedValueOnce(response(404, 'private-principal-body'));

		await expect(run(request)).resolves.toEqual({
			status: 'Error',
			message: MESSAGES.INCOMPLETE,
		});
		expect(request).toHaveBeenCalledTimes(2);
	});

	it.each([
		[
			'unauthenticated principal',
			'<multistatus xmlns="DAV:"><response><href>/private/</href><propstat><prop>' +
				'<current-user-principal><unauthenticated/></current-user-principal></prop>' +
				'<status>HTTP/1.1 200 OK</status></propstat></response></multistatus>',
			MESSAGES.INCOMPLETE,
		],
		['unavailable principal', EMPTY_MULTISTATUS, MESSAGES.INCOMPLETE],
		['malformed principal XML', '<private-xml-sentinel', MESSAGES.XML],
		[
			'invalid principal href',
			PRINCIPAL_XML.replace(
				'/principals/account-private/',
				'https://url-user:url-password@private.example.test/',
			),
			MESSAGES.RESOURCE_URL,
		],
		[
			'ambiguous principal',
			PRINCIPAL_XML.replace(
				'</current-user-principal>',
				'</current-user-principal><current-user-principal><href>/other-private/</href></current-user-principal>',
			),
			MESSAGES.PROTOCOL,
		],
	] as const)('maps %s without calling calendar-home discovery', async (_label, xml, message) => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(response(200, '', { DAV: 'calendar-access' }))
			.mockResolvedValueOnce(response(207, xml));

		await expect(run(request)).resolves.toEqual({ status: 'Error', message });
		expect(request).toHaveBeenCalledTimes(2);
	});

	it.each([
		['missing home', EMPTY_MULTISTATUS, MESSAGES.INCOMPLETE],
		[
			'forbidden home',
			HOME_XML.replace('HTTP/1.1 200 OK', 'HTTP/1.1 403 Forbidden'),
			MESSAGES.FORBIDDEN,
		],
		['malformed home XML', '<home-private-xml', MESSAGES.XML],
		[
			'invalid home href',
			HOME_XML.replace('/calendars/account-private/', 'https://private.example.test/../home'),
			MESSAGES.RESOURCE_URL,
		],
	] as const)('maps %s after exactly the home request', async (_label, xml, message) => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(response(200, '', { DAV: 'calendar-access' }))
			.mockResolvedValueOnce(response(207, PRINCIPAL_XML))
			.mockResolvedValueOnce(response(207, xml));

		await expect(run(request)).resolves.toEqual({ status: 'Error', message });
		expect(request).toHaveBeenCalledTimes(3);
	});

	it.each([
		['missing username', credential({ username: undefined }), MESSAGES.AUTHENTICATION],
		[
			'invalid configured URL',
			credential({ serverUrl: 'https://url-user:url-password@private.example.test/' }),
			MESSAGES.INVALID_URL,
		],
	] as const)('fails %s before any helper request', async (_label, credentials, message) => {
		const request = vi.fn();
		await expect(run(request, credentials)).resolves.toEqual({ status: 'Error', message });
		expect(request).not.toHaveBeenCalled();
	});

	it('maps a hostile unknown throwable to the stable fallback', async () => {
		const credentials = new Proxy(credential(), {
			get(_target, property) {
				if (property === 'data') throw new Error('unknown-private-message');
				return undefined;
			},
		});
		const request = vi.fn();

		const result = await run(request, credentials);

		expect(result).toEqual({ status: 'Error', message: MESSAGES.UNKNOWN });
		expect(JSON.stringify(result)).not.toContain('unknown-private-message');
		expect(request).not.toHaveBeenCalled();
	});
});

describe('CalDAV credential-test privacy and dependency boundary', () => {
	it('does not log or expose credentials, URLs, headers, XML, ICS, provider, or native prose', async () => {
		const logSpies = [
			vi.spyOn(console, 'debug').mockImplementation(() => {}),
			vi.spyOn(console, 'info').mockImplementation(() => {}),
			vi.spyOn(console, 'log').mockImplementation(() => {}),
			vi.spyOn(console, 'warn').mockImplementation(() => {}),
			vi.spyOn(console, 'error').mockImplementation(() => {}),
		];
		const privateResponse =
			'Authorization: Basic header-sentinel <xml-private-sentinel>BEGIN:VCALENDAR:ics-private-sentinel';
		const request = vi.fn().mockResolvedValue(
			response(500, privateResponse, {
				Authorization: 'header-sentinel',
				'X-Provider': 'provider-private-sentinel',
			}),
		);
		const result = await run(
			request,
			credential({
				serverUrl: 'https://calendar.example.test/account-private/?token=query-private',
			}),
		);
		const representations = [
			result.message,
			String(result),
			JSON.stringify(result),
			JSON.stringify(Object.getOwnPropertyDescriptors(result)),
			JSON.stringify({ ...result }),
		].join('\n');

		expect(result).toEqual({ status: 'Error', message: MESSAGES.PROTOCOL });
		expect(representations).not.toMatch(
			/username-sentinel|password-sentinel|account-private|query-private|header-sentinel|xml-private|ics-private|provider-private|calendar\.example/,
		);
		expect(logSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
	});

	it('keeps orchestration imports and request verbs inside the accepted boundaries', async () => {
		const source = await readFile(
			new URL('../../nodes/CalDav/methods/credentialTest.ts', import.meta.url),
			'utf8',
		);
		const importSpecifiers = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(
			([, specifier]) => specifier,
		);

		expect(importSpecifiers).toEqual([
			'n8n-workflow',
			'../discovery/calendarHome',
			'../discovery/capabilities',
			'../discovery/currentUserPrincipal',
			'../transport/http',
			'../transport/url',
			'../xml/errors',
			'../xml/parser',
		]);
		expect(source).toContain('createN8nCalDavTransport(this, credential)');
		expect(source).not.toMatch(
			/providers|raw|fetch|axios|getCredentials|calendarHomeUrl|console\./,
		);
	});
});
