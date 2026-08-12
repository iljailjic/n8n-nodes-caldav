import { afterEach, describe, expect, it, vi } from 'vitest';

import * as calendarCollectionDiscovery from '../../nodes/CalDav/discovery/calendarCollections';
import {
	CalDavCalendarCollectionDiscoveryError,
	CalendarCollectionDiscoveryFailureCode,
	discoverCalendarCollections,
} from '../../nodes/CalDav/discovery/calendarCollections';
import type { CalendarCollection } from '../../nodes/CalDav/discovery/calendarCollections';
import { iCloudCalDavProviderAdapter } from '../../nodes/CalDav/providers/icloud';
import { CalDavMethod } from '../../nodes/CalDav/transport/http';
import type {
	CalDavTransport,
	CalDavTransportRequest,
	CalDavTransportResponse,
} from '../../nodes/CalDav/transport/http';
import {
	CalDavUrlValidationError,
	validateAbsoluteHttpUrl,
} from '../../nodes/CalDav/transport/url';

const CALENDAR_COLLECTION_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <c:calendar-description/>
    <c:calendar-timezone/>
    <c:supported-calendar-component-set/>
    <d:current-user-privilege-set/>
  </d:prop>
</d:propfind>`;

type MockTransport = CalDavTransport & { request: ReturnType<typeof vi.fn> };

function transportResponse(
	xml: string,
	statusCode = 207,
	effectiveUrl = 'https://partition.example.test/homes/account/',
): CalDavTransportResponse {
	return {
		statusCode,
		headers: {},
		effectiveUrl,
		body: Buffer.from(xml),
	};
}

function mockTransport(
	implementation: (input: CalDavTransportRequest) => Promise<CalDavTransportResponse> = async () =>
		transportResponse(multistatus('')),
): MockTransport {
	return {
		serverUrl: 'https://configured.example.test/',
		request: vi.fn(implementation),
	};
}

function propstat(properties: string, status = 'HTTP/1.1 200 OK'): string {
	return `<d:propstat><d:prop>${properties}</d:prop><d:status>${status}</d:status></d:propstat>`;
}

function response(href: string, propstats: string): string {
	return `<d:response><d:href>${href}</d:href>${propstats}</d:response>`;
}

function multistatus(responses: string, namespaces = ''): string {
	return `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"${namespaces}>${responses}</d:multistatus>`;
}

function resourceType(...types: string[]): string {
	return `<d:resourcetype>${types.join('')}</d:resourcetype>`;
}

function calendarResourceType(extra = ''): string {
	return resourceType('<d:collection/>', '<c:calendar/>', extra);
}

function componentSet(...components: string[]): string {
	return `<c:supported-calendar-component-set>${components
		.map((component) => `<c:comp name="${component}"/>`)
		.join('')}</c:supported-calendar-component-set>`;
}

function privilegeSet(...privileges: string[]): string {
	return `<d:current-user-privilege-set>${privileges
		.map((privilege) => `<d:privilege><d:${privilege}/></d:privilege>`)
		.join('')}</d:current-user-privilege-set>`;
}

function calendarResponse(href: string, properties = '', failedPropstats = ''): string {
	return response(href, propstat(`${calendarResourceType()}${properties}`) + failedPropstats);
}

