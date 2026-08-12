// Node file reads are required for deterministic provenance and source-boundary checks.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { readFile, readdir } from 'node:fs/promises';

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

const SUCCESSFUL_PIPELINE_CASES = [
	{
		id: 'standard equivalent',
		fixture: standardEquivalentFixture,
		expectedCalls: [
			{
				method: 'OPTIONS',
				url: 'https://calendar.example.test/fictional/root/',
			},
			{
				method: 'PROPFIND',
				url: 'https://calendar.example.test/fictional/root/',
				depth: '0',
			},
			{
				method: 'PROPFIND',
				url: 'https://calendar.example.test/fictional/principals/user/',
				depth: '0',
			},
			{
				method: 'PROPFIND',
				url: 'https://calendar.example.test/fictional/homes/user/',
				depth: '1',
			},
		],
		expectedCollections: EXPECTED_EQUIVALENT_COLLECTIONS,
	},
	{
		id: 'iCloud-style equivalent',
		fixture: iCloudStyleEquivalentFixture,
		expectedCalls: [
			{
				method: 'OPTIONS',
				url: 'https://calendar.example.test/fictional/root/',
			},
			{
				method: 'PROPFIND',
				url: 'https://calendar.example.test/fictional/root/',
				depth: '0',
			},
			{
				method: 'PROPFIND',
				url: 'https://calendar.example.test/fictional/principals/user/',
				depth: '0',
			},
			{
				method: 'PROPFIND',
				url: 'https://calendar.example.test/fictional/homes/user/',
				depth: '1',
			},
		],
		expectedCollections: EXPECTED_EQUIVALENT_COLLECTIONS,
	},
	{
		id: 'iCloud trusted partition redirect',
		fixture: iCloudPartitionFixture,
		expectedCalls: [
			{
				method: 'OPTIONS',
				url: 'https://caldav.icloud.com/fictional-entry/',
			},
			{
				method: 'PROPFIND',
				url: 'https://caldav.icloud.com/fictional-entry/',
				depth: '0',
			},
			{
				method: 'PROPFIND',
				url: 'https://p42-caldav.icloud.com/fictional-zone/discovery/',
				depth: '0',
			},
			{
				method: 'PROPFIND',
				url: 'https://p42-caldav.icloud.com/fictional-zone/discovery/principal/fictional-user/',
				depth: '0',
			},
			{
				method: 'PROPFIND',
				url: 'https://p42-caldav.icloud.com/fictional-zone/homes/fictional-user/',
				depth: '1',
			},
		],
		expectedCollections: [
			{
				url: 'https://p42-caldav.icloud.com/fictional-zone/homes/fictional-user/events/',
				canRead: true,
				canWrite: false,
			},
		],
	},
] as const;

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

