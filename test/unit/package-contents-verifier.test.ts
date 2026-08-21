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
	'dist/nodes/CalDav/discovery/timeZoneReferences.d.ts',
	'dist/nodes/CalDav/discovery/timeZoneReferences.js',
	'dist/nodes/CalDav/discovery/timeZoneReferences.js.map',
	'dist/nodes/CalDav/events/create.d.ts',
	'dist/nodes/CalDav/events/create.js',
	'dist/nodes/CalDav/events/create.js.map',
	'dist/nodes/CalDav/events/createErrors.d.ts',
	'dist/nodes/CalDav/events/createErrors.js',
	'dist/nodes/CalDav/events/createErrors.js.map',
	'dist/nodes/CalDav/events/createPreparation.d.ts',
	'dist/nodes/CalDav/events/createPreparation.js',
	'dist/nodes/CalDav/events/createPreparation.js.map',
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
	'dist/nodes/CalDav/events/timeZoneAuthoring.d.ts',
	'dist/nodes/CalDav/events/timeZoneAuthoring.js',
	'dist/nodes/CalDav/events/timeZoneAuthoring.js.map',
	'dist/nodes/CalDav/events/timeZoneExecutionContext.d.ts',
	'dist/nodes/CalDav/events/timeZoneExecutionContext.js',
	'dist/nodes/CalDav/events/timeZoneExecutionContext.js.map',
	'dist/nodes/CalDav/events/uid.d.ts',
	'dist/nodes/CalDav/events/uid.js',
	'dist/nodes/CalDav/events/uid.js.map',
	'dist/nodes/CalDav/events/update.d.ts',
	'dist/nodes/CalDav/events/update.js',
	'dist/nodes/CalDav/events/update.js.map',
	'dist/nodes/CalDav/events/upsert.d.ts',
	'dist/nodes/CalDav/events/upsert.js',
	'dist/nodes/CalDav/events/upsert.js.map',
	'dist/nodes/CalDav/icalendar/alarms.d.ts',
	'dist/nodes/CalDav/icalendar/alarms.js',
	'dist/nodes/CalDav/icalendar/alarms.js.map',
	'dist/nodes/CalDav/icalendar/eventReadModel.d.ts',
	'dist/nodes/CalDav/icalendar/eventReadModel.js',
	'dist/nodes/CalDav/icalendar/eventReadModel.js.map',
	'dist/nodes/CalDav/icalendar/parser.d.ts',
	'dist/nodes/CalDav/icalendar/parser.js',
	'dist/nodes/CalDav/icalendar/parser.js.map',
	'dist/nodes/CalDav/icalendar/patcher.d.ts',
	'dist/nodes/CalDav/icalendar/patcher.js',
	'dist/nodes/CalDav/icalendar/patcher.js.map',
	'dist/nodes/CalDav/icalendar/rawEventWrite.d.ts',
	'dist/nodes/CalDav/icalendar/rawEventWrite.js',
	'dist/nodes/CalDav/icalendar/rawEventWrite.js.map',
	'dist/nodes/CalDav/icalendar/recurrence.d.ts',
	'dist/nodes/CalDav/icalendar/recurrence.js',
	'dist/nodes/CalDav/icalendar/recurrence.js.map',
	'dist/nodes/CalDav/icalendar/serializer.d.ts',
	'dist/nodes/CalDav/icalendar/serializer.js',
	'dist/nodes/CalDav/icalendar/serializer.js.map',
	'dist/nodes/CalDav/icalendar/timeZones.d.ts',
	'dist/nodes/CalDav/icalendar/timeZones.js',
	'dist/nodes/CalDav/icalendar/timeZones.js.map',
	'dist/nodes/CalDav/icalendar/uri.d.ts',
	'dist/nodes/CalDav/icalendar/uri.js',
	'dist/nodes/CalDav/icalendar/uri.js.map',
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

const serializerArtifactPaths = [
	'dist/nodes/CalDav/icalendar/serializer.d.ts',
	'dist/nodes/CalDav/icalendar/serializer.js',
	'dist/nodes/CalDav/icalendar/serializer.js.map',
] as const;

const alarmArtifactPaths = [
	'dist/nodes/CalDav/icalendar/alarms.d.ts',
	'dist/nodes/CalDav/icalendar/alarms.js',
	'dist/nodes/CalDav/icalendar/alarms.js.map',
] as const;

