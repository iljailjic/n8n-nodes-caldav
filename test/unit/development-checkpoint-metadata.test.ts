// Repository file reads are required for deterministic checkpoint metadata tests.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { readFile } from 'node:fs/promises';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { join } from 'node:path';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { cwd } from 'node:process';

import { describe, expect, it } from 'vitest';

const PACKAGE_NAME = '@iljailjic/n8n-nodes-caldav';
const UNRELEASED_HEADING = '## Unreleased';
const CURRENT_VERSION = '1.0.0-beta.2';
const CHECKPOINT_HEADING = '## [1.0.0-beta.1] - 2026-09-17';
const CHECKPOINT_SECTION = `## [1.0.0-beta.1] - 2026-09-17

### Development checkpoint

- Completed MVP integration and privacy-safe opt-in iCloud end-to-end validation.

### Fixed

- Accepted exact two- and three-digit iCloud CalDAV partition hosts while retaining strict HTTPS, port, and hostname trust checks.
- Made the local iCloud E2E command execute its protected dry run directly before the live phase instead of spawning a nested npm command.
- Made iCloud event lookups by UID verify candidate resource names before using a bounded calendar scan; standard-provider lookup behavior is unchanged, with the fallback adding only bounded iCloud requests.
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

describe('release metadata and 1.0.0-beta.1 development checkpoint', () => {
	it('synchronizes the package and root lockfile identities at exactly 1.0.0-beta.2', async () => {
		const packageJson = await readJson<PackageIdentity>('package.json');
		const packageLock = await readJson<PackageLock>('package-lock.json');

		expect(packageJson).toMatchObject({ name: PACKAGE_NAME, version: CURRENT_VERSION });
		expect(packageLock).toMatchObject({ name: PACKAGE_NAME, version: CURRENT_VERSION });
		expect(packageLock.packages?.['']).toMatchObject({
			name: PACKAGE_NAME,
			version: CURRENT_VERSION,
		});
	});

	it('documents the exact dated checkpoint immediately after Unreleased without claiming a release', async () => {
		const changelog = await readRepositoryFile('CHANGELOG.md');
		const checkpointStart = changelog.indexOf(CHECKPOINT_HEADING);
		const unreleasedStart = changelog.indexOf(UNRELEASED_HEADING);
		const currentReleaseStart = changelog.indexOf('## [1.0.0-beta.2]');
		const previousCheckpointStart = changelog.indexOf('## [0.6.0]');
		const nextHeadingStart = changelog.indexOf(
			'\n## ',
			checkpointStart + CHECKPOINT_HEADING.length,
		);

		expect(changelog.match(/^## \[1\.0\.0-beta\.1\] - 2026-09-17$/gm) ?? []).toHaveLength(1);
		expect(changelog.match(/^## Unreleased$/gm) ?? []).toHaveLength(1);
		expect(changelog).toContain(`${UNRELEASED_HEADING}\n\n## [1.0.0-beta.2]`);
		expect(currentReleaseStart).toBe(unreleasedStart + UNRELEASED_HEADING.length + 2);
		expect(checkpointStart).toBeGreaterThan(currentReleaseStart);
		expect(previousCheckpointStart).toBeGreaterThan(checkpointStart);
		expect(nextHeadingStart).toBe(previousCheckpointStart - 1);

		const checkpointSection = changelog.slice(checkpointStart, nextHeadingStart);
		expect(checkpointSection).toBe(CHECKPOINT_SECTION);
		expect(checkpointSection).not.toMatch(
			/\b(?:released|published|publishing)\b|available on npm|npm (?:release|publication)/i,
		);
	});
});
