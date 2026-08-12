// The integration oracle uses Node streams to adapt real HTTP responses to the production transport.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { Readable } from 'node:stream';

import type {
	IExecuteFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INode,
	INodeListSearchResult,
	INodeType,
} from 'n8n-workflow';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CalDav } from '../../nodes/CalDav/CalDav.node';
import { getCalendarCollection } from '../../nodes/CalDav/actions/calendar/get';
import { discoverCalendarHome } from '../../nodes/CalDav/discovery/calendarHome';
import { discoverCalendarCollections } from '../../nodes/CalDav/discovery/calendarCollections';
import { discoverCurrentUserPrincipal } from '../../nodes/CalDav/discovery/currentUserPrincipal';
import {
	CalendarEventUidResolutionFailureCode,
	resolveCalendarEventByUid,
} from '../../nodes/CalDav/events/resolveByUid';
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
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';
import {
	loadRadicaleHarnessAdapter,
	type RadicaleHarnessAdapter,
	type RadicaleRun,
} from './support/radicale-harness-contract';

function syntheticEventUid(run: RadicaleRun): string {
	const runScopedUid = Buffer.from(run.identity, 'utf8').toString('hex');
	return `oracle-${runScopedUid}@example.test`;
}

function syntheticEvent(run: RadicaleRun): string {
	return `BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//example.test//Radicale harness oracle//EN\r
BEGIN:VEVENT\r
UID:${syntheticEventUid(run)}\r
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

type ResponseBodyTransform = (
	options: N8nCalDavRequestOptions,
	requestBody: string | undefined,
	responseBody: Buffer,
) => Buffer;

function requestAdapter(
	run: RadicaleRun,
	password = run.password,
	transformResponseBody?: ResponseBodyTransform,
): CalDavRequestHelperAdapter {
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
				body: Readable.from(
					transformResponseBody?.(options, requestBody, responseBody) ?? responseBody,
				),
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
	contentType = 'text/calendar; charset=utf-8',
): Promise<Response> {
	return await fetch(url, {
		method,
		headers: {
			Authorization: basicAuthorization(run),
			...(body === undefined ? {} : { 'Content-Type': contentType }),
		},
		...(body === undefined ? {} : { body }),
		redirect: 'manual',
		signal: AbortSignal.timeout(10_000),
	});
}

function mkCalendarBody(
	displayName: string | undefined,
	component: 'VEVENT' | 'VTODO' = 'VEVENT',
): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:set>
    <d:prop>
      ${displayName === undefined ? '' : `<d:displayname>${displayName}</d:displayname>`}
      <c:supported-calendar-component-set><c:comp name="${component}"/></c:supported-calendar-component-set>
    </d:prop>
  </d:set>
</c:mkcalendar>`;
}

async function createSyntheticCalendar(
	run: RadicaleRun,
	suffix: string,
	displayName: string | undefined,
	component: 'VEVENT' | 'VTODO' = 'VEVENT',
): Promise<string> {
	const homeUrl = await discoverPrincipalAndHome(run);
	const collectionUrl = new URL(
		`get-many-${encodeURIComponent(run.identity)}-${encodeURIComponent(suffix)}/`,
		homeUrl,
	).href;
	const response = await authenticatedFetch(
		run,
		collectionUrl,
		'MKCALENDAR',
		mkCalendarBody(displayName, component),
		'application/xml; charset=utf-8',
	);
	expect([201, 204]).toContain(response.status);
	return collectionUrl;
}

async function createSyntheticNonEventCollection(run: RadicaleRun): Promise<string> {
	return await createSyntheticCalendar(run, 'non-event', 'Task Only', 'VTODO');
}

function workflowNode(): INode {
	return {
		id: 'radicale-calendar-get-many',
		name: 'Radicale Calendar Get Many',
		type: 'CUSTOM.calDav',
		typeVersion: 1,
		position: [0, 0],
		parameters: {},
	};
}

