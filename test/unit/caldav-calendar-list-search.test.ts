import type { ILoadOptionsFunctions, INode, INodeListSearchResult, INodeType } from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencyMocks = vi.hoisted(() => ({
	createTransport: vi.fn(),
	discoverPrincipal: vi.fn(),
	discoverHome: vi.fn(),
	discoverCollections: vi.fn(),
	selectProvider: vi.fn(),
}));

vi.mock('../../nodes/CalDav/transport/http', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/transport/http')>()),
	createN8nCalDavTransport: dependencyMocks.createTransport,
}));

vi.mock('../../nodes/CalDav/discovery/currentUserPrincipal', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/discovery/currentUserPrincipal')>()),
	discoverCurrentUserPrincipal: dependencyMocks.discoverPrincipal,
}));

vi.mock('../../nodes/CalDav/discovery/calendarHome', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/discovery/calendarHome')>()),
	discoverCalendarHome: dependencyMocks.discoverHome,
}));

vi.mock('../../nodes/CalDav/discovery/calendarCollections', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/discovery/calendarCollections')>()),
	discoverCalendarCollections: dependencyMocks.discoverCollections,
}));

vi.mock('../../nodes/CalDav/providers/registry', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/providers/registry')>()),
	defaultCalDavProviderRegistry: Object.freeze({ select: dependencyMocks.selectProvider }),
}));

import { CalDav } from '../../nodes/CalDav/CalDav.node';
import type { CalendarCollection } from '../../nodes/CalDav/discovery/calendarCollections';
import type { CalDavProviderAdapter } from '../../nodes/CalDav/providers/types';
import type { CalDavTransport } from '../../nodes/CalDav/transport/http';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';

const NODE: INode = {
	id: 'calendar-list-search-node',
	name: 'CalDAV Calendar Search',
	type: 'CUSTOM.calDav',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};
const PRINCIPAL_URL = validateAbsoluteHttpUrl(
	'https://calendar.example.test/principals/private-account/',
);
const HOME_URL = validateAbsoluteHttpUrl(
	'https://partition.example.test/calendars/private-account/',
);
const transport: CalDavTransport = {
	serverUrl: 'https://calendar.example.test/root/',
	request: vi.fn(),
};
const provider: CalDavProviderAdapter = Object.freeze({
	id: 'synthetic',
	matchesConfiguredServerUrl: () => true,
	allowsCredentialForwarding: () => true,
});

function collection(
	path: string,
	overrides: Omit<Partial<CalendarCollection>, 'url'> = {},
): CalendarCollection {
	return {
		url: validateAbsoluteHttpUrl(`https://partition.example.test${path}`),
		canRead: true,
		canWrite: true,
		...overrides,
	};
}

function loadOptionsContext(): ILoadOptionsFunctions {
	return {
		getNode: vi.fn().mockReturnValue(NODE),
		getCredentials: vi.fn(),
		helpers: { httpRequestWithAuthentication: vi.fn() },
	} as unknown as ILoadOptionsFunctions;
}

function searchMethod(): NonNullable<NonNullable<INodeType['methods']>['listSearch']>[string] {
	const method = (new CalDav() as INodeType).methods?.listSearch?.searchCalendars;
	expect(method).toBeTypeOf('function');
	if (method === undefined) throw new Error('Missing listSearch.searchCalendars method.');
	return method;
}

async function search(filter?: string, paginationToken?: string): Promise<INodeListSearchResult> {
	return await searchMethod().call(loadOptionsContext(), filter, paginationToken);
}

async function captureSearchError(): Promise<unknown> {
	try {
		await search('private-filter', 'ignored-pagination-token');
	} catch (error) {
		return error;
	}
	throw new Error('Expected Calendar list search to fail.');
}

