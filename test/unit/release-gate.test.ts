// Release archive fixtures must invoke the local tar command, never a community-node runtime path.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
// Repository fixture reads and writes are confined to .codex-runtime.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EXPECTED_PACKAGE_FILES } from '../../scripts/verify-package-contents.mjs';
import {
	archiveNameFor,
	checksumFor,
	validateArchive,
	validateAssets,
	validateMetadata,
	validateRegistry,
	validateRelease,
	validateVersion,
} from '../../scripts/release-gate.mjs';

const version = '1.0.0-beta.2';
const tag = `v${version}`;
const packageName = '@iljailjic/n8n-nodes-caldav';
const repositoryUrl = 'git+https://github.com/iljailjic/n8n-nodes-caldav.git';
const archiveName = archiveNameFor(version);
const fixtureRoots: string[] = [];

afterEach(() => {
	for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function metadata(overrides: Record<string, unknown> = {}) {
	return {
		tag,
		phase: 'prepare',
		manifest: { name: packageName, version, repository: { url: repositoryUrl } },
		lock: {
			name: packageName,
			version,
			packages: { '': { name: packageName, version } },
		},
		changelog: `## [${version}] - 2026-09-23\n`,
		tagCommit: 'synthetic-commit',
		mainCommit: 'synthetic-commit',
		...overrides,
	};
}

function archiveFixture(options: { extraEntry?: string; packageVersion?: string } = {}) {
	mkdirSync(resolve('.codex-runtime'), { recursive: true });
	const root = mkdtempSync(resolve('.codex-runtime', 'release-gate-test-'));
	fixtureRoots.push(root);
	const archive = join(root, archiveName);
	const entries = [...EXPECTED_PACKAGE_FILES].map((path) => `package/${path}`);
	if (options.extraEntry) entries.push(`package/${options.extraEntry}`);
	for (const entry of entries) {
		const path = join(root, entry);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			entry === 'package/package.json'
				? JSON.stringify({
						name: packageName,
						version: options.packageVersion ?? version,
						repository: { url: repositoryUrl },
					})
				: 'synthetic package content\n',
		);
	}
	// eslint-disable-next-line @n8n/community-nodes/no-dangerous-functions
	const tar = spawnSync('tar', ['-czf', archive, ...entries], { cwd: root, encoding: 'utf8' });
	if (tar.status !== 0) throw new Error(tar.stderr || 'Unable to build synthetic archive');
	const digest = checksumFor(archive);
	const checksum = `${archive}.sha256`;
	writeFileSync(checksum, `${digest}  ${archiveName}\n`);
	return { archive, checksum, digest };
}

describe('release metadata gate', () => {
	it('accepts an exact prerelease tag and aligned metadata', () => {
		expect(validateMetadata(metadata())).toEqual({ prerelease: true, version });
		expect(validateVersion('v1.0.0', '1.0.0')).toEqual({ prerelease: false, version: '1.0.0' });
	});

	it.each(['1.0.0-beta.2', 'v1.0.0-beta.3', 'v0.9.0', 'v1.0.0-01'])(
		'rejects an invalid or mismatched tag %s',
		(badTag) => expect(() => validateVersion(badTag, version)).toThrow(),
	);

	it('rejects package, repository, lock, changelog, and checked-out commit mismatches', () => {
		const baseline = metadata();
		const invalid = [
			metadata({ manifest: { ...baseline.manifest, name: 'other-package' } }),
			metadata({
				manifest: { ...baseline.manifest, repository: { url: 'https://example.invalid' } },
			}),
			metadata({ lock: { ...baseline.lock, version: '1.0.0-beta.1' } }),
			metadata({ changelog: '## [1.0.0-beta.20] - 2026-09-23\n' }),
			metadata({ mainCommit: 'different-commit' }),
		];
		for (const candidate of invalid) expect(() => validateMetadata(candidate)).toThrow();
	});

	it('limits the one-time beta workflow to its designated version', () => {
		expect(() =>
			validateMetadata(
				metadata({
					phase: 'first-beta',
					tag: 'v1.0.0-beta.3',
					manifest: { ...metadata().manifest, version: '1.0.0-beta.3' },
					lock: {
						...metadata().lock,
						version: '1.0.0-beta.3',
						packages: { '': { name: packageName, version: '1.0.0-beta.3' } },
					},
					changelog: '## [1.0.0-beta.3] - 2026-09-23\n',
				}),
			),
		).toThrow(/One-time beta/);
	});
});

describe('release and archive gate', () => {
	it('enforces draft/prerelease state and rejects the first beta on the normal publish path', () => {
		const draft = { id: 123, tag_name: tag, draft: true, prerelease: true, assets: [] };
		expect(validateRelease(draft, tag, 'prepare', true)).toBe(draft);
		expect(() => validateRelease({ ...draft, draft: false }, tag, 'prepare', true)).toThrow();
		expect(() => validateRelease({ ...draft, prerelease: false }, tag, 'prepare', true)).toThrow();
		expect(() => validateRelease(draft, tag, 'publish', true)).toThrow();
	});

	it('accepts only the exact package archive and checksum bytes', () => {
		const fixture = archiveFixture();
		expect(validateArchive({ tag, archive: fixture.archive, checksum: fixture.checksum })).toBe(
			fixture.digest,
		);
		writeFileSync(fixture.checksum, `${fixture.digest} ${archiveName}\n`);
		expect(() =>
			validateArchive({ tag, archive: fixture.archive, checksum: fixture.checksum }),
		).toThrow(/checksum/);
	});

	it('rejects an extra archive entry even when its checksum is valid', () => {
		const fixture = archiveFixture({ extraEntry: 'private.txt' });
		expect(() =>
			validateArchive({ tag, archive: fixture.archive, checksum: fixture.checksum }),
		).toThrow(/Archive entries/);
	});

	it('rejects a correctly checksummed archive with a different package version', () => {
		const fixture = archiveFixture({ packageVersion: '1.0.0-beta.1' });
		expect(() =>
			validateArchive({ tag, archive: fixture.archive, checksum: fixture.checksum }),
		).toThrow(/Archive package identity/);
	});

	it('rejects missing and duplicate reviewed assets', () => {
		const asset = { name: archiveName, state: 'uploaded', digest: 'sha256:archive-digest' };
		const checksum = {
			name: `${archiveName}.sha256`,
			state: 'uploaded',
			digest: 'sha256:checksum-digest',
		};
		const release = { assets: [asset, checksum] };
		expect(() =>
			validateAssets(release, archiveName, 'archive-digest', 'publish', 'checksum-digest'),
		).not.toThrow();
		expect(() =>
			validateAssets(
				{ assets: [asset] },
				archiveName,
				'archive-digest',
				'publish',
				'checksum-digest',
			),
		).toThrow();
		expect(() =>
			validateAssets(
				{ assets: [asset, asset, checksum] },
				archiveName,
				'archive-digest',
				'publish',
				'checksum-digest',
			),
		).toThrow();
	});

	it('requires exact npm archive integrity, beta tag, and provenance metadata', () => {
		const fixture = archiveFixture();
		const integrity = `sha512-${createHash('sha512').update(readFileSync(fixture.archive)).digest('base64')}`;
		const dist = {
			integrity,
			attestations: {
				url: 'https://registry.example.invalid/attestation',
				provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
			},
		};
		expect(() => validateRegistry(fixture.archive, dist, { beta: version })).not.toThrow();
		expect(() =>
			validateRegistry(fixture.archive, { ...dist, integrity: 'sha512-wrong' }, { beta: version }),
		).toThrow();
		expect(() => validateRegistry(fixture.archive, dist, { beta: '1.0.0-beta.1' })).toThrow();
		expect(() =>
			validateRegistry(fixture.archive, { ...dist, attestations: {} }, { beta: version }),
		).toThrow();
	});
});

describe('publishing workflow contract', () => {
	it('prepares one archive and installs that exact file before upload', () => {
		const workflow = readFileSync('.github/workflows/prepare-release.yml', 'utf8');
		expect(workflow).toContain('git fetch --no-tags origin main:refs/remotes/origin/main');
		expect(workflow).toContain('npm pack --json --pack-destination');
		expect(workflow).toContain('node scripts/verify-package-clean-host.mjs --archive "$archive"');
		expect(workflow).toContain(
			'node scripts/release-gate.mjs archive "$RELEASE_TAG" "$archive" "$archive.sha256"',
		);
	});

	it('publishes downloaded reviewed archives with distinct beta and normal paths', () => {
		const normal = readFileSync('.github/workflows/publish.yml', 'utf8');
		const beta = readFileSync('.github/workflows/publish-first-beta.yml', 'utf8');
		expect(normal).toContain("if: github.event.release.tag_name != 'v1.0.0-beta.2'");
		expect(normal).toContain(
			'npm publish "$archive" --provenance --access public --tag "$dist_tag"',
		);
		expect(beta).toContain('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}');
		expect(beta).toContain(
			'npm publish "$RUNNER_TEMP/release-archive/iljailjic-n8n-nodes-caldav-1.0.0-beta.2.tgz" --provenance --access public --tag beta',
		);
	});
});
