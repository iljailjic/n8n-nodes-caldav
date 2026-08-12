import { afterEach, describe, expect, it, vi } from 'vitest';

import * as calendarGet from '../../nodes/CalDav/actions/calendar/get';
import {
	CalDavCalendarCollectionGetError,
	CalendarCollectionGetFailureCode,
	getCalendarCollection,
} from '../../nodes/CalDav/actions/calendar/get';
import type {
	CalDavCalendarCollectionPropertyView,
	CalDavProviderAdapter,
} from '../../nodes/CalDav/providers/types';
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

const STANDARD_COLLECTION_BODY = `<?xml version="1.0" encoding="UTF-8"?>
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
	effectiveUrl = 'https://partition.example.test/calendars/work/',
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
		transportResponse(multistatus(calendarResponse('/calendars/work/'))),
): MockTransport {
	return {
		serverUrl: 'https://configured.example.test/',
		request: vi.fn(implementation),
	};
}

function propstat(properties: string, status = 'HTTP/1.1 200 OK'): string {
	return `<d:propstat><d:prop>${properties}</d:prop><d:status>${status}</d:status></d:propstat>`;
}

function response(hrefs: string, contents: string): string {
	return `<d:response>${hrefs}${contents}</d:response>`;
}

function propertyResponse(href: string, propstats: string): string {
	return response(`<d:href>${href}</d:href>`, propstats);
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
	return propertyResponse(
		href,
		propstat(`${calendarResourceType()}${properties}`) + failedPropstats,
	);
}

function calendarUrl(value = 'https://partition.example.test/calendars/work') {
	return validateAbsoluteHttpUrl(value);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('Calendar Get public surface and depth-0 request', () => {
	it('exports the accepted service and classification failures', () => {
		expect(calendarGet.getCalendarCollection).toBeTypeOf('function');
		expect(calendarGet.CalDavCalendarCollectionGetError).toBeTypeOf('function');
		expect(CalendarCollectionGetFailureCode).toEqual({
			NOT_CALENDAR: 'NOT_A_CALENDAR_COLLECTION',
			VEVENT_UNSUPPORTED: 'VEVENT_NOT_SUPPORTED',
		});
	});

	it('sends exactly one explicit depth-0 PROPFIND to the normalized collection URL', async () => {
		const transport = mockTransport();
		const requestedUrl = calendarUrl();

		await expect(getCalendarCollection(transport, requestedUrl)).resolves.toMatchObject({
			url: 'https://partition.example.test/calendars/work/',
		});
		expect(transport.request).toHaveBeenCalledTimes(1);
		expect(transport.request).toHaveBeenCalledWith({
			method: CalDavMethod.PROPFIND,
			url: 'https://partition.example.test/calendars/work/',
			headers: {
				Depth: '0',
				'Content-Type': 'application/xml; charset=utf-8',
			},
			body: STANDARD_COLLECTION_BODY,
		});
		expect(STANDARD_COLLECTION_BODY).not.toContain('allprop');
	});

	it('requests adapter properties and returns only sanitized provider-neutral output', async () => {
		const readCalendarCollectionProperties = vi.fn(
			(properties: CalDavCalendarCollectionPropertyView) => {
				expect(properties.get('urn:example:calendar', 'color')).toHaveLength(1);
				return {
					color: '#123456FF',
					extensions: {
						nested: { enabled: true },
						unsafe: () => 'private-provider-sentinel',
					},
				};
			},
		);
		const provider: CalDavProviderAdapter = {
			id: 'synthetic',
			calendarCollectionProperties: Object.freeze([
				Object.freeze({ namespaceUri: 'urn:example:calendar', localName: 'color' }),
			]),
			matchesConfiguredServerUrl: () => false,
			allowsCredentialForwarding: () => false,
			readCalendarCollectionProperties,
		};
		const xml = multistatus(
			calendarResponse(
				'/calendars/work/',
				'<x:color xmlns:x="urn:example:calendar">#123456FF</x:color>',
			),
		);
		const transport = mockTransport(async () => transportResponse(xml));

		const result = await getCalendarCollection(transport, calendarUrl(), provider);

		expect(readCalendarCollectionProperties).toHaveBeenCalledTimes(1);
		expect(result).toEqual({
			url: 'https://partition.example.test/calendars/work/',
			color: '#123456FF',
			canRead: null,
			canWrite: null,
		});
		expect(JSON.stringify(result)).not.toContain('private-provider-sentinel');
		const body = transport.request.mock.calls[0][0].body;
		expect(body).toMatch(/xmlns:x0="urn:example:calendar"/);
		expect(body).toContain('<x0:color/>');
	});
});

describe('Calendar Get mapping and classification', () => {
	it('returns full read-only metadata from the single property response', async () => {
		const timezone = 'BEGIN:VCALENDAR\nBEGIN:VTIMEZONE\nEND:VTIMEZONE\nEND:VCALENDAR';
		const xml = multistatus(
			calendarResponse(
				'../work',
				'<d:displayname>Work &amp; Travel</d:displayname>' +
					'<c:calendar-description>  Read only\ncalendar  </c:calendar-description>' +
					`<c:calendar-timezone>${timezone}</c:calendar-timezone>` +
					componentSet('vevent', 'VTODO', 'VEVENT') +
					privilegeSet('read'),
			),
		);

		const result = await getCalendarCollection(
			mockTransport(async () =>
				transportResponse(xml, 207, 'https://partition.example.test/calendars/source/'),
			),
			calendarUrl(),
		);

		expect(result).toEqual({
			url: 'https://partition.example.test/calendars/work/',
			displayName: 'Work & Travel',
			description: '  Read only\ncalendar  ',
			timezone,
			supportedComponents: ['vevent', 'VTODO'],
			canRead: true,
			canWrite: false,
		});
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.supportedComponents)).toBe(true);
	});

	it.each([
		['absent', '', ''],
		['404', '', propstat(componentSet('VTODO'), 'HTTP/1.1 404 Not Found')],
	] as const)('accepts an %s supported-component property', async (_label, property, failed) => {
		const xml = multistatus(calendarResponse('/calendars/work/', property, failed));

		await expect(
			getCalendarCollection(
				mockTransport(async () => transportResponse(xml)),
				calendarUrl(),
			),
		).resolves.toEqual({
			url: 'https://partition.example.test/calendars/work/',
			canRead: null,
			canWrite: null,
		});
	});

	it.each([
		['plain collection', resourceType('<d:collection/>')],
		['principal collection', resourceType('<d:collection/>', '<d:principal/>')],
		[
			'address book',
			resourceType(
				'<d:collection/>',
				'<card:addressbook xmlns:card="urn:ietf:params:xml:ns:carddav"/>',
			),
		],
		['scheduling inbox', resourceType('<d:collection/>', '<c:schedule-inbox/>')],
	] as const)('rejects a %s as not a calendar', async (_label, resourceTypeProperty) => {
		const xml = multistatus(propertyResponse('/resource/', propstat(resourceTypeProperty)));

		await expect(
			getCalendarCollection(
				mockTransport(async () => transportResponse(xml)),
				calendarUrl(),
			),
		).rejects.toMatchObject({
			name: 'CalDavCalendarCollectionGetError',
			code: CalendarCollectionGetFailureCode.NOT_CALENDAR,
		});
	});

	it('rejects a successful component set that does not contain VEVENT', async () => {
		const xml = multistatus(calendarResponse('/tasks/', componentSet('VTODO', 'VJOURNAL')));

		await expect(
			getCalendarCollection(
				mockTransport(async () => transportResponse(xml)),
				calendarUrl(),
			),
		).rejects.toMatchObject({
			name: 'CalDavCalendarCollectionGetError',
			code: CalendarCollectionGetFailureCode.VEVENT_UNSUPPORTED,
		});
	});

	it('retains successful values when failed copies contain hostile conflicts', async () => {
		const xml = multistatus(
			propertyResponse(
				'/calendars/work/',
				propstat(
					calendarResourceType() +
						'<d:displayname>Public</d:displayname>' +
						componentSet('VEVENT') +
						privilegeSet('read'),
				) +
					propstat(
						'<d:displayname>private-server-sentinel</d:displayname>' +
							componentSet('VTODO') +
							privilegeSet('all'),
						'HTTP/1.1 403 private-reason-sentinel',
					),
			),
		);

		await expect(
			getCalendarCollection(
				mockTransport(async () => transportResponse(xml)),
				calendarUrl(),
			),
		).resolves.toEqual({
			url: 'https://partition.example.test/calendars/work/',
			displayName: 'Public',
			supportedComponents: ['VEVENT'],
			canRead: true,
			canWrite: false,
		});
	});

	it('matches expanded names independently of namespace prefixes', async () => {
		const canonical = multistatus(
			calendarResponse('/calendars/work/', '<d:displayname>Events</d:displayname>'),
		);
		const renamed =
			'<multistatus xmlns="DAV:" xmlns:calendar="urn:ietf:params:xml:ns:caldav">' +
			'<response><href>/calendars/work/</href><propstat><prop>' +
			'<resourcetype><collection/><calendar:calendar/></resourcetype>' +
			'<displayname>Events</displayname>' +
			'</prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>';

		const canonicalResult = await getCalendarCollection(
			mockTransport(async () => transportResponse(canonical)),
			calendarUrl(),
		);
		const renamedResult = await getCalendarCollection(
			mockTransport(async () => transportResponse(renamed)),
			calendarUrl(),
		);

		expect(renamedResult).toEqual(canonicalResult);
	});

	it('keeps hostile optional text scalar without allowing it to alter output keys', async () => {
		const displayName = '<script>__proto__ https://attacker.invalid/\n[WARN]';
		const description = 'constructor\nurl=javascript:private-sentinel';
		const xml = multistatus(
			calendarResponse(
				'/calendars/work/',
				`<d:displayname><![CDATA[${displayName}]]></d:displayname>` +
					`<c:calendar-description><![CDATA[${description}]]></c:calendar-description>`,
			),
		);

		const result = await getCalendarCollection(
			mockTransport(async () => transportResponse(xml)),
			calendarUrl(),
		);

		expect(result).toEqual({
			url: 'https://partition.example.test/calendars/work/',
			displayName,
			description,
			canRead: null,
			canWrite: null,
		});
		expect(Object.keys(result).sort()).toEqual([
			'canRead',
			'canWrite',
			'description',
			'displayName',
			'url',
		]);
	});
});

describe('Calendar Get response cardinality and safety', () => {
	it.each([
		['non-207 response', 200, multistatus(calendarResponse('/calendars/work/'))],
		['zero responses', 207, multistatus('')],
		['multiple responses', 207, multistatus(calendarResponse('/one/') + calendarResponse('/two/'))],
		[
			'response-status form',
			207,
			multistatus(
				response('<d:href>/calendars/work/</d:href>', '<d:status>HTTP/1.1 200 OK</d:status>'),
			),
		],
		['no propstat', 207, multistatus(response('<d:href>/calendars/work/</d:href>', ''))],
		[
			'multiple hrefs',
			207,
			multistatus(
				response('<d:href>/one/</d:href><d:href>/two/</d:href>', propstat(calendarResourceType())),
			),
		],
		[
			'non-404 component failure',
			207,
			multistatus(
				calendarResponse(
					'/calendars/work/',
					'',
					propstat(componentSet('VEVENT'), 'HTTP/1.1 403 Forbidden'),
				),
			),
		],
	] as const)('rejects %s as an invalid calendar response', async (_label, status, xml) => {
		await expect(
			getCalendarCollection(
				mockTransport(async () => transportResponse(xml, status)),
				calendarUrl(),
			),
		).rejects.toMatchObject({
			code: expect.stringMatching(/INVALID|AMBIGUOUS/),
		});
	});

	it('preserves the existing ambiguous-property error', async () => {
		const xml = multistatus(
			calendarResponse(
				'/calendars/work/',
				'<d:displayname>One</d:displayname><d:displayname>Two</d:displayname>',
			),
		);

		await expect(
			getCalendarCollection(
				mockTransport(async () => transportResponse(xml)),
				calendarUrl(),
			),
		).rejects.toMatchObject({ code: 'AMBIGUOUS_CALENDAR_COLLECTION_PROPERTY' });
	});

	it('propagates the existing URL boundary for an unsafe response href', async () => {
		const xml = multistatus(calendarResponse('http://partition.example.test/private/'));

		await expect(
			getCalendarCollection(
				mockTransport(async () => transportResponse(xml)),
				calendarUrl(),
			),
		).rejects.toBeInstanceOf(CalDavUrlValidationError);
	});

	it('does not retain server-controlled payload in classification errors', () => {
		for (const code of Object.values(CalendarCollectionGetFailureCode)) {
			const error = new CalDavCalendarCollectionGetError(code);
			expect(error).toMatchObject({ name: 'CalDavCalendarCollectionGetError', code });
			expect(String(error)).not.toContain('private-server-sentinel');
			expect(error).not.toHaveProperty('cause');
		}
	});
});
