// Repository reads are required for deterministic public-contract and package metadata checks.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { readFile } from 'node:fs/promises';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { join } from 'node:path';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { cwd } from 'node:process';

import type { IExecuteFunctions, INode, INodeExecutionData } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	createN8nCalDavTransport: vi.fn(),
	getCalendarEventByResourceUrl: vi.fn(),
	resolveCalendarEventByUid: vi.fn(),
	queryCalendarEventsByTimeRange: vi.fn(),
}));

vi.mock('../../nodes/CalDav/transport/http', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/transport/http')>()),
	createN8nCalDavTransport: mocks.createN8nCalDavTransport,
}));

vi.mock('../../nodes/CalDav/events/getByResourceUrl', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/events/getByResourceUrl')>()),
	getCalendarEventByResourceUrl: mocks.getCalendarEventByResourceUrl,
}));

vi.mock('../../nodes/CalDav/events/resolveByUid', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/events/resolveByUid')>()),
	resolveCalendarEventByUid: mocks.resolveCalendarEventByUid,
}));

vi.mock('../../nodes/CalDav/events/timeRangeQuery', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/events/timeRangeQuery')>()),
	queryCalendarEventsByTimeRange: mocks.queryCalendarEventsByTimeRange,
}));

import { CalDav } from '../../nodes/CalDav/CalDav.node';
import type { CalendarEventReadResult } from '../../nodes/CalDav/icalendar/eventReadModel';
import { CalDavICalendarParseError } from '../../nodes/CalDav/icalendar/parser';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';
import { RAW_ICS_PRIVATE_SENTINEL } from './fixtures/events/raw-ics-contract-fixtures';

const NODE: INode = {
	id: 'raw-ics-node-contract',
	name: 'CalDAV Raw ICS contract',
	type: 'calDav',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};
const TRANSPORT = { serverUrl: 'https://calendar.example.test/', request: vi.fn() };
const CALENDAR_URL = 'https://calendar.example.test/calendars/raw/';

function locator(value: string): unknown {
	return { __rl: true, mode: 'url', value };
}

function context(
	parameters: Readonly<Record<string, unknown>>,
	options: { readonly continueOnFail?: boolean } = {},
): IExecuteFunctions {
	return {
		getInputData: vi.fn().mockReturnValue([{ json: { input: 'synthetic' } }]),
		getNodeParameter: vi.fn((name: string) => Reflect.get(parameters, name)),
		getNode: vi.fn().mockReturnValue(NODE),
		continueOnFail: vi.fn().mockReturnValue(options.continueOnFail ?? false),
	} as unknown as IExecuteFunctions;
}

function result(uid: string, rawIcs: string): CalendarEventReadResult {
	return {
		event: {
			calendarUrl: validateAbsoluteHttpUrl(CALENDAR_URL),
			resourceUrl: validateAbsoluteHttpUrl(`${CALENDAR_URL}${uid}.ics`),
			etag: `"${uid}-etag"`,
			uid,
			summary: `Summary ${uid}`,
			timeMode: 'timed',
			accessMode: 'editable',
			start: '2040-01-02T10:00:00Z' as CalendarEventReadResult['event']['start'],
			end: '2040-01-02T10:30:00Z' as CalendarEventReadResult['event']['end'],
			timeZoneMode: 'utc',
			startLocal: '2040-01-02T10:00:00',
			endLocal: '2040-01-02T10:30:00',
		},
		context: {
			resource: {
				kind: 'resource',
				originalIcs: rawIcs,
				calendar: { kind: 'component', name: 'VCALENDAR', entries: [] },
			},
			master: { kind: 'component', name: 'VEVENT', entries: [] },
			exceptions: [],
		},
		rawIcs,
	} as unknown as CalendarEventReadResult;
}

async function execute(
	parameters: Readonly<Record<string, unknown>>,
	continueOnFail = false,
): Promise<INodeExecutionData[][]> {
	return await new CalDav().execute.call(context(parameters, { continueOnFail }));
}

beforeEach(() => {
	mocks.createN8nCalDavTransport.mockReset().mockResolvedValue(TRANSPORT);
	mocks.getCalendarEventByResourceUrl.mockReset();
	mocks.resolveCalendarEventByUid.mockReset();
	mocks.queryCalendarEventsByTimeRange.mockReset();
	TRANSPORT.request.mockReset();
});

