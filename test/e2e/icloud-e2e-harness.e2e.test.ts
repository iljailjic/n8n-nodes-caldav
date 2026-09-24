// The live adapter intentionally adapts iCloud HTTP streams to the production transport.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { Readable } from 'node:stream';
// UUIDs scope mutable resources to this one test run.
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
	CalDavAuthorizationError,
	CalDavNotFoundError,
	CalDavPreconditionFailedError,
	CalDavRemoteProtocolError,
	CalDavTransportError,
	createCalDavTransport,
	type CalDavRequestHelperAdapter,
	type CalDavTransport,
	type N8nCalDavRequestOptions,
} from '../../nodes/CalDav/transport/http';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';
import {
	CalendarEventMutationFailureCode,
	CalDavCalendarEventMutationError,
	createCalendarEventResource,
} from '../../nodes/CalDav/events/mutations';
import { calendarEventResourceUrlForUid } from '../../nodes/CalDav/events/createPreparation';
import { getCalendarEventByResourceUrl } from '../../nodes/CalDav/events/getByResourceUrl';
import { parseICalendarResource, type ICalendarEntry } from '../../nodes/CalDav/icalendar/parser';

import {
	assertE2e,
	canonicalizeIcloudE2eUrl,
	IcloudE2eErrorCode,
	IcloudE2eHarnessError,
	readIcloudE2eInput,
	recoverOwnedE2eResource,
	recoverRunOwnedE2eEvent,
	selectExactCalendar,
	serializeEvidence,
	throwIfCleanupOnlyFailure,
	waitForE2eVisibility,
	emailAlarmRecipient,
} from './support/icloud-e2e-harness';

const CONTRACT_REVISION = 'issue-56-contract-r1' as const;
const MUTATION_CONTRACT_REVISION = 'issue-57-contract-r1' as const;
const ADVANCED_EVENT_CONTRACT_REVISION = 'issue-58-contract-r1' as const;
const READ_ONLY_METHODS = new Set<CalDavMethod>([CalDavMethod.OPTIONS, CalDavMethod.PROPFIND]);
const LIVE_METHODS = new Set<CalDavMethod>([
	CalDavMethod.OPTIONS,
	CalDavMethod.PROPFIND,
	CalDavMethod.REPORT,
	CalDavMethod.GET,
	CalDavMethod.PUT,
	CalDavMethod.DELETE,
]);
const TIME_RANGE_CONVERGENCE_ATTEMPTS = 4;
const TIME_RANGE_CONVERGENCE_DELAY_MS = 2_000;
const READ_VISIBILITY_ATTEMPTS = 4;
const READ_VISIBILITY_DELAY_MS = 2_000;

interface SafeHttpObservation {
	readonly method: CalDavMethod;
	readonly statusCode: number;
	readonly hasEtag: boolean;
}

function firstFailureEvidence(stage: string, error: unknown, lastHttp?: SafeHttpObservation) {
	const statusCode =
		error instanceof CalDavTransportError
			? (error.statusCode ?? lastHttp?.statusCode)
			: lastHttp?.statusCode;
	return {
		stage,
		category:
			error instanceof IcloudE2eHarnessError
				? ('harness' as const)
				: error instanceof CalDavTransportError
					? ('transport' as const)
					: error instanceof Error && error.name === 'NodeApiError'
						? ('node' as const)
						: ('other' as const),
		...(lastHttp === undefined ? {} : { method: lastHttp.method }),
		...(lastHttp?.method === CalDavMethod.GET ? { etagPresent: lastHttp.hasEtag } : {}),
		...(statusCode === undefined ? {} : { httpStatus: statusCode }),
		...(error instanceof CalDavTransportError ? { transportCode: error.code } : {}),
	};
}

const readVisibilityDelay = async () =>
	await new Promise<void>((resolve) => setTimeout(resolve, READ_VISIBILITY_DELAY_MS));

/** Only cleanup GETs may retry a confirmed HTTP 503; exhausted reads leave cleanup manual. */
async function retryCleanupGet503<T>(
	read: () => Promise<{ readonly value: T; readonly statusCode?: number }>,
	delay: () => Promise<void> = readVisibilityDelay,
	attempts = READ_VISIBILITY_ATTEMPTS,
): Promise<T | undefined> {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const result = await read();
		if (result.statusCode !== 503) return result.value;
		if (attempt + 1 < attempts) await delay();
	}
	return undefined;
}

function liveInputOrUndefined(): ReturnType<typeof readIcloudE2eInput> | undefined {
	return process.env.CALDAV_ICLOUD_E2E_OPT_IN === '1' ? readIcloudE2eInput(process.env) : undefined;
}

