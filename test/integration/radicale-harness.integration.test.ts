// The integration oracle uses Node streams to adapt real HTTP responses to the production transport.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { Readable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { discoverCalendarHome } from '../../nodes/CalDav/discovery/calendarHome';
import { discoverCalendarCollections } from '../../nodes/CalDav/discovery/calendarCollections';
import { discoverCurrentUserPrincipal } from '../../nodes/CalDav/discovery/currentUserPrincipal';
import {
	CalDavAuthenticationError,
	CalDavNetworkError,
	createCalDavTransport,
} from '../../nodes/CalDav/transport/http';
import type {
	CalDavRequestHelperAdapter,
	CalDavTransport,
	N8nCalDavRequestOptions,
} from '../../nodes/CalDav/transport/http';
import type { AbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';
import {
	loadRadicaleHarnessAdapter,
	type RadicaleHarnessAdapter,
	type RadicaleRun,
} from './support/radicale-harness-contract';

function syntheticEvent(run: RadicaleRun): string {
	const runScopedUid = Buffer.from(run.identity, 'utf8').toString('hex');
	return `BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//example.test//Radicale harness oracle//EN\r
BEGIN:VEVENT\r
UID:oracle-${runScopedUid}@example.test\r
DTSTAMP:20400101T000000Z\r
DTSTART:20400102T100000Z\r
DTEND:20400102T103000Z\r
SUMMARY:Synthetic harness oracle event\r
END:VEVENT\r
END:VCALENDAR\r
`;
}

let harness: RadicaleHarnessAdapter;
const activeRuns = new Map<string, RadicaleRun>();

function basicAuthorization(run: RadicaleRun, password = run.password): string {
	return `Basic ${Buffer.from(`${run.username}:${password}`, 'utf8').toString('base64')}`;
}

function requestAdapter(run: RadicaleRun, password = run.password): CalDavRequestHelperAdapter {
	return {
		async request(options: N8nCalDavRequestOptions) {
			const requestBody =
				typeof options.body === 'string'
					? options.body
					: Buffer.isBuffer(options.body)
						? options.body.toString('utf8')
						: undefined;
			expect(options.body === undefined || requestBody !== undefined).toBe(true);
			const response = await fetch(options.url, {
				method: options.method,
				headers: {
					...options.headers,
					Authorization: basicAuthorization(run, password),
				},
				...(requestBody === undefined ? {} : { body: requestBody }),
				redirect: 'manual',
				signal: AbortSignal.timeout(10_000),
			});
			const responseBody = Buffer.from(await response.arrayBuffer());
			const responseHeaders: Record<string, string> = {};
			response.headers.forEach((value, name) => {
				responseHeaders[name] = value;
			});

			return {
				statusCode: response.status,
				headers: responseHeaders,
				body: Readable.from(responseBody),
			};
		},
	};
}

function transport(run: RadicaleRun, password = run.password): CalDavTransport {
	return createCalDavTransport(run.endpoint, requestAdapter(run, password));
}

async function startRun(): Promise<RadicaleRun> {
	const run = await harness.start();
	activeRuns.set(run.identity, run);
	return run;
}

async function teardownRun(run: RadicaleRun): Promise<void> {
	try {
		await harness.teardown(run);
	} finally {
		activeRuns.delete(run.identity);
	}
}

async function discoverPrincipalAndHome(run: RadicaleRun): Promise<AbsoluteHttpUrl> {
	const currentUserPrincipal = await discoverCurrentUserPrincipal(transport(run));
	expect(currentUserPrincipal.kind).toBe('authenticated');
	if (currentUserPrincipal.kind !== 'authenticated') {
		throw new Error('The synthetic Radicale principal did not authenticate.');
	}

	const home = await discoverCalendarHome(transport(run), currentUserPrincipal.principalUrl);
	expect(new URL(home.calendarHomeUrl).origin).toBe(new URL(run.endpoint).origin);
	return home.calendarHomeUrl;
}

async function authenticatedFetch(
	run: RadicaleRun,
	url: string,
	method = 'GET',
	body?: string,
): Promise<Response> {
	return await fetch(url, {
		method,
		headers: {
			Authorization: basicAuthorization(run),
			...(body === undefined ? {} : { 'Content-Type': 'text/calendar; charset=utf-8' }),
		},
		...(body === undefined ? {} : { body }),
		redirect: 'manual',
		signal: AbortSignal.timeout(10_000),
	});
}

async function createSyntheticEvent(run: RadicaleRun, calendarSuffix = 'default'): Promise<string> {
	const homeUrl = await discoverPrincipalAndHome(run);
	const collectionUrl = new URL(
		`oracle-${encodeURIComponent(run.identity)}-${encodeURIComponent(calendarSuffix)}/`,
		homeUrl,
	).href;
	const createCollection = await authenticatedFetch(run, collectionUrl, 'MKCALENDAR');
	expect([201, 204]).toContain(createCollection.status);

	const eventUrl = new URL('event.ics', collectionUrl).href;
	const putEvent = await authenticatedFetch(run, eventUrl, 'PUT', syntheticEvent(run));
	expect([201, 204]).toContain(putEvent.status);
	expect((await authenticatedFetch(run, eventUrl)).status).toBe(200);
	return eventUrl;
}

beforeAll(async () => {
	harness = await loadRadicaleHarnessAdapter();
	await harness.buildImage();
});

afterAll(async () => {
	const cleanupResults = await Promise.allSettled([...activeRuns.values()].map(teardownRun));
	const cleanupFailures = cleanupResults.filter((result) => result.status === 'rejected');
	if (cleanupFailures.length > 0) {
		throw new Error(`Mandatory Radicale cleanup failed for ${cleanupFailures.length} run(s).`);
	}
});

describe('Radicale authenticated discovery', () => {
	it('discovers the generated current-user principal and calendar home from fresh storage', async () => {
		const run = await startRun();
		try {
			await expect(harness.waitForAuthenticatedReadiness(run)).resolves.toBeUndefined();
			await expect(discoverPrincipalAndHome(run)).resolves.toBeTruthy();
		} finally {
			await teardownRun(run);
		}
	});

	it('rejects an invalid password without invalidating the generated credential', async () => {
		const run = await startRun();
		try {
			await expect(
				discoverCurrentUserPrincipal(transport(run, `${run.password}-invalid`)),
			).rejects.toBeInstanceOf(CalDavAuthenticationError);
			await expect(discoverPrincipalAndHome(run)).resolves.toBeTruthy();
		} finally {
			await teardownRun(run);
		}
	});

	it('reports bounded sanitized unavailability and still permits teardown', async () => {
		const run = await startRun();
		const startedAt = Date.now();
		try {
			await harness.stopService(run);
			let unavailableError: unknown;
			try {
				await discoverCurrentUserPrincipal(transport(run));
			} catch (error) {
				unavailableError = error;
			}
			expect(unavailableError).toBeInstanceOf(CalDavNetworkError);
			expect(String(unavailableError)).not.toContain(run.password);
			expect(String(unavailableError)).not.toContain(basicAuthorization(run));
			expect(Date.now() - startedAt).toBeLessThan(10_000);
		} finally {
			await teardownRun(run);
		}
	});

	it('discovers real writable and read-only VEVENT calendars with accurate privileges', async () => {
		const run = await startRun();
		try {
			const writableEventUrl = await createSyntheticEvent(run, 'writable');
			const readOnlyEventUrl = await createSyntheticEvent(run, 'read-only');
			const writableCollectionUrl = new URL('./', writableEventUrl).href;
			const readOnlyCollectionUrl = new URL('./', readOnlyEventUrl).href;
			await harness.makeCalendarReadOnly(run, readOnlyCollectionUrl);

			const homeUrl = await discoverPrincipalAndHome(run);
			const collections = await discoverCalendarCollections(transport(run), homeUrl);
			const writableCollection = collections.find(({ url }) => url === writableCollectionUrl);
			const readOnlyCollection = collections.find(({ url }) => url === readOnlyCollectionUrl);

			expect(writableCollection).toMatchObject({
				url: writableCollectionUrl,
				supportedComponents: ['VTODO', 'VEVENT', 'VJOURNAL'],
				canRead: true,
				canWrite: true,
			});
			expect(readOnlyCollection).toMatchObject({
				url: readOnlyCollectionUrl,
				supportedComponents: ['VTODO', 'VEVENT', 'VJOURNAL'],
				canRead: true,
				canWrite: false,
			});
			expect(writableCollection?.displayName).toBeTypeOf('string');
			expect(readOnlyCollection?.displayName).toBeTypeOf('string');
			expect(writableCollection).not.toHaveProperty('extensions');
			expect(readOnlyCollection).not.toHaveProperty('extensions');
			expect((await authenticatedFetch(run, readOnlyEventUrl)).status).toBe(200);
			expect(
				(await authenticatedFetch(run, readOnlyEventUrl, 'PUT', syntheticEvent(run))).status,
			).toBe(403);
			const serialized = JSON.stringify(collections);
			expect(serialized).not.toContain(run.password);
		} finally {
			await teardownRun(run);
		}
	});
});

describe('Radicale run isolation and confinement', () => {
	it('resets only the selected run and preserves authenticated reconnection', async () => {
		const [resetRun, controlRun] = await Promise.all([startRun(), startRun()]);
		try {
			const [resetEventUrl, controlEventUrl] = await Promise.all([
				createSyntheticEvent(resetRun),
				createSyntheticEvent(controlRun),
			]);

			await harness.resetStorage(resetRun);

			expect((await authenticatedFetch(resetRun, resetEventUrl)).status).toBe(404);
			expect((await authenticatedFetch(controlRun, controlEventUrl)).status).toBe(200);
			await expect(discoverPrincipalAndHome(resetRun)).resolves.toBeTruthy();
		} finally {
			await Promise.all([teardownRun(resetRun), teardownRun(controlRun)]);
		}
	});

	it('allocates distinct parallel identities and confines each runtime', async () => {
		const [first, second] = await Promise.all([startRun(), startRun()]);
		try {
			for (const field of [
				'identity',
				'endpoint',
				'username',
				'password',
				'configurationIdentity',
				'serviceIdentity',
				'storageIdentity',
			] as const) {
				expect(first[field]).not.toBe(second[field]);
			}

			await Promise.all([discoverPrincipalAndHome(first), discoverPrincipalAndHome(second)]);
			const [firstInspection, secondInspection] = await Promise.all([
				harness.inspect(first),
				harness.inspect(second),
			]);
			for (const inspection of [firstInspection, secondInspection]) {
				expect(inspection.loopbackOnly).toBe(true);
				expect(inspection.runtimeInternetEgress).toBe(false);
				expect(inspection.repositoryLocalRuntimeOnly).toBe(true);
				expect(inspection.liveResourceIdentities.length).toBeGreaterThan(0);
			}

			await teardownRun(first);
			expect(await harness.findLiveResources(first.identity)).toEqual([]);
			await expect(discoverPrincipalAndHome(second)).resolves.toBeTruthy();
		} finally {
			if (activeRuns.has(first.identity)) {
				await teardownRun(first);
			}
			await teardownRun(second);
		}
	});
});

describe('Radicale mandatory failure cleanup', () => {
	it('returns nonzero only after deliberate failure cleanup and redacts the run secret', async () => {
		const result = await harness.runDeliberateFailureProbe();
		const combinedOutput = `${result.stdout}\n${result.stderr}`;

		expect(result.exitCode).not.toBe(0);
		expect(combinedOutput.toLowerCase()).toContain('test');
		expect(combinedOutput).not.toContain(result.secretCanary);
		expect(await harness.findLiveResources(result.runIdentity)).toEqual([]);

		const followUpRun = await startRun();
		try {
			expect(followUpRun.identity).not.toBe(result.runIdentity);
			await expect(discoverPrincipalAndHome(followUpRun)).resolves.toBeTruthy();
		} finally {
			await teardownRun(followUpRun);
		}
	});
});
