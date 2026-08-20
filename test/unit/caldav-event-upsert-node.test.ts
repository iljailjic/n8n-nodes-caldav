import type { IExecuteFunctions, INode, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	upsertCalendarEvent: vi.fn(),
	createN8nCalDavTransport: vi.fn(),
}));

vi.mock('../../nodes/CalDav/events/upsert', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/events/upsert')>()),
	upsertCalendarEvent: mocks.upsertCalendarEvent,
}));

vi.mock('../../nodes/CalDav/transport/http', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/transport/http')>()),
	createN8nCalDavTransport: mocks.createN8nCalDavTransport,
}));

import { CalDav } from '../../nodes/CalDav/CalDav.node';
import {
	CalDavCalendarEventCreateError,
	CalendarEventCreateFailureCode,
} from '../../nodes/CalDav/events/create';
import {
	CalDavCalendarEventMutationError,
	CalendarEventMutationFailureCode,
} from '../../nodes/CalDav/events/mutations';
import {
	CalDavCalendarEventUidResolutionError,
	CalendarEventUidResolutionFailureCode,
} from '../../nodes/CalDav/events/resolveByUid';
import { calendarEventTimeZoneExecutionContext } from '../../nodes/CalDav/events/timeZoneExecutionContext';
import {
	CalDavCalendarEventUpdateError,
	CalendarEventUpdateFailureCode,
} from '../../nodes/CalDav/events/update';
import {
	CalDavCalendarEventUpsertError,
	CalendarEventUpsertFailureCode,
} from '../../nodes/CalDav/events/upsert';
import {
	CalDavAuthenticationError,
	CalDavAuthorizationError,
	CalDavNetworkError,
	CalDavNotFoundError,
	CalDavRemoteProtocolError,
	CalDavResponseLimitError,
	CalDavTimeoutError,
} from '../../nodes/CalDav/transport/http';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';

const CALENDAR_URL = 'https://calendar.example.test/calendars/work/';
const NODE: INode = {
	id: 'event-upsert-node',
	name: 'CalDAV Event Upsert',
	type: 'calDav',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};
const TRANSPORT = {
	serverUrl: 'https://calendar.example.test/',
	request: vi.fn(),
};

interface EventUpsertParameters {
	readonly resource: unknown;
	readonly operation: unknown;
	readonly calendar: unknown;
	readonly uid: unknown;
	readonly timeMode: unknown;
	readonly timeZoneMode?: unknown;
	readonly timeZone?: unknown;
	readonly start?: unknown;
	readonly end?: unknown;
	readonly startDate?: unknown;
	readonly endDate?: unknown;
	readonly summary: unknown;
	readonly additionalFields: unknown;
}

function locator(value: unknown, mode: unknown = 'url'): unknown {
	return { __rl: true, mode, value };
}

function parameters(overrides: Partial<EventUpsertParameters> = {}): EventUpsertParameters {
	return {
		resource: 'event',
		operation: 'upsert',
		calendar: locator(CALENDAR_URL),
		uid: 'opaque UID 🚀',
		timeMode: 'timed',
		timeZoneMode: 'utc',
		start: '2040-01-02T10:00:00+01:00',
		end: '2040-01-02T11:00:00+01:00',
		summary: 'Meeting',
		additionalFields: {},
		...overrides,
	};
}

function context(
	items: readonly EventUpsertParameters[],
	options: { readonly continueOnFail?: boolean; readonly input?: INodeExecutionData[] } = {},
): IExecuteFunctions {
	return {
		getInputData: vi
			.fn()
			.mockReturnValue(options.input ?? items.map((_item, index) => ({ json: { item: index } }))),
		getNodeParameter: vi.fn((name: keyof EventUpsertParameters, index: number) =>
			Reflect.get(items[index], name),
		),
		getNode: vi.fn().mockReturnValue(NODE),
		continueOnFail: vi.fn().mockReturnValue(options.continueOnFail ?? false),
	} as unknown as IExecuteFunctions;
}