function liveRequestAdapter(
	input: ReturnType<typeof readIcloudE2eInput>,
	observedMethods: CalDavMethod[],
	observedRequests: Array<{
		readonly phase: 'product' | 'race' | 'cleanup';
		readonly method: CalDavMethod;
		readonly conditional: 'if-match' | 'if-none-match' | 'none';
		statusCode?: number;
	}> = [],
	phase: () => 'product' | 'race' | 'cleanup' = () => 'product',
	onReport: (() => Promise<void> | void) | undefined = undefined,
	onGet: (() => Promise<void> | void) | undefined = undefined,
	onResponse: ((observation: SafeHttpObservation) => void) | undefined = undefined,
): CalDavRequestHelperAdapter {
	return {
		async request(options: N8nCalDavRequestOptions) {
			assertE2e(LIVE_METHODS.has(options.method));
			observedMethods.push(options.method);
			const headerNames = Object.keys(options.headers ?? {}).map((name) => name.toLowerCase());
			const requestRecord = {
				phase: phase(),
				method: options.method,
				conditional: headerNames.includes('if-match')
					? 'if-match'
					: headerNames.includes('if-none-match')
						? 'if-none-match'
						: 'none',
			};
			observedRequests.push(requestRecord);
			const response = await fetch(options.url, {
				method: options.method,
				headers: {
					...options.headers,
					Authorization: `Basic ${Buffer.from(
						`${input.username}:${input.appPassword}`,
						'utf8',
					).toString('base64')}`,
				},
				...(options.body === undefined ? {} : { body: options.body }),
				redirect: 'manual',
				signal: AbortSignal.timeout(30_000),
			});
			const headers: Record<string, string> = {};
			response.headers.forEach((value, name) => {
				headers[name] = value;
			});
			requestRecord.statusCode = response.status;
			onResponse?.({
				method: options.method,
				statusCode: response.status,
				hasEtag: response.headers.has('etag'),
			});
			if (options.method === CalDavMethod.REPORT) await onReport?.();
			if (options.method === CalDavMethod.GET) await onGet?.();
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
	transport: CalDavTransport,
	calendarUrl: string,
	event: RunOwnedEvent,
	delay: () => Promise<void> = readVisibilityDelay,
): Promise<'cleaned' | 'manual-cleanup-required'> {
	return await recoverRunOwnedE2eEvent(
		event.uid,
		async () =>
			await waitForE2eVisibility(
				async () => {
					try {
						const current = await getCalendarEventByResourceUrl(
							transport,
							validateAbsoluteHttpUrl(calendarUrl),
							validateAbsoluteHttpUrl(event.resourceUrl),
						);
						return {
							kind: 'found' as const,
							uid: current.event.uid,
							etag: current.event.etag ?? '',
						};
					} catch (error) {
						if (error instanceof CalDavNotFoundError) return undefined;
						if (error instanceof CalDavRemoteProtocolError && error.statusCode === 503)
							return undefined;
						throw error;
					}
				},
				delay,
				READ_VISIBILITY_ATTEMPTS,
			),
		async (etag) => {
			try {
				const response = await transport.request({
					method: CalDavMethod.DELETE,
					url: validateAbsoluteHttpUrl(event.resourceUrl),
					headers: { 'If-Match': etag },
				});
				return response.statusCode === 204 ? 'deleted' : 'failed';
			} catch (error) {
				if (error instanceof CalDavNotFoundError) return 'deleted';
				if (error instanceof CalDavPreconditionFailedError) return 'preconditionFailed';
				throw error;
			}
		},
	);
}

function eventOutput(value: unknown): Readonly<Record<string, unknown>> {
	assertE2e(typeof value === 'object' && value !== null && !Array.isArray(value));
	return value as Readonly<Record<string, unknown>>;
}

function assertPrivateRawIcs(output: Readonly<Record<string, unknown>>, uid: string): void {
	// The node returns raw ICS for interoperability, but this suite must never serialize it.
	assertE2e(typeof output.rawIcs === 'string' && output.rawIcs.includes(`UID:${uid}`));
}

function semanticIcsShape(rawIcs: string): Readonly<Record<string, number>> {
	const resource = parseICalendarResource(Buffer.from(rawIcs, 'utf8'));
	const counts: Record<string, number> = {};
	const visit = (entries: readonly ICalendarEntry[]) => {
		for (const entry of entries) {
			counts[entry.name] = (counts[entry.name] ?? 0) + 1;
			if (entry.kind === 'component') visit(entry.entries);
		}
	};
	visit(resource.calendar.entries);
	return counts;
}

function semanticIcsValues(rawIcs: string): Readonly<Record<string, readonly string[]>> {
	const resource = parseICalendarResource(Buffer.from(rawIcs, 'utf8'));
	const values: Record<string, string[]> = {};
	const visit = (entries: readonly ICalendarEntry[]) => {
		for (const entry of entries) {
			if (entry.kind === 'component') visit(entry.entries);
			else (values[entry.name] ??= []).push(entry.value.raw);
		}
	};
	visit(resource.calendar.entries);
	return values;
}

async function waitForTimeRangeConvergence(
	query: () => Promise<ReadonlyArray<Readonly<Record<string, unknown>>>>,
	expected: ReadonlyArray<{ readonly label: string; readonly uid: string }>,
): Promise<ReadonlyArray<Readonly<Record<string, unknown>>>> {
	const expectedUids = new Set(expected.map(({ uid }) => uid));
	for (let attempt = 0; attempt < TIME_RANGE_CONVERGENCE_ATTEMPTS; attempt++) {
		const events = await query();
		const observedUids = new Set(
			events
				.map((event) => event.uid)
				.filter((uid): uid is string => typeof uid === 'string' && expectedUids.has(uid)),
		);
		if (observedUids.size === expectedUids.size) return events;
		if (attempt + 1 < TIME_RANGE_CONVERGENCE_ATTEMPTS) {
			await new Promise<void>((resolve) => setTimeout(resolve, TIME_RANGE_CONVERGENCE_DELAY_MS));
		}
	}
	throw new IcloudE2eHarnessError(IcloudE2eErrorCode.TIME_RANGE_CONVERGENCE_FAILED);
}

describe('iCloud E2E discovery contract (fictional synthetic regressions)', () => {
	it('waits only for a missing post-write read and propagates terminal failures immediately', async () => {
		let reads = 0;
		let delays = 0;
		const visible = await waitForE2eVisibility(
			async () => (++reads === 3 ? 'visible' : undefined),
			async () => {
				delays += 1;
			},
		);
		expect(visible).toBe('visible');
		expect({ reads, delays }).toEqual({ reads: 3, delays: 2 });

		await expect(
			waitForE2eVisibility(
				async () => undefined,
				async () => undefined,
				2,
			),
		).rejects.toMatchObject({ code: IcloudE2eErrorCode.READ_VISIBILITY_FAILED });
	});

	it('retries only 404 through the node continueOnFail response path', async () => {
		const calendarUrl = 'https://calendar.example.test/dav/';
		const event = runOwnedEvent(
			calendarUrl,
			'synthetic',
			'visibility',
			'20400415T100000Z',
			'20400415T103000Z',
		);
		const input = {
			serverUrl: 'https://calendar.example.test/',
			username: 'fictional-user',
			appPassword: 'fictional-password',
			calendarDisplayName: 'Fictional Calendar',
		};
		const parameters = {
			resource: 'event',
			operation: 'get',
			calendar: { __rl: true, mode: 'url', value: calendarUrl },
			identifierMode: 'resourceUrl',
			resourceUrl: event.resourceUrl,
		};
		const run = (statuses: readonly number[]) => {
			let requests = 0;
			let delays = 0;
			const adapter: CalDavRequestHelperAdapter = {
				async request(options) {
					expect(options.method).toBe(CalDavMethod.GET);
					const statusCode = statuses[Math.min(requests++, statuses.length - 1)]!;
					return {
						statusCode,
						headers: statusCode === 200 ? { etag: '"fictional-etag"' } : {},
						body: Readable.from(Buffer.from(statusCode === 200 ? event.ics : '')),
					};
				},
			};
			const node = new CalDav();
			const read = async () => {
				const [items] = await node.execute.call(liveNodeContext(input, adapter, parameters, true));
				const output = items[0]?.json;
				if (output?.error === 'The calendar event was not found.') return undefined;
				assertE2e(typeof output?.error !== 'string');
				return output;
			};
			const result = waitForE2eVisibility(read, async () => {
				delays += 1;
			});
			return { result, counts: () => ({ requests, delays }) };
		};

		const delayed = run([404, 404, 200]);
		expect((await delayed.result).uid).toBe(event.uid);
		expect(delayed.counts()).toEqual({ requests: 3, delays: 2 });
		for (const status of [401, 403, 412, 429]) {
			const terminal = run([status, 200]);
			await expect(terminal.result).rejects.toMatchObject({
				code: IcloudE2eErrorCode.ASSERTION_FAILED,
			});
			expect(terminal.counts()).toEqual({ requests: 1, delays: 0 });
		}
	});

	it('reports cleanup failure without replacing an earlier operation failure', () => {
		expect(() =>
			throwIfCleanupOnlyFailure(true, true, IcloudE2eErrorCode.MANUAL_CLEANUP_REQUIRED),
		).not.toThrow();
		expect(() =>
			throwIfCleanupOnlyFailure(true, false, IcloudE2eErrorCode.MANUAL_CLEANUP_REQUIRED),
		).toThrowError(IcloudE2eErrorCode.MANUAL_CLEANUP_REQUIRED);
	});

	it('requires exact ownership and a fresh ETag before every conditional cleanup delete', async () => {
		const etags: string[] = [];
		let reads = 0;
		const cleaned = await recoverRunOwnedE2eEvent(
			'run-owned',
			async () => ({
				kind: 'found',
				uid: 'run-owned',
				etag: ++reads === 1 ? '"old"' : '"fresh"',
			}),
			async (etag) => {
				etags.push(etag);
				return etag === '"old"' ? 'preconditionFailed' : 'deleted';
			},
		);
		expect(cleaned).toBe('cleaned');
		expect(etags).toEqual(['"old"', '"fresh"']);
		let foreignDeletes = 0;
		const foreign = await recoverRunOwnedE2eEvent(
			'run-owned',
			async () => ({ kind: 'found', uid: 'someone-else', etag: '"fresh"' }),
			async () => {
				foreignDeletes += 1;
				return 'deleted';
			},
		);
		expect(foreign).toBe('manual-cleanup-required');
		expect(foreignDeletes).toBe(0);
		const absent = await recoverRunOwnedE2eEvent(
			'run-owned',
			async () => ({ kind: 'missing' }),
			async () => {
				throw new Error('DELETE must not run');
			},
		);
		expect(absent).toBe('cleaned');
	});

	it('retries only cleanup GET 503 and never repeats an ambiguous seed PUT or cleanup DELETE', async () => {
		const calendarUrl = 'https://calendar.example.test/dav/';
		const event = runOwnedEvent(
			calendarUrl,
			'synthetic',
			'cleanup-503',
			'20400415T100000Z',
			'20400415T103000Z',
		);
		const responses = (getStatuses: number[], deleteStatus: number) => {
			const methods: CalDavMethod[] = [];
			const conditionalEtags: string[] = [];
			const adapter: CalDavRequestHelperAdapter = {
				async request(options) {
					methods.push(options.method);
					const statusCode =
						options.method === CalDavMethod.GET ? (getStatuses.shift() ?? 503) : deleteStatus;
					if (options.method === CalDavMethod.DELETE) {
						conditionalEtags.push(options.headers?.['If-Match'] ?? '');
					}
					return {
						statusCode,
						headers: statusCode === 200 ? { etag: '"fresh"' } : {},
						body: Readable.from(Buffer.from(statusCode === 200 ? event.ics : '')),
					};
				},
			};
			return { adapter, methods, conditionalEtags };
		};
		const delayed = responses([503, 503, 200], 204);
		expect(
			await deleteRunOwnedEvent(
				createCalDavTransport(calendarUrl, delayed.adapter),
				calendarUrl,
				event,
				async () => undefined,
			),
		).toBe('cleaned');
		expect(delayed.methods).toEqual([
			CalDavMethod.GET,
			CalDavMethod.GET,
			CalDavMethod.GET,
			CalDavMethod.DELETE,
		]);
		expect(delayed.conditionalEtags).toEqual(['"fresh"']);

		const unavailable = responses([503, 503, 503, 503], 204);
		await expect(
			deleteRunOwnedEvent(
				createCalDavTransport(calendarUrl, unavailable.adapter),
				calendarUrl,
				event,
				async () => undefined,
			),
		).rejects.toMatchObject({ code: IcloudE2eErrorCode.READ_VISIBILITY_FAILED });
		expect(unavailable.methods).toEqual(Array(4).fill(CalDavMethod.GET));

		const ambiguousDelete = responses([200], 503);
		await expect(
			deleteRunOwnedEvent(
				createCalDavTransport(calendarUrl, ambiguousDelete.adapter),
				calendarUrl,
				event,
				async () => undefined,
			),
		).rejects.toMatchObject({ statusCode: 503 });
		expect(ambiguousDelete.methods).toEqual([CalDavMethod.GET, CalDavMethod.DELETE]);
		expect(ambiguousDelete.conditionalEtags).toEqual(['"fresh"']);

		let seedWrites = 0;
		await expect(
			seedRunOwnedEvent(
				{
					async request(options) {
						expect(options.method).toBe(CalDavMethod.PUT);
						seedWrites += 1;
						return { statusCode: 503, headers: {}, body: Readable.from(Buffer.from('')) };
					},
				},
				event,
			),
		).rejects.toMatchObject({ code: IcloudE2eErrorCode.ASSERTION_FAILED });
		expect(seedWrites).toBe(1);
	});

	it('bounds node cleanup GET 503 while terminal responses do not retry', async () => {
		const calendarUrl = 'https://calendar.example.test/dav/';
		const event = runOwnedEvent(
			calendarUrl,
			'synthetic',
			'node-cleanup-503',
			'20400415T100000Z',
			'20400415T103000Z',
		);
		const input = {
			serverUrl: 'https://calendar.example.test/',
			username: 'fictional-user',
			appPassword: 'fictional-password',
			calendarDisplayName: 'Fictional Calendar',
		};
		const run = async (statuses: readonly number[]) => {
			let reads = 0;
			let delays = 0;
			let lastStatus = 0;
			const adapter: CalDavRequestHelperAdapter = {
				async request(options) {
					expect(options.method).toBe(CalDavMethod.GET);
					lastStatus = statuses[Math.min(reads++, statuses.length - 1)]!;
					return {
						statusCode: lastStatus,
						headers: lastStatus === 200 ? { etag: '"fresh"' } : {},
						body: Readable.from(Buffer.from(lastStatus === 200 ? event.ics : '')),
					};
				},
			};
			const node = new CalDav();
			const value = await retryCleanupGet503(
				async () => {
					const [items] = await node.execute.call(
						liveNodeContext(
							input,
							adapter,
							{
								resource: 'event',
								operation: 'get',
								calendar: { __rl: true, mode: 'url', value: calendarUrl },
								identifierMode: 'resourceUrl',
								resourceUrl: event.resourceUrl,
							},
							true,
						),
					);
					const current = items[0]?.json;
					return {
						value: lastStatus === 200 ? { uid: current?.uid, etag: current?.etag } : undefined,
						statusCode: lastStatus,
					};
				},
				async () => {
					delays += 1;
				},
			);
			return { value, reads, delays };
		};
		expect(await run([503, 503, 200])).toEqual({
			value: { uid: event.uid, etag: '"fresh"' },
			reads: 3,
			delays: 2,
		});
		expect(await run([503, 503, 503, 503])).toEqual({ value: undefined, reads: 4, delays: 3 });
		for (const status of [401, 403, 404, 412, 429]) {
			expect(await run([status, 200])).toEqual({ value: undefined, reads: 1, delays: 0 });
		}
	});

	it('records only fixed failure categories and numeric HTTP status, never exception text', () => {
		const privateError = new Error('private-account@example.test https://private.example.test/');
		const evidence = serializeEvidence({
			schemaVersion: 'icloud-e2e-evidence/v5',
			mode: 'fake',
			sourceRevision: CONTRACT_REVISION,
			outcome: 'failed',
			scenarios: [],
			requestMethods: ['PUT'],
			errorCodes: [IcloudE2eErrorCode.ASSERTION_FAILED],
			firstFailure: firstFailureEvidence('event-seed', privateError, {
				method: CalDavMethod.PUT,
				statusCode: 429,
				hasEtag: false,
			}),
			cleanupOutcome: 'manual-cleanup-required',
		});
		expect(evidence).toContain('"httpStatus":429');
		expect(evidence).toContain('"stage":"event-seed"');
		expect(evidence).not.toContain('private-account');
		expect(evidence).not.toContain('private.example.test');
	});

	it('retries only cleanup 412s with ownership revalidation and reports a bounded manual-cleanup fallback', async () => {
		const recoveredChecks: string[] = [];
		let recoveredDeletes = 0;
		const recovered = await recoverOwnedE2eResource(
			async () => {
				recoveredChecks.push('verify');
				return true;
			},
			async () => {
				recoveredChecks.push('delete');
				recoveredDeletes += 1;
				return recoveredDeletes === 1 ? 'preconditionFailed' : 'deleted';
			},
		);
		expect(recovered).toBe('cleaned');
		expect(recoveredChecks).toEqual(['verify', 'delete', 'verify', 'delete']);

		let manualDeletes = 0;
		const manual = await recoverOwnedE2eResource(
			async () => true,
			async () => {
				manualDeletes += 1;
				return 'preconditionFailed';
			},
		);
		expect(manual).toBe('manual-cleanup-required');
		expect(manualDeletes).toBe(3);
	});

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
			schemaVersion: 'icloud-e2e-evidence/v5',
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

it('uses a fictional email recipient by default and compares advanced ICS by parsed shape', () => {
	const defaultRecipient = emailAlarmRecipient({ CALDAV_ICLOUD_E2E_OPT_IN: '1' });
	expect(defaultRecipient).toBe('mailto:advanced-event-recipient@caldav-e2e.invalid');
	expect(
		emailAlarmRecipient({
			CALDAV_ICLOUD_E2E_OPT_IN: '1',
			CALDAV_ICLOUD_E2E_EMAIL_OPT_IN: '1',
			CALDAV_ICLOUD_E2E_EMAIL_SINK: 'mailto:owner-controlled@example.test',
		}),
	).toBe('mailto:owner-controlled@example.test');

	const shape = semanticIcsShape(
		[
			'BEGIN:VCALENDAR',
			'VERSION:2.0',
			'BEGIN:VEVENT',
			'UID:advanced-semantic-fixture@example.test',
			'DTSTAMP:20400101T000000Z',
			'DTSTART;TZID=Europe/Prague:20400325T033000',
			'DTEND;TZID=Europe/Prague:20400325T043000',
			'RRULE:FREQ=DAILY;COUNT=2',
			'X-CODEX-UNKNOWN:preserve',
			'BEGIN:VALARM',
			'ACTION:DISPLAY',
			'TRIGGER:-PT15M',
			'END:VALARM',
			'END:VEVENT',
			'END:VCALENDAR',
			'',
		].join('\r\n'),
	);
	expect(shape).toMatchObject({ VEVENT: 1, VALARM: 1, RRULE: 1, 'X-CODEX-UNKNOWN': 1 });
});

const liveInput = liveInputOrUndefined();

describe.runIf(liveInput !== undefined)('iCloud E2E live read-only discovery', () => {
	it('validates capability, redirect-safe principal/home discovery, and the selected calendar list', async () => {
		const input = liveInput!;
		const observedMethods: CalDavMethod[] = [];
		let lastHttp: SafeHttpObservation | undefined;
		let stage = 'capability';
		let firstFailure: ReturnType<typeof firstFailureEvidence> | undefined;
		const adapter = liveRequestAdapter(
			input,
			observedMethods,
			[],
			() => 'product',
			undefined,
			undefined,
			(observation) => {
				lastHttp = observation;
			},
		);
		const transport = createCalDavTransport(input.serverUrl, adapter);
		const scenarios: string[] = [];
		const errorCodes: IcloudE2eErrorCode[] = [];
		let outcome: 'passed' | 'failed' = 'failed';

		try {
			await validateCalDavCapability(transport);
			scenarios.push('capability');

			stage = 'principal-home';
			lastHttp = undefined;
			const principal = await discoverCurrentUserPrincipal(transport);
			assertE2e(principal.kind === CurrentUserPrincipalDiscoveryKind.AUTHENTICATED);
			assertE2e(canonicalizeIcloudE2eUrl(principal.principalUrl) === principal.principalUrl);
			const home = await discoverCalendarHome(transport, principal.principalUrl);
			assertE2e(canonicalizeIcloudE2eUrl(home.calendarHomeUrl) === home.calendarHomeUrl);
			scenarios.push('redirect-principal-home');

			stage = 'calendar-discovery';
			lastHttp = undefined;
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
			stage = 'calendar-node-operations';
			lastHttp = undefined;
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
			firstFailure = firstFailureEvidence(stage, error, lastHttp);
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
					schemaVersion: 'icloud-e2e-evidence/v5',
					mode: 'live',
					sourceRevision: CONTRACT_REVISION,
					outcome,
					scenarios,
					requestMethods: [...new Set(observedMethods)],
					errorCodes,
					...(firstFailure === undefined ? {} : { firstFailure }),
					cleanupOutcome: 'not-required',
				}),
			);
		}
	});
});

describe.runIf(liveInput !== undefined)('iCloud E2E live event lookup and range queries', () => {
	it('uses only run-owned resources for identity, [S,E), sorting, limits, missing, and recurrence checks', async () => {
		const input = liveInput!;
		const observedMethods: CalDavMethod[] = [];
		let lastHttp: SafeHttpObservation | undefined;
		let stage = 'event-discovery';
		let firstFailure: ReturnType<typeof firstFailureEvidence> | undefined;
		const adapter = liveRequestAdapter(
			input,
			observedMethods,
			[],
			() => 'product',
			undefined,
			undefined,
			(observation) => {
				lastHttp = observation;
			},
		);
		const transport = createCalDavTransport(input.serverUrl, adapter);
		const scenarios: string[] = [];
		const errorCodes: IcloudE2eErrorCode[] = [];
		const runId = randomUUID();
		const resources: RunOwnedEvent[] = [];
		const attemptedResources: RunOwnedEvent[] = [];
		let selectedCalendarUrl: string | undefined;
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
			selectedCalendarUrl = selected.url;

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
			stage = 'event-seed';
			lastHttp = undefined;
			for (const resource of resources) {
				attemptedResources.push(resource);
				await seedRunOwnedEvent(adapter, resource);
			}
			scenarios.push('run-owned-seed');

			stage = 'event-get-after-seed';
			lastHttp = undefined;
			const node = new CalDav();
			const calendar = { __rl: true, mode: 'url', value: selected.url };
			const byUrl = await waitForE2eVisibility(
				async () => {
					const [items] = await node.execute.call(
						liveNodeContext(
							input,
							adapter,
							{
								resource: 'event',
								operation: 'get',
								calendar,
								identifierMode: 'resourceUrl',
								resourceUrl: resources[2]!.resourceUrl,
							},
							true,
						),
					);
					if (items[0]?.json.error === 'The calendar event was not found.') return undefined;
					assertE2e(typeof items[0]?.json.error !== 'string');
					return items[0];
				},
				readVisibilityDelay,
				READ_VISIBILITY_ATTEMPTS,
			);
			const byUrlEvent = eventOutput(byUrl.json);
			assertE2e(
				byUrlEvent.resourceUrl === resources[2]!.resourceUrl &&
					byUrlEvent.uid === resources[2]!.uid,
			);
			assertE2e(typeof byUrlEvent.etag === 'string' && byUrlEvent.etag.length > 0);
			assertPrivateRawIcs(byUrlEvent, resources[2]!.uid);
			stage = 'event-uid-after-seed';
			lastHttp = undefined;
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
			const expectedTimeRangeEvents = [
				{ label: 'spans-start', uid: resources[1]!.uid },
				{ label: 'at-start', uid: resources[2]!.uid },
				{ label: 'inside', uid: resources[3]!.uid },
				{ label: 'recurring', uid: resources[4]!.uid },
			];
			stage = 'event-range-after-seed';
			lastHttp = undefined;
			const allEvents = await waitForTimeRangeConvergence(async () => {
				const [all] = await node.execute.call(
					liveNodeContext(input, adapter, { ...query, returnAll: true }),
				);
				return all.map((item) => eventOutput(item.json));
			}, expectedTimeRangeEvents);
			const runOwnedRangeEvents = allEvents.filter((event) =>
				expectedTimeRangeEvents.some(({ uid }) => event.uid === uid),
			);
			assertE2e(runOwnedRangeEvents.length === expectedTimeRangeEvents.length);
			assertE2e(
				runOwnedRangeEvents.map((event) => event.uid).join(',') ===
					expectedTimeRangeEvents.map((event) => event.uid).join(','),
			);
			scenarios.push('time-range-convergence-four-run-owned-labels');

			const [limited] = await node.execute.call(
				liveNodeContext(input, adapter, { ...query, returnAll: false, limit: 2 }),
			);
			const limitedEvents = limited.map((item) => eventOutput(item.json));
			assertE2e(limitedEvents.length === 2);
			assertE2e(
				limitedEvents.map((event) => event.uid).join(',') ===
					allEvents
						.slice(0, 2)
						.map((event) => event.uid)
						.join(','),
			);
			for (const event of limitedEvents) assertPrivateRawIcs(event, event.uid as string);
			scenarios.push('half-open-boundaries-deterministic-limit');

			assertE2e(
				runOwnedRangeEvents.map((event) => event.uid).join(',') ===
					[resources[1]!.uid, resources[2]!.uid, resources[3]!.uid, resources[4]!.uid].join(','),
			);
			assertE2e(!allEvents.some((event) => event.uid === resources[7]!.uid));
			assertPrivateRawIcs(runOwnedRangeEvents[3]!, resources[4]!.uid);
			assertE2e(
				typeof runOwnedRangeEvents[3]!.rawIcs === 'string' &&
					runOwnedRangeEvents[3]!.rawIcs.includes('RRULE:FREQ=DAILY;COUNT=2') &&
					runOwnedRangeEvents[3]!.rawIcs.includes('RECURRENCE-ID:20400416T120000Z'),
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
			firstFailure = firstFailureEvidence(stage, error, lastHttp);
			errorCodes.push(
				error instanceof IcloudE2eHarnessError ? error.code : IcloudE2eErrorCode.EVENT_SEED_FAILED,
			);
			throw error;
		} finally {
			let cleanupFailed = false;
			stage = 'event-cleanup';
			lastHttp = undefined;
			for (const resource of [...attemptedResources].reverse()) {
				try {
					if (
						selectedCalendarUrl === undefined ||
						(await deleteRunOwnedEvent(transport, selectedCalendarUrl, resource)) !== 'cleaned'
					) {
						cleanupFailed = true;
						firstFailure ??= firstFailureEvidence(
							stage,
							new IcloudE2eHarnessError(IcloudE2eErrorCode.EVENT_CLEANUP_FAILED),
							lastHttp,
						);
					}
				} catch (error) {
					cleanupFailed = true;
					firstFailure ??= firstFailureEvidence(stage, error, lastHttp);
				}
			}
			if (cleanupFailed) {
				errorCodes.push(IcloudE2eErrorCode.EVENT_CLEANUP_FAILED);
				outcome = 'failed';
				firstFailure ??= firstFailureEvidence(
					stage,
					new IcloudE2eHarnessError(IcloudE2eErrorCode.EVENT_CLEANUP_FAILED),
					lastHttp,
				);
			}
			// eslint-disable-next-line no-console -- Only aggregate evidence leaves the test process.
			console.info(
				serializeEvidence({
					schemaVersion: 'icloud-e2e-evidence/v5',
					mode: 'live',
					sourceRevision: CONTRACT_REVISION,
					outcome,
					scenarios,
					requestMethods: [...new Set(observedMethods)],
					errorCodes,
					...(firstFailure === undefined ? {} : { firstFailure }),
					cleanupOutcome:
						attemptedResources.length === 0
							? 'not-required'
							: cleanupFailed
								? 'manual-cleanup-required'
								: 'cleaned',
				}),
			);
			throwIfCleanupOnlyFailure(
				cleanupFailed,
				operationFailed,
				IcloudE2eErrorCode.EVENT_CLEANUP_FAILED,
			);
		}
	});
});

function mutationParameters(
	calendarUrl: string,
	operation: 'create' | 'get' | 'update' | 'upsert' | 'delete',
	overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
	return {
		resource: 'event',
		operation,
		calendar: { __rl: true, mode: 'url', value: calendarUrl },
		timeMode: 'timed',
		timeZoneMode: 'utc',
		start: '2040-06-15T10:00:00Z',
		end: '2040-06-15T10:30:00Z',
		summary: 'codex e2e issue 57',
		additionalFields: {},
		...overrides,
	};
}

function assertCurrentIdentity(output: Readonly<Record<string, unknown>>, uid?: string): void {
	assertE2e(typeof output.calendarUrl === 'string' && typeof output.resourceUrl === 'string');
	assertE2e(typeof output.uid === 'string' && output.uid.length > 0);
	assertE2e(typeof output.etag === 'string' && output.etag.length > 0);
	if (uid !== undefined) assertE2e(output.uid === uid);
}

function assertIcloudCandidateScanLookup(
	traffic: ReadonlyArray<{
		readonly method: CalDavMethod;
	}>,
	candidateGetCount: 1 | 2,
): void {
	const lookupTraffic = traffic.filter((request) =>
		[CalDavMethod.GET, CalDavMethod.PROPFIND, CalDavMethod.REPORT].includes(request.method),
	);
	assertE2e(
		lookupTraffic.filter((request) => request.method === CalDavMethod.GET).length ===
			candidateGetCount,
	);
	if (candidateGetCount === 1) {
		assertE2e(lookupTraffic.length === 1 && lookupTraffic[0]?.method === CalDavMethod.GET);
		return;
	}
	assertE2e(
		lookupTraffic[0]?.method === CalDavMethod.GET &&
			lookupTraffic[1]?.method === CalDavMethod.GET &&
			lookupTraffic[2]?.method === CalDavMethod.PROPFIND &&
			lookupTraffic.slice(3).length > 0 &&
			lookupTraffic.slice(3).every((request) => request.method === CalDavMethod.REPORT),
	);
}

function assertIcloudUidLookupConditionalPutAndCanonicalReadback(
	traffic: ReadonlyArray<{
		readonly method: CalDavMethod;
		readonly conditional: 'if-match' | 'if-none-match' | 'none';
	}>,
): void {
	const productPutIndex = traffic.findIndex(
		(request) => request.method === CalDavMethod.PUT && request.conditional === 'if-match',
	);
	assertE2e(productPutIndex > 0);
	assertIcloudCandidateScanLookup(traffic.slice(0, productPutIndex), 1);
	const readback = traffic.slice(productPutIndex + 1);
	assertE2e(readback.length === 1 && readback[0]?.method === CalDavMethod.GET);
}

function assertSingleFailedConditionalProductPut(
	traffic: ReadonlyArray<{
		readonly phase: 'product' | 'race' | 'cleanup';
		readonly method: CalDavMethod;
		readonly conditional: 'if-match' | 'if-none-match' | 'none';
		readonly statusCode?: number;
	}>,
	conditional: 'if-match' | 'if-none-match',
): void {
	const productPuts = traffic.filter(
		(request) =>
			request.phase === 'product' &&
			request.method === CalDavMethod.PUT &&
			request.conditional === conditional,
	);
	assertE2e(productPuts.length === 1 && productPuts[0]?.statusCode === 412);
}

describe.runIf(liveInput !== undefined)('iCloud E2E live CRUD, ETag, and Upsert contract', () => {
	it('keeps conditional product conflicts terminal and isolates cleanup instrumentation', async () => {
		const input = liveInput!;
		const observedMethods: CalDavMethod[] = [];
		const observedRequests: Array<{
			readonly phase: 'product' | 'race' | 'cleanup';
			readonly method: CalDavMethod;
			readonly conditional: 'if-match' | 'if-none-match' | 'none';
			statusCode?: number;
		}> = [];
		let phase: 'product' | 'race' | 'cleanup' = 'product';
		let stage = 'mutation-discovery';
		let lastHttp: SafeHttpObservation | undefined;
		let firstFailure: ReturnType<typeof firstFailureEvidence> | undefined;
		let operationFailed = false;
		let suppliedUidLookup:
			{ result: 'created' | 'incomplete' | 'other-error'; writeAttempts: number } | undefined;
		let raceHook: (() => Promise<void>) | undefined;
		let reportRaceHook: (() => Promise<void>) | undefined;
		const runRaceHook = async (hook: (() => Promise<void>) | undefined): Promise<void> => {
			const priorPhase = phase;
			phase = 'race';
			try {
				await hook?.();
			} finally {
				phase = priorPhase;
			}
		};
		const adapter = liveRequestAdapter(
			input,
			observedMethods,
			observedRequests,
			() => phase,
			async () => await runRaceHook(reportRaceHook),
			async () => await runRaceHook(raceHook),
			(observation) => {
				lastHttp = observation;
			},
		);
		const transport = createCalDavTransport(input.serverUrl, adapter);
		const node = new CalDav();
		const runId = randomUUID();
		const scenarioIds: string[] = [];
		const errorCodes: IcloudE2eErrorCode[] = [];
		const owned: Array<{ readonly uid: string; readonly resourceUrl: string }> = [];
		let outcome: 'passed' | 'failed' = 'failed';
		let calendarUrlForCleanup: string | undefined;
		let incompleteSuppliedUidScan = false;

		const execute = async (
			parameters: Readonly<Record<string, unknown>>,
			continueOnFail = false,
		): Promise<ReadonlyArray<{ readonly json: Record<string, unknown> }>> =>
			(
				await node.execute.call(liveNodeContext(input, adapter, parameters, continueOnFail))
			)[0] as Array<{
				readonly json: Record<string, unknown>;
			}>;

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
			calendarUrlForCleanup = selected.url;

			stage = 'mutation-create';
			lastHttp = undefined;
			const createUid = `codex-e2e-57-${runId}-create`;
			const [created] = await execute(
				mutationParameters(selected.url, 'create', { uid: createUid }),
			);
			assertE2e(created !== undefined);
			assertCurrentIdentity(created!.json, createUid);
			owned.push({ uid: createUid, resourceUrl: created!.json.resourceUrl as string });
			scenarioIds.push('create-current-canonical-identity');

			stage = 'mutation-create-collision';
			lastHttp = undefined;
			const collisionStart = observedRequests.length;
			const [collision] = await execute(
				mutationParameters(selected.url, 'create', { uid: createUid }),
				true,
			);
			assertE2e(typeof collision?.json.error === 'string');
			const createCollisionTraffic = observedRequests.slice(collisionStart);
			assertSingleFailedConditionalProductPut(createCollisionTraffic, 'if-none-match');
			assertE2e(createCollisionTraffic.every((request) => request.method !== CalDavMethod.DELETE));
			scenarioIds.push('create-url-collision-terminal-no-retry');

			stage = 'mutation-stale-etag';
			lastHttp = undefined;
			const staleStart = observedRequests.length;
			const [stale] = await execute(
				mutationParameters(selected.url, 'update', {
					identifierMode: 'resourceUrl',
					resourceUrl: created!.json.resourceUrl,
					etag: '"intentionally-stale"',
					fieldsToUpdate: { summary: 'codex e2e issue 57 stale' },
				}),
				true,
			);
			assertE2e(typeof stale?.json.error === 'string');
			const staleTraffic = observedRequests.slice(staleStart);
			assertSingleFailedConditionalProductPut(staleTraffic, 'if-match');
			assertE2e(staleTraffic.every((request) => request.method !== CalDavMethod.DELETE));
			scenarioIds.push('update-supplied-stale-etag-terminal-no-overwrite');

			stage = 'mutation-update-resource-url';
			lastHttp = undefined;
			const [updated] = await execute(
				mutationParameters(selected.url, 'update', {
					identifierMode: 'resourceUrl',
					resourceUrl: created!.json.resourceUrl,
					etag: created!.json.etag,
					fieldsToUpdate: { summary: 'codex e2e issue 57 updated' },
				}),
			);
			assertE2e(updated !== undefined);
			assertCurrentIdentity(updated!.json, createUid);
			assertPrivateRawIcs(updated!.json, createUid);
			scenarioIds.push('update-conditional-current-canonical-identity-and-read-back');

			stage = 'mutation-update-uid-supplied-etag';
			lastHttp = undefined;
			const suppliedUidUpdateStart = observedRequests.length;
			const [suppliedUidUpdated] = await execute(
				mutationParameters(selected.url, 'update', {
					identifierMode: 'uid',
					uid: createUid,
					etag: updated!.json.etag,
					fieldsToUpdate: { summary: 'codex e2e issue 57 UID supplied ETag update' },
				}),
			);
			assertE2e(suppliedUidUpdated !== undefined);
			assertCurrentIdentity(suppliedUidUpdated!.json, createUid);
			assertPrivateRawIcs(suppliedUidUpdated!.json, createUid);
			const suppliedUidUpdateTraffic = observedRequests.slice(suppliedUidUpdateStart);
			assertIcloudUidLookupConditionalPutAndCanonicalReadback(suppliedUidUpdateTraffic);
			scenarioIds.push('update-uid-supplied-etag-provider-lookup-conditional-canonical-read-back');

			stage = 'mutation-update-uid-internal-etag';
			lastHttp = undefined;
			const internalUidUpdateStart = observedRequests.length;
			const [internalUidUpdated] = await execute(
				mutationParameters(selected.url, 'update', {
					identifierMode: 'uid',
					uid: createUid,
					fieldsToUpdate: { summary: 'codex e2e issue 57 UID internal ETag update' },
				}),
			);
			assertE2e(internalUidUpdated !== undefined);
			assertCurrentIdentity(internalUidUpdated!.json, createUid);
			assertPrivateRawIcs(internalUidUpdated!.json, createUid);
			const internalUidUpdateTraffic = observedRequests.slice(internalUidUpdateStart);
			assertIcloudUidLookupConditionalPutAndCanonicalReadback(internalUidUpdateTraffic);
			scenarioIds.push('update-uid-internal-etag-provider-lookup-conditional-canonical-read-back');

			stage = 'mutation-update-race';
			lastHttp = undefined;
			const updateRaceStart = observedRequests.length;
			raceHook = async () => {
				const winner = await adapter.request({
					method: CalDavMethod.PUT,
					url: internalUidUpdated!.json.resourceUrl as string,
					headers: {
						'Content-Type': 'text/calendar; charset=utf-8',
						'If-Match': internalUidUpdated!.json.etag as string,
					},
					body: [
						'BEGIN:VCALENDAR',
						'VERSION:2.0',
						'BEGIN:VEVENT',
						`UID:${createUid}`,
						'DTSTAMP:20400101T000000Z',
						'DTSTART:20400615T100000Z',
						'DTEND:20400615T103000Z',
						'SUMMARY:codex e2e issue 57 update race winner',
						'END:VEVENT',
						'END:VCALENDAR',
						'',
					].join('\r\n'),
				});
				assertE2e(winner.statusCode === 204 || winner.statusCode === 201);
				raceHook = undefined;
			};
			const [updateRace] = await execute(
				mutationParameters(selected.url, 'update', {
					identifierMode: 'resourceUrl',
					resourceUrl: internalUidUpdated!.json.resourceUrl,
					etag: '',
					fieldsToUpdate: { summary: 'codex e2e issue 57 update race loser' },
				}),
				true,
			);
			assertE2e(typeof updateRace?.json.error === 'string');
			const updateRaceTraffic = observedRequests.slice(updateRaceStart);
			assertE2e(
				updateRaceTraffic.filter((request) => request.method === CalDavMethod.GET).length === 1,
			);
			assertSingleFailedConditionalProductPut(updateRaceTraffic, 'if-match');
			assertE2e(updateRaceTraffic.every((request) => request.method !== CalDavMethod.DELETE));
			const [updateWinner] = await execute(
				mutationParameters(selected.url, 'get', {
					identifierMode: 'resourceUrl',
					resourceUrl: internalUidUpdated!.json.resourceUrl,
				}),
			);
			assertPrivateRawIcs(updateWinner!.json, createUid);
			assertE2e(
				typeof updateWinner!.json.rawIcs === 'string' &&
					updateWinner!.json.rawIcs.includes('SUMMARY:codex e2e issue 57 update race winner'),
			);
			scenarioIds.push('update-lookup-put-race-terminal-winner-unchanged');

			stage = 'mutation-delete';
			lastHttp = undefined;
			const deleteUid = `codex-e2e-57-${runId}-delete`;
			const [deleteCreated] = await execute(
				mutationParameters(selected.url, 'create', { uid: deleteUid }),
			);
			assertE2e(deleteCreated !== undefined);
			assertCurrentIdentity(deleteCreated!.json, deleteUid);
			owned.push({ uid: deleteUid, resourceUrl: deleteCreated!.json.resourceUrl as string });
			const [deleted] = await execute(
				mutationParameters(selected.url, 'delete', {
					identifierMode: 'resourceUrl',
					resourceUrl: deleteCreated!.json.resourceUrl,
					etag: deleteCreated!.json.etag,
				}),
			);
			assertE2e(deleted?.json.deleted === true);
			const [afterDelete] = await execute(
				mutationParameters(selected.url, 'get', {
					identifierMode: 'resourceUrl',
					resourceUrl: deleteCreated!.json.resourceUrl,
				}),
				true,
			);
			assertE2e(typeof afterDelete?.json.error === 'string');
			const deleteReadback = [...observedRequests]
				.reverse()
				.find((request) => request.method === CalDavMethod.GET);
			assertE2e(deleteReadback?.statusCode === 404);
			const deletedOwnedIndex = owned.findIndex(
				(resource) => resource.resourceUrl === deleteCreated!.json.resourceUrl,
			);
			assertE2e(deletedOwnedIndex !== -1);
			owned.splice(deletedOwnedIndex, 1);
			scenarioIds.push('delete-conditional-read-after-delete');

			stage = 'mutation-preservation-seed';
			lastHttp = undefined;
			const preservedUid = `codex-e2e-57-${runId}-preserved`;
			const preservedResourceUrl = new URL(
				`${Buffer.from(preservedUid, 'utf8').toString('base64url')}.ics`,
				selected.url,
			).toString();
			await createCalendarEventResource(
				transport,
				validateAbsoluteHttpUrl(selected.url),
				validateAbsoluteHttpUrl(preservedResourceUrl),
				[
					'BEGIN:VCALENDAR',
					'VERSION:2.0',
					'BEGIN:VEVENT',
					`UID:${preservedUid}`,
					'DTSTAMP:20400101T000000Z',
					'DTSTART:20400615T100000Z',
					'DTEND:20400615T103000Z',
					'SUMMARY:codex e2e issue 57 preserved',
					'X-CODEX-E2E-UNKNOWN:retain',
					'END:VEVENT',
					'END:VCALENDAR',
					'',
				].join('\r\n'),
			);
			owned.push({ uid: preservedUid, resourceUrl: preservedResourceUrl });
			stage = 'mutation-preservation-upsert';
			lastHttp = undefined;
			const preservedUpsertStart = observedRequests.length;
			const [preservedUpdate] = await execute(
				mutationParameters(selected.url, 'upsert', {
					uid: preservedUid,
					summary: 'codex e2e issue 57 preserved update',
				}),
			);
			assertE2e(preservedUpdate !== undefined);
			assertE2e(preservedUpdate!.json.action === 'update');
			assertPrivateRawIcs(preservedUpdate!.json, preservedUid);
			const preservedUpsertTraffic = observedRequests.slice(preservedUpsertStart);
			assertIcloudUidLookupConditionalPutAndCanonicalReadback(preservedUpsertTraffic);
			assertE2e(
				typeof preservedUpdate!.json.rawIcs === 'string' &&
					preservedUpdate!.json.rawIcs.includes('X-CODEX-E2E-UNKNOWN:retain'),
			);
			scenarioIds.push('structured-upsert-update-preserves-seeded-unknown-property');

			stage = 'mutation-upsert-omitted-uid';
			lastHttp = undefined;
			const omittedUidStart = observedRequests.length;
			const [upsertOmittedUid] = await execute(
				mutationParameters(selected.url, 'upsert', { uid: '' }),
			);
			assertE2e(upsertOmittedUid?.json.action === 'create');
			assertCurrentIdentity(upsertOmittedUid!.json);
			owned.push({
				uid: upsertOmittedUid!.json.uid as string,
				resourceUrl: upsertOmittedUid!.json.resourceUrl as string,
			});
			const omittedUidTraffic = observedRequests.slice(omittedUidStart);
			assertE2e(
				omittedUidTraffic.filter((request) => request.method === CalDavMethod.REPORT).length ===
					0 &&
					omittedUidTraffic.filter(
						(request) =>
							request.method === CalDavMethod.PUT && request.conditional === 'if-none-match',
					).length === 1 &&
					omittedUidTraffic.every((request) => request.method !== CalDavMethod.DELETE),
			);
			scenarioIds.push('upsert-omitted-uid-direct-conditional-create-no-lookup-delete');

			const suppliedUid = `codex-e2e-57-${runId}-supplied`;
			stage = 'supplied-uid-lookup';
			lastHttp = undefined;
			const suppliedCreateStart = observedRequests.length;
			const [upsertCreated] = await execute(
				mutationParameters(selected.url, 'upsert', { uid: suppliedUid }),
				true,
			);
			const suppliedCreateTraffic = observedRequests.slice(suppliedCreateStart);
			suppliedUidLookup = {
				result:
					upsertCreated?.json.action === 'create'
						? 'created'
						: upsertCreated?.json.error ===
							  'The calendar event UID lookup could not be completed safely.'
							? 'incomplete'
							: 'other-error',
				writeAttempts: suppliedCreateTraffic.filter(
					(request) =>
						request.method === CalDavMethod.PUT || request.method === CalDavMethod.DELETE,
				).length,
			};
			const suppliedLookupIncomplete = upsertCreated?.json.action !== 'create';
			if (suppliedLookupIncomplete) {
				incompleteSuppliedUidScan = true;
				firstFailure ??= firstFailureEvidence(
					stage,
					new IcloudE2eHarnessError(IcloudE2eErrorCode.ASSERTION_FAILED),
					lastHttp,
				);
				assertE2e(
					upsertCreated?.json.error ===
						'The calendar event UID lookup could not be completed safely.',
				);
				assertE2e(
					suppliedCreateTraffic.filter(
						(request) =>
							request.method === CalDavMethod.PUT || request.method === CalDavMethod.DELETE,
					).length === 0,
				);
				scenarioIds.push('upsert-supplied-missing-incomplete-scan-terminal-no-write');
				stage = 'supplied-uid-seed-after-incomplete-scan';
				lastHttp = undefined;
				const suppliedResourceUrl = calendarEventResourceUrlForUid(selected.url, suppliedUid);
				await createCalendarEventResource(
					transport,
					validateAbsoluteHttpUrl(selected.url),
					validateAbsoluteHttpUrl(suppliedResourceUrl),
					[
						'BEGIN:VCALENDAR',
						'VERSION:2.0',
						'BEGIN:VEVENT',
						`UID:${suppliedUid}`,
						'DTSTAMP:20400101T000000Z',
						'DTSTART:20400615T100000Z',
						'DTEND:20400615T103000Z',
						'SUMMARY:codex e2e issue 57 supplied seed',
						'END:VEVENT',
						'END:VCALENDAR',
						'',
					].join('\r\n'),
				);
				owned.push({ uid: suppliedUid, resourceUrl: suppliedResourceUrl });
			} else {
				assertE2e(upsertCreated?.json.action === 'create');
				assertCurrentIdentity(upsertCreated!.json, suppliedUid);
				owned.push({ uid: suppliedUid, resourceUrl: upsertCreated!.json.resourceUrl as string });
				assertIcloudCandidateScanLookup(suppliedCreateTraffic, 2);
				assertE2e(
					suppliedCreateTraffic.filter(
						(request) =>
							request.method === CalDavMethod.PUT && request.conditional === 'if-none-match',
					).length === 1 &&
						suppliedCreateTraffic.every((request) => request.method !== CalDavMethod.DELETE),
				);
				scenarioIds.push('upsert-supplied-missing-one-lookup-conditional-create-no-delete');
			}

			stage = 'supplied-uid-update';
			lastHttp = undefined;
			const suppliedUpdateStart = observedRequests.length;
			const [upsertUpdated] = await execute(
				mutationParameters(selected.url, 'upsert', {
					uid: suppliedUid,
					summary: 'codex e2e issue 57 updated',
				}),
			);
			assertE2e(upsertUpdated?.json.action === 'update');
			assertCurrentIdentity(upsertUpdated!.json, suppliedUid);
			const suppliedUpdateTraffic = observedRequests.slice(suppliedUpdateStart);
			assertIcloudUidLookupConditionalPutAndCanonicalReadback(suppliedUpdateTraffic);
			assertE2e(suppliedUpdateTraffic.every((request) => request.method !== CalDavMethod.DELETE));
			scenarioIds.push('upsert-unique-match-one-lookup-conditional-update-no-delete-move');

			stage = 'mutation-conflicts';
			lastHttp = undefined;
			const upsertRaceStart = observedRequests.length;
			raceHook = async () => {
				const winner = await adapter.request({
					method: CalDavMethod.PUT,
					url: upsertUpdated!.json.resourceUrl as string,
					headers: {
						'Content-Type': 'text/calendar; charset=utf-8',
						'If-Match': upsertUpdated!.json.etag as string,
					},
					body: [
						'BEGIN:VCALENDAR',
						'VERSION:2.0',
						'BEGIN:VEVENT',
						`UID:${suppliedUid}`,
						'DTSTAMP:20400101T000000Z',
						'DTSTART:20400615T100000Z',
						'DTEND:20400615T103000Z',
						'SUMMARY:codex e2e issue 57 race winner',
						'END:VEVENT',
						'END:VCALENDAR',
						'',
					].join('\r\n'),
				});
				assertE2e(winner.statusCode === 204 || winner.statusCode === 201);
				raceHook = undefined;
			};
			const [upsertRace] = await execute(
				mutationParameters(selected.url, 'upsert', {
					uid: suppliedUid,
					summary: 'codex e2e issue 57 race loser',
				}),
				true,
			);
			assertE2e(typeof upsertRace?.json.error === 'string');
			const upsertRaceTraffic = observedRequests.slice(upsertRaceStart);
			assertIcloudCandidateScanLookup(upsertRaceTraffic, 1);
			assertSingleFailedConditionalProductPut(upsertRaceTraffic, 'if-match');
			assertE2e(upsertRaceTraffic.every((request) => request.method !== CalDavMethod.DELETE));
			const [upsertWinner] = await execute(
				mutationParameters(selected.url, 'get', {
					identifierMode: 'resourceUrl',
					resourceUrl: upsertUpdated!.json.resourceUrl,
				}),
			);
			assertPrivateRawIcs(upsertWinner!.json, suppliedUid);
			assertE2e(
				typeof upsertWinner!.json.rawIcs === 'string' &&
					upsertWinner!.json.rawIcs.includes('SUMMARY:codex e2e issue 57 race winner'),
			);
			scenarioIds.push('upsert-unique-match-lookup-put-race-terminal-winner-unchanged');

			const createRaceUid = `codex-e2e-57-${runId}-create-race`;
			const createRaceResourceUrl = calendarEventResourceUrlForUid(selected.url, createRaceUid);
			const upsertCreateRaceStart = observedRequests.length;
			let createRaceWinnerCreated = false;
			reportRaceHook = async () => {
				const winner = await adapter.request({
					method: CalDavMethod.PUT,
					url: createRaceResourceUrl,
					headers: {
						'Content-Type': 'text/calendar; charset=utf-8',
						'If-None-Match': '*',
					},
					body: [
						'BEGIN:VCALENDAR',
						'VERSION:2.0',
						'BEGIN:VEVENT',
						`UID:${createRaceUid}`,
						'DTSTAMP:20400101T000000Z',
						'DTSTART:20400615T100000Z',
						'DTEND:20400615T103000Z',
						'SUMMARY:codex e2e issue 57 create race winner',
						'END:VEVENT',
						'END:VCALENDAR',
						'',
					].join('\r\n'),
				});
				assertE2e(winner.statusCode === 204 || winner.statusCode === 201);
				createRaceWinnerCreated = true;
				reportRaceHook = undefined;
			};
			const [upsertCreateRace] = await execute(
				mutationParameters(selected.url, 'upsert', { uid: createRaceUid }),
				true,
			);
			assertE2e(typeof upsertCreateRace?.json.error === 'string');
			if (createRaceWinnerCreated) {
				owned.push({ uid: createRaceUid, resourceUrl: createRaceResourceUrl });
			}
			const upsertCreateRaceTraffic = observedRequests.slice(upsertCreateRaceStart);
			assertIcloudCandidateScanLookup(upsertCreateRaceTraffic, 2);
			assertSingleFailedConditionalProductPut(upsertCreateRaceTraffic, 'if-none-match');
			assertE2e(upsertCreateRaceTraffic.every((request) => request.method !== CalDavMethod.DELETE));
			scenarioIds.push('upsert-create-path-uid-race-terminal-winner-unchanged');

			const alternateResourceUrl = new URL(
				`codex-e2e-57-${runId}-alternate.ics`,
				selected.url,
			).toString();
			let uidConflict: unknown;
			try {
				await createCalendarEventResource(
					transport,
					validateAbsoluteHttpUrl(selected.url),
					validateAbsoluteHttpUrl(alternateResourceUrl),
					[
						'BEGIN:VCALENDAR',
						'VERSION:2.0',
						'BEGIN:VEVENT',
						`UID:${suppliedUid}`,
						'DTSTAMP:20400101T000000Z',
						'DTSTART:20400615T100000Z',
						'DTEND:20400615T103000Z',
						'SUMMARY:codex e2e issue 57 conflict',
						'END:VEVENT',
						'END:VCALENDAR',
						'',
					].join('\r\n'),
				);
				owned.push({ uid: suppliedUid, resourceUrl: alternateResourceUrl });
			} catch (error) {
				uidConflict = error;
			}
			assertE2e(
				(uidConflict instanceof CalDavAuthorizationError && uidConflict.noUidConflict === true) ||
					(uidConflict instanceof CalDavCalendarEventMutationError &&
						uidConflict.code === CalendarEventMutationFailureCode.CREATE_CONFLICT),
			);
			scenarioIds.push('collection-wide-no-uid-conflict-distinct-resource-terminal');
			outcome = 'passed';
		} catch (error) {
			operationFailed = true;
			firstFailure ??= firstFailureEvidence(stage, error, lastHttp);
			errorCodes.push(
				error instanceof IcloudE2eHarnessError
					? error.code
					: IcloudE2eErrorCode.MUTATION_CONFLICT_EXPECTED,
			);
			throw error;
		} finally {
			phase = 'cleanup';
			stage = 'mutation-cleanup';
			lastHttp = undefined;
			let cleanupFailed = false;
			for (const resource of [...owned].reverse()) {
				try {
					let etag: string | undefined;
					const cleanup = await recoverOwnedE2eResource(
						async () => {
							const current = await retryCleanupGet503(async () => {
								lastHttp = undefined;
								const [value] = await execute(
									mutationParameters(calendarUrlForCleanup ?? input.serverUrl, 'get', {
										identifierMode: 'resourceUrl',
										resourceUrl: resource.resourceUrl,
									}),
									true,
								);
								return {
									value,
									statusCode:
										lastHttp?.method === CalDavMethod.GET ? lastHttp.statusCode : undefined,
								};
							});
							const currentEtag = current?.json.etag;
							if (
								current?.json.uid !== resource.uid ||
								typeof currentEtag !== 'string' ||
								currentEtag.length === 0
							) {
								return false;
							}
							etag = currentEtag;
							return true;
						},
						async () => {
							const [deleted] = await execute(
								mutationParameters(calendarUrlForCleanup ?? input.serverUrl, 'delete', {
									identifierMode: 'resourceUrl',
									resourceUrl: resource.resourceUrl,
									etag,
								}),
								true,
							);
							if (deleted?.json.deleted === true) return 'deleted';
							const latestDelete = [...observedRequests]
								.reverse()
								.find(
									(request) =>
										request.phase === 'cleanup' && request.method === CalDavMethod.DELETE,
								);
							return latestDelete?.statusCode === 412 ? 'preconditionFailed' : 'failed';
						},
					);
					if (cleanup !== 'cleaned') {
						cleanupFailed = true;
						firstFailure ??= firstFailureEvidence(
							stage,
							new IcloudE2eHarnessError(IcloudE2eErrorCode.MANUAL_CLEANUP_REQUIRED),
							lastHttp,
						);
					}
				} catch (error) {
					cleanupFailed = true;
					firstFailure ??= firstFailureEvidence(stage, error, lastHttp);
				}
			}
			if (cleanupFailed) {
				errorCodes.push(IcloudE2eErrorCode.MANUAL_CLEANUP_REQUIRED);
				outcome = 'failed';
				firstFailure ??= firstFailureEvidence(
					stage,
					new IcloudE2eHarnessError(IcloudE2eErrorCode.MANUAL_CLEANUP_REQUIRED),
					lastHttp,
				);
			}
			if (incompleteSuppliedUidScan) {
				errorCodes.push(IcloudE2eErrorCode.ASSERTION_FAILED);
				outcome = 'failed';
			}
			const conditionalCleanup = observedRequests
				.filter((request) => request.phase === 'cleanup' && request.method === CalDavMethod.DELETE)
				.every((request) => request.conditional === 'if-match');
			if (!conditionalCleanup) {
				errorCodes.push(IcloudE2eErrorCode.ASSERTION_FAILED);
				outcome = 'failed';
				firstFailure ??= firstFailureEvidence(
					stage,
					new IcloudE2eHarnessError(IcloudE2eErrorCode.ASSERTION_FAILED),
					lastHttp,
				);
			}
			// eslint-disable-next-line no-console -- Aggregate IDs and request shapes contain no live identifiers.
			console.info(
				serializeEvidence({
					schemaVersion: 'icloud-e2e-evidence/v5',
					mode: 'live',
					sourceRevision: MUTATION_CONTRACT_REVISION,
					outcome,
					scenarios: scenarioIds,
					requestMethods: [...new Set(observedMethods)],
					errorCodes,
					...(firstFailure === undefined ? {} : { firstFailure }),
					...(suppliedUidLookup === undefined ? {} : { suppliedUidLookup }),
					cleanupOutcome:
						owned.length === 0
							? 'not-required'
							: cleanupFailed
								? 'manual-cleanup-required'
								: 'cleaned',
				}),
			);
			throwIfCleanupOnlyFailure(
				cleanupFailed,
				operationFailed,
				IcloudE2eErrorCode.MANUAL_CLEANUP_REQUIRED,
			);
			if (!operationFailed && (incompleteSuppliedUidScan || !conditionalCleanup)) assertE2e(false);
		}
	});
});

