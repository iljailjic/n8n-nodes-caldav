// Discovery source reads are required only for deterministic dependency-boundary tests.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import * as calendarHomeDiscovery from '../../nodes/CalDav/discovery/calendarHome';
import {
	CalDavCalendarHomeDiscoveryError,
	CalendarHomeDiscoveryFailureCode,
	discoverCalendarHome,
} from '../../nodes/CalDav/discovery/calendarHome';
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
import {
	CalDavUrlValidationError,
	validateAbsoluteHttpUrl,
} from '../../nodes/CalDav/transport/url';
import { CalDavXmlParseError } from '../../nodes/CalDav/xml/parser';

const CALENDAR_HOME_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <c:calendar-home-set/>
  </d:prop>
</d:propfind>`;

type MockTransport = CalDavTransport & { request: ReturnType<typeof vi.fn> };

function transportResponse(
	xml: string,
	statusCode = 207,
	effectiveUrl = 'https://effective.example.test/discovery/root/',
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

function multistatus(responses: string, extraNamespaces = ''): string {
	return `<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"${extraNamespaces}>${responses}</multistatus>`;
}

function homeProperty(value: string, attributes = ''): string {
	return `<c:calendar-home-set${attributes}>${value}</c:calendar-home-set>`;
}

function homeDocument(value: string, status = 'HTTP/1.1 200 OK'): string {
	return multistatus(responseWithPropstats(propstat(homeProperty(value), status)));
}

function principalUrl(value = 'https://principal.example.test/users/account-sentinel/') {
	return validateAbsoluteHttpUrl(value);
}

async function captureDiscoveryError(
	promise: Promise<unknown>,
): Promise<CalDavCalendarHomeDiscoveryError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(CalDavCalendarHomeDiscoveryError);
		return error as CalDavCalendarHomeDiscoveryError;
	}

	throw new Error('Expected calendar-home discovery to fail');
}

