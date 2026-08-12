import type { IExecuteFunctions, INode, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencyMocks = vi.hoisted(() => ({
	createTransport: vi.fn(),
	discoverPrincipal: vi.fn(),
	discoverHome: vi.fn(),
	discoverCollections: vi.fn(),
	selectProvider: vi.fn(),
}));

vi.mock('../../nodes/CalDav/transport/http', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../nodes/CalDav/transport/http')>();
	return { ...actual, createN8nCalDavTransport: dependencyMocks.createTransport };
});

vi.mock('../../nodes/CalDav/discovery/currentUserPrincipal', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../nodes/CalDav/discovery/currentUserPrincipal')>();
	return { ...actual, discoverCurrentUserPrincipal: dependencyMocks.discoverPrincipal };
});

vi.mock('../../nodes/CalDav/discovery/calendarHome', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../nodes/CalDav/discovery/calendarHome')>();
	return { ...actual, discoverCalendarHome: dependencyMocks.discoverHome };
});

vi.mock('../../nodes/CalDav/discovery/calendarCollections', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../nodes/CalDav/discovery/calendarCollections')>();
	return { ...actual, discoverCalendarCollections: dependencyMocks.discoverCollections };
});

vi.mock('../../nodes/CalDav/providers/registry', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../nodes/CalDav/providers/registry')>();
	return {
		...actual,
		defaultCalDavProviderRegistry: Object.freeze({ select: dependencyMocks.selectProvider }),
	};
});

import { CalDav } from '../../nodes/CalDav/CalDav.node';
import type { CalendarCollection } from '../../nodes/CalDav/discovery/calendarCollections';
import { CalDavResponseLimitError, type CalDavTransport } from '../../nodes/CalDav/transport/http';
import type { CalDavProviderAdapter } from '../../nodes/CalDav/providers/types';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';

const LIMIT_MESSAGE = 'Limit must be an integer greater than or equal to 1.';
const GENERIC_MESSAGE = 'The Calendar Get Many operation failed.';
const PRINCIPAL_URL = validateAbsoluteHttpUrl(
	'https://calendar.example.test/principals/account-private/',
);
const HOME_URL = validateAbsoluteHttpUrl(
	'https://partition.example.test/calendars/account-private/',
);

const provider: CalDavProviderAdapter = Object.freeze({
	id: 'synthetic',
	matchesConfiguredServerUrl: () => true,
	allowsCredentialForwarding: () => true,
});

const transport: CalDavTransport = Object.freeze({
	serverUrl: 'https://calendar.example.test/root/',
	request: vi.fn(),
});

interface ItemParameters {
	readonly resource: unknown;
	readonly operation: unknown;
	readonly returnAll: unknown;
	readonly limit?: unknown;
}

interface ContextOptions {
	readonly continueOnFail?: boolean;
	readonly credentials?: unknown;
	readonly requestHelper?: ReturnType<typeof vi.fn>;
	readonly onParameterRead?: (name: string, itemIndex: number) => void;
}

function workflowNode(): INode {
	return {
		id: 'caldav-get-many-test-node',
		name: 'CalDAV Get Many',
		type: 'CUSTOM.calDav',
		typeVersion: 1,
		position: [0, 0],
		parameters: {},
	};
}

function executionContext(
	parameters: readonly ItemParameters[],
	options: ContextOptions = {},
): IExecuteFunctions {
	const input = parameters.map((_, index) => ({ json: { input: index } }));
	return {
		getInputData: vi.fn().mockReturnValue(input),
		getNodeParameter: vi.fn((name: string, itemIndex: number) => {
			options.onParameterRead?.(name, itemIndex);
			return parameters[itemIndex][name as keyof ItemParameters];
		}),
		getCredentials: vi.fn().mockResolvedValue(options.credentials),
		continueOnFail: vi.fn().mockReturnValue(options.continueOnFail ?? false),
		getNode: vi.fn().mockReturnValue(workflowNode()),
		helpers: { httpRequestWithAuthentication: options.requestHelper ?? vi.fn() },
	} as unknown as IExecuteFunctions;
}

