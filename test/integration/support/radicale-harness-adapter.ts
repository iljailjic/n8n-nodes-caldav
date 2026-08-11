/* eslint-disable @n8n/community-nodes/no-restricted-imports -- The test-only harness intentionally owns local Docker subprocesses and repository-local runtime state. */
/* eslint-disable @n8n/community-nodes/require-node-api-error -- Harness failures are outside the n8n node execution boundary. */
/* eslint-disable @n8n/community-nodes/no-dangerous-functions -- Docker and the deliberate-failure child test use fixed executable names and argument arrays without a shell. */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { cwd, env, execPath } from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

import type {
	DeliberateFailureProbeResult,
	RadicaleHarnessAdapter,
	RadicaleRun,
	RadicaleRunInspection,
} from './radicale-harness-contract';

const REPOSITORY_ROOT = cwd();
const RUNTIME_ROOT = join(REPOSITORY_ROOT, '.codex-runtime', 'radicale-harness');
const RUNTIME_TMP = join(REPOSITORY_ROOT, '.codex-runtime', 'tmp');
const NPM_CACHE = join(REPOSITORY_ROOT, '.codex-runtime', 'npm-cache');
const DOCKER_CONFIG = join(RUNTIME_ROOT, 'docker-config');
const DOCKERFILE_DIRECTORY = join(REPOSITORY_ROOT, 'test', 'integration', 'radicale');
const VITEST_EXECUTABLE = join(REPOSITORY_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const FAILURE_CONFIG = join(REPOSITORY_ROOT, 'vitest.integration.failure.config.mts');

const IMAGE_NAME = 'n8n-nodes-caldav-radicale:3.7.7-python-3.13.14-alpine3.24';
const PYTHON_BASE =
	'python:3.13.14-alpine3.24@sha256:399babc8b49529dabfd9c922f2b5eea81d611e4512e3ed250d75bd2e7683f4b0';
const RADICALE_VERSION = '3.7.7';
const RUN_LABEL = 'io.n8n-nodes-caldav.radicale-run';
const IMAGE_VERSION_LABEL = 'io.n8n-nodes-caldav.radicale-version';
const IMAGE_BASE_LABEL = 'io.n8n-nodes-caldav.python-base';
const CONTAINER_PORT = '5232/tcp';
const CONFIG_DIRECTORY = '/var/lib/radicale/.harness';
const CONFIG_PATH = `${CONFIG_DIRECTORY}/config`;
const USERS_PATH = `${CONFIG_DIRECTORY}/users`;
const STORAGE_PATH = '/var/lib/radicale/storage';
const READINESS_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 30_000;
const BUILD_TIMEOUT_MS = 5 * 60_000;
const MAX_CAPTURE_BYTES = 256 * 1024;

type HarnessStage =
	| 'docker capability'
	| 'image build'
	| 'startup'
	| 'authenticated readiness'
	| 'storage reset'
	| 'service stop'
	| 'inspection'
	| 'test'
	| 'cleanup';

interface CommandResult {
	readonly status: number;
	readonly stdout: string;
	readonly stderr: string;
}

interface CommandOptions {
	readonly allowNonzero?: boolean;
	readonly input?: string;
	readonly timeoutMs?: number;
	readonly environment?: NodeJS.ProcessEnv;
}

interface InternalRun {
	readonly identity: string;
	readonly username: string;
	readonly password: string;
	readonly configurationIdentity: string;
	readonly serviceIdentity: string;
	readonly storageIdentity: string;
	readonly networkIdentity: string;
	endpoint?: string;
}

interface DockerMount {
	readonly Destination?: unknown;
	readonly Name?: unknown;
	readonly Type?: unknown;
}

interface DockerPortBinding {
	readonly HostIp?: unknown;
	readonly HostPort?: unknown;
}

class HarnessStageError extends Error {
	readonly stage: HarnessStage;

	constructor(stage: HarnessStage, detail: string) {
		super(`Radicale harness ${stage} failed: ${detail}`);
		this.name = 'HarnessStageError';
		this.stage = stage;
	}
}

const runs = new Map<string, InternalRun>();
let imageBuildPromise: Promise<void> | undefined;

function appendCaptured(previous: string, chunk: Buffer | string): string {
	if (previous.length >= MAX_CAPTURE_BYTES) {
		return previous;
	}

	return `${previous}${chunk.toString()}`.slice(0, MAX_CAPTURE_BYTES);
}

function commandEnvironment(): NodeJS.ProcessEnv {
	return {
		...(env.PATH === undefined ? {} : { PATH: env.PATH }),
		DOCKER_CONFIG,
		LANG: 'C',
		TMPDIR: RUNTIME_TMP,
	};
}

function testEnvironment(): NodeJS.ProcessEnv {
	return {
		...(env.PATH === undefined ? {} : { PATH: env.PATH }),
		...(env.CI === undefined ? {} : { CI: env.CI }),
		...(env.OPENSSL_CONF === undefined ? {} : { OPENSSL_CONF: env.OPENSSL_CONF }),
		NODE_ENV: 'test',
		TMPDIR: RUNTIME_TMP,
		npm_config_cache: NPM_CACHE,
	};
}

async function ensureRuntimeDirectories(): Promise<void> {
	await Promise.all([
		mkdir(RUNTIME_ROOT, { recursive: true }),
		mkdir(RUNTIME_TMP, { recursive: true }),
		mkdir(NPM_CACHE, { recursive: true }),
		mkdir(DOCKER_CONFIG, { recursive: true }),
	]);
}

async function runCommand(
	command: string,
	arguments_: readonly string[],
	stage: HarnessStage,
	options: CommandOptions = {},
): Promise<CommandResult> {
	await ensureRuntimeDirectories();

	return await new Promise<CommandResult>((resolve, reject) => {
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		let settled = false;
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(command, [...arguments_], {
				cwd: REPOSITORY_ROOT,
				env: options.environment ?? commandEnvironment(),
				stdio: ['pipe', 'pipe', 'pipe'],
			});
		} catch {
			reject(new HarnessStageError(stage, `unable to execute ${command}.`));
			return;
		}
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, options.timeoutMs ?? COMMAND_TIMEOUT_MS);

		child.stdout.on('data', (chunk: Buffer | string) => {
			stdout = appendCaptured(stdout, chunk);
		});
		child.stderr.on('data', (chunk: Buffer | string) => {
			stderr = appendCaptured(stderr, chunk);
		});
		child.stdin.on('error', () => {
			// A closed subprocess will be handled by its exit status below.
		});
		child.once('error', () => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			reject(new HarnessStageError(stage, `unable to execute ${command}.`));
		});
		child.once('close', (status) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			if (timedOut) {
				reject(new HarnessStageError(stage, `${command} exceeded its bounded timeout.`));
				return;
			}

			const exitStatus = status ?? 1;
			if (exitStatus !== 0 && !options.allowNonzero) {
				reject(
					new HarnessStageError(
						stage,
						`${command} ${arguments_[0] ?? ''} exited with status ${exitStatus}.`.trim(),
					),
				);
				return;
			}

			resolve({ status: exitStatus, stdout, stderr });
		});

		child.stdin.end(options.input);
	});
}

