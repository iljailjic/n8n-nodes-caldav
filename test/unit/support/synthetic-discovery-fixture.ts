// Node streams are required to model n8n's offline full-response helper contract.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { Readable } from 'node:stream';

import type { IN8nHttpFullResponse } from 'n8n-workflow';

import type {
	CalDavRequestHelperAdapter,
	N8nCalDavRequestOptions,
} from '../../../nodes/CalDav/transport/http';
import type {
	SyntheticDiscoveryFixture,
	SyntheticDiscoveryStep,
} from '../fixtures/discovery/synthetic-discovery-fixtures';

export interface SyntheticDiscoveryTranscript {
	readonly adapter: CalDavRequestHelperAdapter;
	readonly calls: readonly N8nCalDavRequestOptions[];
	assertComplete(): void;
}

function response(step: SyntheticDiscoveryStep): IN8nHttpFullResponse {
	if (step.response === undefined) {
		throw new Error(`Synthetic step ${step.id} has no response.`);
	}

	return {
		statusCode: step.response.statusCode,
		headers: (step.response.headers ?? {}) as IN8nHttpFullResponse['headers'],
		body: Readable.from(step.response.body === undefined ? [] : [Buffer.from(step.response.body)]),
	};
}

export function createSyntheticDiscoveryTranscript(
	fixture: SyntheticDiscoveryFixture,
): SyntheticDiscoveryTranscript {
	let cursor = 0;
	const calls: N8nCalDavRequestOptions[] = [];
	const adapter: CalDavRequestHelperAdapter = {
		async request(options) {
			calls.push(options);
			const step = fixture.steps[cursor];
			if (step === undefined) {
				throw new Error('The offline transcript received an unlisted request.');
			}
			cursor += 1;
			const depth = options.headers?.Depth;
			if (
				options.method !== step.method ||
				options.url !== step.url ||
				(step.depth !== undefined && depth !== step.depth)
			) {
				throw new Error(`The offline transcript request did not match step ${step.id}.`);
			}
			if (step.error !== undefined) {
				throw step.error;
			}
			return response(step);
		},
	};

	return Object.freeze({
		adapter,
		calls,
		assertComplete() {
			if (cursor !== fixture.steps.length) {
				throw new Error('The offline transcript was not completely consumed.');
			}
		},
	});
}
