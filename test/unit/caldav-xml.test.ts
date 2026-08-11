// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports -- A foreign Date realm is required by this unshipped regression test.
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { XmlBuildError } from '../../nodes/CalDav/xml/errors';
import { escapeXmlAttribute, escapeXmlText } from '../../nodes/CalDav/xml/escape';
import {
	XML_NAMESPACE_DECLARATIONS,
	XML_NAMESPACE_PREFIXES,
	XML_NAMESPACE_URIS,
	XML_QUALIFIED_NAMES,
} from '../../nodes/CalDav/xml/namespaces';
import {
	CALENDAR_COLLECTION_PROPERTIES,
	CALENDAR_HOME_PROPERTIES,
	CURRENT_USER_PRINCIPAL_PROPERTIES,
	buildCalendarCollectionListingPropfind,
	buildCalendarHomeSetPropfind,
	buildCalendarTimeRangeQueryReport,
	buildCalendarUidQueryReport,
	buildCurrentUserPrincipalPropfind,
	buildPropfindRequest,
} from '../../nodes/CalDav/xml/requests';
import type {
	CalendarTimeRangeQueryInput,
	CalendarUidQueryInput,
	PropfindPropertyName,
} from '../../nodes/CalDav/xml/requests';

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

function captureError(action: () => unknown): XmlBuildError {
	try {
		action();
	} catch (error) {
		expect(error).toBeInstanceOf(XmlBuildError);
		return error as XmlBuildError;
	}

	throw new Error('Expected XML construction to fail');
}

function expectCleanDocument(document: string): void {
	expect(document.startsWith(XML_DECLARATION)).toBe(true);
	expect(document.endsWith('\n')).toBe(false);
	expect(document).not.toContain('\r');
	expect(document).not.toContain('\uFEFF');
	expect(document.split('\n').some((line) => /[\t ]+$/.test(line))).toBe(false);
}

