// Repository file reads are required for deterministic harness-boundary tests.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { readFile, readdir } from 'node:fs/promises';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { join, relative } from 'node:path';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { cwd } from 'node:process';

import { describe, expect, it } from 'vitest';

const EXPECTED_PYTHON_BASE =
	'python:3.13.14-alpine3.24@sha256:399babc8b49529dabfd9c922f2b5eea81d611e4512e3ed250d75bd2e7683f4b0';
const EXPECTED_RADICALE_VERSION = '3.7.7';

interface PackageManifest {
	readonly dependencies?: Readonly<Record<string, string>>;
	readonly devDependencies?: Readonly<Record<string, string>>;
	readonly files?: readonly string[];
	readonly scripts?: Readonly<Record<string, string>>;
}

async function readRepositoryFile(path: string): Promise<string> {
	return await readFile(join(cwd(), path), 'utf8');
}

async function readPackageManifest(): Promise<PackageManifest> {
	return JSON.parse(await readRepositoryFile('package.json')) as PackageManifest;
}

async function findFilesNamed(directory: string, name: string): Promise<string[]> {
	const matches: string[] = [];
	const entries = await readdir(directory, { withFileTypes: true });

	for (const entry of entries) {
		if (entry.name === '.git' || entry.name === '.codex-runtime' || entry.name === 'node_modules') {
			continue;
		}

		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			matches.push(...(await findFilesNamed(path, name)));
		} else if (entry.isFile() && entry.name === name) {
			matches.push(relative(cwd(), path));
		}
	}

	return matches.sort();
}

describe('Radicale harness public commands and test discovery', () => {
	it('pre-seeds the UID Update field before reading its exact caller ETag', async () => {
		const integrationTest = await readRepositoryFile(
			'test/integration/radicale-harness.integration.test.ts',
		);
		const scenarioStart = integrationTest.indexOf(
			"it('updates by UID with an exact caller ETag through REPORT -> PUT -> GET'",
		);
		const scenarioEnd = integrationTest.indexOf(
			"it('maps a stale caller ETag to one terminal conflict with no read-back'",
			scenarioStart,
		);
		const scenario = integrationTest.slice(scenarioStart, scenarioEnd);
		const seedPutIndex = scenario.indexOf("authenticatedFetch(run, eventUrl, 'PUT', seededBody)");
		const etagCaptureIndex = scenario.indexOf("const suppliedEtag = before.headers.get('etag')");

		expect(scenarioStart).toBeGreaterThanOrEqual(0);
		expect(scenarioEnd).toBeGreaterThan(scenarioStart);
		expect(scenario).toContain("'LOCATION:Before UID oracle'");
		expect(scenario).toContain("value: 'UID oracle'");
		expect(seedPutIndex).toBeGreaterThanOrEqual(0);
		expect(etagCaptureIndex).toBeGreaterThanOrEqual(0);
		expect(seedPutIndex).toBeLessThan(etagCaptureIndex);
		expect(scenario).toContain("toEqual(['REPORT', 'PUT', 'GET'])");
	});

	it('keeps npm test as the aggregate unit-plus-integration CI entry point', async () => {
		const scripts = (await readPackageManifest()).scripts ?? {};

		expect(scripts['test:integration']).toBe('vitest run --config vitest.integration.config.mts');
		expect(scripts.test).toContain('vitest run --config vitest.config.mts');
		expect(scripts.test).toContain('npm run test:integration');
	});

	it('uses separate, mutually exclusive Vitest discovery configurations', async () => {
		const unitConfig = await readRepositoryFile('vitest.config.mts');
		const integrationConfig = await readRepositoryFile('vitest.integration.config.mts');

		expect(unitConfig).toContain("include: ['test/unit/**/*.test.ts']");
		expect(unitConfig).toContain("exclude: ['test/integration/**', 'test/e2e/**']");
		expect(integrationConfig).toContain("include: ['test/integration/**/*.integration.test.ts']");
		expect(integrationConfig).toContain("exclude: ['test/unit/**'");
	});

	it('keeps the unchanged Node.js matrix wired through npm test', async () => {
		const ciWorkflow = await readRepositoryFile('.github/workflows/ci.yml');

		expect(ciWorkflow).toMatch(/node-version:\s*\n\s*- '22'\s*\n\s*- '24'/);
		expect(ciWorkflow).toContain('run: npm test --if-present');
		expect(ciWorkflow).not.toContain('test:integration');
	});

	it('documents the direct command, Docker prerequisite, isolation, and mandatory cleanup', async () => {
		const readme = await readRepositoryFile('README.md');

		expect(readme).toContain('npm run test:integration');
		expect(readme).toMatch(/Docker/i);
		expect(readme).toMatch(/(?:isolat|ephemeral|unique)/i);
		expect(readme).toMatch(/(?:clean[ -]?up|tear[ -]?down)/i);
	});
});