async function runDocker(
	arguments_: readonly string[],
	stage: HarnessStage,
	options: Omit<CommandOptions, 'environment'> = {},
): Promise<CommandResult> {
	return await runCommand('docker', arguments_, stage, {
		...options,
		environment: commandEnvironment(),
	});
}

function sanitizedFailure(error: unknown): string {
	return error instanceof HarnessStageError
		? error.message
		: 'Radicale harness encountered an unexpected failure.';
}

function combinedFailure(primary: unknown, cleanup: unknown): HarnessStageError {
	return new HarnessStageError(
		'cleanup',
		`primary failure: ${sanitizedFailure(primary)} Cleanup failure: ${sanitizedFailure(cleanup)}`,
	);
}

function redactDiagnostics(value: string, secrets: readonly string[]): string {
	let sanitized = value
		.replace(/\bauthorization\s*[:=]\s*[^\s,;]+/gi, 'Authorization: [REDACTED]')
		.replace(/\bbasic\s+[A-Za-z0-9+/_=-]+/gi, 'Basic [REDACTED]');

	for (const secret of secrets) {
		if (secret.length > 0) {
			sanitized = sanitized.split(secret).join('[REDACTED]');
		}
	}

	return sanitized;
}

async function assertDockerAvailable(): Promise<void> {
	await runDocker(['version', '--format', '{{.Server.Version}}'], 'docker capability');
}

