import type { IExecuteFunctions, INode, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	createN8nCalDavTransport: vi.fn(),
	updateCalendarEvent: vi.fn(),
}));

vi.mock('../../nodes/CalDav/transport/http', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/transport/http')>()),
	createN8nCalDavTransport: mocks.createN8nCalDavTransport,
}));

vi.mock('../../nodes/CalDav/events/update', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/events/update')>()),
	updateCalendarEvent: mocks.updateCalendarEvent,
}));

import { CalDav } from '../../nodes/CalDav/CalDav.node';
import { resolveCalendarEventTimeZoneAuthoring } from '../../nodes/CalDav/events/timeZoneAuthoring';
import {
	CalDavCalendarEventMutationError,
	CalendarEventMutationFailureCode,
} from '../../nodes/CalDav/events/mutations';
import {
	CalDavCalendarEventUpdateError,
	CalendarEventUpdateFailureCode,
} from '../../nodes/CalDav/events/update';
import {
	CalDavTimeZoneReferenceError,
	TimeZoneReferenceFailureCode,
} from '../../nodes/CalDav/discovery/timeZoneReferences';
import {
	CalDavCalendarEventPatchError,
	CalendarEventPatchErrorCode,
} from '../../nodes/CalDav/icalendar/patcher';
import {
	CalDavAuthenticationError,
	CalDavAuthorizationError,
	CalDavNotFoundError,
	CalDavRemoteProtocolError,
} from '../../nodes/CalDav/transport/http';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';
import { canonicalizeIanaTimeZone } from '../../nodes/CalDav/icalendar/timeZones';

const NODE: INode = {
	id: 'event-update-node',
	name: 'CalDAV Event Update',
	type: 'calDav',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

const TRANSPORT = {
	serverUrl: 'https://configured.example.test/',
	request: vi.fn(),
};

const CALENDAR_URL = 'https://calendar.example.test/calendars/work/';
const RESOURCE_URL = 'https://calendar.example.test/calendars/work/event.ics';
const UPDATED_EVENT = Object.freeze({
	calendarUrl: validateAbsoluteHttpUrl(CALENDAR_URL),
	resourceUrl: validateAbsoluteHttpUrl(
		'https://calendar.example.test/calendars/work/canonical-event.ics',
	),
	etag: ' "authoritative" ',
	uid: 'event@example.test',
	summary: 'Updated summary',
	description: '',
	location: 'Updated location',
	url: 'urn:example:updated',
	categories: ['One', 'Two'],
	status: 'confirmed',
	transparency: 'transparent',
	timeMode: 'timed',
	accessMode: 'editable',
	start: '2040-01-02T10:00:00Z',
	end: '2040-01-02T11:00:00Z',
});

interface EventUpdateParameters {
	readonly resource: unknown;
	readonly operation: unknown;
	readonly calendar: unknown;
	readonly identifierMode: unknown;
	readonly resourceUrl: unknown;
	readonly uid: unknown;
	readonly etag: unknown;
	readonly timeMode: unknown;
	readonly fieldsToUpdate: unknown;
}

function locator(value: unknown, mode: unknown = 'url'): unknown {
	return { __rl: true, mode, value };
}

function parameters(
	identifierMode: 'resourceUrl' | 'uid' = 'resourceUrl',
	overrides: Partial<EventUpdateParameters> = {},
): EventUpdateParameters {
	return {
		resource: 'event',
		operation: 'update',
		calendar: locator(CALENDAR_URL),
		identifierMode,
		resourceUrl: identifierMode === 'resourceUrl' ? RESOURCE_URL : 'hidden-resource-private',
		uid: identifierMode === 'uid' ? 'event@example.test' : 'hidden-uid-private',
		etag: '',
		timeMode: 'timed',
		fieldsToUpdate: { summary: 'Updated summary' },
		...overrides,
	};
}

function context(
	items: readonly EventUpdateParameters[],
	options: { readonly continueOnFail?: boolean; readonly input?: INodeExecutionData[] } = {},
): IExecuteFunctions {
	return {
		getInputData: vi
			.fn()
			.mockReturnValue(
				options.input ?? items.map((_item, index) => ({ json: { private: `input-${index}` } })),
			),
		getNodeParameter: vi.fn((name: keyof EventUpdateParameters, index: number) =>
			Reflect.get(items[index], name),
		),
		getNode: vi.fn().mockReturnValue(NODE),
		continueOnFail: vi.fn().mockReturnValue(options.continueOnFail ?? false),
	} as unknown as IExecuteFunctions;
}

function property(properties: readonly INodeProperties[], name: string, operation?: string) {
	const matches = properties.filter(
		(candidate) =>
			candidate.name === name &&
			(operation === undefined || candidate.displayOptions?.show?.operation?.includes(operation)),
	);
	expect(matches).toHaveLength(1);
	return matches[0]!;
}

async function captureError(execution: IExecuteFunctions): Promise<Error> {
	try {
		await new CalDav().execute.call(execution);
	} catch (error) {
		return error as Error;
	}
	throw new Error('Expected Event Update execution to fail.');
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
		calendarUrl: validateAbsoluteHttpUrl(CALENDAR_URL),
		timeZone: canonicalizeIanaTimeZone('Europe/Prague'),
		coverage,
	}).catch((error: unknown) => error);
}

