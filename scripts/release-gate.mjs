#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXPECTED_PACKAGE_FILES } from './verify-package-contents.mjs';

const PACKAGE_NAME = '@iljailjic/n8n-nodes-caldav';
const REPOSITORY_URL = 'git+https://github.com/iljailjic/n8n-nodes-caldav.git';
const REPOSITORY_NAME = 'iljailjic/n8n-nodes-caldav';
const FIRST_BETA = '1.0.0-beta.2';
const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function fail(message) {
	throw new Error(message);
}

function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

function run(command, args) {
	const result = spawnSync(command, args, { encoding: 'utf8' });
	if (result.error || result.status !== 0) {
		fail(`${command} ${args[0]} failed`);
	}
	return result.stdout.trim();
}

export function validateVersion(tag, version) {
	if (!tag.startsWith('v') || tag !== `v${version}`) {
		fail('Release tag must be v-prefixed and match package version exactly');
	}
	const match = SEMVER.exec(version);
	if (
		!match ||
		Number(match[1]) < 1 ||
		![match[1], match[2], match[3]].every((part) => Number.isSafeInteger(Number(part)))
	) {
		fail('Release version must be valid SemVer with base at least 1.0.0');
	}
	return { prerelease: match[4] !== undefined, version };
}

export function validateMetadata({ tag, phase, manifest, lock, changelog, tagCommit, mainCommit }) {
	if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY !== REPOSITORY_NAME) {
		fail('Unexpected GitHub repository');
	}
	if (manifest.name !== PACKAGE_NAME || manifest.repository?.url !== REPOSITORY_URL) {
		fail('Unexpected package or repository identity');
	}
	if (
		lock.name !== PACKAGE_NAME ||
		lock.version !== manifest.version ||
		lock.packages?.['']?.name !== PACKAGE_NAME ||
		lock.packages?.['']?.version !== manifest.version
	) {
		fail('Package lock identity or version does not match package.json');
	}
	const release = validateVersion(tag, manifest.version);
	if (!changelog.split('\n').some((line) => line.startsWith(`## [${manifest.version}] `))) {
		fail('CHANGELOG.md has no exact section for the package version');
	}
	if (tagCommit !== mainCommit) {
		fail('Checkout HEAD does not match the existing release tag');
	}
	if (phase === 'first-beta' && manifest.version !== FIRST_BETA) {
		fail('One-time beta publication is limited to 1.0.0-beta.2');
	}
	if (!['prepare', 'publish', 'first-beta'].includes(phase)) {
		fail('Unknown release phase');
	}
	return release;
}

export function validateRelease(release, tag, phase, prerelease) {
	if (
		!['prepare', 'prepare-uploaded', 'publish', 'first-beta', 'first-beta-published'].includes(
			phase,
		)
	) {
		fail('Unknown release phase');
	}
	const shouldBeDraft = !['publish', 'first-beta-published'].includes(phase);
	if (
		release.tag_name !== tag ||
		release.draft !== shouldBeDraft ||
		release.prerelease !== prerelease
	) {
		fail('GitHub Release tag, draft state, or prerelease type does not match package');
	}
	if (!Number.isSafeInteger(release.id) || release.id <= 0) {
		fail('GitHub Release has no valid ID');
	}
	if (phase === 'publish' && tag === `v${FIRST_BETA}`) {
		fail('The first beta must only be published by the one-time manual workflow');
	}
	if (phase.startsWith('first-beta') && tag !== `v${FIRST_BETA}`) {
		fail('The one-time workflow only accepts the first beta');
	}
	return release;
}

export function validateAssets(release, archiveName, digest, phase, checksumDigest) {
	if (!Array.isArray(release.assets)) fail('GitHub Release assets are missing');
	const checksumName = `${archiveName}.sha256`;
	for (const name of [archiveName, checksumName]) {
		const matches = release.assets.filter((asset) => asset.name === name);
		if (matches.length !== (phase === 'prepare' ? 0 : 1)) {
			fail(`Expected ${phase === 'prepare' ? 'no' : 'one'} release asset named ${name}`);
		}
		if (
			phase !== 'prepare' &&
			(matches[0].state !== 'uploaded' ||
				matches[0].digest !== `sha256:${name === archiveName ? digest : checksumDigest}`)
		) {
			fail(`GitHub asset digest or state does not match the reviewed ${name}`);
		}
	}
}

export function archiveNameFor(version) {
	return `iljailjic-n8n-nodes-caldav-${version}.tgz`;
}

