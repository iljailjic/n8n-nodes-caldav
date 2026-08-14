#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const EXPECTED_PACKAGE_NAME = '@iljailjic/n8n-nodes-caldav';
const EXPECTED_PACKAGE_VERSION = '0.3.0';
const EXPECTED_PACKAGE_FILES = new Set([
	'LICENSE.md',
	'README.md',
	'dist/credentials/CalDavApi.credentials.d.ts',
	'dist/credentials/CalDavApi.credentials.js',
	'dist/credentials/CalDavApi.credentials.js.map',
	'dist/nodes/CalDav/caldav.dark.svg',
	'dist/nodes/CalDav/CalDav.node.d.ts',
	'dist/nodes/CalDav/CalDav.node.js',
	'dist/nodes/CalDav/CalDav.node.js.map',
	'dist/nodes/CalDav/CalDav.node.json',
	'dist/nodes/CalDav/caldav.svg',
	'dist/nodes/CalDav/actions/calendar/get.d.ts',
	'dist/nodes/CalDav/actions/calendar/get.js',
	'dist/nodes/CalDav/actions/calendar/get.js.map',
	'dist/nodes/CalDav/discovery/calendarHome.d.ts',
	'dist/nodes/CalDav/discovery/calendarHome.js',
	'dist/nodes/CalDav/discovery/calendarHome.js.map',
	'dist/nodes/CalDav/discovery/calendarCollections.d.ts',
	'dist/nodes/CalDav/discovery/calendarCollections.js',
	'dist/nodes/CalDav/discovery/calendarCollections.js.map',
	'dist/nodes/CalDav/discovery/calendarDiscovery.d.ts',
	'dist/nodes/CalDav/discovery/calendarDiscovery.js',
	'dist/nodes/CalDav/discovery/calendarDiscovery.js.map',
	'dist/nodes/CalDav/discovery/capabilities.d.ts',
	'dist/nodes/CalDav/discovery/capabilities.js',
	'dist/nodes/CalDav/discovery/capabilities.js.map',
	'dist/nodes/CalDav/discovery/currentUserPrincipal.d.ts',
	'dist/nodes/CalDav/discovery/currentUserPrincipal.js',
	'dist/nodes/CalDav/discovery/currentUserPrincipal.js.map',
	'dist/nodes/CalDav/events/create.d.ts',
	'dist/nodes/CalDav/events/create.js',
	'dist/nodes/CalDav/events/create.js.map',
	'dist/nodes/CalDav/events/getByResourceUrl.d.ts',
	'dist/nodes/CalDav/events/getByResourceUrl.js',
	'dist/nodes/CalDav/events/getByResourceUrl.js.map',
	'dist/nodes/CalDav/events/mutations.d.ts',
	'dist/nodes/CalDav/events/mutations.js',
	'dist/nodes/CalDav/events/mutations.js.map',
	'dist/nodes/CalDav/events/resolveByUid.d.ts',
	'dist/nodes/CalDav/events/resolveByUid.js',
	'dist/nodes/CalDav/events/resolveByUid.js.map',
	'dist/nodes/CalDav/events/timeRangeQuery.d.ts',
	'dist/nodes/CalDav/events/timeRangeQuery.js',
	'dist/nodes/CalDav/events/timeRangeQuery.js.map',
	'dist/nodes/CalDav/icalendar/eventReadModel.d.ts',
	'dist/nodes/CalDav/icalendar/eventReadModel.js',
	'dist/nodes/CalDav/icalendar/eventReadModel.js.map',
	'dist/nodes/CalDav/icalendar/parser.d.ts',
	'dist/nodes/CalDav/icalendar/parser.js',
	'dist/nodes/CalDav/icalendar/parser.js.map',
	'dist/nodes/CalDav/icalendar/patcher.d.ts',
	'dist/nodes/CalDav/icalendar/patcher.js',
	'dist/nodes/CalDav/icalendar/patcher.js.map',
	'dist/nodes/CalDav/icalendar/serializer.d.ts',
	'dist/nodes/CalDav/icalendar/serializer.js',
	'dist/nodes/CalDav/icalendar/serializer.js.map',
	'dist/nodes/CalDav/methods/credentialTest.d.ts',
	'dist/nodes/CalDav/methods/credentialTest.js',
	'dist/nodes/CalDav/methods/credentialTest.js.map',
	'dist/nodes/CalDav/providers/icloud.d.ts',
	'dist/nodes/CalDav/providers/icloud.js',
	'dist/nodes/CalDav/providers/icloud.js.map',
	'dist/nodes/CalDav/providers/registry.d.ts',
	'dist/nodes/CalDav/providers/registry.js',
	'dist/nodes/CalDav/providers/registry.js.map',
	'dist/nodes/CalDav/providers/standard.d.ts',
	'dist/nodes/CalDav/providers/standard.js',
	'dist/nodes/CalDav/providers/standard.js.map',
	'dist/nodes/CalDav/providers/types.d.ts',
	'dist/nodes/CalDav/providers/types.js',
	'dist/nodes/CalDav/providers/types.js.map',
	'dist/nodes/CalDav/transport/http.d.ts',
	'dist/nodes/CalDav/transport/http.js',
	'dist/nodes/CalDav/transport/http.js.map',
	'dist/nodes/CalDav/transport/url.d.ts',
	'dist/nodes/CalDav/transport/url.js',
	'dist/nodes/CalDav/transport/url.js.map',
	'dist/nodes/CalDav/xml/errors.d.ts',
	'dist/nodes/CalDav/xml/errors.js',
	'dist/nodes/CalDav/xml/errors.js.map',
	'dist/nodes/CalDav/xml/escape.d.ts',
	'dist/nodes/CalDav/xml/escape.js',
	'dist/nodes/CalDav/xml/escape.js.map',
	'dist/nodes/CalDav/xml/namespaces.d.ts',
	'dist/nodes/CalDav/xml/namespaces.js',
	'dist/nodes/CalDav/xml/namespaces.js.map',
	'dist/nodes/CalDav/xml/parser.d.ts',
	'dist/nodes/CalDav/xml/parser.js',
	'dist/nodes/CalDav/xml/parser.js.map',
	'dist/nodes/CalDav/xml/requests.d.ts',
	'dist/nodes/CalDav/xml/requests.js',
	'dist/nodes/CalDav/xml/requests.js.map',
	'dist/package.json',
	'package.json',
]);

