import type { IExecuteFunctions, INode, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	createCalendarEvent: vi.fn(),
	createN8nCalDavTransport: vi.fn(),
}));

vi.mock('../../nodes/CalDav/events/create', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/events/create')>()),
	createCalendarEvent: mocks.createCalendarEvent,
}));

vi.mock('../../nodes/CalDav/transport/http', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/transport/http')>()),
	createN8nCalDavTransport: mocks.createN8nCalDavTransport,
}));

import { CalDav } from '../../nodes/CalDav/CalDav.node';
import { resolveCalendarEventTimeZoneAuthoring } from '../../nodes/CalDav/events/timeZoneAuthoring';
import {
	CalDavCalendarEventCreateError,
	CalendarEventCreateFailureCode,
} from '../../nodes/CalDav/events/create';
import {
	CalDavCalendarEventMutationError,
	CalendarEventMutationFailureCode,
} from '../../nodes/CalDav/events/mutations';
import {
	CalDavICalendarSerializeError,
	CalDavICalendarSerializeErrorCode,
} from '../../nodes/CalDav/icalendar/serializer';
import {
	CalDavAuthenticationError,
	CalDavAuthorizationError,
	CalDavNetworkError,
	CalDavNotFoundError,
	CalDavResponseLimitError,
	CalDavTimeoutError,
	CalDavTlsError,
} from '../../nodes/CalDav/transport/http';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';
import { canonicalizeIanaTimeZone } from '../../nodes/CalDav/icalendar/timeZones';

