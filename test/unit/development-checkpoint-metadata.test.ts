// Repository file reads are required for deterministic checkpoint metadata tests.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { readFile } from 'node:fs/promises';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { join } from 'node:path';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { cwd } from 'node:process';

import { describe, expect, it } from 'vitest';

const PACKAGE_NAME = '@iljailjic/n8n-nodes-caldav';
const CHECKPOINT_VERSION = '0.4.0';
const CHECKPOINT_HEADING = '## [0.4.0] - 2026-08-14';
const CHECKPOINT_SECTION = `## [0.4.0] - 2026-08-14

### Development checkpoint

- Added deterministic standards-compliant basic timed UTC VEVENT serialization with preservation-AST round trips, RFC escaping and parameter encoding, UTF-8-aware folding, and CRLF output (#33).
- Added shared conditional CalDAV mutation services with canonical resource metadata, opaque ETags, safe preconditions, and sanitized conflict mapping (#34).
- Added collision-safe Event Create with explicit UID, canonical URL and authoritative ETag output, item pairing, and Radicale collision validation (#35).
- Added preservation-first structured event patching with explicit set/remove semantics, deterministic revision metadata, and unknown-data retention (#36).
- Added conditional Event Update by Resource URL or UID with verified preservation read-back, canonical URL and authoritative current ETag output, and stale-ETag protection (#37).
- Added conditional Event Delete by Resource URL or UID with mandatory ETag preconditions, canonical deletion metadata, pairing, and stale/read-only validation (#38).
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

describe('0.4.0 development checkpoint metadata', () => {
	it('synchronizes the package and root lockfile identities at exactly 0.4.0', async () => {
		const packageJson = await readJson<PackageIdentity>('package.json');
		const packageLock = await readJson<PackageLock>('package-lock.json');

		expect(packageJson).toMatchObject({ name: PACKAGE_NAME, version: CHECKPOINT_VERSION });
		expect(packageLock).toMatchObject({ name: PACKAGE_NAME, version: CHECKPOINT_VERSION });
		expect(packageLock.packages?.['']).toMatchObject({
			name: PACKAGE_NAME,
			version: CHECKPOINT_VERSION,
		});
	});

	it('documents the exact dated checkpoint before 0.3.0 without claiming a release', async () => {
		const changelog = await readRepositoryFile('CHANGELOG.md');
		const checkpointStart = changelog.indexOf(CHECKPOINT_HEADING);
		const previousCheckpointStart = changelog.indexOf('## [0.3.0]');
		const nextHeadingStart = changelog.indexOf(
			'\n## ',
			checkpointStart + CHECKPOINT_HEADING.length,
		);

		expect(changelog.match(/^## \[0\.4\.0\] - 2026-08-14$/gm) ?? []).toHaveLength(1);
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
