import type { IExecuteFunctions, INode, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	createN8nCalDavTransport: vi.fn(),
	getCalendarEventByResourceUrl: vi.fn(),
	resolveCalendarEventByUid: vi.fn(),
}));

vi.mock('../../nodes/CalDav/transport/http', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/transport/http')>()),
	createN8nCalDavTransport: mocks.createN8nCalDavTransport,
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
	CalDavCalendarEventResourceGetError,
	CalendarEventResourceGetFailureCode,
} from '../../nodes/CalDav/events/getByResourceUrl';
import {
	CalDavCalendarEventUidResolutionError,
	CalendarEventUidResolutionFailureCode,
} from '../../nodes/CalDav/events/resolveByUid';
import { CalDavCalendarEventReadModelError } from '../../nodes/CalDav/icalendar/eventReadModel';
import type { CalendarEventReadResult } from '../../nodes/CalDav/icalendar/eventReadModel';
import { CalDavICalendarParseError } from '../../nodes/CalDav/icalendar/parser';
import {
	CalDavAuthenticationError,
	CalDavAuthorizationError,
	CalDavInvalidRedirectError,
	CalDavNetworkError,
	CalDavNotFoundError,
	CalDavRemoteProtocolError,
	CalDavResponseLimitError,
	CalDavTimeoutError,
	CalDavTlsError,
	CalDavUntrustedTargetError,
} from '../../nodes/CalDav/transport/http';
import {
	CalDavUrlValidationError,
	validateAbsoluteHttpUrl,
} from '../../nodes/CalDav/transport/url';
import { XmlBuildError } from '../../nodes/CalDav/xml/errors';
import { CalDavXmlParseError, CalDavXmlProtocolError } from '../../nodes/CalDav/xml/parser';

