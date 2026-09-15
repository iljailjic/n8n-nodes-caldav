// The live adapter intentionally adapts iCloud HTTP streams to the production transport.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { Readable } from 'node:stream';
// UUIDs scope mutable resources to this one test run.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { randomUUID } from 'node:crypto';
/* eslint-disable @n8n/community-nodes/no-restricted-globals, @n8n/community-nodes/require-node-api-error -- The opt-in test suite reads only its own environment and reports stable public-safe codes. */

import type { IExecuteFunctions, ILoadOptionsFunctions, INode } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import { CalDav } from '../../nodes/CalDav/CalDav.node';
import { discoverCalendarCollections } from '../../nodes/CalDav/discovery/calendarCollections';
import { discoverCalendarHome } from '../../nodes/CalDav/discovery/calendarHome';
import {
	CalDavCapabilityValidationError,
	validateCalDavCapability,
} from '../../nodes/CalDav/discovery/capabilities';
import {
	discoverCurrentUserPrincipal,
	CurrentUserPrincipalDiscoveryKind,
} from '../../nodes/CalDav/discovery/currentUserPrincipal';
import { defaultCalDavProviderRegistry } from '../../nodes/CalDav/providers/registry';
import {
	CalDavMethod,
	createCalDavTransport,
	type CalDavRequestHelperAdapter,
	type N8nCalDavRequestOptions,
} from '../../nodes/CalDav/transport/http';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';

import {
	assertE2e,
	canonicalizeIcloudE2eUrl,
	IcloudE2eErrorCode,
	IcloudE2eHarnessError,
	readIcloudE2eInput,
	selectExactCalendar,
	serializeEvidence,
} from './support/icloud-e2e-harness';

const CONTRACT_REVISION = 'issue-56-contract-r1' as const;
const READ_ONLY_METHODS = new Set<CalDavMethod>([CalDavMethod.OPTIONS, CalDavMethod.PROPFIND]);
const LIVE_METHODS = new Set<CalDavMethod>([
	CalDavMethod.OPTIONS,
	CalDavMethod.PROPFIND,
	CalDavMethod.REPORT,
	CalDavMethod.GET,
	CalDavMethod.PUT,
	CalDavMethod.DELETE,
]);

function liveInputOrUndefined(): ReturnType<typeof readIcloudE2eInput> | undefined {
	return process.env.CALDAV_ICLOUD_E2E_OPT_IN === '1' ? readIcloudE2eInput(process.env) : undefined;
}

function liveRequestAdapter(
	input: ReturnType<typeof readIcloudE2eInput>,
	observedMethods: CalDavMethod[],
): CalDavRequestHelperAdapter {
	return {
		async request(options: N8nCalDavRequestOptions) {
			assertE2e(LIVE_METHODS.has(options.method));
			observedMethods.push(options.method);
			const response = await fetch(options.url, {
				method: options.method,
				headers: {
					...options.headers,
					Authorization: `Basic ${Buffer.from(`${input.username}:${input.appPassword}`, 'utf8').toString('base64')}`,
				},
				...(options.body === undefined ? {} : { body: options.body }),
				redirect: 'manual',
				signal: AbortSignal.timeout(30_000),
			});
			const headers: Record<string, string> = {};
			response.headers.forEach((value, name) => {
				headers[name] = value;
			});
			return {
				statusCode: response.status,
				headers,
				body: Readable.from(Buffer.from(await response.arrayBuffer())),
			};
		},
	};
}

function liveNode(): INode {
	return {
		id: 'icloud-read-only-e2e',
		name: 'iCloud read-only E2E',
		type: 'CUSTOM.calDav',
		typeVersion: 1,
		position: [0, 0],
		parameters: {},
	};
}

