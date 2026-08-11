// Node file reads are required only for deterministic source-boundary tests.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import * as currentUserPrincipalDiscovery from '../../nodes/CalDav/discovery/currentUserPrincipal';
import {
	CalDavCurrentUserPrincipalDiscoveryError,
	CurrentUserPrincipalDiscoveryFailureCode,
	CurrentUserPrincipalDiscoveryKind,
	discoverCurrentUserPrincipal,
} from '../../nodes/CalDav/discovery/currentUserPrincipal';
import {
	CalDavAuthenticationError,
	CalDavAuthorizationError,
	CalDavMethod,
} from '../../nodes/CalDav/transport/http';
import type {
	CalDavTransport,
	CalDavTransportRequest,
	CalDavTransportResponse,
} from '../../nodes/CalDav/transport/http';
import { CalDavUrlValidationError } from '../../nodes/CalDav/transport/url';
import { CalDavXmlParseError } from '../../nodes/CalDav/xml/parser';

const CURRENT_USER_PRINCIPAL_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:current-user-principal/>
  </d:prop>
</d:propfind>`;

const UNAVAILABLE_OUTCOME = {
	kind: 'unavailable',
	code: 'CURRENT_USER_PRINCIPAL_UNAVAILABLE',
	message: 'The CalDAV current-user principal is unavailable.',
} as const;

const UNAUTHENTICATED_OUTCOME = {
	kind: 'unauthenticated',
	code: 'CURRENT_USER_PRINCIPAL_UNAUTHENTICATED',
	message: 'The CalDAV server did not authenticate the current user.',
} as const;

type MockTransport = CalDavTransport & { request: ReturnType<typeof vi.fn> };

function transportResponse(
	xml: string,
	statusCode = 207,
	effectiveUrl = 'https://calendar.example.test/discovery/root/',
): CalDavTransportResponse {
	return {
		statusCode,
		headers: {},
		effectiveUrl,
		body: Buffer.from(xml),
	};
}

function mockTransport(
	implementation: (input: CalDavTransportRequest) => Promise<CalDavTransportResponse> = async () =>
		transportResponse(''),
): MockTransport {
	return {
		serverUrl: 'https://configured-sentinel.example/account-sentinel/',
		request: vi.fn(implementation),
	};
}

function propstat(properties: string, status = 'HTTP/1.1 200 OK'): string {
	return `<propstat><prop>${properties}</prop><status>${status}</status></propstat>`;
}

function responseWithPropstats(propstats: string, href = '/response-path-sentinel/'): string {
	return `<response><href>${href}</href>${propstats}</response>`;
}

function multistatus(responses: string): string {
	return `<multistatus xmlns="DAV:">${responses}</multistatus>`;
}

function principalProperty(value: string, attributes = ''): string {
	return `<current-user-principal${attributes}>${value}</current-user-principal>`;
}

function principalDocument(value: string, effectiveStatus = 'HTTP/1.1 200 OK'): string {
	return multistatus(responseWithPropstats(propstat(principalProperty(value), effectiveStatus)));
}

async function captureDiscoveryError(
	promise: Promise<unknown>,
): Promise<CalDavCurrentUserPrincipalDiscoveryError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(CalDavCurrentUserPrincipalDiscoveryError);
		return error as CalDavCurrentUserPrincipalDiscoveryError;
	}

	throw new Error('Expected current-user-principal discovery to fail');
}

async function expectSemanticError(
	xml: string,
	code: CalDavCurrentUserPrincipalDiscoveryError['code'],
): Promise<CalDavCurrentUserPrincipalDiscoveryError> {
	const transport = mockTransport(async () => transportResponse(xml));
	const error = await captureDiscoveryError(discoverCurrentUserPrincipal(transport));

	expect(error.code).toBe(code);
	expect(transport.request).toHaveBeenCalledTimes(1);
	return error;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('current-user-principal public contract and request', () => {
	it('exports exactly the accepted runtime surface, discriminants, and failure codes', () => {
		expect(Object.keys(currentUserPrincipalDiscovery).sort()).toEqual(
			[
				'CalDavCurrentUserPrincipalDiscoveryError',
				'CurrentUserPrincipalDiscoveryFailureCode',
				'CurrentUserPrincipalDiscoveryKind',
				'discoverCurrentUserPrincipal',
			].sort(),
		);
		expect(CurrentUserPrincipalDiscoveryKind).toEqual({
			AUTHENTICATED: 'authenticated',
			UNAUTHENTICATED: 'unauthenticated',
			UNAVAILABLE: 'unavailable',
		});
		expect(CurrentUserPrincipalDiscoveryFailureCode).toEqual({
			UNAUTHENTICATED: 'CURRENT_USER_PRINCIPAL_UNAUTHENTICATED',
			UNAVAILABLE: 'CURRENT_USER_PRINCIPAL_UNAVAILABLE',
			INVALID_RESPONSE: 'INVALID_CURRENT_USER_PRINCIPAL_RESPONSE',
			AMBIGUOUS_RESPONSE: 'AMBIGUOUS_CURRENT_USER_PRINCIPAL_RESPONSE',
		});
	});

	it.each([
		[
			'INVALID_CURRENT_USER_PRINCIPAL_RESPONSE',
			'The CalDAV server returned an invalid current-user principal response.',
		],
		[
			'AMBIGUOUS_CURRENT_USER_PRINCIPAL_RESPONSE',
			'The CalDAV server returned an ambiguous current-user principal response.',
		],
	] as const)('provides exact sanitized metadata for %s', (code, message) => {
		const error = new CalDavCurrentUserPrincipalDiscoveryError(code);

		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({
			name: 'CalDavCurrentUserPrincipalDiscoveryError',
			code,
			message,
		});
		expect(error).not.toHaveProperty('cause');
		expect(Object.keys(error).sort()).toEqual(['code', 'name']);
	});

	it('makes exactly one request with the exact depth-0 PROPFIND descriptor', async () => {
		const xml = principalDocument('<href>/principals/account/</href>');
		const transport = mockTransport(async () => transportResponse(xml));

		await expect(discoverCurrentUserPrincipal(transport)).resolves.toEqual({
			kind: 'authenticated',
			principalUrl: 'https://calendar.example.test/principals/account/',
		});
		expect(transport.request).toHaveBeenCalledTimes(1);
		expect(transport.request).toHaveBeenCalledWith({
			method: CalDavMethod.PROPFIND,
			headers: {
				Depth: '0',
				'Content-Type': 'application/xml; charset=utf-8',
			},
			body: CURRENT_USER_PRINCIPAL_BODY,
		});
		expect(Object.keys(transport.request.mock.calls[0][0]).sort()).toEqual([
			'body',
			'headers',
			'method',
		]);
	});
});

describe('current-user-principal selection and URL resolution', () => {
	it.each([
		['child/', 'https://partition.example.test/discovery/root/child/'],
		['/principals/account/', 'https://partition.example.test/principals/account/'],
		['//principal.example.test/users/account/', 'https://principal.example.test/users/account/'],
		[
			'https://absolute.example.test/users/account/',
			'https://absolute.example.test/users/account/',
		],
	] as const)('resolves %s against the final effective URL', async (href, principalUrl) => {
		const transport = mockTransport(async () =>
			transportResponse(
				principalDocument(`<href>${href}</href>`),
				207,
				'https://partition.example.test/discovery/root/',
			),
		);

		await expect(discoverCurrentUserPrincipal(transport)).resolves.toEqual({
			kind: 'authenticated',
			principalUrl,
		});
		expect(transport.request).toHaveBeenCalledTimes(1);
	});

	it('keeps a relative synthetic iCloud principal on the effective partition host', async () => {
		const transport = mockTransport(async () =>
			transportResponse(
				principalDocument('<href>principals/account-sentinel/</href>'),
				207,
				'https://p42-caldav.icloud.com/account-sentinel/',
			),
		);

		await expect(discoverCurrentUserPrincipal(transport)).resolves.toEqual({
			kind: 'authenticated',
			principalUrl: 'https://p42-caldav.icloud.com/account-sentinel/principals/account-sentinel/',
		});
	});

	it('uses only successful propstats and ignores a failed duplicate', async () => {
		const xml = multistatus(
			responseWithPropstats(
				propstat(principalProperty('<href>/failed-private/</href>'), 'HTTP/1.1 404 Not Found') +
					propstat(principalProperty('<href>/successful/</href>')),
			),
		);

		await expect(
			discoverCurrentUserPrincipal(mockTransport(async () => transportResponse(xml))),
		).resolves.toEqual({
			kind: 'authenticated',
			principalUrl: 'https://calendar.example.test/successful/',
		});
	});

	it.each(['HTTP/1.1 401 Unauthorized', 'HTTP/1.1 403 Forbidden', 'HTTP/1.1 404 Not Found'])(
		'returns unavailable when the property exists only with %s',
		async (status) => {
			await expect(
				discoverCurrentUserPrincipal(
					mockTransport(async () =>
						transportResponse(principalDocument('<href>/private/</href>', status)),
					),
				),
			).resolves.toEqual(UNAVAILABLE_OUTCOME);
		},
	);

	it('rejects every duplicate successful property, including identical copies', async () => {
		const samePropstat = multistatus(
			responseWithPropstats(
				propstat(
					principalProperty('<href>/same/</href>') + principalProperty('<href>/same/</href>'),
				),
			),
		);
		const splitPropstats = multistatus(
			responseWithPropstats(
				propstat(principalProperty('<href>/one/</href>')) +
					propstat(principalProperty('<unauthenticated/>')),
			),
		);

		await expectSemanticError(samePropstat, 'AMBIGUOUS_CURRENT_USER_PRINCIPAL_RESPONSE');
		await expectSemanticError(splitPropstats, 'AMBIGUOUS_CURRENT_USER_PRINCIPAL_RESPONSE');
	});

	it('rejects multiple direct responses without selecting by order or response href', async () => {
		const xml = multistatus(
			responseWithPropstats(propstat(principalProperty('<href>/first/</href>')), '/first/') +
				responseWithPropstats(propstat(principalProperty('<href>/second/</href>')), '/second/'),
		);

		await expectSemanticError(xml, 'AMBIGUOUS_CURRENT_USER_PRINCIPAL_RESPONSE');
	});

	it('rejects a response-level status form', async () => {
		const xml = multistatus(
			'<response><href>/response-private/</href><status>HTTP/1.1 200 OK</status></response>',
		);

		await expectSemanticError(xml, 'INVALID_CURRENT_USER_PRINCIPAL_RESPONSE');
	});

	it.each([
		['empty multistatus', multistatus('')],
		[
			'missing property',
			multistatus(responseWithPropstats(propstat('<displayname>Calendar</displayname>'))),
		],
		[
			'wrong-namespace property',
			multistatus(
				responseWithPropstats(
					propstat(
						'<x:current-user-principal xmlns:x="urn:not-dav"><href>/ignored/</href></x:current-user-principal>',
					),
				),
			),
		],
	] as const)('returns unavailable for %s', async (_label, xml) => {
		await expect(
			discoverCurrentUserPrincipal(mockTransport(async () => transportResponse(xml))),
		).resolves.toEqual(UNAVAILABLE_OUTCOME);
	});
});

describe('current-user-principal typed property content', () => {
	it('returns the exact unauthenticated outcome for an empty DAV value', async () => {
		await expect(
			discoverCurrentUserPrincipal(
				mockTransport(async () => transportResponse(principalDocument('<unauthenticated/>'))),
			),
		).resolves.toEqual(UNAUTHENTICATED_OUTCOME);
	});

	it('treats prefixes, comments, processing instructions, CDATA, and XML whitespace equivalently', async () => {
		const xml =
			'<x:multistatus xmlns:x="DAV:"><x:response><x:href>/response/</x:href>' +
			'<x:propstat><x:prop><x:current-user-principal> \n<!-- ignored --><?p ignored?>' +
			'<x:href>principal<![CDATA[%2Fpart]]>/</x:href>\t</x:current-user-principal></x:prop>' +
			'<x:status>HTTP/1.1 200 OK</x:status></x:propstat></x:response></x:multistatus>';

		await expect(
			discoverCurrentUserPrincipal(mockTransport(async () => transportResponse(xml))),
		).resolves.toEqual({
			kind: 'authenticated',
			principalUrl: 'https://calendar.example.test/discovery/root/principal%2Fpart/',
		});
	});

	it('allows only XML whitespace inside DAV unauthenticated', async () => {
		await expect(
			discoverCurrentUserPrincipal(
				mockTransport(async () =>
					transportResponse(principalDocument('<unauthenticated>\t\n\r </unauthenticated>')),
				),
			),
		).resolves.toEqual(UNAUTHENTICATED_OUTCOME);
	});

	it.each([
		['empty property', principalProperty('')],
		['only whitespace', principalProperty(' \t\n')],
		['unknown child', principalProperty('<owner/>')],
		['wrong-namespace href', principalProperty('<x:href xmlns:x="urn:not-dav">/x/</x:href>')],
		[
			'wrong-namespace unauthenticated',
			principalProperty('<x:unauthenticated xmlns:x="urn:not-dav"/>'),
		],
		['non-whitespace sibling text', principalProperty('private<href>/x/</href>')],
		['multiple value elements', principalProperty('<href>/x/</href><unauthenticated/>')],
		['attributed property', principalProperty('<href>/x/</href>', ' private="yes"')],
		['empty href', principalProperty('<href/>')],
		['attributed href', principalProperty('<href private="yes">/x/</href>')],
		['nested href content', principalProperty('<href><segment>private</segment></href>')],
		['attributed unauthenticated', principalProperty('<unauthenticated private="yes"/>')],
		['unauthenticated text', principalProperty('<unauthenticated>private</unauthenticated>')],
		[
			'nested unauthenticated content',
			principalProperty('<unauthenticated><private/></unauthenticated>'),
		],
	] as const)('rejects %s as invalid typed content', async (_label, property) => {
		const xml = multistatus(responseWithPropstats(propstat(property)));

		await expectSemanticError(xml, 'INVALID_CURRENT_USER_PRINCIPAL_RESPONSE');
	});
});

describe('current-user-principal transport, XML, and URL error propagation', () => {
	it.each([
		[new CalDavAuthenticationError(401), 'AUTHENTICATION_FAILED'],
		[new CalDavAuthorizationError(403), 'AUTHORIZATION_FAILED'],
	] as const)('propagates %s before parsing any response body', async (transportError, code) => {
		const transport = mockTransport(async () => {
			throw transportError;
		});

		await expect(discoverCurrentUserPrincipal(transport)).rejects.toBe(transportError);
		expect(transportError.code).toBe(code);
		expect(transport.request).toHaveBeenCalledTimes(1);
	});

	it.each([200, 201, 204])(
		'rejects a transport-successful HTTP %s without parsing',
		async (status) => {
			const transport = mockTransport(async () =>
				transportResponse('xml-body-sentinel-that-is-not-xml', status),
			);
			const error = await captureDiscoveryError(discoverCurrentUserPrincipal(transport));

			expect(error.code).toBe('INVALID_CURRENT_USER_PRINCIPAL_RESPONSE');
			expect(transport.request).toHaveBeenCalledTimes(1);
		},
	);

	it('propagates the existing safe XML parse error unchanged', async () => {
		const transport = mockTransport(async () =>
			transportResponse('<multistatus xmlns="DAV:"><response>xml-private'),
		);
		let caughtError: unknown;
		try {
			await discoverCurrentUserPrincipal(transport);
		} catch (error) {
			caughtError = error;
		}

		expect(caughtError).toBeInstanceOf(CalDavXmlParseError);
		expect(caughtError).toMatchObject({
			name: 'CalDavXmlParseError',
			code: 'TRUNCATED_XML',
			message: 'The XML document ended unexpectedly.',
		});
		expect(transport.request).toHaveBeenCalledTimes(1);
	});

	it.each([
		['whitespace', ' private/'],
		['malformed percent', 'private%GG'],
		['userinfo', 'https://user:password@example.test/private'],
		['fragment', 'private#fragment'],
		['dot segment', '../private'],
		['backslash', 'private\\path'],
		['unsupported scheme', 'ftp://example.test/private'],
		['downgrade', 'http://example.test/private'],
	] as const)('propagates the safe URL error for a %s href', async (_label, href) => {
		const transport = mockTransport(async () =>
			transportResponse(
				principalDocument(`<href>${href}</href>`),
				207,
				'https://effective-sentinel.example/private/',
			),
		);

		await expect(discoverCurrentUserPrincipal(transport)).rejects.toBeInstanceOf(
			CalDavUrlValidationError,
		);
		expect(transport.request).toHaveBeenCalledTimes(1);
	});

	it('never logs or leaks discovery inputs through failures, outcomes, or serialization', async () => {
		const logSpies = [
			vi.spyOn(console, 'debug').mockImplementation(() => {}),
			vi.spyOn(console, 'info').mockImplementation(() => {}),
			vi.spyOn(console, 'log').mockImplementation(() => {}),
			vi.spyOn(console, 'warn').mockImplementation(() => {}),
			vi.spyOn(console, 'error').mockImplementation(() => {}),
		];
		const sentinels = [
			'configured-sentinel',
			'effective-sentinel',
			'partition-sentinel',
			'response-path-sentinel',
			'principal-path-sentinel',
			'username-sentinel',
			'password-sentinel',
			'token-sentinel',
			'authorization-sentinel',
			'xml-body-sentinel',
			'native-message-sentinel',
		];
		const invalidXml = multistatus(
			responseWithPropstats(
				propstat(
					principalProperty(
						'<href>principal-path-sentinel</href><unauthenticated>xml-body-sentinel</unauthenticated>',
					),
				),
			),
		);
		const transport = mockTransport(async () => ({
			...transportResponse(
				invalidXml,
				207,
				'https://effective-sentinel.example/partition-sentinel/',
			),
			headers: {
				authorization: 'authorization-sentinel',
				'x-token': 'token-sentinel',
			},
		}));
		Object.defineProperty(transport, 'nativeMessage', {
			value: 'native-message-sentinel',
		});
		const error = await captureDiscoveryError(discoverCurrentUserPrincipal(transport));
		const unavailable = await discoverCurrentUserPrincipal(
			mockTransport(async () => transportResponse(multistatus(''))),
		);
		const publicRepresentations = [
			error.name,
			error.message,
			error.stack ?? '',
			String(error),
			JSON.stringify(error),
			JSON.stringify(Object.getOwnPropertyDescriptors(error)),
			JSON.stringify({ ...error }),
			JSON.stringify(unavailable),
			JSON.stringify(Object.getOwnPropertyDescriptors(unavailable)),
		].join('\n');

		for (const sentinel of sentinels) {
			expect(publicRepresentations).not.toContain(sentinel);
		}
		expect(error).not.toHaveProperty('cause');
		expect(Object.keys(error).sort()).toEqual(['code', 'name']);
		expect(Object.keys(unavailable).sort()).toEqual(['code', 'kind', 'message']);
		expect(logSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
	});
});

describe('current-user-principal dependency boundaries', () => {
	it('imports only public transport, URL, XML request, and XML parser modules', async () => {
		const source = await readFile(
			new URL('../../nodes/CalDav/discovery/currentUserPrincipal.ts', import.meta.url),
			'utf8',
		);
		const importSpecifiers = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(
			([, specifier]) => specifier,
		);

		expect(new Set(importSpecifiers)).toEqual(
			new Set(['../transport/http', '../transport/url', '../xml/parser', '../xml/requests']),
		);
		expect(source).not.toMatch(
			/credentials|providers|actions|CalDav\.node|n8n-workflow|node_modules|fetch|axios|DOMParser|XPath/,
		);
		expect(source).not.toMatch(
			/console\.|process\.|readFile|writeFile|setTimeout|Math\.random|Date\./,
		);
	});

	it('adds no runtime dependency or package-root export', async () => {
		const packageJson = JSON.parse(
			await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
		) as { dependencies?: Record<string, string>; exports?: unknown };

		expect(packageJson.dependencies).toBeUndefined();
		expect(packageJson.exports).toBeUndefined();
	});
});
