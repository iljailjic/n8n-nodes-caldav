import { describe, expect, it } from 'vitest';

import { verifyPackOutput } from '../../scripts/verify-package-contents.mjs';

const expectedPackageFiles = [
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
	'dist/nodes/CalDav/events/getByResourceUrl.d.ts',
	'dist/nodes/CalDav/events/getByResourceUrl.js',
	'dist/nodes/CalDav/events/getByResourceUrl.js.map',
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
];

interface PackResultOverrides {
	bundled?: unknown;
	entryCount?: unknown;
	files?: unknown;
	name?: unknown;
	version?: unknown;
}

function createPackOutput(paths: string[], overrides: PackResultOverrides = {}) {
	return JSON.stringify([
		{
			name: '@iljailjic/n8n-nodes-caldav',
			version: '0.3.0',
			files: paths.map((path) => ({ path })),
			entryCount: paths.length,
			bundled: [],
			...overrides,
		},
	]);
}

describe('package contents verifier', () => {
	it('accepts only the exact production package manifest', () => {
		const packOutput = createPackOutput(expectedPackageFiles);

		expect(expectedPackageFiles).toHaveLength(82);
		expect(() => verifyPackOutput(packOutput)).not.toThrow();
	});

	it.each([
		['TypeScript build metadata', 'dist/tsconfig.tsbuildinfo'],
		['private artifact', 'dist/private/account.json'],
		['test artifact', 'dist/test/unit/example.js'],
		['synthetic discovery fixture', 'test/unit/fixtures/discovery/standard.xml'],
		['fixture provenance', 'test/unit/fixtures/discovery/PROVENANCE.md'],
		['fixture-only helper', 'test/unit/support/synthetic-discovery-fixture.ts'],
		['integration harness', 'dist/test/integration/radicale/Dockerfile'],
		['integration configuration', 'dist/vitest.integration.config.mjs'],
		['generated harness state', 'dist/.codex-runtime/radicale-harness/storage/event.ics'],
		['fixture artifact', 'dist/fixtures/calendar.ics'],
		['Vitest artifact', 'dist/vitest.config.mjs'],
		['bundled source', 'dist/nodes/CalDav/xml/parser.ts'],
	] as const)('rejects unexpected %s', (_description, path) => {
		const packOutput = createPackOutput([...expectedPackageFiles, path]);

		expect(() => verifyPackOutput(packOutput)).toThrow(
			'Package contents do not match the expected manifest',
		);
	});

	it('rejects bundled dependencies', () => {
		const packOutput = createPackOutput(expectedPackageFiles, { bundled: ['example-runtime'] });

		expect(() => verifyPackOutput(packOutput)).toThrow('Bundled dependencies detected');
	});

	it('rejects a valid-shaped manifest with an expected path omitted', () => {
		const packOutput = createPackOutput(expectedPackageFiles.slice(1));

		expect(() => verifyPackOutput(packOutput)).toThrow(
			'Package contents do not match the expected manifest',
		);
	});

	it('rejects a valid-shaped manifest with a duplicate allowed path', () => {
		const packOutput = createPackOutput([...expectedPackageFiles, expectedPackageFiles[0]]);

		expect(() => verifyPackOutput(packOutput)).toThrow(
			'npm pack result contains duplicate file entries',
		);
	});

	it('rejects a valid-shaped result with a version-only identity mismatch', () => {
		const packOutput = createPackOutput(expectedPackageFiles, { version: '0.2.1' });

		expect(() => verifyPackOutput(packOutput)).toThrow(
			'npm pack returned unexpected package identity',
		);
	});

	it.each([
		['invalid JSON', '{'],
		['missing package result', '[]'],
		['multiple package results', JSON.stringify([{}, {}])],
		['missing package identity', createPackOutput(expectedPackageFiles, { name: undefined })],
		['missing file listing', createPackOutput(expectedPackageFiles, { files: undefined })],
		['invalid file entry', createPackOutput(expectedPackageFiles, { files: [{}] })],
		['incorrect entry count', createPackOutput(expectedPackageFiles, { entryCount: 57 })],
		['missing bundled listing', createPackOutput(expectedPackageFiles, { bundled: undefined })],
	] as const)('rejects malformed or incomplete output: %s', (_description, packOutput) => {
		expect(() => verifyPackOutput(packOutput)).toThrow();
	});
});
