import type { IExecuteFunctions, INode, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	createCalendarEvent: vi.fn(),
	createN8nCalDavTransport: vi.fn(),
	createCalendarEventTimeZoneExecutionContext: vi.fn(),
}));

vi.mock('../../nodes/CalDav/events/create', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/events/create')>()),
	createCalendarEvent: mocks.createCalendarEvent,
}));

vi.mock('../../nodes/CalDav/transport/http', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/transport/http')>()),
	createN8nCalDavTransport: mocks.createN8nCalDavTransport,
}));

vi.mock('../../nodes/CalDav/discovery/timeZoneReferences', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/discovery/timeZoneReferences')>()),
	createCalendarEventTimeZoneExecutionContext: mocks.createCalendarEventTimeZoneExecutionContext,
}));

import { CalDav } from '../../nodes/CalDav/CalDav.node';
import tzdbOracle from './fixtures/time-zones/tzdb-2026c-oracle.json';

const NODE: INode = {
	id: 'event-time-zone-node',
	name: 'CalDAV Event Time Zone',
	type: 'calDav',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

const TRANSPORT = { serverUrl: 'https://calendar.example.test/', request: vi.fn() };
const TIME_ZONE_CONTEXT = { resolveReference: vi.fn() };

interface CreateParameters {
	readonly resource: unknown;
	readonly operation: unknown;
	readonly calendar: unknown;
	readonly uid: unknown;
	readonly timeZoneMode: unknown;
	readonly timeZone?: unknown;
	readonly start: unknown;
	readonly end: unknown;
	readonly summary: unknown;
	readonly additionalFields: unknown;
}

function parameters(overrides: Partial<CreateParameters> = {}): CreateParameters {
	return {
		resource: 'event',
		operation: 'create',
		calendar: { __rl: true, mode: 'url', value: 'https://calendar.example.test/calendars/work/' },
		uid: 'synthetic-event',
		timeZoneMode: 'utc',
		timeZone: 'Private/Inactive-Canary',
		start: '2040-01-15T10:00:00+01:00',
		end: '2040-01-15T11:00:00+01:00',
		summary: 'Synthetic event',
		additionalFields: {},
		...overrides,
	};
}

function context(
	items: readonly CreateParameters[],
	options: { readonly continueOnFail?: boolean; readonly input?: INodeExecutionData[] } = {},
): IExecuteFunctions {
	return {
		getInputData: vi
			.fn()
			.mockReturnValue(options.input ?? items.map((_item, item) => ({ json: { item } }))),
		getNodeParameter: vi.fn((name: keyof CreateParameters, item: number) =>
			Reflect.get(items[item], name),
		),
		getNode: vi.fn().mockReturnValue(NODE),
		continueOnFail: vi.fn().mockReturnValue(options.continueOnFail ?? false),
	} as unknown as IExecuteFunctions;
}

function createProperties(): readonly INodeProperties[] {
	return new CalDav().description.properties.filter((property) => {
		const show = property.displayOptions?.show;
		return (
			property.name === 'calendar' ||
			(show?.resource?.includes('event') === true && show.operation?.includes('create') === true)
		);
	});
}

async function captureError(execution: IExecuteFunctions): Promise<NodeOperationError> {
	try {
		await new CalDav().execute.call(execution);
	} catch (error) {
		expect(error).toBeInstanceOf(NodeOperationError);
		return error as NodeOperationError;
	}
	throw new Error('Expected node execution to fail.');
}

async function captureAnyError(execution: IExecuteFunctions): Promise<Error> {
	try {
		await new CalDav().execute.call(execution);
	} catch (error) {
		return error as Error;
	}
	throw new Error('Expected node execution to fail.');
}

beforeEach(() => {
	mocks.createN8nCalDavTransport.mockReset().mockResolvedValue(TRANSPORT);
	mocks.createCalendarEventTimeZoneExecutionContext.mockReset().mockReturnValue(TIME_ZONE_CONTEXT);
	mocks.createCalendarEvent.mockReset().mockImplementation(async (_transport, input) => ({
		calendarUrl: input.calendarUrl,
		resourceUrl: `${input.calendarUrl}synthetic-event.ics`,
		etag: '"synthetic-etag"',
		uid: input.uid,
		summary: input.summary,
		timeMode: 'timed',
		accessMode: 'editable',
		start: input.start.toISOString().replace('.000Z', 'Z'),
		end: input.end.toISOString().replace('.000Z', 'Z'),
		...(input.timeZone.timeZoneMode === 'iana'
			? {
					timeZoneMode: 'iana',
					timeZone: input.timeZone.timeZone,
					startLocal: '2040-01-15T10:00:00',
					endLocal: '2040-01-15T11:00:00',
				}
			: {
					timeZoneMode: 'utc',
					startLocal: '2040-01-15T09:00:00',
					endLocal: '2040-01-15T10:00:00',
				}),
	}));
	TRANSPORT.request.mockReset();
	TIME_ZONE_CONTEXT.resolveReference.mockReset();
});

describe('CalDAV timed event timezone UI', () => {
	it('keeps operation order/default and exposes exact Create field order and descriptors', () => {
		const node = new CalDav();
		const operation = node.description.properties.find(
			(property) =>
				property.name === 'operation' && property.displayOptions?.show?.resource?.includes('event'),
		);
		expect(operation?.default).toBe('get');
		expect(
			operation?.options?.map((option) => ('value' in option ? option.value : undefined)),
		).toEqual(['create', 'get', 'getMany', 'update', 'delete']);
		const properties = createProperties();
		expect(properties.map(({ displayName }) => displayName)).toEqual([
			'Calendar',
			'UID',
			'Time Zone Mode',
			'Time Zone',
			'Start',
			'End',
			'Summary',
			'Additional Fields',
		]);
		expect(properties[2]).toMatchObject({
			name: 'timeZoneMode',
			type: 'options',
			required: true,
			default: 'utc',
			options: [
				{ name: 'UTC', value: 'utc' },
				{ name: 'IANA', value: 'iana' },
			],
		});
		expect(properties[3]).toMatchObject({
			name: 'timeZone',
			type: 'options',
			required: true,
			default: '',
			typeOptions: { loadOptionsMethod: 'getIanaTimeZones' },
			displayOptions: {
				show: { resource: ['event'], operation: ['create'], timeZoneMode: ['iana'] },
			},
		});
	});

	it('places atomic Time Zone first inside Update fields', () => {
		const fields = new CalDav().description.properties.find(
			({ name }) => name === 'fieldsToUpdate',
		);
		expect(fields?.options?.map(({ name }) => name)).toEqual([
			'timeZone',
			'start',
			'end',
			'summary',
			'description',
			'location',
			'url',
		]);
		expect(fields?.options?.[0]).toMatchObject({
			displayName: 'Time Zone',
			name: 'timeZone',
			type: 'fixedCollection',
			required: true,
		});
	});

	it('loads sorted canonical options locally with zero transport requests', async () => {
		const node = new CalDav();
		const loader = (
			node.methods as unknown as {
				loadOptions: {
					getIanaTimeZones: (this: unknown) => Promise<readonly { name: string; value: string }[]>;
				};
			}
		).loadOptions.getIanaTimeZones;
		const result = await loader.call({ getNode: () => NODE });
		const expected = tzdbOracle.zones
			.filter((zone) => zone !== 'Etc/GMT' && zone !== 'Etc/UTC')
			.sort()
			.map((zone) => ({ name: zone, value: zone }));
		expect(result).toEqual(expected);
		expect(result).toEqual(
			expect.arrayContaining([
				{ name: 'Europe/Prague', value: 'Europe/Prague' },
				{ name: 'Etc/GMT+5', value: 'Etc/GMT+5' },
			]),
		);
		expect(result).not.toEqual(
			expect.arrayContaining([{ name: 'US/Eastern', value: 'US/Eastern' }]),
		);
		expect(mocks.createN8nCalDavTransport).not.toHaveBeenCalled();
	});
});

describe('CalDAV timed event timezone normalization and errors', () => {
	it('does not access the inactive timezone parameter in UTC mode', async () => {
		const input = parameters();
		const execution = context([input]);
		const getNodeParameter = execution.getNodeParameter as ReturnType<typeof vi.fn>;
		getNodeParameter.mockImplementation((name: keyof CreateParameters, item: number) => {
			if (name === 'timeZone') throw new Error('inactive timeZone accessed');
			return Reflect.get([input][item], name);
		});
		await expect(new CalDav().execute.call(execution)).resolves.toBeDefined();
		expect(mocks.createCalendarEvent.mock.calls[0][1]).toMatchObject({
			timeZone: { timeZoneMode: 'utc' },
			start: new Date('2040-01-15T09:00:00Z'),
			end: new Date('2040-01-15T10:00:00Z'),
		});
	});

	it('canonicalizes an IANA alias/case while preserving absolute offset instants and copies Date inputs', async () => {
		const start = new Date('2040-01-15T09:00:00Z');
		const execution = context([
			parameters({
				timeZoneMode: 'iana',
				timeZone: 'europe/prague',
				start,
				end: '2040-01-15T11:00:00+01:00',
			}),
		]);
		await new CalDav().execute.call(execution);
		const input = mocks.createCalendarEvent.mock.calls[0][1];
		expect(input).toMatchObject({
			timeZone: { timeZoneMode: 'iana', timeZone: 'Europe/Prague' },
			start: new Date('2040-01-15T09:00:00Z'),
			end: new Date('2040-01-15T10:00:00Z'),
		});
		expect(input.start).not.toBe(start);
	});

	it.each([
		['invalid mode', { timeZoneMode: 'local' }, 'Time Zone Mode must be UTC or IANA.'],
		[
			'invalid zone',
			{ timeZoneMode: 'iana', timeZone: 'Private/Account-42' },
			'Time Zone must be a valid IANA time zone identifier.',
		],
		[
			'UTC alias',
			{ timeZoneMode: 'iana', timeZone: 'Etc/UTC' },
			'Time Zone resolves to UTC. Use UTC Time Zone Mode.',
		],
		[
			'second overlap Start',
			{
				timeZoneMode: 'iana',
				timeZone: 'Europe/Prague',
				start: '2040-10-28T01:30:00Z',
				end: '2040-10-28T02:30:00Z',
			},
			'Start cannot be represented unambiguously in the selected IANA time zone. Use UTC mode for this instant.',
		],
		[
			'second overlap End',
			{
				timeZoneMode: 'iana',
				timeZone: 'Europe/Prague',
				start: '2040-10-28T00:00:00Z',
				end: '2040-10-28T01:30:00Z',
			},
			'End cannot be represented unambiguously in the selected IANA time zone. Use UTC mode for this instant.',
		],
	] as const)(
		'returns the exact privacy-safe pre-I/O error for %s',
		async (_label, overrides, message) => {
			const error = await captureError(context([parameters(overrides)]));
			expect(error.message).toBe(message);
			expect(error.context.itemIndex).toBe(0);
			expect(mocks.createN8nCalDavTransport).not.toHaveBeenCalled();
			expect(mocks.createCalendarEvent).not.toHaveBeenCalled();
			expect(String(error)).not.toMatch(/Private\/Account-42|2040-10-28|Europe\/Prague|Etc\/UTC/);
		},
	);

	it('shares one lazy timezone execution context across mixed per-item IANA work and preserves pairing', async () => {
		const execution = context([
			parameters({ uid: 'utc', timeZoneMode: 'utc' }),
			parameters({ uid: 'iana-a', timeZoneMode: 'iana', timeZone: 'Europe/Prague' }),
			parameters({ uid: 'iana-b', timeZoneMode: 'iana', timeZone: 'Asia/Kolkata' }),
		]);
		const result = await new CalDav().execute.call(execution);
		expect(mocks.createCalendarEventTimeZoneExecutionContext).toHaveBeenCalledTimes(1);
		expect(mocks.createCalendarEvent.mock.calls.map((call) => call[3])).toEqual([
			TIME_ZONE_CONTEXT,
			TIME_ZONE_CONTEXT,
			TIME_ZONE_CONTEXT,
		]);
		expect(result[0].map(({ pairedItem }) => pairedItem)).toEqual([
			{ item: 0 },
			{ item: 1 },
			{ item: 2 },
		]);
	});

	it.each([
		['SERVER_UNSUPPORTED', 'The CalDAV server does not support IANA time zones by reference.'],
		[
			'ZONE_UNAVAILABLE',
			'The selected IANA time zone is not available by reference on the CalDAV server.',
		],
	] as const)('maps %s to the exact privacy-safe NodeApiError', async (code, message) => {
		const referenceModule = await import('../../nodes/CalDav/discovery/timeZoneReferences');
		mocks.createCalendarEvent.mockRejectedValueOnce(
			new referenceModule.CalDavTimeZoneReferenceError(
				referenceModule.TimeZoneReferenceFailureCode[code],
			),
		);
		const error = await captureAnyError(
			context([parameters({ timeZoneMode: 'iana', timeZone: 'Europe/Prague' })]),
		);
		expect(error).toBeInstanceOf(NodeApiError);
		expect(error.message).toBe(message);
		expect(String(error)).not.toMatch(
			/Europe\/Prague|calendar\.example\.test|synthetic-etag|authorization|cookie/i,
		);
	});
});
