#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputFile = resolve(root, 'dist/nodes/CalDav/icalendar/timeZones.js');
const upstreamLicenses = await Promise.all(
	[
		['timezonecomplete', 'LICENSE-MIT'],
		['tzdata', 'LICENSE'],
	].map(async ([name, filename]) => {
		const license = await readFile(resolve(root, 'node_modules', name, filename), 'utf8');
		return `${name}:\n${license.trim()}`;
	}),
);
const banner = `/*\nBundled time-zone rule data and engine licenses:\n\n${upstreamLicenses.join('\n\n')}\n*/`;

const bundle = await rolldown({ input: outputFile, platform: 'node' });
const { output } = await bundle.generate({ format: 'cjs', sourcemap: true, banner });
const chunk = output.find((entry) => entry.type === 'chunk');
const sourceMap = output.find((entry) => entry.type === 'asset');
if (
	output.length !== 2 ||
	chunk?.fileName !== 'timeZones.js' ||
	sourceMap?.fileName !== 'timeZones.js.map' ||
	chunk.imports.length !== 0 ||
	chunk.dynamicImports.length !== 0
) {
	throw new Error('The time-zone bundle contains unresolved imports or unexpected output.');
}
await Promise.all([
	writeFile(outputFile, chunk.code),
	writeFile(`${outputFile}.map`, sourceMap.source),
]);
