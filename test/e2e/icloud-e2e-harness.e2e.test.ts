// The live adapter intentionally adapts real HTTP streams to the production transport.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
/* eslint-disable @n8n/community-nodes/no-restricted-globals, @n8n/community-nodes/require-node-api-error -- The opt-in test suite reads its own live-run environment and models transport failures without an n8n execution context. */

import { describe, expect, it } from 'vitest';

import { discoverCalendarsForCurrentUser } from '../../nodes/CalDav/discovery/calendarDiscovery';
import { createCalendarEvent } from '../../nodes/CalDav/events/create';
import { getCalendarEventByResourceUrl } from '../../nodes/CalDav/events/getByResourceUrl';
import {
	CalendarEventMutationFailureCode,
	deleteCalendarEventResource,
} from '../../nodes/CalDav/events/mutations';
import { resolveCalendarEventByUid } from '../../nodes/CalDav/events/resolveByUid';
import { queryCalendarEventsByTimeRange } from '../../nodes/CalDav/events/timeRangeQuery';
import { updateCalendarEvent } from '../../nodes/CalDav/events/update';
import type { CalendarEventPatch } from '../../nodes/CalDav/icalendar/patcher';
import { canonicalizeIanaTimeZone } from '../../nodes/CalDav/icalendar/timeZones';

import {
	CalDavNotFoundError,
	createCalDavTransport,
	type CalDavRequestHelperAdapter,
	type N8nCalDavRequestOptions,
} from '../../nodes/CalDav/transport/http';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';

import {
	assertE2e,
	cleanupOwnedEvents,
	countCreatedResources,
	createOrRecoverOwnedEvent,
	createRunIdentity,
	cleanupOwnedEvent,
	IcloudE2eErrorCode,
	IcloudE2eHarnessError,
	type IcloudE2ePendingOwnershipIntent,
	readIcloudE2eInput,
	selectExactCalendar,
	serializeEvidence,
	throwIfCleanupEscalated,
	type IcloudE2eEvent,
	type IcloudE2eTransport,
} from './support/icloud-e2e-harness';

const CONTRACT_REVISION = 'issue-54-contract-r1';
const liveClock = (): Date => new Date();

function liveInputOrUndefined(): ReturnType<typeof readIcloudE2eInput> | undefined {
	if (process.env.CALDAV_ICLOUD_E2E_OPT_IN !== '1') return undefined;
	return readIcloudE2eInput(process.env);
}

