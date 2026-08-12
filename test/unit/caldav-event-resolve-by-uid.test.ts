import { afterEach, describe, expect, it, vi } from 'vitest';

import * as uidResolver from '../../nodes/CalDav/events/resolveByUid';
import {
	CalDavCalendarEventUidResolutionError,
	CalendarEventUidResolutionFailureCode,
	resolveCalendarEventByUid,
} from '../../nodes/CalDav/events/resolveByUid';
import { CalDavCalendarEventReadModelError } from '../../nodes/CalDav/icalendar/eventReadModel';
import type { CalendarEventReadResult } from '../../nodes/CalDav/icalendar/eventReadModel';
import { CalDavICalendarParseError } from '../../nodes/CalDav/icalendar/parser';
import { CalDavMethod, CalDavNetworkError } from '../../nodes/CalDav/transport/http';
import type {
	CalDavTransport,
	CalDavTransportRequest,
	CalDavTransportResponse,
} from '../../nodes/CalDav/transport/http';
import {
	CalDavUrlValidationError,
	validateAbsoluteHttpUrl,
} from '../../nodes/CalDav/transport/url';
import { XmlBuildError } from '../../nodes/CalDav/xml/errors';
import { CalDavXmlParseError } from '../../nodes/CalDav/xml/parser';

const CALENDAR_URL = validateAbsoluteHttpUrl(
	'https://calendar.example.test/calendars/selected?opaque=%2f',
);
const EFFECTIVE_URL = 'https://partition.example.test/calendars/selected/';

type MockTransport = CalDavTransport & { request: ReturnType<typeof vi.fn> };

