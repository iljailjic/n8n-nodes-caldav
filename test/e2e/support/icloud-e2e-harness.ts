/**
 * Test-only contract harness for the opt-in iCloud interoperability suite.
 * It deliberately owns no credentials, filesystem manifest, or HTTP client.
 */
/* eslint-disable @n8n/community-nodes/require-node-api-error -- The test-only harness has no n8n execution context and intentionally exposes stable public-safe error codes. */

export const ICLOUD_E2E_EVIDENCE_PREFIX = 'ICLOUD_E2E_EVIDENCE';
export const ICLOUD_E2E_SCHEMA_VERSION = 'icloud-e2e-evidence/v1';

export const IcloudE2eErrorCode = {
	OPT_IN_REQUIRED: 'E2E_OPT_IN_REQUIRED',
	INPUT_MISSING: 'E2E_INPUT_MISSING',
	INPUT_INVALID: 'E2E_INPUT_INVALID',
	DEFAULT_BRANCH_REQUIRED: 'E2E_DEFAULT_BRANCH_REQUIRED',
	CALENDAR_NOT_FOUND: 'E2E_CALENDAR_NOT_FOUND',
	CALENDAR_AMBIGUOUS: 'E2E_CALENDAR_AMBIGUOUS',
	OWNERSHIP_PROOF_FAILED: 'E2E_OWNERSHIP_PROOF_FAILED',
	CREATE_RECOVERY_UNVERIFIABLE: 'E2E_CREATE_RECOVERY_UNVERIFIABLE',
	CLEANUP_CONFLICT: 'E2E_CLEANUP_CONFLICT',
	CLEANUP_INCOMPLETE: 'E2E_CLEANUP_INCOMPLETE',
	ASSERTION_FAILED: 'E2E_ASSERTION_FAILED',
	TRANSPORT_FAILED: 'E2E_TRANSPORT_FAILED',
} as const;

export type IcloudE2eErrorCode = (typeof IcloudE2eErrorCode)[keyof typeof IcloudE2eErrorCode];

export class IcloudE2eHarnessError extends Error {
	constructor(readonly code: IcloudE2eErrorCode) {
		super(code);
		this.name = 'IcloudE2eHarnessError';
	}
}

export interface IcloudE2eInput {
	serverUrl: string;
	username: string;
	appPassword: string;
	calendarDisplayName: string;
}

export interface IcloudE2eEvent {
	url: string;
	etag: string;
	uid: string;
	title: string;
	runId: string;
	parentUrl: string;
}

/**
 * A deterministic, test-only record made before a create request is sent.
 * It is deliberately not an event resource: an unresolved intent must never
 * be used as a deletion target.
 */
export type IcloudE2ePendingOwnershipIntent = Omit<IcloudE2eEvent, 'url' | 'etag'>;

export interface IcloudE2eTransport {
	listCalendars(): Promise<ReadonlyArray<{ displayName: string; url: string }>>;
	create(event: Omit<IcloudE2eEvent, 'url' | 'etag'>): Promise<IcloudE2eEvent>;
	reportByUid(calendarUrl: string, uid: string): Promise<ReadonlyArray<IcloudE2eEvent>>;
	get(url: string): Promise<IcloudE2eEvent | undefined>;
	delete(url: string, etag: string): Promise<'deleted' | 'notFound' | 'stale'>;
}

