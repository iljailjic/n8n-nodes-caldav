import type { IExecuteFunctions, INode, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// Test-only native request event doubles.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { EventEmitter } from 'node:events';

const mocks = vi.hoisted(() => ({
	createCalendarEvent: vi.fn(),
	createN8nCalDavTransport: vi.fn(),
	createCalendarEventTimeZoneExecutionContext: vi.fn(),
	httpRequest: vi.fn(),
	httpsRequest: vi.fn(),
}));

vi.mock('node:http', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:http')>()),
	request: mocks.httpRequest,
}));

vi.mock('node:https', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:https')>()),
	request: mocks.httpsRequest,
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
	options: {
		readonly continueOnFail?: boolean;
		readonly input?: INodeExecutionData[];
		readonly secureEgressFilter?: {
			readonly validateUrl: ReturnType<typeof vi.fn>;
			readonly createSecureLookup: ReturnType<typeof vi.fn>;
		};
	} = {},
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
		helpers: { getSecureEgressFilter: () => options.secureEgressFilter },
	} as unknown as IExecuteFunctions;
}

function mockNativeResponse(statusCode: number): void {
	mocks.httpsRequest.mockImplementation(
		(_url: unknown, _options: unknown, onResponse: (response: EventEmitter) => void) => {
			const request = new EventEmitter() as EventEmitter & {
				setTimeout: ReturnType<typeof vi.fn>;
				destroy: ReturnType<typeof vi.fn>;
				end: ReturnType<typeof vi.fn>;
			};
			request.setTimeout = vi.fn();
			request.destroy = vi.fn((error?: Error) => {
				if (error !== undefined) request.emit('error', error);
			});
			request.end = vi.fn(() => {
				const response = new EventEmitter() as EventEmitter & {
					statusCode: number;
					headers: Record<string, string>;
					destroy: ReturnType<typeof vi.fn>;
				};
				response.statusCode = statusCode;
				response.headers = { Location: 'https://tzdist-next.example.test/resource' };
				response.destroy = vi.fn((error?: Error) => {
					if (error !== undefined) response.emit('error', error);
				});
				onResponse(response);
				response.emit('data', Buffer.from(`status-${statusCode}`));
				response.emit('end');
			});
			return request;
		},
	);
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
	mocks.httpRequest.mockReset();
	mocks.httpsRequest.mockReset();
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
		).toEqual(['create', 'get', 'getMany', 'update', 'upsert', 'delete']);
		const properties = createProperties();
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
		expect(properties[3]).toMatchObject({
			name: 'timeZoneMode',
			type: 'options',
			required: true,
			default: 'utc',
			options: [
				{ name: 'UTC', value: 'utc' },
				{ name: 'IANA', value: 'iana' },
			],
		});
		expect(properties[4]).toMatchObject({
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
			'startDate',
			'endDate',
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
		['302 response', 302],
		['307 response', 307],
		['404 response', 404],
	] as const)(
		'keeps the native anonymous adapter manual for a %s and binds its socket lookup',
		async (_label, statusCode) => {
			mockNativeResponse(statusCode);
			const secureLookup = vi.fn();
			const validateUrl = vi.fn().mockResolvedValue({ ok: true, value: undefined });
			await new CalDav().execute.call(
				context([parameters({ timeZoneMode: 'iana', timeZone: 'Europe/Prague' })], {
					secureEgressFilter: {
						validateUrl,
						createSecureLookup: vi.fn().mockReturnValue(secureLookup),
					},
				}),
			);
			const factoryInput = mocks.createCalendarEventTimeZoneExecutionContext.mock.calls[0]![0] as {
				readonly request: (
					input: unknown,
					binding: {
						readonly hostname: string;
						readonly address: string;
						readonly lookup: ReturnType<typeof vi.fn>;
					},
				) => Promise<{
					readonly statusCode: number;
					readonly headers: Readonly<Record<string, string>>;
					readonly body: Buffer;
				}>;
			};
			const response = await factoryInput.request(
				{
					method: 'GET',
					url: 'https://tzdist.example.test/resource',
				},
				{ hostname: 'tzdist.example.test', address: '93.184.216.34', lookup: vi.fn() },
			);
			expect(validateUrl).toHaveBeenCalledWith(
				expect.objectContaining({ href: 'https://tzdist.example.test/resource' }),
			);
			expect(mocks.httpsRequest).toHaveBeenCalledTimes(1);
			const [target, options] = mocks.httpsRequest.mock.calls[0]!;
			expect(target).toEqual(
				expect.objectContaining({ href: 'https://tzdist.example.test/resource' }),
			);
			expect(options).toMatchObject({
				method: 'GET',
				headers: { Host: 'tzdist.example.test' },
				servername: 'tzdist.example.test',
			});
			expect((options as { readonly lookup?: unknown }).lookup).toBe(secureLookup);
			expect(response).toMatchObject({
				statusCode,
				headers: { location: 'https://tzdist-next.example.test/resource' },
			});
			expect(response.body.toString()).toBe(`status-${statusCode}`);
		},
	);

	it('refuses anonymous adapter I/O without an approved connection binding', async () => {
		await new CalDav().execute.call(
			context([parameters({ timeZoneMode: 'iana', timeZone: 'Europe/Prague' })]),
		);
		const factoryInput = mocks.createCalendarEventTimeZoneExecutionContext.mock.calls[0]![0] as {
			readonly request: (input: unknown) => Promise<unknown>;
		};
		await expect(
			factoryInput.request({ method: 'GET', url: 'https://tzdist.example.test/resource' }),
		).rejects.toThrow('Anonymous time zone request failed');
		expect(mocks.httpsRequest).not.toHaveBeenCalled();
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