beforeEach(() => {
	mocks.createN8nCalDavTransport.mockReset().mockResolvedValue(TRANSPORT);
	mocks.updateCalendarEvent.mockReset().mockResolvedValue(UPDATED_EVENT);
	TRANSPORT.request.mockReset();
});

describe('CalDAV Event Update metadata', () => {
	it('adds Update in the exact Event operation order without changing the default', () => {
		const eventOperation = new CalDav().description.properties.find(
			(candidate) =>
				candidate.name === 'operation' &&
				candidate.displayOptions?.show?.resource?.includes('event'),
		)!;
		expect(eventOperation).toMatchObject({
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

	it('reuses Calendar/identifier/ETag fields and defines the exact ordered patch collection', () => {
		const properties = new CalDav().description.properties;
		expect(property(properties, 'calendar').displayOptions?.show?.operation).toContain('update');
		expect(property(properties, 'identifierMode').displayOptions?.show?.operation).toEqual([
			'get',
			'update',
			'delete',
		]);
		expect(property(properties, 'resourceUrl').displayOptions?.show?.operation).toEqual([
			'get',
			'update',
			'delete',
		]);
		expect(property(properties, 'uid', 'update').displayOptions?.show).toEqual({
			resource: ['event'],
			operation: ['get', 'update', 'delete'],
			identifierMode: ['uid'],
		});
		const etag = property(properties, 'etag');
		expect(etag).toMatchObject({
			type: 'string',
			default: '',
			displayOptions: { show: { resource: ['event'], operation: ['update', 'delete'] } },
		});
		expect(etag.required).toBeUndefined();
		expect(etag.noDataExpression).toBeUndefined();

		const fields = property(properties, 'fieldsToUpdate');
		expect(fields).toMatchObject({
			displayName: 'Fields to Update',
			name: 'fieldsToUpdate',
			type: 'collection',
			placeholder: 'Add Field',
			default: {},
			required: true,
			displayOptions: { show: { resource: ['event'], operation: ['update'] } },
		});
		expect(fields.options?.map((option) => option.name)).toEqual([
			'timeZone',
			'start',
			'end',
			'startDate',
			'endDate',
			'summary',
			'alarms',
			'categories',
			'description',
			'location',
			'status',
			'transparency',
			'url',
		]);
		for (const name of ['description', 'location', 'url'] as const) {
			const nested = fields.options?.find((option) => option.name === name);
			expect(nested).toBeDefined();
			if (nested === undefined) throw new Error(`Missing ${name} Update field.`);
			expect(nested).toMatchObject({
				type: 'fixedCollection',
				typeOptions: { multipleValues: false },
				default: {},
				required: true,
			});
			const change = nested.options?.[0];
			expect(change).toMatchObject({ displayName: 'Change', name: 'change' });
			expect(change?.values?.[0]).toMatchObject({
				displayName: 'Action',
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
				displayName: 'Value',
				name: 'value',
				type: 'string',
				default: '',
				displayOptions: { show: { action: ['set'] } },
			});
			expect(change?.values?.[1].required).toBeUndefined();
		}
		const categories = fields.options?.find(({ name }) => name === 'categories');
		expect(categories).toMatchObject({
			type: 'fixedCollection',
			typeOptions: { multipleValues: false },
			options: [
				{
					name: 'change',
					values: [
						expect.objectContaining({ name: 'action', default: 'set' }),
						expect.objectContaining({
							name: 'value',
							type: 'fixedCollection',
							typeOptions: { multipleValues: true },
							displayOptions: { show: { action: ['set'] } },
						}),
					],
				},
			],
		});
		for (const [name, values] of [
			['status', ['tentative', 'confirmed', 'cancelled']],
			['transparency', ['opaque', 'transparent']],
		] as const) {
			const nested = fields.options?.find((option) => option.name === name);
			const change = nested?.options?.[0];
			expect(change?.values?.[1]).toMatchObject({
				name: 'value',
				type: 'options',
				default: '',
				displayOptions: { show: { action: ['set'] } },
			});
			expect(change?.values?.[1]?.options?.map((option) => option.value)).toEqual(values);
		}
	});
});

describe('CalDAV Event Update extraction and output', () => {
	it('extracts all six fields in Set/Remove form and keeps an opaque caller ETag exact', async () => {
		const execution = context([
			parameters('resourceUrl', {
				etag: ' W/"opaque caller" ',
				fieldsToUpdate: {
					start: '2040-01-02T11:00:00+01:00',
					end: new Date('2040-01-02T11:00:00Z'),
					summary: '',
					description: { change: { action: 'set', value: '' } },
					location: { change: { action: 'remove' } },
					url: { change: { action: 'set', value: 'urn:example:updated' } },
					categories: {
						change: {
							action: 'set',
							value: {
								category: [{ value: 'One' }, { value: 'Two' }, { value: 'One' }],
							},
						},
					},
					status: { change: { action: 'set', value: 'confirmed' } },
					transparency: { change: { action: 'remove', value: 'hidden-private' } },
				},
			}),
		]);

		const [output] = await new CalDav().execute.call(execution);

		expect(mocks.updateCalendarEvent).toHaveBeenCalledTimes(1);
		const [transport, input, clock] = mocks.updateCalendarEvent.mock.calls[0];
		expect(transport).toBe(TRANSPORT);
		expect(input).toEqual({
			calendarUrl: CALENDAR_URL,
			identifier: { kind: 'resourceUrl', resourceUrl: RESOURCE_URL },
			patch: {
				timeMode: 'timed',
				start: { kind: 'set', value: new Date('2040-01-02T10:00:00Z') },
				end: { kind: 'set', value: new Date('2040-01-02T11:00:00Z') },
				summary: { kind: 'set', value: '' },
				description: { kind: 'set', value: '' },
				location: { kind: 'remove' },
				url: { kind: 'set', value: 'urn:example:updated' },
				categories: { kind: 'set', value: ['One', 'Two'] },
				status: { kind: 'set', value: 'confirmed' },
				transparency: { kind: 'remove' },
			},
			etag: ' W/"opaque caller" ',
		});
		expect(clock()).toBeInstanceOf(Date);
		expect(output).toEqual([{ json: UPDATED_EVENT, pairedItem: { item: 0 } }]);
		expect(Object.keys(output[0]!.json)).toEqual([
			'calendarUrl',
			'resourceUrl',
			'etag',
			'uid',
			'summary',
			'description',
			'location',
			'url',
			'categories',
			'status',
			'transparency',
			'timeMode',
			'accessMode',
			'start',
			'end',
		]);
		expect(execution.getNodeParameter).not.toHaveBeenCalledWith('uid', 0);
	});

	it('uses UID mode and converts the empty UI ETag sentinel to coordinator absence', async () => {
		await new CalDav().execute.call(
			context([
				parameters('uid', {
					uid: 'opaque uid ../event',
					etag: '',
					fieldsToUpdate: { description: { change: { action: 'remove', value: 'hidden' } } },
				}),
			]),
		);

		expect(mocks.updateCalendarEvent.mock.calls[0][1]).toEqual({
			calendarUrl: CALENDAR_URL,
			identifier: { kind: 'uid', uid: 'opaque uid ../event' },
			patch: { timeMode: 'timed', description: { kind: 'remove' } },
		});
	});
});

describe('CalDAV Event Update local validation', () => {
	it.each([
		[
			'invalid Calendar',
			{ calendar: locator('https://user:secret@example.test/work/') },
			'The Calendar URL is invalid. Enter an absolute HTTP(S) calendar collection URL.',
		],
		[
			'invalid Resource URL',
			{ resourceUrl: '/private/event.ics' },
			'The Event Resource URL is invalid or does not belong to the selected calendar.',
		],
		[
			'invalid UID',
			{ identifierMode: 'uid', uid: '\u0000private' },
			'UID must be a non-empty valid iCalendar text value.',
		],
		['invalid ETag', { etag: { private: true } }, 'ETag must be a string.'],
		['invalid fields shape', { fieldsToUpdate: [] }, 'Fields to Update must be an object.'],
		[
			'empty patch',
			{ fieldsToUpdate: {} },
			'The calendar event patch does not contain any changes.',
		],
		[
			'invalid Start',
			{ fieldsToUpdate: { start: '2040-01-02T10:00:00' } },
			'Start must be a valid date and time with whole-second precision.',
		],
		[
			'invalid End',
			{ fieldsToUpdate: { end: 2_208_988_800_000 } },
			'End must be a valid date and time with whole-second precision.',
		],
		[
			'invalid Summary',
			{ fieldsToUpdate: { summary: 'bad\rtext' } },
			'Summary must be a valid iCalendar text value.',
		],
		[
			'invalid Description',
			{ fieldsToUpdate: { description: { change: { action: 'set', value: 'bad\rtext' } } } },
			'Description must be a valid iCalendar text value.',
		],
		[
			'invalid Location',
			{ fieldsToUpdate: { location: { change: { action: 'invalid' } } } },
			'Location must be a valid iCalendar text value.',
		],
		[
			'invalid URL',
			{ fieldsToUpdate: { url: { change: { action: 'set', value: '' } } } },
			'URL must be a valid absolute URI without a fragment.',
		],
		[
			'invalid Categories',
			{
				fieldsToUpdate: {
					categories: { change: { action: 'set', value: { category: [{ value: '' }] } } },
				},
			},
			'Categories must be a non-empty list of valid iCalendar text values.',
		],
		[
			'invalid Status',
			{ fieldsToUpdate: { status: { change: { action: 'set', value: 'CONFIRMED' } } } },
			'Status must be Tentative, Confirmed, or Cancelled.',
		],
		[
			'invalid Transparency',
			{ fieldsToUpdate: { transparency: { change: { action: 'set', value: 'private' } } } },
			'Transparency must be Opaque or Transparent.',
		],
	] as const)('rejects %s before transport creation', async (_label, overrides, message) => {
		const error = await captureError(
			context([parameters('resourceUrl', overrides as Partial<EventUpdateParameters>)]),
		);
		expect(error).toBeInstanceOf(NodeOperationError);
		expect(error.message).toBe(message);
		expect((error as NodeOperationError).context.itemIndex).toBe(0);
		expect(mocks.createN8nCalDavTransport).not.toHaveBeenCalled();
		expect(mocks.updateCalendarEvent).not.toHaveBeenCalled();
		expect(String(error)).not.toMatch(/secret|private\/event|bad\rtext/);
	});
});

describe('CalDAV Event Update error mapping, continuation, and privacy', () => {
	it.each([
		[
			new CalDavCalendarEventPatchError(CalendarEventPatchErrorCode.NO_CHANGES),
			'The calendar event patch does not contain any changes.',
			NodeOperationError,
		],
		[
			new CalDavCalendarEventPatchError(CalendarEventPatchErrorCode.UNSUPPORTED_TIME, 'start'),
			'The calendar event uses an unsupported time representation for this patch.',
			NodeApiError,
		],
		[
			new CalDavCalendarEventPatchError(
				CalendarEventPatchErrorCode.INCOMPATIBLE_PARAMETERS,
				'summary',
			),
			'The calendar event property parameters are incompatible with this patch.',
			NodeApiError,
		],
		[
			new CalDavCalendarEventPatchError(CalendarEventPatchErrorCode.AMBIGUOUS_PROPERTY),
			'The calendar event contains an ambiguous property.',
			NodeApiError,
		],
		[
			new CalDavCalendarEventPatchError(CalendarEventPatchErrorCode.INVALID_METADATA),
			'The calendar event revision metadata is invalid.',
			NodeApiError,
		],
		[
			new CalDavCalendarEventMutationError(CalendarEventMutationFailureCode.MISSING_ETAG),
			'The calendar event does not provide an ETag required for a safe mutation.',
			NodeApiError,
		],
		[
			new CalDavCalendarEventMutationError(CalendarEventMutationFailureCode.CONCURRENCY_CONFLICT),
			'The calendar event changed before the mutation could be applied.',
			NodeApiError,
		],
		[new CalDavAuthenticationError(401), 'Event Update authentication failed.', NodeApiError],
		[new CalDavAuthorizationError(403), 'Event Update is not authorized.', NodeApiError],
		[new CalDavNotFoundError(404), 'The calendar event was not found.', NodeApiError],
		[
			new CalDavRemoteProtocolError(409),
			'The CalDAV server returned an invalid calendar-event update response.',
			NodeApiError,
		],
		[
			new CalDavCalendarEventUpdateError(CalendarEventUpdateFailureCode.CONFIRMATION_FAILED, 404),
			'The event was updated, but its current state could not be verified.',
			NodeApiError,
		],
		[
			new CalDavTimeZoneReferenceError(TimeZoneReferenceFailureCode.SERVER_UNSUPPORTED),
			'The CalDAV server does not support IANA time zones by reference.',
			NodeApiError,
		],
		[
			new CalDavTimeZoneReferenceError(TimeZoneReferenceFailureCode.ZONE_UNAVAILABLE),
			'The selected IANA time zone is not available by reference on the CalDAV server.',
			NodeApiError,
		],
	] as const)(
		'maps a coordinator failure to the exact safe node error',
		async (failure, message, ErrorType) => {
			mocks.updateCalendarEvent.mockRejectedValue(failure);
			const error = await captureError(context([parameters()]));
			expect(error).toBeInstanceOf(ErrorType);
			expect(error.message).toBe(message);
			expect((error as NodeApiError | NodeOperationError).context.itemIndex).toBe(0);
			if (message.includes('verified')) {
				expect((error as NodeApiError).context.httpCode).toBe('404');
			}
		},
	);

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
			mocks.updateCalendarEvent.mockRejectedValueOnce(await authoringFailure(code));
			const error = await captureError(context([parameters()]));
			expect(error).toBeInstanceOf(NodeOperationError);
			expect(error).toMatchObject({ message, context: { itemIndex: 0 } });
			expect(JSON.stringify(error)).not.toMatch(/Prague|calendar\.example|private|VTIMEZONE/i);
		},
	);

	it('returns only safe errors and preserves ordered pairing with continueOnFail', async () => {
		mocks.updateCalendarEvent
			.mockRejectedValueOnce(
				Object.assign(new Error('private remote body /users/account/path'), {
					body: 'BEGIN:VCALENDAR private ICS',
					headers: { authorization: 'private-auth', etag: 'private-etag' },
				}),
			)
			.mockResolvedValueOnce(UPDATED_EVENT)
			.mockRejectedValueOnce(new CalDavAuthorizationError(403));

		const [output] = await new CalDav().execute.call(
			context([parameters(), parameters('uid'), parameters()], { continueOnFail: true }),
		);

		expect(output).toEqual([
			{ json: { error: 'Event Update failed.' }, pairedItem: { item: 0 } },
			{ json: UPDATED_EVENT, pairedItem: { item: 1 } },
			{ json: { error: 'Event Update is not authorized.' }, pairedItem: { item: 2 } },
		]);
		expect(JSON.stringify(output)).not.toMatch(
			/private-auth|private-etag|private remote|BEGIN:VCALENDAR|account\/path|input-/,
		);
		expect(mocks.updateCalendarEvent).toHaveBeenCalledTimes(3);
	});

	it('stops after the first failure when continueOnFail is disabled', async () => {
		mocks.updateCalendarEvent.mockRejectedValueOnce(new CalDavNotFoundError(404));
		await expect(
			new CalDav().execute.call(context([parameters(), parameters('uid')])),
		).rejects.toBeInstanceOf(NodeApiError);
		expect(mocks.updateCalendarEvent).toHaveBeenCalledTimes(1);
	});
});