function calendarGetManyContext(run: RadicaleRun): IExecuteFunctions {
	const adapter = requestAdapter(run);
	const context = {
		getInputData: vi.fn().mockReturnValue([{ json: { oracle: 'radicale' } }]),
		getNodeParameter: vi.fn((name: string, itemIndex: number) => {
			expect(itemIndex).toBe(0);
			if (name === 'resource') return 'calendar';
			if (name === 'operation') return 'getMany';
			if (name === 'returnAll') return true;
			throw new Error(`Unexpected active parameter read: ${name}.`);
		}),
		getCredentials: vi.fn().mockResolvedValue({
			serverUrl: run.endpoint,
			username: run.username,
			password: run.password,
			allowUnauthorizedCerts: false,
		}),
		continueOnFail: vi.fn().mockReturnValue(false),
		getNode: vi.fn().mockReturnValue(workflowNode()),
		helpers: {
			async httpRequestWithAuthentication(_credentialType: string, options: IHttpRequestOptions) {
				return await adapter.request(options as N8nCalDavRequestOptions);
			},
		},
	};
	return context as unknown as IExecuteFunctions;
}

function calendarListSearchContext(
	run: RadicaleRun,
	transformResponseBody?: ResponseBodyTransform,
): ILoadOptionsFunctions {
	const adapter = requestAdapter(run, run.password, transformResponseBody);
	return {
		getCredentials: vi.fn().mockResolvedValue({
			serverUrl: run.endpoint,
			username: run.username,
			password: run.password,
			allowUnauthorizedCerts: false,
		}),
		getNode: vi.fn().mockReturnValue(workflowNode()),
		helpers: {
			async httpRequestWithAuthentication(_credentialType: string, options: IHttpRequestOptions) {
				return await adapter.request(options as N8nCalDavRequestOptions);
			},
		},
	} as unknown as ILoadOptionsFunctions;
}

async function searchRadicaleCalendars(
	run: RadicaleRun,
	filter?: string,
	paginationToken?: string,
	transformResponseBody?: ResponseBodyTransform,
): Promise<INodeListSearchResult> {
	const method = (new CalDav() as INodeType).methods?.listSearch?.searchCalendars;
	expect(method).toBeTypeOf('function');
	if (method === undefined) throw new Error('Missing listSearch.searchCalendars method.');
	return await method.call(
		calendarListSearchContext(run, transformResponseBody),
		filter,
		paginationToken,
	);
}