function calendarHomeUrl() {
	return validateAbsoluteHttpUrl('https://partition.example.test/homes/account/');
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('calendar-collection public surface and request descriptor', () => {
	it('accepts the provider-neutral public calendar model', () => {
		const collection: CalendarCollection = {
			url: validateAbsoluteHttpUrl('https://calendar.example.test/events/'),
			displayName: '',
			description: 'Events',
			timezone: 'BEGIN:VCALENDAR\nEND:VCALENDAR',
			color: '#123456FF',
			supportedComponents: Object.freeze(['VEVENT']),
			canRead: null,
			canWrite: false,
			extensions: Object.freeze({
				provider: Object.freeze({ synthetic: true }),
			}),
		};

		expect(collection).toMatchObject({
			canRead: null,
			canWrite: false,
			supportedComponents: ['VEVENT'],
		});
	});

	it('exports exactly the accepted runtime surface and failure codes', () => {
		expect(Object.keys(calendarCollectionDiscovery).sort()).toEqual(
			[
				'CalDavCalendarCollectionDiscoveryError',
				'CalendarCollectionDiscoveryFailureCode',
				'discoverCalendarCollections',
			].sort(),
		);
		expect(CalendarCollectionDiscoveryFailureCode).toEqual({
			INVALID_RESPONSE: 'INVALID_CALENDAR_COLLECTION_RESPONSE',
			AMBIGUOUS_PROPERTY: 'AMBIGUOUS_CALENDAR_COLLECTION_PROPERTY',
		});
	});

	it('makes one depth-1 PROPFIND with the explicit standard property set', async () => {
		const homeUrl = calendarHomeUrl();
		const transport = mockTransport();

		await expect(discoverCalendarCollections(transport, homeUrl)).resolves.toEqual([]);
		expect(transport.request).toHaveBeenCalledTimes(1);
		expect(transport.request).toHaveBeenCalledWith({
			method: CalDavMethod.PROPFIND,
			url: homeUrl,
			headers: {
				Depth: '1',
				'Content-Type': 'application/xml; charset=utf-8',
			},
			body: CALENDAR_COLLECTION_BODY,
		});
		expect(CALENDAR_COLLECTION_BODY).not.toContain('allprop');
	});

	it('requests and exposes confirmed iCloud color without provider-specific top-level keys', async () => {
		const xml = multistatus(
			calendarResponse('/calendars/work/', '<i:calendar-color>#123456FF</i:calendar-color>'),
			' xmlns:i="http://apple.com/ns/ical/"',
		);
		const transport = mockTransport(async () => transportResponse(xml));

		const result = await discoverCalendarCollections(
			transport,
			calendarHomeUrl(),
			iCloudCalDavProviderAdapter,
		);
		expect(result).toEqual([
			{
				url: 'https://partition.example.test/calendars/work/',
				color: '#123456FF',
				canRead: null,
				canWrite: null,
			},
		]);
		const requestBody = transport.request.mock.calls[0][0].body;
		expect(requestBody).toBeTypeOf('string');
		expect(requestBody).toMatch(/xmlns:([A-Za-z_][\w.-]*)="http:\/\/apple\.com\/ns\/ical\/"/);
		const applePrefix = (requestBody as string).match(
			/xmlns:([A-Za-z_][\w.-]*)="http:\/\/apple\.com\/ns\/ical\/"/,
		)?.[1];
		expect(applePrefix).toBeDefined();
		expect(requestBody).toContain(`<${applePrefix}:calendar-color/>`);
		expect(Object.keys(result[0]).sort()).toEqual(['canRead', 'canWrite', 'color', 'url']);
	});
});

describe('calendar-collection filtering and property status handling', () => {
	it('returns only VEVENT calendars from mixed WebDAV and CalDAV resource types', async () => {
		const responses = [
			response('/principals/account/', propstat(resourceType('<d:collection/>', '<d:principal/>'))),
			response(
				'/addressbooks/account/',
				propstat(
					resourceType(
						'<d:collection/>',
						'<card:addressbook xmlns:card="urn:ietf:params:xml:ns:carddav"/>',
					),
				),
			),
			response('/plain/', propstat(resourceType('<d:collection/>'))),
			response('/inbox/', propstat(resourceType('<d:collection/>', '<c:schedule-inbox/>'))),
			calendarResponse('/tasks/', componentSet('VTODO')),
			calendarResponse(
				'/events/',
				'<d:displayname>Events</d:displayname>' +
					componentSet('VEVENT', 'VTODO', 'VEVENT') +
					privilegeSet('read'),
			),
		].join('');

		const result = await discoverCalendarCollections(
			mockTransport(async () => transportResponse(multistatus(responses))),
			calendarHomeUrl(),
		);

		expect(result).toEqual([
			{
				url: 'https://partition.example.test/events/',
				displayName: 'Events',
				supportedComponents: ['VEVENT', 'VTODO'],
				canRead: true,
				canWrite: false,
			},
		]);
		expect(Object.isFrozen(result[0].supportedComponents)).toBe(true);
	});

	it('includes absent and 404 component sets but excludes a non-404 failure', async () => {
		const xml = multistatus(
			calendarResponse('/absent/') +
				calendarResponse(
					'/missing/',
					'',
					propstat(componentSet('VTODO'), 'HTTP/1.1 404 Not Found'),
				) +
				calendarResponse(
					'/forbidden/',
					'',
					propstat(componentSet('VEVENT'), 'HTTP/1.1 403 Forbidden'),
				),
		);

		await expect(
			discoverCalendarCollections(
				mockTransport(async () => transportResponse(xml)),
				calendarHomeUrl(),
			),
		).resolves.toEqual([
			{ url: 'https://partition.example.test/absent/', canRead: null, canWrite: null },
			{ url: 'https://partition.example.test/missing/', canRead: null, canWrite: null },
		]);
	});

	it.each([
		['read', privilegeSet('read'), '', true, false],
		['read and write', privilegeSet('read', 'write'), '', true, true],
		['all', privilegeSet('all'), '', true, true],
		['empty successful set', privilegeSet(), '', false, false],
		['missing set', '', '', null, null],
		['failed set', '', propstat(privilegeSet('all'), 'HTTP/1.1 403 Forbidden'), null, null],
	] as const)(
		'derives %s privileges without inference',
		async (_label, property, failedPropstats, canRead, canWrite) => {
			const xml = multistatus(calendarResponse('/calendar/', property, failedPropstats));

			await expect(
				discoverCalendarCollections(
					mockTransport(async () => transportResponse(xml)),
					calendarHomeUrl(),
				),
			).resolves.toEqual([
				{
					url: 'https://partition.example.test/calendar/',
					canRead,
					canWrite,
				},
			]);
		},
	);

	it('matches expanded names independently of namespace prefix spelling', async () => {
		const canonical = multistatus(
			calendarResponse('/calendar/', '<d:displayname>Events</d:displayname>'),
		);
		const renamed =
			'<multistatus xmlns="DAV:" xmlns:calendar="urn:ietf:params:xml:ns:caldav">' +
			'<response><href>/calendar/</href><propstat><prop>' +
			'<resourcetype><collection/><calendar:calendar/></resourcetype>' +
			'<displayname>Events</displayname>' +
			'</prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>';

		const canonicalResult = await discoverCalendarCollections(
			mockTransport(async () => transportResponse(canonical)),
			calendarHomeUrl(),
		);
		const renamedResult = await discoverCalendarCollections(
			mockTransport(async () => transportResponse(renamed)),
			calendarHomeUrl(),
		);

		expect(renamedResult).toEqual(canonicalResult);
	});

	it('uses only successful properties when failed duplicates contain conflicting values', async () => {
		const xml = multistatus(
			response(
				'/calendar/',
				propstat(
					`${calendarResourceType()}<d:displayname>Public</d:displayname>${privilegeSet('read')}`,
				) +
					propstat(
						'<d:displayname>Private failed value</d:displayname>' + privilegeSet('all'),
						'HTTP/1.1 403 Forbidden',
					),
			),
		);

		await expect(
			discoverCalendarCollections(
				mockTransport(async () => transportResponse(xml)),
				calendarHomeUrl(),
			),
		).resolves.toEqual([
			{
				url: 'https://partition.example.test/calendar/',
				displayName: 'Public',
				canRead: true,
				canWrite: false,
			},
		]);
	});
});

describe('calendar-collection URL, deduplication, and security behavior', () => {
	it('normalizes against the effective URL, preserves order, and retains the first duplicate', async () => {
		const xml = multistatus(
			calendarResponse(
				'/calendars/shared',
				'<d:displayname>First</d:displayname>' + privilegeSet('read'),
			) +
				calendarResponse('/calendars/other/', '<d:displayname>Other</d:displayname>') +
				calendarResponse(
					'https://partition.example.test/calendars/shared/',
					'<d:displayname>Ignored duplicate</d:displayname>' + privilegeSet('all'),
				),
		);

		await expect(
			discoverCalendarCollections(
				mockTransport(async () => transportResponse(xml)),
				calendarHomeUrl(),
			),
		).resolves.toEqual([
			{
				url: 'https://partition.example.test/calendars/shared/',
				displayName: 'First',
				canRead: true,
				canWrite: false,
			},
			{
				url: 'https://partition.example.test/calendars/other/',
				displayName: 'Other',
				canRead: null,
				canWrite: null,
			},
		]);
	});

	it('keeps hostile display text scalar and cannot let it affect URL, flags, keys, or logs', async () => {
		const logSpies = [
			vi.spyOn(console, 'debug').mockImplementation(() => {}),
			vi.spyOn(console, 'info').mockImplementation(() => {}),
			vi.spyOn(console, 'log').mockImplementation(() => {}),
			vi.spyOn(console, 'warn').mockImplementation(() => {}),
			vi.spyOn(console, 'error').mockImplementation(() => {}),
		];
		const displayName = '<script>__proto__ https://attacker.invalid/\n[WARN]';
		const description = 'constructor\nurl=javascript:private-sentinel';
		const xml = multistatus(
			calendarResponse(
				'/safe-calendar/',
				`<d:displayname><![CDATA[${displayName}]]></d:displayname>` +
					`<c:calendar-description><![CDATA[${description}]]></c:calendar-description>` +
					privilegeSet('read'),
			),
		);

		const [calendar] = await discoverCalendarCollections(
			mockTransport(async () => transportResponse(xml)),
			calendarHomeUrl(),
		);

		expect(calendar).toEqual({
			url: 'https://partition.example.test/safe-calendar/',
			displayName,
			description,
			canRead: true,
			canWrite: false,
		});
		expect(Object.keys(calendar).sort()).toEqual([
			'canRead',
			'canWrite',
			'description',
			'displayName',
			'url',
		]);
		expect(Object.getPrototypeOf(calendar)).not.toHaveProperty('private-sentinel');
		expect(logSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
	});

	it('propagates the existing URL security error for an unsafe href', async () => {
		const xml = multistatus(calendarResponse('http://partition.example.test/private/'));

		await expect(
			discoverCalendarCollections(
				mockTransport(async () => transportResponse(xml)),
				calendarHomeUrl(),
			),
		).rejects.toBeInstanceOf(CalDavUrlValidationError);
	});

	it('rejects non-207 responses with deterministic sanitized discovery metadata', async () => {
		const transport = mockTransport(async () =>
			transportResponse('private-response-body-sentinel', 200),
		);

		let error: unknown;
		try {
			await discoverCalendarCollections(transport, calendarHomeUrl());
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(CalDavCalendarCollectionDiscoveryError);
		expect(error).toMatchObject({
			name: 'CalDavCalendarCollectionDiscoveryError',
			code: 'INVALID_CALENDAR_COLLECTION_RESPONSE',
		});
		expect(String(error)).not.toContain('private-response-body-sentinel');
		expect(error).not.toHaveProperty('cause');
	});
});