function hasExpectedImageLabels(stdout: string): boolean {
	try {
		const labels = JSON.parse(stdout) as Record<string, unknown> | null;
		return (
			labels?.[IMAGE_VERSION_LABEL] === RADICALE_VERSION &&
			labels?.[IMAGE_BASE_LABEL] === PYTHON_BASE
		);
	} catch {
		return false;
	}
}

async function buildImageInternal(): Promise<void> {
	await assertDockerAvailable();
	const inspection = await runDocker(
		['image', 'inspect', IMAGE_NAME, '--format', '{{json .Config.Labels}}'],
		'image build',
		{ allowNonzero: true },
	);
	if (inspection.status === 0 && hasExpectedImageLabels(inspection.stdout.trim())) {
		return;
	}

	await runDocker(['build', '--pull', '--tag', IMAGE_NAME, DOCKERFILE_DIRECTORY], 'image build', {
		timeoutMs: BUILD_TIMEOUT_MS,
	});
}

async function buildImage(): Promise<void> {
	if (imageBuildPromise === undefined) {
		imageBuildPromise = buildImageInternal();
	}

	try {
		await imageBuildPromise;
	} catch (error) {
		imageBuildPromise = undefined;
		throw error;
	}
}

function newInternalRun(): InternalRun {
	const identity = randomUUID();
	const prefix = `n8n-caldav-${identity}`;
	return {
		identity,
		username: `oracle-${randomBytes(12).toString('hex')}`,
		password: randomBytes(32).toString('base64url'),
		configurationIdentity: `${prefix}-configuration`,
		serviceIdentity: `${prefix}-service`,
		storageIdentity: `${prefix}-storage`,
		networkIdentity: `${prefix}-network`,
	};
}

function publicRun(run: InternalRun): RadicaleRun {
	if (run.endpoint === undefined) {
		throw new HarnessStageError('startup', 'Docker did not allocate a loopback endpoint.');
	}

	return Object.freeze({
		identity: run.identity,
		endpoint: run.endpoint,
		username: run.username,
		password: run.password,
		configurationIdentity: run.configurationIdentity,
		serviceIdentity: run.serviceIdentity,
		storageIdentity: run.storageIdentity,
	});
}

function lookupRun(run: RadicaleRun): InternalRun {
	const internal = runs.get(run.identity);
	if (
		internal === undefined ||
		internal.endpoint !== run.endpoint ||
		internal.username !== run.username ||
		internal.password !== run.password ||
		internal.configurationIdentity !== run.configurationIdentity ||
		internal.serviceIdentity !== run.serviceIdentity ||
		internal.storageIdentity !== run.storageIdentity
	) {
		throw new HarnessStageError('inspection', 'the run handle is unknown or no longer valid.');
	}

	return internal;
}

function radicaleConfiguration(): string {
	return `[server]
hosts = 0.0.0.0:5232
max_connections = 20
timeout = 10

[auth]
type = htpasswd
htpasswd_filename = ${USERS_PATH}
htpasswd_encryption = plain
delay = 0

[rights]
type = owner_only

[storage]
type = multifilesystem
filesystem_folder = ${STORAGE_PATH}
folder_umask = 0077

[web]
type = none

[logging]
level = warning
`;
}

async function writeContainerFile(run: InternalRun, path: string, contents: string): Promise<void> {
	await runDocker(
		[
			'exec',
			'--interactive',
			run.serviceIdentity,
			'sh',
			'-c',
			`umask 077; mkdir -p ${CONFIG_DIRECTORY}; cat > ${path}`,
		],
		'startup',
		{ input: contents },
	);
}

