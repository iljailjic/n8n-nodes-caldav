import { describe, expect, it } from 'vitest';

import { verifyPackOutput } from '../../scripts/verify-package-contents.mjs';

function createPackOutput(paths: string[], bundled: string[] = []) {
	return JSON.stringify([
		{
			bundled,
			files: paths.map((path) => ({ path })),
		},
	]);
}

describe('package contents verifier', () => {
	it('accepts production package files', () => {
		const packOutput = createPackOutput(['package.json', 'dist/nodes/CalDav/CalDav.node.js']);

		expect(() => verifyPackOutput(packOutput)).not.toThrow();
	});

	it.each([
		['test directory', 'dist/test/unit/example.js', []],
		['test file', 'dist/nodes/CalDav/example.test.js', []],
		['fixture', 'dist/fixtures/calendar.ics', []],
		['Vitest configuration', 'dist/vitest.config.mjs', []],
		['Vitest library', 'dist/node_modules/@vitest/runner/index.js', []],
		['bundled Vitest runtime', 'dist/nodes/CalDav/CalDav.node.js', ['vitest']],
	] as const)('rejects a prohibited %s', (_description, path, bundled) => {
		const packOutput = createPackOutput(['package.json', path], [...bundled]);

		expect(() => verifyPackOutput(packOutput)).toThrow('Prohibited package content detected');
	});
});