function defaultParameters(overrides: Partial<ItemParameters> = {}): ItemParameters {
	return {
		resource: 'calendar',
		operation: 'getMany',
		returnAll: true,
		...overrides,
	};
}

function collection(
	path: string,
	overrides: Omit<Partial<CalendarCollection>, 'url'> = {},
): CalendarCollection {
	return {
		url: validateAbsoluteHttpUrl(`https://partition.example.test${path}`),
		canRead: true,
		canWrite: true,
		...overrides,
	};
}

async function execute(context: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	return await new CalDav().execute.call(context);
}

function property(
	description: readonly INodeProperties[],
	name: string,
	resource?: string,
): INodeProperties {
	const result = description.find(
		(candidate) =>
			candidate.name === name &&
			(resource === undefined || candidate.displayOptions?.show?.resource?.includes(resource)),
	);
	if (result === undefined) throw new Error(`Missing node property ${name}.`);
	return result;
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error('Expected the operation to fail.');
}

beforeEach(() => {
	vi.clearAllMocks();
	dependencyMocks.createTransport.mockResolvedValue(transport);
	dependencyMocks.discoverPrincipal.mockResolvedValue({
		kind: 'authenticated',
		principalUrl: PRINCIPAL_URL,
	});
	dependencyMocks.discoverHome.mockResolvedValue({ calendarHomeUrl: HOME_URL });
	dependencyMocks.discoverCollections.mockResolvedValue([]);
	dependencyMocks.selectProvider.mockReturnValue(provider);
});

describe('Calendar Get Many node description', () => {
	it('exposes additive Calendar operations with conventional operation-specific fields', () => {
		const description = new CalDav().description.properties;
		expect(description.map(({ name }) => name)).toEqual([
			'resource',
			'operation',
			'operation',
			'returnAll',
			'limit',
			'calendar',
			'identifierMode',
			'resourceUrl',
			'uid',
		]);

		expect(property(description, 'resource')).toMatchObject({
			displayName: 'Resource',
			type: 'options',
			noDataExpression: true,
			default: 'calendar',
			options: [
				{ name: 'Calendar', value: 'calendar' },
				{ name: 'Event', value: 'event' },
			],
		});
		expect(property(description, 'operation', 'calendar')).toMatchObject({
			displayName: 'Operation',
			type: 'options',
			noDataExpression: true,
			default: 'get',
			displayOptions: { show: { resource: ['calendar'] } },
			options: [
				{ name: 'Get', value: 'get' },
				{ name: 'Get Many', value: 'getMany' },
			],
		});
		expect(property(description, 'returnAll')).toMatchObject({
			displayName: 'Return All',
			type: 'boolean',
			default: false,
			displayOptions: { show: { resource: ['calendar'], operation: ['getMany'] } },
		});
		expect(property(description, 'limit')).toMatchObject({
			displayName: 'Limit',
			type: 'number',
			default: 50,
			typeOptions: { minValue: 1 },
			displayOptions: {
				show: { resource: ['calendar'], operation: ['getMany'], returnAll: [false] },
			},
		});
		expect(property(description, 'limit').typeOptions).not.toHaveProperty('maxValue');
		expect(property(description, 'calendar')).toMatchObject({
			displayName: 'Calendar',
			type: 'resourceLocator',
			required: true,
			default: { mode: 'url', value: '' },
			displayOptions: { show: { resource: ['calendar', 'event'], operation: ['get'] } },
			modes: [
				{
					displayName: 'From List',
					name: 'list',
					type: 'list',
					typeOptions: { searchListMethod: 'searchCalendars', searchable: true },
				},
				{ displayName: 'By URL', name: 'url', type: 'string' },
			],
		});
		expect(new CalDav().methods).toHaveProperty('listSearch.searchCalendars', expect.any(Function));
	});
});