function liveNodeContext(
	input: ReturnType<typeof readIcloudE2eInput>,
	adapter: CalDavRequestHelperAdapter,
	parameters: Readonly<Record<string, unknown>>,
	continueOnFail = false,
): IExecuteFunctions & ILoadOptionsFunctions {
	return {
		getInputData: () => [{ json: {} }],
		getNodeParameter: (name: string) => parameters[name],
		getCredentials: async () => ({
			serverUrl: input.serverUrl,
			username: input.username,
			password: input.appPassword,
		}),
		continueOnFail: () => continueOnFail,
		getNode: liveNode,
		helpers: {
			httpRequestWithAuthentication: async (_credentialType, options) =>
				await adapter.request(options as N8nCalDavRequestOptions),
		},
	} as unknown as IExecuteFunctions & ILoadOptionsFunctions;
}

interface RunOwnedEvent {
	readonly uid: string;
	readonly resourceUrl: string;
	readonly ics: string;
}

function runOwnedEvent(
	calendarUrl: string,
	runId: string,
	label: string,
	start: string,
	end: string,
): RunOwnedEvent {
	const uid = `codex-e2e-56-${runId}-${label}`;
	return {
		uid,
		resourceUrl: new URL(`${encodeURIComponent(uid)}.ics`, calendarUrl).toString(),
		ics: [
			'BEGIN:VCALENDAR',
			'VERSION:2.0',
			'PRODID:-//CalDAV E2E//Issue 56//EN',
			'BEGIN:VEVENT',
			`UID:${uid}`,
			'DTSTAMP:20400101T000000Z',
			`DTSTART:${start}`,
			`DTEND:${end}`,
			'END:VEVENT',
			'END:VCALENDAR',
			'',
		].join('\r\n'),
	};
}

function runOwnedRecurringEvent(calendarUrl: string, runId: string): RunOwnedEvent {
	const uid = `codex-e2e-56-${runId}-recurring`;
	return {
		uid,
		resourceUrl: new URL(`${encodeURIComponent(uid)}.ics`, calendarUrl).toString(),
		ics: [
			'BEGIN:VCALENDAR',
			'VERSION:2.0',
			'PRODID:-//CalDAV E2E//Issue 56//EN',
			'BEGIN:VEVENT',
			`UID:${uid}`,
			'DTSTAMP:20400101T000000Z',
			'DTSTART:20400415T120000Z',
			'DTEND:20400415T123000Z',
			'RRULE:FREQ=DAILY;COUNT=2',
			'END:VEVENT',
			'BEGIN:VEVENT',
			`UID:${uid}`,
			'RECURRENCE-ID:20400416T120000Z',
			'DTSTAMP:20400101T000000Z',
			'DTSTART:20400416T130000Z',
			'DTEND:20400416T133000Z',
			'END:VEVENT',
			'END:VCALENDAR',
			'',
		].join('\r\n'),
	};
}

async function seedRunOwnedEvent(
	adapter: CalDavRequestHelperAdapter,
	event: RunOwnedEvent,
): Promise<void> {
	const response = await adapter.request({
		method: CalDavMethod.PUT,
		url: event.resourceUrl,
		headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'If-None-Match': '*' },
		body: event.ics,
	});
	assertE2e(response.statusCode === 201 || response.statusCode === 204);
}

async function deleteRunOwnedEvent(
	adapter: CalDavRequestHelperAdapter,
	resourceUrl: string,
): Promise<void> {
	const response = await adapter.request({
		method: CalDavMethod.DELETE,
		url: resourceUrl,
		headers: {},
	});
	assertE2e(response.statusCode === 204 || response.statusCode === 404);
}

function eventOutput(value: unknown): Readonly<Record<string, unknown>> {
	assertE2e(typeof value === 'object' && value !== null && !Array.isArray(value));
	return value as Readonly<Record<string, unknown>>;
}

function assertPrivateRawIcs(output: Readonly<Record<string, unknown>>, uid: string): void {
	// The node returns raw ICS for interoperability, but this suite must never serialize it.
	assertE2e(typeof output.rawIcs === 'string' && output.rawIcs.includes(`UID:${uid}`));
}

