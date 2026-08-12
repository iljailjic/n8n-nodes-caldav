// Repository file reads are required for deterministic checkpoint metadata tests.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { readFile } from 'node:fs/promises';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { join } from 'node:path';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { cwd } from 'node:process';

import { describe, expect, it } from 'vitest';

const PACKAGE_NAME = '@iljailjic/n8n-nodes-caldav';
const CHECKPOINT_VERSION = '0.2.0';
const CHECKPOINT_HEADING = '## [0.2.0] - 2026-08-12';

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

describe('0.2.0 development checkpoint metadata', () => {
	it('synchronizes the package and root lockfile identities at exactly 0.2.0', async () => {
		const packageJson = await readJson<PackageIdentity>('package.json');
		const packageLock = await readJson<PackageLock>('package-lock.json');

		expect(packageJson).toMatchObject({ name: PACKAGE_NAME, version: CHECKPOINT_VERSION });
		expect(packageLock).toMatchObject({ name: PACKAGE_NAME, version: CHECKPOINT_VERSION });
		expect(packageLock.packages?.['']).toMatchObject({
			name: PACKAGE_NAME,
			version: CHECKPOINT_VERSION,
		});
	});

	it('documents the dated checkpoint before 0.1.0 without claiming a release', async () => {
		const changelog = await readRepositoryFile('CHANGELOG.md');
		const checkpointStart = changelog.indexOf(CHECKPOINT_HEADING);
		const previousCheckpointStart = changelog.indexOf('## [0.1.0]');
		const nextHeadingStart = changelog.indexOf(
			'\n## ',
			checkpointStart + CHECKPOINT_HEADING.length,
		);

		expect(changelog.match(/^## \[0\.2\.0\] - 2026-08-12$/gm) ?? []).toHaveLength(1);
		expect(checkpointStart).toBeGreaterThanOrEqual(0);
		expect(previousCheckpointStart).toBeGreaterThan(checkpointStart);
		expect(nextHeadingStart).toBe(previousCheckpointStart - 1);

		const checkpointSection = changelog.slice(checkpointStart, nextHeadingStart);
		expect(checkpointSection).toMatch(/development checkpoint/i);
		expect(checkpointSection).toMatch(/Radicale/i);
		expect(checkpointSection).toMatch(/standard[\s\S]*iCloud|iCloud[\s\S]*standard/i);
		expect(checkpointSection).toMatch(/calendar collection|collection discovery/i);
		expect(checkpointSection).toMatch(/Calendar Get[\s\S]*Get Many/i);
		expect(checkpointSection).toMatch(/resource locator|From List|searchable/i);
		expect(checkpointSection).not.toMatch(
			/\b(?:released|published|publishing)\b|available on npm|npm (?:release|publication)/i,
		);
	});
});
