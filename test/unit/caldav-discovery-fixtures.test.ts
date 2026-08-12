// Node file reads are required for deterministic provenance and source-boundary checks.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CalendarCollection } from '../../nodes/CalDav/discovery/calendarCollections';
import { discoverCalendarCollections } from '../../nodes/CalDav/discovery/calendarCollections';
import { discoverCalendarHome } from '../../nodes/CalDav/discovery/calendarHome';
import { validateCalDavCapability } from '../../nodes/CalDav/discovery/capabilities';
import { discoverCurrentUserPrincipal } from '../../nodes/CalDav/discovery/currentUserPrincipal';
import { defaultCalDavProviderRegistry } from '../../nodes/CalDav/providers/registry';
import { createCalDavTransport } from '../../nodes/CalDav/transport/http';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';
import {
	SYNTHETIC_DISCOVERY_CASE_IDS,
	iCloudPartitionFixture,
	iCloudStyleEquivalentFixture,
	standardEquivalentFixture,
	unsafeHrefCases,
} from './fixtures/discovery/synthetic-discovery-fixtures';
import type {
	SyntheticDiscoveryFixture,
	SyntheticDiscoveryStep,
} from './fixtures/discovery/synthetic-discovery-fixtures';
import { createSyntheticDiscoveryTranscript } from './support/synthetic-discovery-fixture';

const EXPECTED_EQUIVALENT_COLLECTIONS = Object.freeze([
	Object.freeze({
		url: 'https://calendar.example.test/fictional/homes/user/calendars/team/',
		displayName: 'Team',
		description: 'Synthetic calendar',
		supportedComponents: Object.freeze(['VEVENT', 'VTODO']),
		canRead: true,
		canWrite: false,
	}),
	Object.freeze({
		url: 'https://collections.example.test/public/',
		canRead: null,
		canWrite: null,
	}),
]);

interface PipelineResult {
	readonly collections: readonly CalendarCollection[];
	readonly calls: readonly {
		readonly method: string;
		readonly url: string;
		readonly depth?: string;
	}[];
}

async function runPipeline(fixture: SyntheticDiscoveryFixture): Promise<PipelineResult> {
	const transcript = createSyntheticDiscoveryTranscript(fixture);
	const transport = createCalDavTransport(fixture.configuredUrl, transcript.adapter);
	const provider = defaultCalDavProviderRegistry.select(
		validateAbsoluteHttpUrl(fixture.configuredUrl),
	);

	await validateCalDavCapability(transport);
	const principal = await discoverCurrentUserPrincipal(transport);
	if (principal.kind !== 'authenticated') {
		throw new Error('The synthetic pipeline did not discover an authenticated principal.');
	}
	const home = await discoverCalendarHome(transport, principal.principalUrl);
	const collections = await discoverCalendarCollections(transport, home.calendarHomeUrl, provider);
	transcript.assertComplete();

	return {
		collections,
		calls: transcript.calls.map((call) => ({
			method: call.method,
			url: call.url,
			...(call.headers?.Depth === undefined ? {} : { depth: call.headers.Depth }),
		})),
	};
}

function responseStep(
	id: string,
	url: string,
	body: string,
	depth: '0' | '1',
): SyntheticDiscoveryStep {
	return {
		id,
		method: 'PROPFIND',
		url,
		depth,
		response: { statusCode: 207, body },
	};
}