const createArtifactPaths = [
	'dist/nodes/CalDav/events/create.d.ts',
	'dist/nodes/CalDav/events/create.js',
	'dist/nodes/CalDav/events/create.js.map',
] as const;

const uidArtifactPaths = [
	'dist/nodes/CalDav/events/uid.d.ts',
	'dist/nodes/CalDav/events/uid.js',
	'dist/nodes/CalDav/events/uid.js.map',
] as const;

const patcherArtifactPaths = [
	'dist/nodes/CalDav/icalendar/patcher.d.ts',
	'dist/nodes/CalDav/icalendar/patcher.js',
	'dist/nodes/CalDav/icalendar/patcher.js.map',
] as const;

const recurrenceArtifactPaths = [
	'dist/nodes/CalDav/icalendar/recurrence.d.ts',
	'dist/nodes/CalDav/icalendar/recurrence.js',
	'dist/nodes/CalDav/icalendar/recurrence.js.map',
] as const;

const updateArtifactPaths = [
	'dist/nodes/CalDav/events/update.d.ts',
	'dist/nodes/CalDav/events/update.js',
	'dist/nodes/CalDav/events/update.js.map',
] as const;

const upsertArtifactPaths = [
	'dist/nodes/CalDav/events/upsert.d.ts',
	'dist/nodes/CalDav/events/upsert.js',
	'dist/nodes/CalDav/events/upsert.js.map',
] as const;

const timeZoneArtifactPaths = [
	'dist/nodes/CalDav/icalendar/timeZones.d.ts',
	'dist/nodes/CalDav/icalendar/timeZones.js',
	'dist/nodes/CalDav/icalendar/timeZones.js.map',
] as const;

const timeZoneReferenceArtifactPaths = [
	'dist/nodes/CalDav/discovery/timeZoneReferences.d.ts',
	'dist/nodes/CalDav/discovery/timeZoneReferences.js',
	'dist/nodes/CalDav/discovery/timeZoneReferences.js.map',
] as const;

const timeZoneAuthoringArtifactPaths = [
	'dist/nodes/CalDav/events/timeZoneAuthoring.d.ts',
	'dist/nodes/CalDav/events/timeZoneAuthoring.js',
	'dist/nodes/CalDav/events/timeZoneAuthoring.js.map',
] as const;

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
			version: '0.5.0',
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

		expect(expectedPackageFiles).toHaveLength(133);
		expect(expectedPackageFiles.filter((path) => path.includes('/icalendar/alarms.'))).toEqual(
			alarmArtifactPaths,
		);
		expect(expectedPackageFiles.filter((path) => path.includes('/events/create.'))).toEqual(
			createArtifactPaths,
		);
		expect(expectedPackageFiles.filter((path) => path.includes('/events/uid.'))).toEqual(
			uidArtifactPaths,
		);
		expect(expectedPackageFiles.filter((path) => path.includes('/icalendar/serializer.'))).toEqual(
			serializerArtifactPaths,
		);
		expect(expectedPackageFiles.filter((path) => path.includes('/icalendar/patcher.'))).toEqual(
			patcherArtifactPaths,
		);
		expect(expectedPackageFiles.filter((path) => path.includes('/icalendar/recurrence.'))).toEqual(
			recurrenceArtifactPaths,
		);
		expect(expectedPackageFiles.filter((path) => path.includes('/events/update.'))).toEqual(
			updateArtifactPaths,
		);
		expect(expectedPackageFiles.filter((path) => path.includes('/events/upsert.'))).toEqual(
			upsertArtifactPaths,
		);
		expect(expectedPackageFiles.filter((path) => path.includes('/icalendar/timeZones.'))).toEqual(
			timeZoneArtifactPaths,
		);
		expect(
			expectedPackageFiles.filter((path) => path.includes('/discovery/timeZoneReferences.')),
		).toEqual(timeZoneReferenceArtifactPaths);
		expect(
			expectedPackageFiles.filter((path) => path.includes('/events/timeZoneAuthoring.')),
		).toEqual(timeZoneAuthoringArtifactPaths);
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

	it('rejects the previous 0.4.0 checkpoint identity', () => {
		const packOutput = createPackOutput(expectedPackageFiles, { version: '0.4.0' });

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