describe('iCloud E2E discovery contract (fictional synthetic regressions)', () => {
	it('requires opt-in HTTPS input and canonicalizes identity without retaining secrets', () => {
		expect(() => readIcloudE2eInput({})).toThrow(IcloudE2eHarnessError);
		expect(() =>
			readIcloudE2eInput({
				CALDAV_ICLOUD_E2E_OPT_IN: '1',
				CALDAV_ICLOUD_E2E_SERVER_URL: 'https://user:secret@calendar.example.test/',
				CALDAV_ICLOUD_E2E_USERNAME: 'fictional-user',
				CALDAV_ICLOUD_E2E_APP_PASSWORD: 'fictional-password',
				CALDAV_ICLOUD_E2E_CALENDAR_DISPLAY_NAME: 'Fictional Calendar',
			}),
		).toThrow(IcloudE2eHarnessError);
		expect(canonicalizeIcloudE2eUrl('https://CALENDAR.example.test:443/discovery/../dav/')).toBe(
			'https://calendar.example.test/dav/',
		);
	});

	it('selects exactly one fictional calendar by canonical URL identity', () => {
		expect(
			selectExactCalendar(
				[
					{
						displayName: 'Fictional Calendar',
						url: 'https://CALENDAR.example.test:443/dav/calendars/',
					},
				],
				'Fictional Calendar',
			),
		).toEqual({
			displayName: 'Fictional Calendar',
			url: 'https://calendar.example.test/dav/calendars/',
		});
		let notFound: unknown;
		try {
			selectExactCalendar([], 'Fictional Calendar');
		} catch (error) {
			notFound = error;
		}
		expect(notFound).toMatchObject({ code: IcloudE2eErrorCode.CALENDAR_NOT_FOUND });
		let ambiguous: unknown;
		try {
			selectExactCalendar(
				[
					{ displayName: 'Fictional Calendar', url: 'https://calendar.example.test/a/' },
					{ displayName: 'Fictional Calendar', url: 'https://calendar.example.test/b/' },
				],
				'Fictional Calendar',
			);
		} catch (error) {
			ambiguous = error;
		}
		expect(ambiguous).toMatchObject({ code: IcloudE2eErrorCode.CALENDAR_AMBIGUOUS });
	});

	it('emits only privacy-safe, discovery-only evidence', () => {
		const evidence = serializeEvidence({
			schemaVersion: 'icloud-e2e-evidence/v3',
			mode: 'fake',
			sourceRevision: CONTRACT_REVISION,
			outcome: 'passed',
			scenarios: [
				'capability',
				'redirect-principal-home',
				'calendar-list',
				'resource-locator-get-contract',
			],
			requestMethods: ['OPTIONS', 'PROPFIND'],
			errorCodes: [],
		});
		expect(evidence).toMatch(/^ICLOUD_E2E_EVIDENCE /);
		expect(evidence).not.toContain('fictional-password');
		expect(evidence).not.toContain('calendar.example.test');
		expect(evidence).not.toContain('GET');
		expect(evidence).not.toContain('PUT');
		expect(evidence).not.toContain('DELETE');
	});

	it('keeps the established event Get resource-locator contract synthetic and out of live I/O', () => {
		const properties = new CalDav().description.properties;
		const calendar = properties.find((property) => property.name === 'calendar');
		const eventGet = properties.find(
			(property) =>
				property.name === 'operation' && property.displayOptions?.show?.resource?.includes('event'),
		);
		expect(calendar).toMatchObject({
			type: 'resourceLocator',
			default: { mode: 'url', value: '' },
		});
		expect(eventGet?.options).toContainEqual(
			expect.objectContaining({ name: 'Get', value: 'get' }),
		);
		expect(READ_ONLY_METHODS.has(CalDavMethod.GET)).toBe(false);
	});
});

const liveInput = liveInputOrUndefined();

