import type { IExecuteFunctions, INode, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	createCalendarEvent: vi.fn(),
	createN8nCalDavTransport: vi.fn(),
	queryCalendarEventsByTimeRange: vi.fn(),
}));

vi.mock('../../nodes/CalDav/events/create', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/events/create')>()),
	createCalendarEvent: mocks.createCalendarEvent,
}));

vi.mock('../../nodes/CalDav/events/timeRangeQuery', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/events/timeRangeQuery')>()),
	queryCalendarEventsByTimeRange: mocks.queryCalendarEventsByTimeRange,
}));

vi.mock('../../nodes/CalDav/transport/http', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/transport/http')>()),
	createN8nCalDavTransport: mocks.createN8nCalDavTransport,
}));

import { CalDav } from '../../nodes/CalDav/CalDav.node';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';

const NODE: INode = {
	id: 'issue-41-node-contract',
	name: 'CalDAV issue #41 oracle',
	type: 'calDav',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};
const CALENDAR_URL = validateAbsoluteHttpUrl('https://calendar.example.test/calendars/all-day/');
const RESOURCE_URL = validateAbsoluteHttpUrl(
	'https://calendar.example.test/calendars/all-day/oracle.ics',
);
const TRANSPORT = { serverUrl: 'https://calendar.example.test/', request: vi.fn() };

type ParameterRecord = Readonly<Record<string, unknown>>;

function locator(value: string): unknown {
	return { __rl: true, mode: 'url', value };
}

function createParameters(overrides: ParameterRecord = {}): ParameterRecord {
	return {
		resource: 'event',
		operation: 'create',
		calendar: locator(CALENDAR_URL),
		uid: 'issue-41-create',
		timeMode: 'allDay',
		start: undefined,
		end: undefined,
		startDate: '2024-02-29',
		endDate: '2024-03-01',
		summary: 'One leap day',
		additionalFields: {},
		...overrides,
	};
}

function getManyParameters(overrides: ParameterRecord = {}): ParameterRecord {
	return {
		resource: 'event',
		operation: 'getMany',
		calendar: locator(CALENDAR_URL),
		start: '2024-02-29T00:00:00Z',
		end: '2024-03-02T00:00:00Z',
		returnAll: true,
		limit: 50,
		...overrides,
	};
}

function context(
	parameters: readonly ParameterRecord[],
	options: {
		readonly continueOnFail?: boolean;
		readonly timezone?: string;
		readonly input?: INodeExecutionData[];
	} = {},
): IExecuteFunctions {
	return {
		getInputData: vi
			.fn()
			.mockReturnValue(
				options.input ?? parameters.map((_value, index) => ({ json: { input: index } })),
			),
		getNodeParameter: vi.fn((name: string, index: number) => parameters[index]?.[name]),
		getTimezone: vi.fn().mockReturnValue(options.timezone ?? 'UTC'),
		getNode: vi.fn().mockReturnValue(NODE),
		continueOnFail: vi.fn().mockReturnValue(options.continueOnFail ?? false),
	} as unknown as IExecuteFunctions;
}

function event(
	uid: string,
	time:
		| { readonly timeMode: 'timed'; readonly start: string; readonly end: string }
		| { readonly timeMode: 'allDay'; readonly startDate: string; readonly endDate: string }
		| {
				readonly timeMode: 'unsupported';
				readonly readOnlyReason: 'unsupportedTimeRepresentation';
		  },
	accessMode: 'editable' | 'readOnly' = time.timeMode === 'unsupported' ? 'readOnly' : 'editable',
) {
	const timeProjection =
		time.timeMode === 'timed'
			? { timeMode: time.timeMode, accessMode, start: time.start, end: time.end }
			: time.timeMode === 'allDay'
				? {
						timeMode: time.timeMode,
						accessMode,
						startDate: time.startDate,
						endDate: time.endDate,
					}
				: {
						timeMode: time.timeMode,
						accessMode,
						readOnlyReason: time.readOnlyReason,
					};
	return {
		calendarUrl: CALENDAR_URL,
		resourceUrl: RESOURCE_URL,
		etag: '"issue-41-etag"',
		uid,
		summary: `Summary ${uid}`,
		...timeProjection,
	};
}

