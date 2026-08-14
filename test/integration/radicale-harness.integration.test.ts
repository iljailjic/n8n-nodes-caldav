// The integration oracle uses Node streams to adapt real HTTP responses to the production transport.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { Readable } from 'node:stream';

import type {
	IExecuteFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IN8nHttpFullResponse,
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
import { createCalendarEvent } from '../../nodes/CalDav/events/create';
import { getCalendarEventByResourceUrl } from '../../nodes/CalDav/events/getByResourceUrl';
import {
	CalendarEventMutationFailureCode,
	createCalendarEventResource,
	deleteCalendarEventResource,
	updateCalendarEventResource,
} from '../../nodes/CalDav/events/mutations';
import { queryCalendarEventsByTimeRange } from '../../nodes/CalDav/events/timeRangeQuery';
import {
	CalendarEventUidResolutionFailureCode,
	resolveCalendarEventByUid,
} from '../../nodes/CalDav/events/resolveByUid';
import { serializeBasicUtcEvent } from '../../nodes/CalDav/icalendar/serializer';
import {
	CalDavAuthenticationError,
	CalDavAuthorizationError,
	CalDavNetworkError,
	CalDavNotFoundError,
	createCalDavTransport,
} from '../../nodes/CalDav/transport/http';
import type {
	CalDavRequestHelperAdapter,
	CalDavTransport,
	CalDavTransportRequest,
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

function mutationEvent(run: RadicaleRun, summary: string): string {
	return syntheticEvent(run).replace(
		'SUMMARY:Synthetic harness oracle event',
		`SUMMARY:${summary}`,
	);
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

interface EventDeleteIntegrationParameters {
	readonly calendar: unknown;
	readonly identifierMode: 'resourceUrl' | 'uid';
	readonly resourceUrl?: string;
	readonly uid?: string;
	readonly etag?: unknown;
}

interface EventCreateIntegrationParameters {
	readonly calendar: unknown;
	readonly uid: unknown;
	readonly start: unknown;
	readonly end: unknown;
	readonly summary: unknown;
	readonly additionalFields: unknown;
}

interface EventUpdateIntegrationParameters {
	readonly calendar: unknown;
	readonly identifierMode: 'resourceUrl' | 'uid';
	readonly resourceUrl?: string;
	readonly uid?: string;
	readonly etag?: unknown;
	readonly fieldsToUpdate: unknown;
}

function eventCreateContext(
	run: RadicaleRun,
	parameters: EventCreateIntegrationParameters,
): {
	readonly context: IExecuteFunctions;
	readonly requests: ReturnType<typeof vi.fn>;
} {
	const adapter = requestAdapter(run);
	const requests = vi.fn(
		async (options: N8nCalDavRequestOptions) => await adapter.request(options),
	);
	const values: Readonly<Record<string, unknown>> = {
		resource: 'event',
		operation: 'create',
		calendar: parameters.calendar,
		uid: parameters.uid,
		start: parameters.start,
		end: parameters.end,
		summary: parameters.summary,
		additionalFields: parameters.additionalFields,
	};
	const context = {
		getInputData: vi.fn().mockReturnValue([{ json: { oracle: 'event-create' } }]),
		getNodeParameter: vi.fn((name: string, itemIndex: number) => {
			expect(itemIndex).toBe(0);
			if (!Object.hasOwn(values, name)) {
				throw new Error(`Unexpected active parameter read: ${name}.`);
			}
			return values[name];
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
				return await requests(options as N8nCalDavRequestOptions);
			},
		},
	};
	return { context: context as unknown as IExecuteFunctions, requests };
}

function eventDeleteContext(
	run: RadicaleRun,
	parameters: EventDeleteIntegrationParameters,
): {
	readonly context: IExecuteFunctions;
	readonly requests: ReturnType<typeof vi.fn>;
} {
	const adapter = requestAdapter(run);
	const requests = vi.fn(
		async (options: N8nCalDavRequestOptions) => await adapter.request(options),
	);
	const values: Readonly<Record<string, unknown>> = {
		resource: 'event',
		operation: 'delete',
		calendar: parameters.calendar,
		identifierMode: parameters.identifierMode,
		resourceUrl: parameters.resourceUrl,
		uid: parameters.uid,
		etag: parameters.etag,
	};
	const context = {
		getInputData: vi.fn().mockReturnValue([{ json: { oracle: 'event-delete' } }]),
		getNodeParameter: vi.fn((name: string, itemIndex: number) => {
			expect(itemIndex).toBe(0);
			if (!Object.hasOwn(values, name)) {
				throw new Error(`Unexpected active parameter read: ${name}.`);
			}
			return values[name];
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
				return await requests(options as N8nCalDavRequestOptions);
			},
		},
	};
	return { context: context as unknown as IExecuteFunctions, requests };
}

function eventUpdateContext(
	run: RadicaleRun,
	parameters: EventUpdateIntegrationParameters,
	beforeRequest?: (options: N8nCalDavRequestOptions) => Promise<void>,
): {
	readonly context: IExecuteFunctions;
	readonly requests: ReturnType<typeof vi.fn>;
	readonly responses: IN8nHttpFullResponse[];
} {
	const adapter = requestAdapter(run);
	const responses: IN8nHttpFullResponse[] = [];
	const requests = vi.fn(async (options: N8nCalDavRequestOptions) => {
		await beforeRequest?.(options);
		const response = await adapter.request(options);
		responses.push(response);
		return response;
	});
	const values: Readonly<Record<string, unknown>> = {
		resource: 'event',
		operation: 'update',
		calendar: parameters.calendar,
		identifierMode: parameters.identifierMode,
		resourceUrl: parameters.resourceUrl,
		uid: parameters.uid,
		etag: parameters.etag,
		fieldsToUpdate: parameters.fieldsToUpdate,
	};
	const context = {
		getInputData: vi.fn().mockReturnValue([{ json: { oracle: 'event-update' } }]),
		getNodeParameter: vi.fn((name: string, itemIndex: number) => {
			expect(itemIndex).toBe(0);
			if (!Object.hasOwn(values, name)) {
				throw new Error(`Unexpected active parameter read: ${name}.`);
			}
			return values[name];
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
				return await requests(options as N8nCalDavRequestOptions);
			},
		},
	};
	return { context: context as unknown as IExecuteFunctions, requests, responses };
}

async function captureNodeExecutionError(context: IExecuteFunctions): Promise<Error> {
	try {
		await new CalDav().execute.call(context);
	} catch (error) {
		return error as Error;
	}
	throw new Error('Expected the live Event Delete operation to fail.');
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

async function putSyntheticEventResource(
	run: RadicaleRun,
	collectionUrl: string,
	resourceName: string,
	uid: string,
	start: string,
	end: string,
	extraLines: readonly string[] = [],
): Promise<void> {
	const body = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//example.test//Radicale time range oracle//EN',
		'BEGIN:VEVENT',
		`UID:${uid}`,
		'DTSTAMP:20400101T000000Z',
		`DTSTART:${start}`,
		`DTEND:${end}`,
		...extraLines,
		`SUMMARY:Synthetic boundary oracle ${uid}`,
		'END:VEVENT',
		'END:VCALENDAR',
		'',
	].join('\r\n');
	const response = await authenticatedFetch(
		run,
		new URL(resourceName, collectionUrl).href,
		'PUT',
		body,
	);
	expect([201, 204]).toContain(response.status);
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

	it('enforces [start,end) overlap boundaries and returns one recurring resource', async () => {
		const run = await startRun();
		try {
			const collectionUrl = await createSyntheticCalendar(
				run,
				'time-range-boundaries',
				'Time Range Boundaries',
			);
			const fixtures = [
				['ends-at-start.ics', 'ends-at-start', '20400102T090000Z', '20400102T100000Z', []],
				['starts-at-start.ics', 'starts-at-start', '20400102T100000Z', '20400102T101500Z', []],
				['inside.ics', 'inside', '20400102T101500Z', '20400102T103000Z', []],
				['spanning.ics', 'spanning', '20400102T093000Z', '20400102T113000Z', []],
				['starts-at-end.ics', 'starts-at-end', '20400102T110000Z', '20400102T120000Z', []],
				['before.ics', 'before', '20400102T080000Z', '20400102T090000Z', []],
				['after.ics', 'after', '20400102T120000Z', '20400102T130000Z', []],
				[
					'recurring.ics',
					'recurring-overlap',
					'20400101T103000Z',
					'20400101T104500Z',
					['RRULE:FREQ=DAILY;COUNT=3'],
				],
			] as const;
			await Promise.all(
				fixtures.map(([resourceName, uid, start, end, extraLines]) =>
					putSyntheticEventResource(run, collectionUrl, resourceName, uid, start, end, extraLines),
				),
			);

			const result = await queryCalendarEventsByTimeRange(
				transport(run),
				validateAbsoluteHttpUrl(collectionUrl),
				{
					start: new Date('2040-01-02T10:00:00Z'),
					end: new Date('2040-01-02T11:00:00Z'),
				},
			);

			expect(result.map(({ event }) => event.uid)).toEqual([
				'recurring-overlap',
				'spanning',
				'starts-at-start',
				'inside',
			]);
			expect(result.filter(({ event }) => event.uid === 'recurring-overlap')).toHaveLength(1);
			expect(result.find(({ event }) => event.uid === 'recurring-overlap')?.event.start).toBe(
				'2040-01-01T10:30:00Z',
			);
			expect(Object.isFrozen(result)).toBe(true);
			expect(JSON.stringify(result)).not.toContain(run.password);
			expect(JSON.stringify(result)).not.toContain(basicAuthorization(run));
		} finally {
			await teardownRun(run);
		}
	});
});

describe('Radicale calendar-event UID resolution', () => {
	it('retrieves one stored event identically by exact resource URL and UID with live missing and forbidden boundaries', async () => {
		const run = await startRun();
		try {
			const eventUrl = await createSyntheticEvent(run, 'uid-resolution');
			const calendarUrl = validateAbsoluteHttpUrl(new URL('./', eventUrl).href);
			const uid = syntheticEventUid(run);
			const storedResponse = await authenticatedFetch(run, eventUrl);
			const storedEtag = storedResponse.headers.get('etag');
			expect(storedResponse.status).toBe(200);
			expect(storedEtag).not.toBeNull();

			const directResult = await getCalendarEventByResourceUrl(
				transport(run),
				calendarUrl,
				validateAbsoluteHttpUrl(eventUrl),
			);
			const uidResult = await resolveCalendarEventByUid(transport(run), calendarUrl, uid);
			const expectedEvent = {
				calendarUrl,
				resourceUrl: eventUrl,
				etag: storedEtag,
				uid,
				summary: 'Synthetic harness oracle event',
				start: '2040-01-02T10:00:00Z',
				end: '2040-01-02T10:30:00Z',
			};
			expect(directResult.event).toEqual(expectedEvent);
			expect(uidResult.event).toEqual(expectedEvent);
			expect(directResult.event).toEqual(uidResult.event);
			expect(uidResult.context.resource.originalIcs.replace(/\r?\n[ \t]/g, '')).toContain(
				`UID:${uid}`,
			);
			expect(uidResult.context.master.kind).toBe('component');
			expect(uidResult.context.exceptions).toEqual([]);

			await expect(
				getCalendarEventByResourceUrl(
					transport(run),
					calendarUrl,
					validateAbsoluteHttpUrl(new URL('missing-resource', calendarUrl).href),
				),
			).rejects.toBeInstanceOf(CalDavNotFoundError);

			const missingUid = `missing-${run.identity}@example.test`;
			await expect(
				resolveCalendarEventByUid(transport(run), calendarUrl, missingUid),
			).rejects.toMatchObject({
				name: 'CalDavCalendarEventUidResolutionError',
				code: CalendarEventUidResolutionFailureCode.NOT_FOUND,
				message: 'No calendar event with the requested UID was found in the selected calendar.',
			});

			const forbiddenCalendarUrl = validateAbsoluteHttpUrl(
				new URL('forbidden-principal/private/', run.endpoint).href,
			);
			await expect(
				getCalendarEventByResourceUrl(
					transport(run),
					forbiddenCalendarUrl,
					validateAbsoluteHttpUrl(new URL('event', forbiddenCalendarUrl).href),
				),
			).rejects.toBeInstanceOf(CalDavAuthorizationError);

			const serialized = JSON.stringify({ directResult, uidResult });
			expect(serialized).not.toContain(run.password);
			expect(serialized).not.toContain(basicAuthorization(run));
		} finally {
			await teardownRun(run);
		}
	});
});

describe('Radicale collision-safe Event Create', () => {
	it('creates and reads back Unicode data, then preserves it across a same-UID collision', async () => {
		const run = await startRun();
		try {
			const calendarUrl = validateAbsoluteHttpUrl(
				await createSyntheticCalendar(run, 'node-create-unicode', 'Create Unicode'),
			);
			const adapter = requestAdapter(run);
			const requests = vi.fn(
				async (options: N8nCalDavRequestOptions) => await adapter.request(options),
			);
			const inspectedTransport = createCalDavTransport(run.endpoint, { request: requests });
			const uid = ` opaque/../🚀-${run.identity} `;
			const created = await createCalendarEvent(
				inspectedTransport,
				{
					calendarUrl,
					uid,
					start: new Date('2040-02-03T10:00:00Z'),
					end: new Date('2040-02-03T11:00:00Z'),
					summary: 'Žluťoučký Create 🚀',
					description: '',
					location: 'Praha; Brno',
					url: 'urn:example:radicale:create',
				},
				() => new Date('2040-02-01T00:00:00.999Z'),
			);
			const expectedResourceUrl = new URL(
				`${Buffer.from(uid, 'utf8').toString('base64url')}.ics`,
				calendarUrl,
			).href;
			expect(created).toEqual({
				calendarUrl,
				resourceUrl: expectedResourceUrl,
				etag: expect.any(String),
				uid,
				summary: 'Žluťoučký Create 🚀',
				description: '',
				location: 'Praha; Brno',
				url: 'urn:example:radicale:create',
				start: '2040-02-03T10:00:00Z',
				end: '2040-02-03T11:00:00Z',
			});
			const readBack = await getCalendarEventByResourceUrl(
				transport(run),
				calendarUrl,
				validateAbsoluteHttpUrl(expectedResourceUrl),
			);
			expect(readBack.event).toMatchObject({
				uid,
				summary: 'Žluťoučký Create 🚀',
				description: '',
				location: 'Praha; Brno',
				url: 'urn:example:radicale:create',
			});

			await expect(
				createCalendarEvent(
					inspectedTransport,
					{
						calendarUrl,
						uid,
						start: new Date('2040-02-03T12:00:00Z'),
						end: new Date('2040-02-03T13:00:00Z'),
						summary: 'Forbidden collision overwrite',
					},
					() => new Date('2040-02-01T00:00:01Z'),
				),
			).rejects.toMatchObject({
				code: CalendarEventMutationFailureCode.CREATE_CONFLICT,
			});
			const retained = await authenticatedFetch(run, expectedResourceUrl);
			expect(retained.status).toBe(200);
			const retainedBody = await retained.text();
			expect(retainedBody).toContain('SUMMARY:Žluťoučký Create 🚀');
			expect(retainedBody).not.toContain('Forbidden collision overwrite');
			const putRequests = requests.mock.calls
				.map(([options]) => options as N8nCalDavRequestOptions)
				.filter((options) => options.method === 'PUT');
			expect(putRequests).toHaveLength(2);
			for (const request of putRequests) {
				expect(request).toMatchObject({
					url: expectedResourceUrl,
					headers: {
						'If-None-Match': '*',
						'Content-Type': 'text/calendar; charset=utf-8',
					},
				});
			}
		} finally {
			await teardownRun(run);
		}
	});

	it('maps read-only denial and rejects invalid input before any live request', async () => {
		const run = await startRun();
		try {
			const calendarUrl = await createSyntheticCalendar(
				run,
				'node-create-read-only',
				'Create Read Only',
			);
			await harness.makeCalendarReadOnly(run, calendarUrl);
			const readOnly = eventCreateContext(run, {
				calendar: { __rl: true, mode: 'url', value: calendarUrl },
				uid: `read-only-${run.identity}`,
				start: '2040-02-03T10:00:00Z',
				end: '2040-02-03T11:00:00Z',
				summary: 'Must not be created',
				additionalFields: {},
			});
			const readOnlyError = await captureNodeExecutionError(readOnly.context);
			expect(readOnlyError).toMatchObject({
				message: 'Event Create is not authorized for the selected calendar.',
				context: { itemIndex: 0, httpCode: '403' },
			});
			const putRequests = readOnly.requests.mock.calls
				.map(([options]) => options as N8nCalDavRequestOptions)
				.filter((options) => options.method === 'PUT');
			expect(putRequests).toHaveLength(1);
			expect(putRequests[0]?.headers?.['If-None-Match']).toBe('*');

			const invalid = eventCreateContext(run, {
				calendar: { __rl: true, mode: 'url', value: calendarUrl },
				uid: `invalid-${run.identity}`,
				start: '2040-02-03T10:00:00',
				end: '2040-02-03T11:00:00Z',
				summary: 'Invalid timezone-less input',
				additionalFields: {},
			});
			const invalidError = await captureNodeExecutionError(invalid.context);
			expect(invalidError).toMatchObject({
				message: 'Start must be a valid date and time with whole-second precision.',
				context: { itemIndex: 0 },
			});
			expect(invalid.requests).not.toHaveBeenCalled();
		} finally {
			await teardownRun(run);
		}
	});
});

describe('Radicale conditional calendar-event mutations', () => {
	it('accepts a serialized basic event through the mutation service and returns its read model', async () => {
		const run = await startRun();
		try {
			const calendarUrl = validateAbsoluteHttpUrl(
				await createSyntheticCalendar(run, 'serializer-create', 'Serializer Create'),
			);
			const resourceUrl = validateAbsoluteHttpUrl(
				new URL('serialized-basic-event.ics', calendarUrl).href,
			);
			const uid = syntheticEventUid(run);
			const calendarData = serializeBasicUtcEvent({
				uid,
				dtstamp: new Date('2040-01-01T00:00:00.000Z'),
				start: new Date('2040-01-02T10:00:00.000Z'),
				end: new Date('2040-01-02T10:30:00.000Z'),
				summary: 'Radicale serializer, oracle; 🚀',
				description: 'Created through the merged mutation service',
				location: 'Integration calendar',
				url: 'urn:example:calendar:radicale-oracle',
			});
			const liveTransport = transport(run);
			const request = vi.fn(liveTransport.request.bind(liveTransport));
			const inspectedTransport: CalDavTransport = { ...liveTransport, request };

			const created = await createCalendarEventResource(
				inspectedTransport,
				calendarUrl,
				resourceUrl,
				calendarData,
			);
			expect(created.statusCode).toBe(201);
			expect(request).toHaveBeenCalledTimes(1);
			expect(request.mock.calls[0][0]).toMatchObject({
				method: 'PUT',
				url: resourceUrl,
				headers: {
					'If-None-Match': '*',
					'Content-Type': 'text/calendar; charset=utf-8',
				},
				body: calendarData,
			});

			const readBack = await getCalendarEventByResourceUrl(
				liveTransport,
				calendarUrl,
				created.resourceUrl,
			);
			expect(readBack.event).toEqual({
				calendarUrl,
				resourceUrl: created.resourceUrl,
				etag: expect.any(String),
				uid,
				summary: 'Radicale serializer, oracle; 🚀',
				description: 'Created through the merged mutation service',
				location: 'Integration calendar',
				url: 'urn:example:calendar:radicale-oracle',
				start: '2040-01-02T10:00:00Z',
				end: '2040-01-02T10:30:00Z',
			});
			expect(readBack.context.resource.originalIcs).not.toMatch(
				/(^|\r?\n)(?:X-|BEGIN:VTIMEZONE|BEGIN:VALARM)/,
			);
		} finally {
			await teardownRun(run);
		}
	});

	it('creates once with If-None-Match and preserves the resource on create collision', async () => {
		const run = await startRun();
		try {
			const calendarUrl = validateAbsoluteHttpUrl(
				await createSyntheticCalendar(run, 'mutation-create', 'Mutation Create'),
			);
			const resourceUrl = validateAbsoluteHttpUrl(
				new URL('conditional-create.ics', calendarUrl).href,
			);
			const originalBody = mutationEvent(run, 'Original conditional create');
			const conflictingBody = mutationEvent(run, 'Forbidden collision overwrite');
			const liveTransport = transport(run);
			const request = vi.fn(liveTransport.request.bind(liveTransport));
			const inspectedTransport: CalDavTransport = { ...liveTransport, request };

			const created = await createCalendarEventResource(
				inspectedTransport,
				calendarUrl,
				resourceUrl,
				originalBody,
			);
			expect(created.statusCode).toBe(201);
			expect(created.resourceUrl).toBe(resourceUrl);
			await expect(
				createCalendarEventResource(inspectedTransport, calendarUrl, resourceUrl, conflictingBody),
			).rejects.toMatchObject({
				name: 'CalDavCalendarEventMutationError',
				code: CalendarEventMutationFailureCode.CREATE_CONFLICT,
				message: 'A calendar event already exists at the requested resource URL.',
			});
			expect(request).toHaveBeenCalledTimes(2);
			for (const [input] of request.mock.calls) {
				expect(input).toMatchObject({
					method: 'PUT',
					url: resourceUrl,
					headers: {
						'If-None-Match': '*',
						'Content-Type': 'text/calendar; charset=utf-8',
					},
				});
			}
			expect(request.mock.calls[0][0].body).toBe(originalBody);
			expect(request.mock.calls[1][0].body).toBe(conflictingBody);

			const stored = await authenticatedFetch(run, resourceUrl);
			const storedBody = await stored.text();
			expect(stored.status).toBe(200);
			expect(storedBody).toContain('SUMMARY:Original conditional create');
			expect(storedBody).not.toContain('Forbidden collision overwrite');
		} finally {
			await teardownRun(run);
		}
	});

	it('rejects supplied stale Update and Delete ETags and leaves the newer resource unchanged', async () => {
		const run = await startRun();
		try {
			const calendarUrl = validateAbsoluteHttpUrl(
				await createSyntheticCalendar(run, 'mutation-stale', 'Mutation Stale'),
			);
			const resourceUrl = validateAbsoluteHttpUrl(new URL('stale-etag.ics', calendarUrl).href);
			const initialBody = mutationEvent(run, 'Initial mutation version');
			await createCalendarEventResource(transport(run), calendarUrl, resourceUrl, initialBody);
			const initialRead = await authenticatedFetch(run, resourceUrl);
			const staleEtag = initialRead.headers.get('etag');
			expect(staleEtag).not.toBeNull();
			if (staleEtag === null) {
				throw new Error('Radicale did not return the mutation oracle ETag.');
			}

			const newerBody = mutationEvent(run, 'Newer concurrent version');
			const concurrentWrite = await authenticatedFetch(run, resourceUrl, 'PUT', newerBody);
			expect([201, 204]).toContain(concurrentWrite.status);
			const liveTransport = transport(run);
			const request = vi.fn(liveTransport.request.bind(liveTransport));
			const inspectedTransport: CalDavTransport = { ...liveTransport, request };

			await expect(
				updateCalendarEventResource(
					inspectedTransport,
					calendarUrl,
					resourceUrl,
					mutationEvent(run, 'Forbidden stale update'),
					staleEtag,
				),
			).rejects.toMatchObject({
				code: CalendarEventMutationFailureCode.CONCURRENCY_CONFLICT,
			});
			await expect(
				deleteCalendarEventResource(inspectedTransport, calendarUrl, resourceUrl, staleEtag),
			).rejects.toMatchObject({
				code: CalendarEventMutationFailureCode.CONCURRENCY_CONFLICT,
			});
			expect(request).toHaveBeenCalledTimes(2);
			expect(request.mock.calls.map(([input]) => input.method)).toEqual(['PUT', 'DELETE']);
			expect(request.mock.calls.map(([input]) => input.headers?.['If-Match'])).toEqual([
				staleEtag,
				staleEtag,
			]);

			const stored = await authenticatedFetch(run, resourceUrl);
			const storedBody = await stored.text();
			expect(stored.status).toBe(200);
			expect(storedBody).toContain('SUMMARY:Newer concurrent version');
			expect(storedBody).not.toContain('Forbidden stale update');
		} finally {
			await teardownRun(run);
		}
	});

	it('maps a GET-to-Update race to one terminal conflict with the exact fetched ETag', async () => {
		const run = await startRun();
		try {
			const calendarUrl = validateAbsoluteHttpUrl(
				await createSyntheticCalendar(run, 'mutation-race', 'Mutation Race'),
			);
			const resourceUrl = validateAbsoluteHttpUrl(new URL('race.ics', calendarUrl).href);
			await createCalendarEventResource(
				transport(run),
				calendarUrl,
				resourceUrl,
				mutationEvent(run, 'Before race'),
			);
			const racedBody = mutationEvent(run, 'Race winner');
			const liveTransport = transport(run);
			let fetchedEtag: string | undefined;
			const request = vi.fn(async (input: CalDavTransportRequest) => {
				const result = await liveTransport.request(input);
				if (input.method === 'GET') {
					fetchedEtag = result.etag;
					const raceWrite = await authenticatedFetch(run, resourceUrl, 'PUT', racedBody);
					expect([201, 204]).toContain(raceWrite.status);
				}
				return result;
			});
			const racingTransport: CalDavTransport = { ...liveTransport, request };

			await expect(
				updateCalendarEventResource(
					racingTransport,
					calendarUrl,
					resourceUrl,
					mutationEvent(run, 'Forbidden race loser'),
				),
			).rejects.toMatchObject({
				code: CalendarEventMutationFailureCode.CONCURRENCY_CONFLICT,
				message: 'The calendar event changed before the mutation could be applied.',
			});
			expect(fetchedEtag).toBeTypeOf('string');
			expect(request).toHaveBeenCalledTimes(2);
			expect(request.mock.calls.map(([input]) => input.method)).toEqual(['GET', 'PUT']);
			expect(request.mock.calls[1][0].headers?.['If-Match']).toBe(fetchedEtag);

			const stored = await authenticatedFetch(run, resourceUrl);
			const storedBody = await stored.text();
			expect(stored.status).toBe(200);
			expect(storedBody).toContain('SUMMARY:Race winner');
			expect(storedBody).not.toContain('Forbidden race loser');
		} finally {
			await teardownRun(run);
		}
	});
});

describe('Radicale conditional Event Update operation', () => {
	// Radicale serves these direct event URLs without a configurable canonical redirect. The
	// coordinator unit oracle covers a canonical read-back URL while these live cases require the
	// exact current ETag from Radicale's mandatory authoritative GET.
	it('updates a direct Resource URL with the exact fetched and authoritative ETags while preserving unknown data', async () => {
		const run = await startRun();
		try {
			const eventUrl = await createSyntheticEvent(run, 'node-update-resource-url');
			const calendarUrl = new URL('./', eventUrl).href;
			const preservationBody = mutationEvent(run, 'Before preservation update').replace(
				'SUMMARY:Before preservation update',
				[
					'DESCRIPTION:Preserved description',
					'X-UNKNOWN;X-PARAM=MiXeD:opaque-preservation-oracle',
					'SUMMARY:Before preservation update',
				].join('\r\n'),
			);
			expect((await authenticatedFetch(run, eventUrl, 'PUT', preservationBody)).status).toBe(204);
			const before = await authenticatedFetch(run, eventUrl);
			const fetchedEtag = before.headers.get('etag');
			expect(fetchedEtag).not.toBeNull();
			const { context, requests, responses } = eventUpdateContext(run, {
				calendar: { __rl: true, mode: 'url', value: calendarUrl },
				identifierMode: 'resourceUrl',
				resourceUrl: eventUrl,
				etag: '',
				fieldsToUpdate: {
					summary: 'After preservation update',
					description: { change: { action: 'set', value: '' } },
				},
			});

			const [output] = await new CalDav().execute.call(context);
			const authoritativeEtag = responses[2]?.headers.etag;
			expect(authoritativeEtag).toBeTypeOf('string');

			expect(output).toEqual([
				{
					json: {
						calendarUrl,
						resourceUrl: eventUrl,
						etag: authoritativeEtag,
						uid: syntheticEventUid(run),
						summary: 'After preservation update',
						description: '',
						start: '2040-01-02T10:00:00Z',
						end: '2040-01-02T10:30:00Z',
					},
					pairedItem: { item: 0 },
				},
			]);
			const observed = requests.mock.calls.map(([options]) => options as N8nCalDavRequestOptions);
			expect(observed.map((options) => options.method)).toEqual(['GET', 'PUT', 'GET']);
			expect(observed[1]).toMatchObject({
				url: eventUrl,
				headers: {
					'If-Match': fetchedEtag,
					'Content-Type': 'text/calendar; charset=utf-8',
				},
			});
			const stored = await authenticatedFetch(run, eventUrl);
			const storedBody = await stored.text();
			expect(storedBody).toContain('SUMMARY:After preservation update');
			expect(storedBody).toContain('X-UNKNOWN;X-PARAM=MiXeD:opaque-preservation-oracle');
		} finally {
			await teardownRun(run);
		}
	});

	it('updates by UID with an exact caller ETag through REPORT -> PUT -> GET', async () => {
		const run = await startRun();
		try {
			const eventUrl = await createSyntheticEvent(run, 'node-update-uid');
			const calendarUrl = new URL('./', eventUrl).href;
			const before = await authenticatedFetch(run, eventUrl);
			const suppliedEtag = before.headers.get('etag');
			expect(suppliedEtag).not.toBeNull();
			const { context, requests, responses } = eventUpdateContext(run, {
				calendar: { __rl: true, mode: 'list', value: calendarUrl },
				identifierMode: 'uid',
				uid: syntheticEventUid(run),
				etag: suppliedEtag,
				fieldsToUpdate: { location: { change: { action: 'set', value: 'UID oracle' } } },
			});

			const [output] = await new CalDav().execute.call(context);
			const authoritativeEtag = responses[2]?.headers.etag;
			expect(authoritativeEtag).toBeTypeOf('string');
			expect(output[0]).toMatchObject({
				json: {
					calendarUrl,
					resourceUrl: eventUrl,
					etag: authoritativeEtag,
					uid: syntheticEventUid(run),
					location: 'UID oracle',
				},
				pairedItem: { item: 0 },
			});
			const observed = requests.mock.calls.map(([options]) => options as N8nCalDavRequestOptions);
			expect(observed.map((options) => options.method)).toEqual(['REPORT', 'PUT', 'GET']);
			expect(observed[1].headers?.['If-Match']).toBe(suppliedEtag);
			expect(observed[1].url).toBe(eventUrl);
		} finally {
			await teardownRun(run);
		}
	});

	it('maps a stale caller ETag to one terminal conflict with no read-back', async () => {
		const run = await startRun();
		try {
			const eventUrl = await createSyntheticEvent(run, 'node-update-stale');
			const calendarUrl = new URL('./', eventUrl).href;
			const staleEtag = (await authenticatedFetch(run, eventUrl)).headers.get('etag');
			expect(staleEtag).not.toBeNull();
			const newerBody = mutationEvent(run, 'Newer resource retained after stale Update');
			expect((await authenticatedFetch(run, eventUrl, 'PUT', newerBody)).status).toBe(204);
			const { context, requests } = eventUpdateContext(run, {
				calendar: { __rl: true, mode: 'url', value: calendarUrl },
				identifierMode: 'resourceUrl',
				resourceUrl: eventUrl,
				etag: staleEtag,
				fieldsToUpdate: { summary: 'Forbidden stale Update' },
			});

			const error = await captureNodeExecutionError(context);
			expect(error).toMatchObject({
				message: 'The calendar event changed before the mutation could be applied.',
				context: { itemIndex: 0 },
			});
			const observed = requests.mock.calls.map(([options]) => options as N8nCalDavRequestOptions);
			expect(observed.map((options) => options.method)).toEqual(['GET', 'PUT']);
			expect(observed[1].headers?.['If-Match']).toBe(staleEtag);
			const retained = await authenticatedFetch(run, eventUrl);
			expect(await retained.text()).toContain('SUMMARY:Newer resource retained after stale Update');
		} finally {
			await teardownRun(run);
		}
	});

	it('maps a preservation-read-to-PUT race using the exact fetched ETag and no retry', async () => {
		const run = await startRun();
		try {
			const eventUrl = await createSyntheticEvent(run, 'node-update-race');
			const calendarUrl = new URL('./', eventUrl).href;
			const winnerBody = mutationEvent(run, 'Race winner retained');
			let raced = false;
			const { context, requests, responses } = eventUpdateContext(
				run,
				{
					calendar: { __rl: true, mode: 'url', value: calendarUrl },
					identifierMode: 'resourceUrl',
					resourceUrl: eventUrl,
					etag: '',
					fieldsToUpdate: { summary: 'Forbidden race loser' },
				},
				async (options) => {
					if (options.method !== 'PUT' || raced) return;
					raced = true;
					expect((await authenticatedFetch(run, eventUrl, 'PUT', winnerBody)).status).toBe(204);
				},
			);

			const error = await captureNodeExecutionError(context);
			expect(error.message).toBe(
				'The calendar event changed before the mutation could be applied.',
			);
			const observed = requests.mock.calls.map(([options]) => options as N8nCalDavRequestOptions);
			expect(observed.map((options) => options.method)).toEqual(['GET', 'PUT']);
			const preservationReadEtag = responses[0]?.headers.etag;
			expect(preservationReadEtag).toBeTypeOf('string');
			expect(observed[1].headers?.['If-Match']).toBe(preservationReadEtag);
			const retained = await authenticatedFetch(run, eventUrl);
			expect(await retained.text()).toContain('SUMMARY:Race winner retained');
		} finally {
			await teardownRun(run);
		}
	});

	it('maps read-only denial, performs no read-back, and retains the event', async () => {
		const run = await startRun();
		try {
			const eventUrl = await createSyntheticEvent(run, 'node-update-read-only');
			const calendarUrl = new URL('./', eventUrl).href;
			await harness.makeCalendarReadOnly(run, calendarUrl);
			const { context, requests } = eventUpdateContext(run, {
				calendar: { __rl: true, mode: 'url', value: calendarUrl },
				identifierMode: 'resourceUrl',
				resourceUrl: eventUrl,
				etag: '',
				fieldsToUpdate: { summary: 'Forbidden read-only Update' },
			});

			const error = await captureNodeExecutionError(context);
			expect(error).toMatchObject({
				message: 'Event Update is not authorized.',
				context: { itemIndex: 0, httpCode: '403' },
			});
			const observed = requests.mock.calls.map(([options]) => options as N8nCalDavRequestOptions);
			expect(observed.map((options) => options.method)).toEqual(['GET', 'PUT']);
			expect(observed[1].headers?.['If-Match']).toEqual(expect.any(String));
			expect((await authenticatedFetch(run, eventUrl)).status).toBe(200);
		} finally {
			await teardownRun(run);
		}
	});
});

describe('Radicale Event Delete node operation', () => {
	it('deletes an exact Resource URL with the resolved ETag and returns stable metadata', async () => {
		const run = await startRun();
		try {
			const eventUrl = await createSyntheticEvent(run, 'node-delete-resource-url');
			const calendarUrl = new URL('./', eventUrl).href;
			const { context, requests } = eventDeleteContext(run, {
				calendar: { __rl: true, mode: 'url', value: calendarUrl },
				identifierMode: 'resourceUrl',
				resourceUrl: eventUrl,
			});

			await expect(new CalDav().execute.call(context)).resolves.toEqual([
				[
					{
						json: {
							calendarUrl,
							resourceUrl: eventUrl,
							uid: syntheticEventUid(run),
							deleted: true,
						},
						pairedItem: { item: 0 },
					},
				],
			]);

			const deleteRequests = requests.mock.calls
				.map(([options]) => options as N8nCalDavRequestOptions)
				.filter((options) => options.method === 'DELETE');
			expect(deleteRequests).toHaveLength(1);
			expect(deleteRequests[0]).toMatchObject({
				url: eventUrl,
				headers: { 'If-Match': expect.any(String) },
			});
			expect(deleteRequests[0].body).toBeUndefined();
			expect((await authenticatedFetch(run, eventUrl)).status).toBe(404);
		} finally {
			await teardownRun(run);
		}
	});

	it('resolves and deletes by UID within only the selected calendar', async () => {
		const run = await startRun();
		try {
			const eventUrl = await createSyntheticEvent(run, 'node-delete-uid');
			const calendarUrl = new URL('./', eventUrl).href;
			const { context, requests } = eventDeleteContext(run, {
				calendar: { __rl: true, mode: 'list', value: calendarUrl },
				identifierMode: 'uid',
				uid: syntheticEventUid(run),
			});

			await expect(new CalDav().execute.call(context)).resolves.toEqual([
				[
					{
						json: {
							calendarUrl,
							resourceUrl: eventUrl,
							uid: syntheticEventUid(run),
							deleted: true,
						},
						pairedItem: { item: 0 },
					},
				],
			]);

			const observed = requests.mock.calls.map(([options]) => options as N8nCalDavRequestOptions);
			expect(observed.filter((options) => options.method === 'REPORT')).toHaveLength(1);
			const deleteRequests = observed.filter((options) => options.method === 'DELETE');
			expect(deleteRequests).toHaveLength(1);
			expect(deleteRequests[0]).toMatchObject({
				url: eventUrl,
				headers: { 'If-Match': expect.any(String) },
			});
			expect(deleteRequests[0].body).toBeUndefined();
			expect((await authenticatedFetch(run, eventUrl)).status).toBe(404);
		} finally {
			await teardownRun(run);
		}
	});

	it('maps a supplied stale ETag to one terminal conflict and retains the newer resource', async () => {
		const run = await startRun();
		try {
			const eventUrl = await createSyntheticEvent(run, 'node-delete-stale');
			const calendarUrl = new URL('./', eventUrl).href;
			const before = await authenticatedFetch(run, eventUrl);
			const staleEtag = before.headers.get('etag');
			expect(staleEtag).not.toBeNull();
			const newerBody = mutationEvent(run, 'Newer resource retained after stale delete');
			expect((await authenticatedFetch(run, eventUrl, 'PUT', newerBody)).status).toBe(204);
			const { context, requests } = eventDeleteContext(run, {
				calendar: { __rl: true, mode: 'url', value: calendarUrl },
				identifierMode: 'resourceUrl',
				resourceUrl: eventUrl,
				etag: staleEtag,
			});

			const error = await captureNodeExecutionError(context);
			expect(error).toMatchObject({
				message: 'The calendar event changed before the mutation could be applied.',
				context: { itemIndex: 0 },
			});
			const deleteRequests = requests.mock.calls
				.map(([options]) => options as N8nCalDavRequestOptions)
				.filter((options) => options.method === 'DELETE');
			expect(deleteRequests).toHaveLength(1);
			expect(deleteRequests[0].headers?.['If-Match']).toBe(staleEtag);
			expect(deleteRequests[0].body).toBeUndefined();
			const retained = await authenticatedFetch(run, eventUrl);
			expect(retained.status).toBe(200);
			expect(await retained.text()).toContain('SUMMARY:Newer resource retained after stale delete');
		} finally {
			await teardownRun(run);
		}
	});

	it('reports a missing event without issuing DELETE', async () => {
		const run = await startRun();
		try {
			const existingUrl = await createSyntheticEvent(run, 'node-delete-missing');
			const calendarUrl = new URL('./', existingUrl).href;
			const missingUrl = new URL('missing-event.ics', calendarUrl).href;
			const { context, requests } = eventDeleteContext(run, {
				calendar: { __rl: true, mode: 'url', value: calendarUrl },
				identifierMode: 'resourceUrl',
				resourceUrl: missingUrl,
			});

			const error = await captureNodeExecutionError(context);
			expect(error).toMatchObject({
				message: 'The calendar event was not found.',
				context: { itemIndex: 0, httpCode: '404' },
			});
			expect(
				requests.mock.calls
					.map(([options]) => options as N8nCalDavRequestOptions)
					.filter((options) => options.method === 'DELETE'),
			).toEqual([]);
			expect((await authenticatedFetch(run, existingUrl)).status).toBe(200);
		} finally {
			await teardownRun(run);
		}
	});

	it('maps read-only denial and retains the resource while every DELETE stays conditional', async () => {
		const run = await startRun();
		try {
			const eventUrl = await createSyntheticEvent(run, 'node-delete-read-only');
			const calendarUrl = new URL('./', eventUrl).href;
			await harness.makeCalendarReadOnly(run, calendarUrl);
			const { context, requests } = eventDeleteContext(run, {
				calendar: { __rl: true, mode: 'url', value: calendarUrl },
				identifierMode: 'resourceUrl',
				resourceUrl: eventUrl,
			});

			const error = await captureNodeExecutionError(context);
			expect(error).toMatchObject({
				message: 'Event Delete is not authorized.',
				context: { itemIndex: 0, httpCode: '403' },
			});
			const deleteRequests = requests.mock.calls
				.map(([options]) => options as N8nCalDavRequestOptions)
				.filter((options) => options.method === 'DELETE');
			expect(deleteRequests).toHaveLength(1);
			expect(deleteRequests[0].headers?.['If-Match']).toEqual(expect.any(String));
			expect(deleteRequests[0].body).toBeUndefined();
			expect((await authenticatedFetch(run, eventUrl)).status).toBe(200);
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