function event(uid: string, summary = 'Meeting') {
	return Object.freeze({
		calendarUrl: validateAbsoluteHttpUrl(CALENDAR_URL),
		resourceUrl: validateAbsoluteHttpUrl(
			new URL(`${Buffer.from(uid).toString('base64url')}.ics`, CALENDAR_URL).href,
		),
		etag: ' W/"authoritative" ',
		uid,
		summary,
		description: '',
		location: 'Office',
		url: 'urn:example:upsert',
		timeMode: 'timed' as const,
		accessMode: 'editable' as const,
		start: '2040-01-02T09:00:00Z',
		end: '2040-01-02T10:00:00Z',
		timeZoneMode: 'utc' as const,
		startLocal: '2040-01-02T09:00:00',
		endLocal: '2040-01-02T10:00:00',
	});
}

function result(action: 'create' | 'update', uid: string, summary = 'Meeting') {
	return Object.freeze({ action, event: event(uid, summary) });
}

function upsertProperties(): readonly INodeProperties[] {
	return new CalDav().description.properties.filter((candidate) => {
		const show = candidate.displayOptions?.show;
		return (
			candidate.name === 'calendar' ||
			(show?.resource?.includes('event') === true && show.operation?.includes('upsert') === true)
		);
	});
}

async function captureError(execution: IExecuteFunctions): Promise<Error> {
	try {
		await new CalDav().execute.call(execution);
	} catch (error) {
		return error as Error;
	}
	throw new Error('Expected Event Upsert execution to fail.');
}

beforeEach(() => {
	mocks.createN8nCalDavTransport.mockReset().mockResolvedValue(TRANSPORT);
	mocks.upsertCalendarEvent
		.mockReset()
		.mockImplementation(async (_transport, input) =>
			result(input.uid === undefined ? 'create' : 'update', input.uid ?? 'generated-by-service'),
		);
	TRANSPORT.request.mockReset();
});