function fixtureWithBodies(
	id: string,
	overrides: {
		readonly principal?: string;
		readonly home?: string;
		readonly homeHref?: string;
		readonly collection?: string;
		readonly collectionHeaders?: Readonly<Record<string, string>>;
	},
	configuredUrl = 'https://calendar.example.test/discovery/',
): SyntheticDiscoveryFixture {
	const principalBody =
		overrides.principal ??
		'<multistatus xmlns="DAV:"><response><href>/fictional/</href><propstat><prop><current-user-principal><href>/principal/</href></current-user-principal></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>';
	const homeHref = overrides.homeHref ?? '/home/';
	const homeBody =
		overrides.home ??
		`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/principal/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>${homeHref}</d:href></c:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
	const principalUrl = new URL('/principal/', configuredUrl).href;
	const homeUrl = new URL(homeHref, configuredUrl).href;

	return {
		id,
		configuredUrl,
		steps: [
			{
				id: 'capability',
				method: 'OPTIONS',
				url: configuredUrl,
				response: { statusCode: 200, headers: { DAV: 'calendar-access' } },
			},
			responseStep('principal', configuredUrl, principalBody, '0'),
			...(overrides.principal === undefined ||
			overrides.home !== undefined ||
			overrides.collection !== undefined
				? [responseStep('home', principalUrl, homeBody, '0')]
				: []),
			...(overrides.collection === undefined
				? []
				: [
						{
							...responseStep('collections', homeUrl, overrides.collection, '1'),
							response: {
								statusCode: 207,
								body: overrides.collection,
								...(overrides.collectionHeaders === undefined
									? {}
									: { headers: overrides.collectionHeaders }),
							},
						},
					]),
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
		error.stack ?? '',
		JSON.stringify(error),
		JSON.stringify(Object.getOwnPropertyDescriptors(error)),
		JSON.stringify(Reflect.ownKeys(error)),
		JSON.stringify({ ...error }),
		JSON.stringify(consoleCalls),
	].join('\n');
}

function spyOnConsole() {
	return [
		vi.spyOn(console, 'debug').mockImplementation(() => {}),
		vi.spyOn(console, 'info').mockImplementation(() => {}),
		vi.spyOn(console, 'log').mockImplementation(() => {}),
		vi.spyOn(console, 'warn').mockImplementation(() => {}),
		vi.spyOn(console, 'error').mockImplementation(() => {}),
	];
}

async function readTypeScriptTree(directory: URL): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const sources: string[] = [];
	for (const entry of entries) {
		const entryUrl = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
		if (entry.isDirectory()) {
			sources.push(...(await readTypeScriptTree(entryUrl)));
		} else if (entry.name.endsWith('.ts')) {
			sources.push(await readFile(entryUrl, 'utf8'));
		}
	}
	return sources;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('synthetic standard and iCloud-style discovery fixtures', () => {
	it.each(SUCCESSFUL_PIPELINE_CASES)(
		'runs the $id complete pipeline with ordered calls and normalized output',
		async ({ fixture, expectedCalls, expectedCollections }) => {
			const result = await runPipeline(fixture);

			expect(result.calls).toEqual(expectedCalls);
			expect(result.collections).toEqual(expectedCollections);
			expect(Object.isFrozen(result.collections)).toBe(true);
		},
	);
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

	it('does not accept wrong-namespace principal and home lookalikes', async () => {
		const wrongPrincipal = fixtureWithBodies('wrong-namespace-principal-required-property', {
			principal:
				'<d:multistatus xmlns:d="DAV:" xmlns:x="urn:fictional:not-dav"><d:response><d:href>/fictional/</d:href><d:propstat><d:prop><x:current-user-principal><d:href>/lookalike-sentinel/</d:href></x:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>',
		});
		const principalTranscript = createSyntheticDiscoveryTranscript(wrongPrincipal);
		const principalTransport = createCalDavTransport(
			wrongPrincipal.configuredUrl,
			principalTranscript.adapter,
		);
		await validateCalDavCapability(principalTransport);

		await expect(discoverCurrentUserPrincipal(principalTransport)).resolves.toEqual({
			kind: 'unavailable',
			code: 'CURRENT_USER_PRINCIPAL_UNAVAILABLE',
			message: 'The CalDAV current-user principal is unavailable.',
		});
		principalTranscript.assertComplete();

		const wrongHome = fixtureWithBodies('wrong-namespace-home-required-property', {
			home: '<d:multistatus xmlns:d="DAV:" xmlns:x="urn:fictional:not-caldav"><d:response><d:href>/principal/</d:href><d:propstat><d:prop><x:calendar-home-set><d:href>/lookalike-sentinel/</d:href></x:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>',
		});
		const homeTranscript = createSyntheticDiscoveryTranscript(wrongHome);
		const homeTransport = createCalDavTransport(wrongHome.configuredUrl, homeTranscript.adapter);
		await validateCalDavCapability(homeTransport);
		const principal = await discoverCurrentUserPrincipal(homeTransport);
		if (principal.kind !== 'authenticated') {
			throw new Error('Expected the hand-authored principal fixture to authenticate.');
		}

		await expect(discoverCalendarHome(homeTransport, principal.principalUrl)).rejects.toMatchObject(
			{
				name: 'CalDavCalendarHomeDiscoveryError',
				code: 'CALENDAR_HOME_MISSING',
			},
		);
		homeTranscript.assertComplete();
	});

	it.each(['principal', 'home', 'collection'] as const)(
		'preserves the XML parser error for a malformed %s response and stops there',
		async (phase) => {
			const body = '<multistatus xmlns="DAV:"><response><href>xml-body-sentinel</href>';
			const fixture = fixtureWithBodies(`malformed-xml-${phase}`, { [phase]: body });
			const error = await captureFailure(runPipeline(fixture));

			expect(error).toMatchObject({
				name: 'CalDavXmlParseError',
				code: 'TRUNCATED_XML',
				message: 'The XML document ended unexpectedly.',
			});
			expect(publicErrorRepresentations(error, [])).not.toContain('xml-body-sentinel');
		},
	);

	it('filters unexpected resource types and component/access variants without losing a valid sibling', async () => {
		const collectionBody = `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="urn:ietf:params:xml:ns:carddav">
			<d:response><d:href>principal/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><d:principal/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
			<d:response><d:href>addressbook/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><a:addressbook/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
			<d:response><d:href>plain/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
			<d:response><d:href>inbox/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:schedule-inbox/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
			<d:response><d:href>not-a-collection/</d:href><d:propstat><d:prop><d:resourcetype><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
			<d:response><d:href>missing-type/</d:href><d:propstat><d:prop><d:displayname>Missing type</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
			<d:response><d:href>tasks/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
			<d:response><d:href>component-forbidden/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop><d:status>HTTP/1.1 403 Forbidden</d:status></d:propstat></d:response>
			<d:response><d:href>component-missing/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>
			<d:response><d:href>unspecified-components/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
			<d:response><d:href>events/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set><d:current-user-privilege-set><d:privilege><d:read/></d:privilege></d:current-user-privilege-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
		</d:multistatus>`;
		const result = await runPipeline(
			fixtureWithBodies('resource-type-filtering', { collection: collectionBody }),
		);

		expect(result.collections).toEqual([
			{
				url: 'https://calendar.example.test/home/component-missing/',
				canRead: null,
				canWrite: null,
			},
			{
				url: 'https://calendar.example.test/home/unspecified-components/',
				canRead: null,
				canWrite: null,
			},
			{
				url: 'https://calendar.example.test/home/events/',
				supportedComponents: ['VEVENT'],
				canRead: true,
				canWrite: false,
			},
		]);
	});

	it('uses a successful singleton over a failed copy but rejects two successful copies without leakage', async () => {
		const successfulPrecedenceBody = `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>precedence/</d:href>
			<d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Successful name</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
			<d:propstat><d:prop><d:displayname>Failed name</d:displayname><c:calendar-description>Failed description</c:calendar-description></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
		</d:response></d:multistatus>`;
		const successful = await runPipeline(
			fixtureWithBodies('successful-over-failed-collection-property', {
				collection: successfulPrecedenceBody,
			}),
		);

		expect(successful.collections).toEqual([
			{
				url: 'https://calendar.example.test/home/precedence/',
				displayName: 'Successful name',
				canRead: null,
				canWrite: null,
			},
		]);

		const consoleSpies = spyOnConsole();
		const collectionBody = `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>collection-href-sentinel/</d:href>
			<d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>display-sentinel-one</d:displayname><c:calendar-description>description-sentinel xml-body-sentinel</c:calendar-description></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
			<d:propstat><d:prop><d:displayname>display-sentinel-failed</d:displayname></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
			<d:propstat><d:prop><d:displayname>display-sentinel-two</d:displayname></d:prop><d:status>HTTP/1.1 299 Synthetic Success</d:status></d:propstat>
		</d:response></d:multistatus>`;
		const fixture = fixtureWithBodies(
			'duplicate-successful-collection-property',
			{
				homeHref: '/effective-url-sentinel/home/',
				collection: collectionBody,
				collectionHeaders: {
					authorization: 'authorization-header-sentinel',
					'x-fictional-token': 'response-token-sentinel',
				},
			},
			'https://calendar.example.test/configured-url-sentinel/account-path-sentinel/',
		);
		const error = await captureFailure(runPipeline(fixture));
		const representations = publicErrorRepresentations(
			error,
			consoleSpies.flatMap((spy) => spy.mock.calls),
		);

		expect(error).toMatchObject({
			name: 'CalDavCalendarCollectionDiscoveryError',
			code: 'AMBIGUOUS_CALENDAR_COLLECTION_PROPERTY',
			message: 'The CalDAV server returned an ambiguous calendar-collection property.',
		});
		for (const sentinel of [
			'configured-url-sentinel',
			'account-path-sentinel',
			'collection-href-sentinel',
			'effective-url-sentinel',
			'xml-body-sentinel',
			'display-sentinel-one',
			'display-sentinel-failed',
			'display-sentinel-two',
			'description-sentinel',
			'authorization-header-sentinel',
			'response-token-sentinel',
		]) {
			expect(representations).not.toContain(sentinel);
		}
		expect(representations).not.toContain(collectionBody);
		expect(Object.keys(error).sort()).toEqual(['code', 'name']);
		expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
	});

	it('denies an untrusted redirect before contacting its target and leaks no redirect inputs', async () => {
		const consoleSpies = spyOnConsole();
		const fixture: SyntheticDiscoveryFixture = {
			id: 'denied-redirect-leakage',
			configuredUrl:
				'https://calendar.example.test/configured-redirect-sentinel/account-redirect-sentinel/',
			steps: [
				{
					id: 'capability',
					method: 'OPTIONS',
					url: 'https://calendar.example.test/configured-redirect-sentinel/account-redirect-sentinel/',
					response: { statusCode: 200, headers: { DAV: 'calendar-access' } },
				},
				{
					id: 'principal-redirect',
					method: 'PROPFIND',
					url: 'https://calendar.example.test/configured-redirect-sentinel/account-redirect-sentinel/',
					depth: '0',
					response: {
						statusCode: 302,
						headers: {
							Location:
								'https://target-host-sentinel.example.test/target-path-sentinel/?query-sentinel=1',
							Authorization: 'authorization-sentinel',
							'X-Fictional-Token': 'token-sentinel',
						},
						body: 'redirect-body-sentinel',
					},
				},
			],
		};
		const transcript = createSyntheticDiscoveryTranscript(fixture);
		const transport = createCalDavTransport(fixture.configuredUrl, transcript.adapter);
		await validateCalDavCapability(transport);
		const error = await captureFailure(discoverCurrentUserPrincipal(transport));
		const representations = publicErrorRepresentations(
			error,
			consoleSpies.flatMap((spy) => spy.mock.calls),
		);

		expect(error).toMatchObject({
			name: 'CalDavUntrustedTargetError',
			code: 'UNTRUSTED_TARGET',
			statusCode: 302,
		});
		expect(transcript.calls).toHaveLength(2);
		transcript.assertComplete();
		for (const sentinel of [
			'configured-redirect-sentinel',
			'account-redirect-sentinel',
			'target-host-sentinel',
			'target-path-sentinel',
			'query-sentinel',
			'authorization-sentinel',
			'token-sentinel',
			'redirect-body-sentinel',
		]) {
			expect(representations).not.toContain(sentinel);
		}
		expect(Object.keys(error).sort()).toEqual(['code', 'name', 'statusCode']);
		expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
	});

	it('normalizes a native adapter failure without exposing credential-like fields', async () => {
		const consoleSpies = spyOnConsole();
		const nativeError = Object.assign(new Error('native-message-sentinel'), {
			username: 'username-sentinel',
			password: 'password-sentinel',
			authorization: 'Basic credential-sentinel',
			headers: { 'x-fictional-token': 'native-token-sentinel' },
		});
		const fixture: SyntheticDiscoveryFixture = {
			id: 'native-error-leakage',
			configuredUrl: 'https://calendar.example.test/native-account-path-sentinel/',
			steps: [
				{
					id: 'capability',
					method: 'OPTIONS',
					url: 'https://calendar.example.test/native-account-path-sentinel/',
					response: { statusCode: 200, headers: { DAV: 'calendar-access' } },
				},
				{
					id: 'principal-native-error',
					method: 'PROPFIND',
					url: 'https://calendar.example.test/native-account-path-sentinel/',
					depth: '0',
					error: nativeError,
				},
			],
		};
		const transcript = createSyntheticDiscoveryTranscript(fixture);
		const transport = createCalDavTransport(fixture.configuredUrl, transcript.adapter);
		await validateCalDavCapability(transport);
		const error = await captureFailure(discoverCurrentUserPrincipal(transport));
		const representations = publicErrorRepresentations(
			error,
			consoleSpies.flatMap((spy) => spy.mock.calls),
		);

		expect(error).toMatchObject({
			name: 'CalDavNetworkError',
			code: 'NETWORK_ERROR',
			message: 'The CalDAV server could not be reached.',
		});
		transcript.assertComplete();
		for (const sentinel of [
			'native-message-sentinel',
			'username-sentinel',
			'password-sentinel',
			'credential-sentinel',
			'native-token-sentinel',
			'native-account-path-sentinel',
		]) {
			expect(representations).not.toContain(sentinel);
		}
		expect(Object.keys(error).sort()).toEqual(['code', 'name']);
		expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
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

		const inventoryIds = [...provenance.matchAll(/`([^`]+)`/g)]
			.map(([, id]) => id)
			.filter((id) => SYNTHETIC_DISCOVERY_CASE_IDS.includes(id));
		expect(new Set(inventoryIds).size).toBe(inventoryIds.length);
		expect(new Set(inventoryIds)).toEqual(new Set(SYNTHETIC_DISCOVERY_CASE_IDS));
		expect(provenance).toContain('hand-authored');
		expect(provenance).toContain('None was copied, sanitized, redacted, transformed');
		expect(provenance).toContain('Real account responses and values must never be committed');
		expect(provenance).toContain('privacy reviewed: pass');
	});

	it('runs every positive transcript offline without a network API or event-operation escape hatch', async () => {
		const networkSentinel = vi.fn(() => {
			throw new Error('network-call-sentinel');
		});
		vi.stubGlobal('fetch', networkSentinel);

		for (const fixture of [
			standardEquivalentFixture,
			iCloudStyleEquivalentFixture,
			iCloudPartitionFixture,
		]) {
			const result = await runPipeline(fixture);
			expect(
				result.calls.every(({ method }) => method === 'OPTIONS' || method === 'PROPFIND'),
			).toBe(true);
		}
		expect(networkSentinel).not.toHaveBeenCalled();

		const productionSources = await readTypeScriptTree(new URL('../../nodes/', import.meta.url));
		expect(productionSources.join('\n')).not.toMatch(
			/from ['"]node:(?:dns|http|https|net|tls)['"]|\bfetch\s*\(|\baxios\s*\(/,
		);
	});

	it('keeps fixture and fixture-helper imports outside production source boundaries', async () => {
		const sources = (
			await Promise.all(
				['../../nodes/', '../../credentials/'].map((path) =>
					readTypeScriptTree(new URL(path, import.meta.url)),
				),
			)
		).flat();

		expect(sources.join('\n')).not.toMatch(
			/synthetic-discovery-fixture|fixtures\/discovery|PROVENANCE\.md/,
		);
	});
});
