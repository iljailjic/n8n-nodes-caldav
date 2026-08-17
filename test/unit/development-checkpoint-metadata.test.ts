// Repository file reads are required for deterministic checkpoint metadata tests.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { readFile } from 'node:fs/promises';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { join } from 'node:path';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { cwd } from 'node:process';

import { describe, expect, it } from 'vitest';

const PACKAGE_NAME = '@iljailjic/n8n-nodes-caldav';
const CHECKPOINT_VERSION = '0.5.0';
const CHECKPOINT_HEADING = '## [0.5.0] - 2026-08-17';
const CHECKPOINT_SECTION = `## [0.5.0] - 2026-08-17

### Development checkpoint

- Added optional cryptographically generated RFC 4122 UUIDv4 event UIDs while preserving supplied opaque UIDs and one consistent identity across serialization, resource naming, and output (#40).
- Added explicit timed, all-day, and safe read-only event-time modes with strict Gregorian exclusive end dates, workflow-time-zone normalization, preservation-first conversions, and fixed-UTC query semantics (#41).
- Added pinned IANA TZDB 2026c validation and deterministic UTC/IANA conversion with embedded VTIMEZONE authority and secure RFC 7808/7809 time-zone reference discovery (#42).
- Added reference-first finite IANA authoring with deterministic RFC-compliant embedded VTIMEZONE fallback, proven closed-event coverage, and safe rejection when a representation cannot be proved (#43).
- Added deterministic calendar-scoped Event Upsert with supplied/omitted UID branching, preservation-first conditional Create/Update, semantic no-op handling, and strict race classification without deleting history (#44).
`;

interface PackageIdentity {
	readonly name?: string;
	readonly version?: string;
}

interface PackageLock extends PackageIdentity {
	readonly packages?: Readonly<Record<string, PackageIdentity>>;
}

async function readRepositoryFile(path: string): Promise<string> {
	return await readFile(join(cwd(), path), 'utf8');
}

async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(await readRepositoryFile(path)) as T;
}

describe('0.5.0 development checkpoint metadata', () => {
	it('synchronizes the package and root lockfile identities at exactly 0.5.0', async () => {
		const packageJson = await readJson<PackageIdentity>('package.json');
		const packageLock = await readJson<PackageLock>('package-lock.json');

		expect(packageJson).toMatchObject({ name: PACKAGE_NAME, version: CHECKPOINT_VERSION });
		expect(packageLock).toMatchObject({ name: PACKAGE_NAME, version: CHECKPOINT_VERSION });
		expect(packageLock.packages?.['']).toMatchObject({
			name: PACKAGE_NAME,
			version: CHECKPOINT_VERSION,
		});
	});

	it('documents the exact dated checkpoint before 0.4.0 without claiming a release', async () => {
		const changelog = await readRepositoryFile('CHANGELOG.md');
		const checkpointStart = changelog.indexOf(CHECKPOINT_HEADING);
		const previousCheckpointStart = changelog.indexOf('## [0.4.0]');
		const nextHeadingStart = changelog.indexOf(
			'\n## ',
			checkpointStart + CHECKPOINT_HEADING.length,
		);

		expect(changelog.match(/^## \[0\.5\.0\] - 2026-08-17$/gm) ?? []).toHaveLength(1);
		expect(checkpointStart).toBeGreaterThanOrEqual(0);
		expect(previousCheckpointStart).toBeGreaterThan(checkpointStart);
		expect(nextHeadingStart).toBe(previousCheckpointStart - 1);

		const checkpointSection = changelog.slice(checkpointStart, nextHeadingStart);
		expect(checkpointSection).toBe(CHECKPOINT_SECTION);
		expect(checkpointSection).not.toMatch(
			/\b(?:released|published|publishing)\b|available on npm|npm (?:release|publication)/i,
		);
	});
});