describe('CalDAV Event Upsert metadata', () => {
	it('adds Upsert after Update and before Delete without changing the existing default', () => {
		const operation = new CalDav().description.properties.find(
			(candidate) =>
				candidate.name === 'operation' &&
				candidate.displayOptions?.show?.resource?.includes('event'),
		);
		expect(operation).toMatchObject({
			type: 'options',
			noDataExpression: true,
			options: [
				{ name: 'Create', value: 'create' },
				{ name: 'Get', value: 'get' },
				{ name: 'Get Many', value: 'getMany' },
				{ name: 'Update', value: 'update' },
				{
					name: 'Upsert',
					value: 'upsert',
					description: 'Create or update a calendar event by UID',
					action: 'Upsert a calendar event',
				},
				{ name: 'Delete', value: 'delete' },
			],
			default: 'get',
		});
	});

	it('defines the exact ordered create-complete fields and Set/Remove optional collection', () => {
		const properties = upsertProperties();
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
		const uid = properties[1]!;
		expect(uid).toMatchObject({ name: 'uid', type: 'string', default: '' });
		expect(uid.required).toBeUndefined();
		expect(uid.description).toContain('blank');
		expect(uid.description).toContain('new UID');
		expect(uid.description).toContain('always creates');
		expect(uid.description).toContain('supplied UID');
		expect(uid.description).toContain('selected calendar');

		expect(properties.slice(2, 10).map(({ name }) => name)).toEqual([
			'timeMode',
			'timeZoneMode',
			'timeZone',
			'start',
			'end',
			'startDate',
			'endDate',
			'summary',
		]);
		expect(properties[2]).toMatchObject({
			required: true,
			noDataExpression: true,
			default: 'timed',
			options: [
				{ name: 'Timed', value: 'timed' },
				{ name: 'All-Day', value: 'allDay' },
			],
		});
		expect(properties[3]).toMatchObject({
			required: true,
			noDataExpression: true,
			default: 'utc',
			displayOptions: { show: { operation: ['upsert'], timeMode: ['timed'] } },
		});
		expect(properties[4]).toMatchObject({
			required: true,
			default: '',
			displayOptions: {
				show: { operation: ['upsert'], timeMode: ['timed'], timeZoneMode: ['iana'] },
			},
		});

		const additional = properties[10]!;
		expect(additional).toMatchObject({
			name: 'additionalFields',
			type: 'collection',
			placeholder: 'Add Field',
			default: {},
		});
		expect(additional.options?.map(({ name }) => name)).toEqual([
			'categories',
			'description',
			'location',
			'status',
			'transparency',
			'url',
		]);
		for (const option of (additional.options ?? []).filter(({ name }) =>
			['description', 'location', 'url'].includes(name),
		)) {
			expect(option).toMatchObject({
				type: 'fixedCollection',
				typeOptions: { multipleValues: false },
				default: {},
				required: true,
			});
			const change = option.options?.[0];
			expect(change).toMatchObject({ name: 'change' });
			expect(change?.values?.[0]).toMatchObject({
				name: 'action',
				type: 'options',
				required: true,
				noDataExpression: true,
				options: [
					{ name: 'Set', value: 'set' },
					{ name: 'Remove', value: 'remove' },
				],
				default: 'set',
			});
			expect(change?.values?.[1]).toMatchObject({
				name: 'value',
				type: 'string',
				default: '',
				displayOptions: { show: { action: ['set'] } },
			});
		}
		expect(
			additional.options?.find(({ name }) => name === 'description')?.options?.[0]?.values?.[1],
		).toMatchObject({
			typeOptions: { rows: 4 },
		});
		const categories = additional.options?.find(({ name }) => name === 'categories');
		expect(categories?.options?.[0]?.values?.[1]).toMatchObject({
			name: 'value',
			type: 'fixedCollection',
			typeOptions: { multipleValues: true },
			displayOptions: { show: { action: ['set'] } },
		});
		for (const [name, values] of [
			['status', ['tentative', 'confirmed', 'cancelled']],
			['transparency', ['opaque', 'transparent']],
		] as const) {
			const value = additional.options?.find((option) => option.name === name)?.options?.[0]
				?.values?.[1];
			expect(value).toMatchObject({
				name: 'value',
				type: 'options',
				default: '',
				displayOptions: { show: { action: ['set'] } },
			});
			expect(value?.options?.map((option) => option.value)).toEqual(values);
		}
	});
});