describe('CalDAV XML namespaces', () => {
	it('exports the exact immutable namespace registries', () => {
		expect(XML_NAMESPACE_URIS).toEqual({
			dav: 'DAV:',
			caldav: 'urn:ietf:params:xml:ns:caldav',
		});
		expect(XML_NAMESPACE_PREFIXES).toEqual({ dav: 'd', caldav: 'c' });
		expect(XML_NAMESPACE_DECLARATIONS).toEqual({
			dav: 'xmlns:d="DAV:"',
			caldav: 'xmlns:c="urn:ietf:params:xml:ns:caldav"',
		});
		expect(Object.isFrozen(XML_NAMESPACE_URIS)).toBe(true);
		expect(Object.isFrozen(XML_NAMESPACE_PREFIXES)).toBe(true);
		expect(Object.isFrozen(XML_NAMESPACE_DECLARATIONS)).toBe(true);
		expect(Object.isFrozen(XML_QUALIFIED_NAMES)).toBe(true);
		expect(Object.values(XML_QUALIFIED_NAMES).every(Object.isFrozen)).toBe(true);
	});

	it('registers the exact DAV and CalDAV qualified names', () => {
		expect(XML_QUALIFIED_NAMES).toEqual({
			propfind: {
				namespace: 'dav',
				namespaceUri: 'DAV:',
				prefix: 'd',
				localName: 'propfind',
				qualifiedName: 'd:propfind',
			},
			prop: {
				namespace: 'dav',
				namespaceUri: 'DAV:',
				prefix: 'd',
				localName: 'prop',
				qualifiedName: 'd:prop',
			},
			currentUserPrincipal: {
				namespace: 'dav',
				namespaceUri: 'DAV:',
				prefix: 'd',
				localName: 'current-user-principal',
				qualifiedName: 'd:current-user-principal',
			},
			resourceType: {
				namespace: 'dav',
				namespaceUri: 'DAV:',
				prefix: 'd',
				localName: 'resourcetype',
				qualifiedName: 'd:resourcetype',
			},
			displayName: {
				namespace: 'dav',
				namespaceUri: 'DAV:',
				prefix: 'd',
				localName: 'displayname',
				qualifiedName: 'd:displayname',
			},
			getEtag: {
				namespace: 'dav',
				namespaceUri: 'DAV:',
				prefix: 'd',
				localName: 'getetag',
				qualifiedName: 'd:getetag',
			},
			calendarHomeSet: {
				namespace: 'caldav',
				namespaceUri: 'urn:ietf:params:xml:ns:caldav',
				prefix: 'c',
				localName: 'calendar-home-set',
				qualifiedName: 'c:calendar-home-set',
			},
			calendarDescription: {
				namespace: 'caldav',
				namespaceUri: 'urn:ietf:params:xml:ns:caldav',
				prefix: 'c',
				localName: 'calendar-description',
				qualifiedName: 'c:calendar-description',
			},
			supportedCalendarComponentSet: {
				namespace: 'caldav',
				namespaceUri: 'urn:ietf:params:xml:ns:caldav',
				prefix: 'c',
				localName: 'supported-calendar-component-set',
				qualifiedName: 'c:supported-calendar-component-set',
			},
			calendarQuery: {
				namespace: 'caldav',
				namespaceUri: 'urn:ietf:params:xml:ns:caldav',
				prefix: 'c',
				localName: 'calendar-query',
				qualifiedName: 'c:calendar-query',
			},
			calendarData: {
				namespace: 'caldav',
				namespaceUri: 'urn:ietf:params:xml:ns:caldav',
				prefix: 'c',
				localName: 'calendar-data',
				qualifiedName: 'c:calendar-data',
			},
			filter: {
				namespace: 'caldav',
				namespaceUri: 'urn:ietf:params:xml:ns:caldav',
				prefix: 'c',
				localName: 'filter',
				qualifiedName: 'c:filter',
			},
			compFilter: {
				namespace: 'caldav',
				namespaceUri: 'urn:ietf:params:xml:ns:caldav',
				prefix: 'c',
				localName: 'comp-filter',
				qualifiedName: 'c:comp-filter',
			},
			propFilter: {
				namespace: 'caldav',
				namespaceUri: 'urn:ietf:params:xml:ns:caldav',
				prefix: 'c',
				localName: 'prop-filter',
				qualifiedName: 'c:prop-filter',
			},
			textMatch: {
				namespace: 'caldav',
				namespaceUri: 'urn:ietf:params:xml:ns:caldav',
				prefix: 'c',
				localName: 'text-match',
				qualifiedName: 'c:text-match',
			},
			timeRange: {
				namespace: 'caldav',
				namespaceUri: 'urn:ietf:params:xml:ns:caldav',
				prefix: 'c',
				localName: 'time-range',
				qualifiedName: 'c:time-range',
			},
		});
	});
});

describe('CalDAV XML escaping', () => {
	it.each([escapeXmlText, escapeXmlAttribute])(
		'escapes all five metacharacters exactly once',
		(escape) => {
			expect(escape(`A&<>"'`)).toBe('A&amp;&lt;&gt;&quot;&apos;');
			expect(escape('A&amp;B')).toBe('A&amp;amp;B');
		},
	);

	it.each([escapeXmlText, escapeXmlAttribute])(
		'preserves every valid XML character including supplementary Unicode',
		(escape) => {
			const value = 'tab\tline\nreturn\r latin-ž emoji-😀 max-\u{10ffff}';
			expect(escape(value)).toBe(value);
		},
	);

	it.each([
		['null', '\u0000'],
		['prohibited control', '\u001f'],
		['isolated high surrogate', '\ud800'],
		['isolated low surrogate', '\udfff'],
		['noncharacter U+FFFE', '\ufffe'],
		['noncharacter U+FFFF', '\uffff'],
	] as const)('rejects an XML-invalid %s without leaking input', (_label, invalidCharacter) => {
		for (const escape of [escapeXmlText, escapeXmlAttribute]) {
			const error = captureError(() => escape(`private-sentinel${invalidCharacter}`));

			expect(error.name).toBe('XmlBuildError');
			expect(error.code).toBe('INVALID_XML_CHARACTER');
			expect(error.message).not.toContain('private-sentinel');
		}
	});

	it.each([undefined, null, 42, false, {}])('rejects runtime non-string value %j', (value) => {
		const error = captureError(() => escapeXmlText(value as unknown as string));

		expect(error.code).toBe('INVALID_XML_VALUE');
	});
});