const NODE: INode = {
	id: 'event-create-node',
	name: 'CalDAV Event Create',
	type: 'calDav',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

const TRANSPORT = {
	serverUrl: 'https://calendar.example.test/',
	request: vi.fn(),
};

interface EventCreateParameters {
	readonly resource: unknown;
	readonly operation: unknown;
	readonly calendar: unknown;
	readonly uid: unknown;
	readonly timeMode: unknown;
	readonly start: unknown;
	readonly end: unknown;
	readonly startDate?: unknown;
	readonly endDate?: unknown;
	readonly summary: unknown;
	readonly additionalFields: unknown;
}

function locator(value: unknown, mode: unknown = 'url'): unknown {
	return { __rl: true, mode, value };
}

function parameters(overrides: Partial<EventCreateParameters> = {}): EventCreateParameters {
	return {
		resource: 'event',
		operation: 'create',
		calendar: locator('https://calendar.example.test/calendars/work'),
		uid: 'opaque UID 🚀',
		timeMode: 'timed',
		start: '2040-01-02T10:00:00+01:00',
		end: '2040-01-02T11:00:00+01:00',
		summary: 'Meeting',
		additionalFields: {},
		...overrides,
	};
}

function context(
	itemParameters: readonly EventCreateParameters[],
	options: { readonly continueOnFail?: boolean; readonly input?: INodeExecutionData[] } = {},
): IExecuteFunctions {
	return {
		getInputData: vi
			.fn()
			.mockReturnValue(
				options.input ?? itemParameters.map((_item, index) => ({ json: { item: index } })),
			),
		getNodeParameter: vi.fn((name: keyof EventCreateParameters, index: number) =>
			Reflect.get(itemParameters[index], name),
		),
		getNode: vi.fn().mockReturnValue(NODE),
		continueOnFail: vi.fn().mockReturnValue(options.continueOnFail ?? false),
	} as unknown as IExecuteFunctions;
}

function created(uid: string, optional: Record<string, unknown> = {}) {
	return {
		calendarUrl: validateAbsoluteHttpUrl('https://calendar.example.test/calendars/work/'),
		resourceUrl: validateAbsoluteHttpUrl(
			`https://calendar.example.test/calendars/work/${Buffer.from(uid).toString('base64url')}.ics`,
		),
		etag: '"created-etag"',
		uid,
		summary: 'Meeting',
		...optional,
		timeMode: 'timed',
		accessMode: 'editable',
		start: '2040-01-02T09:00:00Z',
		end: '2040-01-02T10:00:00Z',
	};
}

function createProperties(): readonly INodeProperties[] {
	return new CalDav().description.properties.filter((candidate) => {
		const show = candidate.displayOptions?.show;
		return (
			candidate.name === 'calendar' ||
			(show?.resource?.includes('event') === true && show.operation?.includes('create') === true)
		);
	});
}

async function captureError(executionContext: IExecuteFunctions): Promise<Error> {
	try {
		await new CalDav().execute.call(executionContext);
	} catch (error) {
		return error as Error;
	}
	throw new Error('Expected Event Create execution to fail.');
}

async function authoringFailure(
	code: 'UNBOUNDED_REQUIRES_REFERENCE' | 'UNREPRESENTABLE_TIME_ZONE',
): Promise<unknown> {
	const coverage =
		code === 'UNBOUNDED_REQUIRES_REFERENCE'
			? ({ kind: 'unbounded' } as const)
			: ({
					kind: 'finite',
					interval: {
						start: new Date('0001-01-01T00:00:00Z'),
						end: new Date('9999-12-31T23:59:59Z'),
					},
				} as const);
	return await resolveCalendarEventTimeZoneAuthoring({
		calendarUrl: validateAbsoluteHttpUrl('https://calendar.example.test/calendars/work/'),
		timeZone: canonicalizeIanaTimeZone('Europe/Prague'),
		coverage,
	}).catch((error: unknown) => error);
}

beforeEach(() => {
	mocks.createN8nCalDavTransport.mockReset().mockResolvedValue(TRANSPORT);
	mocks.createCalendarEvent.mockReset().mockImplementation(async (_transport, input) =>
		created(input.uid, {
			...(input.description === undefined ? {} : { description: input.description }),
			...(input.location === undefined ? {} : { location: input.location }),
			...(input.url === undefined ? {} : { url: input.url }),
			...(input.categories === undefined ? {} : { categories: input.categories }),
			...(input.status === undefined ? {} : { status: input.status }),
			...(input.transparency === undefined ? {} : { transparency: input.transparency }),
		}),
	);
	TRANSPORT.request.mockReset();
});

describe('CalDAV Event Create metadata', () => {
	it('adds the exact Create descriptor before existing operations and preserves the default', () => {
		const operation = new CalDav().description.properties.find(
			(candidate) =>
				candidate.name === 'operation' &&
				candidate.displayOptions?.show?.resource?.includes('event'),
		);
		expect(operation).toMatchObject({
			displayName: 'Operation',
			name: 'operation',
			type: 'options',
			noDataExpression: true,
			options: [
				{
					name: 'Create',
					value: 'create',
					description: 'Create a calendar event',
					action: 'Create a calendar event',
				},
				{
					name: 'Get',
					value: 'get',
					description: 'Retrieve a calendar event',
					action: 'Retrieve a calendar event',
				},
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
			default: 'get',
		});
	});

	it('exposes optional UID help, explicit time mode, and both mode-specific time pairs', () => {
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
		const uid = properties[1];
		expect(uid).toMatchObject({ name: 'uid', type: 'string', default: '' });
		expect(uid).not.toHaveProperty('required');
		expect(uid?.description).toContain('blank');
		expect(uid?.description).toContain('generated UUID');
		expect(uid?.description).toContain('Each separate Create');
		expect(
			properties.slice(2, 10).map(({ name, type, required, default: defaultValue }) => ({
				name,
				type,
				required,
				default: defaultValue,
			})),
		).toEqual([
			{ name: 'timeMode', type: 'options', required: true, default: 'timed' },
			{ name: 'timeZoneMode', type: 'options', required: true, default: 'utc' },
			{ name: 'timeZone', type: 'options', required: true, default: '' },
			{ name: 'start', type: 'dateTime', required: true, default: '' },
			{ name: 'end', type: 'dateTime', required: true, default: '' },
			{ name: 'startDate', type: 'dateTime', required: true, default: '' },
			{ name: 'endDate', type: 'dateTime', required: true, default: '' },
			{ name: 'summary', type: 'string', required: true, default: '' },
		]);
		const additional = properties[10];
		expect(additional).toMatchObject({
			name: 'additionalFields',
			type: 'collection',
			placeholder: 'Add Field',
			default: {},
		});
		expect(additional?.options?.map(({ name }) => name)).toEqual([
			'alarms',
			'categories',
			'description',
			'location',
			'status',
			'transparency',
			'url',
		]);
		const categories = additional?.options?.find(({ name }) => name === 'categories');
		expect(categories).toMatchObject({
			type: 'fixedCollection',
			typeOptions: { multipleValues: true },
			default: {},
			options: [
				{
					name: 'category',
					values: [{ name: 'value', type: 'string', default: '' }],
				},
			],
		});
		for (const [name, values] of [
			['status', ['tentative', 'confirmed', 'cancelled']],
			['transparency', ['opaque', 'transparent']],
		] as const) {
			const field = additional?.options?.find((option) => option.name === name);
			expect(field).toMatchObject({ type: 'options', default: '' });
			expect(field?.options?.map((option) => option.value)).toEqual(values);
		}
		expect(additional?.options?.find(({ name }) => name === 'description')).toMatchObject({
			typeOptions: { rows: 4 },
		});
	});
});

describe('CalDAV Event Create input and output mapping', () => {
	it('normalizes offset, Date, and Luxon expression families to copied whole-second UTC Dates', async () => {
		const startDate = new Date('2040-01-03T12:00:00Z');
		const luxonEndDate = new Date('2040-01-03T13:00:00Z');
		const luxonEnd = {
			isLuxonDateTime: true,
			isValid: true,
			toJSDate: vi.fn(() => luxonEndDate),
		};
		const execution = context([
			parameters({
				uid: 'first',
				additionalFields: {
					description: '',
					location: ' Office ',
					url: 'urn:test:first',
					categories: {
						category: [
							{ value: 'Planning, review' },
							{ value: '  ' },
							{ value: 'Planning, review' },
						],
					},
					status: 'cancelled',
					transparency: 'transparent',
				},
			}),
			parameters({ uid: 'second', start: startDate, end: luxonEnd }),
		]);

		const [output] = await new CalDav().execute.call(execution);
		expect(output).toEqual([
			{
				json: created('first', {
					description: '',
					location: ' Office ',
					url: 'urn:test:first',
					categories: ['Planning, review', '  '],
					status: 'cancelled',
					transparency: 'transparent',
				}),
				pairedItem: { item: 0 },
			},
			{
				json: { ...created('second'), start: '2040-01-02T09:00:00Z', end: '2040-01-02T10:00:00Z' },
				pairedItem: { item: 1 },
			},
		]);
		expect(mocks.createCalendarEvent).toHaveBeenCalledTimes(2);
		const firstInput = mocks.createCalendarEvent.mock.calls[0]?.[1];
		expect(firstInput).toMatchObject({
			calendarUrl: 'https://calendar.example.test/calendars/work/',
			uid: 'first',
			start: new Date('2040-01-02T09:00:00Z'),
			end: new Date('2040-01-02T10:00:00Z'),
			summary: 'Meeting',
			description: '',
			location: ' Office ',
			url: 'urn:test:first',
			categories: ['Planning, review', '  '],
			status: 'cancelled',
			transparency: 'transparent',
		});
		const secondInput = mocks.createCalendarEvent.mock.calls[1]?.[1];
		expect(secondInput.start).toEqual(startDate);
		expect(secondInput.start).not.toBe(startDate);
		expect(secondInput.end).toEqual(luxonEndDate);
		expect(secondInput.end).not.toBe(luxonEndDate);
		expect(secondInput).not.toHaveProperty('description');
		expect(luxonEnd.toJSDate).toHaveBeenCalledTimes(1);
		expect(typeof mocks.createCalendarEvent.mock.calls[0]?.[2]).toBe('function');
	});

	it('preserves empty/whitespace text and omits only absent optional keys', async () => {
		await new CalDav().execute.call(
			context([
				parameters({
					uid: '  opaque  ',
					summary: '   ',
					additionalFields: { description: '', location: '' },
				}),
			]),
		);
		expect(mocks.createCalendarEvent.mock.calls[0]?.[1]).toMatchObject({
			uid: '  opaque  ',
			summary: '   ',
			description: '',
			location: '',
		});
		expect(mocks.createCalendarEvent.mock.calls[0]?.[1]).not.toHaveProperty('url');
	});

	it('converts blank UID to omission and preserves generated output pairing for multiple items', async () => {
		const generated = [
			'00000000-0000-4000-8000-000000000001',
			'00000000-0000-4000-8000-000000000002',
			'00000000-0000-4000-8000-000000000003',
		];
		for (const uid of generated) mocks.createCalendarEvent.mockResolvedValueOnce(created(uid));

		const [output] = await new CalDav().execute.call(
			context([parameters({ uid: '' }), parameters({ uid: '' }), parameters({ uid: '' })]),
		);

		expect(output).toEqual(
			generated.map((uid, item) => ({ json: created(uid), pairedItem: { item } })),
		);
		expect(mocks.createCalendarEvent).toHaveBeenCalledTimes(3);
		for (const call of mocks.createCalendarEvent.mock.calls) {
			expect(call[1]).not.toHaveProperty('uid');
		}
	});
});

describe('CalDAV Event Create deterministic validation', () => {
	it.each([
		[
			'Calendar',
			{ calendar: locator('https://user:secret@calendar.example.test/work') },
			'The Calendar URL is invalid. Enter an absolute HTTP(S) calendar collection URL.',
		],
		['UID type', { uid: 12 }, 'UID must be a non-empty valid iCalendar text value.'],
		[
			'UID Unicode',
			{ uid: '\ud800private' },
			'UID must be a non-empty valid iCalendar text value.',
		],
		[
			'UID carriage return',
			{ uid: 'private\ruid' },
			'UID must be a non-empty valid iCalendar text value.',
		],
		['UID DEL', { uid: 'private\u007fuid' }, 'UID must be a non-empty valid iCalendar text value.'],
		[
			'resource overflow',
			{ uid: 'a'.repeat(189) },
			'UID is too long to create a safe event resource name.',
		],
		[
			'Start timezone',
			{ start: '2040-01-02T10:00:00' },
			'Start must be a valid date and time with whole-second precision.',
		],
		[
			'Start fraction',
			{ start: '2040-01-02T10:00:00.001Z' },
			'Start must be a valid date and time with whole-second precision.',
		],
		[
			'End invalid',
			{ end: new Date(Number.NaN) },
			'End must be a valid date and time with whole-second precision.',
		],
		['Summary', { summary: '\u0000private' }, 'Summary must be a valid iCalendar text value.'],
		['Additional null', { additionalFields: null }, 'Additional Fields must be an object.'],
		['Additional array', { additionalFields: [] }, 'Additional Fields must be an object.'],
		[
			'Additional unknown',
			{ additionalFields: { privateKey: 'private' } },
			'Additional Fields must be an object.',
		],
		[
			'Description',
			{ additionalFields: { description: undefined } },
			'Description must be a valid iCalendar text value.',
		],
		[
			'Location',
			{ additionalFields: { location: 4 } },
			'Location must be a valid iCalendar text value.',
		],
		[
			'URL empty',
			{ additionalFields: { url: '' } },
			'URL must be a valid absolute URI without a fragment.',
		],
		[
			'URL fragment',
			{ additionalFields: { url: 'https://example.test/private#fragment' } },
			'URL must be a valid absolute URI without a fragment.',
		],
		[
			'Categories empty list',
			{ additionalFields: { categories: { category: [] } } },
			'Categories must be a non-empty list of valid iCalendar text values.',
		],
		[
			'Categories empty value',
			{ additionalFields: { categories: { category: [{ value: 'private' }, { value: '' }] } } },
			'Categories must be a non-empty list of valid iCalendar text values.',
		],
		[
			'Status uppercase',
			{ additionalFields: { status: 'CONFIRMED' } },
			'Status must be Tentative, Confirmed, or Cancelled.',
		],
		[
			'Transparency unsupported',
			{ additionalFields: { transparency: 'private' } },
			'Transparency must be Opaque or Transparent.',
		],
		['range', { end: '2040-01-02T10:00:00+01:00' }, 'End must be later than Start.'],
	] as const)('rejects %s before transport/coordinator I/O', async (_label, overrides, message) => {
		const error = await captureError(context([parameters(overrides)]));
		expect(error).toBeInstanceOf(NodeOperationError);
		expect(error).toMatchObject({ message, context: { itemIndex: 0 } });
		expect(mocks.createN8nCalDavTransport).not.toHaveBeenCalled();
		expect(mocks.createCalendarEvent).not.toHaveBeenCalled();
		expect(String(error)).not.toMatch(/secret|privateKey|example\.test\/private/);
	});

	it('uses the exact precedence when several fields are invalid', async () => {
		const error = await captureError(
			context([
				parameters({
					uid: 'a'.repeat(189),
					start: 'not-a-date',
					summary: '\u0000private',
					additionalFields: null,
				}),
			]),
		);
		expect(error.message).toBe('UID is too long to create a safe event resource name.');
		expect(mocks.createN8nCalDavTransport).not.toHaveBeenCalled();
	});
});

describe('CalDAV Event Create multi-item and sanitized failures', () => {
	it('processes sequentially, preserves earlier successes, and returns exactly one paired output per item with continueOnFail', async () => {
		mocks.createCalendarEvent
			.mockResolvedValueOnce(created('first'))
			.mockRejectedValueOnce(new CalDavAuthorizationError(403))
			.mockResolvedValueOnce(created('third'));
		const [output] = await new CalDav().execute.call(
			context(
				[parameters({ uid: 'first' }), parameters({ uid: 'second' }), parameters({ uid: 'third' })],
				{ continueOnFail: true },
			),
		);
		expect(output).toEqual([
			{ json: created('first'), pairedItem: { item: 0 } },
			{
				json: { error: 'Event Create is not authorized for the selected calendar.' },
				pairedItem: { item: 1 },
			},
			{ json: created('third'), pairedItem: { item: 2 } },
		]);
		expect(mocks.createCalendarEvent.mock.calls.map((call) => call[1].uid)).toEqual([
			'first',
			'second',
			'third',
		]);
	});

	it('stops later items after the first failure without continueOnFail', async () => {
		mocks.createCalendarEvent
			.mockResolvedValueOnce(created('first'))
			.mockRejectedValueOnce(new CalDavNetworkError());
		const error = await captureError(
			context([
				parameters({ uid: 'first' }),
				parameters({ uid: 'second' }),
				parameters({ uid: 'third' }),
			]),
		);
		expect(error).toBeInstanceOf(NodeApiError);
		expect(error).toMatchObject({
			message: 'The CalDAV server could not be reached.',
			context: { itemIndex: 1 },
		});
		expect(mocks.createCalendarEvent).toHaveBeenCalledTimes(2);
	});

	it.each([
		[new CalDavAuthenticationError(401), 'Event Create authentication failed.', '401'],
		[
			new CalDavAuthorizationError(403),
			'Event Create is not authorized for the selected calendar.',
			'403',
		],
		[new CalDavNotFoundError(404), 'The selected calendar was not found.', '404'],
		[new CalDavTlsError(), 'TLS certificate validation failed.', undefined],
		[new CalDavTimeoutError(), 'Event Create timed out.', undefined],
		[
			new CalDavResponseLimitError(),
			'The Event Create response exceeded the size limit.',
			undefined,
		],
		[new CalDavNetworkError(), 'The CalDAV server could not be reached.', undefined],
		[
			new CalDavCalendarEventMutationError(CalendarEventMutationFailureCode.CREATE_CONFLICT),
			'A calendar event already exists for this UID in the selected calendar.',
			undefined,
		],
		[
			new CalDavCalendarEventMutationError(CalendarEventMutationFailureCode.INVALID_RESPONSE),
			'The CalDAV server returned an invalid calendar-event creation response.',
			undefined,
		],
		[
			new CalDavCalendarEventCreateError(CalendarEventCreateFailureCode.INVALID_CLOCK),
			'Event Create failed.',
			undefined,
		],
	] as const)(
		'maps a typed failure to the closed Create error contract',
		async (failure, message, httpCode) => {
			mocks.createCalendarEvent.mockRejectedValueOnce(failure);
			const error = await captureError(context([parameters()]));
			expect(error).toBeInstanceOf(NodeApiError);
			expect(error.message).toBe(message);
			expect((error as NodeApiError).context).toMatchObject({
				itemIndex: 0,
				...(httpCode === undefined ? {} : { httpCode }),
			});
		},
	);

	it('maps serialized-size overflow to an item-indexed local error', async () => {
		mocks.createCalendarEvent.mockRejectedValueOnce(
			new CalDavICalendarSerializeError(CalDavICalendarSerializeErrorCode.RESOURCE_LIMIT_EXCEEDED),
		);
		const error = await captureError(context([parameters()]));
		expect(error).toBeInstanceOf(NodeOperationError);
		expect(error).toMatchObject({
			message: 'The calendar event exceeds the supported size limit.',
			context: { itemIndex: 0 },
		});
	});

	it.each([
		[
			'UNBOUNDED_REQUIRES_REFERENCE',
			'An unbounded IANA recurrence requires server time-zone reference support.',
		],
		[
			'UNREPRESENTABLE_TIME_ZONE',
			'The selected IANA time zone cannot be represented safely for this calendar event.',
		],
	] as const)(
		'maps %s authoring failure to an item-indexed local safe error',
		async (code, message) => {
			mocks.createCalendarEvent.mockRejectedValueOnce(await authoringFailure(code));
			const error = await captureError(context([parameters()]));
			expect(error).toBeInstanceOf(NodeOperationError);
			expect(error).toMatchObject({ message, context: { itemIndex: 0 } });
			expect(JSON.stringify(error)).not.toMatch(/Prague|calendar\.example|private|VTIMEZONE/i);
		},
	);

	it('returns only the exact authoring message with pairing under continueOnFail', async () => {
		mocks.createCalendarEvent.mockRejectedValueOnce(
			await authoringFailure('UNREPRESENTABLE_TIME_ZONE'),
		);
		const [output] = await new CalDav().execute.call(
			context([parameters({ uid: 'private-uid' })], { continueOnFail: true }),
		);
		expect(output).toEqual([
			{
				json: {
					error:
						'The selected IANA time zone cannot be represented safely for this calendar event.',
				},
				pairedItem: { item: 0 },
			},
		]);
		expect(JSON.stringify(output)).not.toMatch(/private-uid|Prague|calendar\.example|VTIMEZONE/i);
	});

	it('uses only the partial-success message and safe status after a successful PUT', async () => {
		mocks.createCalendarEvent.mockRejectedValueOnce(
			new CalDavCalendarEventCreateError(CalendarEventCreateFailureCode.ETAG_RETRIEVAL_FAILED, 403),
		);
		const execution = context([parameters({ uid: 'private-uid-sentinel' })], {
			continueOnFail: true,
		});
		const output = await new CalDav().execute.call(execution);
		expect(output).toEqual([
			[
				{
					json: { error: 'The event was created, but its required ETag could not be retrieved.' },
					pairedItem: { item: 0 },
				},
			],
		]);
		expect(JSON.stringify(output)).not.toMatch(/private-uid|403|calendar\.example/i);
	});

	it('sanitizes an unexpected UID generator failure through the generic Create path', async () => {
		mocks.createCalendarEvent.mockRejectedValueOnce(new Error('private-generator-sentinel'));
		const error = await captureError(context([parameters({ uid: '' })]));

		expect(error).toBeInstanceOf(NodeApiError);
		expect(error).toMatchObject({
			message: 'Event Create failed.',
			context: { itemIndex: 0 },
		});
		expect(JSON.stringify(error)).not.toContain('private-generator-sentinel');
	});
});
