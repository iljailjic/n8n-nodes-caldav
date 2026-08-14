import type { IExecuteFunctions, INode, INodeExecutionData } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	createN8nCalDavTransport: vi.fn(),
	getCalendarCollection: vi.fn(),
}));

vi.mock('../../nodes/CalDav/transport/http', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/transport/http')>()),
	createN8nCalDavTransport: mocks.createN8nCalDavTransport,
}));

vi.mock('../../nodes/CalDav/actions/calendar/get', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/actions/calendar/get')>()),
	getCalendarCollection: mocks.getCalendarCollection,
}));

import { CalDav } from '../../nodes/CalDav/CalDav.node';
import {
	CalDavCalendarCollectionGetError,
	CalendarCollectionGetFailureCode,
} from '../../nodes/CalDav/actions/calendar/get';
import {
	CalDavAuthenticationError,
	CalDavAuthorizationError,
	CalDavInvalidRedirectError,
	CalDavNetworkError,
	CalDavNotFoundError,
	CalDavResponseLimitError,
	CalDavTimeoutError,
	CalDavTlsError,
	CalDavUntrustedTargetError,
} from '../../nodes/CalDav/transport/http';

const NODE: INode = {
	id: 'calendar-get-node',
	name: 'CalDAV',
	type: 'calDav',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

const TRANSPORT = {
	serverUrl: 'https://configured.example.test/',
	request: vi.fn(),
};

const CALENDARS = [
	{
		url: 'https://calendar.example.test/one/',
		displayName: 'One',
		canRead: true,
		canWrite: true,
	},
	{
		url: 'https://calendar.example.test/two/',
		displayName: 'Two',
		canRead: true,
		canWrite: false,
	},
	{
		url: 'https://calendar.example.test/three/',
		canRead: null,
		canWrite: null,
	},
] as const;

interface ItemParameters {
	readonly resource: unknown;
	readonly operation: unknown;
	readonly calendar: unknown;
}

function locator(value: unknown, overrides: Record<string, unknown> = {}): unknown {
	return {
		__rl: true,
		mode: 'url',
		value,
		...overrides,
	};
}

function context(
	parameters: readonly ItemParameters[],
	options: {
		readonly continueOnFail?: boolean;
		readonly input?: INodeExecutionData[];
	} = {},
): IExecuteFunctions {
	const input =
		options.input ??
		parameters.map((_parameters, index) => ({ json: { inputSentinel: `input-${index}` } }));

	return {
		getInputData: vi.fn().mockReturnValue(input),
		getNodeParameter: vi.fn((name: keyof ItemParameters, index: number) => parameters[index][name]),
		getNode: vi.fn().mockReturnValue(NODE),
		continueOnFail: vi.fn().mockReturnValue(options.continueOnFail ?? false),
	} as unknown as IExecuteFunctions;
}

function itemParameters(
	calendar: unknown,
	resource: unknown = 'calendar',
	operation: unknown = 'get',
): ItemParameters {
	return { resource, operation, calendar };
}

async function captureExecutionError(executionContext: IExecuteFunctions): Promise<Error> {
	try {
		await new CalDav().execute.call(executionContext);
	} catch (error) {
		return error as Error;
	}
	throw new Error('Expected CalDAV execution to fail.');
}

beforeEach(() => {
	mocks.createN8nCalDavTransport.mockReset().mockResolvedValue(TRANSPORT);
	mocks.getCalendarCollection.mockReset();
	TRANSPORT.request.mockReset();
});

describe('CalDAV Calendar Get UI', () => {
	it('exposes Calendar/Get and Calendar/Get Many with operation-specific fields', () => {
		const node = new CalDav();

		expect(node.description).toMatchObject({
			name: 'calDav',
			version: 1,
			inputs: ['main'],
			outputs: ['main'],
			credentials: [{ name: 'calDavApi', required: true, testedBy: 'testCalDavApiCredentials' }],
		});
		expect(node.description.properties.map(({ name }) => name)).toEqual([
			'resource',
			'operation',
			'operation',
			'returnAll',
			'limit',
			'calendar',
			'start',
			'end',
			'returnAll',
			'limit',
			'identifierMode',
			'resourceUrl',
			'uid',
			'etag',
		]);
		const calendarProperties = node.description.properties.filter(
			(property) =>
				!['start', 'end', 'identifierMode', 'resourceUrl', 'uid', 'etag'].includes(property.name) &&
				(property.name !== 'returnAll' ||
					property.displayOptions?.show?.resource?.includes('calendar')) &&
				(property.name !== 'limit' ||
					property.displayOptions?.show?.resource?.includes('calendar')) &&
				(property.name !== 'operation' ||
					property.displayOptions?.show?.resource?.includes('calendar')),
		);
		expect(calendarProperties).toEqual([
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Calendar', value: 'calendar' },
					{ name: 'Event', value: 'event' },
				],
				default: 'calendar',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['calendar'] } },
				options: [
					{
						name: 'Get',
						value: 'get',
						description: expect.stringMatching(/retrieve.*calendar|get.*calendar/i),
						action: expect.stringMatching(/calendar/i),
					},
					{
						name: 'Get Many',
						value: 'getMany',
						description: expect.stringMatching(/accessible.*calendar|many.*calendar/i),
						action: expect.stringMatching(/many.*calendar/i),
					},
				],
				default: 'get',
			},
			{
				displayName: 'Return All',
				name: 'returnAll',
				type: 'boolean',
				default: false,
				description: expect.any(String),
				displayOptions: {
					show: { resource: ['calendar'], operation: ['getMany'] },
				},
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 50,
				description: expect.any(String),
				displayOptions: {
					show: {
						resource: ['calendar'],
						operation: ['getMany'],
						returnAll: [false],
					},
				},
			},
			{
				displayName: 'Calendar',
				name: 'calendar',
				type: 'resourceLocator',
				required: true,
				default: { mode: 'url', value: '' },
				displayOptions: {
					show: {
						resource: ['calendar', 'event'],
						operation: ['get', 'getMany', 'delete'],
					},
					hide: { resource: ['calendar'], operation: ['getMany'] },
				},
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						typeOptions: {
							searchListMethod: 'searchCalendars',
							searchable: true,
						},
					},
					{
						displayName: 'By URL',
						name: 'url',
						type: 'string',
						hint: expect.stringMatching(/absolute.*collection.*URL/i),
					},
				],
			},
		]);
		expect(node.methods).toHaveProperty('listSearch.searchCalendars', expect.any(Function));
	});

	it('keeps the locator additive without exposing unrelated operations', () => {
		const node = new CalDav();
		const operation = node.description.properties.find(
			({ name, displayOptions }) =>
				name === 'operation' && displayOptions?.show?.resource?.includes('calendar'),
		);

		expect(
			operation?.options?.map((option) => ('value' in option ? option.value : undefined)),
		).toEqual(['get', 'getMany']);
		expect(node.methods).toMatchObject({
			credentialTest: { testCalDavApiCredentials: expect.any(Function) },
			listSearch: { searchCalendars: expect.any(Function) },
		});
	});
});

