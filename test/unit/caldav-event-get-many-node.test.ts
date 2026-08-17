import type { IExecuteFunctions, INode, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	createN8nCalDavTransport: vi.fn(),
	queryCalendarEventsByTimeRange: vi.fn(),
}));

vi.mock('../../nodes/CalDav/transport/http', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/transport/http')>()),
	createN8nCalDavTransport: mocks.createN8nCalDavTransport,
}));

vi.mock('../../nodes/CalDav/events/timeRangeQuery', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/events/timeRangeQuery')>()),
	queryCalendarEventsByTimeRange: mocks.queryCalendarEventsByTimeRange,
}));

import { CalDav } from '../../nodes/CalDav/CalDav.node';
import type { CalendarEventReadResult } from '../../nodes/CalDav/icalendar/eventReadModel';
import { CalDavResponseLimitError } from '../../nodes/CalDav/transport/http';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';

const NODE: INode = {
	id: 'event-get-many-node',
	name: 'CalDAV Event Get Many',
	type: 'calDav',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

const TRANSPORT = { serverUrl: 'https://configured.example.test/', request: vi.fn() };

interface Parameters {
	readonly resource: unknown;
	readonly operation: unknown;
	readonly calendar: unknown;
	readonly start: unknown;
	readonly end: unknown;
	readonly returnAll: unknown;
	readonly limit?: unknown;
}

function locator(value: unknown, mode: unknown = 'url'): unknown {
	return { __rl: true, mode, value };
}

function parameters(overrides: Partial<Parameters> = {}): Parameters {
	return {
		resource: 'event',
		operation: 'getMany',
		calendar: locator('https://calendar.example.test/calendars/work'),
		start: '2040-01-02T10:00:00Z',
		end: '2040-01-02T11:00:00Z',
		returnAll: false,
		limit: 50,
		...overrides,
	};
}

function context(
	itemParameters: readonly Parameters[],
	options: { readonly continueOnFail?: boolean } = {},
): IExecuteFunctions {
	return {
		getInputData: vi
			.fn()
			.mockReturnValue(itemParameters.map((_, index) => ({ json: { privateInput: index } }))),
		getNodeParameter: vi.fn((name: keyof Parameters, index: number) => itemParameters[index][name]),
		getNode: vi.fn().mockReturnValue(NODE),
		continueOnFail: vi.fn().mockReturnValue(options.continueOnFail ?? false),
	} as unknown as IExecuteFunctions;
}

function event(uid: string, overrides: Partial<CalendarEventReadResult['event']> = {}) {
	return {
		event: {
			calendarUrl: validateAbsoluteHttpUrl('https://calendar.example.test/calendars/work/'),
			resourceUrl: validateAbsoluteHttpUrl(
				`https://calendar.example.test/calendars/work/${encodeURIComponent(uid)}.ics`,
			),
			etag: 'W/"etag"',
			uid,
			summary: '',
			description: undefined,
			location: 'Room',
			url: undefined,
			timeMode: 'timed',
			accessMode: 'editable',
			start: '2040-01-02T10:00:00Z',
			end: '2040-01-02T10:30:00Z',
			...overrides,
		},
		context: { private: 'ics-context' },
	} as unknown as CalendarEventReadResult;
}

function property(
	properties: readonly INodeProperties[],
	name: string,
	resource?: string,
	operation?: string,
) {
	const matches = properties.filter(
		(candidate) =>
			candidate.name === name &&
			(resource === undefined || candidate.displayOptions?.show?.resource?.includes(resource)) &&
			(operation === undefined || candidate.displayOptions?.show?.operation?.includes(operation)),
	);
	expect(matches).toHaveLength(1);
	return matches[0];
}

async function execute(executionContext: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	return await new CalDav().execute.call(executionContext);
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		return error as Error;
	}
	throw new Error('Expected execution to fail.');
}

beforeEach(() => {
	mocks.createN8nCalDavTransport.mockReset().mockResolvedValue(TRANSPORT);
	mocks.queryCalendarEventsByTimeRange.mockReset();
	TRANSPORT.request.mockReset();
});

