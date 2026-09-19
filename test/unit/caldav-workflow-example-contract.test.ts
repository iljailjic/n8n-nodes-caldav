// Repository reads validate the committed, importable workflow artifact.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { readFile } from 'node:fs/promises';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { resolve } from 'node:path';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { cwd } from 'node:process';

import type { IConnections, INode, INodeTypes } from 'n8n-workflow';
import { Workflow } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import packageManifest from '../../package.json';
import { CalDav } from '../../nodes/CalDav/CalDav.node';

const workflowPaths = {
	createRead: resolve(cwd(), 'examples/workflows/caldav-create-read.json'),
	etagUpdate: resolve(cwd(), 'examples/workflows/caldav-etag-update.json'),
	rawIcsCreate: resolve(cwd(), 'examples/workflows/caldav-raw-ics-create.json'),
	upsert: resolve(cwd(), 'examples/workflows/caldav-upsert.json'),
} as const;

interface WorkflowExport {
	readonly name: string;
	readonly nodes: INode[];
	readonly connections: IConnections;
	readonly active: boolean;
	readonly settings: { readonly executionOrder: string };
}

async function readWorkflowExport(workflow: keyof typeof workflowPaths): Promise<WorkflowExport> {
	return JSON.parse(await readFile(workflowPaths[workflow], 'utf8')) as WorkflowExport;
}

describe('sanitized n8n workflow export contract', () => {
	it.each(Object.keys(workflowPaths) as (keyof typeof workflowPaths)[])(
		'parses and instantiates %s as an inactive n8n workflow export',
		async (fixture) => {
			const workflowExport = await readWorkflowExport(fixture);
			const nodeTypes = {
				getByNameAndVersion: () => undefined,
			} as unknown as INodeTypes;

			const workflow = new Workflow({
				name: workflowExport.name,
				nodes: workflowExport.nodes,
				connections: workflowExport.connections,
				active: workflowExport.active,
				settings: workflowExport.settings,
				nodeTypes,
			});

			expect(workflow.active).toBe(false);
			expect(workflow.getNode("When clicking 'Execute workflow'")).toBeDefined();
			expect(workflow.connectionsBySourceNode).toEqual(workflowExport.connections);
		},
	);

	it('uses the shipped CalDAV type, type version, credential type, and parameter shapes', async () => {
		const workflowExports = await Promise.all(
			(Object.keys(workflowPaths) as (keyof typeof workflowPaths)[]).map(readWorkflowExport),
		);
		const nodeDescription = new CalDav().description;
		const calDavNodeType = `${packageManifest.name}.${nodeDescription.name}`;
		const calDavCredentialType = nodeDescription.credentials?.[0]?.name;
		const rawIcsProperty = nodeDescription.properties.find(
			(property) => property.name === 'rawIcs',
		);
		expect(nodeDescription.version).toBe(1);
		expect(calDavCredentialType).toBe('calDavApi');
		expect(rawIcsProperty).toMatchObject({
			name: 'rawIcs',
			type: 'string',
			required: true,
			default: '',
		});

		for (const workflowExport of workflowExports) {
			for (const calDav of workflowExport.nodes.filter((node) => node.type === calDavNodeType)) {
				expect(calDav).toMatchObject({
					type: calDavNodeType,
					typeVersion: nodeDescription.version,
					credentials: {
						[calDavCredentialType!]: {
							id: null,
							name: 'Select your CalDAV credential after import',
						},
					},
					parameters: { resource: 'event' },
				});
			}
		}

		const rawIcsCreate = workflowExports[2].nodes.find(
			(node) => node.name === 'Create event from Raw ICS',
		);
		expect(rawIcsCreate).toMatchObject({
			parameters: { operation: 'create', inputMode: 'rawIcs' },
		});
		expect(rawIcsCreate?.parameters.rawIcs).toContain('BEGIN:VCALENDAR');
		expect(rawIcsCreate?.parameters.rawIcs).toContain('BEGIN:VEVENT');
		expect(rawIcsCreate?.parameters.rawIcs).toContain('END:VCALENDAR');

		const createRead = workflowExports[0].nodes;
		expect(createRead.find((node) => node.name === 'Create event')).toMatchObject({
			parameters: {
				operation: 'create',
				inputMode: 'structured',
				timeMode: 'timed',
				timeZoneMode: 'utc',
			},
		});
		expect(createRead.find((node) => node.name === 'Read event by UID')).toMatchObject({
			parameters: {
				operation: 'get',
				identifierMode: 'uid',
				uid: '={{ $json.uid }}',
			},
		});

		const etagUpdate = workflowExports[1].nodes.find(
			(node) => node.name === 'Update event with ETag',
		);
		expect(etagUpdate).toMatchObject({
			parameters: {
				operation: 'update',
				inputMode: 'structured',
				identifierMode: 'resourceUrl',
				resourceUrl: '={{ $json.resourceUrl }}',
				etag: '={{ $json.etag }}',
				timeMode: 'timed',
				fieldsToUpdate: { summary: 'Sanitized ETag-protected update' },
			},
		});

		expect(
			workflowExports[3].nodes.find((node) => node.name === 'Upsert all-day event'),
		).toMatchObject({
			parameters: {
				operation: 'upsert',
				inputMode: 'structured',
				timeMode: 'allDay',
				startDate: '2026-09-21',
				endDate: '2026-09-22',
			},
		});
	});

	it('contains only fictional, secret-free values', async () => {
		for (const workflowPath of Object.values(workflowPaths)) {
			const artifact = await readFile(workflowPath, 'utf8');

			expect(artifact).toContain('calendar.example.test');
			expect(artifact).not.toMatch(
				/(?:password|app[-_ ]?specific|authorization|bearer|token)\s*[:=]/i,
			);
			expect(artifact).not.toMatch(/https?:\/\/(?!calendar\.example\.test)/i);
		}
	});
});