const NODE: INode = {
	id: 'event-get-node',
	name: 'CalDAV Event Get',
	type: 'calDav',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

const TRANSPORT = {
	serverUrl: 'https://configured.example.test/',
	request: vi.fn(),
};

interface EventGetParameters {
	readonly resource: unknown;
	readonly operation: unknown;
	readonly calendar: unknown;
	readonly identifierMode: unknown;
	readonly resourceUrl: unknown;
	readonly uid: unknown;
}

function locator(value: unknown, mode: unknown = 'url'): unknown {
	return { __rl: true, mode, value };
}

function parameters(
	identifierMode: unknown,
	identifier: unknown,
	overrides: Partial<EventGetParameters> = {},
): EventGetParameters {
	return {
		resource: 'event',
		operation: 'get',
		calendar: locator('https://calendar.example.test/calendars/work'),
		identifierMode,
		resourceUrl: identifierMode === 'resourceUrl' ? identifier : 'hidden-resource-private',
		uid: identifierMode === 'uid' ? identifier : 'hidden-uid-private',
		...overrides,
	};
}

function context(
	itemParameters: readonly EventGetParameters[],
	options: {
		readonly continueOnFail?: boolean;
		readonly input?: INodeExecutionData[];
	} = {},
): IExecuteFunctions {
	const input =
		options.input ??
		itemParameters.map((_item, index) => ({ json: { inputPrivate: `input-${index}` } }));
	return {
		getInputData: vi.fn().mockReturnValue(input),
		getNodeParameter: vi.fn((name: keyof EventGetParameters, index: number) =>
			Reflect.get(itemParameters[index], name),
		),
		getNode: vi.fn().mockReturnValue(NODE),
		continueOnFail: vi.fn().mockReturnValue(options.continueOnFail ?? false),
	} as unknown as IExecuteFunctions;
}

function result(
	uid: string,
	overrides: Partial<CalendarEventReadResult['event']> = {},
): CalendarEventReadResult {
	const calendarUrl = validateAbsoluteHttpUrl('https://calendar.example.test/calendars/work/');
	const resourceUrl = validateAbsoluteHttpUrl(
		`https://calendar.example.test/calendars/work/${encodeURIComponent(uid)}`,
	);
	const event = Object.freeze({
		calendarUrl,
		resourceUrl,
		etag: ' W/"exact" ',
		uid,
		summary: '',
		description: 'Public description',
		location: 'Room',
		url: 'https://public.example.test/event',
		start: '2040-01-02T10:00:00Z' as CalendarEventReadResult['event']['start'],
		end: '2040-01-02T10:30:00Z' as CalendarEventReadResult['event']['end'],
		...overrides,
	});
	const privateResource = Object.freeze({
		kind: 'resource' as const,
		originalIcs: 'private-ics-sentinel',
		calendar: Object.freeze({
			kind: 'component' as const,
			name: 'VCALENDAR',
			entries: Object.freeze([]),
		}),
	});
	const privateMaster = Object.freeze({
		kind: 'component' as const,
		name: 'VEVENT',
		entries: Object.freeze([]),
	});
	return Object.freeze({
		event,
		context: Object.freeze({
			resource: privateResource,
			master: privateMaster,
			exceptions: Object.freeze([privateMaster]),
		}),
	});
}

function property(properties: readonly INodeProperties[], name: string, resource?: string) {
	const matches = properties.filter(
		(candidate) =>
			candidate.name === name &&
			(resource === undefined || candidate.displayOptions?.show?.resource?.includes(resource)),
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
	throw new Error('Expected Event Get execution to fail.');
}

beforeEach(() => {
	mocks.createN8nCalDavTransport.mockReset().mockResolvedValue(TRANSPORT);
	mocks.getCalendarEventByResourceUrl.mockReset();
	mocks.resolveCalendarEventByUid.mockReset();
	TRANSPORT.request.mockReset();
});

describe('CalDAV Event Get metadata', () => {
	it('adds Event after the default Calendar resource without changing the node identity', () => {
		const node = new CalDav();
		const resource = property(node.description.properties, 'resource');

		expect(node.description).toMatchObject({
			name: 'calDav',
			version: 1,
			inputs: ['main'],
			outputs: ['main'],
			usableAsTool: true,
			credentials: [{ name: 'calDavApi', required: true, testedBy: 'testCalDavApiCredentials' }],
		});
		expect(resource).toEqual({
			displayName: 'Resource',
			name: 'resource',
			type: 'options',
			noDataExpression: true,
			options: [
				{ name: 'Calendar', value: 'calendar' },
				{ name: 'Event', value: 'event' },
			],
			default: 'calendar',
		});
	});

	it('exposes only Get for Event with the exact display contract', () => {
		const operation = property(new CalDav().description.properties, 'operation', 'event');

		expect(operation).toEqual({
			displayName: 'Operation',
			name: 'operation',
			type: 'options',
			noDataExpression: true,
			displayOptions: { show: { resource: ['event'] } },
			options: [
				{
					name: 'Get',
					value: 'get',
					description: 'Retrieve a calendar event',
					action: 'Retrieve a calendar event',
				},
			],
			default: 'get',
		});
	});

	it('reuses the exact required Calendar locator for Event Get', () => {
		const calendar = property(new CalDav().description.properties, 'calendar');

		expect(calendar).toMatchObject({
			displayName: 'Calendar',
			name: 'calendar',
			type: 'resourceLocator',
			required: true,
			default: { mode: 'url', value: '' },
			displayOptions: {
				show: { resource: expect.arrayContaining(['calendar', 'event']), operation: ['get'] },
			},
			modes: [
				{
					displayName: 'From List',
					name: 'list',
					type: 'list',
					typeOptions: { searchListMethod: 'searchCalendars', searchable: true },
				},
				{
					displayName: 'By URL',
					name: 'url',
					type: 'string',
					hint: expect.any(String),
				},
			],
		});
	});

	it('defines the identifier selector and expression-capable conditional inputs exactly', () => {
		const properties = new CalDav().description.properties;

		expect(property(properties, 'identifierMode')).toMatchObject({
			displayName: 'Identifier Mode',
			name: 'identifierMode',
			type: 'options',
			required: true,
			noDataExpression: true,
			options: [
				{ name: 'Resource URL', value: 'resourceUrl' },
				{ name: 'UID', value: 'uid' },
			],
			default: 'resourceUrl',
			displayOptions: { show: { resource: ['event'], operation: ['get'] } },
		});
		const resourceUrl = property(properties, 'resourceUrl');
		expect(resourceUrl).toMatchObject({
			displayName: 'Resource URL',
			name: 'resourceUrl',
			type: 'string',
			required: true,
			default: '',
			displayOptions: {
				show: { resource: ['event'], operation: ['get'], identifierMode: ['resourceUrl'] },
			},
		});
		expect(resourceUrl.noDataExpression).toBeUndefined();
		const uid = property(properties, 'uid');
		expect(uid).toMatchObject({
			displayName: 'UID',
			name: 'uid',
			type: 'string',
			required: true,
			default: '',
			displayOptions: {
				show: { resource: ['event'], operation: ['get'], identifierMode: ['uid'] },
			},
		});
		expect(uid.noDataExpression).toBeUndefined();
	});
});

describe('CalDAV Event Get dispatch and output', () => {
	it.each(['url', 'list'] as const)(
		'normalizes the %s Calendar locator and delegates Resource URL mode exclusively',
		async (locatorMode) => {
			const event = result('resource-mode@example.test');
			mocks.getCalendarEventByResourceUrl.mockResolvedValue(event);
			const resource = 'https://calendar.example.test/calendars/work/arbitrary%2Fname?opaque=1';
			const executionContext = context([
				parameters('resourceUrl', resource, {
					calendar: locator('https://calendar.example.test/calendars/work', locatorMode),
				}),
			]);

			await expect(new CalDav().execute.call(executionContext)).resolves.toEqual([
				[{ json: event.event, pairedItem: { item: 0 } }],
			]);
			expect(mocks.getCalendarEventByResourceUrl).toHaveBeenCalledWith(
				TRANSPORT,
				'https://calendar.example.test/calendars/work/',
				resource,
			);
			expect(mocks.resolveCalendarEventByUid).not.toHaveBeenCalled();
			expect(executionContext.getNodeParameter).not.toHaveBeenCalledWith('uid', 0);
		},
	);

	it('passes an opaque UID unchanged only to the scoped resolver and never guesses a path', async () => {
		const uid = ' ../Other/Case%2FEvent.ics?occurrence=one ';
		const event = result(uid);
		mocks.resolveCalendarEventByUid.mockResolvedValue(event);
		const executionContext = context([parameters('uid', uid)]);

		await expect(new CalDav().execute.call(executionContext)).resolves.toEqual([
			[{ json: event.event, pairedItem: { item: 0 } }],
		]);
		expect(mocks.resolveCalendarEventByUid).toHaveBeenCalledWith(
			TRANSPORT,
			'https://calendar.example.test/calendars/work/',
			uid,
		);
		expect(mocks.getCalendarEventByResourceUrl).not.toHaveBeenCalled();
		expect(TRANSPORT.request).not.toHaveBeenCalled();
		expect(executionContext.getNodeParameter).not.toHaveBeenCalledWith('resourceUrl', 0);
	});

	it('emits only the stable provider-neutral projection and strips recurrence/context data', async () => {
		const event = result('recurring@example.test', {
			extensions: { synthetic: { privateValue: 'private-extension-sentinel' } },
		});
		mocks.getCalendarEventByResourceUrl.mockResolvedValue(event);

		const [[output]] = await new CalDav().execute.call(
			context([parameters('resourceUrl', event.event.resourceUrl)]),
		);

		expect(Object.keys(output.json)).toEqual([
			'calendarUrl',
			'resourceUrl',
			'etag',
			'uid',
			'summary',
			'description',
			'location',
			'url',
			'start',
			'end',
		]);
		expect(output).toEqual({ json: event.event, pairedItem: { item: 0 } });
		expect(output.json).not.toHaveProperty('context');
		expect(output.json).not.toHaveProperty('extensions');
		expect(output.json).not.toHaveProperty('id');
		expect(JSON.stringify(output)).not.toContain('private-ics-sentinel');
	});

	it('omits missing optional fields while preserving empty UID and ETag values', async () => {
		const event = result('', {
			etag: '',
			summary: undefined,
			description: undefined,
			location: undefined,
			url: undefined,
		});
		mocks.getCalendarEventByResourceUrl.mockResolvedValue(event);

		const [[output]] = await new CalDav().execute.call(
			context([
				parameters('resourceUrl', 'https://calendar.example.test/calendars/work/empty-values'),
			]),
		);

		expect(output.json).toEqual({
			calendarUrl: event.event.calendarUrl,
			resourceUrl: event.event.resourceUrl,
			etag: '',
			uid: '',
			start: '2040-01-02T10:00:00Z',
			end: '2040-01-02T10:30:00Z',
		});
	});

	it('processes each item in order with exact pairing and per-index parameter reads', async () => {
		const first = result('first@example.test');
		const second = result('second@example.test');
		mocks.getCalendarEventByResourceUrl.mockResolvedValueOnce(first);
		mocks.resolveCalendarEventByUid.mockResolvedValueOnce(second);
		const executionContext = context([
			parameters('resourceUrl', 'https://calendar.example.test/calendars/work/first'),
			parameters('uid', 'second@example.test'),
		]);

		await expect(new CalDav().execute.call(executionContext)).resolves.toEqual([
			[
				{ json: first.event, pairedItem: { item: 0 } },
				{ json: second.event, pairedItem: { item: 1 } },
			],
		]);
		for (const index of [0, 1]) {
			for (const name of ['resource', 'operation', 'calendar', 'identifierMode']) {
				expect(executionContext.getNodeParameter).toHaveBeenCalledWith(name, index);
			}
		}
	});
});

describe('CalDAV Event Get configuration validation', () => {
	it.each([
		['null locator', null],
		['missing locator marker', { mode: 'url', value: 'https://calendar.example.test/work/' }],
		[
			'false locator marker',
			{ __rl: false, mode: 'url', value: 'https://calendar.example.test/work/' },
		],
		['unsupported locator mode', locator('https://calendar.example.test/work/', 'id')],
		['empty locator value', locator('')],
		['relative locator value', locator('/calendar/')],
		['locator userinfo', locator('https://user:secret@calendar.example.test/work/')],
		['locator fragment', locator('https://calendar.example.test/work/#private')],
	] as const)(
		'rejects %s as an item-indexed operation error before service I/O',
		async (_label, calendar) => {
			const error = await captureError(
				context([
					parameters('uid', 'private-uid-sentinel', {
						calendar,
					}),
				]),
			);

			expect(error).toBeInstanceOf(NodeOperationError);
			expect(error.message).toBe(
				'The Calendar URL is invalid. Enter an absolute HTTP(S) calendar collection URL.',
			);
			expect((error as NodeOperationError).context.itemIndex).toBe(0);
			expect(mocks.createN8nCalDavTransport).not.toHaveBeenCalled();
			expect(mocks.getCalendarEventByResourceUrl).not.toHaveBeenCalled();
			expect(mocks.resolveCalendarEventByUid).not.toHaveBeenCalled();
			expect(String(error)).not.toMatch(/secret|private-uid-sentinel|calendar\.example\.test/);
		},
	);

	it.each([
		['unsupported resource', { resource: 'contact' }],
		['unsupported operation', { operation: 'getMany' }],
		['unsupported mode', { identifierMode: 'id' }],
	] as const)('rejects %s before acquisition', async (_label, overrides) => {
		const error = await captureError(
			context([parameters('resourceUrl', 'https://calendar.example.test/work/event', overrides)]),
		);

		expect(error).toBeInstanceOf(NodeOperationError);
		expect(error.message).toBe('Unsupported CalDAV resource or operation.');
		expect((error as NodeOperationError).context.itemIndex).toBe(0);
		expect(mocks.createN8nCalDavTransport).not.toHaveBeenCalled();
		expect(mocks.getCalendarEventByResourceUrl).not.toHaveBeenCalled();
		expect(mocks.resolveCalendarEventByUid).not.toHaveBeenCalled();
	});

	it.each([
		['empty', ''],
		['whitespace', ' '],
		['relative', '/calendars/work/event.ics'],
		['userinfo', 'https://user:secret@calendar.example.test/work/event.ics'],
		['fragment', 'https://calendar.example.test/work/event.ics#private'],
		['control', 'https://calendar.example.test/work/event.ics\nprivate'],
		['malformed percent', 'https://calendar.example.test/work/%ZZ'],
		['dot segment', 'https://calendar.example.test/work/%2e%2e/private'],
		['scheme', 'ftp://calendar.example.test/work/event.ics'],
	] as const)(
		'rejects an %s Resource URL before transport or service I/O',
		async (_label, value) => {
			const error = await captureError(context([parameters('resourceUrl', value)]));

			expect(error).toBeInstanceOf(NodeOperationError);
			expect(error.message).toBe(
				'The Event Resource URL is invalid or does not belong to the selected calendar.',
			);
			expect((error as NodeOperationError).context.itemIndex).toBe(0);
			expect(mocks.createN8nCalDavTransport).not.toHaveBeenCalled();
			expect(mocks.getCalendarEventByResourceUrl).not.toHaveBeenCalled();
			expect(String(error)).not.toMatch(/secret|calendar\.example\.test|private/);
		},
	);

	it('rejects an empty UID before transport or resolver I/O', async () => {
		const uid = '';
		const error = await captureError(context([parameters('uid', uid)]));

		expect(error).toBeInstanceOf(NodeOperationError);
		expect(error.message).toBe('UID must be a non-empty valid iCalendar text value.');
		expect((error as NodeOperationError).context.itemIndex).toBe(0);
		expect(mocks.createN8nCalDavTransport).not.toHaveBeenCalled();
		expect(mocks.resolveCalendarEventByUid).not.toHaveBeenCalled();
		expect(String(error)).not.toContain('private-uid');
	});
});

describe('CalDAV Event Get sanitized errors and continuation', () => {
	it.each([
		[new CalDavAuthenticationError(401), 'Event Get authentication failed.'],
		[new CalDavAuthorizationError(403), 'Event Get is not authorized.'],
		[new CalDavNotFoundError(404), 'The calendar event was not found.'],
		[new CalDavTlsError(), 'TLS certificate validation failed.'],
		[new CalDavTimeoutError(), 'Event Get timed out.'],
		[new CalDavResponseLimitError(), 'The Event Get response exceeded the size limit.'],
		[
			new CalDavInvalidRedirectError(302),
			'The CalDAV server returned an unsafe or invalid redirect.',
		],
		[new CalDavUntrustedTargetError(), 'The Event Resource URL targets an untrusted endpoint.'],
		[new CalDavNetworkError(), 'The CalDAV server could not be reached.'],
		[
			new CalDavICalendarParseError('INVALID_CONTENT_LINE'),
			'The CalDAV server returned malformed iCalendar event data.',
		],
		[
			new CalDavCalendarEventReadModelError('NOT_VEVENT_RESOURCE'),
			'The calendar event uses an unsupported event representation.',
		],
		[
			new CalDavCalendarEventUidResolutionError(
				CalendarEventUidResolutionFailureCode.INVALID_RESPONSE,
			),
			'The CalDAV server returned an invalid calendar-event response.',
		],
		[
			new CalDavCalendarEventResourceGetError(CalendarEventResourceGetFailureCode.INVALID_RESPONSE),
			'The CalDAV server returned an invalid calendar-event response.',
		],
		[
			new CalDavXmlProtocolError('INVALID_RESPONSE'),
			'The CalDAV server returned an invalid calendar-event response.',
		],
		[
			new CalDavXmlParseError('MALFORMED_XML'),
			'The CalDAV server returned an invalid calendar-event response.',
		],
		[
			new CalDavRemoteProtocolError(502),
			'The CalDAV server returned an invalid calendar-event response.',
		],
		[
			new CalDavUrlValidationError('INSECURE_PROTOCOL_DOWNGRADE'),
			'The CalDAV server returned an invalid calendar-event response.',
		],
		[new Error('private-native-sentinel'), 'Event Get failed.'],
	] as const)('maps a lower failure to exact safe NodeApiError %s', async (failure, message) => {
		mocks.getCalendarEventByResourceUrl.mockRejectedValue(failure);
		const error = await captureError(
			context([
				parameters('resourceUrl', 'https://calendar.example.test/calendars/work/private-event'),
			]),
		);

		expect(error).toBeInstanceOf(NodeApiError);
		expect(error.message).toBe(message);
		expect((error as NodeApiError).context.itemIndex).toBe(0);
		expect(String(error)).not.toMatch(/private|calendar\.example\.test|native-sentinel/);
	});

	it.each([
		[
			new CalDavCalendarEventResourceGetError(CalendarEventResourceGetFailureCode.OUTSIDE_CALENDAR),
			'The Event Resource URL is invalid or does not belong to the selected calendar.',
		],
		[
			new XmlBuildError('INVALID_UID', 'private UID build detail', 'uid'),
			'UID must be a non-empty valid iCalendar text value.',
		],
	] as const)(
		'maps a configuration failure to exact safe NodeOperationError',
		async (failure, message) => {
			const mode = failure instanceof XmlBuildError ? 'uid' : 'resourceUrl';
			const value =
				mode === 'uid'
					? 'valid-until-builder@example.test'
					: 'https://calendar.example.test/calendars/work/private-event';
			const acquisition =
				mode === 'uid' ? mocks.resolveCalendarEventByUid : mocks.getCalendarEventByResourceUrl;
			acquisition.mockRejectedValue(failure);

			const error = await captureError(context([parameters(mode, value)]));

			expect(error).toBeInstanceOf(NodeOperationError);
			expect(error.message).toBe(message);
			expect((error as NodeOperationError).context.itemIndex).toBe(0);
			expect(String(error)).not.toMatch(/private|calendar\.example\.test|build detail/);
		},
	);

	it.each([
		[
			new CalDavCalendarEventUidResolutionError(CalendarEventUidResolutionFailureCode.NOT_FOUND),
			'The calendar event was not found.',
		],
		[
			new CalDavCalendarEventUidResolutionError(CalendarEventUidResolutionFailureCode.AMBIGUOUS),
			'More than one calendar event with the requested UID was found in the selected calendar.',
		],
	] as const)('maps UID cardinality failure without leaking the UID', async (failure, message) => {
		mocks.resolveCalendarEventByUid.mockRejectedValue(failure);
		const error = await captureError(context([parameters('uid', 'private-uid-sentinel')]));

		expect(error).toBeInstanceOf(NodeApiError);
		expect(error.message).toBe(message);
		expect(String(error)).not.toContain('private-uid-sentinel');
	});

	it('stops on the first failed item when continue-on-fail is disabled', async () => {
		mocks.getCalendarEventByResourceUrl
			.mockResolvedValueOnce(result('first@example.test'))
			.mockRejectedValueOnce(new CalDavNotFoundError(404))
			.mockResolvedValueOnce(result('third@example.test'));
		const executionContext = context(
			['first', 'second', 'third'].map((name) =>
				parameters('resourceUrl', `https://calendar.example.test/calendars/work/${name}`),
			),
		);

		const error = await captureError(executionContext);

		expect(error).toBeInstanceOf(NodeApiError);
		expect((error as NodeApiError).context.itemIndex).toBe(1);
		expect(mocks.getCalendarEventByResourceUrl).toHaveBeenCalledTimes(2);
	});

	it('emits exact success/error/success order and pairing when continue-on-fail is enabled', async () => {
		const first = result('first@example.test');
		const third = result('third@example.test');
		mocks.getCalendarEventByResourceUrl
			.mockResolvedValueOnce(first)
			.mockRejectedValueOnce(new Error('private-native-sentinel'))
			.mockResolvedValueOnce(third);
		const executionContext = context(
			['first', 'second', 'third'].map((name) =>
				parameters('resourceUrl', `https://calendar.example.test/calendars/work/${name}`),
			),
			{ continueOnFail: true },
		);

		await expect(new CalDav().execute.call(executionContext)).resolves.toEqual([
			[
				{ json: first.event, pairedItem: { item: 0 } },
				{ json: { error: 'Event Get failed.' }, pairedItem: { item: 1 } },
				{ json: third.event, pairedItem: { item: 2 } },
			],
		]);
		expect(mocks.getCalendarEventByResourceUrl).toHaveBeenCalledTimes(3);
	});
});
