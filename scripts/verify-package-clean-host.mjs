#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@iljailjic/n8n-nodes-caldav';
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const RUNTIME_ROOT = resolve(PACKAGE_ROOT, '.codex-runtime');
const ALLOWED_PACKAGE_PATHS = /^(?:LICENSE\.md|README\.md|package\.json|dist\/)/;
const FORBIDDEN_PACKAGE_PATHS =
	/(?:^|\/)(?:test|tests|fixtures|node_modules|\.codex-runtime)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|(?:secret|private)/i;

function run(command, arguments_, cwd) {
	const result = spawnSync(command, arguments_, {
		cwd,
		env: { ...process.env, npm_config_cache: join(RUNTIME_ROOT, 'npm-cache') },
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	if (result.error) {
		throw new Error(`Unable to run ${command}: ${result.error.message}`);
	}

	if (result.status !== 0) {
		throw new Error(
			`${command} ${arguments_.join(' ')} failed with exit code ${result.status ?? 'unknown'}:\n${result.stderr}`,
		);
	}

	return result.stdout;
}

function packageArchiveFrom(packOutput, archiveDirectory) {
	let results;
	try {
		results = JSON.parse(packOutput);
	} catch {
		throw new Error('npm pack did not produce valid JSON output');
	}

	if (!Array.isArray(results) || results.length !== 1 || typeof results[0]?.filename !== 'string') {
		throw new Error('npm pack must report exactly one archive filename');
	}

	const packResult = results[0];
	if (packResult.name !== PACKAGE_NAME || !Array.isArray(packResult.files)) {
		throw new Error('npm pack returned an invalid package result');
	}

	const paths = packResult.files.map((file) => file?.path);
	if (!paths.every((path) => typeof path === 'string' && ALLOWED_PACKAGE_PATHS.test(path))) {
		throw new Error('Package archive contains a path outside the production allowlist');
	}
	if (paths.some((path) => FORBIDDEN_PACKAGE_PATHS.test(path))) {
		throw new Error('Package archive contains test, fixture, private, or secret data');
	}

	return resolve(archiveDirectory, basename(packResult.filename));
}

async function main() {
	await mkdir(RUNTIME_ROOT, { recursive: true });
	const cleanHostRoot = await mkdtemp(join(RUNTIME_ROOT, 'package-clean-host-'));
	const archiveDirectory = join(cleanHostRoot, 'archive');
	const installDirectory = join(cleanHostRoot, 'install');
	await mkdir(archiveDirectory);
	await mkdir(installDirectory);

	const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
	const packOutput = run(
		npmCommand,
		['pack', '--json', '--pack-destination', archiveDirectory],
		PACKAGE_ROOT,
	);
	const packageArchive = packageArchiveFrom(packOutput, archiveDirectory);

	await writeFile(
		join(installDirectory, 'package.json'),
		JSON.stringify({ name: 'caldav-clean-host-validation', private: true }),
	);
	run(
		npmCommand,
		[
			'install',
			'--ignore-scripts',
			'--no-package-lock',
			'--offline',
			'--omit=dev',
			'--omit=optional',
			'--omit=peer',
			'--legacy-peer-deps',
			'--no-audit',
			'--no-fund',
			packageArchive,
		],
		installDirectory,
	);
	const peerDirectory = join(installDirectory, 'node_modules', 'n8n-workflow');
	await mkdir(peerDirectory);
	await writeFile(
		join(peerDirectory, 'package.json'),
		JSON.stringify({ name: 'n8n-workflow', version: '0.0.0-clean-host-harness' }),
	);
	await writeFile(
		join(peerDirectory, 'index.js'),
		[
			'class NodeApiError extends Error {}',
			'class NodeOperationError extends Error {}',
			'exports.NodeApiError = NodeApiError;',
			"exports.NodeConnectionTypes = { Main: 'main' };",
			'exports.NodeOperationError = NodeOperationError;',
		].join('\n'),
	);

	const installedManifest = JSON.parse(
		await readFile(
			join(installDirectory, 'node_modules', ...PACKAGE_NAME.split('/'), 'package.json'),
			'utf8',
		),
	);
	const registrations = [
		...(installedManifest.n8n?.credentials ?? []),
		...(installedManifest.n8n?.nodes ?? []),
	];
	if (registrations.length !== 2) {
		throw new Error(
			'Installed package does not declare exactly one node and one credential registration',
		);
	}
	await Promise.all(
		registrations.map((registration) =>
			access(
				join(installDirectory, 'node_modules', ...PACKAGE_NAME.split('/'), registration),
				constants.R_OK,
			),
		),
	);

	run(
		process.execPath,
		[
			'--eval',
			`const packageRoot = require.resolve('${PACKAGE_NAME}/package.json').replace(/package\\.json$/, '');\n` +
				`const { CalDav } = require(packageRoot + '${installedManifest.n8n.nodes[0]}');\n` +
				`const { CalDavApi } = require(packageRoot + '${installedManifest.n8n.credentials[0]}');\n` +
				"if (new CalDav().description.name !== 'calDav' || new CalDavApi().name !== 'calDavApi') process.exit(1);",
		],
		installDirectory,
	);

	console.log(`Clean-host archive install/load validation passed: ${cleanHostRoot}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