describe('Radicale image pinning and production separation', () => {
	it('keeps read-only calendar rights run-scoped, first-match, and inside the harness', async () => {
		const harness = await readRepositoryFile(
			'test/integration/support/radicale-harness-adapter.ts',
		);
		const harnessContract = await readRepositoryFile(
			'test/integration/support/radicale-harness-contract.ts',
		);
		const integrationTest = await readRepositoryFile(
			'test/integration/radicale-harness.integration.test.ts',
		);

		expect(harnessContract).toContain(
			'makeCalendarReadOnly(run: RadicaleRun, collectionUrl: string): Promise<void>',
		);
		expect(harness).toContain('[read-only-calendar]');
		expect(harness).toContain('permissions = r');
		expect(harness).toContain('[run-root]');
		expect(harness).toContain('permissions = R');
		expect(harness).toContain('[run-owner]');
		expect(harness).toContain('permissions = RWrw');
		expect(harness).toContain('type = from_file');
		expect(harness).toContain('RIGHTS_PATH = `${CONFIG_DIRECTORY}/rights`');
		expect(harness).toContain('the calendar URL is not an exact run-owned collection URL');
		expect(integrationTest).toContain('harness.makeCalendarReadOnly');
		expect(integrationTest).not.toMatch(/spawn\(|execFile\(|docker/);
	});

	it('keeps host access race-free and loopback-only without publishing the internal network', async () => {
		const harness = await readRepositoryFile(
			'test/integration/support/radicale-harness-adapter.ts',
		);

		expect(harness).toContain('server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }');
		expect(harness).toContain("'--internal'");
		expect(harness).toContain("'exec'");
		expect(harness).toContain('network.Internal === true');
		expect(harness).toContain('attachedNetworkNames.length === 1');
		expect(harness).not.toContain("'--publish'");
	});

	it('builds Radicale from the accepted immutable official Python base and exact version', async () => {
		const dockerfiles = await findFilesNamed(cwd(), 'Dockerfile');
		const radicaleDockerfiles: Array<{ path: string; source: string }> = [];

		for (const path of dockerfiles) {
			const source = await readRepositoryFile(path);
			if (/\bRadicale\b/i.test(source)) {
				radicaleDockerfiles.push({ path, source });
			}
		}

		expect(radicaleDockerfiles, 'expected exactly one test-only Radicale Dockerfile').toHaveLength(
			1,
		);
		const [{ path, source }] = radicaleDockerfiles;
		expect(path).toMatch(/^test\/integration\//);
		expect(source).toMatch(new RegExp(`^FROM ${EXPECTED_PYTHON_BASE}$`, 'm'));
		expect(source).toMatch(new RegExp(`(?:^|\\s)Radicale==${EXPECTED_RADICALE_VERSION}(?:\\s|$)`));
		expect(source).not.toMatch(/^FROM\s+[^\s@]+(?:\s|$)/m);
	});

	it('keeps Python, Radicale, and harness artifacts outside production dependencies and package files', async () => {
		const manifest = await readPackageManifest();
		const productionDependencies = Object.keys(manifest.dependencies ?? {});
		const developmentDependencies = Object.keys(manifest.devDependencies ?? {});

		expect(productionDependencies).not.toContain('radicale');
		expect(productionDependencies).not.toContain('python');
		expect(developmentDependencies).not.toContain('radicale');
		expect(developmentDependencies).not.toContain('python');
		expect(manifest.files).toEqual(['dist']);
	});

	it('keeps the production compiler boundary limited to credentials and node sources', async () => {
		const tsconfig = JSON.parse(await readRepositoryFile('tsconfig.json')) as {
			readonly include?: readonly string[];
		};

		expect(tsconfig.include).toEqual([
			'credentials/**/*',
			'nodes/**/*',
			'nodes/**/*.json',
			'package.json',
		]);
		expect(tsconfig.include).not.toContain('test/**/*');
	});
});