describe('CalDAV Event Upsert extraction and flat output', () => {
	it('maps timed Set/Remove values, preserves opaque UID, and flattens action before the event', async () => {
		mocks.upsertCalendarEvent.mockResolvedValueOnce(result('update', '  opaque UID 🚀  '));
		const execution = context([
			parameters({
				uid: '  opaque UID 🚀  ',
				additionalFields: {
					description: { change: { action: 'set', value: '' } },
					location: { change: { action: 'remove', value: 'hidden-private' } },
					url: { change: { action: 'set', value: 'urn:example:upsert' } },
					categories: {
						change: {
							action: 'set',
							value: { category: [{ value: 'One' }, { value: 'One' }, { value: 'Two' }] },
						},
					},
					status: { change: { action: 'set', value: 'cancelled' } },
					transparency: { change: { action: 'remove', value: 'hidden-private' } },
				},
			}),
		]);

		const [output] = await new CalDav().execute.call(execution);

		expect(mocks.upsertCalendarEvent).toHaveBeenCalledTimes(1);
		const [selectedTransport, input, deps] = mocks.upsertCalendarEvent.mock.calls[0]!;
		expect(selectedTransport).toBe(TRANSPORT);
		expect(input).toEqual({
			calendarUrl: CALENDAR_URL,
			uid: '  opaque UID 🚀  ',
			timeMode: 'timed',
			start: new Date('2040-01-02T09:00:00Z'),
			end: new Date('2040-01-02T10:00:00Z'),
			timeZone: { timeZoneMode: 'utc' },
			summary: 'Meeting',
			description: { kind: 'set', value: '' },
			location: { kind: 'remove' },
			url: { kind: 'set', value: 'urn:example:upsert' },
			categories: { kind: 'set', value: ['One', 'Two'] },
			status: { kind: 'set', value: 'cancelled' },
			transparency: { kind: 'remove' },
		});
		expect(deps.clock).toBeTypeOf('function');
		expect(deps.uidFactory).toBeTypeOf('function');
		expect(output).toEqual([
			{
				json: { action: 'update', ...event('  opaque UID 🚀  ') },
				pairedItem: { item: 0 },
			},
		]);
		expect(Object.keys(output[0]!.json)).toEqual([
			'action',
			'calendarUrl',
			'resourceUrl',
			'etag',
			'uid',
			'summary',
			'description',
			'location',
			'url',
			'timeMode',
			'accessMode',
			'start',
			'end',
			'timeZoneMode',
			'startLocal',
			'endLocal',
		]);
		expect(output[0]!.json).not.toHaveProperty('event');
	});

	it('converts only blank UID to omission and reads only active all-day fields', async () => {
		mocks.upsertCalendarEvent.mockResolvedValueOnce(result('create', 'generated-by-service'));
		const execution = context([
			parameters({
				uid: '',
				timeMode: 'allDay',
				timeZoneMode: undefined,
				start: undefined,
				end: undefined,
				startDate: '2040-02-28',
				endDate: '2040-03-01',
			}),
		]);

		await new CalDav().execute.call(execution);

		expect(mocks.upsertCalendarEvent.mock.calls[0]![1]).toEqual({
			calendarUrl: CALENDAR_URL,
			timeMode: 'allDay',
			startDate: '2040-02-28',
			endDate: '2040-03-01',
			summary: 'Meeting',
		});
		for (const inactive of ['timeZoneMode', 'timeZone', 'start', 'end'] as const) {
			expect(execution.getNodeParameter).not.toHaveBeenCalledWith(inactive, 0);
		}
	});

	it('binds a lazy shared timezone context for supplied UTC lookup but not omitted all-day Create', async () => {
		const suppliedTransport = {
			serverUrl: 'https://calendar.example.test/',
			request: vi.fn(),
		};
		const omittedTransport = {
			serverUrl: 'https://calendar.example.test/',
			request: vi.fn(),
		};
		mocks.createN8nCalDavTransport
			.mockResolvedValueOnce(suppliedTransport)
			.mockResolvedValueOnce(omittedTransport);

		await new CalDav().execute.call(context([parameters({ uid: 'supplied-utc' })]));
		expect(calendarEventTimeZoneExecutionContext(suppliedTransport)).toBeDefined();

		await new CalDav().execute.call(
			context([
				parameters({
					uid: '',
					timeMode: 'allDay',
					timeZoneMode: undefined,
					start: undefined,
					end: undefined,
					startDate: '2040-02-28',
					endDate: '2040-03-01',
				}),
			]),
		);
		expect(calendarEventTimeZoneExecutionContext(omittedTransport)).toBeUndefined();
		expect(mocks.upsertCalendarEvent).toHaveBeenCalledTimes(2);
	});
});