describe('Calendar Get Many successful execution', () => {
	it('uses exact ordinal display-name and canonical-URL ordering independent of server order', async () => {
		const expected = [
			collection('/empty/', { displayName: '' }),
			collection('/missing/', {}),
			collection('/alpha-a/', { displayName: 'Alpha' }),
			collection('/alpha-z/', { displayName: 'Alpha' }),
			collection('/lower/', { displayName: 'alpha' }),
			collection('/private-use/', { displayName: '\uE000' }),
			collection('/supplementary/', { displayName: '😀' }),
		];
		const serverOrders = [
			[expected[6], expected[3], expected[0], expected[4], expected[1], expected[2], expected[5]],
			[expected[5], expected[2], expected[1], expected[4], expected[0], expected[3], expected[6]],
		];

		for (const serverOrder of serverOrders) {
			dependencyMocks.discoverCollections.mockResolvedValueOnce(serverOrder);
			const [output] = await execute(executionContext([defaultParameters()]));
			expect(output).toEqual(expected.map((json) => ({ json, pairedItem: { item: 0 } })));
		}
	});

	it('sorts the full normalized result before applying active Limit', async () => {
		dependencyMocks.discoverCollections.mockResolvedValue([
			collection('/zulu/', { displayName: 'Zulu' }),
			collection('/alpha-z/', { displayName: 'Alpha' }),
			collection('/alpha-a/', { displayName: 'Alpha' }),
		]);

		const [output] = await execute(
			executionContext([defaultParameters({ returnAll: false, limit: 2 })]),
		);
		expect(output).toEqual([
			{ json: collection('/alpha-a/', { displayName: 'Alpha' }), pairedItem: { item: 0 } },
			{ json: collection('/alpha-z/', { displayName: 'Alpha' }), pairedItem: { item: 0 } },
		]);
	});

	it('does not read or validate a stale hidden Limit when Return All is true', async () => {
		const alpha = collection('/alpha/', { displayName: 'Alpha' });
		dependencyMocks.discoverCollections.mockResolvedValue([alpha]);
		const context = executionContext([defaultParameters({ limit: 0 })], {
			onParameterRead(name) {
				if (name === 'limit') throw new Error('The hidden Limit parameter was read.');
			},
		});

		await expect(execute(context)).resolves.toEqual([[{ json: alpha, pairedItem: { item: 0 } }]]);
		expect(context.getNodeParameter).not.toHaveBeenCalledWith('limit', 0);
	});

	it('emits no synthetic item for empty homes and keeps successful input groups paired', async () => {
		const zeroB = collection('/zero-b/', { displayName: 'B' });
		const zeroA = collection('/zero-a/', { displayName: 'A' });
		const one = collection('/one/', { displayName: 'Only' });
		dependencyMocks.discoverCollections
			.mockResolvedValueOnce([zeroB, zeroA])
			.mockResolvedValueOnce([one])
			.mockResolvedValueOnce([]);

		const [output] = await execute(
			executionContext([defaultParameters(), defaultParameters(), defaultParameters()]),
		);
		expect(output).toEqual([
			{ json: zeroA, pairedItem: { item: 0 } },
			{ json: zeroB, pairedItem: { item: 0 } },
			{ json: one, pairedItem: { item: 1 } },
		]);
	});

	it('preserves the provider-neutral collection payload without filling missing optionals', async () => {
		const full = collection('/full/', {
			displayName: '',
			description: 'Synthetic description',
			timezone: 'BEGIN:VCALENDAR\nEND:VCALENDAR',
			color: '#123456FF',
			supportedComponents: Object.freeze(['VEVENT', 'VTODO']),
			canRead: null,
			canWrite: false,
			extensions: Object.freeze({
				icloud: Object.freeze({ order: 7, enabled: true }),
			}),
		});
		const minimal = collection('/minimal/', { canRead: null, canWrite: null });
		dependencyMocks.discoverCollections.mockResolvedValue([minimal, full]);

		const [output] = await execute(executionContext([defaultParameters()]));
		expect(output).toEqual([
			{ json: full, pairedItem: { item: 0 } },
			{ json: minimal, pairedItem: { item: 0 } },
		]);
		expect(output[1].json).not.toHaveProperty('displayName');
	});

	it('coordinates shared discovery in order with one transport and selected provider per input', async () => {
		const result = collection('/result/', { displayName: 'Result' });
		dependencyMocks.discoverCollections.mockResolvedValue([result]);

		await execute(executionContext([defaultParameters()]));

		expect(dependencyMocks.createTransport).toHaveBeenCalledTimes(1);
		expect(dependencyMocks.createTransport).toHaveBeenCalledWith(expect.any(Object));
		expect(dependencyMocks.discoverPrincipal).toHaveBeenCalledWith(transport);
		expect(dependencyMocks.discoverHome).toHaveBeenCalledWith(transport, PRINCIPAL_URL);
		expect(dependencyMocks.selectProvider).toHaveBeenCalledWith(
			validateAbsoluteHttpUrl(transport.serverUrl),
		);
		expect(dependencyMocks.discoverCollections).toHaveBeenCalledWith(transport, HOME_URL, provider);
		expect(dependencyMocks.discoverPrincipal.mock.invocationCallOrder[0]).toBeLessThan(
			dependencyMocks.discoverHome.mock.invocationCallOrder[0],
		);
		expect(dependencyMocks.discoverHome.mock.invocationCallOrder[0]).toBeLessThan(
			dependencyMocks.selectProvider.mock.invocationCallOrder[0],
		);
		expect(dependencyMocks.selectProvider.mock.invocationCallOrder[0]).toBeLessThan(
			dependencyMocks.discoverCollections.mock.invocationCallOrder[0],
		);
		expect(transport.request).not.toHaveBeenCalled();
	});
});