async function expectSemanticError(
	xml: string,
	code: CalDavCalendarHomeDiscoveryError['code'],
): Promise<CalDavCalendarHomeDiscoveryError> {
	const transport = mockTransport(async () => transportResponse(xml));
	const error = await captureDiscoveryError(discoverCalendarHome(transport, principalUrl()));

	expect(error.code).toBe(code);
	expect(transport.request).toHaveBeenCalledTimes(1);
	return error;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('calendar-home public contract and request', () => {
	it('exports exactly the accepted runtime surface and failure codes', () => {
		expect(Object.keys(calendarHomeDiscovery).sort()).toEqual(
			[
				'CalDavCalendarHomeDiscoveryError',
				'CalendarHomeDiscoveryFailureCode',
				'discoverCalendarHome',
			].sort(),
		);
		expect(CalendarHomeDiscoveryFailureCode).toEqual({
			MISSING: 'CALENDAR_HOME_MISSING',
			FORBIDDEN: 'CALENDAR_HOME_FORBIDDEN',
			INVALID_RESPONSE: 'INVALID_CALENDAR_HOME_RESPONSE',
			AMBIGUOUS_RESPONSE: 'AMBIGUOUS_CALENDAR_HOME_RESPONSE',
		});
	});

	it.each([
		['CALENDAR_HOME_MISSING', 'The CalDAV calendar-home property is unavailable.'],
		['CALENDAR_HOME_FORBIDDEN', 'The CalDAV calendar-home property is forbidden.'],
		[
			'INVALID_CALENDAR_HOME_RESPONSE',
			'The CalDAV server returned an invalid calendar-home response.',
		],
		[
			'AMBIGUOUS_CALENDAR_HOME_RESPONSE',
			'The CalDAV server returned an ambiguous calendar-home response.',
		],
	] as const)('provides exact sanitized metadata for %s', (code, message) => {
		const error = new CalDavCalendarHomeDiscoveryError(code);

		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({
			name: 'CalDavCalendarHomeDiscoveryError',
			code,
			message,
		});
		expect(error).not.toHaveProperty('cause');
		expect(error).not.toHaveProperty('statusCode');
		expect(Object.keys(error).sort()).toEqual(['code', 'name']);
	});

	it('makes one request with exactly the accepted depth-0 PROPFIND descriptor', async () => {
		const requestedPrincipal = principalUrl();
		const transport = mockTransport(async () =>
			transportResponse(homeDocument('<href>/homes/account-sentinel</href>')),
		);

		await expect(discoverCalendarHome(transport, requestedPrincipal)).resolves.toEqual({
			calendarHomeUrl: 'https://effective.example.test/homes/account-sentinel/',
		});
		expect(transport.request).toHaveBeenCalledTimes(1);
		expect(transport.request).toHaveBeenCalledWith({
			method: CalDavMethod.PROPFIND,
			url: requestedPrincipal,
			headers: {
				Depth: '0',
				'Content-Type': 'application/xml; charset=utf-8',
			},
			body: CALENDAR_HOME_BODY,
		});
		expect(Object.keys(transport.request.mock.calls[0][0]).sort()).toEqual([
			'body',
			'headers',
			'method',
			'url',
		]);
	});
});

describe('calendar-home selection and effective URL resolution', () => {
	it.each([
		['child', 'https://partition.example.test/discovery/root/child/'],
		['/homes/account', 'https://partition.example.test/homes/account/'],
		['//home.example.test/users/account', 'https://home.example.test/users/account/'],
		['https://absolute.example.test/users/account', 'https://absolute.example.test/users/account/'],
	] as const)('resolves %s once against the final effective URL', async (href, calendarHomeUrl) => {
		const transport = mockTransport(async () =>
			transportResponse(
				homeDocument(`<href>${href}</href>`),
				207,
				'https://partition.example.test/discovery/root/',
			),
		);

		await expect(discoverCalendarHome(transport, principalUrl())).resolves.toEqual({
			calendarHomeUrl,
		});
		expect(transport.request).toHaveBeenCalledTimes(1);
	});

	it('keeps a relative synthetic iCloud home on the final partition host without guessing paths', async () => {
		const xml =
			'<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">' +
			'<d:response><d:href>/ignored-response/</d:href><d:propstat><d:prop>' +
			'<cal:calendar-home-set>\n<d:href>account-sentinel/home%2Fopaque</d:href>\t</cal:calendar-home-set>' +
			'</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';
		const transport = mockTransport(async () =>
			transportResponse(xml, 207, 'https://p42-caldav.icloud.com/discovery/'),
		);

		await expect(discoverCalendarHome(transport, principalUrl())).resolves.toEqual({
			calendarHomeUrl: 'https://p42-caldav.icloud.com/discovery/account-sentinel/home%2Fopaque/',
		});
	});

	it('accepts default CalDAV namespace and concatenates semantic href text unchanged', async () => {
		const xml =
			'<d:multistatus xmlns:d="DAV:"><d:response><d:href>/ignored/</d:href><d:propstat>' +
			'<d:prop><calendar-home-set xmlns="urn:ietf:params:xml:ns:caldav">' +
			'<d:href>home<![CDATA[%2Fpart]]>?view=%2f</d:href></calendar-home-set></d:prop>' +
			'<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';

		await expect(
			discoverCalendarHome(
				mockTransport(async () => transportResponse(xml)),
				principalUrl(),
			),
		).resolves.toEqual({
			calendarHomeUrl: 'https://effective.example.test/discovery/root/home%2Fpart/?view=%2f',
		});
	});

	it('uses the one successful property despite failed 403 and 404 copies', async () => {
		const xml = multistatus(
			responseWithPropstats(
				propstat(homeProperty('<href>/forbidden-private</href>'), 'HTTP/1.1 403 Forbidden') +
					propstat(homeProperty('<href>/missing-private</href>'), 'HTTP/1.1 404 Not Found') +
					propstat(homeProperty('<href>/successful</href>')),
			),
		);

		await expect(
			discoverCalendarHome(
				mockTransport(async () => transportResponse(xml)),
				principalUrl(),
			),
		).resolves.toEqual({ calendarHomeUrl: 'https://effective.example.test/successful/' });
	});

	it.each([
		['empty multistatus', multistatus('')],
		[
			'missing property',
			multistatus(responseWithPropstats(propstat('<displayname>Calendar</displayname>'))),
		],
		[
			'wrong namespace',
			multistatus(
				responseWithPropstats(
					propstat(
						'<x:calendar-home-set xmlns:x="urn:not-caldav"><href>/ignored</href></x:calendar-home-set>',
						'HTTP/1.1 403 Forbidden',
					),
				),
			),
		],
		['failed 401', homeDocument('<href>/private</href>', 'HTTP/1.1 401 Unauthorized')],
		['failed 404', homeDocument('<href>/private</href>', 'HTTP/1.1 404 Not Found')],
		['failed 500', homeDocument('<href>/private</href>', 'HTTP/1.1 500 Server Error')],
		['successful property with no href', homeDocument(' \t\n')],
	] as const)('reports missing for %s', async (_label, xml) => {
		await expectSemanticError(xml, 'CALENDAR_HOME_MISSING');
	});

	it('reports forbidden only for a failed correct-namespace property with exact status 403', async () => {
		await expectSemanticError(
			homeDocument('<href>/private</href>', 'HTTP/1.1 403 Forbidden'),
			'CALENDAR_HOME_FORBIDDEN',
		);
	});

	it('rejects duplicate successful properties across or within propstats', async () => {
		const within = multistatus(
			responseWithPropstats(
				propstat(homeProperty('<href>/same</href>') + homeProperty('<href>/same</href>')),
			),
		);
		const across = multistatus(
			responseWithPropstats(
				propstat(homeProperty('<href>/one</href>')) + propstat(homeProperty('<href>/two</href>')),
			),
		);

		await expectSemanticError(within, 'AMBIGUOUS_CALENDAR_HOME_RESPONSE');
		await expectSemanticError(across, 'AMBIGUOUS_CALENDAR_HOME_RESPONSE');
	});

	it('rejects multiple direct responses before considering their response hrefs', async () => {
		const xml = multistatus(
			responseWithPropstats(propstat(homeProperty('<href>/first</href>')), '/first/') +
				responseWithPropstats(propstat(homeProperty('<href>/second</href>')), '/second/'),
		);

		await expectSemanticError(xml, 'AMBIGUOUS_CALENDAR_HOME_RESPONSE');
	});

	it('rejects response-level status form', async () => {
		const xml = multistatus(
			'<response><href>/response-private/</href><status>HTTP/1.1 200 OK</status></response>',
		);

		await expectSemanticError(xml, 'INVALID_CALENDAR_HOME_RESPONSE');
	});
});

describe('calendar-home typed property content', () => {
	it('rejects multiple hrefs as ambiguous even when identical', async () => {
		await expectSemanticError(
			homeDocument('<href>/same</href><href>/same</href>'),
			'AMBIGUOUS_CALENDAR_HOME_RESPONSE',
		);
	});

	it.each([
		['attributed property', homeProperty('<href>/home</href>', ' private="yes"')],
		['non-whitespace text', homeProperty('private<href>/home</href>')],
		['unknown child', homeProperty('<owner/><href>/home</href>')],
		['wrong-namespace href', homeProperty('<x:href xmlns:x="urn:not-dav">/home</x:href>')],
		['empty href', homeProperty('<href/>')],
		['attributed href', homeProperty('<href private="yes">/home</href>')],
		['nested href', homeProperty('<href><segment>private</segment></href>')],
		[
			'unknown child plus duplicate hrefs',
			homeProperty('<href>/one</href><owner/><href>/two</href>'),
		],
	] as const)('rejects %s as invalid before URL resolution', async (_label, property) => {
		await expectSemanticError(
			multistatus(responseWithPropstats(propstat(property))),
			'INVALID_CALENDAR_HOME_RESPONSE',
		);
	});
});

describe('calendar-home transport, XML, URL, and leakage behavior', () => {
	it.each([new CalDavAuthenticationError(401), new CalDavAuthorizationError(403)])(
		'propagates the same transport authorization error instance',
		async (transportError) => {
			const transport = mockTransport(async () => {
				throw transportError;
			});

			await expect(discoverCalendarHome(transport, principalUrl())).rejects.toBe(transportError);
			expect(transport.request).toHaveBeenCalledTimes(1);
		},
	);

	it.each([200, 201, 204])(
		'rejects successful HTTP %s without parsing its body',
		async (status) => {
			const transport = mockTransport(async () =>
				transportResponse('xml-body-sentinel-that-is-not-xml', status),
			);
			const error = await captureDiscoveryError(discoverCalendarHome(transport, principalUrl()));

			expect(error.code).toBe('INVALID_CALENDAR_HOME_RESPONSE');
			expect(transport.request).toHaveBeenCalledTimes(1);
		},
	);

	it.each([
		[
			'malformed',
			'<multistatus xmlns="DAV:"><response>xml-private',
			'TRUNCATED_XML',
			'The XML document ended unexpectedly.',
		],
		[
			'hostile',
			'<!DOCTYPE multistatus [<!ENTITY secret "xml-private">]><multistatus xmlns="DAV:"/>',
			'FORBIDDEN_DECLARATION',
			'The XML document contains a forbidden declaration.',
		],
	] as const)(
		'propagates the existing safe XML parser error unchanged for %s XML',
		async (_label, xml, code, message) => {
			const transport = mockTransport(async () => transportResponse(xml));
			let caughtError: unknown;
			try {
				await discoverCalendarHome(transport, principalUrl());
			} catch (error) {
				caughtError = error;
			}

			expect(caughtError).toBeInstanceOf(CalDavXmlParseError);
			expect(caughtError).toMatchObject({
				name: 'CalDavXmlParseError',
				code,
				message,
			});
		},
	);

	it.each([
		['whitespace', ' private'],
		['malformed percent', 'private%GG'],
		['userinfo', 'https://user:password@example.test/private'],
		['fragment', 'private#fragment'],
		['dot segment', '../private'],
		['unsupported scheme', 'ftp://example.test/private'],
		['downgrade', 'http://example.test/private'],
	] as const)('propagates the safe URL error for a %s href', async (_label, href) => {
		const transport = mockTransport(async () =>
			transportResponse(homeDocument(`<href>${href}</href>`), 207, 'https://effective.example/'),
		);

		await expect(discoverCalendarHome(transport, principalUrl())).rejects.toBeInstanceOf(
			CalDavUrlValidationError,
		);
		expect(transport.request).toHaveBeenCalledTimes(1);
	});

	it('does not log or leak private discovery inputs through any public error representation', async () => {
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
			'home-path-sentinel',
			'username-sentinel',
			'password-sentinel',
			'token-sentinel',
			'authorization-sentinel',
			'xml-body-sentinel',
			'native-message-sentinel',
		];
		const invalidXml = multistatus(
			responseWithPropstats(
				propstat(homeProperty('<href>home-path-sentinel</href><owner>xml-body-sentinel</owner>')),
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
		Object.defineProperty(transport, 'nativeMessage', { value: 'native-message-sentinel' });
		const error = await captureDiscoveryError(
			discoverCalendarHome(
				transport,
				principalUrl('https://principal.example/principal-path-sentinel/'),
			),
		);
		const publicRepresentations = [
			error.name,
			error.message,
			error.stack ?? '',
			String(error),
			JSON.stringify(error),
			JSON.stringify(Object.getOwnPropertyDescriptors(error)),
			JSON.stringify(Reflect.ownKeys(error)),
			JSON.stringify({ ...error }),
		].join('\n');

		for (const sentinel of sentinels) {
			expect(publicRepresentations).not.toContain(sentinel);
		}
		expect(error).not.toHaveProperty('cause');
		expect(error).not.toHaveProperty('statusCode');
		expect(Object.keys(error).sort()).toEqual(['code', 'name']);
		expect(logSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
	});
});

describe('calendar-home dependency boundaries', () => {
	it('imports only the accepted transport, URL, XML parser, and XML request modules', async () => {
		const source = await readFile(
			new URL('../../nodes/CalDav/discovery/calendarHome.ts', import.meta.url),
			'utf8',
		);
		const importSpecifiers = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(
			([, specifier]) => specifier,
		);

		expect(new Set(importSpecifiers)).toEqual(
			new Set(['../transport/http', '../transport/url', '../xml/parser', '../xml/requests']),
		);
		expect(source).not.toMatch(
			/credentials|providers|actions|currentUserPrincipal|CalDav\.node|n8n-workflow|node_modules|fetch|axios|DOMParser|XPath/,
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
