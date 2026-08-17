import type { IExecuteFunctions, INode, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	createN8nCalDavTransport: vi.fn(),
	deleteCalendarEventResource: vi.fn(),
	getCalendarEventByResourceUrl: vi.fn(),
	resolveCalendarEventByUid: vi.fn(),
}));

vi.mock('../../nodes/CalDav/transport/http', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/transport/http')>()),
	createN8nCalDavTransport: mocks.createN8nCalDavTransport,
}));

vi.mock('../../nodes/CalDav/events/mutations', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/events/mutations')>()),
	deleteCalendarEventResource: mocks.deleteCalendarEventResource,
}));

vi.mock('../../nodes/CalDav/events/getByResourceUrl', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/events/getByResourceUrl')>()),
	getCalendarEventByResourceUrl: mocks.getCalendarEventByResourceUrl,
}));

vi.mock('../../nodes/CalDav/events/resolveByUid', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/events/resolveByUid')>()),
	resolveCalendarEventByUid: mocks.resolveCalendarEventByUid,
}));

import { CalDav } from '../../nodes/CalDav/CalDav.node';
import {
	CalDavCalendarEventMutationError,
	CalendarEventMutationFailureCode,
} from '../../nodes/CalDav/events/mutations';
import {
	CalDavCalendarEventUidResolutionError,
	CalendarEventUidResolutionFailureCode,
} from '../../nodes/CalDav/events/resolveByUid';
import type { CalendarEventReadResult } from '../../nodes/CalDav/icalendar/eventReadModel';
import {
	CalDavAuthenticationError,
	CalDavAuthorizationError,
	CalDavNotFoundError,
	CalDavRemoteProtocolError,
} from '../../nodes/CalDav/transport/http';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';