describe('CalDAV Event Upsert local validation and item behavior', () => {
	it.each([
		[
			'Calendar',
			{ calendar: locator('https://user:secret@calendar.example.test/private/') },
			'The Calendar URL is invalid. Enter an absolute HTTP(S) calendar collection URL.',
		],
		['UID type', { uid: null }, 'UID must be a non-empty valid iCalendar text value.'],
		['Time Mode', { timeMode: 'private' }, 'Time Mode must be Timed or All-Day.'],
		['Time Zone Mode', { timeZoneMode: 'private' }, 'Time Zone Mode must be UTC or IANA.'],
		[
			'Time Zone',
			{ timeZoneMode: 'iana', timeZone: 'Private/Zone' },
			'Time Zone must be a valid IANA time zone identifier.',
		],
		[
			'Start',
			{ start: '2040-01-02T10:00:00' },
			'Start must be a valid date and time with whole-second precision.',
		],
		['Summary', { summary: '\u0000private' }, 'Summary must be a valid iCalendar text value.'],
		['Additional Fields', { additionalFields: [] }, 'Additional Fields must be an object.'],
		[
			'Description shape',
			{ additionalFields: { description: { change: { action: 'set' } } } },
			'Description must be a valid iCalendar text value.',
		],
		[
			'URL empty',
			{ additionalFields: { url: { change: { action: 'set', value: '' } } } },
			'URL must be a valid absolute URI without a fragment.',
		],
		[
			'URL empty fragment',
			{ additionalFields: { url: { change: { action: 'set', value: 'urn:example:#' } } } },
			'URL must be a valid absolute URI without a fragment.',
		],
		[
			'Categories empty',
			{
				additionalFields: {
					categories: { change: { action: 'set', value: { category: [] } } },
				},
			},
			'Categories must be a non-empty list of valid iCalendar text values.',
		],
		[
			'Status uppercase',
			{ additionalFields: { status: { change: { action: 'set', value: 'CANCELLED' } } } },
			'Status must be Tentative, Confirmed, or Cancelled.',
		],
		[
			'Transparency unsupported',
			{
				additionalFields: { transparency: { change: { action: 'set', value: 'private' } } },
			},
			'Transparency must be Opaque or Transparent.',
		],
		['Range', { end: '2040-01-02T10:00:00+01:00' }, 'End must be later than Start.'],
	] as const)(
		'rejects %s before transport creation or coordinator execution',
		async (_label, overrides, message) => {
			const error = await captureError(context([parameters(overrides)]));
			expect(error).toBeInstanceOf(NodeOperationError);
			expect(error).toMatchObject({ message, context: { itemIndex: 0 } });
			expect(mocks.createN8nCalDavTransport).not.toHaveBeenCalled();
			expect(mocks.upsertCalendarEvent).not.toHaveBeenCalled();
			expect(String(error)).not.toMatch(/secret|Private\/Zone|private/);
		},
	);

	it('reports the first simultaneously invalid field in exact UI order', async () => {
		const error = await captureError(
			context([
				parameters({
					uid: '\u0000private-uid',
					timeMode: 'private-mode',
					start: 'private-start',
					summary: '\u0000private-summary',
					additionalFields: null,
				}),
			]),
		);
		expect(error.message).toBe('UID must be a non-empty valid iCalendar text value.');
		expect(mocks.createN8nCalDavTransport).not.toHaveBeenCalled();
		expect(mocks.upsertCalendarEvent).not.toHaveBeenCalled();
	});

	it('reports Summary before the deferred final range consistency check', async () => {
		const error = await captureError(
			context([
				parameters({
					end: '2040-01-02T10:00:00+01:00',
					summary: '\u0000private-summary',
				}),
			]),
		);
		expect(error.message).toBe('Summary must be a valid iCalendar text value.');
		expect(mocks.createN8nCalDavTransport).not.toHaveBeenCalled();
		expect(mocks.upsertCalendarEvent).not.toHaveBeenCalled();
	});

	it('continues sequentially with exactly one flat paired output per input', async () => {
		mocks.upsertCalendarEvent
			.mockResolvedValueOnce(result('create', 'first'))
			.mockRejectedValueOnce(new CalDavAuthorizationError(403))
			.mockResolvedValueOnce(result('update', 'third'));

		const [output] = await new CalDav().execute.call(
			context(
				[parameters({ uid: 'first' }), parameters({ uid: 'second' }), parameters({ uid: 'third' })],
				{ continueOnFail: true },
			),
		);

		expect(output).toEqual([
			{ json: { action: 'create', ...event('first') }, pairedItem: { item: 0 } },
			{
				json: { error: 'Event Upsert is not authorized for the selected calendar.' },
				pairedItem: { item: 1 },
			},
			{ json: { action: 'update', ...event('third') }, pairedItem: { item: 2 } },
		]);
		expect(mocks.upsertCalendarEvent).toHaveBeenCalledTimes(3);
	});

	it('stops later items after the first failure without rolling back earlier success', async () => {
		mocks.upsertCalendarEvent
			.mockResolvedValueOnce(result('create', 'first'))
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
		expect(mocks.upsertCalendarEvent).toHaveBeenCalledTimes(2);
	});
});