describe('CalDAV Event Get Many metadata', () => {
	it('adds the exact Event operation and range fields with their defaults and visibility', () => {
		const properties = new CalDav().description.properties;
		expect(property(properties, 'operation', 'event')).toMatchObject({
			default: 'get',
			options: [
				{
					name: 'Create',
					value: 'create',
					description: 'Create a calendar event',
					action: 'Create a calendar event',
				},
				{ name: 'Get', value: 'get', description: 'Retrieve a calendar event' },
				{
					name: 'Get Many',
					value: 'getMany',
					description: 'Retrieve events in a date range',
					action: 'Get many events',
				},
				{
					name: 'Update',
					value: 'update',
					description: 'Update a calendar event',
					action: 'Update a calendar event',
				},
				{
					name: 'Upsert',
					value: 'upsert',
					description: 'Create or update a calendar event by UID',
					action: 'Upsert a calendar event',
				},
				{
					name: 'Delete',
					value: 'delete',
					description: 'Delete a calendar event',
					action: 'Delete a calendar event',
				},
			],
		});
		expect(property(properties, 'calendar')).toMatchObject({
			required: true,
			default: { mode: 'url', value: '' },
			displayOptions: {
				show: {
					resource: ['calendar', 'event'],
					operation: ['create', 'get', 'getMany', 'update', 'upsert', 'delete'],
				},
				hide: { resource: ['calendar'], operation: ['getMany'] },
			},
		});
		expect(property(properties, 'start', 'event', 'getMany')).toMatchObject({
			displayName: 'Start',
			type: 'dateTime',
			required: true,
			default: '',
			displayOptions: { show: { resource: ['event'], operation: ['getMany'] } },
		});
		expect(property(properties, 'end', 'event', 'getMany')).toMatchObject({
			displayName: 'End',
			type: 'dateTime',
			required: true,
			default: '',
			displayOptions: { show: { resource: ['event'], operation: ['getMany'] } },
		});
		expect(property(properties, 'returnAll', 'event')).toMatchObject({
			displayName: 'Return All',
			type: 'boolean',
			default: false,
			displayOptions: { show: { resource: ['event'], operation: ['getMany'] } },
		});
		expect(property(properties, 'limit', 'event')).toMatchObject({
			displayName: 'Limit',
			type: 'number',
			default: 50,
			typeOptions: { minValue: 1 },
			displayOptions: {
				show: { resource: ['event'], operation: ['getMany'], returnAll: [false] },
			},
		});
	});
});

describe('CalDAV Event Get Many execution', () => {
	it('accepts the inclusive four-digit UTC year boundaries', async () => {
		mocks.queryCalendarEventsByTimeRange.mockResolvedValue([]);

		await expect(
			execute(
				context([
					parameters({ start: '0001-01-01T00:00:00Z', end: '0001-01-02T00:00:00Z' }),
					parameters({ start: '9999-12-30T00:00:00Z', end: '9999-12-31T00:00:00Z' }),
				]),
			),
		).resolves.toEqual([[]]);
		expect(mocks.queryCalendarEventsByTimeRange).toHaveBeenCalledTimes(2);
		expect(mocks.queryCalendarEventsByTimeRange.mock.calls[0]?.[2]).toEqual({
			start: expect.any(Date),
			end: expect.any(Date),
		});
		expect(mocks.queryCalendarEventsByTimeRange.mock.calls[0]?.[2].start.getUTCFullYear()).toBe(1);
		expect(mocks.queryCalendarEventsByTimeRange.mock.calls[1]?.[2].end.getUTCFullYear()).toBe(9999);
	});

	it('normalizes each calendar, delegates sequentially, slices service order, projects events, and pairs input', async () => {
		const first = event('first');
		const second = event('second', { etag: undefined, summary: undefined, description: '' });
		const third = event('third');
		mocks.queryCalendarEventsByTimeRange
			.mockResolvedValueOnce([second, first, third])
			.mockResolvedValueOnce([event('other')]);

		const [output] = await execute(
			context([
				parameters({ limit: 2 }),
				parameters({ calendar: locator('https://calendar.example.test/calendars/other/') }),
			]),
		);

		expect(mocks.queryCalendarEventsByTimeRange).toHaveBeenNthCalledWith(
			1,
			TRANSPORT,
			'https://calendar.example.test/calendars/work/',
			{ start: new Date('2040-01-02T10:00:00Z'), end: new Date('2040-01-02T11:00:00Z') },
			expect.objectContaining({ resolveReference: expect.any(Function) }),
		);
		expect(mocks.queryCalendarEventsByTimeRange).toHaveBeenNthCalledWith(
			2,
			TRANSPORT,
			'https://calendar.example.test/calendars/other/',
			{ start: new Date('2040-01-02T10:00:00Z'), end: new Date('2040-01-02T11:00:00Z') },
			expect.objectContaining({ resolveReference: expect.any(Function) }),
		);
		expect(output).toEqual([
			{
				json: {
					calendarUrl: 'https://calendar.example.test/calendars/work/',
					resourceUrl: 'https://calendar.example.test/calendars/work/second.ics',
					uid: 'second',
					description: '',
					location: 'Room',
					timeMode: 'timed',
					accessMode: 'editable',
					start: '2040-01-02T10:00:00Z',
					end: '2040-01-02T10:30:00Z',
				},
				pairedItem: { item: 0 },
			},
			{
				json: {
					calendarUrl: 'https://calendar.example.test/calendars/work/',
					resourceUrl: 'https://calendar.example.test/calendars/work/first.ics',
					etag: 'W/"etag"',
					uid: 'first',
					summary: '',
					location: 'Room',
					timeMode: 'timed',
					accessMode: 'editable',
					start: '2040-01-02T10:00:00Z',
					end: '2040-01-02T10:30:00Z',
				},
				pairedItem: { item: 0 },
			},
			{
				json: {
					calendarUrl: 'https://calendar.example.test/calendars/work/',
					resourceUrl: 'https://calendar.example.test/calendars/work/other.ics',
					etag: 'W/"etag"',
					uid: 'other',
					summary: '',
					location: 'Room',
					timeMode: 'timed',
					accessMode: 'editable',
					start: '2040-01-02T10:00:00Z',
					end: '2040-01-02T10:30:00Z',
				},
				pairedItem: { item: 1 },
			},
		]);
	});

	it('emits no item for empty results and ignores an invalid hidden Limit when Return All is true', async () => {
		mocks.queryCalendarEventsByTimeRange.mockResolvedValue([]);
		const executionContext = context([parameters({ returnAll: true, limit: 0 })]);
		await expect(execute(executionContext)).resolves.toEqual([[]]);
		expect(executionContext.getNodeParameter).not.toHaveBeenCalledWith('limit', 0);
	});
});