function codedFailure(code: string, secret = 'private-upstream-sentinel'): Error {
	return Object.assign(new Error(secret), {
		code,
		body: '<calendar-description>Private calendar text</calendar-description>',
		href: '/private-account/private-calendar/',
		response: { reason: 'Private reason phrase', stack: 'private-stack-sentinel' },
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	dependencyMocks.createTransport.mockResolvedValue(transport);
	dependencyMocks.discoverPrincipal.mockResolvedValue({
		kind: 'authenticated',
		principalUrl: PRINCIPAL_URL,
	});
	dependencyMocks.discoverHome.mockResolvedValue({ calendarHomeUrl: HOME_URL });
	dependencyMocks.discoverCollections.mockResolvedValue([]);
	dependencyMocks.selectProvider.mockReturnValue(provider);
});

describe('Calendar searchable resource locator mapping', () => {
	it('maps ordered names, duplicate and empty labels, canonical URL identity, and capability tri-state', async () => {
		const missing = collection('/00-missing/');
		const empty = collection('/01-empty/', { displayName: '' });
		const alphaA = collection('/alpha-a/', {
			displayName: 'Alpha',
			description: 'private-description-sentinel',
			color: '#123456FF',
			extensions: { synthetic: { privateId: 'private-provider-id-sentinel' } },
		});
		const alphaZ = collection('/alpha-z/', { displayName: 'Alpha' });
		const beta = collection('/beta/', {
			displayName: 'Beta',
			canRead: true,
			canWrite: false,
		});
		const lower = collection('/lower/', {
			displayName: 'alpha',
			canRead: null,
			canWrite: null,
		});
		dependencyMocks.discoverCollections.mockResolvedValue([
			lower,
			alphaZ,
			beta,
			empty,
			alphaA,
			missing,
		]);

		const result = await search();

		expect(Object.keys(result)).toEqual(['results']);
		expect(result.results.map(({ value }) => value)).toEqual([
			missing.url,
			empty.url,
			alphaA.url,
			alphaZ.url,
			beta.url,
			lower.url,
		]);
		expect(
			result.results.every(
				(option) => Object.keys(option).sort().join(',') === 'description,name,value',
			),
		).toBe(true);
		expect(result.results[0]).toEqual({
			name: missing.url,
			value: missing.url,
			description: 'Read: yes; Write: yes',
		});
		expect(result.results[1].name).toBe(empty.url);
		for (const [index, calendar] of [
			[2, alphaA],
			[3, alphaZ],
		] as const) {
			expect(result.results[index].name).toContain('Alpha');
			expect(result.results[index].name).toContain(calendar.url);
		}
		expect(result.results[2].name).not.toBe(result.results[3].name);
		expect(result.results[4]).toEqual({
			name: 'Beta',
			value: beta.url,
			description: 'Read: yes; Write: no',
		});
		expect(result.results[5]).toEqual({
			name: 'alpha',
			value: lower.url,
			description: 'Read: unknown; Write: unknown',
		});
		expect(result.results.every((option) => option.disabled !== true)).toBe(true);
		expect(JSON.stringify(result)).not.toMatch(
			/private-description-sentinel|private-provider-id-sentinel|#123456FF/,
		);
	});

	it('filters locally by final label or URL with deterministic folding and preserves order', async () => {
		const alphaA = collection('/alpha-a/', { displayName: 'Alpha' });
		const alphaZ = collection('/alpha-z/', { displayName: 'Alpha' });
		const beta = collection('/private-url-match/', { displayName: 'Beta' });
		dependencyMocks.discoverCollections.mockResolvedValue([beta, alphaZ, alphaA]);

		const all = await search('');
		const byLabel = await search('ALPHA');
		const byUrl = await search('URL-MATCH');
		const absent = await search('not-present');

		expect(all.results.map(({ value }) => value)).toEqual([alphaA.url, alphaZ.url, beta.url]);
		expect(byLabel.results.map(({ value }) => value)).toEqual([alphaA.url, alphaZ.url]);
		expect(byUrl.results.map(({ value }) => value)).toEqual([beta.url]);
		expect(absent).toEqual({ results: [] });
		expect(dependencyMocks.discoverCollections).toHaveBeenCalledTimes(4);
		expect(transport.request).not.toHaveBeenCalled();
	});

	it('returns an exact empty result and ignores pagination without emitting a token', async () => {
		await expect(search(undefined, 'private-pagination-token')).resolves.toEqual({ results: [] });
		expect(dependencyMocks.discoverCollections).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(dependencyMocks.discoverCollections.mock.calls)).not.toContain(
			'private-pagination-token',
		);
	});
});

