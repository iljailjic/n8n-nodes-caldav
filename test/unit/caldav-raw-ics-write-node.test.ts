import type { IExecuteFunctions, INode } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	createN8nCalDavTransport: vi.fn(),
	createCalendarEvent: vi.fn(),
	updateCalendarEvent: vi.fn(),
	upsertCalendarEvent: vi.fn(),
}));

vi.mock('../../nodes/CalDav/transport/http', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/transport/http')>()),
	createN8nCalDavTransport: mocks.createN8nCalDavTransport,
}));

vi.mock('../../nodes/CalDav/events/create', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/events/create')>()),
	createCalendarEvent: mocks.createCalendarEvent,
}));

vi.mock('../../nodes/CalDav/events/update', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/events/update')>()),
	updateCalendarEvent: mocks.updateCalendarEvent,
}));

vi.mock('../../nodes/CalDav/events/upsert', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/events/upsert')>()),
	upsertCalendarEvent: mocks.upsertCalendarEvent,
}));

import { CalDav } from '../../nodes/CalDav/CalDav.node';
import { CalDavRawCalendarEventError } from '../../nodes/CalDav/icalendar/rawEventWrite';

const CALENDAR_URL = 'https://calendar.example.test/calendars/raw/';
const RESOURCE_URL = `${CALENDAR_URL}event.ics`;
const RAW = 'BEGIN:VCALENDAR\r\nX-PRIVATE:sentinel\r\nEND:VCALENDAR\r\n';
const NODE: INode = {
	id: 'raw-write-node',
	name: 'Raw write node',
	type: 'calDav',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};
const EVENT = {
	calendarUrl: CALENDAR_URL,
	resourceUrl: RESOURCE_URL,
	etag: '"etag"',
	uid: 'event@example.test',
	summary: 'Raw',
	timeMode: 'timed',
	accessMode: 'editable',
	start: '2040-01-02T10:00:00Z',
	end: '2040-01-02T11:00:00Z',
	timeZoneMode: 'utc',
	startLocal: '2040-01-02T10:00:00',
	endLocal: '2040-01-02T11:00:00',
} as const;

function locator(value: string): unknown {
	return { __rl: true, mode: 'url', value };
}

function context(
	parameters: Readonly<Record<string, unknown>>,
	forbidden: ReadonlySet<string>,
	continueOnFail = false,
): IExecuteFunctions {
	return {
		getInputData: vi.fn().mockReturnValue([{ json: {} }]),
		getNodeParameter: vi.fn((name: string) => {
			if (forbidden.has(name)) throw new Error(`hidden ${name}`);
			return Reflect.get(parameters, name);
		}),
		getNode: vi.fn(() => NODE),
		continueOnFail: vi.fn(() => continueOnFail),
	} as unknown as IExecuteFunctions;
}

beforeEach(() => {
	mocks.createN8nCalDavTransport.mockReset().mockResolvedValue({
		serverUrl: 'https://calendar.example.test/',
		request: vi.fn(),
	});
	mocks.createCalendarEvent.mockReset().mockResolvedValue(EVENT);
	mocks.updateCalendarEvent.mockReset().mockResolvedValue({ ...EVENT, rawIcs: RAW });
	mocks.upsertCalendarEvent
		.mockReset()
		.mockResolvedValue({ action: 'update', event: { ...EVENT, rawIcs: RAW } });
});

describe('Raw ICS node descriptor and active extraction', () => {
	it('publishes exact mode/raw descriptors immediately after Calendar and hides structured controls', () => {
		const properties = new CalDav().description.properties;
		const calendarIndex = properties.findIndex(({ name }) => name === 'calendar');
		const mode = properties[calendarIndex + 1]!;
		const raw = properties[calendarIndex + 2]!;
		expect(mode).toMatchObject({
			displayName: 'Input Mode',
			name: 'inputMode',
			type: 'options',
			required: true,
			noDataExpression: true,
			default: 'structured',
			options: [
				{ name: 'Structured', value: 'structured', description: 'Use individual event fields' },
				{ name: 'Raw ICS', value: 'rawIcs', description: 'Supply a complete VCALENDAR object' },
			],
		});
		expect(raw).toMatchObject({
			displayName: 'Raw ICS',
			name: 'rawIcs',
			type: 'string',
			typeOptions: { rows: 12 },
			required: true,
			default: '',
		});
		for (const property of properties.filter(({ name }) =>
			['timeMode', 'summary', 'additionalFields', 'fieldsToUpdate'].includes(name),
		)) {
			expect(property.displayOptions?.show?.inputMode).toEqual(['structured']);
		}
	});

	it.each(['create', 'update', 'upsert'] as const)(
		'passes only active Raw ICS fields for %s and never reads hidden structured values',
		async (operation) => {
			const parameters = {
				resource: 'event',
				operation,
				calendar: locator(CALENDAR_URL),
				inputMode: 'rawIcs',
				rawIcs: RAW,
				identifierMode: 'resourceUrl',
				resourceUrl: RESOURCE_URL,
				etag: '"caller"',
			};
			const forbidden = new Set([
				'uid',
				'timeMode',
				'timeZoneMode',
				'timeZone',
				'start',
				'end',
				'startDate',
				'endDate',
				'summary',
				'additionalFields',
				'fieldsToUpdate',
			]);

			const [output] = await new CalDav().execute.call(context(parameters, forbidden));
			const selected =
				operation === 'create'
					? mocks.createCalendarEvent
					: operation === 'update'
						? mocks.updateCalendarEvent
						: mocks.upsertCalendarEvent;
			expect(selected).toHaveBeenCalledOnce();
			expect(selected.mock.calls[0]![1]).toMatchObject({
				calendarUrl: CALENDAR_URL,
				inputMode: 'rawIcs',
				rawIcs: RAW,
			});
			expect(output[0]?.pairedItem).toEqual({ item: 0 });
		},
	);

	it('continues with only the fixed Raw error and does not leak body or attached causes', async () => {
		mocks.createCalendarEvent.mockRejectedValue(
			Object.assign(new CalDavRawCalendarEventError('INVALID_RESOURCE'), {
				body: RAW,
				cause: new Error(RAW),
			}),
		);
		const [output] = await new CalDav().execute.call(
			context(
				{
					resource: 'event',
					operation: 'create',
					calendar: locator(CALENDAR_URL),
					inputMode: 'rawIcs',
					rawIcs: RAW,
				},
				new Set(),
				true,
			),
		);
		expect(output).toEqual([
			{
				json: { error: 'Raw ICS must contain one valid VCALENDAR event resource.' },
				pairedItem: { item: 0 },
			},
		]);
		expect(JSON.stringify(output)).not.toContain('sentinel');
	});
});