function escapeRegularExpression(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function calendarCollectionPath(collectionUrl: string): string {
	return decodeURIComponent(new URL(collectionUrl).pathname).replace(/^\/+|\/+$/g, '');
}

function missingAndEmptyDisplayNameFixture(
	emptyDisplayNameUrl: string,
	missingDisplayNameUrl: string,
): ResponseBodyTransform {
	// Radicale 3.7.7 replaces a falsey DAV:displayname with collection.path in PROPFIND.
	// Restore the provider-neutral wire shapes only in the list response under test.
	const fixtures = [
		{ url: emptyDisplayNameUrl, replacement: 'empty' },
		{ url: missingDisplayNameUrl, replacement: 'missing' },
	] as const;

	return (options, requestBody, responseBody) => {
		if (
			options.method !== 'PROPFIND' ||
			requestBody?.includes('supported-calendar-component-set') !== true
		) {
			return responseBody;
		}

		let xml = responseBody.toString('utf8');
		for (const fixture of fixtures) {
			const fallbackName = calendarCollectionPath(fixture.url);
			const displayName = new RegExp(
				`<((?:[A-Za-z_][\\w.-]*:)?displayname)(?:\\s[^>]*)?>${escapeRegularExpression(fallbackName)}</\\1\\s*>`,
				'g',
			);
			expect(xml.match(displayName)).toHaveLength(1);
			xml = xml.replace(displayName, fixture.replacement === 'empty' ? '<$1/>' : '');
		}

		return Buffer.from(xml, 'utf8');
	};
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
			const writableGet = await getCalendarCollection(
				transport(run),
				validateAbsoluteHttpUrl(writableCollectionUrl),
			);
			const readOnlyGet = await getCalendarCollection(
				transport(run),
				validateAbsoluteHttpUrl(readOnlyCollectionUrl),
			);

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
			expect(writableGet).toMatchObject({
				url: writableCollectionUrl,
				supportedComponents: ['VTODO', 'VEVENT', 'VJOURNAL'],
				canRead: true,
				canWrite: true,
			});
			expect(readOnlyGet).toMatchObject({
				url: readOnlyCollectionUrl,
				supportedComponents: ['VTODO', 'VEVENT', 'VJOURNAL'],
				canRead: true,
				canWrite: false,
			});
			expect(writableCollection?.displayName).toBeTypeOf('string');
			expect(readOnlyCollection?.displayName).toBeTypeOf('string');
			expect(writableGet.displayName).toBeTypeOf('string');
			expect(readOnlyGet.displayName).toBeTypeOf('string');
			expect(writableCollection).not.toHaveProperty('extensions');
			expect(readOnlyCollection).not.toHaveProperty('extensions');
			expect(writableGet).not.toHaveProperty('extensions');
			expect(readOnlyGet).not.toHaveProperty('extensions');
			expect((await authenticatedFetch(run, readOnlyEventUrl)).status).toBe(200);
			expect(
				(await authenticatedFetch(run, readOnlyEventUrl, 'PUT', syntheticEvent(run))).status,
			).toBe(403);
			const serialized = JSON.stringify({ collections, writableGet, readOnlyGet });
			expect(serialized).not.toContain(run.password);
		} finally {
			await teardownRun(run);
		}
	});

	it('executes Calendar Get Many for an empty home and filters/sorts writable, read-only, and non-event collections', async () => {
		const run = await startRun();
		try {
			await expect(harness.waitForAuthenticatedReadiness(run)).resolves.toBeUndefined();
			await expect(new CalDav().execute.call(calendarGetManyContext(run))).resolves.toEqual([[]]);

			const writableUrl = await createSyntheticCalendar(run, 'writable', 'Zulu Writable');
			const readOnlyUrl = await createSyntheticCalendar(run, 'read-only', 'Alpha Read Only');
			const nonEventUrl = await createSyntheticNonEventCollection(run);
			await harness.makeCalendarReadOnly(run, readOnlyUrl);

			const [output] = await new CalDav().execute.call(calendarGetManyContext(run));
			expect(output).toHaveLength(2);
			expect(output).toEqual([
				{
					json: expect.objectContaining({
						url: readOnlyUrl,
						displayName: 'Alpha Read Only',
						canRead: true,
						canWrite: false,
					}),
					pairedItem: { item: 0 },
				},
				{
					json: expect.objectContaining({
						url: writableUrl,
						displayName: 'Zulu Writable',
						canRead: true,
						canWrite: true,
					}),
					pairedItem: { item: 0 },
				},
			]);
			const serialized = JSON.stringify(output);
			expect(serialized).not.toContain(nonEventUrl);
			expect(serialized).not.toContain(run.password);
			expect(serialized).not.toContain(basicAuthorization(run));
		} finally {
			await teardownRun(run);
		}
	});

	it('loads duplicate, missing, empty, writable, and read-only VEVENT calendars while excluding VTODO-only collections', async () => {
		const run = await startRun();
		try {
			await expect(searchRadicaleCalendars(run, '', 'ignored-pagination-token')).resolves.toEqual({
				results: [],
			});

			const duplicateAUrl = await createSyntheticCalendar(run, 'duplicate-a', 'Duplicate');
			const duplicateZUrl = await createSyntheticCalendar(run, 'duplicate-z', 'Duplicate');
			const emptyUrl = await createSyntheticCalendar(run, 'empty', '');
			const missingUrl = await createSyntheticCalendar(run, 'missing', undefined);
			const readOnlyUrl = await createSyntheticCalendar(run, 'read-only-search', 'Read Only');
			const todoOnlyUrl = await createSyntheticCalendar(
				run,
				'todo-only-search',
				'Task Only',
				'VTODO',
			);
			await harness.makeCalendarReadOnly(run, readOnlyUrl);
			const displayNameFixture = missingAndEmptyDisplayNameFixture(emptyUrl, missingUrl);

			const all = await searchRadicaleCalendars(run, undefined, undefined, displayNameFixture);
			expect(all).not.toHaveProperty('paginationToken');
			expect(all.results.map(({ value }) => value)).toEqual([
				emptyUrl,
				missingUrl,
				duplicateAUrl,
				duplicateZUrl,
				readOnlyUrl,
			]);
			expect(all.results[0]).toEqual({
				name: emptyUrl,
				value: emptyUrl,
				description: 'Read: yes; Write: yes',
			});
			expect(all.results[1]).toEqual({
				name: missingUrl,
				value: missingUrl,
				description: 'Read: yes; Write: yes',
			});
			for (const [index, url] of [
				[2, duplicateAUrl],
				[3, duplicateZUrl],
			] as const) {
				expect(all.results[index].name).toContain('Duplicate');
				expect(all.results[index].name).toContain(url);
				expect(all.results[index]).toMatchObject({
					value: url,
					description: 'Read: yes; Write: yes',
				});
			}
			expect(all.results[2].name).not.toBe(all.results[3].name);
			expect(all.results[4]).toEqual({
				name: 'Read Only',
				value: readOnlyUrl,
				description: 'Read: yes; Write: no',
			});
			expect(all.results.every((option) => option.disabled !== true)).toBe(true);
			expect(JSON.stringify(all)).not.toContain(todoOnlyUrl);

			const filtered = await searchRadicaleCalendars(
				run,
				'DUPLICATE',
				undefined,
				displayNameFixture,
			);
			expect(filtered.results.map(({ value }) => value)).toEqual([duplicateAUrl, duplicateZUrl]);
			const serialized = JSON.stringify({ all, filtered });
			expect(serialized).not.toContain(run.password);
			expect(serialized).not.toContain(basicAuthorization(run));
		} finally {
			await teardownRun(run);
		}
	});
});