export function checksumFor(archive) {
	return createHash('sha256').update(readFileSync(archive)).digest('hex');
}

export function validateArchive({ tag, archive, checksum, release }) {
	const version = tag.startsWith('v') ? tag.slice(1) : '';
	validateVersion(tag, version);
	const archiveName = archiveNameFor(version);
	if (basename(archive) !== archiveName || basename(checksum) !== `${archiveName}.sha256`) {
		fail('Archive or checksum filename does not match the version tag');
	}
	const digest = checksumFor(archive);
	const checksumBytes = readFileSync(checksum);
	if (checksumBytes.toString('utf8') !== `${digest}  ${archiveName}\n`) {
		fail('Archive checksum does not match the exact archive');
	}
	const entries = run('tar', ['-tzf', archive]).split('\n');
	const expected = new Set([...EXPECTED_PACKAGE_FILES].map((path) => `package/${path}`));
	if (
		entries.length !== expected.size ||
		new Set(entries).size !== entries.length ||
		entries.some((entry) => !expected.has(entry))
	) {
		fail('Archive entries do not match the reviewed package manifest');
	}
	const manifest = JSON.parse(run('tar', ['-xOzf', archive, 'package/package.json']));
	if (
		manifest.name !== PACKAGE_NAME ||
		manifest.version !== version ||
		manifest.repository?.url !== REPOSITORY_URL
	) {
		fail('Archive package identity differs from the release metadata');
	}
	if (release)
		validateAssets(
			release,
			archiveName,
			digest,
			'publish',
			createHash('sha256').update(checksumBytes).digest('hex'),
		);
	return digest;
}

export function validateRegistry(archive, dist, tags) {
	const integrity = `sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}`;
	if (dist.integrity !== integrity || tags.beta !== FIRST_BETA) {
		fail('npm version, beta dist-tag, or exact archive integrity differs from publication');
	}
	if (
		typeof dist.attestations?.url !== 'string' ||
		dist.attestations.provenance?.predicateType !== 'https://slsa.dev/provenance/v1'
	) {
		fail('npm package provenance attestation is missing');
	}
}

function main(args) {
	const [command, ...parameters] = args;
	if (command === 'metadata' && parameters.length === 2) {
		const [phase, tag] = parameters;
		const tagCommit = run('git', ['rev-parse', `refs/tags/${tag}^{commit}`]);
		const checkoutCommit = run('git', ['rev-parse', 'HEAD']);
		const release = validateMetadata({
			tag,
			phase,
			manifest: readJson('package.json'),
			lock: readJson('package-lock.json'),
			changelog: readFileSync('CHANGELOG.md', 'utf8'),
			tagCommit,
			mainCommit: checkoutCommit,
		});
		run('git', ['merge-base', '--is-ancestor', tagCommit, 'refs/remotes/origin/main']);
		console.log(`Release metadata valid: ${tag} (${release.prerelease ? 'prerelease' : 'stable'})`);
		return;
	}
	if (command === 'release' && parameters.length === 3) {
		const [phase, tag, jsonPath] = parameters;
		const { prerelease, version } = validateVersion(tag, readJson('package.json').version);
		const release = validateRelease(readJson(jsonPath), tag, phase, prerelease);
		if (phase === 'prepare') validateAssets(release, archiveNameFor(version), '', phase);
		console.log(`GitHub Release valid: ${tag}`);
		return;
	}
	if (command === 'checksum' && parameters.length === 1) {
		const [archive] = parameters;
		const digest = checksumFor(archive);
		writeFileSync(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`, { flag: 'wx' });
		console.log(digest);
		return;
	}
	if (command === 'archive' && (parameters.length === 3 || parameters.length === 4)) {
		const [tag, archive, checksum, jsonPath] = parameters;
		console.log(
			validateArchive({
				tag,
				archive,
				checksum,
				release: jsonPath ? readJson(jsonPath) : undefined,
			}),
		);
		return;
	}
	if (command === 'registry' && parameters.length === 3) {
		validateRegistry(parameters[0], readJson(parameters[1]), readJson(parameters[2]));
		console.log('npm archive, beta dist-tag, and provenance metadata valid');
		return;
	}
	fail(
		'Usage: release-gate.mjs metadata <phase> <tag> | release <phase> <tag> <json> | checksum <archive> | archive <tag> <archive> <checksum> [release-json] | registry <archive> <dist-json> <tags-json>',
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