describe('CalDAV PROPFIND request builders', () => {
	it('exports the exact immutable fixed property sets', () => {
		expect(CURRENT_USER_PRINCIPAL_PROPERTIES).toEqual(['currentUserPrincipal']);
		expect(CALENDAR_HOME_PROPERTIES).toEqual(['calendarHomeSet']);
		expect(CALENDAR_COLLECTION_PROPERTIES).toEqual([
			'resourceType',
			'displayName',
			'calendarDescription',
			'supportedCalendarComponentSet',
		]);
		expect(Object.isFrozen(CURRENT_USER_PRINCIPAL_PROPERTIES)).toBe(true);
		expect(Object.isFrozen(CALENDAR_HOME_PROPERTIES)).toBe(true);
		expect(Object.isFrozen(CALENDAR_COLLECTION_PROPERTIES)).toBe(true);
	});

	it('builds the exact current-user-principal golden document', () => {
		const document = buildCurrentUserPrincipalPropfind();

		expect(document).toBe(`${XML_DECLARATION}
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:current-user-principal/>
  </d:prop>
</d:propfind>`);
		expectCleanDocument(document);
	});

	it('builds the exact calendar-home golden document', () => {
		const document = buildCalendarHomeSetPropfind();

		expect(document).toBe(`${XML_DECLARATION}
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <c:calendar-home-set/>
  </d:prop>
</d:propfind>`);
		expectCleanDocument(document);
	});

	it('preserves property order and multiplicity while reusing namespace declarations', () => {
		const properties = Object.freeze([
			'calendarDescription',
			'currentUserPrincipal',
			'calendarDescription',
		] as const);
		const document = buildPropfindRequest(properties);

		expect(document).toBe(`${XML_DECLARATION}
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <c:calendar-description/>
    <d:current-user-principal/>
    <c:calendar-description/>
  </d:prop>
</d:propfind>`);
		expect(document.match(/xmlns:d=/g)).toHaveLength(1);
		expect(document.match(/xmlns:c=/g)).toHaveLength(1);
		expect(properties).toEqual([
			'calendarDescription',
			'currentUserPrincipal',
			'calendarDescription',
		]);
	});

	it('builds the fixed collection listing property request', () => {
		expect(buildCalendarCollectionListingPropfind()).toBe(`${XML_DECLARATION}
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <c:calendar-description/>
    <c:supported-calendar-component-set/>
  </d:prop>
</d:propfind>`);
	});

	it.each([
		['non-array property set', 'currentUserPrincipal' as unknown],
		['missing property set', undefined],
		['empty property set', []],
	] as const)('rejects a %s', (_label, properties) => {
		const error = captureError(() =>
			buildPropfindRequest(properties as readonly PropfindPropertyName[]),
		);

		expect(error.code).toBe('INVALID_PROPERTY_SET');
	});

	it('rejects unknown runtime properties without leaking their name', () => {
		const error = captureError(() =>
			buildPropfindRequest(['private-property-sentinel'] as unknown as PropfindPropertyName[]),
		);

		expect(error.code).toBe('UNKNOWN_PROPERTY');
		expect(error.message).not.toContain('private-property-sentinel');
	});

	it('sanitizes failures from property element getters', () => {
		const properties: PropfindPropertyName[] = ['currentUserPrincipal'];
		Object.defineProperty(properties, 0, {
			get: () => {
				throw new Error('private-property-getter-sentinel');
			},
		});

		const error = captureError(() => buildPropfindRequest(properties));

		expect(error.code).toBe('UNKNOWN_PROPERTY');
		expect(error.field).toBe('properties');
		expect(error.message).not.toContain('private-property-getter-sentinel');
	});

	it('sanitizes failures from property array proxies', () => {
		const properties = new Proxy<PropfindPropertyName[]>(['currentUserPrincipal'], {
			get: (target, property, receiver) => {
				if (property === 'length') {
					throw new Error('private-property-proxy-sentinel');
				}

				return Reflect.get(target, property, receiver);
			},
		});

		const error = captureError(() => buildPropfindRequest(properties));

		expect(error.code).toBe('INVALID_PROPERTY_SET');
		expect(error.field).toBe('properties');
		expect(error.message).not.toContain('private-property-proxy-sentinel');
	});
});