async function configureContainer(run: InternalRun): Promise<void> {
	await writeContainerFile(run, CONFIG_PATH, radicaleConfiguration());
	await writeContainerFile(run, USERS_PATH, `${run.username}:${run.password}\n`);
}

async function launchService(run: InternalRun): Promise<void> {
	await runDocker(
		['exec', '--detach', run.serviceIdentity, 'python', '-m', 'radicale', '--config', CONFIG_PATH],
		'startup',
	);
}

function basicAuthorization(run: Pick<InternalRun, 'username' | 'password'>): string {
	return `Basic ${Buffer.from(`${run.username}:${run.password}`, 'utf8').toString('base64')}`;
}

async function waitForReadiness(run: InternalRun): Promise<void> {
	if (run.endpoint === undefined) {
		throw new HarnessStageError('authenticated readiness', 'the loopback endpoint is unavailable.');
	}

	const deadline = Date.now() + READINESS_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(run.endpoint, {
				method: 'PROPFIND',
				headers: {
					Authorization: basicAuthorization(run),
					Depth: '0',
					'Content-Type': 'application/xml; charset=utf-8',
				},
				body: '<?xml version="1.0" encoding="UTF-8"?><propfind xmlns="DAV:"><prop><current-user-principal/></prop></propfind>',
				redirect: 'manual',
				signal: AbortSignal.timeout(2_000),
			});
			await response.body?.cancel();
			if (response.status === 207) {
				return;
			}
			if (response.status === 401 || response.status === 403) {
				throw new HarnessStageError(
					'authenticated readiness',
					'the service rejected its generated principal.',
				);
			}
		} catch (error) {
			if (error instanceof HarnessStageError) {
				throw error;
			}
		}

		await new Promise<void>((resolve) => {
			setTimeout(resolve, 100);
		});
	}

	throw new HarnessStageError(
		'authenticated readiness',
		'the service did not accept an authenticated operation before the timeout.',
	);
}

async function readEndpoint(run: InternalRun): Promise<string> {
	const result = await runDocker(['port', run.serviceIdentity, CONTAINER_PORT], 'startup');
	const bindings = result.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (bindings.length !== 1) {
		throw new HarnessStageError('startup', 'Docker returned an ambiguous host binding.');
	}

	const match = /^127\.0\.0\.1:(\d+)$/.exec(bindings[0]);
	if (match === null) {
		throw new HarnessStageError('startup', 'Docker did not publish the service on IPv4 loopback.');
	}

	return `http://127.0.0.1:${match[1]}/`;
}

async function createDockerResources(run: InternalRun): Promise<void> {
	const label = `${RUN_LABEL}=${run.identity}`;
	await runDocker(
		[
			'network',
			'create',
			'--driver',
			'bridge',
			'--internal',
			'--label',
			label,
			run.networkIdentity,
		],
		'startup',
	);
	await runDocker(['volume', 'create', '--label', label, run.storageIdentity], 'startup');
	await runDocker(
		[
			'create',
			'--name',
			run.serviceIdentity,
			'--label',
			label,
			'--network',
			run.networkIdentity,
			'--publish',
			`127.0.0.1::${CONTAINER_PORT}`,
			'--mount',
			`type=volume,source=${run.storageIdentity},destination=${STORAGE_PATH}`,
			'--mount',
			`type=tmpfs,destination=${CONFIG_DIRECTORY},tmpfs-mode=0777`,
			'--mount',
			'type=tmpfs,destination=/tmp,tmpfs-mode=1777',
			'--read-only',
			'--cap-drop',
			'ALL',
			'--security-opt',
			'no-new-privileges',
			'--pids-limit',
			'128',
			'--init',
			IMAGE_NAME,
			'tail',
			'-f',
			'/dev/null',
		],
		'startup',
	);
	await runDocker(['start', run.serviceIdentity], 'startup');
	run.endpoint = await readEndpoint(run);
	await configureContainer(run);
	await launchService(run);
	await waitForReadiness(run);
}

