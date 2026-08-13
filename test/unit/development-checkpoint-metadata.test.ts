// Repository file reads are required for deterministic checkpoint metadata tests.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { readFile } from 'node:fs/promises';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { join } from 'node:path';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { cwd } from 'node:process';

import { describe, expect, it } from 'vitest';

const PACKAGE_NAME = '@iljailjic/n8n-nodes-caldav';
const CHECKPOINT_VERSION = '0.3.0';
const CHECKPOINT_HEADING = '## [0.3.0] - 2026-08-13';

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

describe('0.3.0 development checkpoint metadata', () => {
	it('synchronizes the package and root lockfile identities at exactly 0.3.0', async () => {
		const packageJson = await readJson<PackageIdentity>('package.json');
		const packageLock = await readJson<PackageLock>('package-lock.json');

		expect(packageJson).toMatchObject({ name: PACKAGE_NAME, version: CHECKPOINT_VERSION });
		expect(packageLock).toMatchObject({ name: PACKAGE_NAME, version: CHECKPOINT_VERSION });
		expect(packageLock.packages?.['']).toMatchObject({
			name: PACKAGE_NAME,
			version: CHECKPOINT_VERSION,
		});
	});

	it('documents the dated checkpoint before 0.2.0 without claiming a release', async () => {
		const changelog = await readRepositoryFile('CHANGELOG.md');
		const checkpointStart = changelog.indexOf(CHECKPOINT_HEADING);
		const previousCheckpointStart = changelog.indexOf('## [0.2.0]');
		const nextHeadingStart = changelog.indexOf(
			'\n## ',
			checkpointStart + CHECKPOINT_HEADING.length,
		);

		expect(changelog.match(/^## \[0\.3\.0\] - 2026-08-13$/gm) ?? []).toHaveLength(1);
		expect(checkpointStart).toBeGreaterThanOrEqual(0);
		expect(previousCheckpointStart).toBeGreaterThan(checkpointStart);
		expect(nextHeadingStart).toBe(previousCheckpointStart - 1);

		const checkpointSection = changelog.slice(checkpointStart, nextHeadingStart);
		expect(checkpointSection).toMatch(/development checkpoint/i);
		expect(checkpointSection).not.toMatch(
			/\b(?:released|published|publishing)\b|available on npm|npm (?:release|publication)/i,
		);

		const entries = checkpointSection.split('\n').filter((line) => line.startsWith('- '));
		const entryFor = (issue: number) => {
			const issueReference = `#${issue}`;
			const matchingEntries = entries.filter((entry) => entry.includes(issueReference));

			expect(matchingEntries).toHaveLength(1);
			return matchingEntries[0];
		};

		const parserEntry = entryFor(26);
		expect(parserEntry).toMatch(/bounded/i);
		expect(parserEntry).toMatch(/preservation-first/i);
		expect(parserEntry).toMatch(/parsing|parser/i);
		expect(parserEntry).toMatch(/security limits?/i);

		const projectionEntry = entryFor(27);
		expect(projectionEntry).toMatch(/provider-neutral/i);
		expect(projectionEntry).toMatch(/UTC/);
		expect(projectionEntry).toMatch(/URL/i);
		expect(projectionEntry).toMatch(/UID/);
		expect(projectionEntry).toMatch(/ETag/i);
		expect(projectionEntry).toMatch(/internal preservation context/i);

		const uidEntry = entryFor(28);
		expect(uidEntry).toMatch(/UID/);
		expect(uidEntry).toMatch(/resol(?:ve|ution)/i);

		const queryEntry = entryFor(29);
		expect(queryEntry).toMatch(/deterministic/i);
		expect(queryEntry).toMatch(/\[start,\s*end\)/i);
		expect(queryEntry).toMatch(/calendar-query/i);
		expect(queryEntry).toMatch(/REPORT/);
		expect(queryEntry).toMatch(/recurrence/i);
		expect(queryEntry).toMatch(/non-expansion/i);

		const getEntry = entryFor(30);
		expect(getEntry).toMatch(/Event Get/i);
		expect(getEntry).toMatch(/Resource URL/i);
		expect(getEntry).toMatch(/UID/);

		const getManyEntry = entryFor(31);
		expect(getManyEntry).toMatch(/Event Get Many/i);
		expect(getManyEntry).toMatch(/Return All/i);
		expect(getManyEntry).toMatch(/Limit/);
		expect(getManyEntry).toMatch(/pairing/i);
		expect(getManyEntry).toMatch(/Radicale/i);
		expect(getManyEntry).toMatch(/boundary validation/i);
	});
});