function eventProperties(operation: string): readonly INodeProperties[] {
	return new CalDav().description.properties.filter((property) => {
		if (property.name === 'calendar') return true;
		const show = property.displayOptions?.show;
		return (
			show?.resource?.includes('event') === true && show.operation?.includes(operation) === true
		);
	});
}

async function captureError(execution: IExecuteFunctions): Promise<Error> {
	try {
		await new CalDav().execute.call(execution);
	} catch (error) {
		return error as Error;
	}
	throw new Error('Expected the issue #41 node execution to fail.');
}

beforeEach(() => {
	mocks.createCalendarEvent.mockReset();
	mocks.queryCalendarEventsByTimeRange.mockReset();
	mocks.createN8nCalDavTransport.mockReset().mockResolvedValue(TRANSPORT);
	TRANSPORT.request.mockReset();
});

describe('issue #41 exact Event node surface', () => {
	it('keeps operation order/default and adds no Upsert', () => {
		const operation = new CalDav().description.properties.find(
			(property) =>
				property.name === 'operation' && property.displayOptions?.show?.resource?.includes('event'),
		);
		expect(operation?.default).toBe('get');
		expect(
			operation?.options?.map((option) => ('value' in option ? option.value : undefined)),
		).toEqual(['create', 'get', 'getMany', 'update', 'delete']);
	});

	it('exposes exact Create order and mode-specific required date pickers', () => {
		const properties = eventProperties('create');
		expect(properties.map(({ displayName }) => displayName)).toEqual([
			'Calendar',
			'UID',
			'Time Mode',
			'Time Zone Mode',
			'Time Zone',
			'Start',
			'End',
			'Start Date',
			'End Date',
			'Summary',
			'Additional Fields',
		]);
		const timeMode = properties.find(({ name }) => name === 'timeMode');
		expect(timeMode).toMatchObject({
			displayName: 'Time Mode',
			name: 'timeMode',
			type: 'options',
			required: true,
			noDataExpression: true,
			options: [
				{ name: 'Timed', value: 'timed' },
				{ name: 'All-Day', value: 'allDay' },
			],
			default: 'timed',
		});
		for (const name of ['start', 'end']) {
			expect(properties.find((property) => property.name === name)).toMatchObject({
				type: 'dateTime',
				required: true,
				displayOptions: { show: { timeMode: ['timed'] } },
			});
		}
		for (const name of ['startDate', 'endDate']) {
			expect(properties.find((property) => property.name === name)).toMatchObject({
				type: 'dateTime',
				typeOptions: { dateOnly: true },
				required: true,
				displayOptions: { show: { timeMode: ['allDay'] } },
			});
		}
	});

	it('keeps exact Update top-level order and collection option order/visibility', () => {
		const properties = eventProperties('update');
		expect(properties.map(({ displayName }) => displayName)).toEqual([
			'Calendar',
			'Identifier Mode',
			'Resource URL',
			'UID',
			'ETag',
			'Time Mode',
			'Fields to Update',
		]);
		const fields = properties.find(({ name }) => name === 'fieldsToUpdate');
		expect(fields?.options?.map((option) => option.displayName)).toEqual([
			'Time Zone',
			'Start',
			'End',
			'Start Date',
			'End Date',
			'Summary',
			'Description',
			'Location',
			'URL',
		]);
		expect(fields?.options?.find((option) => option.name === 'start')).toMatchObject({
			displayOptions: { show: { timeMode: ['timed'] } },
		});
		expect(fields?.options?.find((option) => option.name === 'startDate')).toMatchObject({
			typeOptions: { dateOnly: true },
			displayOptions: { show: { timeMode: ['allDay'] } },
		});
	});

	it('does not add event-mode, calendar-date, or timezone inputs to Get Many', () => {
		const properties = eventProperties('getMany');
		expect(properties.map(({ displayName }) => displayName)).toEqual([
			'Calendar',
			'Start',
			'End',
			'Return All',
			'Limit',
		]);
		expect(properties.map(({ name }) => name)).not.toEqual(
			expect.arrayContaining(['timeMode', 'startDate', 'endDate', 'timezone']),
		);
	});
});