async function listDockerResources(
	category: 'container' | 'network' | 'volume',
	runIdentity: string,
	stage: HarnessStage,
): Promise<string[]> {
	const baseArguments =
		category === 'container' ? ['ps', '--all', '--quiet'] : [category, 'ls', '--quiet'];
	const result = await runDocker(
		[...baseArguments, '--filter', `label=${RUN_LABEL}=${runIdentity}`],
		stage,
	);
	return result.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

async function cleanupResources(runIdentity: string): Promise<void> {
	const failures: string[] = [];
	let containers: string[] = [];
	let volumes: string[] = [];
	let networks: string[] = [];

	try {
		containers = await listDockerResources('container', runIdentity, 'cleanup');
	} catch (error) {
		failures.push(sanitizedFailure(error));
	}
	for (const container of containers) {
		try {
			await runDocker(['rm', '--force', container], 'cleanup');
		} catch (error) {
			failures.push(sanitizedFailure(error));
		}
	}

	try {
		volumes = await listDockerResources('volume', runIdentity, 'cleanup');
	} catch (error) {
		failures.push(sanitizedFailure(error));
	}
	for (const volume of volumes) {
		try {
			await runDocker(['volume', 'rm', volume], 'cleanup');
		} catch (error) {
			failures.push(sanitizedFailure(error));
		}
	}

	try {
		networks = await listDockerResources('network', runIdentity, 'cleanup');
	} catch (error) {
		failures.push(sanitizedFailure(error));
	}
	for (const network of networks) {
		try {
			await runDocker(['network', 'rm', network], 'cleanup');
		} catch (error) {
			failures.push(sanitizedFailure(error));
		}
	}

	if (failures.length > 0) {
		throw new HarnessStageError(
			'cleanup',
			`${failures.length} owned Docker cleanup operation(s) failed.`,
		);
	}
}

async function start(): Promise<RadicaleRun> {
	await buildImage();
	const internal = newInternalRun();
	runs.set(internal.identity, internal);

	try {
		await createDockerResources(internal);
		return publicRun(internal);
	} catch (primaryError) {
		try {
			await cleanupResources(internal.identity);
			runs.delete(internal.identity);
		} catch (cleanupError) {
			throw combinedFailure(primaryError, cleanupError);
		}
		throw primaryError;
	}
}

async function waitForAuthenticatedReadiness(run: RadicaleRun): Promise<void> {
	await waitForReadiness(lookupRun(run));
}

async function stopService(run: RadicaleRun): Promise<void> {
	const internal = lookupRun(run);
	await runDocker(['stop', '--time', '3', internal.serviceIdentity], 'service stop');
}

async function clearStorage(run: InternalRun): Promise<void> {
	const resetContainer = `${run.serviceIdentity}-reset-${randomBytes(4).toString('hex')}`;
	await runDocker(
		[
			'run',
			'--rm',
			'--name',
			resetContainer,
			'--label',
			`${RUN_LABEL}=${run.identity}`,
			'--network',
			'none',
			'--mount',
			`type=volume,source=${run.storageIdentity},destination=${STORAGE_PATH}`,
			IMAGE_NAME,
			'sh',
			'-c',
			`rm -rf ${STORAGE_PATH}/* ${STORAGE_PATH}/.[!.]* ${STORAGE_PATH}/..?*`,
		],
		'storage reset',
	);
}

async function resetStorage(run: RadicaleRun): Promise<void> {
	const internal = lookupRun(run);
	try {
		await runDocker(['stop', '--time', '3', internal.serviceIdentity], 'storage reset');
		await clearStorage(internal);
		await runDocker(['start', internal.serviceIdentity], 'storage reset');
		await configureContainer(internal);
		await launchService(internal);
		await waitForReadiness(internal);
	} catch (primaryError) {
		try {
			await cleanupResources(internal.identity);
			runs.delete(internal.identity);
		} catch (cleanupError) {
			throw combinedFailure(primaryError, cleanupError);
		}
		throw primaryError;
	}
}

async function teardown(run: RadicaleRun): Promise<void> {
	const internal = runs.get(run.identity);
	if (internal !== undefined) {
		lookupRun(run);
	}

	await cleanupResources(run.identity);
	runs.delete(run.identity);
}

async function findLiveResources(runIdentity: string): Promise<readonly string[]> {
	const [containers, volumes, networks] = await Promise.all([
		listDockerResources('container', runIdentity, 'inspection'),
		listDockerResources('volume', runIdentity, 'inspection'),
		listDockerResources('network', runIdentity, 'inspection'),
	]);

	return [
		...containers.map((identity) => `container:${identity}`),
		...volumes.map((identity) => `volume:${identity}`),
		...networks.map((identity) => `network:${identity}`),
	].sort();
}

async function inspect(run: RadicaleRun): Promise<RadicaleRunInspection> {
	const internal = lookupRun(run);
	const [portResult, networkResult, mountResult, liveResourceIdentities] = await Promise.all([
		runDocker(
			['inspect', internal.serviceIdentity, '--format', '{{json .NetworkSettings.Ports}}'],
			'inspection',
		),
		runDocker(
			['network', 'inspect', internal.networkIdentity, '--format', '{{.Internal}}'],
			'inspection',
		),
		runDocker(['inspect', internal.serviceIdentity, '--format', '{{json .Mounts}}'], 'inspection'),
		findLiveResources(internal.identity),
	]);

	let loopbackOnly = false;
	let repositoryLocalRuntimeOnly = false;
	try {
		const ports = JSON.parse(portResult.stdout) as Record<string, DockerPortBinding[]>;
		const bindings = ports[CONTAINER_PORT] ?? [];
		loopbackOnly =
			bindings.length === 1 &&
			bindings[0].HostIp === '127.0.0.1' &&
			typeof bindings[0].HostPort === 'string' &&
			/^\d+$/.test(bindings[0].HostPort);

		const mounts = JSON.parse(mountResult.stdout) as DockerMount[];
		repositoryLocalRuntimeOnly =
			mounts.some(
				(mount) =>
					mount.Type === 'volume' &&
					mount.Name === internal.storageIdentity &&
					mount.Destination === STORAGE_PATH,
			) && mounts.every((mount) => mount.Type === 'volume' || mount.Type === 'tmpfs');
	} catch {
		throw new HarnessStageError('inspection', 'Docker returned malformed resource metadata.');
	}

	const internalNetwork = networkResult.stdout.trim() === 'true';
	return {
		loopbackOnly,
		runtimeInternetEgress: !internalNetwork,
		repositoryLocalRuntimeOnly,
		liveResourceIdentities,
	};
}

async function runDeliberateFailureProbe(): Promise<DeliberateFailureProbeResult> {
	const run = await start();
	let commandResult: CommandResult | undefined;
	let primaryError: unknown;
	let expectedTestFailure: HarnessStageError | undefined;

	try {
		commandResult = await runCommand(
			execPath,
			[VITEST_EXECUTABLE, 'run', '--config', FAILURE_CONFIG],
			'test',
			{
				allowNonzero: true,
				environment: testEnvironment(),
				timeoutMs: 60_000,
			},
		);
		if (commandResult.status === 0) {
			primaryError = new HarnessStageError('test', 'the deliberate assertion did not fail.');
		} else {
			expectedTestFailure = new HarnessStageError(
				'test',
				`the deliberate assertion exited with status ${commandResult.status}.`,
			);
		}
	} catch (error) {
		primaryError = error;
	}

	try {
		await teardown(run);
	} catch (cleanupError) {
		throw combinedFailure(primaryError ?? expectedTestFailure, cleanupError);
	}

	if (primaryError !== undefined) {
		throw primaryError;
	}
	if (commandResult === undefined) {
		throw new HarnessStageError('test', 'the deliberate assertion result is unavailable.');
	}

	const secrets = [run.password, basicAuthorization(run)];
	return {
		exitCode: commandResult.status,
		runIdentity: run.identity,
		secretCanary: run.password,
		stdout: redactDiagnostics(commandResult.stdout, secrets),
		stderr: redactDiagnostics(commandResult.stderr, secrets),
	};
}

export const radicaleHarness: RadicaleHarnessAdapter = Object.freeze({
	buildImage,
	start,
	waitForAuthenticatedReadiness,
	resetStorage,
	stopService,
	teardown,
	inspect,
	findLiveResources,
	runDeliberateFailureProbe,
});