describe('Calendar Get Many validation and dispatch', () => {
	it.each([0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null])(
		'rejects active Limit %j as an item-indexed operation error',
		async (limit) => {
			const error = await captureError(
				execute(executionContext([defaultParameters({ returnAll: false, limit })])),
			);
			expect(error).toBeInstanceOf(NodeOperationError);
			expect(error).toMatchObject({ message: LIMIT_MESSAGE, context: { itemIndex: 0 } });
			expect(dependencyMocks.createTransport).not.toHaveBeenCalled();
		},
	);

	it('accepts active Limit 1', async () => {
		const first = collection('/first/', { displayName: 'First' });
		dependencyMocks.discoverCollections.mockResolvedValue([
			collection('/second/', { displayName: 'Second' }),
			first,
		]);

		await expect(
			execute(executionContext([defaultParameters({ returnAll: false, limit: 1 })])),
		).resolves.toEqual([[{ json: first, pairedItem: { item: 0 } }]]);
	});

	it.each([
		['calendar', 'getEvents'],
		['event', 'getMany'],
		['calendar', 'fromList'],
	] as const)(
		'rejects unsupported dispatch %s/%s without discovery',
		async (resource, operation) => {
			const error = await captureError(
				execute(executionContext([defaultParameters({ resource, operation })])),
			);
			expect(error).toBeInstanceOf(NodeOperationError);
			expect(error).toMatchObject({ context: { itemIndex: 0 } });
			expect(dependencyMocks.createTransport).not.toHaveBeenCalled();
			expect(dependencyMocks.discoverCollections).not.toHaveBeenCalled();
		},
	);
});

