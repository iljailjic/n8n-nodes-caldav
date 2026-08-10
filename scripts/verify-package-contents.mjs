#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const TEST_DIRECTORY_NAMES = new Set(['test', 'tests', '__tests__']);
const FIXTURE_DIRECTORY_NAMES = new Set(['fixture', 'fixtures', '__fixtures__']);
const TEST_FILE_PATTERN = /\.(?:spec|test)\.[^/]+$/i;
const VITEST_FILE_PATTERN = /^vitest(?:\.|-|$)/i;

function normalizePackagePath(filePath) {
	return filePath.replaceAll('\\', '/').replace(/^package\//, '');
}

function isProhibitedPath(filePath) {
	const normalizedPath = normalizePackagePath(filePath);
	const pathSegments = normalizedPath.toLowerCase().split('/');
	const fileName = pathSegments.at(-1) ?? '';

	return (
		pathSegments.some((segment) => TEST_DIRECTORY_NAMES.has(segment)) ||
		pathSegments.some((segment) => FIXTURE_DIRECTORY_NAMES.has(segment)) ||
		TEST_FILE_PATTERN.test(fileName) ||
		VITEST_FILE_PATTERN.test(fileName) ||
		pathSegments.includes('vitest') ||
		pathSegments.includes('@vitest')
	);
}

function parsePackOutput(packOutput) {
	let packResults;

	try {
		packResults = JSON.parse(packOutput);
	} catch {
		throw new Error('npm pack did not produce valid JSON output');
	}

	if (!Array.isArray(packResults) || packResults.length === 0) {
		throw new Error('npm pack did not report any package contents');
	}

	return packResults;
}

function collectProhibitedEntries(packResults) {
	const prohibitedEntries = new Set();

	for (const packResult of packResults) {
		if (!packResult || typeof packResult !== 'object') {
			throw new Error('npm pack returned an invalid package result');
		}

		if (!Array.isArray(packResult.files)) {
			throw new Error('npm pack result is missing its file listing');
		}

		for (const file of packResult.files) {
			if (file && typeof file.path === 'string' && isProhibitedPath(file.path)) {
				prohibitedEntries.add(normalizePackagePath(file.path));
			}
		}

		if (Array.isArray(packResult.bundled)) {
			for (const packageName of packResult.bundled) {
				if (
					typeof packageName === 'string' &&
					(packageName.toLowerCase() === 'vitest' ||
						packageName.toLowerCase().startsWith('@vitest/'))
				) {
					prohibitedEntries.add(`bundled dependency: ${packageName}`);
				}
			}
		}
	}

	return [...prohibitedEntries].sort();
}

export function verifyPackOutput(packOutput) {
	const prohibitedEntries = collectProhibitedEntries(parsePackOutput(packOutput));

	if (prohibitedEntries.length > 0) {
		throw new Error(`Prohibited package content detected:\n${prohibitedEntries.join('\n')}`);
	}
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

	console.log('Package contents contain no test, fixture, or Vitest artifacts.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
