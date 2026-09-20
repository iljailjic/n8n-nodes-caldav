import { describe, expect, it } from 'vitest';

import packageManifest from '../../package.json';

describe('community-node eligibility package contract', () => {
	it('declares the required community-node identity, Node 22/24 support, and strict registrations', () => {
		expect(packageManifest.keywords).toContain('n8n-community-node-package');
		expect(packageManifest.engines?.node).toBe('>=22 <25');
		expect(packageManifest.files).toEqual(['dist']);
		expect(packageManifest.scripts?.['verify:package']).toContain(
			'node scripts/verify-package-clean-host.mjs',
		);
		expect(packageManifest.n8n).toEqual({
			n8nNodesApiVersion: 1,
			strict: true,
			credentials: ['dist/credentials/CalDavApi.credentials.js'],
			nodes: ['dist/nodes/CalDav/CalDav.node.js'],
		});
	});
});