describe.runIf(liveInput !== undefined)('iCloud E2E live read-only discovery', () => {
	it('validates capability, redirect-safe principal/home discovery, and the selected calendar list', async () => {
		const input = liveInput!;
		const observedMethods: CalDavMethod[] = [];
		const adapter = liveRequestAdapter(input, observedMethods);
		const transport = createCalDavTransport(input.serverUrl, adapter);
		const scenarios: string[] = [];
		const errorCodes: IcloudE2eErrorCode[] = [];
		let outcome: 'passed' | 'failed' = 'failed';

		try {
			await validateCalDavCapability(transport);
			scenarios.push('capability');

			const principal = await discoverCurrentUserPrincipal(transport);
			assertE2e(principal.kind === CurrentUserPrincipalDiscoveryKind.AUTHENTICATED);
			assertE2e(canonicalizeIcloudE2eUrl(principal.principalUrl) === principal.principalUrl);
			const home = await discoverCalendarHome(transport, principal.principalUrl);
			assertE2e(canonicalizeIcloudE2eUrl(home.calendarHomeUrl) === home.calendarHomeUrl);
			scenarios.push('redirect-principal-home');

			const provider = defaultCalDavProviderRegistry.select(
				validateAbsoluteHttpUrl(transport.serverUrl),
			);
			const calendars = await discoverCalendarCollections(
				transport,
				home.calendarHomeUrl,
				provider,
			);
			const selected = selectExactCalendar(
				calendars.map((calendar) => ({
					displayName: calendar.displayName ?? '',
					url: calendar.url,
				})),
				input.calendarDisplayName,
			);
			assertE2e(canonicalizeIcloudE2eUrl(selected.url) === selected.url);
			scenarios.push('calendar-list');

			const node = new CalDav();
			const [many] = await node.execute.call(
				liveNodeContext(input, adapter, {
					resource: 'calendar',
					operation: 'getMany',
					returnAll: true,
				}),
			);
			assertE2e(many.filter((item) => item.json.url === selected.url).length === 1);
			scenarios.push('calendar-get-many');

			const [byUrl] = await node.execute.call(
				liveNodeContext(input, adapter, {
					resource: 'calendar',
					operation: 'get',
					calendar: { __rl: true, mode: 'url', value: selected.url },
				}),
			);
			assertE2e(byUrl.length === 1 && byUrl[0]?.json.url === selected.url);
			scenarios.push('calendar-get-url');

			const searchCalendars = node.methods.listSearch.searchCalendars;
			const search = await searchCalendars.call(
				liveNodeContext(input, adapter, {}),
				input.calendarDisplayName,
			);
			const locatorMatches = search.results.filter((result) => result.value === selected.url);
			assertE2e(locatorMatches.length === 1);
			const [byLocator] = await node.execute.call(
				liveNodeContext(input, adapter, {
					resource: 'calendar',
					operation: 'get',
					calendar: { __rl: true, mode: 'list', value: locatorMatches[0]!.value },
				}),
			);
			assertE2e(byLocator.length === 1 && byLocator[0]?.json.url === selected.url);
			scenarios.push('resource-locator-search-get');
			outcome = 'passed';
		} catch (error) {
			errorCodes.push(
				error instanceof IcloudE2eHarnessError
					? error.code
					: error instanceof CalDavCapabilityValidationError
						? IcloudE2eErrorCode.CAPABILITY_FAILED
						: IcloudE2eErrorCode.DISCOVERY_FAILED,
			);
			throw error;
		} finally {
			assertE2e(observedMethods.every((method) => READ_ONLY_METHODS.has(method)));
			// eslint-disable-next-line no-console -- The manual workflow log receives only aggregate, privacy-safe evidence.
			console.info(
				serializeEvidence({
					schemaVersion: 'icloud-e2e-evidence/v3',
					mode: 'live',
					sourceRevision: CONTRACT_REVISION,
					outcome,
					scenarios,
					requestMethods: [...new Set(observedMethods)],
					errorCodes,
				}),
			);
		}
	});
});