describe('CalDAV Calendar Get execution', () => {
	it('reads all parameters per item and returns top-level paired calendar objects in order', async () => {
		mocks.getCalendarCollection
			.mockResolvedValueOnce(CALENDARS[0])
			.mockResolvedValueOnce(CALENDARS[1]);
		const executionContext = context([
			itemParameters(locator('https://calendar.example.test/one')),
			itemParameters(locator('https://calendar.example.test/two/')),
		]);

		await expect(new CalDav().execute.call(executionContext)).resolves.toEqual([
			[
				{ json: CALENDARS[0], pairedItem: { item: 0 } },
				{ json: CALENDARS[1], pairedItem: { item: 1 } },
			],
		]);
		expect(executionContext.getNodeParameter).toHaveBeenCalledTimes(6);
		expect(executionContext.getNodeParameter).toHaveBeenNthCalledWith(1, 'resource', 0);
		expect(executionContext.getNodeParameter).toHaveBeenNthCalledWith(2, 'operation', 0);
		expect(executionContext.getNodeParameter).toHaveBeenNthCalledWith(3, 'calendar', 0);
		expect(executionContext.getNodeParameter).toHaveBeenNthCalledWith(4, 'resource', 1);
		expect(executionContext.getNodeParameter).toHaveBeenNthCalledWith(5, 'operation', 1);
		expect(executionContext.getNodeParameter).toHaveBeenNthCalledWith(6, 'calendar', 1);
		expect(mocks.getCalendarCollection.mock.calls[0].slice(0, 2)).toEqual([
			TRANSPORT,
			'https://calendar.example.test/one/',
		]);
		expect(mocks.getCalendarCollection.mock.calls[1].slice(0, 2)).toEqual([
			TRANSPORT,
			'https://calendar.example.test/two/',
		]);
	});

	it('treats expression-resolved and literal locator values identically', async () => {
		mocks.getCalendarCollection.mockResolvedValue(CALENDARS[0]);
		const expressionSource = '={{ $json.privateExpressionSource }}';
		const executionContext = context(
			[
				itemParameters(locator('https://calendar.example.test/one')),
				itemParameters(locator('https://calendar.example.test/one')),
			],
			{
				input: [
					{ json: { literal: true } },
					{ json: { privateExpressionSource: expressionSource } },
				],
			},
		);

		const result = await new CalDav().execute.call(executionContext);

		expect(mocks.getCalendarCollection.mock.calls[0][1]).toBe(
			mocks.getCalendarCollection.mock.calls[1][1],
		);
		expect(JSON.stringify(mocks.getCalendarCollection.mock.calls)).not.toContain(expressionSource);
		expect(result[0].map(({ pairedItem }) => pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
	});

	it('treats list and URL locator values identically and ignores cached presentation fields', async () => {
		mocks.getCalendarCollection.mockResolvedValue(CALENDARS[0]);
		const canonicalValue = 'https://calendar.example.test/one';
		const executionContext = context([
			itemParameters(locator(canonicalValue)),
			itemParameters(
				locator(canonicalValue, {
					mode: 'list',
					cachedResultName: 'Private renamed calendar',
					cachedResultUrl: 'https://calendar.example.test/private-cached-url/',
				}),
			),
		]);

		const result = await new CalDav().execute.call(executionContext);

		expect(mocks.createN8nCalDavTransport).toHaveBeenCalledTimes(1);
		expect(mocks.getCalendarCollection).toHaveBeenCalledTimes(2);
		expect(mocks.getCalendarCollection.mock.calls.map((call) => call[1])).toEqual([
			'https://calendar.example.test/one/',
			'https://calendar.example.test/one/',
		]);
		expect(result).toEqual([
			[
				{ json: CALENDARS[0], pairedItem: { item: 0 } },
				{ json: CALENDARS[0], pairedItem: { item: 1 } },
			],
		]);
		expect(JSON.stringify(mocks.getCalendarCollection.mock.calls)).not.toMatch(
			/Private renamed calendar|private-cached-url/,
		);
	});

	it.each([
		['null locator', null],
		['array locator', []],
		['missing resource-locator marker', { mode: 'url', value: 'https://calendar.example.test/' }],
		['false resource-locator marker', locator('https://calendar.example.test/', { __rl: false })],
		['missing mode', locator('https://calendar.example.test/', { mode: undefined })],
		['unsupported mode', locator('https://calendar.example.test/', { mode: 'id' })],
		['empty value', locator('')],
		['empty list value', locator('', { mode: 'list' })],
		['non-string value', locator(123)],
		['relative URL', locator('/calendar/')],
		['relative list URL', locator('/calendar/', { mode: 'list' })],
		['non-HTTP URL', locator('ftp://calendar.example.test/')],
		['userinfo list URL', locator('https://user:secret@calendar.example.test/', { mode: 'list' })],
		['userinfo URL', locator('https://user:secret@calendar.example.test/')],
		['fragment URL', locator('https://calendar.example.test/#private')],
		['dot-segment URL', locator('https://calendar.example.test/a/../private/')],
		['control-character URL', locator('https://calendar.example.test/\nprivate/')],
		[
			'cached label without value',
			locator('', {
				cachedResultName: 'https://calendar.example.test/private-label/',
				cachedResultUrl: 'https://calendar.example.test/private-cached-url/',
			}),
		],
	] as const)('rejects %s before protocol coordination', async (_label, calendar) => {
		const error = await captureExecutionError(context([itemParameters(calendar)]));

		expect(error).toBeInstanceOf(NodeOperationError);
		expect(error.message).toMatch(/invalid.*calendar.*URL|calendar.*URL.*invalid/i);
		expect((error as NodeOperationError).context.itemIndex).toBe(0);
		expect(mocks.getCalendarCollection).not.toHaveBeenCalled();
		expect(String(error)).not.toContain('calendar.example.test');
		expect(String(error)).not.toContain('secret');
	});

	it.each([
		['unsupported resource', 'event', 'get'],
		['unsupported operation', 'calendar', 'fromList'],
	] as const)(
		'rejects %s instead of passing input through',
		async (_label, resource, operation) => {
			const error = await captureExecutionError(
				context([
					itemParameters(locator('https://calendar.example.test/one/'), resource, operation),
				]),
			);

			expect(error).toBeInstanceOf(NodeOperationError);
			expect(error.message).toMatch(/unsupported/i);
			expect((error as NodeOperationError).context.itemIndex).toBe(0);
			expect(mocks.getCalendarCollection).not.toHaveBeenCalled();
		},
	);
});

describe('CalDAV Calendar Get sanitized errors and continue-on-fail', () => {
	it.each(['url', 'list'] as const)(
		'preserves the same sanitized remote error for %s mode',
		async (mode) => {
			mocks.getCalendarCollection.mockRejectedValue(new CalDavAuthorizationError(403));
			const error = await captureExecutionError(
				context([
					itemParameters(
						locator('https://calendar.example.test/private/', {
							mode,
							cachedResultName: 'Private cached label',
						}),
					),
				]),
			);

			expect(error).toBeInstanceOf(NodeApiError);
			expect(error.message).toMatch(/authoriz|permission|forbidden/i);
			expect((error as NodeApiError).context.itemIndex).toBe(0);
			expect(String(error)).not.toMatch(/calendar\.example\.test|Private cached label/);
		},
	);

	it.each([
		[
			new CalDavCalendarCollectionGetError(CalendarCollectionGetFailureCode.NOT_CALENDAR),
			/not.*calendar/i,
		],
		[
			new CalDavCalendarCollectionGetError(CalendarCollectionGetFailureCode.VEVENT_UNSUPPORTED),
			/VEVENT.*not supported|does not support.*VEVENT/i,
		],
		[new CalDavAuthenticationError(401), /authentication/i],
		[new CalDavAuthorizationError(403), /authoriz|permission|forbidden/i],
		[new CalDavNotFoundError(404), /not found/i],
		[new CalDavTlsError(), /TLS/i],
		[new CalDavTimeoutError(), /timed out|timeout/i],
		[new CalDavResponseLimitError(), /response.*(limit|large)|size limit/i],
		[new CalDavUntrustedTargetError(), /untrusted/i],
		[new CalDavInvalidRedirectError(), /redirect/i],
		[new CalDavNetworkError(), /network|reached/i],
		[new Error('private-server-sentinel'), /calendar get.*failed|failed.*calendar get/i],
	] as const)(
		'maps a remote failure to an item-indexed sanitized NodeApiError',
		async (failure, message) => {
			mocks.getCalendarCollection.mockRejectedValue(failure);
			const error = await captureExecutionError(
				context([itemParameters(locator('https://calendar.example.test/private/'))]),
			);

			expect(error).toBeInstanceOf(NodeApiError);
			expect(error.message).toMatch(message);
			expect((error as NodeApiError).context.itemIndex).toBe(0);
			expect(String(error)).not.toContain('calendar.example.test');
			expect(String(error)).not.toContain('private-server-sentinel');
		},
	);

	it('stops on the first failed input when continue-on-fail is disabled', async () => {
		mocks.getCalendarCollection
			.mockResolvedValueOnce(CALENDARS[0])
			.mockRejectedValueOnce(new CalDavNotFoundError(404))
			.mockResolvedValueOnce(CALENDARS[2]);
		const executionContext = context(
			CALENDARS.map(({ url }) => itemParameters(locator(url))),
			{ continueOnFail: false },
		);

		const error = await captureExecutionError(executionContext);

		expect(error).toBeInstanceOf(NodeApiError);
		expect((error as NodeApiError).context.itemIndex).toBe(1);
		expect(mocks.getCalendarCollection).toHaveBeenCalledTimes(2);
	});

	it('emits success/error/success with exact pairing when continue-on-fail is enabled', async () => {
		mocks.getCalendarCollection
			.mockResolvedValueOnce(CALENDARS[0])
			.mockRejectedValueOnce(new Error('private-server-sentinel'))
			.mockResolvedValueOnce(CALENDARS[2]);
		const executionContext = context(
			CALENDARS.map(({ url }) => itemParameters(locator(url))),
			{ continueOnFail: true },
		);

		const [result] = await new CalDav().execute.call(executionContext);

		expect(result[0]).toEqual({ json: CALENDARS[0], pairedItem: { item: 0 } });
		expect(result[1]).toEqual({
			json: { error: expect.stringMatching(/calendar get.*failed|failed.*calendar get/i) },
			pairedItem: { item: 1 },
		});
		expect(result[2]).toEqual({ json: CALENDARS[2], pairedItem: { item: 2 } });
		expect(Object.keys(result[1].json)).toEqual(['error']);
		expect(JSON.stringify(result)).not.toContain('private-server-sentinel');
		expect(JSON.stringify(result)).not.toContain('inputSentinel');
		expect(mocks.getCalendarCollection).toHaveBeenCalledTimes(3);
	});
});