function parsePackOutput(packOutput) {
	let packResults;

	try {
		packResults = JSON.parse(packOutput);
	} catch {
		throw new Error('npm pack did not produce valid JSON output');
	}

	if (!Array.isArray(packResults) || packResults.length !== 1) {
		throw new Error('npm pack must report exactly one package result');
	}

	return packResults[0];
}

function validatePackResult(packResult) {
	if (!packResult || typeof packResult !== 'object') {
		throw new Error('npm pack returned an invalid package result');
	}

	if (
		packResult.name !== EXPECTED_PACKAGE_NAME ||
		packResult.version !== EXPECTED_PACKAGE_VERSION
	) {
		throw new Error('npm pack returned unexpected package identity');
	}

	if (!Array.isArray(packResult.files)) {
		throw new Error('npm pack result is missing its file listing');
	}

	if (packResult.entryCount !== packResult.files.length) {
		throw new Error('npm pack result has an invalid entry count');
	}

	if (!Array.isArray(packResult.bundled)) {
		throw new Error('npm pack result is missing its bundled dependency listing');
	}

	if (packResult.bundled.length > 0) {
		throw new Error(`Bundled dependencies detected:\n${packResult.bundled.join('\n')}`);
	}

	const packagePaths = packResult.files.map((file) => {
		if (!file || typeof file !== 'object' || typeof file.path !== 'string' || file.path === '') {
			throw new Error('npm pack result contains an invalid file entry');
		}

		return file.path;
	});
	const uniquePackagePaths = new Set(packagePaths);

	if (uniquePackagePaths.size !== packagePaths.length) {
		throw new Error('npm pack result contains duplicate file entries');
	}

	const missingPaths = [...EXPECTED_PACKAGE_FILES]
		.filter((filePath) => !uniquePackagePaths.has(filePath))
		.sort();
	const unexpectedPaths = packagePaths
		.filter((filePath) => !EXPECTED_PACKAGE_FILES.has(filePath))
		.sort();

	if (missingPaths.length > 0 || unexpectedPaths.length > 0) {
		const details = [
			...missingPaths.map((filePath) => `missing: ${filePath}`),
			...unexpectedPaths.map((filePath) => `unexpected: ${filePath}`),
		];
		throw new Error(`Package contents do not match the expected manifest:\n${details.join('\n')}`);
	}
}

export function verifyPackOutput(packOutput) {
	validatePackResult(parsePackOutput(packOutput));
}

function runNpmPack() {
	const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
	const pack = spawnSync(npmCommand, ['pack', '--dry-run', '--json'], {
		encoding: 'utf8',
	});

	if (pack.error) {
		throw new Error(`Unable to run npm pack: ${pack.error.message}`);
	}

	if (pack.status !== 0) {
		throw new Error(`npm pack failed with exit code ${pack.status ?? 'unknown'}`);
	}

	return pack.stdout;
}

function main() {
	const arguments_ = process.argv.slice(2);
	if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== '--stdin')) {
		throw new Error('Usage: verify-package-contents.mjs [--stdin]');
	}

	const packOutput = arguments_[0] === '--stdin' ? readFileSync(0, 'utf8') : runNpmPack();
	verifyPackOutput(packOutput);

	console.log(`Package contents match the exact ${EXPECTED_PACKAGE_FILES.size}-file manifest.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