function fixtureWithHref(
	phase: 'principal' | 'home' | 'collection',
	id: string,
	href: string,
): SyntheticDiscoveryFixture {
	const configuredUrl = 'https://calendar.example.test/discovery/';
	const capability: SyntheticDiscoveryStep = {
		id: 'capability',
		method: 'OPTIONS',
		url: configuredUrl,
		response: { statusCode: 200, headers: { DAV: 'calendar-access' } },
	};
	const principalBody = `<multistatus xmlns="DAV:"><response><href>/fictional/</href><propstat><prop><current-user-principal><href>${phase === 'principal' ? href : '/principal/'}</href></current-user-principal></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;
	const homeBody = `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/principal/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>${phase === 'home' ? href : '/home/'}</d:href></c:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
	const collectionBody = `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;

	return {
		id: `${phase}-href-${id}`,
		configuredUrl,
		steps: [
			capability,
			responseStep('principal', configuredUrl, principalBody, '0'),
			...(phase === 'principal'
				? []
				: [responseStep('home', 'https://calendar.example.test/principal/', homeBody, '0')]),
			...(phase === 'collection'
				? [responseStep('collections', 'https://calendar.example.test/home/', collectionBody, '1')]
				: []),
		],
	};
}

async function captureFailure(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(Error);
		return error as Error;
	}
	throw new Error('Expected the synthetic discovery pipeline to fail.');
}

function publicErrorRepresentations(error: Error, consoleCalls: readonly unknown[][]): string {
	return [
		String(error),
		error.name,
		error.message,
		JSON.stringify(error),
		JSON.stringify(consoleCalls),
	].join('\n');
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('synthetic standard and iCloud-style discovery fixtures', () => {
	it('produces deeply equal provider-neutral results in the four logical phases', async () => {
		const standard = await runPipeline(standardEquivalentFixture);
		const iCloudStyle = await runPipeline(iCloudStyleEquivalentFixture);

		expect(standard.collections).toEqual(EXPECTED_EQUIVALENT_COLLECTIONS);
		expect(iCloudStyle.collections).toEqual(standard.collections);
		expect(standard.calls.map(({ method, depth }) => [method, depth])).toEqual([
			['OPTIONS', undefined],
			['PROPFIND', '0'],
			['PROPFIND', '0'],
			['PROPFIND', '1'],
		]);
		expect(iCloudStyle.calls).toEqual(standard.calls);
		expect(Object.isFrozen(standard.collections)).toBe(true);
	});

	it('uses the trusted partition effective URL at every following href boundary', async () => {
		const result = await runPipeline(iCloudPartitionFixture);

		expect(result.calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
			'OPTIONS https://caldav.icloud.com/fictional-entry/',
			'PROPFIND https://caldav.icloud.com/fictional-entry/',
			'PROPFIND https://p42-caldav.icloud.com/fictional-zone/discovery/',
			'PROPFIND https://p42-caldav.icloud.com/fictional-zone/discovery/principal/fictional-user/',
			'PROPFIND https://p42-caldav.icloud.com/fictional-zone/homes/fictional-user/',
		]);
		expect(result.collections).toEqual([
			{
				url: 'https://p42-caldav.icloud.com/fictional-zone/homes/fictional-user/events/',
				canRead: true,
				canWrite: false,
			},
		]);
	});
});

describe('synthetic discovery negative fixtures', () => {
	it('preserves the unavailable outcome for a failed principal property', async () => {
		const fixture: SyntheticDiscoveryFixture = {
			id: 'failed-principal-required-property',
			configuredUrl: 'https://calendar.example.test/discovery/',
			steps: [
				{
					id: 'capability',
					method: 'OPTIONS',
					url: 'https://calendar.example.test/discovery/',
					response: { statusCode: 200, headers: { DAV: 'calendar-access' } },
				},
				responseStep(
					'principal',
					'https://calendar.example.test/discovery/',
					'<multistatus xmlns="DAV:"><response><href>/fictional/</href><propstat><prop><current-user-principal><href>/failed-path-sentinel/</href></current-user-principal></prop><status>HTTP/1.1 403 Forbidden</status></propstat></response></multistatus>',
					'0',
				),
			],
		};
		const transcript = createSyntheticDiscoveryTranscript(fixture);
		const transport = createCalDavTransport(fixture.configuredUrl, transcript.adapter);

		await validateCalDavCapability(transport);
		const outcome = await discoverCurrentUserPrincipal(transport);

		expect(outcome).toEqual({
			kind: 'unavailable',
			code: 'CURRENT_USER_PRINCIPAL_UNAVAILABLE',
			message: 'The CalDAV current-user principal is unavailable.',
		});
		expect(JSON.stringify(outcome)).not.toContain('failed-path-sentinel');
		transcript.assertComplete();
	});

	it('preserves the explicit sanitized forbidden-home error', async () => {
		const fixture: SyntheticDiscoveryFixture = {
			id: 'forbidden-home-required-property',
			configuredUrl: 'https://calendar.example.test/discovery/',
			steps: [
				{
					id: 'capability',
					method: 'OPTIONS',
					url: 'https://calendar.example.test/discovery/',
					response: { statusCode: 200, headers: { DAV: 'calendar-access' } },
				},
				responseStep(
					'principal',
					'https://calendar.example.test/discovery/',
					'<multistatus xmlns="DAV:"><response><href>/fictional/</href><propstat><prop><current-user-principal><href>/principal/</href></current-user-principal></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>',
					'0',
				),
				responseStep(
					'home',
					'https://calendar.example.test/principal/',
					'<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/principal/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/forbidden-path-sentinel/</d:href></c:calendar-home-set></d:prop><d:status>HTTP/1.1 403 Forbidden</d:status></d:propstat></d:response></d:multistatus>',
					'0',
				),
			],
		};
		const transcript = createSyntheticDiscoveryTranscript(fixture);
		const transport = createCalDavTransport(fixture.configuredUrl, transcript.adapter);

		await validateCalDavCapability(transport);
		const principal = await discoverCurrentUserPrincipal(transport);
		if (principal.kind !== 'authenticated') {
			throw new Error('Expected the hand-authored principal fixture to authenticate.');
		}
		const error = await captureFailure(discoverCalendarHome(transport, principal.principalUrl));

		expect(error).toMatchObject({
			name: 'CalDavCalendarHomeDiscoveryError',
			code: 'CALENDAR_HOME_FORBIDDEN',
			message: 'The CalDAV calendar-home property is forbidden.',
		});
		expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain('forbidden-path-sentinel');
		transcript.assertComplete();
	});

	it.each(unsafeHrefCases)(
		'rejects principal href case $id before a later logical phase',
		async ({ id, href, urlCode }) => {
			const error = await captureFailure(runPipeline(fixtureWithHref('principal', id, href)));

			expect(error.name).toBe(
				urlCode === undefined
					? 'CalDavCurrentUserPrincipalDiscoveryError'
					: 'CalDavUrlValidationError',
			);
			expect(error).toMatchObject({
				code: urlCode ?? 'INVALID_CURRENT_USER_PRINCIPAL_RESPONSE',
			});
		},
	);

	it.each(unsafeHrefCases)(
		'rejects home href case $id before collection discovery',
		async ({ id, href, urlCode }) => {
			const error = await captureFailure(runPipeline(fixtureWithHref('home', id, href)));

			expect(error.name).toBe(
				urlCode === undefined ? 'CalDavCalendarHomeDiscoveryError' : 'CalDavUrlValidationError',
			);
			expect(error).toMatchObject({ code: urlCode ?? 'INVALID_CALENDAR_HOME_RESPONSE' });
		},
	);

	it.each(unsafeHrefCases)(
		'rejects collection href case $id without exposing its source value',
		async ({ id, href, urlCode }) => {
			const consoleSpies = ['debug', 'info', 'log', 'warn', 'error'].map((method) =>
				vi.spyOn(console, method as 'log').mockImplementation(() => {}),
			);
			const error = await captureFailure(runPipeline(fixtureWithHref('collection', id, href)));
			const representations = publicErrorRepresentations(
				error,
				consoleSpies.flatMap((spy) => spy.mock.calls),
			);

			expect(error).toMatchObject({
				code: urlCode ?? 'INVALID_CALENDAR_COLLECTION_RESPONSE',
			});
			expect(representations).not.toContain('href-sentinel');
			expect(representations).not.toContain('credential-sentinel');
			expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
		},
	);

	it('stops after a missing capability with the existing sanitized error', async () => {
		const fixture: SyntheticDiscoveryFixture = {
			id: 'missing-capability',
			configuredUrl: 'https://calendar.example.test/capability-path-sentinel/',
			steps: [
				{
					id: 'capability',
					method: 'OPTIONS',
					url: 'https://calendar.example.test/capability-path-sentinel/',
					response: { statusCode: 200, headers: { DAV: '1' }, body: 'body-sentinel' },
				},
			],
		};

		const error = await captureFailure(runPipeline(fixture));
		expect(error).toMatchObject({
			name: 'CalDavCapabilityValidationError',
			code: 'CALDAV_CAPABILITY_MISSING',
		});
		expect(`${String(error)} ${JSON.stringify(error)}`).not.toMatch(
			/capability-path-sentinel|body-sentinel/,
		);
	});
});

describe('synthetic fixture provenance and separation', () => {
	it('inventories every fixture case and records the synthetic privacy rule', async () => {
		const provenance = await readFile(
			new URL('./fixtures/discovery/PROVENANCE.md', import.meta.url),
			'utf8',
		);

		for (const id of SYNTHETIC_DISCOVERY_CASE_IDS) {
			expect(provenance, `missing provenance for ${id}`).toContain(`\`${id}\``);
		}
		expect(provenance).toContain('hand-authored');
		expect(provenance).toContain('None was copied, sanitized, redacted, transformed');
		expect(provenance).toContain('Real account responses and values must never be committed');
		expect(provenance).toContain('privacy reviewed: pass');
	});

	it('keeps fixture and fixture-helper imports outside production source boundaries', async () => {
		const productionFiles = [
			'credentials/CalDavApi.credentials.ts',
			'nodes/CalDav/CalDav.node.ts',
			'nodes/CalDav/discovery/calendarCollections.ts',
			'nodes/CalDav/discovery/calendarHome.ts',
			'nodes/CalDav/discovery/capabilities.ts',
			'nodes/CalDav/discovery/currentUserPrincipal.ts',
			'nodes/CalDav/transport/http.ts',
		];
		const sources = await Promise.all(
			productionFiles.map((path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')),
		);

		expect(sources.join('\n')).not.toMatch(
			/synthetic-discovery-fixture|fixtures\/discovery|PROVENANCE\.md/,
		);
	});
});