describe('Calendar list discovery coordination', () => {
	it('uses one transport and principal-home-provider-collections order without list-layer HTTP', async () => {
		await search('alpha');

		expect(dependencyMocks.createTransport).toHaveBeenCalledTimes(1);
		expect(dependencyMocks.discoverPrincipal).toHaveBeenCalledWith(transport);
		expect(dependencyMocks.discoverHome).toHaveBeenCalledWith(transport, PRINCIPAL_URL);
		expect(dependencyMocks.selectProvider).toHaveBeenCalledWith(
			validateAbsoluteHttpUrl(transport.serverUrl),
		);
		expect(dependencyMocks.discoverCollections).toHaveBeenCalledWith(transport, HOME_URL, provider);
		expect(dependencyMocks.discoverPrincipal.mock.invocationCallOrder[0]).toBeLessThan(
			dependencyMocks.discoverHome.mock.invocationCallOrder[0],
		);
		expect(dependencyMocks.discoverHome.mock.invocationCallOrder[0]).toBeLessThan(
			dependencyMocks.selectProvider.mock.invocationCallOrder[0],
		);
		expect(dependencyMocks.selectProvider.mock.invocationCallOrder[0]).toBeLessThan(
			dependencyMocks.discoverCollections.mock.invocationCallOrder[0],
		);
		expect(transport.request).not.toHaveBeenCalled();
	});
});

describe('Calendar list sanitized failures', () => {
	it.each([
		['AUTHENTICATION_FAILED', 'CalDAV authentication failed.'],
		['AUTHORIZATION_FAILED', 'The CalDAV request is not authorized.'],
		['NOT_FOUND', 'The requested CalDAV resource was not found.'],
		['TLS_VALIDATION_FAILED', 'TLS certificate validation failed.'],
		['TIMEOUT', 'The CalDAV request timed out after 30 seconds.'],
		['RESPONSE_LIMIT_EXCEEDED', 'The CalDAV response exceeded the 10 MiB size limit.'],
		['INVALID_REDIRECT', 'The CalDAV server returned an invalid redirect.'],
		['NETWORK_ERROR', 'The CalDAV server could not be reached.'],
		['MALFORMED_URL', 'The URL is malformed.'],
		['CURRENT_USER_PRINCIPAL_UNAVAILABLE', 'The CalDAV current-user principal is unavailable.'],
		[
			'INVALID_CALENDAR_HOME_RESPONSE',
			'The CalDAV server returned an invalid calendar-home response.',
		],
		[
			'INVALID_CALENDAR_COLLECTION_RESPONSE',
			'The CalDAV server returned an invalid calendar-collection response.',
		],
		['MALFORMED_XML', 'The XML document is malformed.'],
	] as const)('keeps only the safe %s category', async (code, expectedMessage) => {
		dependencyMocks.discoverCollections.mockRejectedValue(codedFailure(code));

		const error = await captureSearchError();

		expect(error).toBeInstanceOf(NodeApiError);
		expect(error).toMatchObject({ message: expectedMessage });
		expect(JSON.stringify(error)).not.toMatch(
			/private-upstream-sentinel|Private calendar text|private-account|Private reason|private-stack|private-filter|pagination-token/i,
		);
	});

	it('maps an unauthenticated principal outcome without continuing discovery', async () => {
		dependencyMocks.discoverPrincipal.mockResolvedValue({
			kind: 'unauthenticated',
			code: 'CURRENT_USER_PRINCIPAL_UNAUTHENTICATED',
			message: 'private-outcome-message',
		});

		const error = await captureSearchError();

		expect(error).toBeInstanceOf(NodeApiError);
		expect(error).toMatchObject({
			message: 'The CalDAV server did not authenticate the current user.',
		});
		expect(JSON.stringify(error)).not.toContain('private-outcome-message');
		expect(dependencyMocks.discoverHome).not.toHaveBeenCalled();
		expect(dependencyMocks.discoverCollections).not.toHaveBeenCalled();
	});

	it('uses the exact generic message for unknown failures without exposing arbitrary data', async () => {
		dependencyMocks.discoverHome.mockRejectedValue(codedFailure('PRIVATE_UNKNOWN_CODE'));

		const error = await captureSearchError();

		expect(error).toBeInstanceOf(NodeApiError);
		expect(error).toMatchObject({ message: 'The calendar list could not be loaded.' });
		expect(JSON.stringify(error)).not.toMatch(
			/private-upstream-sentinel|Private calendar text|private-account|Private reason|private-stack|private-filter|pagination-token/i,
		);
	});

	it('rejects a response-limit failure without returning attached partial options', async () => {
		dependencyMocks.discoverCollections.mockRejectedValue(
			Object.assign(codedFailure('RESPONSE_LIMIT_EXCEEDED'), {
				partialResults: [
					{ name: 'Private partial option', value: 'https://private.example.test/' },
				],
			}),
		);

		const error = await captureSearchError();

		expect(error).toBeInstanceOf(NodeApiError);
		expect(error).toMatchObject({
			message: 'The CalDAV response exceeded the 10 MiB size limit.',
		});
		expect(JSON.stringify(error)).not.toMatch(/Private partial option|private\.example\.test/);
	});
});