describe('CalDAV Event Upsert closed error adapter and privacy', () => {
	it.each([
		[new CalDavAuthenticationError(401), 'Event Upsert authentication failed.', '401'],
		[
			new CalDavAuthorizationError(403),
			'Event Upsert is not authorized for the selected calendar.',
			'403',
		],
		[new CalDavNotFoundError(404), 'The selected calendar was not found.', '404'],
		[new CalDavTimeoutError(), 'Event Upsert timed out.', undefined],
		[
			new CalDavResponseLimitError(),
			'The Event Upsert response exceeded the size limit.',
			undefined,
		],
		[
			new CalDavRemoteProtocolError(409),
			'The CalDAV server returned an invalid calendar-event upsert response.',
			'409',
		],
		[
			new CalDavCalendarEventUidResolutionError(CalendarEventUidResolutionFailureCode.AMBIGUOUS),
			'More than one calendar event with the requested UID was found in the selected calendar.',
			undefined,
		],
		[
			new CalDavCalendarEventUidResolutionError(
				CalendarEventUidResolutionFailureCode.INVALID_RESPONSE,
			),
			'The CalDAV server returned an invalid calendar-event upsert response.',
			undefined,
		],
		[
			new CalDavCalendarEventMutationError(CalendarEventMutationFailureCode.MISSING_ETAG),
			'The calendar event does not provide an ETag required for a safe mutation.',
			undefined,
		],
		[
			new CalDavCalendarEventUpsertError(CalendarEventUpsertFailureCode.CONCURRENCY_CONFLICT),
			'The calendar changed while Event Upsert was in progress.',
			undefined,
		],
		[
			new CalDavCalendarEventCreateError(CalendarEventCreateFailureCode.ETAG_RETRIEVAL_FAILED, 404),
			'The event was created, but its required ETag could not be retrieved.',
			'404',
		],
		[
			new CalDavCalendarEventCreateError(CalendarEventCreateFailureCode.INVALID_CLOCK),
			'Event Upsert failed.',
			undefined,
		],
		[
			new CalDavCalendarEventUpdateError(CalendarEventUpdateFailureCode.CONFIRMATION_FAILED, 404),
			'The event was updated, but its current state could not be verified.',
			'404',
		],
		[new Error('private native sentinel'), 'Event Upsert failed.', undefined],
	] as const)(
		'maps one typed failure to the exact item-indexed safe message',
		async (failure, message, httpCode) => {
			mocks.upsertCalendarEvent.mockRejectedValueOnce(failure);
			const error = await captureError(context([parameters()]));
			expect(error).toBeInstanceOf(NodeApiError);
			expect(error).toMatchObject({
				message,
				context: { itemIndex: 0, ...(httpCode === undefined ? {} : { httpCode }) },
			});
			expect(JSON.stringify(error)).not.toMatch(
				/private native|opaque UID|calendar\.example|authorization/i,
			);
		},
	);

	it('emits only the fixed error and pairing under continueOnFail', async () => {
		mocks.upsertCalendarEvent.mockRejectedValueOnce(
			Object.assign(new Error('private native /account/path'), {
				body: '<private-xml/>',
				headers: { authorization: 'private-auth', etag: 'private-etag' },
			}),
		);
		const [output] = await new CalDav().execute.call(
			context([parameters()], { continueOnFail: true }),
		);
		expect(output).toEqual([{ json: { error: 'Event Upsert failed.' }, pairedItem: { item: 0 } }]);
		expect(JSON.stringify(output)).not.toMatch(/private|account|auth|etag|xml|UID|calendar/);
	});
});
