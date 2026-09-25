/** Test-only helpers for the opt-in, read-only iCloud discovery suite. */
/* eslint-disable @n8n/community-nodes/require-node-api-error -- Stable test-harness errors are deliberately independent of n8n execution. */

export const ICLOUD_E2E_EVIDENCE_PREFIX = 'ICLOUD_E2E_EVIDENCE';
export const ICLOUD_E2E_SCHEMA_VERSION = 'icloud-e2e-evidence/v5';
export const ICLOUD_E2E_CLEANUP_DELETE_ATTEMPTS = 3;

export const IcloudE2eErrorCode = Object.freeze({
	OPT_IN_REQUIRED: 'E2E_OPT_IN_REQUIRED',
	INPUT_MISSING: 'E2E_INPUT_MISSING',
	INPUT_INVALID: 'E2E_INPUT_INVALID',
	CAPABILITY_FAILED: 'E2E_CAPABILITY_FAILED',
	DISCOVERY_FAILED: 'E2E_DISCOVERY_FAILED',
	EVENT_SEED_FAILED: 'E2E_EVENT_SEED_FAILED',
	READ_VISIBILITY_FAILED: 'E2E_READ_VISIBILITY_FAILED',
	TIME_RANGE_CONVERGENCE_FAILED: 'E2E_TIME_RANGE_CONVERGENCE_FAILED',
	EVENT_CLEANUP_FAILED: 'E2E_EVENT_CLEANUP_FAILED',
	MANUAL_CLEANUP_REQUIRED: 'E2E_MANUAL_CLEANUP_REQUIRED',
	EMAIL_SINK_OPT_IN_REQUIRED: 'E2E_EMAIL_SINK_OPT_IN_REQUIRED',
	MUTATION_CONFLICT_EXPECTED: 'E2E_MUTATION_CONFLICT_EXPECTED',
	CALENDAR_NOT_FOUND: 'E2E_CALENDAR_NOT_FOUND',
	CALENDAR_AMBIGUOUS: 'E2E_CALENDAR_AMBIGUOUS',
	ASSERTION_FAILED: 'E2E_ASSERTION_FAILED',
	REMOTE_COOLDOWN: 'E2E_REMOTE_COOLDOWN',
} as const);

export type IcloudE2eErrorCode = (typeof IcloudE2eErrorCode)[keyof typeof IcloudE2eErrorCode];

export class IcloudE2eHarnessError extends Error {
	constructor(readonly code: IcloudE2eErrorCode) {
		super(code);
		this.name = 'IcloudE2eHarnessError';
	}
}

export interface IcloudE2eInput {
	readonly serverUrl: string;
	readonly username: string;
	readonly appPassword: string;
	readonly calendarDisplayName: string;
}

export interface IcloudE2eEvidence {
	readonly schemaVersion: typeof ICLOUD_E2E_SCHEMA_VERSION;
	readonly mode: 'fake' | 'live';
	readonly sourceRevision: 'issue-56-contract-r1' | 'issue-57-contract-r1' | 'issue-58-contract-r1';
	readonly outcome: 'passed' | 'failed';
	readonly scenarios: readonly string[];
	readonly requestMethods: readonly (
		'OPTIONS' | 'PROPFIND' | 'REPORT' | 'GET' | 'PUT' | 'DELETE'
	)[];
	readonly errorCodes: readonly IcloudE2eErrorCode[];
	readonly requestDiagnostics?: {
		readonly requestCount: number;
		readonly minStartGapMs?: number;
		readonly statusCounts: Readonly<Record<string, number>>;
		readonly phaseStatusCounts?: Readonly<Record<string, number>>;
	};
	readonly firstFailure?: {
		readonly stage: string;
		readonly category: 'harness' | 'transport' | 'node' | 'other';
		readonly method?: 'OPTIONS' | 'PROPFIND' | 'REPORT' | 'GET' | 'PUT' | 'DELETE';
		readonly httpStatus?: number;
		readonly etagPresent?: boolean;
		readonly retryAfterPresent?: boolean;
		readonly retryAfterSeconds?: number;
		readonly transportCode?: string;
	};
	readonly cleanupOutcome?: 'not-required' | 'cleaned' | 'manual-cleanup-required';
	readonly suppliedUidLookup?: {
		readonly result: 'created' | 'incomplete' | 'other-error';
		readonly writeAttempts: number;
	};
}

export function canonicalizeIcloudE2eUrl(value: string): string {
	try {
		const url = new URL(value);
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
			throw new Error();
		}
		return url.toString();
	} catch {
		throw new IcloudE2eHarnessError(IcloudE2eErrorCode.INPUT_INVALID);
	}
}