describe('CalDAV REPORT request builders', () => {
	it('builds the exact UID query and escapes the supplied UID as text', () => {
		const uid = ` Case & <unsafe attr="value"> 'UID' `;
		const document = buildCalendarUidQueryReport({ uid });

		expect(document).toBe(`${XML_DECLARATION}
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:prop-filter name="UID">
          <c:text-match collation="i;octet"> Case &amp; &lt;unsafe attr=&quot;value&quot;&gt; &apos;UID&apos; </c:text-match>
        </c:prop-filter>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`);
		expect(document).not.toContain('<unsafe');
		expect(document.match(/xmlns:d=/g)).toHaveLength(1);
		expect(document.match(/xmlns:c=/g)).toHaveLength(1);
		expectCleanDocument(document);
	});

	it('preserves entity-looking UID text without normalization', () => {
		const document = buildCalendarUidQueryReport({ uid: '  Mixed&amp;Case  ' });

		expect(document).toContain('>  Mixed&amp;amp;Case  </c:text-match>');
	});

	it.each([
		['empty UID', { uid: '' }],
		['non-string UID', { uid: 42 }],
		['missing UID', {}],
		['missing input', null],
	] as const)('rejects %s with a typed sanitized error', (_label, input) => {
		const error = captureError(() =>
			buildCalendarUidQueryReport(input as unknown as CalendarUidQueryInput),
		);

		expect(error.code).toBe('INVALID_UID');
		expect(error.field).toBe('uid');
	});

	it('sanitizes failures from the UID input getter', () => {
		const input = Object.defineProperty({}, 'uid', {
			get: () => {
				throw new Error('private-uid-getter-sentinel');
			},
		}) as CalendarUidQueryInput;

		const error = captureError(() => buildCalendarUidQueryReport(input));

		expect(error.code).toBe('INVALID_UID');
		expect(error.field).toBe('uid');
		expect(error.message).not.toContain('private-uid-getter-sentinel');
	});

	it('rejects an XML-invalid UID without leaking it', () => {
		const error = captureError(() =>
			buildCalendarUidQueryReport({ uid: 'private-uid-sentinel\u0000' }),
		);

		expect(error.code).toBe('INVALID_XML_CHARACTER');
		expect(error.message).not.toContain('private-uid-sentinel');
	});

	it('builds the exact UTC time-range query', () => {
		const document = buildCalendarTimeRangeQueryReport({
			start: new Date('2026-01-02T03:04:05.000Z'),
			end: new Date('2026-12-31T23:59:59.000Z'),
		});

		expect(document).toBe(`${XML_DECLARATION}
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="20260102T030405Z" end="20261231T235959Z"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`);
		expectCleanDocument(document);
	});

	it('accepts valid Date objects created in another realm', () => {
		const start = runInNewContext(`new Date('2026-03-04T05:06:07.000Z')`) as Date;
		const end = runInNewContext(`new Date('2026-03-05T06:07:08.000Z')`) as Date;

		expect(start).not.toBeInstanceOf(Date);
		expect(buildCalendarTimeRangeQueryReport({ start, end })).toContain(
			'<c:time-range start="20260304T050607Z" end="20260305T060708Z"/>',
		);
	});

	it.each([
		['non-Date start', { start: '2026-01-01', end: new Date('2026-01-02T00:00:00Z') }, 'start'],
		[
			'invalid start',
			{ start: new Date(Number.NaN), end: new Date('2026-01-02T00:00:00Z') },
			'start',
		],
		[
			'start milliseconds',
			{ start: new Date('2026-01-01T00:00:00.001Z'), end: new Date('2026-01-02T00:00:00Z') },
			'start',
		],
		[
			'end milliseconds',
			{ start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-01-02T00:00:00.001Z') },
			'end',
		],
	] as const)('rejects %s', (_label, input, field) => {
		const error = captureError(() =>
			buildCalendarTimeRangeQueryReport(input as unknown as CalendarTimeRangeQueryInput),
		);

		expect(error.code).toBe('INVALID_DATE');
		expect(error.field).toBe(field);
	});

	it('rejects Date-like impostors without invoking their methods', () => {
		const getTime = () => new Date('2026-01-01T00:00:00Z').getTime();
		const input = {
			start: { getTime },
			end: new Date('2026-01-02T00:00:00Z'),
		} as unknown as CalendarTimeRangeQueryInput;

		const error = captureError(() => buildCalendarTimeRangeQueryReport(input));

		expect(error.code).toBe('INVALID_DATE');
		expect(error.field).toBe('start');
	});

	it.each([
		['start', 'private-start-getter-sentinel'],
		['end', 'private-end-getter-sentinel'],
	] as const)('sanitizes failures from the %s input getter', (field, sentinel) => {
		const input = {
			start: new Date('2026-01-01T00:00:00Z'),
			end: new Date('2026-01-02T00:00:00Z'),
		};
		Object.defineProperty(input, field, {
			get: () => {
				throw new Error(sentinel);
			},
		});

		const error = captureError(() => buildCalendarTimeRangeQueryReport(input));

		expect(error.code).toBe('INVALID_DATE');
		expect(error.field).toBe(field);
		expect(error.message).not.toContain(sentinel);
	});

	it.each([
		['equal endpoints', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'],
		['decreasing endpoints', '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z'],
	] as const)('rejects %s', (_label, start, end) => {
		const error = captureError(() =>
			buildCalendarTimeRangeQueryReport({ start: new Date(start), end: new Date(end) }),
		);

		expect(error.code).toBe('INVALID_TIME_RANGE');
	});

	it('rejects years that cannot be serialized with exactly four digits', () => {
		const negativeYear = new Date('2026-01-01T00:00:00Z');
		const ordinaryEnd = new Date('2026-01-02T00:00:00Z');
		negativeYear.setUTCFullYear(-1);

		expect(
			captureError(() =>
				buildCalendarTimeRangeQueryReport({ start: negativeYear, end: ordinaryEnd }),
			).code,
		).toBe('INVALID_DATE');

		const validStart = new Date('2026-01-01T00:00:00Z');
		const fiveDigitEnd = new Date('2026-01-02T00:00:00Z');
		validStart.setUTCFullYear(9_999);
		fiveDigitEnd.setUTCFullYear(10_000);
		expect(
			captureError(() =>
				buildCalendarTimeRangeQueryReport({ start: validStart, end: fiveDigitEnd }),
			).code,
		).toBe('INVALID_DATE');
	});

	it('is deterministic and does not mutate inputs', () => {
		const uidInput = Object.freeze({ uid: 'deterministic-uid' });
		const start = new Date('2026-02-03T04:05:06Z');
		const end = new Date('2026-02-04T04:05:06Z');
		const startTime = start.getTime();
		const endTime = end.getTime();

		expect(buildCalendarUidQueryReport(uidInput)).toBe(buildCalendarUidQueryReport(uidInput));
		expect(buildCalendarTimeRangeQueryReport({ start, end })).toBe(
			buildCalendarTimeRangeQueryReport({ start, end }),
		);
		expect(start.getTime()).toBe(startTime);
		expect(end.getTime()).toBe(endTime);
	});
});
