/* eslint-disable @n8n/community-nodes/require-node-api-error -- Test-only adapter loading is outside the n8n node execution boundary. */

export interface RadicaleRun {
	readonly identity: string;
	readonly endpoint: string;
	readonly username: string;
	readonly password: string;
	readonly configurationIdentity: string;
	readonly serviceIdentity: string;
	readonly storageIdentity: string;
}

export interface RadicaleRunInspection {
	readonly loopbackOnly: boolean;
	readonly runtimeInternetEgress: boolean;
	readonly repositoryLocalRuntimeOnly: boolean;
	readonly liveResourceIdentities: readonly string[];
}

export interface DeliberateFailureProbeResult {
	readonly exitCode: number;
	readonly runIdentity: string;
	readonly secretCanary: string;
	readonly stdout: string;
	readonly stderr: string;
}

export interface RadicaleHarnessAdapter {
	buildImage(): Promise<void>;
	start(): Promise<RadicaleRun>;
	waitForAuthenticatedReadiness(run: RadicaleRun): Promise<void>;
	resetStorage(run: RadicaleRun): Promise<void>;
	stopService(run: RadicaleRun): Promise<void>;
	teardown(run: RadicaleRun): Promise<void>;
	inspect(run: RadicaleRun): Promise<RadicaleRunInspection>;
	findLiveResources(runIdentity: string): Promise<readonly string[]>;
	runDeliberateFailureProbe(): Promise<DeliberateFailureProbeResult>;
}

function hasHarnessOperations(value: unknown): value is RadicaleHarnessAdapter {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	const candidate = value as Partial<Record<keyof RadicaleHarnessAdapter, unknown>>;
	return [
		'buildImage',
		'start',
		'waitForAuthenticatedReadiness',
		'resetStorage',
		'stopService',
		'teardown',
		'inspect',
		'findLiveResources',
		'runDeliberateFailureProbe',
	].every(
		(operation) => typeof candidate[operation as keyof RadicaleHarnessAdapter] === 'function',
	);
}

export async function loadRadicaleHarnessAdapter(): Promise<RadicaleHarnessAdapter> {
	const adapterModulePath = './radicale-harness-adapter';
	let module: unknown;

	try {
		module = await import(adapterModulePath);
	} catch {
		throw new Error(
			'Radicale integration harness adapter is unavailable; implement the test-only lifecycle adapter.',
		);
	}

	const adapter = (module as { readonly radicaleHarness?: unknown }).radicaleHarness;
	if (!hasHarnessOperations(adapter)) {
		throw new Error(
			'Radicale integration harness adapter does not expose every contract operation.',
		);
	}

	return adapter;
}