describe('CalDAV Event Get Many validation and failures', () => {
	it.each([
		['string', '0000-01-01T00:00:00Z'],
		[
			'native Date',
			(() => {
				const value = new Date(0);
				value.setUTCFullYear(0, 0, 1);
				value.setUTCHours(0, 0, 0, 0);
				return value;
			})(),
		],
		[
			'Luxon/n8n DateTime',
			{
				isLuxonDateTime: true,
				isValid: true,
				toJSDate: () => {
					const value = new Date(0);
					value.setUTCFullYear(0, 0, 1);
					value.setUTCHours(0, 0, 0, 0);
					return value;
				},
			},
		],
	] as const)('rejects year zero from a %s before transport or query', async (_label, start) => {
		const error = await captureError(execute(context([parameters({ start })])));
		expect(error).toBeInstanceOf(NodeOperationError);
		expect(error.message).toBe('Start must be a valid date and time with whole-second precision.');
		expect(mocks.createN8nCalDavTransport).not.toHaveBeenCalled();
		expect(mocks.queryCalendarEventsByTimeRange).not.toHaveBeenCalled();
	});

	it.each([
		['start', '2040-01-02T10:00:00'],
		['start', '2040-01-02T10:00:00.123Z'],
		['end', 'not-a-date'],
	] as const)('rejects invalid %s before transport or query', async (field, value) => {
		const error = await captureError(execute(context([parameters({ [field]: value })])));
		expect(error).toBeInstanceOf(NodeOperationError);
		expect(error.message).toBe(
			field === 'start'
				? 'Start must be a valid date and time with whole-second precision.'
				: 'End must be a valid date and time with whole-second precision.',
		);
		expect(mocks.createN8nCalDavTransport).not.toHaveBeenCalled();
		expect(mocks.queryCalendarEventsByTimeRange).not.toHaveBeenCalled();
	});

	it.each([
		[0, 'Limit must be an integer greater than or equal to 1.'],
		['true', 'Return All must be true or false.'],
		[undefined, 'End must be later than Start.'],
	] as const)('rejects invalid active configuration before I/O', async (value, message) => {
		const overrides =
			message === 'End must be later than Start.'
				? { end: '2040-01-02T10:00:00Z' }
				: message === 'Return All must be true or false.'
					? { returnAll: value }
					: { limit: value, returnAll: false };
		const error = await captureError(execute(context([parameters(overrides)])));
		expect(error).toMatchObject({ message, context: { itemIndex: 0 } });
		expect(mocks.createN8nCalDavTransport).not.toHaveBeenCalled();
	});

	it('maps the response limit safely and continues with later inputs when enabled', async () => {
		mocks.queryCalendarEventsByTimeRange
			.mockRejectedValueOnce(Object.assign(new CalDavResponseLimitError(), { body: 'private-ics' }))
			.mockResolvedValueOnce([event('success')]);
		const [output] = await execute(context([parameters(), parameters()], { continueOnFail: true }));
		expect(output).toEqual([
			{
				json: { error: 'The Event Get Many response exceeded the size limit.' },
				pairedItem: { item: 0 },
			},
			expect.objectContaining({ pairedItem: { item: 1 } }),
		]);
		expect(JSON.stringify(output)).not.toContain('private-ics');
	});

	it('throws an item-indexed API error for a response limit when continuation is disabled', async () => {
		mocks.queryCalendarEventsByTimeRange.mockRejectedValue(new CalDavResponseLimitError());
		const error = await captureError(execute(context([parameters()])));
		expect(error).toBeInstanceOf(NodeApiError);
		expect(error).toMatchObject({
			message: 'The Event Get Many response exceeded the size limit.',
			context: { itemIndex: 0 },
		});
	});
});