export interface IcloudE2eEvidence {
	schemaVersion: typeof ICLOUD_E2E_SCHEMA_VERSION;
	mode: 'fake' | 'live';
	runId: string;
	sourceRevision: string;
	outcome: 'passed' | 'failed' | 'manual-cleanup-required';
	scenarios: readonly string[];
	counts: { created: number; deleted: number; deleteAttempts: number };
	resources: {
		planned: number;
		created: number;
		adoptedAfterAmbiguousCreate: number;
		deleted: number;
		alreadyAbsent: number;
		manualCleanupRequired: number;
	};
	cleanup: 'verified' | 'manual-cleanup-required' | 'not-needed';
	errorCodes: readonly IcloudE2eErrorCode[];
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function canonicalHttpUrl(value: string): string {
	try {
		const url = new URL(value);
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
			throw new Error();
		return url.toString();
	} catch {
		throw new IcloudE2eHarnessError(IcloudE2eErrorCode.INPUT_INVALID);
	}
}

function canonicalHttpsUrl(value: string): string {
	const url = canonicalHttpUrl(value);
	if (new URL(url).protocol !== 'https:') {
		throw new IcloudE2eHarnessError(IcloudE2eErrorCode.INPUT_INVALID);
	}
	return url;
}

export function readIcloudE2eInput(env: NodeJS.ProcessEnv): IcloudE2eInput {
	if (env.CALDAV_ICLOUD_E2E_OPT_IN !== '1') {
		throw new IcloudE2eHarnessError(IcloudE2eErrorCode.OPT_IN_REQUIRED);
	}
	const serverUrl = env.CALDAV_ICLOUD_E2E_SERVER_URL;
	const username = env.CALDAV_ICLOUD_E2E_USERNAME;
	const appPassword = env.CALDAV_ICLOUD_E2E_APP_PASSWORD;
	const calendarDisplayName = env.CALDAV_ICLOUD_E2E_CALENDAR_DISPLAY_NAME;
	if (!serverUrl) {
		throw new IcloudE2eHarnessError(IcloudE2eErrorCode.INPUT_MISSING);
	}
	const canonicalServerUrl = canonicalHttpsUrl(serverUrl);
	if (!username || !appPassword || !calendarDisplayName) {
		throw new IcloudE2eHarnessError(IcloudE2eErrorCode.INPUT_MISSING);
	}
	return { serverUrl: canonicalServerUrl, username, appPassword, calendarDisplayName };
}

export function selectExactCalendar(
	calendars: ReadonlyArray<{ displayName: string; url: string }>,
	displayName: string,
): { displayName: string; url: string } {
	const matches = calendars.filter((calendar) => calendar.displayName === displayName);
	if (matches.length === 0) throw new IcloudE2eHarnessError(IcloudE2eErrorCode.CALENDAR_NOT_FOUND);
	if (matches.length !== 1) throw new IcloudE2eHarnessError(IcloudE2eErrorCode.CALENDAR_AMBIGUOUS);
	return { ...matches[0], url: canonicalHttpUrl(matches[0].url) };
}

export function createRunIdentity(randomUuid: () => string): {
	runId: string;
	uidPrefix: string;
	titlePrefix: string;
} {
	const runId = randomUuid();
	if (!UUID_V4.test(runId)) throw new IcloudE2eHarnessError(IcloudE2eErrorCode.INPUT_INVALID);
	return { runId, uidPrefix: `n8n-caldav-e2e-${runId}-`, titlePrefix: `[n8n-caldav-e2e ${runId}]` };
}

export function countCreatedResources(
	activeOwnedResources: ReadonlyArray<IcloudE2eEvent>,
	deletedResources: number,
): number {
	return activeOwnedResources.length + deletedResources;
}

export function assertE2e(condition: unknown): asserts condition {
	if (!condition) throw new IcloudE2eHarnessError(IcloudE2eErrorCode.ASSERTION_FAILED);
}

function provesOwnership(
	event: IcloudE2eEvent,
	calendarUrl: string,
	runId: string,
	uid: string,
	titlePrefix: string,
): boolean {
	try {
		const calendar = new URL(canonicalHttpUrl(calendarUrl));
		const resource = new URL(canonicalHttpUrl(event.url));
		const isCollection = calendar.pathname.endsWith('/');
		const directChildPath = resource.pathname.startsWith(calendar.pathname)
			? resource.pathname.slice(calendar.pathname.length)
			: '';
		return (
			canonicalHttpUrl(event.parentUrl) === calendar.toString() &&
			resource.origin === calendar.origin &&
			isCollection &&
			directChildPath.length > 0 &&
			!directChildPath.includes('/') &&
			event.runId === runId &&
			event.uid === uid &&
			event.title.startsWith(titlePrefix) &&
			Boolean(event.etag)
		);
	} catch {
		return false;
	}
}

export async function createOrRecoverOwnedEvent(
	transport: IcloudE2eTransport,
	calendarUrl: string,
	event: Omit<IcloudE2eEvent, 'url' | 'etag'>,
	titlePrefix: string,
	registerPendingOwnershipIntent: (intent: IcloudE2ePendingOwnershipIntent) => void = () => {},
): Promise<IcloudE2eEvent> {
	// The intent is registered before PUT so a lost response can never leave an
	// unaccounted-for resource. Callers retain it until ownership is proven.
	registerPendingOwnershipIntent({ ...event });
	try {
		const created = await transport.create(event);
		if (!provesOwnership(created, calendarUrl, event.runId, event.uid, titlePrefix)) {
			// A response can be malformed or incomplete after a successful PUT. It
			// is therefore recovered exactly once by the scoped, fresh UID below.
			throw new Error('Unconfirmed create response');
		}
		return created;
	} catch {
		// The recovery below deliberately replaces every unconfirmed outcome
		// with one scoped UID lookup and a stable public-safe failure code.
	}

	// Any create failure or unproven response may have followed a successful
	// PUT. Make one—and only one—UID-scoped recovery attempt. Never infer a
	// deletion URL from an unresolved intent.
	let recovered: ReadonlyArray<IcloudE2eEvent>;
	try {
		recovered = await transport.reportByUid(calendarUrl, event.uid);
	} catch {
		throw new IcloudE2eHarnessError(IcloudE2eErrorCode.CREATE_RECOVERY_UNVERIFIABLE);
	}
	if (
		recovered.length !== 1 ||
		!provesOwnership(recovered[0], calendarUrl, event.runId, event.uid, titlePrefix)
	) {
		throw new IcloudE2eHarnessError(IcloudE2eErrorCode.CREATE_RECOVERY_UNVERIFIABLE);
	}
	return recovered[0];
}

export async function cleanupOwnedEvent(
	transport: IcloudE2eTransport,
	event: IcloudE2eEvent,
	calendarUrl: string,
	titlePrefix: string,
): Promise<{ status: 'verified' | 'manual-cleanup-required'; attempts: number }> {
	if (!provesOwnership(event, calendarUrl, event.runId, event.uid, titlePrefix)) {
		throw new IcloudE2eHarnessError(IcloudE2eErrorCode.OWNERSHIP_PROOF_FAILED);
	}
	let current = event;
	for (let attempts = 1; attempts <= 3; attempts += 1) {
		const outcome = await transport.delete(current.url, current.etag);
		if (outcome === 'notFound') return { status: 'verified', attempts };
		if (outcome === 'deleted' && !(await transport.get(current.url)))
			return { status: 'verified', attempts };
		const refreshed = await transport.get(current.url);
		if (!refreshed) return { status: 'verified', attempts };
		if (attempts === 3) return { status: 'manual-cleanup-required', attempts };
		if (!provesOwnership(refreshed, calendarUrl, current.runId, current.uid, titlePrefix)) {
			throw new IcloudE2eHarnessError(IcloudE2eErrorCode.CLEANUP_CONFLICT);
		}
		current = refreshed;
	}
	throw new IcloudE2eHarnessError(IcloudE2eErrorCode.CLEANUP_INCOMPLETE);
}

export interface IcloudE2eCleanupSummary {
	cleanup: IcloudE2eEvidence['cleanup'];
	manualCleanupRequired: number;
	errorCodes: readonly IcloudE2eErrorCode[];
}

function cleanupFailureCode(error: unknown): IcloudE2eErrorCode {
	return error instanceof IcloudE2eHarnessError ? error.code : IcloudE2eErrorCode.TRANSPORT_FAILED;
}

/**
 * Attempts every owned cleanup even when one resource cannot be verified. The
 * returned status is deliberately monotonic: a manual-cleanup outcome can
 * never be overwritten by a later successful cleanup.
 */
export async function cleanupOwnedEvents(
	events: ReadonlyArray<IcloudE2eEvent>,
	cleanupEvent: (
		event: IcloudE2eEvent,
	) => Promise<{ status: 'verified' | 'manual-cleanup-required'; attempts: number }>,
): Promise<IcloudE2eCleanupSummary> {
	let cleanup: IcloudE2eEvidence['cleanup'] = events.length === 0 ? 'not-needed' : 'verified';
	let manualCleanupRequired = 0;
	const errorCodes: IcloudE2eErrorCode[] = [];

	for (const event of events) {
		try {
			const result = await cleanupEvent(event);
			if (result.status === 'manual-cleanup-required') {
				cleanup = 'manual-cleanup-required';
				manualCleanupRequired += 1;
				errorCodes.push(IcloudE2eErrorCode.CLEANUP_INCOMPLETE);
			}
		} catch (error) {
			cleanup = 'manual-cleanup-required';
			manualCleanupRequired += 1;
			errorCodes.push(cleanupFailureCode(error));
		}
	}

	return { cleanup, manualCleanupRequired, errorCodes };
}

export function throwIfCleanupEscalated(
	cleanup: IcloudE2eEvidence['cleanup'],
	primaryFailure: unknown,
): void {
	if (cleanup === 'manual-cleanup-required' && primaryFailure === undefined) {
		throw new IcloudE2eHarnessError(IcloudE2eErrorCode.CLEANUP_INCOMPLETE);
	}
}

export function serializeEvidence(evidence: IcloudE2eEvidence): string {
	return `${ICLOUD_E2E_EVIDENCE_PREFIX} ${JSON.stringify(evidence)}`;
}