describe('Radicale calendar-event UID resolution', () => {
	it('resolves a stored UID and returns stable not-found for a missing UID in the same calendar', async () => {
		const run = await startRun();
		try {
			const eventUrl = await createSyntheticEvent(run, 'uid-resolution');
			const calendarUrl = validateAbsoluteHttpUrl(new URL('./', eventUrl).href);
			const uid = syntheticEventUid(run);
			const storedResponse = await authenticatedFetch(run, eventUrl);
			const storedEtag = storedResponse.headers.get('etag');
			expect(storedResponse.status).toBe(200);
			expect(storedEtag).not.toBeNull();

			const result = await resolveCalendarEventByUid(transport(run), calendarUrl, uid);
			expect(result.event).toEqual({
				calendarUrl,
				resourceUrl: eventUrl,
				etag: storedEtag,
				uid,
				summary: 'Synthetic harness oracle event',
				start: '2040-01-02T10:00:00Z',
				end: '2040-01-02T10:30:00Z',
			});
			expect(result.context.resource.originalIcs.replace(/\r?\n[ \t]/g, '')).toContain(
				`UID:${uid}`,
			);
			expect(result.context.master.kind).toBe('component');
			expect(result.context.exceptions).toEqual([]);

			const missingUid = `missing-${run.identity}@example.test`;
			await expect(
				resolveCalendarEventByUid(transport(run), calendarUrl, missingUid),
			).rejects.toMatchObject({
				name: 'CalDavCalendarEventUidResolutionError',
				code: CalendarEventUidResolutionFailureCode.NOT_FOUND,
				message: 'No calendar event with the requested UID was found in the selected calendar.',
			});
			const serialized = JSON.stringify(result);
			expect(serialized).not.toContain(run.password);
			expect(serialized).not.toContain(basicAuthorization(run));
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