describe('Raw ICS n8n projection and privacy contract', () => {
	it.each(['resourceUrl', 'uid'] as const)(
		'projects the authorized flat JSON string for Event Get by %s',
		async (identifierMode) => {
			const selected = result(
				`${identifierMode}-event`,
				`BEGIN:VCALENDAR\r\nX-MODE:${identifierMode}\r\nEND:VCALENDAR\r\n`,
			);
			(identifierMode === 'uid'
				? mocks.resolveCalendarEventByUid
				: mocks.getCalendarEventByResourceUrl
			).mockResolvedValue(selected);

			const [[output]] = await execute({
				resource: 'event',
				operation: 'get',
				calendar: locator(CALENDAR_URL),
				identifierMode,
				resourceUrl: selected.event.resourceUrl,
				uid: selected.event.uid,
			});

			expect(output.json.rawIcs).toBe((selected as unknown as { rawIcs: string }).rawIcs);
			expect(output.json).not.toHaveProperty('context');
			expect(output.pairedItem).toEqual({ item: 0 });
		},
	);

	it('projects each Event Get Many raw value without cross-association', async () => {
		const first = result('first', 'BEGIN:VCALENDAR\nX-RAW:first\nEND:VCALENDAR\n');
		const second = result('second', 'BEGIN:VCALENDAR\r\nX-RAW:second\r\nEND:VCALENDAR\r\n');
		mocks.queryCalendarEventsByTimeRange.mockResolvedValue([first, second]);

		const [output] = await execute({
			resource: 'event',
			operation: 'getMany',
			calendar: locator(CALENDAR_URL),
			start: '2040-01-01T00:00:00Z',
			end: '2041-01-01T00:00:00Z',
			returnAll: true,
		});

		expect(output.map(({ json }) => json.rawIcs)).toEqual([
			(first as unknown as { rawIcs: string }).rawIcs,
			(second as unknown as { rawIcs: string }).rawIcs,
		]);
		expect(output.map(({ pairedItem }) => pairedItem)).toEqual([{ item: 0 }, { item: 0 }]);
	});

	it('continueOnFail emits only the fixed error and never partial raw event data', async () => {
		mocks.getCalendarEventByResourceUrl.mockRejectedValue(
			Object.assign(new CalDavICalendarParseError('INVALID_UTF8'), {
				rawIcs: RAW_ICS_PRIVATE_SENTINEL,
				body: `<calendar-data>${RAW_ICS_PRIVATE_SENTINEL}</calendar-data>`,
			}),
		);

		const [output] = await execute(
			{
				resource: 'event',
				operation: 'get',
				calendar: locator(CALENDAR_URL),
				identifierMode: 'resourceUrl',
				resourceUrl: `${CALENDAR_URL}private.ics`,
				uid: 'hidden',
			},
			true,
		);

		expect(output).toEqual([
			{
				json: { error: 'The CalDAV server returned malformed iCalendar event data.' },
				pairedItem: { item: 0 },
			},
		]);
		expect(JSON.stringify(output)).not.toContain(RAW_ICS_PRIVATE_SENTINEL);
	});
});

async function repositoryFile(path: string): Promise<string> {
	return await readFile(join(cwd(), path), 'utf8');
}

describe('Raw ICS public type, compatibility, documentation, and package contract', () => {
	it('declares provenance-explicit read, update, and Upsert types without adding raw to CalendarEvent', async () => {
		const readModel = await repositoryFile('nodes/CalDav/icalendar/eventReadModel.ts');
		const update = await repositoryFile('nodes/CalDav/events/update.ts');
		const upsert = await repositoryFile('nodes/CalDav/events/upsert.ts');

		expect(readModel).toMatch(
			/export interface CalendarEventReadResult[\s\S]*?readonly rawIcs: string;[\s\S]*?\n}/,
		);
		expect(readModel).toMatch(
			/export type CalendarEventWithRawIcs = CalendarEvent & \{ readonly rawIcs: string \};/,
		);
		expect(readModel.match(/interface CalendarEventCommon[\s\S]*?\n}/)?.[0]).not.toContain(
			'rawIcs',
		);
		expect(update).toMatch(
			/export type UpdatedCalendarEvent = CalendarEventWithRawIcs & \{[\s\S]*?readonly etag: string;/,
		);
		expect(upsert).toMatch(/action: 'create'[\s\S]*?action: 'update'[\s\S]*?rawIcs: string/);
	});

	it('documents authority, fidelity distinctions, bounds, JSON behavior, and sensitivity', async () => {
		const readme = await repositoryFile('README.md');
		for (const expectation of [
			/Event Get[\s\S]*rawIcs/i,
			/Get Many[\s\S]*rawIcs/i,
			/Create[\s\S]*(?:omit|absent)[\s\S]*rawIcs/i,
			/direct GET[\s\S]*REPORT/i,
			/5 MiB/,
			/10 MiB/,
			/JSON string/i,
			/(?:sensitive|retention)/i,
		]) {
			expect(readme).toMatch(expectation);
		}
	});

	it('keeps package identity, registrations and dependencies while adding only the Raw write triplet', async () => {
		const packageJson = JSON.parse(await repositoryFile('package.json')) as {
			readonly version: string;
			readonly dependencies?: Readonly<Record<string, string>>;
			readonly n8n: { readonly nodes: readonly string[]; readonly credentials: readonly string[] };
		};
		const verifier = await repositoryFile('scripts/verify-package-contents.mjs');

		expect(packageJson.version).toBe('0.5.0');
		expect(packageJson.n8n.nodes).toHaveLength(1);
		expect(packageJson.n8n.credentials).toHaveLength(1);
		expect(packageJson.dependencies).toBeUndefined();
		expect(verifier.match(/^\s*'[^']+',$/gm)).toHaveLength(133);
		expect(verifier).toContain('EXPECTED_PACKAGE_FILES.size');
		expect(verifier.match(/rawEventWrite\.(?:d\.ts|js|js\.map)/g)).toHaveLength(3);
	});
});
