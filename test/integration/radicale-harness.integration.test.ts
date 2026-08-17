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
import { updateCalendarEvent } from '../../nodes/CalDav/events/update';
import type { CalendarEventUpdateInput } from '../../nodes/CalDav/events/update';
import { upsertCalendarEvent } from '../../nodes/CalDav/events/upsert';
import {
	CalendarEventUidResolutionFailureCode,
	resolveCalendarEventByUid,
} from '../../nodes/CalDav/events/resolveByUid';
import { serializeBasicUtcEvent } from '../../nodes/CalDav/icalendar/serializer';
import type { CalendarEventPatch } from '../../nodes/CalDav/icalendar/patcher';
import { canonicalizeIanaTimeZone } from '../../nodes/CalDav/icalendar/timeZones';
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
import {
	PRAGUE_VTIMEZONE,
	timedEventIcs,
} from '../unit/fixtures/time-zones/synthetic-time-zone-fixtures';

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
	readonly timeMode: 'timed';
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
	readonly timeMode: 'timed';
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
		timeMode: parameters.timeMode,
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
		timeMode: parameters.timeMode,
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

	it('round-trips a synthetic embedded IANA event through Radicale with authoritative local and instant fields', async () => {
		const run = await startRun();
		try {
			const collectionUrl = await createSyntheticCalendar(run, 'iana-time-zone', 'IANA Time Zone');
			const resourceUrl = new URL('iana-event.ics', collectionUrl).href;
			const source = timedEventIcs(
				'DTSTART;TZID=Europe/Prague:20400715T100000',
				'DTEND;TZID=Europe/Prague:20400715T110000',
				[PRAGUE_VTIMEZONE],
			);
			const put = await authenticatedFetch(run, resourceUrl, 'PUT', source);
			expect([201, 204]).toContain(put.status);

			const result = await getCalendarEventByResourceUrl(
				transport(run),
				validateAbsoluteHttpUrl(collectionUrl),
				validateAbsoluteHttpUrl(resourceUrl),
			);

			expect(result.event).toMatchObject({
				uid: 'synthetic-time-zone-event',
				timeMode: 'timed',
				accessMode: 'editable',
				start: '2040-07-15T07:00:00Z',
				end: '2040-07-15T08:00:00Z',
				timeZoneMode: 'iana',
				timeZone: 'Europe/Prague',
				startLocal: '2040-07-15T10:00:00',
				endLocal: '2040-07-15T11:00:00',
			});
			expect(JSON.stringify(result)).not.toContain(run.password);
			expect(JSON.stringify(result)).not.toContain(basicAuthorization(run));
		} finally {
			await teardownRun(run);
		}
	});

	it('creates, queries, updates bounds, changes zones, and reads generated finite fallback definitions', async () => {
		const run = await startRun();
		try {
			const calendarUrl = validateAbsoluteHttpUrl(
				await createSyntheticCalendar(run, 'generated-vtimezone', 'Generated VTIMEZONE'),
			);
			const liveTransport = transport(run);
			const request = vi.fn(liveTransport.request.bind(liveTransport));
			const inspectedTransport: CalDavTransport = { ...liveTransport, request };
			const resolveReference = vi.fn().mockRejectedValue(new Error('synthetic unavailable'));
			const timeZoneContext = { resolveReference };
			const uid = `generated-vtimezone-${run.identity}@example.test`;
			const prague = canonicalizeIanaTimeZone('Europe/Prague');

			const created = await createCalendarEvent(
				inspectedTransport,
				{
					calendarUrl,
					uid,
					timeMode: 'timed',
					start: new Date('2040-07-15T08:00:00Z'),
					end: new Date('2040-07-15T09:00:00Z'),
					timeZone: { timeZoneMode: 'iana', timeZone: prague },
					summary: 'Generated Prague fallback',
				},
				() => new Date('2040-01-01T00:00:00Z'),
				timeZoneContext,
			);
			expect(created).toMatchObject({
				uid,
				timeMode: 'timed',
				accessMode: 'editable',
				start: '2040-07-15T08:00:00Z',
				end: '2040-07-15T09:00:00Z',
				timeZoneMode: 'iana',
				timeZone: 'Europe/Prague',
				startLocal: '2040-07-15T10:00:00',
				endLocal: '2040-07-15T11:00:00',
			});
			expect(resolveReference).toHaveBeenCalledOnce();
			expect(request.mock.calls.map(([input]) => (input as CalDavTransportRequest).method)).toEqual(
				['PUT', 'GET'],
			);
			let storedBody = await (await authenticatedFetch(run, created.resourceUrl)).text();
			expect(storedBody.match(/BEGIN:VTIMEZONE/g)).toHaveLength(1);
			expect(storedBody).toContain('TZID:Europe/Prague');
			expect(storedBody).toContain('DTSTART;TZID=Europe/Prague:20400715T100000');
			expect(storedBody).not.toMatch(/(?:RRULE|TZNAME|TZURL|X-LIC-LOCATION):/);

			const query = await queryCalendarEventsByTimeRange(inspectedTransport, calendarUrl, {
				start: new Date('2040-07-15T07:59:59Z'),
				end: new Date('2040-07-15T09:00:01Z'),
			});
			expect(query.map(({ event }) => event.uid)).toContain(uid);
			expect(query.find(({ event }) => event.uid === uid)?.event).toMatchObject({
				timeZone: 'Europe/Prague',
				start: '2040-07-15T08:00:00Z',
				end: '2040-07-15T09:00:00Z',
			});

			request.mockClear();
			const boundsUpdated = await updateCalendarEvent(
				inspectedTransport,
				{
					calendarUrl,
					identifier: { kind: 'resourceUrl', resourceUrl: created.resourceUrl },
					etag: created.etag,
					patch: {
						timeMode: 'timed',
						start: { kind: 'set', value: new Date('2040-07-15T08:30:00Z') },
						end: { kind: 'set', value: new Date('2040-07-15T09:30:00Z') },
					} as CalendarEventPatch,
				},
				() => new Date('2040-01-02T00:00:00Z'),
				timeZoneContext,
			);
			expect(boundsUpdated).toMatchObject({
				timeZone: 'Europe/Prague',
				start: '2040-07-15T08:30:00Z',
				end: '2040-07-15T09:30:00Z',
			});
			expect(resolveReference).toHaveBeenCalledTimes(1);
			expect(request.mock.calls.map(([input]) => (input as CalDavTransportRequest).method)).toEqual(
				['GET', 'PUT', 'GET'],
			);

			request.mockClear();
			const newYork = canonicalizeIanaTimeZone('America/New_York');
			const zoneChanged = await updateCalendarEvent(
				inspectedTransport,
				{
					calendarUrl,
					identifier: { kind: 'resourceUrl', resourceUrl: created.resourceUrl },
					etag: boundsUpdated.etag,
					patch: {
						timeMode: 'timed',
						timeZone: {
							kind: 'set',
							value: { timeZoneMode: 'iana', timeZone: newYork },
						},
						start: { kind: 'set', value: new Date('2040-07-15T08:30:00Z') },
						end: { kind: 'set', value: new Date('2040-07-15T09:30:00Z') },
					} as CalendarEventPatch,
				},
				() => new Date('2040-01-03T00:00:00Z'),
				timeZoneContext,
			);
			expect(zoneChanged).toMatchObject({
				timeZone: 'America/New_York',
				start: '2040-07-15T08:30:00Z',
				end: '2040-07-15T09:30:00Z',
				startLocal: '2040-07-15T04:30:00',
				endLocal: '2040-07-15T05:30:00',
			});
			expect(resolveReference).toHaveBeenCalledTimes(2);
			expect(request.mock.calls.map(([input]) => (input as CalDavTransportRequest).method)).toEqual(
				['GET', 'PUT', 'GET'],
			);

			storedBody = await (await authenticatedFetch(run, created.resourceUrl)).text();
			expect(storedBody.match(/BEGIN:VTIMEZONE/g)).toHaveLength(1);
			expect(storedBody).toContain('TZID:America/New_York');
			expect(storedBody).toContain('DTSTART;TZID=America/New_York:20400715T043000');
			expect(storedBody).not.toContain('TZID:Europe/Prague');
			expect(JSON.stringify(zoneChanged)).not.toMatch(/synthetic unavailable|BEGIN:VTIMEZONE/);
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
				timeMode: 'timed',
				accessMode: 'editable',
				start: '2040-01-02T10:00:00Z',
				end: '2040-01-02T10:30:00Z',
				timeZoneMode: 'utc',
				startLocal: '2040-01-02T10:00:00',
				endLocal: '2040-01-02T10:30:00',
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
	it('generates a canonical UUID for blank node UID and reads back one matching VEVENT identity', async () => {
		const run = await startRun();
		try {
			const calendarUrl = await createSyntheticCalendar(
				run,
				'node-create-generated-uid',
				'Create Generated UID',
			);
			const execution = eventCreateContext(run, {
				calendar: { __rl: true, mode: 'url', value: calendarUrl },
				uid: '',
				timeMode: 'timed',
				start: '2040-02-03T10:00:00Z',
				end: '2040-02-03T11:00:00Z',
				summary: 'Generated UID round trip',
				additionalFields: {},
			});

			const [output] = await new CalDav().execute.call(execution.context);
			expect(output).toHaveLength(1);
			const created = output[0]?.json;
			const uid = created?.uid;
			expect(uid).toEqual(
				expect.stringMatching(
					/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
				),
			);
			if (typeof uid !== 'string') throw new Error('Generated UID output is missing.');
			const expectedResourceUrl = new URL(
				`${Buffer.from(uid, 'utf8').toString('base64url')}.ics`,
				calendarUrl,
			).href;
			expect(created).toMatchObject({
				calendarUrl,
				resourceUrl: expectedResourceUrl,
				uid,
				summary: 'Generated UID round trip',
			});
			expect(output[0]).toMatchObject({ pairedItem: { item: 0 } });

			const readBack = await getCalendarEventByResourceUrl(
				transport(run),
				validateAbsoluteHttpUrl(calendarUrl),
				validateAbsoluteHttpUrl(expectedResourceUrl),
			);
			expect(readBack.event.uid).toBe(uid);
			expect(readBack.event.resourceUrl).toBe(expectedResourceUrl);

			const stored = await authenticatedFetch(run, expectedResourceUrl);
			expect(stored.status).toBe(200);
			const unfoldedLines = (await stored.text()).replace(/\r?\n[ \t]/gu, '').split(/\r?\n/u);
			expect(unfoldedLines.filter((line) => line === `UID:${uid}`)).toHaveLength(1);
		} finally {
			await teardownRun(run);
		}
	});

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
				timeMode: 'timed',
				accessMode: 'editable',
				start: '2040-02-03T10:00:00Z',
				end: '2040-02-03T11:00:00Z',
				timeZoneMode: 'utc',
				startLocal: '2040-02-03T10:00:00',
				endLocal: '2040-02-03T11:00:00',
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
				timeMode: 'timed',
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
				timeMode: 'timed',
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
				timeMode: 'timed',
				accessMode: 'editable',
				start: '2040-01-02T10:00:00Z',
				end: '2040-01-02T10:30:00Z',
				timeZoneMode: 'utc',
				startLocal: '2040-01-02T10:00:00',
				endLocal: '2040-01-02T10:30:00',
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
				timeMode: 'timed',
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
						timeMode: 'timed',
						accessMode: 'editable',
						start: '2040-01-02T10:00:00Z',
						end: '2040-01-02T10:30:00Z',
						timeZoneMode: 'utc',
						startLocal: '2040-01-02T10:00:00',
						endLocal: '2040-01-02T10:30:00',
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
			const seededBody = mutationEvent(run, 'Before UID update').replace(
				'SUMMARY:Before UID update',
				['LOCATION:Before UID oracle', 'SUMMARY:Before UID update'].join('\r\n'),
			);
			expect((await authenticatedFetch(run, eventUrl, 'PUT', seededBody)).status).toBe(204);
			const before = await authenticatedFetch(run, eventUrl);
			const suppliedEtag = before.headers.get('etag');
			expect(suppliedEtag).not.toBeNull();
			const { context, requests, responses } = eventUpdateContext(run, {
				calendar: { __rl: true, mode: 'list', value: calendarUrl },
				identifierMode: 'uid',
				uid: syntheticEventUid(run),
				etag: suppliedEtag,
				timeMode: 'timed',
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
				timeMode: 'timed',
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
					timeMode: 'timed',
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
				timeMode: 'timed',
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

describe('Radicale issue #41 all-day event interoperability', () => {
	it('round-trips one-day leap and multi-day year-boundary values and enforces half-open queries', async () => {
		const run = await startRun();
		try {
			const calendarUrl = validateAbsoluteHttpUrl(
				await createSyntheticCalendar(run, 'all-day-boundaries', 'All-Day Boundaries'),
			);
			const adapter = requestAdapter(run);
			const requests = vi.fn(
				async (options: N8nCalDavRequestOptions) => await adapter.request(options),
			);
			const liveTransport = createCalDavTransport(run.endpoint, { request: requests });
			const leapUid = `all-day-leap-${run.identity}@example.test`;
			const yearUid = `all-day-year-${run.identity}@example.test`;

			const leap = await createCalendarEvent(
				liveTransport,
				{
					calendarUrl,
					uid: leapUid,
					timeMode: 'allDay',
					startDate: '2040-02-29',
					endDate: '2040-03-01',
					summary: 'Leap-day exclusive end',
				} as never,
				() => new Date('2040-02-01T00:00:00.999Z'),
			);
			const year = await createCalendarEvent(
				liveTransport,
				{
					calendarUrl,
					uid: yearUid,
					timeMode: 'allDay',
					startDate: '2040-12-31',
					endDate: '2041-01-03',
					summary: 'Year-boundary exclusive end',
				} as never,
				() => new Date('2040-02-01T00:00:01Z'),
			);

			expect(leap).toMatchObject({
				timeMode: 'allDay',
				accessMode: 'editable',
				startDate: '2040-02-29',
				endDate: '2040-03-01',
				etag: expect.any(String),
			});
			expect(year).toMatchObject({
				timeMode: 'allDay',
				accessMode: 'editable',
				startDate: '2040-12-31',
				endDate: '2041-01-03',
			});
			const createMethods = requests.mock.calls.map(
				([options]) => (options as N8nCalDavRequestOptions).method,
			);
			expect(createMethods).toEqual(['PUT', 'GET', 'PUT', 'GET']);

			for (const created of [leap, year]) {
				const raw = await authenticatedFetch(run, created.resourceUrl);
				const rawBody = await raw.text();
				expect(rawBody).toContain(`DTSTART;VALUE=DATE:${created.startDate.replaceAll('-', '')}`);
				expect(rawBody).toContain(`DTEND;VALUE=DATE:${created.endDate.replaceAll('-', '')}`);
				expect(rawBody).not.toMatch(/DT(?:START|END)[^\r\n]*(?:TZID|T\d{6}|Z)/);
				const readBack = await getCalendarEventByResourceUrl(
					transport(run),
					calendarUrl,
					created.resourceUrl,
				);
				expect(readBack.event).toMatchObject({
					timeMode: 'allDay',
					startDate: created.startDate,
					endDate: created.endDate,
				});
			}

			const beforeLeap = await queryCalendarEventsByTimeRange(transport(run), calendarUrl, {
				start: new Date('2040-02-28T00:00:00Z'),
				end: new Date('2040-02-29T00:00:00Z'),
			});
			const exactLeap = await queryCalendarEventsByTimeRange(transport(run), calendarUrl, {
				start: new Date('2040-02-29T00:00:00Z'),
				end: new Date('2040-03-01T00:00:00Z'),
			});
			const afterLeap = await queryCalendarEventsByTimeRange(transport(run), calendarUrl, {
				start: new Date('2040-03-01T00:00:00Z'),
				end: new Date('2040-03-02T00:00:00Z'),
			});
			expect(beforeLeap.map(({ event }) => event.uid)).not.toContain(leapUid);
			expect(exactLeap.map(({ event }) => event.uid)).toContain(leapUid);
			expect(afterLeap.map(({ event }) => event.uid)).not.toContain(leapUid);
		} finally {
			await teardownRun(run);
		}
	});

	it('converts all-day to timed and back while preserving conditional concurrency', async () => {
		const run = await startRun();
		try {
			const calendarUrl = validateAbsoluteHttpUrl(
				await createSyntheticCalendar(run, 'all-day-conversion', 'All-Day Conversion'),
			);
			const adapter = requestAdapter(run);
			const requests = vi.fn(
				async (options: N8nCalDavRequestOptions) => await adapter.request(options),
			);
			const liveTransport = createCalDavTransport(run.endpoint, { request: requests });
			const uid = `all-day-conversion-${run.identity}@example.test`;
			const created = await createCalendarEvent(
				liveTransport,
				{
					calendarUrl,
					uid,
					timeMode: 'allDay',
					startDate: '2040-12-31',
					endDate: '2041-01-03',
					summary: 'Convert me',
				} as never,
				() => new Date('2040-12-01T00:00:00Z'),
			);

			requests.mockClear();
			const toTimedPatch = {
				timeMode: 'timed',
				start: { kind: 'set', value: new Date('2040-12-31T10:00:00Z') },
				end: { kind: 'set', value: new Date('2040-12-31T11:00:00Z') },
			} as unknown as CalendarEventPatch;
			const timed = await updateCalendarEvent(
				liveTransport,
				{
					calendarUrl,
					identifier: { kind: 'resourceUrl', resourceUrl: created.resourceUrl },
					etag: created.etag,
					patch: toTimedPatch,
				} satisfies CalendarEventUpdateInput,
				() => new Date('2040-12-02T00:00:00.999Z'),
			);
			expect(timed).toMatchObject({
				timeMode: 'timed',
				accessMode: 'editable',
				start: '2040-12-31T10:00:00Z',
				end: '2040-12-31T11:00:00Z',
			});
			expect(
				requests.mock.calls.map(([options]) => (options as N8nCalDavRequestOptions).method),
			).toEqual(['GET', 'PUT', 'GET']);

			requests.mockClear();
			const backToAllDay = await updateCalendarEvent(
				liveTransport,
				{
					calendarUrl,
					identifier: { kind: 'resourceUrl', resourceUrl: created.resourceUrl },
					etag: timed.etag,
					patch: {
						timeMode: 'allDay',
						startDate: { kind: 'set', value: '2040-12-31' },
						endDate: { kind: 'set', value: '2041-01-03' },
					} as unknown as CalendarEventPatch,
				},
				() => new Date('2040-12-03T00:00:00Z'),
			);
			expect(backToAllDay).toMatchObject({
				timeMode: 'allDay',
				startDate: '2040-12-31',
				endDate: '2041-01-03',
			});
			const stored = await authenticatedFetch(run, created.resourceUrl);
			const storedBody = await stored.text();
			expect(storedBody).toContain('DTSTART;VALUE=DATE:20401231');
			expect(storedBody).toContain('DTEND;VALUE=DATE:20410103');

			requests.mockClear();
			await expect(
				updateCalendarEvent(
					liveTransport,
					{
						calendarUrl,
						identifier: { kind: 'resourceUrl', resourceUrl: created.resourceUrl },
						etag: timed.etag,
						patch: {
							timeMode: 'allDay',
							summary: { kind: 'set', value: 'Forbidden stale update' },
						} as unknown as CalendarEventPatch,
					},
					() => new Date('2040-12-04T00:00:00Z'),
				),
			).rejects.toMatchObject({ code: CalendarEventMutationFailureCode.CONCURRENCY_CONFLICT });
			expect(
				requests.mock.calls.map(([options]) => (options as N8nCalDavRequestOptions).method),
			).toEqual(['GET', 'PUT']);
			expect(await (await authenticatedFetch(run, created.resourceUrl)).text()).not.toContain(
				'Forbidden stale update',
			);
		} finally {
			await teardownRun(run);
		}
	});
});

describe('Radicale deterministic Event Upsert', () => {
	it('creates then updates one supplied UID with preservation-first conditional requests and no DELETE', async () => {
		const run = await startRun();
		try {
			const calendarUrl = validateAbsoluteHttpUrl(
				await createSyntheticCalendar(run, 'event-upsert-supplied', 'Event Upsert Supplied'),
			);
			const uid = `upsert-supplied-${run.identity}@example.test`;
			const expectedResourceUrl = new URL(
				`${Buffer.from(uid, 'utf8').toString('base64url')}.ics`,
				calendarUrl,
			).href;
			const liveTransport = transport(run);
			const request = vi.fn(liveTransport.request.bind(liveTransport));
			const inspectedTransport: CalDavTransport = { ...liveTransport, request };
			const clock = vi
				.fn()
				.mockReturnValueOnce(new Date('2040-03-01T00:00:00Z'))
				.mockReturnValueOnce(new Date('2040-03-01T00:00:01Z'));
			const uidFactory = vi.fn(() => '00000000-0000-4000-8000-000000000001');

			const created = await upsertCalendarEvent(
				inspectedTransport,
				{
					calendarUrl,
					uid,
					timeMode: 'timed',
					start: new Date('2040-03-02T10:00:00Z'),
					end: new Date('2040-03-02T11:00:00Z'),
					summary: 'Upsert first version',
					description: { kind: 'set', value: 'Preserve this description' },
					location: { kind: 'set', value: 'Remove this location' },
					url: { kind: 'set', value: 'urn:example:upsert:first' },
				},
				{ clock, uidFactory },
			);
			expect(created).toMatchObject({
				action: 'create',
				event: { resourceUrl: expectedResourceUrl, uid, summary: 'Upsert first version' },
			});
			expect(uidFactory).not.toHaveBeenCalled();

			const seeded = await authenticatedFetch(run, expectedResourceUrl);
			const seededBody = (await seeded.text()).replace(
				'END:VEVENT',
				'X-UNKNOWN;X-SOURCE=MiXeD:preserved-by-upsert\r\nEND:VEVENT',
			);
			expect((await authenticatedFetch(run, expectedResourceUrl, 'PUT', seededBody)).status).toBe(
				204,
			);
			const beforeUpdate = await authenticatedFetch(run, expectedResourceUrl);
			const beforeEtag = beforeUpdate.headers.get('etag');
			expect(beforeEtag).not.toBeNull();
			const updateStart = request.mock.calls.length;

			const updated = await upsertCalendarEvent(
				inspectedTransport,
				{
					calendarUrl,
					uid,
					timeMode: 'timed',
					start: new Date('2040-03-02T10:00:00Z'),
					end: new Date('2040-03-02T11:00:00Z'),
					summary: 'Upsert second version',
					location: { kind: 'remove' },
					url: { kind: 'set', value: 'urn:example:upsert:second' },
				},
				{ clock, uidFactory },
			);
			expect(updated).toMatchObject({
				action: 'update',
				event: {
					resourceUrl: expectedResourceUrl,
					uid,
					summary: 'Upsert second version',
					description: 'Preserve this description',
					url: 'urn:example:upsert:second',
				},
			});
			expect(updated.event).not.toHaveProperty('location');

			const updateRequests = request.mock.calls
				.slice(updateStart)
				.map(([input]) => input as CalDavTransportRequest);
			expect(updateRequests.map(({ method }) => method)).toEqual(['REPORT', 'PUT', 'GET']);
			expect(updateRequests[1]).toMatchObject({
				url: expectedResourceUrl,
				headers: { 'If-Match': beforeEtag },
			});
			const allRequests = request.mock.calls.map(([input]) => input as CalDavTransportRequest);
			expect(allRequests.filter(({ method }) => method === 'DELETE')).toHaveLength(0);
			expect(allRequests.filter(({ method }) => method === 'REPORT')).toHaveLength(2);
			const stored = await authenticatedFetch(run, expectedResourceUrl);
			const storedBody = await stored.text();
			expect(storedBody).toContain('X-UNKNOWN;X-SOURCE=MiXeD:preserved-by-upsert');
			expect(storedBody).toContain('SUMMARY:Upsert second version');
			expect(storedBody).not.toContain('LOCATION:Remove this location');
		} finally {
			await teardownRun(run);
		}
	});

	it('creates two omitted-UID resources through conditional PUTs for timed UTC and all-day input', async () => {
		const run = await startRun();
		try {
			const calendarUrl = validateAbsoluteHttpUrl(
				await createSyntheticCalendar(run, 'event-upsert-generated', 'Event Upsert Generated'),
			);
			const generated = [
				'00000000-0000-4000-8000-000000000011',
				'00000000-0000-4000-8000-000000000012',
			];
			const uidFactory = vi
				.fn()
				.mockReturnValueOnce(generated[0])
				.mockReturnValueOnce(generated[1]);
			const clock = vi.fn(() => new Date('2040-03-01T00:00:00Z'));
			const liveTransport = transport(run);
			const request = vi.fn(liveTransport.request.bind(liveTransport));
			const inspectedTransport: CalDavTransport = { ...liveTransport, request };

			const first = await upsertCalendarEvent(
				inspectedTransport,
				{
					calendarUrl,
					timeMode: 'timed',
					start: new Date('2040-03-02T10:00:00Z'),
					end: new Date('2040-03-02T11:00:00Z'),
					summary: 'Generated UTC Upsert',
				},
				{ clock, uidFactory },
			);
			const second = await upsertCalendarEvent(
				inspectedTransport,
				{
					calendarUrl,
					timeMode: 'allDay',
					startDate: '2040-02-28',
					endDate: '2040-03-01',
					summary: 'Generated all-day Upsert',
				},
				{ clock, uidFactory },
			);

			expect([first.action, second.action]).toEqual(['create', 'create']);
			expect([first.event.uid, second.event.uid]).toEqual(generated);
			expect(new Set([first.event.resourceUrl, second.event.resourceUrl]).size).toBe(2);
			expect(uidFactory).toHaveBeenCalledTimes(2);
			expect(clock).toHaveBeenCalledTimes(2);
			const observed = request.mock.calls.map(([input]) => input as CalDavTransportRequest);
			expect(observed.filter(({ method }) => method === 'REPORT')).toHaveLength(0);
			expect(observed.filter(({ method }) => method === 'DELETE')).toHaveLength(0);
			const puts = observed.filter(({ method }) => method === 'PUT');
			expect(puts).toHaveLength(2);
			for (const put of puts) expect(put.headers?.['If-None-Match']).toBe('*');
			expect(puts[1]?.body).toContain('DTSTART;VALUE=DATE:20400228');
			expect(puts[1]?.body).toContain('DTEND;VALUE=DATE:20400301');
		} finally {
			await teardownRun(run);
		}
	});

	it('maps a REPORT-to-PUT stale race to one conflict and leaves the winner intact', async () => {
		const run = await startRun();
		try {
			const calendarUrl = validateAbsoluteHttpUrl(
				await createSyntheticCalendar(run, 'event-upsert-race', 'Event Upsert Race'),
			);
			const uid = `upsert-race-${run.identity}@example.test`;
			const deps = {
				clock: vi.fn(() => new Date('2040-03-01T00:00:00Z')),
				uidFactory: vi.fn(() => '00000000-0000-4000-8000-000000000013'),
			};
			const liveTransport = transport(run);
			const created = await upsertCalendarEvent(
				liveTransport,
				{
					calendarUrl,
					uid,
					timeMode: 'timed',
					start: new Date('2040-03-02T10:00:00Z'),
					end: new Date('2040-03-02T11:00:00Z'),
					summary: 'Before Upsert race',
				},
				deps,
			);
			const resourceUrl = created.event.resourceUrl;
			const before = await authenticatedFetch(run, resourceUrl);
			const winnerBody = (await before.text()).replace(
				'SUMMARY:Before Upsert race',
				'SUMMARY:Upsert race winner',
			);
			let raced = false;
			const request = vi.fn(async (input: CalDavTransportRequest) => {
				if (input.method === 'PUT' && !raced) {
					raced = true;
					expect((await authenticatedFetch(run, resourceUrl, 'PUT', winnerBody)).status).toBe(204);
				}
				return await liveTransport.request(input);
			});
			const racingTransport: CalDavTransport = { ...liveTransport, request };

			await expect(
				upsertCalendarEvent(
					racingTransport,
					{
						calendarUrl,
						uid,
						timeMode: 'timed',
						start: new Date('2040-03-02T10:00:00Z'),
						end: new Date('2040-03-02T11:00:00Z'),
						summary: 'Forbidden Upsert race loser',
					},
					deps,
				),
			).rejects.toMatchObject({
				code: 'UPSERT_CONCURRENCY_CONFLICT',
				message: 'The calendar changed while Event Upsert was in progress.',
			});
			const observed = request.mock.calls.map(([input]) => input as CalDavTransportRequest);
			expect(observed.map(({ method }) => method)).toEqual(['REPORT', 'PUT']);
			expect(observed.filter(({ method }) => method === 'DELETE')).toHaveLength(0);
			const retained = await authenticatedFetch(run, resourceUrl);
			const retainedBody = await retained.text();
			expect(retainedBody).toContain('SUMMARY:Upsert race winner');
			expect(retainedBody).not.toContain('Forbidden Upsert race loser');
		} finally {
			await teardownRun(run);
		}
	});

	it('uses one conditional Create attempt on a read-only calendar and never DELETEs', async () => {
		const run = await startRun();
		try {
			const calendarUrl = validateAbsoluteHttpUrl(
				await createSyntheticCalendar(run, 'event-upsert-read-only', 'Event Upsert Read Only'),
			);
			await harness.makeCalendarReadOnly(run, calendarUrl);
			const liveTransport = transport(run);
			const request = vi.fn(liveTransport.request.bind(liveTransport));
			const inspectedTransport: CalDavTransport = { ...liveTransport, request };

			await expect(
				upsertCalendarEvent(
					inspectedTransport,
					{
						calendarUrl,
						timeMode: 'timed',
						start: new Date('2040-03-02T10:00:00Z'),
						end: new Date('2040-03-02T11:00:00Z'),
						summary: 'Must not be created',
					},
					{
						clock: () => new Date('2040-03-01T00:00:00Z'),
						uidFactory: () => '00000000-0000-4000-8000-000000000014',
					},
				),
			).rejects.toBeInstanceOf(CalDavAuthorizationError);
			const observed = request.mock.calls.map(([input]) => input as CalDavTransportRequest);
			expect(observed.map(({ method }) => method)).toEqual(['PUT']);
			expect(observed[0]?.headers?.['If-None-Match']).toBe('*');
			expect(observed.filter(({ method }) => method === 'DELETE')).toHaveLength(0);
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