function escapeXmlText(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function calendar(lines: readonly string[]): string {
	return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR', ''].join('\n');
}

function event(uid: string, extraLines: readonly string[] = []): readonly string[] {
	return [
		'BEGIN:VEVENT',
		`UID:${uid}`,
		'DTSTAMP:20400101T000000Z',
		'DTSTART:20400102T100000Z',
		'DTEND:20400102T103000Z',
		...extraLines,
		'END:VEVENT',
	];
}

function eventResource(uid: string, extraLines: readonly string[] = []): string {
	return calendar(event(uid, extraLines));
}

function todoResource(uid: string): string {
	return calendar([
		'BEGIN:VTODO',
		`UID:${uid}`,
		'DTSTAMP:20400101T000000Z',
		'DTSTART:20400102T100000Z',
		'END:VTODO',
	]);
}

function propstat(properties: string, status = 'HTTP/1.1 200 OK'): string {
	return `<d:propstat><d:prop>${properties}</d:prop><d:status>${status}</d:status></d:propstat>`;
}

function response(href: string, contents: string): string {
	return `<d:response><d:href>${escapeXmlText(href)}</d:href>${contents}</d:response>`;
}

function propertyResponse(href: string, propstats: string): string {
	return response(href, propstats);
}

function statusResponse(href: string, status = 'HTTP/1.1 200 OK'): string {
	return response(href, `<d:status>${status}</d:status>`);
}

function multistatus(responses: string, namespaces = ''): string {
	return `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"${namespaces}>${responses}</d:multistatus>`;
}

function etagProperty(etag: string, attributes = ''): string {
	return `<d:getetag${attributes}>${escapeXmlText(etag)}</d:getetag>`;
}

function calendarDataProperty(ics: string, attributes = ''): string {
	return `<c:calendar-data${attributes}>${escapeXmlText(ics)}</c:calendar-data>`;
}

function eventResponse(
	href: string,
	uid: string,
	options: {
		readonly etag?: string;
		readonly ics?: string;
		readonly extraSuccessfulProperties?: string;
		readonly failedPropstats?: string;
	} = {},
): string {
	const etag = options.etag ?? '"synthetic-etag"';
	const ics = options.ics ?? eventResource(uid);
	return propertyResponse(
		href,
		propstat(
			`${etagProperty(etag)}${calendarDataProperty(ics)}${options.extraSuccessfulProperties ?? ''}`,
		) + (options.failedPropstats ?? ''),
	);
}

function transportResponse(
	xml: string,
	statusCode = 207,
	effectiveUrl = EFFECTIVE_URL,
): CalDavTransportResponse {
	return {
		statusCode,
		headers: Object.freeze({ 'content-type': 'application/xml; charset=utf-8' }),
		effectiveUrl,
		body: Buffer.from(xml, 'utf8'),
	};
}

function mockTransport(
	implementation: (input: CalDavTransportRequest) => Promise<CalDavTransportResponse> = async () =>
		transportResponse(multistatus('')),
): MockTransport {
	return {
		serverUrl: 'https://configured.example.test/private-root/',
		request: vi.fn(implementation),
	};
}

async function captureResolutionError(
	promise: Promise<unknown>,
	code: (typeof CalendarEventUidResolutionFailureCode)[keyof typeof CalendarEventUidResolutionFailureCode],
): Promise<CalDavCalendarEventUidResolutionError> {
	try {
		await promise;
		expect.unreachable('Expected UID resolution to fail');
	} catch (error) {
		expect(error).toBeInstanceOf(CalDavCalendarEventUidResolutionError);
		expect(error).toMatchObject({
			name: 'CalDavCalendarEventUidResolutionError',
			code,
		});
		return error as CalDavCalendarEventUidResolutionError;
	}
}

function expectDeeplyFrozen(value: unknown, seen = new WeakSet<object>()): void {
	if (typeof value !== 'object' || value === null || seen.has(value)) return;
	seen.add(value);
	expect(Object.isFrozen(value)).toBe(true);
	for (const key of Reflect.ownKeys(value)) expectDeeplyFrozen(Reflect.get(value, key), seen);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('calendar-event UID resolver public contract', () => {
	it('exports exactly the accepted runtime surface and immutable failure codes', () => {
		expect(Object.keys(uidResolver).sort()).toEqual([
			'CalDavCalendarEventUidResolutionError',
			'CalendarEventUidResolutionFailureCode',
			'resolveCalendarEventByUid',
		]);
		expect(CalendarEventUidResolutionFailureCode).toEqual({
			NOT_FOUND: 'CALENDAR_EVENT_UID_NOT_FOUND',
			AMBIGUOUS: 'AMBIGUOUS_CALENDAR_EVENT_UID',
			INVALID_RESPONSE: 'INVALID_CALENDAR_EVENT_UID_RESPONSE',
		});
		expect(Object.isFrozen(CalendarEventUidResolutionFailureCode)).toBe(true);
		expect(resolveCalendarEventByUid).toBeTypeOf('function');
		expect(resolveCalendarEventByUid).toHaveLength(3);
	});

	it.each([
		[
			CalendarEventUidResolutionFailureCode.NOT_FOUND,
			'No calendar event with the requested UID was found in the selected calendar.',
		],
		[
			CalendarEventUidResolutionFailureCode.AMBIGUOUS,
			'More than one calendar event with the requested UID was found in the selected calendar.',
		],
		[
			CalendarEventUidResolutionFailureCode.INVALID_RESPONSE,
			'The CalDAV server returned an invalid calendar-event UID response.',
		],
	] as const)('constructs the fixed sanitized %s error', (code, message) => {
		const error = new CalDavCalendarEventUidResolutionError(code);

		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({
			name: 'CalDavCalendarEventUidResolutionError',
			code,
			message,
		});
		expect(
			Object.getOwnPropertyNames(error).every((name) =>
				['stack', 'message', 'name', 'code'].includes(name),
			),
		).toBe(true);
		for (const forbidden of [
			'uid',
			'url',
			'etag',
			'xml',
			'ics',
			'body',
			'property',
			'excerpt',
			'ast',
			'cause',
			'statusText',
		]) {
			expect(error).not.toHaveProperty(forbidden);
		}
	});
});

describe('calendar-event UID REPORT request and successful mapping', () => {
	it('sends exactly one scoped Depth-1 REPORT with the exact existing UID-query XML', async () => {
		const uid = ` Mixed & <tag> "quoted" 'single'  `;
		const transport = mockTransport(async () =>
			transportResponse(multistatus(eventResponse('event.ics', uid))),
		);
		const expectedBody = `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:prop-filter name="UID">
          <c:text-match collation="i;octet"> Mixed &amp; &lt;tag&gt; &quot;quoted&quot; &apos;single&apos;  </c:text-match>
        </c:prop-filter>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

		const result = await resolveCalendarEventByUid(transport, CALENDAR_URL, uid);

		expect(transport.request).toHaveBeenCalledTimes(1);
		expect(transport.request).toHaveBeenCalledWith({
			method: CalDavMethod.REPORT,
			url: CALENDAR_URL,
			headers: {
				Depth: '1',
				'Content-Type': 'application/xml; charset=utf-8',
			},
			body: expectedBody,
		});
		expect(Object.keys(transport.request.mock.calls[0][0]).sort()).toEqual([
			'body',
			'headers',
			'method',
			'url',
		]);
		expect(result.event.uid).toBe(uid);
	});

	it.each([
		['empty UID', ''],
		['XML-invalid UID', 'private-uid\u0000sentinel'],
	] as const)('fails for %s before calling transport', async (_label, uid) => {
		const transport = mockTransport();

		await expect(resolveCalendarEventByUid(transport, CALENDAR_URL, uid)).rejects.toBeInstanceOf(
			XmlBuildError,
		);
		expect(transport.request).not.toHaveBeenCalled();
	});

	it('maps the sole resource URL, exact ETag, public event, and preservation context', async () => {
		const uid = 'unique-event@example.test';
		const etag = '  W/"opaque%2Fetag"  ';
		const ics = eventResource(uid, [
			'SUMMARY:Planning',
			'DESCRIPTION:Preserve me',
			'X-PRIVATE:preservation-only',
		]);
		const transport = mockTransport(async () =>
			transportResponse(multistatus(eventResponse('event%2Fopaque.ics', uid, { etag, ics }))),
		);

		const result = await resolveCalendarEventByUid(transport, CALENDAR_URL, uid);

		expect(result.event).toEqual({
			calendarUrl: CALENDAR_URL,
			resourceUrl: 'https://partition.example.test/calendars/selected/event%2Fopaque.ics',
			etag,
			uid,
			summary: 'Planning',
			description: 'Preserve me',
			start: '2040-01-02T10:00:00Z',
			end: '2040-01-02T10:30:00Z',
		});
		expect(Object.keys(result).sort()).toEqual(['context', 'event']);
		expect(result.context.resource.originalIcs).toBe(ics);
		expect(result.context.master).toBe(result.context.resource.calendar.entries[1]);
		expect(result.context.exceptions).toEqual([]);
		expect(result.event).not.toHaveProperty('extensions');
		expect(JSON.stringify(result.event)).not.toContain('preservation-only');
		expectDeeplyFrozen(result);
	});

	it.each([
		['child.ics', 'https://effective.example.test/base/child.ics'],
		['/root/event.ics', 'https://effective.example.test/root/event.ics'],
		['//partition.example.net/shared/event.ics', 'https://partition.example.net/shared/event.ics'],
		['https://absolute.example.org/event.ics', 'https://absolute.example.org/event.ics'],
	] as const)('resolves %s against the effective response URL', async (href, resourceUrl) => {
		const uid = `href-${Buffer.from(href).toString('hex')}@example.test`;
		const transport = mockTransport(async () =>
			transportResponse(
				multistatus(eventResponse(href, uid)),
				207,
				'https://effective.example.test/base/',
			),
		);

		await expect(resolveCalendarEventByUid(transport, CALENDAR_URL, uid)).resolves.toMatchObject({
			event: { calendarUrl: CALENDAR_URL, resourceUrl, uid },
		});
	});

	it('never interprets an opaque path-like UID as a URL or searches another calendar', async () => {
		const uid = '../other-calendar/event.ics?occurrence=20400102T100000Z';
		const transport = mockTransport(async (request) => {
			expect(request.url).toBe(CALENDAR_URL);
			expect(request.method).toBe(CalDavMethod.REPORT);
			return transportResponse(multistatus(eventResponse('/selected/random-name.ics', uid)));
		});

		const result = await resolveCalendarEventByUid(transport, CALENDAR_URL, uid);

		expect(transport.request).toHaveBeenCalledTimes(1);
		expect(result.event.resourceUrl).toBe(
			'https://partition.example.test/selected/random-name.ics',
		);
		expect(result.event.uid).toBe(uid);
	});

	it('keeps a master and ordered recurrence exceptions in one resolved resource', async () => {
		const uid = 'recurring@example.test';
		const ics = calendar([
			...event(uid, ['SUMMARY:Master', 'RRULE:FREQ=DAILY;COUNT=3']),
			...event(uid, [
				'RECURRENCE-ID:20400103T100000Z',
				'DTSTART:20400103T120000Z',
				'DTEND:20400103T123000Z',
				'SUMMARY:First exception',
			]),
			...event(uid, [
				'RECURRENCE-ID:20400104T100000Z',
				'DTSTART:20400104T130000Z',
				'DTEND:20400104T133000Z',
				'SUMMARY:Second exception',
			]),
		]);
		const transport = mockTransport(async () =>
			transportResponse(multistatus(eventResponse('recurring.ics', uid, { ics }))),
		);

		const result = await resolveCalendarEventByUid(transport, CALENDAR_URL, uid);

		expect(result.event).toMatchObject({ uid, summary: 'Master' });
		expect(result.context.exceptions).toHaveLength(2);
		expect(
			result.context.exceptions.map(({ entries }) =>
				entries.find((entry) => entry.kind === 'property' && entry.name === 'SUMMARY'),
			),
		).toEqual([
			expect.objectContaining({ kind: 'property', name: 'SUMMARY' }),
			expect.objectContaining({ kind: 'property', name: 'SUMMARY' }),
		]);
	});
});

describe('calendar-event UID exact-match cardinality and aliases', () => {
	it('returns not-found for an empty multistatus with a stable sanitized error', async () => {
		const uid = 'private-empty-sentinel@example.test';
		const error = await captureResolutionError(
			resolveCalendarEventByUid(mockTransport(), CALENDAR_URL, uid),
			CalendarEventUidResolutionFailureCode.NOT_FOUND,
		);

		expect(error.message).not.toContain(uid);
		expect(error.message).not.toContain(CALENDAR_URL);
	});

	it('discards valid substring and case-only server matches after mapping', async () => {
		const uid = 'Case-Sensitive-Uid';
		const xml = multistatus(
			eventResponse('substring.ics', `${uid}-suffix`) +
				eventResponse('case.ics', uid.toUpperCase()),
		);

		await captureResolutionError(
			resolveCalendarEventByUid(
				mockTransport(async () => transportResponse(xml)),
				CALENDAR_URL,
				uid,
			),
			CalendarEventUidResolutionFailureCode.NOT_FOUND,
		);
	});

	it('rejects two exact UID resources at distinct canonical URLs as ambiguous', async () => {
		const uid = 'duplicate@example.test';
		const transport = mockTransport(async () =>
			transportResponse(
				multistatus(eventResponse('first.ics', uid) + eventResponse('second.ics', uid)),
			),
		);

		const error = await captureResolutionError(
			resolveCalendarEventByUid(transport, CALENDAR_URL, uid),
			CalendarEventUidResolutionFailureCode.AMBIGUOUS,
		);
		expect(transport.request).toHaveBeenCalledTimes(1);
		expect(error.message).not.toContain(uid);
		expect(error).not.toHaveProperty('results');
	});

	it('deduplicates identical root-relative and absolute aliases of one canonical resource', async () => {
		const uid = 'alias@example.test';
		const ics = eventResource(uid, ['SUMMARY:Aliased']);
		const first = eventResponse('/calendars/selected/event.ics', uid, {
			etag: 'W/"same"',
			ics,
		});
		const second = eventResponse(
			'https://partition.example.test/calendars/selected/event.ics',
			uid,
			{ etag: 'W/"same"', ics },
		);

		await expect(
			resolveCalendarEventByUid(
				mockTransport(async () => transportResponse(multistatus(first + second))),
				CALENDAR_URL,
				uid,
			),
		).resolves.toMatchObject({
			event: {
				resourceUrl: 'https://partition.example.test/calendars/selected/event.ics',
				uid,
				summary: 'Aliased',
			},
		});
	});

	it.each([
		['ETag', 'W/"different"', eventResource('alias-conflict@example.test')],
		[
			'calendar-data',
			'W/"same"',
			eventResource('alias-conflict@example.test', ['SUMMARY:Different']),
		],
	] as const)('rejects a canonical alias conflict in %s', async (_label, secondEtag, secondIcs) => {
		const uid = 'alias-conflict@example.test';
		const first = eventResponse('/calendars/selected/conflict.ics', uid, {
			etag: 'W/"same"',
			ics: eventResource(uid),
		});
		const second = eventResponse(
			'https://partition.example.test/calendars/selected/conflict.ics',
			uid,
			{ etag: secondEtag, ics: secondIcs },
		);

		await captureResolutionError(
			resolveCalendarEventByUid(
				mockTransport(async () => transportResponse(multistatus(first + second))),
				CALENDAR_URL,
				uid,
			),
			CalendarEventUidResolutionFailureCode.INVALID_RESPONSE,
		);
	});

	it('parses and maps every canonical resource before exact-UID cardinality', async () => {
		const uid = 'map-before-cardinality@example.test';
		const xml = multistatus(
			eventResponse('exact.ics', uid) +
				eventResponse('substring-invalid-model.ics', `${uid}-suffix`, {
					ics: todoResource(`${uid}-suffix`),
				}),
		);

		await expect(
			resolveCalendarEventByUid(
				mockTransport(async () => transportResponse(xml)),
				CALENDAR_URL,
				uid,
			),
		).rejects.toMatchObject({
			name: 'CalDavCalendarEventReadModelError',
			code: 'NOT_VEVENT_RESOURCE',
		});
	});
});

describe('calendar-event UID multistatus and requested-property validation', () => {
	it.each([
		['missing ETag', calendarDataProperty(eventResource('shape@example.test'))],
		['missing calendar-data', etagProperty('"etag"')],
		[
			'duplicate ETag',
			etagProperty('"one"') +
				etagProperty('"two"') +
				calendarDataProperty(eventResource('shape@example.test')),
		],
		[
			'duplicate calendar-data',
			etagProperty('"etag"') +
				calendarDataProperty(eventResource('shape@example.test')) +
				calendarDataProperty(eventResource('shape@example.test')),
		],
		[
			'wrong ETag namespace',
			'<x:getetag xmlns:x="urn:not-dav">"etag"</x:getetag>' +
				calendarDataProperty(eventResource('shape@example.test')),
		],
		[
			'wrong calendar-data namespace',
			etagProperty('"etag"') +
				'<x:calendar-data xmlns:x="urn:not-caldav">ignored</x:calendar-data>',
		],
	] as const)('rejects %s', async (_label, properties) => {
		const xml = multistatus(propertyResponse('shape.ics', propstat(properties)));

		await captureResolutionError(
			resolveCalendarEventByUid(
				mockTransport(async () => transportResponse(xml)),
				CALENDAR_URL,
				'shape@example.test',
			),
			CalendarEventUidResolutionFailureCode.INVALID_RESPONSE,
		);
	});

	it.each([
		['status-only response', multistatus(statusResponse('event.ics'))],
		[
			'wholly failed response',
			multistatus(
				propertyResponse(
					'event.ics',
					propstat(
						etagProperty('private-etag') +
							calendarDataProperty(eventResource('status@example.test')),
						'HTTP/1.1 404 Not Found',
					),
				),
			),
		],
		[
			'partial requested-property success',
			multistatus(
				propertyResponse(
					'event.ics',
					propstat(etagProperty('"etag"')) +
						propstat(
							calendarDataProperty(eventResource('status@example.test')),
							'HTTP/1.1 404 Not Found',
						),
				),
			),
		],
	] as const)('rejects a %s', async (_label, xml) => {
		await captureResolutionError(
			resolveCalendarEventByUid(
				mockTransport(async () => transportResponse(xml)),
				CALENDAR_URL,
				'status@example.test',
			),
			CalendarEventUidResolutionFailureCode.INVALID_RESPONSE,
		);
	});

	it.each([200, 206, 404, 500] as const)(
		'rejects overall HTTP status %s before XML mapping',
		async (statusCode) => {
			const privateMalformedBody = '<private-malformed-body-sentinel>';
			const error = await captureResolutionError(
				resolveCalendarEventByUid(
					mockTransport(async () => transportResponse(privateMalformedBody, statusCode)),
					CALENDAR_URL,
					'non-207@example.test',
				),
				CalendarEventUidResolutionFailureCode.INVALID_RESPONSE,
			);
			expect(error.message).not.toContain(privateMalformedBody);
		},
	);

	it('ignores unrelated and failed propstat properties when one complete success exists', async () => {
		const uid = 'mixed-propstats@example.test';
		const xml = multistatus(
			propertyResponse(
				'mixed.ics',
				propstat(
					etagProperty(' W/"exact" ') +
						calendarDataProperty(eventResource(uid), ' content-type="text/calendar"') +
						'<x:unrelated xmlns:x="urn:synthetic">public</x:unrelated>',
				) +
					propstat(
						etagProperty('private-failed-etag') +
							calendarDataProperty('private-failed-calendar-data'),
						'HTTP/1.1 403 Forbidden',
					),
			),
		);

		await expect(
			resolveCalendarEventByUid(
				mockTransport(async () => transportResponse(xml)),
				CALENDAR_URL,
				uid,
			),
		).resolves.toMatchObject({ event: { uid, etag: ' W/"exact" ' } });
	});

	it('does not silently ignore a separate unprocessable response', async () => {
		const uid = 'complete-plus-invalid@example.test';
		const xml = multistatus(
			eventResponse('valid.ics', uid) +
				propertyResponse('invalid.ics', propstat(calendarDataProperty(eventResource(uid)))),
		);

		await captureResolutionError(
			resolveCalendarEventByUid(
				mockTransport(async () => transportResponse(xml)),
				CALENDAR_URL,
				uid,
			),
			CalendarEventUidResolutionFailureCode.INVALID_RESPONSE,
		);
	});

	it.each([
		['empty', '', ''],
		['weak quoted whitespace', ' \tW/"opaque"\n ', ' \tW/"opaque"\n '],
	] as const)('preserves an %s ETag exactly', async (_label, etag, expected) => {
		const uid = `etag-${_label}@example.test`;
		const xml = multistatus(eventResponse('etag.ics', uid, { etag }));

		await expect(
			resolveCalendarEventByUid(
				mockTransport(async () => transportResponse(xml)),
				CALENDAR_URL,
				uid,
			),
		).resolves.toMatchObject({ event: { uid, etag: expected } });
	});

	it.each([
		[
			'ETag attributes',
			`${etagProperty('"etag"', ' private="yes"')}${calendarDataProperty(eventResource('content-shape@example.test'))}`,
		],
		[
			'ETag element child',
			'<d:getetag><d:href>private</d:href></d:getetag>' +
				calendarDataProperty(eventResource('content-shape@example.test')),
		],
		[
			'calendar-data element child',
			etagProperty('"etag"') + '<c:calendar-data><c:comp name="VEVENT"/></c:calendar-data>',
		],
	] as const)('rejects %s', async (_label, properties) => {
		const xml = multistatus(propertyResponse('shape.ics', propstat(properties)));

		await captureResolutionError(
			resolveCalendarEventByUid(
				mockTransport(async () => transportResponse(xml)),
				CALENDAR_URL,
				'content-shape@example.test',
			),
			CalendarEventUidResolutionFailureCode.INVALID_RESPONSE,
		);
	});
});

describe('calendar-event UID lower-layer error propagation and precedence', () => {
	it('propagates the same transport error instance without response or credential leakage', async () => {
		const transportError = new CalDavNetworkError();
		const transport = mockTransport(async () => {
			throw transportError;
		});
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		await expect(
			resolveCalendarEventByUid(transport, CALENDAR_URL, 'private-uid-sentinel'),
		).rejects.toBe(transportError);
		expect(transport.request).toHaveBeenCalledTimes(1);
		expect(consoleError).not.toHaveBeenCalled();
		expect(consoleWarn).not.toHaveBeenCalled();
		expect(JSON.stringify(transportError)).not.toContain('private-uid-sentinel');
		expect(transportError).not.toHaveProperty('response');
		expect(transportError).not.toHaveProperty('cause');
	});

	it('propagates malformed XML as the existing typed XML parse failure', async () => {
		const promise = resolveCalendarEventByUid(
			mockTransport(async () => transportResponse('<d:multistatus xmlns:d="DAV:">')),
			CALENDAR_URL,
			'malformed-xml@example.test',
		);

		await expect(promise).rejects.toBeInstanceOf(CalDavXmlParseError);
		await expect(promise).rejects.toMatchObject({ code: 'TRUNCATED_XML' });
	});

	it('propagates an unsafe href as the existing sanitized URL validation failure', async () => {
		const uid = 'unsafe-href@example.test';
		const xml = multistatus(eventResponse('http://partition.example.test/private.ics', uid));

		await expect(
			resolveCalendarEventByUid(
				mockTransport(async () =>
					transportResponse(xml, 207, 'https://partition.example.test/calendar/'),
				),
				CALENDAR_URL,
				uid,
			),
		).rejects.toMatchObject({
			name: 'CalDavUrlValidationError',
			code: 'INSECURE_PROTOCOL_DOWNGRADE',
		});
	});

	it.each([
		['empty calendar-data', '', 'INVALID_ROOT_COMPONENT'],
		['malformed calendar-data', 'BEGIN:VCALENDAR\nVERSION:2.0\n', 'TRUNCATED_COMPONENT'],
	] as const)('propagates %s through the existing iCalendar parser', async (_label, ics, code) => {
		const uid = 'malformed-ics@example.test';
		const xml = multistatus(eventResponse('malformed.ics', uid, { ics }));

		await expect(
			resolveCalendarEventByUid(
				mockTransport(async () => transportResponse(xml)),
				CALENDAR_URL,
				uid,
			),
		).rejects.toMatchObject({ name: 'CalDavICalendarParseError', code });
	});

	it('propagates an unsupported event model instead of reclassifying it', async () => {
		const uid = 'todo-model@example.test';
		const xml = multistatus(eventResponse('todo.ics', uid, { ics: todoResource(uid) }));

		await expect(
			resolveCalendarEventByUid(
				mockTransport(async () => transportResponse(xml)),
				CALENDAR_URL,
				uid,
			),
		).rejects.toMatchObject({
			name: 'CalDavCalendarEventReadModelError',
			code: 'NOT_VEVENT_RESOURCE',
		});
	});

	it('processes wire order and reports the first lower-layer resource failure', async () => {
		const uid = 'wire-order@example.test';
		const unsafe = eventResponse('http://partition.example.test/private.ics', uid);
		const malformed = eventResponse('malformed.ics', uid, { ics: 'not-an-icalendar-resource' });
		const transportFor = (responses: string) =>
			mockTransport(async () =>
				transportResponse(multistatus(responses), 207, 'https://partition.example.test/calendar/'),
			);

		await expect(
			resolveCalendarEventByUid(transportFor(unsafe + malformed), CALENDAR_URL, uid),
		).rejects.toBeInstanceOf(CalDavUrlValidationError);
		await expect(
			resolveCalendarEventByUid(transportFor(malformed + unsafe), CALENDAR_URL, uid),
		).rejects.toBeInstanceOf(CalDavICalendarParseError);
	});

	it('maps a conflicting alias before classifying the canonical conflict', async () => {
		const uid = 'conflict-precedence@example.test';
		const first = eventResponse('/calendar/conflict.ics', uid, {
			etag: '"first"',
			ics: eventResource(uid),
		});
		const second = eventResponse('https://partition.example.test/calendar/conflict.ics', uid, {
			etag: '"second"',
			ics: todoResource(uid),
		});

		await expect(
			resolveCalendarEventByUid(
				mockTransport(async () =>
					transportResponse(
						multistatus(first + second),
						207,
						'https://partition.example.test/calendar/',
					),
				),
				CALENDAR_URL,
				uid,
			),
		).rejects.toBeInstanceOf(CalDavCalendarEventReadModelError);
	});

	it('does not mutate transport response bytes and returns no raw response surface', async () => {
		const uid = 'immutable@example.test';
		const xml = multistatus(eventResponse('immutable.ics', uid));
		const responseValue = transportResponse(xml);
		const bodySnapshot = Buffer.from(responseValue.body);
		const transport = mockTransport(async () => responseValue);

		const result: CalendarEventReadResult = await resolveCalendarEventByUid(
			transport,
			CALENDAR_URL,
			uid,
		);

		expect(responseValue.body).toEqual(bodySnapshot);
		expect(Object.keys(responseValue)).toEqual(['statusCode', 'headers', 'effectiveUrl', 'body']);
		expect(result).not.toHaveProperty('response');
		expect(result).not.toHaveProperty('body');
		expect(result).not.toHaveProperty('xml');
		expect(result).not.toHaveProperty('occurrences');
		expect(result.event).not.toHaveProperty('extensions');
	});
});