function liveRequestAdapter(
	input: ReturnType<typeof readIcloudE2eInput>,
): CalDavRequestHelperAdapter {
	return {
		async request(options: N8nCalDavRequestOptions) {
			const body =
				typeof options.body === 'string'
					? options.body
					: Buffer.isBuffer(options.body)
						? options.body.toString('utf8')
						: undefined;
			const response = await fetch(options.url, {
				method: options.method,
				headers: {
					...options.headers,
					Authorization: `Basic ${Buffer.from(`${input.username}:${input.appPassword}`, 'utf8').toString('base64')}`,
				},
				...(body === undefined ? {} : { body }),
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

function toOwnedEvent(
	event: Awaited<ReturnType<typeof getCalendarEventByResourceUrl>>['event'],
): IcloudE2eEvent {
	if (event.etag === undefined || event.summary === undefined) {
		throw new IcloudE2eHarnessError(IcloudE2eErrorCode.OWNERSHIP_PROOF_FAILED);
	}
	const runId = /^\[n8n-caldav-e2e ([0-9a-f-]{36})\]/i.exec(event.summary)?.[1];
	if (runId === undefined)
		throw new IcloudE2eHarnessError(IcloudE2eErrorCode.OWNERSHIP_PROOF_FAILED);
	return {
		url: event.resourceUrl,
		etag: event.etag,
		uid: event.uid,
		title: event.summary,
		runId,
		parentUrl: event.calendarUrl,
	};
}

function futureTimedBounds(): { start: Date; end: Date } {
	const start = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000);
	start.setUTCHours(10, 0, 0, 0);
	return { start, end: new Date(start.getTime() + 60 * 60 * 1000) };
}

function futureAllDayBounds(): { startDate: string; endDate: string } {
	const start = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
	const startDate = start.toISOString().slice(0, 10);
	const endDate = new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
	return { startDate, endDate };
}

function expectHarnessError(action: () => void, code: IcloudE2eErrorCode): void {
	try {
		action();
	} catch (error) {
		expect(error).toMatchObject({ code });
		return;
	}
	throw new Error('The E2E harness did not reject the invalid input.');
}

const calendarUrl = 'https://caldav.example.test/calendars/dedicated/';
const runId = 'f0b1c2d3-e4f5-4a67-8b9c-0d1e2f3a4b5c';
const titlePrefix = `[n8n-caldav-e2e ${runId}]`;
const owned: IcloudE2eEvent = {
	url: `${calendarUrl}owned.ics`,
	etag: '"one"',
	uid: `${runId}-timed`,
	title: `${titlePrefix} timed`,
	runId,
	parentUrl: calendarUrl,
};

function fakeTransport(overrides: Partial<IcloudE2eTransport> = {}): IcloudE2eTransport {
	return {
		listCalendars: async () => [{ displayName: 'Dedicated', url: calendarUrl }],
		create: async (input) => ({ ...owned, ...input }),
		reportByUid: async () => [owned],
		get: async () => undefined,
		delete: async () => 'deleted',
		...overrides,
	};
}

describe('iCloud E2E test harness contract (fake transport)', () => {
	it('requires explicit opt-in and exact, credential-free input boundaries', () => {
		expect(() => readIcloudE2eInput({})).toThrow(IcloudE2eHarnessError);
		expect(() => readIcloudE2eInput({ CALDAV_ICLOUD_E2E_OPT_IN: 'true' })).toThrow(
			IcloudE2eHarnessError,
		);
		expect(() =>
			readIcloudE2eInput({
				CALDAV_ICLOUD_E2E_OPT_IN: '1',
				CALDAV_ICLOUD_E2E_SERVER_URL: 'https://user:secret@example.test/',
				CALDAV_ICLOUD_E2E_USERNAME: 'user',
				CALDAV_ICLOUD_E2E_APP_PASSWORD: 'secret',
				CALDAV_ICLOUD_E2E_CALENDAR_DISPLAY_NAME: 'Dedicated',
			}),
		).toThrow(IcloudE2eHarnessError);
		expect(() =>
			readIcloudE2eInput({
				CALDAV_ICLOUD_E2E_OPT_IN: '1',
				CALDAV_ICLOUD_E2E_SERVER_URL: 'http://caldav.example.test/',
				CALDAV_ICLOUD_E2E_USERNAME: 'user',
				CALDAV_ICLOUD_E2E_APP_PASSWORD: 'secret',
				CALDAV_ICLOUD_E2E_CALENDAR_DISPLAY_NAME: 'Dedicated',
			}),
		).toThrow(IcloudE2eHarnessError);
		expect(() =>
			readIcloudE2eInput({
				CALDAV_ICLOUD_E2E_OPT_IN: '1',
				CALDAV_ICLOUD_E2E_SERVER_URL: 'https://caldav.example.test/account#private-fragment',
				CALDAV_ICLOUD_E2E_USERNAME: 'user',
				CALDAV_ICLOUD_E2E_APP_PASSWORD: 'secret',
				CALDAV_ICLOUD_E2E_CALENDAR_DISPLAY_NAME: 'Dedicated',
			}),
		).toThrow(IcloudE2eHarnessError);
		expectHarnessError(
			() =>
				readIcloudE2eInput({
					CALDAV_ICLOUD_E2E_OPT_IN: '1',
					CALDAV_ICLOUD_E2E_SERVER_URL:
						'https://caldav.example.test/account#private-fragment-before-credentials',
				}),
			IcloudE2eErrorCode.INPUT_INVALID,
		);
	});

	it('selects a calendar only by exact display name and canonical URL identity', () => {
		expect(
			selectExactCalendar([{ displayName: 'Dedicated', url: calendarUrl }], 'Dedicated').url,
		).toBe(calendarUrl);
		expectHarnessError(
			() => selectExactCalendar([{ displayName: 'dedicated', url: calendarUrl }], 'Dedicated'),
			IcloudE2eErrorCode.CALENDAR_NOT_FOUND,
		);
		expectHarnessError(
			() =>
				selectExactCalendar(
					[
						{ displayName: 'Dedicated', url: calendarUrl },
						{ displayName: 'Dedicated', url: `${calendarUrl}other/` },
					],
					'Dedicated',
				),
			IcloudE2eErrorCode.CALENDAR_AMBIGUOUS,
		);
	});

	it('uses UUIDv4 run identities and adopts exactly one ownership-proven ambiguous create result', async () => {
		expect(createRunIdentity(() => runId)).toMatchObject({ runId, titlePrefix });
		const pending: IcloudE2ePendingOwnershipIntent[] = [];
		const calls: string[] = [];
		const adopted = await createOrRecoverOwnedEvent(
			fakeTransport({
				create: async () => {
					calls.push('put');
					throw new Error('response lost');
				},
				reportByUid: async () => {
					calls.push('report');
					return [owned];
				},
			}),
			calendarUrl,
			{ uid: owned.uid, title: owned.title, runId, parentUrl: calendarUrl },
			titlePrefix,
			(intent) => {
				calls.push('intent');
				pending.push(intent);
			},
		);
		expect(adopted).toEqual(owned);
		expect(pending).toEqual([
			{ uid: owned.uid, title: owned.title, runId, parentUrl: calendarUrl },
		]);
		expect(calls).toEqual(['intent', 'put', 'report']);
		await expect(
			createOrRecoverOwnedEvent(
				fakeTransport({
					create: async () => {
						throw new Error('response lost');
					},
					reportByUid: async () => [owned, owned],
				}),
				calendarUrl,
				{ uid: owned.uid, title: owned.title, runId, parentUrl: calendarUrl },
				titlePrefix,
			),
		).rejects.toMatchObject({ code: IcloudE2eErrorCode.CREATE_RECOVERY_UNVERIFIABLE });
	});

	it('recovers an ownership-unproven create response once, then leaves an unresolved intent for manual cleanup', async () => {
		let reports = 0;
		const pending: IcloudE2ePendingOwnershipIntent[] = [];
		await expect(
			createOrRecoverOwnedEvent(
				fakeTransport({
					create: async () => ({ ...owned, parentUrl: 'https://caldav.example.test/other/' }),
					reportByUid: async () => {
						reports += 1;
						return [];
					},
				}),
				calendarUrl,
				{ uid: owned.uid, title: owned.title, runId, parentUrl: calendarUrl },
				titlePrefix,
				(intent) => pending.push(intent),
			),
		).rejects.toMatchObject({ code: IcloudE2eErrorCode.CREATE_RECOVERY_UNVERIFIABLE });
		expect(reports).toBe(1);
		expect(pending).toEqual([
			{ uid: owned.uid, title: owned.title, runId, parentUrl: calendarUrl },
		]);
	});

	it('registers a recovered all-day create for ownership-checked cleanup', async () => {
		const cleanupLedger: IcloudE2eEvent[] = [];
		const allDay = { ...owned, uid: `${runId}-all-day`, title: `${titlePrefix} all-day` };
		const recovered = await createOrRecoverOwnedEvent(
			fakeTransport({
				create: async () => {
					throw new Error('post-PUT response lost');
				},
				reportByUid: async (_selectedCalendarUrl, uid) => (uid === allDay.uid ? [allDay] : []),
			}),
			calendarUrl,
			{ uid: allDay.uid, title: allDay.title, runId, parentUrl: calendarUrl },
			titlePrefix,
		);
		cleanupLedger.push(recovered);
		expect(cleanupLedger).toEqual([allDay]);
		expect(countCreatedResources([], 0)).toBe(0);
		expect(countCreatedResources(cleanupLedger, 0)).toBe(1);
		expect(countCreatedResources(cleanupLedger, 1)).toBe(2);
		await expect(
			cleanupOwnedEvent(
				fakeTransport({ delete: async () => 'deleted', get: async () => undefined }),
				cleanupLedger[0]!,
				calendarUrl,
				titlePrefix,
			),
		).resolves.toEqual({ status: 'verified', attempts: 1 });
	});

	it('requires recovery ownership proof for the exact resource, UID/run ID, title prefix, and ETag', async () => {
		const unsafeEvents: IcloudE2eEvent[] = [
			{ ...owned, parentUrl: 'https://caldav.example.test/calendars/other/' },
			{ ...owned, url: `${calendarUrl}nested/owned.ics` },
			{ ...owned, uid: `${runId}-other` },
			{ ...owned, runId: '00000000-0000-4000-8000-000000000000' },
			{ ...owned, title: 'unowned event' },
			{ ...owned, etag: '' },
		];

		for (const unsafe of unsafeEvents) {
			await expect(
				createOrRecoverOwnedEvent(
					fakeTransport({ create: async () => unsafe, reportByUid: async () => [] }),
					calendarUrl,
					{ uid: owned.uid, title: owned.title, runId, parentUrl: calendarUrl },
					titlePrefix,
				),
			).rejects.toMatchObject({ code: IcloudE2eErrorCode.CREATE_RECOVERY_UNVERIFIABLE });
		}
	});

	it('rejects a same-origin sibling and a non-collection calendar URL as ownership proof', async () => {
		const sibling = {
			...owned,
			url: 'https://caldav.example.test/calendars/dedicated-sibling.ics',
		};
		await expect(
			createOrRecoverOwnedEvent(
				fakeTransport({ create: async () => sibling, reportByUid: async () => [] }),
				calendarUrl,
				{ uid: sibling.uid, title: sibling.title, runId, parentUrl: calendarUrl },
				titlePrefix,
			),
		).rejects.toMatchObject({ code: IcloudE2eErrorCode.CREATE_RECOVERY_UNVERIFIABLE });
		await expect(
			createOrRecoverOwnedEvent(
				fakeTransport({
					create: async (input) => ({
						...owned,
						...input,
						url: `${calendarUrl}owned.ics`,
					}),
				}),
				calendarUrl.slice(0, -1),
				{ uid: owned.uid, title: owned.title, runId, parentUrl: calendarUrl.slice(0, -1) },
				titlePrefix,
			),
		).rejects.toMatchObject({ code: IcloudE2eErrorCode.CREATE_RECOVERY_UNVERIFIABLE });
	});

	it('makes manual cleanup fail after evidence unless an earlier primary failure is in flight', async () => {
		expect(() => throwIfCleanupEscalated('manual-cleanup-required', undefined)).toThrow(
			IcloudE2eHarnessError,
		);
		const primaryFailure = new Error('primary failure');
		const runWithPrimaryFailure = async (): Promise<void> => {
			let capturedPrimaryFailure: unknown;
			try {
				throw primaryFailure;
			} catch (error) {
				capturedPrimaryFailure = error;
				throw error;
			} finally {
				throwIfCleanupEscalated('manual-cleanup-required', capturedPrimaryFailure);
			}
		};
		await expect(runWithPrimaryFailure()).rejects.toBe(primaryFailure);
	});

	it('keeps manual cleanup required when a later owned event is verified', async () => {
		const cleaned: string[] = [];
		const summary = await cleanupOwnedEvents(
			[owned, { ...owned, uid: `${runId}-second`, url: `${calendarUrl}second.ics` }],
			async (event) => {
				cleaned.push(event.uid);
				return {
					status: event.uid === owned.uid ? 'manual-cleanup-required' : 'verified',
					attempts: 1,
				};
			},
		);
		expect(cleaned).toEqual([owned.uid, `${runId}-second`]);
		expect(summary).toEqual({
			cleanup: 'manual-cleanup-required',
			manualCleanupRequired: 1,
			errorCodes: [IcloudE2eErrorCode.CLEANUP_INCOMPLETE],
		});
		expect(() => throwIfCleanupEscalated(summary.cleanup, undefined)).toThrow(
			IcloudE2eHarnessError,
		);
	});

	it('continues cleanup after a transport failure and preserves privacy-safe failure evidence', async () => {
		const second = { ...owned, uid: `${runId}-second`, url: `${calendarUrl}second.ics` };
		const cleaned: string[] = [];
		const summary = await cleanupOwnedEvents([owned, second], async (event) => {
			cleaned.push(event.uid);
			if (event.uid === owned.uid) throw new Error('transport response contained private data');
			return { status: 'verified', attempts: 1 };
		});
		const evidence = serializeEvidence({
			schemaVersion: 'icloud-e2e-evidence/v1',
			mode: 'fake',
			runId,
			sourceRevision: CONTRACT_REVISION,
			outcome: 'manual-cleanup-required',
			scenarios: ['cleanup'],
			counts: { created: 2, deleted: 1, deleteAttempts: 2 },
			resources: {
				planned: 2,
				created: 2,
				adoptedAfterAmbiguousCreate: 0,
				deleted: 1,
				alreadyAbsent: 0,
				manualCleanupRequired: summary.manualCleanupRequired,
			},
			cleanup: summary.cleanup,
			errorCodes: summary.errorCodes,
		});
		expect(cleaned).toEqual([owned.uid, second.uid]);
		expect(summary).toEqual({
			cleanup: 'manual-cleanup-required',
			manualCleanupRequired: 1,
			errorCodes: [IcloudE2eErrorCode.TRANSPORT_FAILED],
		});
		expect(evidence).toMatch(/^ICLOUD_E2E_EVIDENCE /);
		expect(evidence).not.toContain('private data');
		expect(evidence).not.toContain(calendarUrl);
		expect(() => throwIfCleanupEscalated(summary.cleanup, undefined)).toThrow(
			IcloudE2eHarnessError,
		);
	});

	it('maps a failed harness assertion to its stable public-safe error code', () => {
		expectHarnessError(() => assertE2e(false), IcloudE2eErrorCode.ASSERTION_FAILED);
	});

	it('retries stale conditional cleanup at most twice and verifies a deleted resource as absent', async () => {
		let deletes = 0;
		const result = await cleanupOwnedEvent(
			fakeTransport({
				delete: async () => (++deletes < 3 ? 'stale' : 'notFound'),
				get: async () => ({ ...owned, etag: `"${deletes}"` }),
			}),
			owned,
			calendarUrl,
			titlePrefix,
		);
		expect(result).toEqual({ status: 'verified', attempts: 3 });
		expect(deletes).toBe(3);
	});

	it('verifies cleanup when a stale delete is followed by a fresh absent GET', async () => {
		const result = await cleanupOwnedEvent(
			fakeTransport({ delete: async () => 'stale', get: async () => undefined }),
			owned,
			calendarUrl,
			titlePrefix,
		);
		expect(result).toEqual({ status: 'verified', attempts: 1 });
	});

	it('reports manual-cleanup-required after the bounded stale retry budget and emits private-safe evidence', async () => {
		let gets = 0;
		const result = await cleanupOwnedEvent(
			fakeTransport({
				delete: async () => 'stale',
				get: async () => ({ ...owned, etag: `"${++gets}"` }),
			}),
			owned,
			calendarUrl,
			titlePrefix,
		);
		expect(result).toEqual({ status: 'manual-cleanup-required', attempts: 3 });
		expect(gets).toBe(2);
		const evidence = serializeEvidence({
			schemaVersion: 'icloud-e2e-evidence/v1',
			mode: 'fake',
			runId,
			sourceRevision: 'issue-54-contract-r1',
			outcome: 'manual-cleanup-required',
			scenarios: ['cleanup'],
			counts: { created: 1, deleted: 0, deleteAttempts: 3 },
			resources: {
				planned: 1,
				created: 1,
				adoptedAfterAmbiguousCreate: 0,
				deleted: 0,
				alreadyAbsent: 0,
				manualCleanupRequired: 1,
			},
			cleanup: result.status,
			errorCodes: [IcloudE2eErrorCode.CLEANUP_INCOMPLETE],
		});
		expect(evidence).toMatch(/^ICLOUD_E2E_EVIDENCE /);
		expect(evidence).not.toContain('CALDAV_ICLOUD_E2E_APP_PASSWORD');
		expect(evidence).not.toContain(calendarUrl);
		expect(evidence).not.toContain(owned.title);
	});

	it('uses a clocked production mutation signature with an offline request adapter', async () => {
		const methods: string[] = [];
		let clockCalls = 0;
		const adapter: CalDavRequestHelperAdapter = {
			request: async (options) => {
				methods.push(options.method);
				if (options.method === 'GET') {
					return {
						statusCode: 200,
						headers: { etag: '"clocked"' },
						body: Readable.from(
							Buffer.from(
								[
									'BEGIN:VCALENDAR',
									'VERSION:2.0',
									'BEGIN:VEVENT',
									`UID:${runId}-clocked-update`,
									'DTSTAMP:20400101T000000Z',
									'DTSTART:20400201T100000Z',
									'DTEND:20400201T110000Z',
									'SUMMARY:Before offline update',
									'END:VEVENT',
									'END:VCALENDAR',
									'',
								].join('\r\n'),
							),
						),
					};
				}
				throw new Error('offline adapter');
			},
		};
		const transport = createCalDavTransport('https://caldav.example.test/', adapter);
		const clock = () => {
			clockCalls += 1;
			return new Date('2040-01-01T00:00:00.000Z');
		};
		const calendar = validateAbsoluteHttpUrl(calendarUrl);
		await expect(
			createCalendarEvent(
				transport,
				{
					calendarUrl: calendar,
					uid: `${runId}-clocked-create`,
					timeMode: 'timed',
					start: new Date('2040-02-01T10:00:00.000Z'),
					end: new Date('2040-02-01T11:00:00.000Z'),
					summary: `${titlePrefix} clocked create`,
				},
				clock,
			),
		).rejects.toBeInstanceOf(Error);
		await expect(
			updateCalendarEvent(
				transport,
				{
					calendarUrl: calendar,
					identifier: {
						kind: 'resourceUrl',
						resourceUrl: `${calendarUrl}clocked-update.ics`,
					},
					etag: '"clocked"',
					patch: { summary: { kind: 'set', value: `${titlePrefix} clocked update` } },
				},
				clock,
			),
		).rejects.toBeInstanceOf(Error);
		expect(methods).toEqual(['PUT', 'GET', 'PUT']);
		expect(clockCalls).toBe(2);
	});
});

const liveInput = liveInputOrUndefined();

describe.runIf(liveInput !== undefined)('iCloud E2E live interoperability', () => {
	it('uses production discovery and event services without touching resources outside this run', async () => {
		const input = liveInput!;
		const identity = createRunIdentity(randomUUID);
		const scenarios: string[] = [];
		const created: IcloudE2eEvent[] = [];
		const pendingOwnershipIntents: IcloudE2ePendingOwnershipIntent[] = [];
		let deleted = 0;
		let deleteAttempts = 0;
		let cleanup: 'verified' | 'manual-cleanup-required' | 'not-needed' = 'not-needed';
		let outcome: 'passed' | 'failed' | 'manual-cleanup-required' = 'failed';
		const errorCodes: IcloudE2eErrorCode[] = [];
		const resources = {
			planned: 2,
			created: 0,
			adoptedAfterAmbiguousCreate: 0,
			deleted: 0,
			alreadyAbsent: 0,
			manualCleanupRequired: 0,
		};
		const transport = createCalDavTransport(input.serverUrl, liveRequestAdapter(input));
		let primaryFailure: unknown;
		let calendarUrl: ReturnType<typeof validateAbsoluteHttpUrl> | undefined;
		const timedBounds = futureTimedBounds();
		const allDayBounds = futureAllDayBounds();
		const registerPendingOwnershipIntent = (intent: IcloudE2ePendingOwnershipIntent): void => {
			pendingOwnershipIntents.push(intent);
		};
		const confirmPendingOwnershipIntent = (event: IcloudE2eEvent): void => {
			const index = pendingOwnershipIntents.findIndex((intent) => intent.uid === event.uid);
			assertE2e(index !== -1);
			pendingOwnershipIntents.splice(index, 1);
		};

		const cleanupTransport: IcloudE2eTransport = {
			listCalendars: async () => [],
			create: async (event) => {
				if (calendarUrl === undefined) {
					throw new IcloudE2eHarnessError(IcloudE2eErrorCode.OWNERSHIP_PROOF_FAILED);
				}
				if (event.uid.endsWith('-timed')) {
					return toOwnedEvent(
						await createCalendarEvent(
							transport,
							{
								calendarUrl,
								uid: event.uid,
								timeMode: 'timed',
								start: timedBounds.start,
								end: timedBounds.end,
								timeZone: {
									timeZoneMode: 'iana',
									timeZone: canonicalizeIanaTimeZone('Europe/Prague'),
								},
								summary: event.title,
								recurrence: { frequency: 'daily', end: { kind: 'count', count: 2 } },
								alarms: [
									{
										action: 'display',
										trigger: { reference: 'start', direction: 'before', value: 15, unit: 'minute' },
										description: 'n8n CalDAV E2E reminder',
									},
								],
							},
							liveClock,
						),
					);
				}
				if (event.uid.endsWith('-all-day')) {
					return toOwnedEvent(
						await createCalendarEvent(
							transport,
							{
								calendarUrl,
								uid: event.uid,
								timeMode: 'allDay',
								startDate: allDayBounds.startDate as never,
								endDate: allDayBounds.endDate as never,
								summary: event.title,
							},
							liveClock,
						),
					);
				}
				throw new IcloudE2eHarnessError(IcloudE2eErrorCode.OWNERSHIP_PROOF_FAILED);
			},
			reportByUid: async (selectedCalendarUrl, uid) => {
				const resolved = await resolveCalendarEventByUid(
					transport,
					validateAbsoluteHttpUrl(selectedCalendarUrl),
					uid,
				);
				resources.adoptedAfterAmbiguousCreate += 1;
				return [toOwnedEvent(resolved.event)];
			},
			get: async (url) => {
				if (calendarUrl === undefined) return undefined;
				try {
					return toOwnedEvent(
						(
							await getCalendarEventByResourceUrl(
								transport,
								calendarUrl,
								validateAbsoluteHttpUrl(url),
							)
						).event,
					);
				} catch (error) {
					if (error instanceof CalDavNotFoundError) return undefined;
					throw error;
				}
			},
			delete: async (url, etag) => {
				if (calendarUrl === undefined) return 'notFound';
				deleteAttempts += 1;
				try {
					await deleteCalendarEventResource(
						transport,
						calendarUrl,
						validateAbsoluteHttpUrl(url),
						etag,
					);
					deleted += 1;
					resources.deleted += 1;
					return 'deleted';
				} catch (error) {
					if (
						error instanceof Error &&
						'code' in error &&
						error.code === CalendarEventMutationFailureCode.CONCURRENCY_CONFLICT
					) {
						return 'stale';
					}
					if (error instanceof CalDavNotFoundError) {
						resources.alreadyAbsent += 1;
						return 'notFound';
					}
					throw error;
				}
			},
		};

		try {
			const selected = selectExactCalendar(
				(await discoverCalendarsForCurrentUser(transport)).map((calendar) => ({
					displayName: calendar.displayName ?? '',
					url: calendar.url,
				})),
				input.calendarDisplayName,
			);
			calendarUrl = validateAbsoluteHttpUrl(selected.url);
			scenarios.push('discover-calendar');

			const timedUid = `${identity.uidPrefix}timed`;
			const timedTitle = `${identity.titlePrefix} timed`;
			const timedOwned = await createOrRecoverOwnedEvent(
				cleanupTransport,
				calendarUrl,
				{ uid: timedUid, title: timedTitle, runId: identity.runId, parentUrl: calendarUrl },
				identity.titlePrefix,
				registerPendingOwnershipIntent,
			);
			confirmPendingOwnershipIntent(timedOwned);
			created.push(timedOwned);
			resources.created = countCreatedResources(created, deleted);
			const timed = await getCalendarEventByResourceUrl(transport, calendarUrl, timedOwned.url);
			const timedByUrl = await getCalendarEventByResourceUrl(
				transport,
				calendarUrl,
				timed.resourceUrl,
			);
			const timedByUid = await resolveCalendarEventByUid(transport, calendarUrl, timedUid);
			const timedMany = await queryCalendarEventsByTimeRange(transport, calendarUrl, {
				start: new Date(timedBounds.start.getTime() - 60_000),
				end: new Date(timedBounds.end.getTime() + 2 * 24 * 60 * 60 * 1000),
			});
			assertE2e(
				timedByUrl.event.resourceUrl === timed.resourceUrl &&
					timedByUrl.event.uid === timedUid &&
					timedByUrl.event.timeMode === 'timed' &&
					timedByUrl.event.timeZoneMode === 'iana' &&
					timedByUrl.event.timeZone === 'Europe/Prague' &&
					timedByUrl.event.recurrence?.frequency === 'daily' &&
					timedByUrl.event.recurrence.end?.kind === 'count' &&
					timedByUrl.event.recurrence.end.count === 2,
			);
			assertE2e(timedByUid.event.resourceUrl === timed.resourceUrl);
			assertE2e(timedMany.filter(({ event }) => event.uid === timedUid).length === 1);
			assertE2e(timedByUrl.event.alarms?.some((alarm) => alarm.action === 'display'));
			scenarios.push('timed-round-trip');

			const allDayUid = `${identity.uidPrefix}all-day`;
			const allDay = await createOrRecoverOwnedEvent(
				cleanupTransport,
				calendarUrl,
				{
					uid: allDayUid,
					title: `${identity.titlePrefix} all-day`,
					runId: identity.runId,
					parentUrl: calendarUrl,
				},
				identity.titlePrefix,
				registerPendingOwnershipIntent,
			);
			confirmPendingOwnershipIntent(allDay);
			created.push(allDay);
			resources.created = countCreatedResources(created, deleted);
			const readAllDay = await getCalendarEventByResourceUrl(
				transport,
				calendarUrl,
				allDay.resourceUrl,
			);
			assertE2e(
				readAllDay.event.uid === allDayUid &&
					readAllDay.event.timeMode === 'allDay' &&
					readAllDay.event.startDate === allDayBounds.startDate &&
					readAllDay.event.endDate === allDayBounds.endDate,
			);
			scenarios.push('all-day-round-trip');

			const updated = await updateCalendarEvent(
				transport,
				{
					calendarUrl,
					identifier: { kind: 'resourceUrl', resourceUrl: timed.resourceUrl },
					etag: timed.etag,
					patch: { summary: { kind: 'set', value: `${timedTitle} updated` } } as CalendarEventPatch,
				},
				liveClock,
			);
			created[0] = toOwnedEvent(updated);
			assertE2e(updated.summary === `${timedTitle} updated`);
			scenarios.push('conditional-update');

			let staleConflict = false;
			try {
				await updateCalendarEvent(
					transport,
					{
						calendarUrl,
						identifier: { kind: 'resourceUrl', resourceUrl: timed.resourceUrl },
						etag: timed.etag,
						patch: { summary: { kind: 'set', value: `${timedTitle} stale` } } as CalendarEventPatch,
					},
					liveClock,
				);
			} catch (error) {
				staleConflict =
					error instanceof Error &&
					'code' in error &&
					error.code === CalendarEventMutationFailureCode.CONCURRENCY_CONFLICT;
			}
			assertE2e(staleConflict);
			scenarios.push('stale-etag-conflict');

			const allDayCleanup = await cleanupOwnedEvent(
				cleanupTransport,
				allDay,
				calendarUrl,
				identity.titlePrefix,
			);
			assertE2e(allDayCleanup.status === 'verified');
			created.splice(1, 1);
			assertE2e((await cleanupTransport.get(allDay.resourceUrl)) === undefined);
			scenarios.push('conditional-delete');
			outcome = 'passed';
		} catch (error) {
			primaryFailure = error;
			if (error instanceof IcloudE2eHarnessError) errorCodes.push(error.code);
			throw error;
		} finally {
			const cleanupSummary = await cleanupOwnedEvents([...created], (event) =>
				cleanupOwnedEvent(
					cleanupTransport,
					event,
					calendarUrl ?? event.parentUrl,
					identity.titlePrefix,
				),
			);
			cleanup = cleanupSummary.cleanup;
			resources.manualCleanupRequired += cleanupSummary.manualCleanupRequired;
			errorCodes.push(...cleanupSummary.errorCodes);
			if (pendingOwnershipIntents.length > 0) {
				// These intents never enter the deletion ledger: their recovery did
				// not prove a unique, owned resource URL, so deleting would be a guess.
				cleanup = 'manual-cleanup-required';
				resources.manualCleanupRequired += pendingOwnershipIntents.length;
				errorCodes.push(
					...pendingOwnershipIntents.map(() => IcloudE2eErrorCode.CREATE_RECOVERY_UNVERIFIABLE),
				);
			}
			if (cleanup === 'manual-cleanup-required') outcome = 'manual-cleanup-required';
			scenarios.push('cleanup');
			// eslint-disable-next-line no-console -- Live evidence is deliberately emitted to the manually dispatched job log.
			console.info(
				serializeEvidence({
					schemaVersion: 'icloud-e2e-evidence/v1',
					mode: 'live',
					runId: identity.runId,
					sourceRevision: CONTRACT_REVISION,
					outcome,
					scenarios,
					counts: { created: resources.created, deleted, deleteAttempts },
					resources,
					cleanup,
					errorCodes,
				}),
			);
			throwIfCleanupEscalated(cleanup, primaryFailure);
		}
	});
});