describe('issue #41 Create normalization and output mapping', () => {
	it('passes exact all-day strings literally and returns ordered all-day JSON', async () => {
		mocks.createCalendarEvent.mockResolvedValue(
			event('all-day-literal', {
				timeMode: 'allDay',
				startDate: '2024-02-29',
				endDate: '2024-03-01',
			}),
		);
		const [output] = await new CalDav().execute.call(
			context([createParameters({ uid: 'all-day-literal' })]),
		);

		expect(mocks.createCalendarEvent.mock.calls[0]?.[1]).toMatchObject({
			timeMode: 'allDay',
			startDate: '2024-02-29',
			endDate: '2024-03-01',
		});
		expect(output).toEqual([
			{
				json: event('all-day-literal', {
					timeMode: 'allDay',
					startDate: '2024-02-29',
					endDate: '2024-03-01',
				}),
				pairedItem: { item: 0 },
			},
		]);
		expect(Object.keys(output[0]!.json)).toEqual([
			'calendarUrl',
			'resourceUrl',
			'etag',
			'uid',
			'summary',
			'timeMode',
			'accessMode',
			'startDate',
			'endDate',
		]);
	});

	it('projects native Date values through workflow timezone, independent of the host timezone', async () => {
		const start = new Date('2024-02-29T11:30:00Z');
		const end = new Date('2024-03-01T11:30:00Z');
		mocks.createCalendarEvent.mockResolvedValue(
			event('workflow-zone', {
				timeMode: 'allDay',
				startDate: '2024-03-01',
				endDate: '2024-03-02',
			}),
		);
		vi.stubEnv('TZ', 'America/Los_Angeles');
		try {
			await new CalDav().execute.call(
				context([createParameters({ uid: 'workflow-zone', startDate: start, endDate: end })], {
					timezone: 'Pacific/Kiritimati',
				}),
			);
		} finally {
			vi.unstubAllEnvs();
		}

		expect(mocks.createCalendarEvent.mock.calls[0]?.[1]).toMatchObject({
			timeMode: 'allDay',
			startDate: '2024-03-01',
			endDate: '2024-03-02',
		});
		expect(start.toISOString()).toBe('2024-02-29T11:30:00.000Z');
	});

	it('projects valid Luxon/n8n DateTime expressions through the same workflow timezone', async () => {
		const startInstant = new Date('2024-02-29T11:30:00Z');
		const endInstant = new Date('2024-03-01T11:30:00Z');
		const start = {
			isLuxonDateTime: true,
			isValid: true,
			toJSDate: vi.fn(() => startInstant),
		};
		const end = {
			isLuxonDateTime: true,
			isValid: true,
			toJSDate: vi.fn(() => endInstant),
		};
		mocks.createCalendarEvent.mockResolvedValue(
			event('luxon-workflow-zone', {
				timeMode: 'allDay',
				startDate: '2024-03-01',
				endDate: '2024-03-02',
			}),
		);

		await new CalDav().execute.call(
			context([createParameters({ uid: 'luxon-workflow-zone', startDate: start, endDate: end })], {
				timezone: 'Pacific/Kiritimati',
			}),
		);
		expect(mocks.createCalendarEvent.mock.calls[0]?.[1]).toMatchObject({
			timeMode: 'allDay',
			startDate: '2024-03-01',
			endDate: '2024-03-02',
		});
		expect(start.toJSDate).toHaveBeenCalledTimes(1);
		expect(end.toJSDate).toHaveBeenCalledTimes(1);
	});

	it('normalizes offset and zero-fraction timed strings to copied whole-second UTC Dates', async () => {
		mocks.createCalendarEvent.mockResolvedValue(
			event('timed-normalization', {
				timeMode: 'timed',
				start: '2024-02-29T09:00:00Z',
				end: '2024-02-29T10:00:00Z',
			}),
		);
		await new CalDav().execute.call(
			context([
				createParameters({
					uid: 'timed-normalization',
					timeMode: 'timed',
					start: '2024-02-29T10:00:00.000+01:00',
					end: '2024-02-29T11:00:00+01:00',
					startDate: undefined,
					endDate: undefined,
				}),
			]),
		);
		const input = mocks.createCalendarEvent.mock.calls[0]?.[1];
		expect(input).toMatchObject({ timeMode: 'timed' });
		expect(input.start).toEqual(new Date('2024-02-29T09:00:00Z'));
		expect(input.end).toEqual(new Date('2024-02-29T10:00:00Z'));
	});

	it('returns a supported authoritative read-only Create result as ordinary success', async () => {
		mocks.createCalendarEvent.mockResolvedValue(
			event('server-transformed', {
				timeMode: 'unsupported',
				readOnlyReason: 'unsupportedTimeRepresentation',
			}),
		);
		const [output] = await new CalDav().execute.call(context([createParameters()]));
		expect(output[0]).toEqual({
			json: event('server-transformed', {
				timeMode: 'unsupported',
				readOnlyReason: 'unsupportedTimeRepresentation',
			}),
			pairedItem: { item: 0 },
		});
		expect(output[0]?.json).not.toHaveProperty('start');
		expect(output[0]?.json).not.toHaveProperty('rawIcs');
	});
});