describe.runIf(liveInput !== undefined)('iCloud E2E live advanced event semantics', () => {
	it('creates, reads, queries, replaces, upserts, and conditionally removes only advanced run-owned resources', async () => {
		const input = liveInput!;
		const observedMethods: CalDavMethod[] = [];
		let lastHttp: SafeHttpObservation | undefined;
		let stage = 'advanced-discovery';
		let firstFailure: ReturnType<typeof firstFailureEvidence> | undefined;
		let operationFailed = false;
		const adapter = liveRequestAdapter(
			input,
			observedMethods,
			[],
			() => 'product',
			undefined,
			undefined,
			(observation) => {
				lastHttp = observation;
			},
		);
		const transport = createCalDavTransport(input.serverUrl, adapter);
		const node = new CalDav();
		const runId = randomUUID();
		const scenarioIds: string[] = [];
		const errorCodes: IcloudE2eErrorCode[] = [];
		let outcome: 'passed' | 'failed' = 'failed';
		const owned: Array<{ readonly uid: string; readonly resourceUrl: string }> = [];
		let selectedCalendarUrl: string | undefined;
		const execute = async (parameters: Readonly<Record<string, unknown>>, continueOnFail = false) =>
			(
				await node.execute.call(liveNodeContext(input, adapter, parameters, continueOnFail))
			)[0] as Array<{ readonly json: Record<string, unknown> }>;

		try {
			const principal = await discoverCurrentUserPrincipal(transport);
			assertE2e(principal.kind === CurrentUserPrincipalDiscoveryKind.AUTHENTICATED);
			const home = await discoverCalendarHome(transport, principal.principalUrl);
			const calendars = await discoverCalendarCollections(
				transport,
				home.calendarHomeUrl,
				defaultCalDavProviderRegistry.select(validateAbsoluteHttpUrl(transport.serverUrl)),
			);
			const selected = selectExactCalendar(
				calendars.map((calendar) => ({
					displayName: calendar.displayName ?? '',
					url: calendar.url,
				})),
				input.calendarDisplayName,
			);
			const calendar = { __rl: true, mode: 'url', value: selected.url };
			selectedCalendarUrl = selected.url;
			const uid = `codex-e2e-58-${runId}-advanced`;
			const rawIcs = [
				'BEGIN:VCALENDAR',
				'VERSION:2.0',
				'PRODID:-//CalDAV E2E//Issue 58//EN',
				'BEGIN:VEVENT',
				`UID:${uid}`,
				'DTSTAMP:20400101T000000Z',
				'DTSTART;VALUE=DATE:20401027',
				'DTEND;VALUE=DATE:20401029',
				'RRULE:FREQ=DAILY;COUNT=2',
				'X-CODEX-E2E-UNKNOWN:preserve',
				'BEGIN:VALARM',
				'ACTION:DISPLAY',
				'TRIGGER:-PT15M',
				'DESCRIPTION:advanced display',
				'END:VALARM',
				'BEGIN:VALARM',
				'ACTION:AUDIO',
				'TRIGGER:-PT30M',
				'END:VALARM',
				'BEGIN:VALARM',
				'ACTION:EMAIL',
				'TRIGGER:-PT45M',
				'SUMMARY:advanced email',
				'DESCRIPTION:advanced email body',
				`ATTENDEE:${emailAlarmRecipient(process.env)}`,
				'END:VALARM',
				'END:VEVENT',
				'END:VCALENDAR',
				'',
			].join('\r\n');
			stage = 'advanced-create';
			lastHttp = undefined;
			const [created] = await execute({
				resource: 'event',
				operation: 'create',
				calendar,
				inputMode: 'rawIcs',
				rawIcs,
			});
			assertE2e(created !== undefined);
			assertCurrentIdentity(created!.json, uid);
			owned.push({ uid, resourceUrl: created!.json.resourceUrl as string });
			scenarioIds.push('advanced-raw-create-current-identity');

			stage = 'advanced-get-after-create';
			lastHttp = undefined;
			const read = await waitForE2eVisibility(
				async () => {
					const [current] = await execute(
						{
							resource: 'event',
							operation: 'get',
							calendar,
							identifierMode: 'resourceUrl',
							resourceUrl: owned[0]!.resourceUrl,
						},
						true,
					);
					if (current?.json.error === 'The calendar event was not found.') return undefined;
					assertE2e(typeof current?.json.error !== 'string');
					return current;
				},
				readVisibilityDelay,
				READ_VISIBILITY_ATTEMPTS,
			);
			assertPrivateRawIcs(read!.json, uid);
			const initialShape = semanticIcsShape(read!.json.rawIcs as string);
			assertE2e(
				initialShape.VALARM === 3 &&
					initialShape.RRULE === 1 &&
					initialShape['X-CODEX-E2E-UNKNOWN'] === 1,
			);
			const initialValues = semanticIcsValues(read!.json.rawIcs as string);
			assertE2e(
				initialValues.RRULE?.includes('FREQ=DAILY;COUNT=2') === true &&
					initialValues.ACTION?.includes('DISPLAY') === true &&
					initialValues.ACTION?.includes('AUDIO') === true &&
					initialValues.ACTION?.includes('EMAIL') === true &&
					initialValues.TRIGGER?.includes('-PT15M') === true &&
					initialValues.TRIGGER?.includes('-PT30M') === true &&
					initialValues.TRIGGER?.includes('-PT45M') === true &&
					initialValues['X-CODEX-E2E-UNKNOWN']?.includes('preserve') === true,
			);
			assertE2e(
				read!.json.timeMode === 'allDay' &&
					read!.json.startDate === '2040-10-27' &&
					read!.json.endDate === '2040-10-29',
			);
			scenarioIds.push('advanced-all-day-recurrence-alarms-unknown-semantic-readback');

			stage = 'advanced-range-after-create';
			lastHttp = undefined;
			await waitForE2eVisibility(
				async () => {
					const queried = await execute({
						resource: 'event',
						operation: 'getMany',
						calendar,
						start: '2040-10-27T00:00:00Z',
						end: '2040-10-29T00:00:00Z',
						returnAll: true,
					});
					return queried.some((item) => item.json.uid === uid) ? queried : undefined;
				},
				readVisibilityDelay,
				READ_VISIBILITY_ATTEMPTS,
			);
			scenarioIds.push('advanced-all-day-half-open-query');

			stage = 'advanced-dst-create';
			lastHttp = undefined;
			const [dstCreated] = await execute(
				mutationParameters(selected.url, 'create', {
					uid: `codex-e2e-58-${runId}-dst`,
					timeZoneMode: 'iana',
					timeZone: 'Europe/Prague',
					start: '2040-03-25T03:30:00+02:00',
					end: '2040-03-25T04:30:00+02:00',
					summary: 'advanced DST wall-time',
				}),
			);
			assertCurrentIdentity(dstCreated!.json);
			owned.push({
				uid: dstCreated!.json.uid as string,
				resourceUrl: dstCreated!.json.resourceUrl as string,
			});
			assertE2e(
				dstCreated!.json.timeZoneMode === 'iana' && dstCreated!.json.timeZone === 'Europe/Prague',
			);
			assertE2e(
				dstCreated!.json.startLocal === '2040-03-25T03:30:00' &&
					dstCreated!.json.endLocal === '2040-03-25T04:30:00',
			);
			scenarioIds.push('advanced-iana-prague-spring-dst-wall-time-readback');

			const replacement = rawIcs.replace(
				'X-CODEX-E2E-UNKNOWN:preserve',
				'X-CODEX-E2E-UNKNOWN:replacement',
			);
			stage = 'advanced-raw-replacement';
			lastHttp = undefined;
			const [updated] = await execute({
				resource: 'event',
				operation: 'update',
				calendar,
				inputMode: 'rawIcs',
				rawIcs: replacement,
				identifierMode: 'resourceUrl',
				resourceUrl: owned[0]!.resourceUrl,
				etag: read!.json.etag,
			});
			assertCurrentIdentity(updated!.json, uid);
			const updatedValues = semanticIcsValues(updated!.json.rawIcs as string);
			assertE2e(
				semanticIcsShape(updated!.json.rawIcs as string)['X-CODEX-E2E-UNKNOWN'] === 1 &&
					updatedValues.RRULE?.includes('FREQ=DAILY;COUNT=2') === true &&
					updatedValues.ACTION?.includes('DISPLAY') === true &&
					updatedValues.ACTION?.includes('AUDIO') === true &&
					updatedValues.ACTION?.includes('EMAIL') === true &&
					updatedValues.TRIGGER?.includes('-PT15M') === true &&
					updatedValues.TRIGGER?.includes('-PT30M') === true &&
					updatedValues.TRIGGER?.includes('-PT45M') === true &&
					updatedValues['X-CODEX-E2E-UNKNOWN']?.includes('replacement') === true,
			);
			scenarioIds.push('advanced-raw-full-replacement-semantic-readback');

			stage = 'advanced-raw-upsert';
			lastHttp = undefined;
			const [upserted] = await execute({
				resource: 'event',
				operation: 'upsert',
				calendar,
				inputMode: 'rawIcs',
				rawIcs: replacement,
			});
			assertE2e(upserted!.json.action === 'update');
			assertCurrentIdentity(upserted!.json, uid);
			owned[0] = { uid, resourceUrl: upserted!.json.resourceUrl as string };
			const upsertedValues = semanticIcsValues(upserted!.json.rawIcs as string);
			assertE2e(
				upsertedValues.RRULE?.includes('FREQ=DAILY;COUNT=2') === true &&
					upsertedValues.ACTION?.includes('DISPLAY') === true &&
					upsertedValues.ACTION?.includes('AUDIO') === true &&
					upsertedValues.ACTION?.includes('EMAIL') === true &&
					upsertedValues.TRIGGER?.includes('-PT15M') === true &&
					upsertedValues.TRIGGER?.includes('-PT30M') === true &&
					upsertedValues.TRIGGER?.includes('-PT45M') === true &&
					upsertedValues['X-CODEX-E2E-UNKNOWN']?.includes('replacement') === true,
			);
			scenarioIds.push('advanced-raw-upsert-update-uid-semantic-readback');
			outcome = 'passed';
		} catch (error) {
			operationFailed = true;
			firstFailure = firstFailureEvidence(stage, error, lastHttp);
			errorCodes.push(
				error instanceof IcloudE2eHarnessError ? error.code : IcloudE2eErrorCode.ASSERTION_FAILED,
			);
			throw error;
		} finally {
			stage = 'advanced-cleanup';
			lastHttp = undefined;
			if (selectedCalendarUrl !== undefined) {
				let cleanupFailed = false;
				for (const resource of [...owned].reverse()) {
					try {
						let cleanupEtag: string | undefined;
						const cleanup = await recoverOwnedE2eResource(
							async () => {
								const current = await retryCleanupGet503(async () => {
									lastHttp = undefined;
									const [value] = await execute(
										{
											resource: 'event',
											operation: 'get',
											calendar: { __rl: true, mode: 'url', value: selectedCalendarUrl },
											identifierMode: 'resourceUrl',
											resourceUrl: resource.resourceUrl,
										},
										true,
									);
									return {
										value,
										statusCode:
											lastHttp?.method === CalDavMethod.GET ? lastHttp.statusCode : undefined,
									};
								});
								const currentEtag = current?.json.etag;
								if (
									current?.json.uid !== resource.uid ||
									typeof currentEtag !== 'string' ||
									currentEtag.length === 0
								) {
									return false;
								}
								cleanupEtag = currentEtag;
								return true;
							},
							async () => {
								const [deleted] = await execute(
									{
										resource: 'event',
										operation: 'delete',
										calendar: { __rl: true, mode: 'url', value: selectedCalendarUrl },
										identifierMode: 'resourceUrl',
										resourceUrl: resource.resourceUrl,
										etag: cleanupEtag,
									},
									true,
								);
								return deleted?.json.deleted === true ? 'deleted' : 'failed';
							},
						);
						if (cleanup !== 'cleaned') {
							cleanupFailed = true;
							firstFailure ??= firstFailureEvidence(
								stage,
								new IcloudE2eHarnessError(IcloudE2eErrorCode.MANUAL_CLEANUP_REQUIRED),
								lastHttp,
							);
						}
					} catch (error) {
						cleanupFailed = true;
						firstFailure ??= firstFailureEvidence(stage, error, lastHttp);
					}
				}
				if (cleanupFailed) {
					errorCodes.push(IcloudE2eErrorCode.MANUAL_CLEANUP_REQUIRED);
					outcome = 'failed';
					firstFailure ??= firstFailureEvidence(
						stage,
						new IcloudE2eHarnessError(IcloudE2eErrorCode.MANUAL_CLEANUP_REQUIRED),
						lastHttp,
					);
				}
			}
			// eslint-disable-next-line no-console -- The opt-in live suite emits its public-safe evidence record for CI artifacts.
			console.info(
				serializeEvidence({
					schemaVersion: 'icloud-e2e-evidence/v5',
					mode: 'live',
					sourceRevision: ADVANCED_EVENT_CONTRACT_REVISION,
					outcome,
					scenarios: scenarioIds,
					requestMethods: [...new Set(observedMethods)],
					errorCodes,
					...(firstFailure === undefined ? {} : { firstFailure }),
					cleanupOutcome:
						owned.length === 0
							? 'not-required'
							: errorCodes.includes(IcloudE2eErrorCode.MANUAL_CLEANUP_REQUIRED)
								? 'manual-cleanup-required'
								: 'cleaned',
				}),
			);
			throwIfCleanupOnlyFailure(
				errorCodes.includes(IcloudE2eErrorCode.MANUAL_CLEANUP_REQUIRED),
				operationFailed,
				IcloudE2eErrorCode.MANUAL_CLEANUP_REQUIRED,
			);
		}
	});
});