describe('Calendar Get Many safe failure behavior', () => {
	it.each([false, true])(
		'exposes only the safe stored-URL category with continueOnFail=%s and makes no request',
		async (continueOnFail) => {
			const actualTransportModule = await vi.importActual<
				typeof import('../../nodes/CalDav/transport/http')
			>('../../nodes/CalDav/transport/http');
			dependencyMocks.createTransport.mockImplementation(
				async (context: IExecuteFunctions) =>
					await actualTransportModule.createN8nCalDavTransport(context),
			);
			const requestHelper = vi.fn();
			const context = executionContext([defaultParameters()], {
				continueOnFail,
				credentials: {
					serverUrl: 'https://url-user:url-password@calendar.example.test/private-account-path/',
					username: 'username-sentinel',
					password: 'password-sentinel',
				},
				requestHelper,
			});

			if (continueOnFail) {
				await expect(execute(context)).resolves.toEqual([
					[{ json: { error: 'The URL is malformed.' }, pairedItem: { item: 0 } }],
				]);
			} else {
				const error = await captureError(execute(context));
				expect(error).toBeInstanceOf(NodeApiError);
				expect(error).toMatchObject({
					message: 'The URL is malformed.',
					context: { itemIndex: 0 },
				});
				expect(JSON.stringify(error)).not.toMatch(
					/url-user|url-password|private-account-path|username-sentinel|password-sentinel/,
				);
			}

			expect(context.getCredentials).toHaveBeenCalledWith('calDavApi');
			expect(requestHelper).not.toHaveBeenCalled();
			expect(dependencyMocks.discoverPrincipal).not.toHaveBeenCalled();
		},
	);

	it.each([
		[
			'unauthenticated',
			{
				kind: 'unauthenticated',
				code: 'CURRENT_USER_PRINCIPAL_UNAUTHENTICATED',
				message: 'The CalDAV server did not authenticate the current user.',
			},
			'The CalDAV server did not authenticate the current user.',
		],
		[
			'unavailable',
			{
				kind: 'unavailable',
				code: 'CURRENT_USER_PRINCIPAL_UNAVAILABLE',
				message: 'The CalDAV current-user principal is unavailable.',
			},
			'The CalDAV current-user principal is unavailable.',
		],
	] as const)(
		'maps a safe %s principal outcome without continuing discovery',
		async (_kind, outcome, message) => {
			dependencyMocks.discoverPrincipal.mockResolvedValue(outcome);

			await expect(
				execute(executionContext([defaultParameters()], { continueOnFail: true })),
			).resolves.toEqual([[{ json: { error: message }, pairedItem: { item: 0 } }]]);
			expect(dependencyMocks.discoverHome).not.toHaveBeenCalled();
			expect(dependencyMocks.discoverCollections).not.toHaveBeenCalled();
		},
	);

	it('continues per input with one sanitized failure item and no mixed pairings', async () => {
		const zeroB = collection('/zero-b/', { displayName: 'B' });
		const zeroA = collection('/zero-a/', { displayName: 'A' });
		const two = collection('/two/', { displayName: 'Two' });
		dependencyMocks.discoverPrincipal
			.mockResolvedValueOnce({ kind: 'authenticated', principalUrl: PRINCIPAL_URL })
			.mockResolvedValueOnce({
				kind: 'unauthenticated',
				code: 'CURRENT_USER_PRINCIPAL_UNAUTHENTICATED',
				message: 'The CalDAV server did not authenticate the current user.',
			})
			.mockResolvedValueOnce({ kind: 'authenticated', principalUrl: PRINCIPAL_URL });
		dependencyMocks.discoverCollections
			.mockResolvedValueOnce([zeroB, zeroA])
			.mockResolvedValueOnce([two]);

		const [output] = await execute(
			executionContext([defaultParameters(), defaultParameters(), defaultParameters()], {
				continueOnFail: true,
			}),
		);
		expect(output).toEqual([
			{ json: zeroA, pairedItem: { item: 0 } },
			{ json: zeroB, pairedItem: { item: 0 } },
			{
				json: { error: 'The CalDAV server did not authenticate the current user.' },
				pairedItem: { item: 1 },
			},
			{ json: two, pairedItem: { item: 2 } },
		]);
		expect(dependencyMocks.discoverHome).toHaveBeenCalledTimes(2);
		expect(dependencyMocks.discoverCollections).toHaveBeenCalledTimes(2);
	});

	it('stops at the first failure when continueOnFail is false', async () => {
		const privateFailure = Object.assign(new Error('private-body-sentinel'), {
			response: { body: 'private-calendar-data', url: 'https://p99.example.test/private/' },
		});
		dependencyMocks.discoverPrincipal
			.mockResolvedValueOnce({ kind: 'authenticated', principalUrl: PRINCIPAL_URL })
			.mockRejectedValueOnce(privateFailure)
			.mockResolvedValueOnce({ kind: 'authenticated', principalUrl: PRINCIPAL_URL });
		dependencyMocks.discoverCollections.mockResolvedValueOnce([]);

		const error = await captureError(
			execute(executionContext([defaultParameters(), defaultParameters(), defaultParameters()])),
		);
		expect(error).toBeInstanceOf(NodeApiError);
		expect(error).toMatchObject({ message: GENERIC_MESSAGE, context: { itemIndex: 1 } });
		expect(JSON.stringify(error)).not.toMatch(
			/private-body-sentinel|private-calendar-data|p99|account-private|partition/i,
		);
		expect(dependencyMocks.createTransport).toHaveBeenCalledTimes(2);
		expect(dependencyMocks.discoverPrincipal).toHaveBeenCalledTimes(2);
	});

	it('preserves only allowlisted domain messages in continue-on-fail output', async () => {
		dependencyMocks.discoverCollections.mockRejectedValue(
			Object.assign(new CalDavResponseLimitError(), {
				privateBody: 'private-body-sentinel',
				privateUrl: 'https://partition.example.test/private-path/',
			}),
		);

		const [output] = await execute(
			executionContext([defaultParameters({ returnAll: false, limit: 1 })], {
				continueOnFail: true,
			}),
		);
		expect(output).toEqual([
			{
				json: { error: 'The CalDAV response exceeded the 10 MiB size limit.' },
				pairedItem: { item: 0 },
			},
		]);
		expect(JSON.stringify(output)).not.toMatch(/private-body-sentinel|private-path|partition/i);
	});

	it.each(['principal', 'home', 'collections'] as const)(
		'keeps the 10 MiB response guard authoritative at the %s stage with Limit 1',
		async (stage) => {
			if (stage === 'principal') {
				dependencyMocks.discoverPrincipal.mockRejectedValue(new CalDavResponseLimitError());
			} else if (stage === 'home') {
				dependencyMocks.discoverHome.mockRejectedValue(new CalDavResponseLimitError());
			} else {
				dependencyMocks.discoverCollections.mockRejectedValue(new CalDavResponseLimitError());
			}

			const error = await captureError(
				execute(executionContext([defaultParameters({ returnAll: false, limit: 1 })])),
			);
			expect(error).toBeInstanceOf(NodeApiError);
			expect(error).toMatchObject({
				message: 'The CalDAV response exceeded the 10 MiB size limit.',
				context: { itemIndex: 0 },
			});
			expect(dependencyMocks.discoverPrincipal).toHaveBeenCalledTimes(1);
			expect(dependencyMocks.discoverHome).toHaveBeenCalledTimes(stage === 'principal' ? 0 : 1);
			expect(dependencyMocks.discoverCollections).toHaveBeenCalledTimes(
				stage === 'collections' ? 1 : 0,
			);
		},
	);

	it('uses the generic sanitized message for unknown continue-on-fail errors', async () => {
		const privateError = Object.assign(new Error('password-sentinel private stack'), {
			body: '<calendar-description>Private calendar</calendar-description>',
			href: '/account-private/calendar-private/',
		});
		dependencyMocks.discoverHome.mockRejectedValue(privateError);

		const [output] = await execute(
			executionContext([defaultParameters()], { continueOnFail: true }),
		);
		expect(output).toEqual([{ json: { error: GENERIC_MESSAGE }, pairedItem: { item: 0 } }]);
		expect(JSON.stringify(output)).not.toMatch(
			/password-sentinel|Private calendar|account-private/i,
		);
	});
});