export function readIcloudE2eInput(env: NodeJS.ProcessEnv): IcloudE2eInput {
	if (env.CALDAV_ICLOUD_E2E_OPT_IN !== '1') {
		throw new IcloudE2eHarnessError(IcloudE2eErrorCode.OPT_IN_REQUIRED);
	}
	const serverUrl = env.CALDAV_ICLOUD_E2E_SERVER_URL;
	const username = env.CALDAV_ICLOUD_E2E_USERNAME;
	const appPassword = env.CALDAV_ICLOUD_E2E_APP_PASSWORD;
	const calendarDisplayName = env.CALDAV_ICLOUD_E2E_CALENDAR_DISPLAY_NAME;
	if (!serverUrl || !username || !appPassword || !calendarDisplayName) {
		throw new IcloudE2eHarnessError(IcloudE2eErrorCode.INPUT_MISSING);
	}
	const canonicalServerUrl = canonicalizeIcloudE2eUrl(serverUrl);
	if (new URL(canonicalServerUrl).protocol !== 'https:') {
		throw new IcloudE2eHarnessError(IcloudE2eErrorCode.INPUT_INVALID);
	}
	return { serverUrl: canonicalServerUrl, username, appPassword, calendarDisplayName };
}

export function selectExactCalendar(
	calendars: ReadonlyArray<{ readonly displayName: string; readonly url: string }>,
	displayName: string,
): { displayName: string; url: string } {
	const matches = calendars.filter((calendar) => calendar.displayName === displayName);
	if (matches.length === 0) throw new IcloudE2eHarnessError(IcloudE2eErrorCode.CALENDAR_NOT_FOUND);
	if (matches.length !== 1) throw new IcloudE2eHarnessError(IcloudE2eErrorCode.CALENDAR_AMBIGUOUS);
	return { displayName: matches[0]!.displayName, url: canonicalizeIcloudE2eUrl(matches[0]!.url) };
}

export function assertE2e(condition: unknown): asserts condition {
	if (!condition) throw new IcloudE2eHarnessError(IcloudE2eErrorCode.ASSERTION_FAILED);
}

/** A cleanup failure is terminal but must not replace an earlier operation error. */
export function throwIfCleanupOnlyFailure(
	cleanupFailed: boolean,
	operationFailed: boolean,
	code: IcloudE2eErrorCode,
): void {
	if (cleanupFailed && !operationFailed) throw new IcloudE2eHarnessError(code);
}

/** Test-only convergence for an expected missing/empty post-write read. */
export async function waitForE2eVisibility<T>(
	read: () => Promise<T | undefined>,
	delay: () => Promise<void>,
	attempts = 4,
): Promise<T> {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const value = await read();
		if (value !== undefined) return value;
		if (attempt + 1 < attempts) await delay();
	}
	throw new IcloudE2eHarnessError(IcloudE2eErrorCode.READ_VISIBILITY_FAILED);
}

export type IcloudE2eCleanupDeleteOutcome = 'deleted' | 'preconditionFailed' | 'failed';

export type IcloudE2eOwnedRead =
	| { readonly kind: 'missing' }
	| { readonly kind: 'found'; readonly uid: string; readonly etag: string };

/** A cleanup DELETE is permitted only after an exact UID read with a fresh ETag. */
export async function recoverRunOwnedE2eEvent(
	expectedUid: string,
	read: () => Promise<IcloudE2eOwnedRead>,
	deleteWithEtag: (etag: string) => Promise<IcloudE2eCleanupDeleteOutcome>,
): Promise<'cleaned' | 'manual-cleanup-required'> {
	for (let attempt = 0; attempt < ICLOUD_E2E_CLEANUP_DELETE_ATTEMPTS; attempt += 1) {
		const current = await read();
		if (current.kind === 'missing') return 'cleaned';
		if (current.uid !== expectedUid || current.etag.length === 0) return 'manual-cleanup-required';
		const outcome = await deleteWithEtag(current.etag);
		if (outcome === 'deleted') return 'cleaned';
		if (outcome !== 'preconditionFailed') return 'manual-cleanup-required';
	}
	return 'manual-cleanup-required';
}

/**
 * Harness-only recovery: product paths never call this helper. Each retry begins
 * with a fresh ownership check and can only repeat a conditional-delete 412.
 */
export async function recoverOwnedE2eResource(
	verifyOwnership: () => Promise<boolean>,
	deleteConditionally: () => Promise<IcloudE2eCleanupDeleteOutcome>,
): Promise<'cleaned' | 'manual-cleanup-required'> {
	for (let attempt = 0; attempt < ICLOUD_E2E_CLEANUP_DELETE_ATTEMPTS; attempt += 1) {
		if (!(await verifyOwnership())) return 'manual-cleanup-required';
		const outcome = await deleteConditionally();
		if (outcome === 'deleted') return 'cleaned';
		if (outcome !== 'preconditionFailed') return 'manual-cleanup-required';
	}
	return 'manual-cleanup-required';
}

export function serializeEvidence(evidence: IcloudE2eEvidence): string {
	return `${ICLOUD_E2E_EVIDENCE_PREFIX} ${JSON.stringify(evidence)}`;
}

/** The ordinary live opt-in may never select a real mail recipient. */
export function emailAlarmRecipient(env: NodeJS.ProcessEnv): string {
	const sink = env.CALDAV_ICLOUD_E2E_EMAIL_SINK;
	if (env.CALDAV_ICLOUD_E2E_EMAIL_OPT_IN !== '1' || sink === undefined || sink.length === 0) {
		return 'mailto:advanced-event-recipient@caldav-e2e.invalid';
	}
	if (!sink.startsWith('mailto:')) {
		throw new IcloudE2eHarnessError(IcloudE2eErrorCode.EMAIL_SINK_OPT_IN_REQUIRED);
	}
	return sink;
}