describe('issue #41 validation, privacy, pairing, and Get Many projection', () => {
	it.each([
		['invalid mode', { timeMode: 'private-mode' }, /time mode/i],
		['missing selected end', { endDate: undefined }, /end date|required/i],
		['invalid leap date', { startDate: '2100-02-29' }, /start date/i],
		['year zero', { startDate: '0000-01-01' }, /start date/i],
		['date suffix', { startDate: '2024-02-29Z' }, /start date/i],
		['locale date', { startDate: '2/29/2024' }, /start date/i],
		['equal range', { endDate: '2024-02-29' }, /later|range/i],
		['mixed families', { start: '2024-02-29T00:00:00Z' }, /mixed|time/i],
		[
			'unzoned timed string',
			{
				timeMode: 'timed',
				start: '2024-02-29T00:00:00',
				end: '2024-02-29T01:00:00Z',
				startDate: undefined,
				endDate: undefined,
			},
			/start/i,
		],
		[
			'locale timed string',
			{
				timeMode: 'timed',
				start: '2/29/2024 10:00',
				end: '2024-02-29T11:00:00Z',
				startDate: undefined,
				endDate: undefined,
			},
			/start/i,
		],
		[
			'nonzero timed fraction',
			{
				timeMode: 'timed',
				start: '2024-02-29T00:00:00.001Z',
				end: '2024-02-29T01:00:00Z',
				startDate: undefined,
				endDate: undefined,
			},
			/start/i,
		],
	] as const)('rejects %s before transport or mutation I/O', async (_label, overrides, message) => {
		const error = await captureError(context([createParameters(overrides)]));
		expect(error).toBeInstanceOf(NodeOperationError);
		expect(error.message).toMatch(message);
		expect(error).toMatchObject({ context: { itemIndex: 0 } });
		expect(mocks.createN8nCalDavTransport).not.toHaveBeenCalled();
		expect(mocks.createCalendarEvent).not.toHaveBeenCalled();
		expect(JSON.stringify(error)).not.toMatch(/private-mode|2100-02-29|2\\?\/29/);
	});

	it('preserves exact per-item pairing and sanitizes continue-on-fail without stopping later items', async () => {
		mocks.createCalendarEvent
			.mockResolvedValueOnce(
				event('first', {
					timeMode: 'allDay',
					startDate: '2024-02-29',
					endDate: '2024-03-01',
				}),
			)
			.mockResolvedValueOnce(
				event('third', {
					timeMode: 'timed',
					start: '2024-02-29T10:00:00Z',
					end: '2024-02-29T11:00:00Z',
				}),
			);
		const [output] = await new CalDav().execute.call(
			context(
				[
					createParameters({ uid: 'first' }),
					createParameters({ uid: 'private-uid', startDate: 'private-date' }),
					createParameters({
						uid: 'third',
						timeMode: 'timed',
						start: '2024-02-29T10:00:00Z',
						end: '2024-02-29T11:00:00Z',
						startDate: undefined,
						endDate: undefined,
					}),
				],
				{ continueOnFail: true },
			),
		);
		expect(output.map(({ pairedItem }) => pairedItem)).toEqual([
			{ item: 0 },
			{ item: 1 },
			{ item: 2 },
		]);
		expect(output[1]).toEqual({
			json: { error: expect.stringMatching(/start date/i) },
			pairedItem: { item: 1 },
		});
		expect(JSON.stringify(output[1])).not.toMatch(/private-date|private-uid|calendar\.example/);
		expect(mocks.createCalendarEvent).toHaveBeenCalledTimes(2);
	});

	it('projects extensions last for timed, all-day, and read-only execution outputs', async () => {
		const timed = {
			...event('timed-extensions', {
				timeMode: 'timed',
				start: '2024-02-29T10:00:00Z',
				end: '2024-02-29T11:00:00Z',
			}),
			extensions: { oracle: { mode: 'timed' } },
		};
		const allDay = {
			...event('all-day-extensions', {
				timeMode: 'allDay',
				startDate: '2024-02-29',
				endDate: '2024-03-01',
			}),
			extensions: { oracle: { mode: 'allDay' } },
		};
		const readOnly = {
			...event('read-only-extensions', {
				timeMode: 'unsupported',
				readOnlyReason: 'unsupportedTimeRepresentation',
			}),
			extensions: { oracle: { mode: 'readOnly' } },
		};
		mocks.queryCalendarEventsByTimeRange.mockResolvedValue(
			[timed, allDay, readOnly].map((event) => ({ event, context: {} })),
		);

		const [output] = await new CalDav().execute.call(context([getManyParameters()]));

		expect(output.map(({ json }) => json)).toEqual([timed, allDay, readOnly]);
		expect(output.map(({ json }) => Object.keys(json))).toEqual([
			[
				'calendarUrl',
				'resourceUrl',
				'etag',
				'uid',
				'summary',
				'timeMode',
				'accessMode',
				'start',
				'end',
				'extensions',
			],
			[
				'calendarUrl',
				'resourceUrl',
				'etag',
				'uid',
				'summary',
				'timeMode',
				'accessMode',
				'startDate',
				'endDate',
				'extensions',
			],
			[
				'calendarUrl',
				'resourceUrl',
				'etag',
				'uid',
				'summary',
				'timeMode',
				'accessMode',
				'readOnlyReason',
				'extensions',
			],
		]);
	});

	it('projects mixed Get Many results without dropping read-only items and applies Limit afterward', async () => {
		mocks.queryCalendarEventsByTimeRange.mockResolvedValue([
			{
				event: event('all-day', {
					timeMode: 'allDay',
					startDate: '2024-02-29',
					endDate: '2024-03-01',
				}),
				context: {},
			},
			{
				event: event('read-only', {
					timeMode: 'unsupported',
					readOnlyReason: 'unsupportedTimeRepresentation',
				}),
				context: {},
			},
		]);
		const [output] = await new CalDav().execute.call(
			context([getManyParameters({ returnAll: false, limit: 2 })]),
		);
		expect(output).toEqual([
			{
				json: event('all-day', {
					timeMode: 'allDay',
					startDate: '2024-02-29',
					endDate: '2024-03-01',
				}),
				pairedItem: { item: 0 },
			},
			{
				json: event('read-only', {
					timeMode: 'unsupported',
					readOnlyReason: 'unsupportedTimeRepresentation',
				}),
				pairedItem: { item: 0 },
			},
		]);
	});
});
