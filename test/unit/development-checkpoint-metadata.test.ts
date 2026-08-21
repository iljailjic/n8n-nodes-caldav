// Repository file reads are required for deterministic checkpoint metadata tests.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { readFile } from 'node:fs/promises';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { join } from 'node:path';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { cwd } from 'node:process';

import { describe, expect, it } from 'vitest';

const PACKAGE_NAME = '@iljailjic/n8n-nodes-caldav';
const CHECKPOINT_VERSION = '0.6.0';
const CHECKPOINT_HEADING = '## [0.6.0] - 2026-08-21';
const CHECKPOINT_SECTION = `## [0.6.0] - 2026-08-21

### Development checkpoint

- Added structured categories, status, and transparency across Event reads, Create, Update, and Upsert with explicit omission/set/remove semantics and preservation of unrelated iCalendar content (#46).
- Added a deterministic structured recurrence-rule model for daily, weekly, monthly, and yearly rules with bounded validation and preservation of unsupported recurrence data (#47).
- Added recurrence authoring and safe recurrence mutation across Create, Update, and Upsert while preserving exceptions, EXDATE/RDATE, unsupported fields, and IANA VTIMEZONE correctness without occurrence expansion (#48).
- Added multiple structured DISPLAY, AUDIO, and EMAIL reminders with relative triggers, targeted mutation, and preservation of unsupported or untouched VALARM content (#49).
- Added bounded source \`rawIcs\` output for Event Get, Get Many, Update, and Upsert update results with authoritative snapshot provenance and privacy-safe errors (#50).
- Added validated Raw ICS input mode for Event Create, Update, and Upsert with complete-object replacement semantics, UID/calendar/ETag safeguards, semantic preservation, and authoritative read-back (#51).
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

describe('0.6.0 development checkpoint metadata', () => {
	it('synchronizes the package and root lockfile identities at exactly 0.6.0', async () => {
		const packageJson = await readJson<PackageIdentity>('package.json');
		const packageLock = await readJson<PackageLock>('package-lock.json');

		expect(packageJson).toMatchObject({ name: PACKAGE_NAME, version: CHECKPOINT_VERSION });
		expect(packageLock).toMatchObject({ name: PACKAGE_NAME, version: CHECKPOINT_VERSION });
		expect(packageLock.packages?.['']).toMatchObject({
			name: PACKAGE_NAME,
			version: CHECKPOINT_VERSION,
		});
	});

	it('documents the exact dated checkpoint before 0.5.0 without claiming a release', async () => {
		const changelog = await readRepositoryFile('CHANGELOG.md');
		const checkpointStart = changelog.indexOf(CHECKPOINT_HEADING);
		const previousCheckpointStart = changelog.indexOf('## [0.5.0]');
		const nextHeadingStart = changelog.indexOf(
			'\n## ',
			checkpointStart + CHECKPOINT_HEADING.length,
		);

		expect(changelog.match(/^## \[0\.6\.0\] - 2026-08-21$/gm) ?? []).toHaveLength(1);
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