const NODE: INode = {
	id: 'event-delete-node',
	name: 'CalDAV Event Delete',
	type: 'calDav',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

const TRANSPORT = {
	serverUrl: 'https://configured.example.test/',
	request: vi.fn(),
};

interface EventDeleteParameters {
	readonly resource: unknown;
	readonly operation: unknown;
	readonly calendar: unknown;
	readonly identifierMode: unknown;
	readonly resourceUrl: unknown;
	readonly uid: unknown;
	readonly etag: unknown;
}

function locator(value: unknown, mode: unknown = 'url'): unknown {
	return { __rl: true, mode, value };
}

function parameters(
	identifierMode: unknown,
	identifier: unknown,
	overrides: Partial<EventDeleteParameters> = {},
): EventDeleteParameters {
	return {
		resource: 'event',
		operation: 'delete',
		calendar: locator('https://calendar.example.test/calendars/work'),
		identifierMode,
		resourceUrl:
			identifierMode === 'resourceUrl' ? identifier : 'hidden-resource-url-private-sentinel',
		uid: identifierMode === 'uid' ? identifier : 'hidden-uid-private-sentinel',
		etag: undefined,
		...overrides,
	};
}

function context(
	itemParameters: readonly EventDeleteParameters[],
	options: {
		readonly continueOnFail?: boolean;
		readonly input?: INodeExecutionData[];
	} = {},
): IExecuteFunctions {
	return {
		getInputData: vi
			.fn()
			.mockReturnValue(
				options.input ??
					itemParameters.map((_item, index) => ({ json: { privateInput: `input-${index}` } })),
			),
		getNodeParameter: vi.fn((name: keyof EventDeleteParameters, index: number) =>
			Reflect.get(itemParameters[index], name),
		),
		getNode: vi.fn().mockReturnValue(NODE),
		continueOnFail: vi.fn().mockReturnValue(options.continueOnFail ?? false),
	} as unknown as IExecuteFunctions;
}

function resolvedEvent(
	uid: string,
	overrides: Partial<CalendarEventReadResult['event']> = {},
): CalendarEventReadResult {
	const calendarUrl = validateAbsoluteHttpUrl('https://calendar.example.test/calendars/work/');
	const resourceUrl = validateAbsoluteHttpUrl(
		`https://calendar.example.test/calendars/work/${encodeURIComponent(uid)}.ics`,
	);
	return {
		event: {
			calendarUrl,
			resourceUrl,
			etag: 'W/"resolved-etag"',
			uid,
			start: '2040-01-02T10:00:00Z',
			end: '2040-01-02T10:30:00Z',
			...overrides,
		},
		context: {
			resource: {
				kind: 'resource',
				originalIcs: 'private-ics-sentinel',
				calendar: { kind: 'component', name: 'VCALENDAR', entries: [] },
			},
			master: { kind: 'component', name: 'VEVENT', entries: [] },
			exceptions: [],
		},
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

async function captureError(executionContext: IExecuteFunctions): Promise<Error> {
	try {
		await new CalDav().execute.call(executionContext);
	} catch (error) {
		return error as Error;
	}
	throw new Error('Expected Event Delete execution to fail.');
}

beforeEach(() => {
	mocks.createN8nCalDavTransport.mockReset().mockResolvedValue(TRANSPORT);
	mocks.deleteCalendarEventResource.mockReset().mockResolvedValue({
		statusCode: 204,
		resourceUrl: validateAbsoluteHttpUrl(
			'https://calendar.example.test/calendars/work/deleted.ics',
		),
	});
	mocks.getCalendarEventByResourceUrl.mockReset();
	mocks.resolveCalendarEventByUid.mockReset();
	TRANSPORT.request.mockReset();
});

describe('CalDAV Event Delete metadata', () => {
	it('adds Delete after the existing Event read operations without changing their defaults', () => {
		const operation = property(new CalDav().description.properties, 'operation', 'event');

		expect(operation).toMatchObject({
			displayName: 'Operation',
			name: 'operation',
			type: 'options',
			noDataExpression: true,
			displayOptions: { show: { resource: ['event'] } },
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

	it('reuses the Calendar and identifier fields for Delete and exposes one optional ETag', () => {
		const properties = new CalDav().description.properties;

		expect(property(properties, 'calendar')).toMatchObject({
			required: true,
			default: { mode: 'url', value: '' },
			displayOptions: {
				show: {
					resource: ['calendar', 'event'],
					operation: expect.arrayContaining(['get', 'getMany', 'delete']),
				},
				hide: { resource: ['calendar'], operation: ['getMany'] },
			},
		});
		expect(property(properties, 'identifierMode')).toMatchObject({
			required: true,
			noDataExpression: true,
			default: 'resourceUrl',
			options: [
				{ name: 'Resource URL', value: 'resourceUrl' },
				{ name: 'UID', value: 'uid' },
			],
			displayOptions: {
				show: { resource: ['event'], operation: ['get', 'update', 'delete'] },
			},
		});
		expect(property(properties, 'resourceUrl')).toMatchObject({
			type: 'string',
			required: true,
			default: '',
			displayOptions: {
				show: {
					resource: ['event'],
					operation: ['get', 'update', 'delete'],
					identifierMode: ['resourceUrl'],
				},
			},
		});
		expect(property(properties, 'uid', 'event', 'delete')).toMatchObject({
			type: 'string',
			required: true,
			default: '',
			displayOptions: {
				show: {
					resource: ['event'],
					operation: ['get', 'update', 'delete'],
					identifierMode: ['uid'],
				},
			},
		});
		const etag = property(properties, 'etag');
		expect(etag).toMatchObject({
			displayName: 'ETag',
			name: 'etag',
			type: 'string',
			default: '',
			displayOptions: { show: { resource: ['event'], operation: ['update', 'delete'] } },
		});
		expect(etag.required).toBeUndefined();
		expect(etag.noDataExpression).toBeUndefined();
	});
});

describe('CalDAV Event Delete exact resolution, validator, and output', () => {
	it.each(['url', 'list'] as const)(
		'resolves Resource URL mode in the selected %s Calendar and passes a supplied opaque ETag unchanged',
		async (calendarMode) => {
			const event = resolvedEvent('resource-mode@example.test');
			const requestedResourceUrl =
				'https://calendar.example.test/calendars/work/arbitrary-name.ics';
			const suppliedEtag = ' W/"opaque supplied validator" ';
			mocks.getCalendarEventByResourceUrl.mockResolvedValue(event);
			const executionContext = context([
				parameters('resourceUrl', requestedResourceUrl, {
					calendar: locator('https://calendar.example.test/calendars/work', calendarMode),
					etag: suppliedEtag,
				}),
			]);

			await expect(new CalDav().execute.call(executionContext)).resolves.toEqual([
				[
					{
						json: {
							calendarUrl: event.event.calendarUrl,
							resourceUrl: event.event.resourceUrl,
							uid: event.event.uid,
							deleted: true,
						},
						pairedItem: { item: 0 },
					},
				],
			]);
			expect(mocks.getCalendarEventByResourceUrl).toHaveBeenCalledWith(
				TRANSPORT,
				'https://calendar.example.test/calendars/work/',
				requestedResourceUrl,
				{ allowMissingEtag: true },
			);
			expect(mocks.deleteCalendarEventResource).toHaveBeenCalledWith(
				TRANSPORT,
				event.event.calendarUrl,
				event.event.resourceUrl,
				suppliedEtag,
			);
			expect(mocks.resolveCalendarEventByUid).not.toHaveBeenCalled();
			expect(executionContext.getNodeParameter).not.toHaveBeenCalledWith('uid', 0);
			expect(TRANSPORT.request).not.toHaveBeenCalled();
		},
	);

	it('delegates UID resolution only within the selected calendar and never guesses a resource path', async () => {
		const uid = ' ../Other/Case%2FEvent.ics?occurrence=one ';
		const event = resolvedEvent(uid);
		mocks.resolveCalendarEventByUid.mockResolvedValue(event);

		await expect(new CalDav().execute.call(context([parameters('uid', uid)]))).resolves.toEqual([
			[
				{
					json: {
						calendarUrl: event.event.calendarUrl,
						resourceUrl: event.event.resourceUrl,
						uid,
						deleted: true,
					},
					pairedItem: { item: 0 },
				},
			],
		]);
		expect(mocks.resolveCalendarEventByUid).toHaveBeenCalledWith(
			TRANSPORT,
			'https://calendar.example.test/calendars/work/',
			uid,
			{ allowMissingEtag: true },
		);
		expect(mocks.deleteCalendarEventResource).toHaveBeenCalledWith(
			TRANSPORT,
			event.event.calendarUrl,
			event.event.resourceUrl,
			event.event.etag,
		);
		expect(mocks.getCalendarEventByResourceUrl).not.toHaveBeenCalled();
		expect(TRANSPORT.request).not.toHaveBeenCalled();
	});

	it.each([
		['undefined absence', undefined, 'W/"resolved-etag"'],
		['empty optional UI field', '', 'W/"resolved-etag"'],
		['whitespace-only caller value', '   ', '   '],
	] as const)('uses the resolved ETag only for %s', async (_label, supplied, expected) => {
		const event = resolvedEvent('validator@example.test');
		mocks.getCalendarEventByResourceUrl.mockResolvedValue(event);

		await new CalDav().execute.call(
			context([
				parameters('resourceUrl', event.event.resourceUrl, {
					etag: supplied,
				}),
			]),
		);

		expect(mocks.deleteCalendarEventResource).toHaveBeenCalledWith(
			TRANSPORT,
			event.event.calendarUrl,
			event.event.resourceUrl,
			expected,
		);
	});

	it('keeps a server-derived empty ETag present after an empty UI sentinel', async () => {
		const event = resolvedEvent('server-empty-etag@example.test', { etag: '' });
		mocks.getCalendarEventByResourceUrl.mockResolvedValue(event);

		await new CalDav().execute.call(
			context([parameters('resourceUrl', event.event.resourceUrl, { etag: '' })]),
		);

		expect(mocks.deleteCalendarEventResource).toHaveBeenCalledWith(
			TRANSPORT,
			event.event.calendarUrl,
			event.event.resourceUrl,
			'',
		);
	});

	it.each([
		['undefined UI absence', undefined],
		['empty UI sentinel', ''],
	] as const)(
		'stops after exact resolution for %s when no remote ETag exists',
		async (_label, uiEtag) => {
			const event = resolvedEvent('missing-etag@example.test', { etag: undefined });
			mocks.getCalendarEventByResourceUrl.mockResolvedValue(event);

			const error = await captureError(
				context([parameters('resourceUrl', event.event.resourceUrl, { etag: uiEtag })]),
			);

			expect(error).toBeInstanceOf(NodeApiError);
			expect(error.message).toBe(
				'The calendar event does not provide an ETag required for a safe mutation.',
			);
			expect((error as NodeApiError).context.itemIndex).toBe(0);
			expect(mocks.deleteCalendarEventResource).not.toHaveBeenCalled();
			expect(TRANSPORT.request).not.toHaveBeenCalled();
		},
	);

	it('uses exactly one resolver and one conditional-delete boundary call per successful input item', async () => {
		const first = resolvedEvent('first@example.test');
		const second = resolvedEvent('second@example.test');
		mocks.getCalendarEventByResourceUrl.mockResolvedValueOnce(first);
		mocks.resolveCalendarEventByUid.mockResolvedValueOnce(second);

		const [output] = await new CalDav().execute.call(
			context([
				parameters('resourceUrl', first.event.resourceUrl),
				parameters('uid', second.event.uid, { etag: '"second-supplied"' }),
			]),
		);

		expect(output).toEqual([
			{
				json: {
					calendarUrl: first.event.calendarUrl,
					resourceUrl: first.event.resourceUrl,
					uid: first.event.uid,
					deleted: true,
				},
				pairedItem: { item: 0 },
			},
			{
				json: {
					calendarUrl: second.event.calendarUrl,
					resourceUrl: second.event.resourceUrl,
					uid: second.event.uid,
					deleted: true,
				},
				pairedItem: { item: 1 },
			},
		]);
		expect(mocks.getCalendarEventByResourceUrl).toHaveBeenCalledTimes(1);
		expect(mocks.resolveCalendarEventByUid).toHaveBeenCalledTimes(1);
		expect(mocks.deleteCalendarEventResource).toHaveBeenCalledTimes(2);
		expect(mocks.deleteCalendarEventResource.mock.calls.map((call) => call[3])).toEqual([
			first.event.etag,
			'"second-supplied"',
		]);
	});
});

describe('CalDAV Event Delete configuration validation', () => {
	it.each([
		[
			'invalid Calendar',
			{ calendar: locator('https://user:secret@calendar.example.test/work/') },
			'The Calendar URL is invalid. Enter an absolute HTTP(S) calendar collection URL.',
		],
		[
			'invalid Resource URL',
			{ resourceUrl: '/private/event.ics' },
			'The Event Resource URL is invalid or does not belong to the selected calendar.',
		],
		[
			'invalid UID',
			{ identifierMode: 'uid', uid: '\u0000private-uid' },
			'UID must be a non-empty valid iCalendar text value.',
		],
	] as const)(
		'rejects %s before transport or service I/O',
		async (_label, overrides, expectedMessage) => {
			const error = await captureError(
				context([
					parameters(
						'resourceUrl',
						'https://calendar.example.test/calendars/work/event.ics',
						overrides,
					),
				]),
			);

			expect(error).toBeInstanceOf(NodeOperationError);
			expect(error.message).toBe(expectedMessage);
			expect((error as NodeOperationError).context.itemIndex).toBe(0);
			expect(mocks.createN8nCalDavTransport).not.toHaveBeenCalled();
			expect(mocks.getCalendarEventByResourceUrl).not.toHaveBeenCalled();
			expect(mocks.resolveCalendarEventByUid).not.toHaveBeenCalled();
			expect(mocks.deleteCalendarEventResource).not.toHaveBeenCalled();
			expect(String(error)).not.toMatch(/secret|private|calendar\.example\.test/);
		},
	);

	it('rejects an unsupported identifier mode before transport or service I/O', async () => {
		const error = await captureError(
			context([
				parameters('resourceUrl', 'https://calendar.example.test/calendars/work/event.ics', {
					identifierMode: 'id',
				}),
			]),
		);

		expect(error).toBeInstanceOf(NodeOperationError);
		expect(error.message).toBe('Unsupported CalDAV resource or operation.');
		expect((error as NodeOperationError).context.itemIndex).toBe(0);
		expect(mocks.createN8nCalDavTransport).not.toHaveBeenCalled();
	});

	it('rejects a non-string supplied ETag with a sanitized validation error before I/O', async () => {
		const error = await captureError(
			context([
				parameters('resourceUrl', 'https://calendar.example.test/calendars/work/event.ics', {
					etag: { private: 'etag-sentinel' },
				}),
			]),
		);

		expect(error).toBeInstanceOf(NodeOperationError);
		expect(error.message).not.toBe('Unsupported CalDAV resource or operation.');
		expect((error as NodeOperationError).context.itemIndex).toBe(0);
		expect(mocks.createN8nCalDavTransport).not.toHaveBeenCalled();
		expect(mocks.getCalendarEventByResourceUrl).not.toHaveBeenCalled();
		expect(mocks.deleteCalendarEventResource).not.toHaveBeenCalled();
		expect(String(error)).not.toMatch(/private|etag-sentinel/);
	});

	it('sanitizes a throwing ETag expression and supports the same failure with continue-on-fail', async () => {
		const item = parameters(
			'resourceUrl',
			'https://calendar.example.test/calendars/work/event.ics',
		);
		const executionContext = context([item]);
		vi.mocked(executionContext.getNodeParameter).mockImplementation((name) => {
			if (name === 'etag') throw new Error('private-etag-expression-sentinel');
			return Reflect.get(item, name);
		});

		const error = await captureError(executionContext);
		expect(error).toBeInstanceOf(NodeOperationError);
		expect(error.message).not.toBe('Unsupported CalDAV resource or operation.');
		expect((error as NodeOperationError).context.itemIndex).toBe(0);
		expect(String(error)).not.toContain('private-etag-expression-sentinel');
		expect(mocks.createN8nCalDavTransport).not.toHaveBeenCalled();

		vi.mocked(executionContext.continueOnFail).mockReturnValue(true);
		const [output] = await new CalDav().execute.call(executionContext);
		expect(output).toEqual([{ json: { error: expect.any(String) }, pairedItem: { item: 0 } }]);
		expect(JSON.stringify(output)).not.toContain('private-etag-expression-sentinel');
	});
});

describe('CalDAV Event Delete sanitized errors and continuation', () => {
	it('maps an outside-calendar mutation target to a sanitized domain invalid-response error', async () => {
		const event = resolvedEvent('outside-calendar@example.test');
		mocks.getCalendarEventByResourceUrl.mockResolvedValue(event);
		mocks.deleteCalendarEventResource.mockRejectedValue(
			new CalDavCalendarEventMutationError(CalendarEventMutationFailureCode.OUTSIDE_CALENDAR),
		);

		const error = await captureError(context([parameters('resourceUrl', event.event.resourceUrl)]));

		expect(error).toBeInstanceOf(NodeApiError);
		expect(error).not.toBeInstanceOf(NodeOperationError);
		expect(error.message).toBe(
			'The CalDAV server returned an invalid calendar-event mutation response.',
		);
		expect((error as NodeApiError).context.itemIndex).toBe(0);
		expect(String(error)).not.toMatch(/outside|calendar\.example\.test|outside-calendar/);
	});

	it('maps Resource URL resolution 404 to not-found and stops before DELETE', async () => {
		mocks.getCalendarEventByResourceUrl.mockRejectedValue(new CalDavNotFoundError(404));

		const error = await captureError(
			context([
				parameters('resourceUrl', 'https://calendar.example.test/calendars/work/missing-event.ics'),
			]),
		);

		expect(error).toBeInstanceOf(NodeApiError);
		expect(error.message).toBe('The calendar event was not found.');
		expect((error as NodeApiError).context).toMatchObject({ itemIndex: 0, httpCode: '404' });
		expect(mocks.deleteCalendarEventResource).not.toHaveBeenCalled();
	});

	it.each([
		[
			new CalDavCalendarEventUidResolutionError(CalendarEventUidResolutionFailureCode.NOT_FOUND),
			'The calendar event was not found.',
		],
		[
			new CalDavCalendarEventUidResolutionError(CalendarEventUidResolutionFailureCode.AMBIGUOUS),
			'More than one calendar event with the requested UID was found in the selected calendar.',
		],
	] as const)(
		'maps UID cardinality without leaking the requested UID',
		async (failure, message) => {
			mocks.resolveCalendarEventByUid.mockRejectedValue(failure);

			const error = await captureError(context([parameters('uid', 'private-uid-sentinel')]));

			expect(error).toBeInstanceOf(NodeApiError);
			expect(error.message).toBe(message);
			expect((error as NodeApiError).context.itemIndex).toBe(0);
			expect(String(error)).not.toContain('private-uid-sentinel');
			expect(mocks.deleteCalendarEventResource).not.toHaveBeenCalled();
		},
	);

	it.each([
		[new CalDavAuthenticationError(401), 'Event Delete authentication failed.', '401'],
		[new CalDavNotFoundError(404), 'The calendar event was not found.', '404'],
		[new CalDavAuthorizationError(403), 'Event Delete is not authorized.', '403'],
		[
			new CalDavCalendarEventMutationError(CalendarEventMutationFailureCode.CONCURRENCY_CONFLICT),
			'The calendar event changed before the mutation could be applied.',
			undefined,
		],
		[
			new CalDavCalendarEventMutationError(CalendarEventMutationFailureCode.MISSING_ETAG),
			'The calendar event does not provide an ETag required for a safe mutation.',
			undefined,
		],
		[
			new CalDavCalendarEventMutationError(CalendarEventMutationFailureCode.INVALID_RESPONSE),
			'The CalDAV server returned an invalid calendar-event mutation response.',
			undefined,
		],
	] as const)(
		'maps a delete-boundary failure to a fixed NodeApiError',
		async (failure, message, httpCode) => {
			const event = resolvedEvent('delete-error@example.test');
			mocks.getCalendarEventByResourceUrl.mockResolvedValue(event);
			mocks.deleteCalendarEventResource.mockRejectedValue(failure);

			const error = await captureError(
				context([parameters('resourceUrl', event.event.resourceUrl)]),
			);

			expect(error).toBeInstanceOf(NodeApiError);
			expect(error.message).toBe(message);
			expect((error as NodeApiError).context.itemIndex).toBe(0);
			if (httpCode !== undefined) {
				expect((error as NodeApiError).context.httpCode).toBe(httpCode);
			}
			expect(mocks.deleteCalendarEventResource).toHaveBeenCalledTimes(1);
		},
	);

	it('does not relabel HTTP 409 as concurrency and never leaks remote details', async () => {
		const event = resolvedEvent('conflict-private-uid@example.test');
		mocks.getCalendarEventByResourceUrl.mockResolvedValue(event);
		mocks.deleteCalendarEventResource.mockRejectedValue(new CalDavRemoteProtocolError(409));

		const error = await captureError(
			context([
				parameters('resourceUrl', event.event.resourceUrl, {
					etag: 'private-etag-sentinel',
				}),
			]),
		);

		expect(error).toBeInstanceOf(NodeApiError);
		expect(error.message).not.toBe(
			'The calendar event changed before the mutation could be applied.',
		);
		expect((error as NodeApiError).context.httpCode).toBe('409');
		expect(String(error)).not.toMatch(
			/private|conflict-private-uid|etag-sentinel|calendar\.example\.test/,
		);
	});

	it('projects an unknown lower failure to one generic private-data-safe message', async () => {
		const event = resolvedEvent('private-uid@example.test');
		mocks.getCalendarEventByResourceUrl.mockResolvedValue(event);
		mocks.deleteCalendarEventResource.mockRejectedValue(
			Object.assign(new Error('private response body and /users/account/path'), {
				headers: { authorization: 'private-auth-value', etag: 'private-etag' },
				body: 'private-ics-resource-body',
			}),
		);

		const error = await captureError(context([parameters('resourceUrl', event.event.resourceUrl)]));

		expect(error).toBeInstanceOf(NodeApiError);
		expect(error.message).toBe('Event Delete failed.');
		expect(String(error)).not.toMatch(
			/private|authorization|etag|ics-resource|account\/path|calendar\.example\.test/,
		);
	});

	it('stops at the first failure without resolving or deleting later items', async () => {
		const first = resolvedEvent('first@example.test');
		mocks.getCalendarEventByResourceUrl.mockResolvedValueOnce(first);
		mocks.deleteCalendarEventResource.mockRejectedValueOnce(new CalDavNotFoundError(404));

		const error = await captureError(
			context([
				parameters('resourceUrl', first.event.resourceUrl),
				parameters('uid', 'later@example.test'),
			]),
		);

		expect(error).toBeInstanceOf(NodeApiError);
		expect(mocks.getCalendarEventByResourceUrl).toHaveBeenCalledTimes(1);
		expect(mocks.resolveCalendarEventByUid).not.toHaveBeenCalled();
		expect(mocks.deleteCalendarEventResource).toHaveBeenCalledTimes(1);
	});

	it('preserves input order and exact pairing with continue-on-fail', async () => {
		const first = resolvedEvent('ambiguous@example.test');
		const second = resolvedEvent('second@example.test');
		const third = resolvedEvent('third@example.test');
		mocks.resolveCalendarEventByUid.mockRejectedValueOnce(
			new CalDavCalendarEventUidResolutionError(CalendarEventUidResolutionFailureCode.AMBIGUOUS),
		);
		mocks.getCalendarEventByResourceUrl.mockResolvedValueOnce(second).mockResolvedValueOnce(third);
		mocks.deleteCalendarEventResource
			.mockResolvedValueOnce({ statusCode: 204, resourceUrl: second.event.resourceUrl })
			.mockRejectedValueOnce(new CalDavAuthorizationError(403));

		const [output] = await new CalDav().execute.call(
			context(
				[
					parameters('uid', first.event.uid, { etag: '' }),
					parameters('resourceUrl', second.event.resourceUrl, { etag: '' }),
					parameters('resourceUrl', third.event.resourceUrl, { etag: '   ' }),
				],
				{ continueOnFail: true },
			),
		);

		expect(output).toEqual([
			{
				json: {
					error:
						'More than one calendar event with the requested UID was found in the selected calendar.',
				},
				pairedItem: { item: 0 },
			},
			{
				json: {
					calendarUrl: second.event.calendarUrl,
					resourceUrl: second.event.resourceUrl,
					uid: second.event.uid,
					deleted: true,
				},
				pairedItem: { item: 1 },
			},
			{ json: { error: 'Event Delete is not authorized.' }, pairedItem: { item: 2 } },
		]);
		expect(mocks.deleteCalendarEventResource.mock.calls.map((call) => call[3])).toEqual([
			second.event.etag,
			'   ',
		]);
		expect(JSON.stringify(output)).not.toContain('private-ics-sentinel');
	});
});
