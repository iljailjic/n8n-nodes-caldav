// This fixture is deliberately a saved n8n workflow, rather than a description snapshot.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { readFile } from 'node:fs/promises';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { resolve } from 'node:path';

import type {
	IConnections,
	IExecuteFunctions,
	INode,
	INodeProperties,
	INodeTypes,
} from 'n8n-workflow';
import { Workflow } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import packageManifest from '../../package.json';
import { CalDav } from '../../nodes/CalDav/CalDav.node';

const fixturePath = resolve('test/unit/fixtures/workflows/issue-61-v1-saved-workflows.json');

interface WorkflowFixture {
	readonly name: string;
	readonly nodes: INode[];
	readonly connections: IConnections;
	readonly active: boolean;
	readonly settings: { readonly executionOrder: string };
	readonly compatibility: {
		readonly credentialType: string;
		readonly outputSamples: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
		readonly omittedParameters: Readonly<Record<string, readonly string[]>>;
	};
}

async function readFixture(): Promise<WorkflowFixture> {
	return JSON.parse(await readFile(fixturePath, 'utf8')) as WorkflowFixture;
}

function calDavNode(fixture: WorkflowFixture, name: string): INode {
	const node = fixture.nodes.find((candidate) => candidate.name === name);
	expect(node).toBeDefined();
	return node!;
}

function isVisible(property: INodeProperties, parameters: Record<string, unknown>): boolean {
	const show = property.displayOptions?.show;
	if (show === undefined) return true;
	return Object.entries(show).every(([name, values]) => values.includes(parameters[name] as never));
}

function resolvedParameters(node: INode): Record<string, unknown> {
	const parameters = { ...node.parameters } as Record<string, unknown>;
	const properties = new CalDav().description.properties;

	for (let pass = 0; pass < properties.length; pass += 1) {
		for (const property of properties) {
			if (
				parameters[property.name] === undefined &&
				property.default !== undefined &&
				isVisible(property, parameters)
			) {
				parameters[property.name] = property.default;
			}
		}
	}

	return parameters;
}

function fixtureExecutionContext(node: INode): IExecuteFunctions {
	const parameters = resolvedParameters(node);
	return {
		getInputData: () => [{ json: {} }],
		getNodeParameter: (name: string) => parameters[name],
		getNode: () => node,
		continueOnFail: () => node.continueOnFail === true,
	} as unknown as IExecuteFunctions;
}

