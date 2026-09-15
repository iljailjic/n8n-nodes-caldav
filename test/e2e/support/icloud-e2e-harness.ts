/** Test-only helpers for the opt-in, read-only iCloud discovery suite. */
/* eslint-disable @n8n/community-nodes/require-node-api-error -- Stable test-harness errors are deliberately independent of n8n execution. */

export const ICLOUD_E2E_EVIDENCE_PREFIX = 'ICLOUD_E2E_EVIDENCE';
export const ICLOUD_E2E_SCHEMA_VERSION = 'icloud-e2e-evidence/v2';

export const IcloudE2eErrorCode = Object.freeze({
	OPT_IN_REQUIRED: 'E2E_OPT_IN_REQUIRED',
	INPUT_MISSING: 'E2E_INPUT_MISSING',
	INPUT_INVALID: 'E2E_INPUT_INVALID',
	CAPABILITY_FAILED: 'E2E_CAPABILITY_FAILED',
	DISCOVERY_FAILED: 'E2E_DISCOVERY_FAILED',
	CALENDAR_NOT_FOUND: 'E2E_CALENDAR_NOT_FOUND',
	CALENDAR_AMBIGUOUS: 'E2E_CALENDAR_AMBIGUOUS',
	ASSERTION_FAILED: 'E2E_ASSERTION_FAILED',
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
	readonly sourceRevision: 'issue-55-contract-r1';
	readonly outcome: 'passed' | 'failed';
	readonly scenarios: readonly string[];
	readonly requestMethods: readonly ('OPTIONS' | 'PROPFIND')[];
	readonly errorCodes: readonly IcloudE2eErrorCode[];
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

export function serializeEvidence(evidence: IcloudE2eEvidence): string {
	return `${ICLOUD_E2E_EVIDENCE_PREFIX} ${JSON.stringify(evidence)}`;
}