describe.runIf(liveInput !== undefined)('iCloud E2E live event lookup and range queries', () => {
	it('uses only run-owned resources for identity, [S,E), sorting, limits, missing, and recurrence checks', async () => {
		const input = liveInput!;
		const observedMethods: CalDavMethod[] = [];
		const adapter = liveRequestAdapter(input, observedMethods);
		const transport = createCalDavTransport(input.serverUrl, adapter);
		const scenarios: string[] = [];
		const errorCodes: IcloudE2eErrorCode[] = [];
		const runId = randomUUID();
		const resources: RunOwnedEvent[] = [];
		let outcome: 'passed' | 'failed' = 'failed';
		let operationFailed = false;

		try {
			const principal = await discoverCurrentUserPrincipal(transport);
			assertE2e(principal.kind === CurrentUserPrincipalDiscoveryKind.AUTHENTICATED);
			const home = await discoverCalendarHome(transport, principal.principalUrl);
			const provider = defaultCalDavProviderRegistry.select(
				validateAbsoluteHttpUrl(transport.serverUrl),
			);
			const calendars = await discoverCalendarCollections(
				transport,
				home.calendarHomeUrl,
				provider,
			);
			const selected = selectExactCalendar(
				calendars.map((calendar) => ({
					displayName: calendar.displayName ?? '',
					url: calendar.url,
				})),
				input.calendarDisplayName,
			);

			resources.push(
				runOwnedEvent(selected.url, runId, 'wholly-before', '20400415T090000Z', '20400415T093000Z'),
				runOwnedEvent(selected.url, runId, 'spans-start', '20400415T093000Z', '20400415T103000Z'),
				runOwnedEvent(selected.url, runId, 'at-start', '20400415T100000Z', '20400415T103000Z'),
				runOwnedEvent(selected.url, runId, 'inside', '20400415T110000Z', '20400415T113000Z'),
				runOwnedRecurringEvent(selected.url, runId),
				runOwnedEvent(selected.url, runId, 'at-end', '20400415T140000Z', '20400415T143000Z'),
				runOwnedEvent(selected.url, runId, 'wholly-after', '20400415T143000Z', '20400415T150000Z'),
				runOwnedEvent(selected.url, runId, 'ends-at-start', '20400415T093000Z', '20400415T100000Z'),
			);
			for (const resource of resources) await seedRunOwnedEvent(adapter, resource);
			scenarios.push('run-owned-seed');

			const node = new CalDav();
			const calendar = { __rl: true, mode: 'url', value: selected.url };
			const [byUrl] = await node.execute.call(
				liveNodeContext(input, adapter, {
					resource: 'event',
					operation: 'get',
					calendar,
					identifierMode: 'resourceUrl',
					resourceUrl: resources[2]!.resourceUrl,
				}),
			);
			const byUrlEvent = eventOutput(byUrl[0]?.json);
			assertE2e(
				byUrlEvent.resourceUrl === resources[2]!.resourceUrl &&
					byUrlEvent.uid === resources[2]!.uid,
			);
			assertE2e(typeof byUrlEvent.etag === 'string' && byUrlEvent.etag.length > 0);
			assertPrivateRawIcs(byUrlEvent, resources[2]!.uid);
			const [byUid] = await node.execute.call(
				liveNodeContext(input, adapter, {
					resource: 'event',
					operation: 'get',
					calendar,
					identifierMode: 'uid',
					uid: resources[2]!.uid,
				}),
			);
			const byUidEvent = eventOutput(byUid[0]?.json);
			assertE2e(
				byUidEvent.resourceUrl === resources[2]!.resourceUrl && byUidEvent.etag === byUrlEvent.etag,
			);
			assertPrivateRawIcs(byUidEvent, resources[2]!.uid);
			scenarios.push('resource-url-uid-etag-identity');

			const query = {
				resource: 'event',
				operation: 'getMany',
				calendar,
				start: '2040-04-15T10:00:00Z',
				end: '2040-04-15T14:00:00Z',
			};
			const [limited] = await node.execute.call(
				liveNodeContext(input, adapter, { ...query, returnAll: false, limit: 2 }),
			);
			const limitedEvents = limited.map((item) => eventOutput(item.json));
			assertE2e(limitedEvents.length === 2);
			assertE2e(
				limitedEvents.map((event) => event.uid).join(',') ===
					[resources[1]!.uid, resources[2]!.uid].join(','),
			);
			for (const event of limitedEvents) assertPrivateRawIcs(event, event.uid as string);
			scenarios.push('half-open-boundaries-deterministic-limit');

			const [all] = await node.execute.call(
				liveNodeContext(input, adapter, { ...query, returnAll: true }),
			);
			const allEvents = all.map((item) => eventOutput(item.json));
			assertE2e(allEvents.length === 4);
			assertE2e(
				allEvents.map((event) => event.uid).join(',') ===
					[resources[1]!.uid, resources[2]!.uid, resources[3]!.uid, resources[4]!.uid].join(','),
			);
			assertE2e(!allEvents.some((event) => event.uid === resources[7]!.uid));
			assertPrivateRawIcs(allEvents[3]!, resources[4]!.uid);
			assertE2e(
				typeof allEvents[3]!.rawIcs === 'string' &&
					allEvents[3]!.rawIcs.includes('RRULE:FREQ=DAILY;COUNT=2') &&
					allEvents[3]!.rawIcs.includes('RECURRENCE-ID:20400416T120000Z'),
			);
			scenarios.push('return-all-one-recurring-resource');

			const [empty] = await node.execute.call(
				liveNodeContext(input, adapter, {
					...query,
					start: '2040-04-17T10:00:00Z',
					end: '2040-04-17T11:00:00Z',
					returnAll: true,
				}),
			);
			assertE2e(empty.length === 0);
			const [missing] = await node.execute.call(
				liveNodeContext(
					input,
					adapter,
					{
						resource: 'event',
						operation: 'get',
						calendar,
						identifierMode: 'uid',
						uid: `codex-e2e-56-${runId}-missing`,
					},
					true,
				),
			);
			assertE2e(missing.length === 1 && typeof missing[0]?.json.error === 'string');
			const [missingByUrl] = await node.execute.call(
				liveNodeContext(
					input,
					adapter,
					{
						resource: 'event',
						operation: 'get',
						calendar,
						identifierMode: 'resourceUrl',
						resourceUrl: new URL(`codex-e2e-56-${runId}-missing.ics`, selected.url).toString(),
					},
					true,
				),
			);
			assertE2e(missingByUrl.length === 1 && typeof missingByUrl[0]?.json.error === 'string');
			scenarios.push('empty-and-missing');
			outcome = 'passed';
		} catch (error) {
			operationFailed = true;
			errorCodes.push(
				error instanceof IcloudE2eHarnessError ? error.code : IcloudE2eErrorCode.EVENT_SEED_FAILED,
			);
			throw error;
		} finally {
			let cleanupFailed = false;
			for (const resource of [...resources].reverse()) {
				try {
					await deleteRunOwnedEvent(adapter, resource.resourceUrl);
				} catch {
					cleanupFailed = true;
				}
			}
			if (cleanupFailed) {
				errorCodes.push(IcloudE2eErrorCode.EVENT_CLEANUP_FAILED);
				outcome = 'failed';
			}
			// eslint-disable-next-line no-console -- Only aggregate evidence leaves the test process.
			console.info(
				serializeEvidence({
					schemaVersion: 'icloud-e2e-evidence/v3',
					mode: 'live',
					sourceRevision: CONTRACT_REVISION,
					outcome,
					scenarios,
					requestMethods: [...new Set(observedMethods)],
					errorCodes,
				}),
			);
			if (cleanupFailed && !operationFailed) assertE2e(false);
		}
	});
});