describe('issue-61 saved v1 workflow compatibility fixture', () => {
	it('instantiates as an inactive n8n workflow and freezes package, node, credential, and version identifiers', async () => {
		const fixture = await readFixture();
		const nodeDescription = new CalDav().description;
		const nodeTypes = { getByNameAndVersion: () => undefined } as unknown as INodeTypes;
		const workflow = new Workflow({ ...fixture, nodeTypes });

		expect(workflow.active).toBe(false);
		expect(workflow.connectionsBySourceNode).toEqual(fixture.connections);
		expect(nodeDescription).toMatchObject({ name: 'calDav', version: 1 });
		expect(fixture.compatibility.credentialType).toBe('calDavApi');

		const type = `${packageManifest.name}.${nodeDescription.name}`;
		for (const node of fixture.nodes.filter((candidate) => candidate.type === type)) {
			expect(node).toMatchObject({
				type,
				typeVersion: 1,
				credentials: {
					calDavApi: { id: null, name: 'Select your CalDAV credential after import' },
				},
			});
		}
	});

	it('covers every v1 Calendar/Event operation, both identifier modes, and both applicable input modes', async () => {
		const fixture = await readFixture();
		const calDavNodes = fixture.nodes.filter((node) => node.type.endsWith('.calDav'));
		const operationPairs = calDavNodes.map((node) => [
			node.parameters.resource,
			node.parameters.operation,
		]);

		expect(operationPairs).toEqual(
			expect.arrayContaining([
				['calendar', 'get'],
				['calendar', 'getMany'],
				['event', 'create'],
				['event', 'get'],
				['event', 'getMany'],
				['event', 'update'],
				['event', 'upsert'],
				['event', 'delete'],
			]),
		);
		expect(calDavNodes.map((node) => node.parameters.identifierMode)).toEqual(
			expect.arrayContaining(['resourceUrl', 'uid']),
		);
		expect(calDavNodes.map((node) => node.parameters.inputMode)).toEqual(
			expect.arrayContaining(['structured', 'rawIcs']),
		);
	});

	it('keeps parameter visibility, expression locators, and intentional default omissions compatible with v1', async () => {
		const fixture = await readFixture();
		const properties = new CalDav().description.properties;

		for (const node of fixture.nodes.filter((candidate) => candidate.type.endsWith('.calDav'))) {
			for (const parameterName of Object.keys(node.parameters)) {
				const matchingProperties = properties.filter((property) => property.name === parameterName);
				expect(matchingProperties.some((property) => isVisible(property, node.parameters))).toBe(
					true,
				);
			}
		}

		for (const [nodeName, names] of Object.entries(fixture.compatibility.omittedParameters)) {
			const parameters = calDavNode(fixture, nodeName).parameters;
			for (const name of names) expect(parameters).not.toHaveProperty(name);
		}
		expect(
			resolvedParameters(calDavNode(fixture, 'Calendar Get Many with defaults omitted')),
		).toMatchObject({
			returnAll: false,
			limit: 50,
		});
		expect(
			resolvedParameters(calDavNode(fixture, 'Event Get Many defaults omitted')),
		).toMatchObject({
			returnAll: false,
			limit: 50,
		});
		expect(
			resolvedParameters(calDavNode(fixture, 'Event Create Structured defaults omitted')),
		).toMatchObject({ uid: '', timeZoneMode: 'utc', additionalFields: {} });
		expect(
			resolvedParameters(calDavNode(fixture, 'Event Upsert Structured defaults omitted')),
		).toMatchObject({ timeZoneMode: 'utc', additionalFields: {} });

		for (const node of fixture.nodes.filter((candidate) => candidate.type.endsWith('.calDav'))) {
			const locator = node.parameters.calendar as
				{ readonly __rl?: unknown; readonly value?: unknown } | undefined;
			if (locator?.value === '={{ $json.calendarUrl }}')
				expect(locator).toMatchObject({ __rl: true, mode: 'url' });
		}
	});

	it('records stable output samples without display-text snapshots', async () => {
		const fixture = await readFixture();

		expect(fixture.compatibility.outputSamples['Calendar Get by expression locator']).toMatchObject(
			{
				calendarUrl: 'https://calendar.example.test/calendars/work/',
			},
		);
		expect(
			fixture.compatibility.outputSamples['Event Create Structured defaults omitted'],
		).toMatchObject({
			resourceUrl: expect.any(String),
			uid: expect.any(String),
			timeMode: 'timed',
			accessMode: 'editable',
		});
		expect(fixture.compatibility.outputSamples['Event Delete by UID']).toMatchObject({
			deleted: true,
			uid: expect.any(String),
		});
	});

	it('executes fixture Continue On Fail nodes and returns the v1 error-item shape', async () => {
		const fixture = await readFixture();
		const cases = [
			[
				'Event Get invalid Resource URL (Continue On Fail)',
				'The Event Resource URL is invalid or does not belong to the selected calendar.',
			],
			[
				'Event Delete invalid UID (Continue On Fail)',
				'UID must be a non-empty valid iCalendar text value.',
			],
		] as const;

		for (const [name, message] of cases) {
			const node = calDavNode(fixture, name);
			expect(node.continueOnFail).toBe(true);
			await expect(new CalDav().execute.call(fixtureExecutionContext(node))).resolves.toEqual([
				[{ json: { error: message }, pairedItem: { item: 0 } }],
			]);
		}
	});
});
