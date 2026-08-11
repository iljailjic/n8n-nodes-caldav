import { describe, expect, it } from 'vitest';

import {
	CalDavXmlParseError,
	CalDavXmlProtocolError,
	parseDavMultiStatus,
} from '../../nodes/CalDav/xml/parser';

const dav = 'DAV:';

function propstatDocument(body: string): string {
	return `<multistatus xmlns="DAV:"><response><href>/calendar/a%20b.ics</href>${body}</response></multistatus>`;
}

function propstat(properties: string, status = 'HTTP/1.1 200 OK'): string {
	return `<propstat><prop>${properties}</prop><status>${status}</status></propstat>`;
}

function expectParseError(xml: string, code: CalDavXmlParseError['code']): void {
	try {
		parseDavMultiStatus(xml);
		expect.unreachable('Expected XML parsing to fail');
	} catch (error) {
		expect(error).toBeInstanceOf(CalDavXmlParseError);
		expect(error).toMatchObject({ name: 'CalDavXmlParseError', code });
	}
}

function expectProtocolError(xml: string, code: CalDavXmlProtocolError['code']): void {
	try {
		parseDavMultiStatus(xml);
		expect.unreachable('Expected WebDAV validation to fail');
	} catch (error) {
		expect(error).toBeInstanceOf(CalDavXmlProtocolError);
		expect(error).toMatchObject({ name: 'CalDavXmlProtocolError', code });
	}
}

describe('parseDavMultiStatus', () => {
	it.each([
		['FORBIDDEN_DECLARATION', 'The XML document contains a forbidden declaration.'],
		['MALFORMED_XML', 'The XML document is malformed.'],
		['TRUNCATED_XML', 'The XML document ended unexpectedly.'],
		['INVALID_CHARACTER_REFERENCE', 'The XML document contains an invalid character reference.'],
		['UNSUPPORTED_ENTITY_REFERENCE', 'The XML document contains an unsupported entity reference.'],
		['DUPLICATE_ATTRIBUTE', 'The XML document contains a duplicate attribute.'],
		['INVALID_QUALIFIED_NAME', 'The XML document contains an invalid qualified name.'],
		[
			'INVALID_NAMESPACE_DECLARATION',
			'The XML document contains an invalid namespace declaration.',
		],
		['UNBOUND_NAMESPACE_PREFIX', 'The XML document uses an unbound namespace prefix.'],
		['MAX_DEPTH_EXCEEDED', 'The XML document exceeds the maximum nesting depth.'],
		['MAX_ELEMENT_COUNT_EXCEEDED', 'The XML document exceeds the maximum element count.'],
	] as const)('exposes the fixed sanitized parse error for %s', (code, message) => {
		expect(new CalDavXmlParseError(code)).toMatchObject({
			name: 'CalDavXmlParseError',
			code,
			message,
		});
	});

	it.each([
		['INVALID_MULTISTATUS', 'The WebDAV multistatus response is invalid.'],
		['INVALID_RESPONSE', 'A WebDAV response element is invalid.'],
		['INVALID_PROPSTAT', 'A WebDAV propstat element is invalid.'],
		['INVALID_STATUS', 'A WebDAV status element is invalid.'],
	] as const)('exposes the fixed sanitized protocol error for %s', (code, message) => {
		expect(new CalDavXmlProtocolError(code)).toMatchObject({
			name: 'CalDavXmlProtocolError',
			code,
			message,
		});
	});

	it('returns identical results for default and renamed DAV prefixes', () => {
		const defaultNamespace = propstatDocument(
			propstat('<displayname>Team</displayname><getetag>"one"</getetag>'),
		);
		const renamedPrefix =
			'<x:multistatus xmlns:x="DAV:"><x:response><x:href>/calendar/a%20b.ics</x:href>' +
			'<x:propstat><x:prop><x:displayname>Team</x:displayname><x:getetag>"one"</x:getetag></x:prop>' +
			'<x:status>HTTP/1.1 200 OK</x:status></x:propstat></x:response></x:multistatus>';

		expect(parseDavMultiStatus(defaultNamespace)).toEqual(parseDavMultiStatus(renamedPrefix));
	});

	it('retains every propstat but exposes only successful repeated properties in order', () => {
		const parsed = parseDavMultiStatus(
			propstatDocument(
				propstat('<displayname>first</displayname><displayname>second</displayname>') +
					propstat('<getetag>missing</getetag>', 'HTTP/1.1 404 Not Found') +
					propstat('<owner/>', 'HTTP/1.1 403 Forbidden'),
			),
		);
		const response = parsed.responses[0];

		expect(response).toMatchObject({
			kind: 'propstat',
			hrefs: ['/calendar/a%20b.ics'],
			status: null,
		});
		if (response?.kind !== 'propstat') throw new Error('unexpected test result');
		expect(response.propstats.map(({ status }) => status.code)).toEqual([200, 404, 403]);
		expect(response.successfulProperties.map(({ name }) => name)).toEqual([
			{ namespaceUri: dav, localName: 'displayname' },
			{ namespaceUri: dav, localName: 'displayname' },
		]);
	});

	it('parses status responses with multiple opaque hrefs', () => {
		const parsed = parseDavMultiStatus(
			'<D:multistatus xmlns:D="DAV:"><D:response>' +
				'<D:href>../locked%2Fone</D:href><D:href>https://example.test/cal/a%20b</D:href>' +
				'<D:status>HTTP/1.1 423 Locked</D:status></D:response></D:multistatus>',
		);

		expect(parsed.responses[0]).toEqual({
			kind: 'status',
			hrefs: ['../locked%2Fone', 'https://example.test/cal/a%20b'],
			status: { httpVersion: '1.1', code: 423, reasonPhrase: 'Locked', isSuccessful: false },
			propstats: [],
			successfulProperties: [],
		});
	});

	it('preserves decoded href whitespace and rejects duplicates after decoding', () => {
		const response = parseDavMultiStatus(
			'<multistatus xmlns="DAV:"><response><href> ../a&amp;b\n</href>' +
				'<status>HTTP/1.1 200 OK</status></response></multistatus>',
		).responses[0];
		expect(response?.hrefs).toEqual([' ../a&b\n']);

		expectProtocolError(
			'<multistatus xmlns="DAV:"><response><href>a&amp;b</href><href>a&#38;b</href>' +
				'<status>HTTP/1.1 200 OK</status></response></multistatus>',
			'INVALID_RESPONSE',
		);
	});

	it('preserves expanded unknown property trees, normalized attributes, mixed text, and whitespace', () => {
		const parsed = parseDavMultiStatus(
			propstatDocument(
				propstat(
					'<z:custom xmlns:z="urn:custom" z:mode="yes" plain="x\r\ny"> alpha<![CDATA[&beta]]>' +
						'<z:child xml:lang="en">value&#x21;</z:child> omega </z:custom>',
				),
			),
		);
		const response = parsed.responses[0];

		if (response?.kind !== 'propstat') throw new Error('unexpected test result');
		expect(response.successfulProperties[0]).toEqual({
			kind: 'element',
			name: { namespaceUri: 'urn:custom', localName: 'custom' },
			attributes: [
				{ name: { namespaceUri: 'urn:custom', localName: 'mode' }, value: 'yes' },
				{ name: { namespaceUri: null, localName: 'plain' }, value: 'x y' },
			],
			children: [
				{ kind: 'text', value: ' alpha&beta' },
				{
					kind: 'element',
					name: { namespaceUri: 'urn:custom', localName: 'child' },
					attributes: [
						{
							name: { namespaceUri: 'http://www.w3.org/XML/1998/namespace', localName: 'lang' },
							value: 'en',
						},
					],
					children: [{ kind: 'text', value: 'value!' }],
				},
				{ kind: 'text', value: ' omega ' },
			],
		});
	});

	it('coalesces semantic text and ignores comments and processing instructions', () => {
		const variants = [
			propstatDocument(propstat('<displayname>A&amp;B</displayname>')),
			propstatDocument(
				propstat('<displayname>A<![CDATA[&]]><!-- hidden --><?inside ok?>B</displayname>'),
			),
		];

		expect(parseDavMultiStatus(variants[0])).toEqual(parseDavMultiStatus(variants[1]));
	});

	it('accepts an empty multistatus and strict valid HTTP status variants', () => {
		expect(
			parseDavMultiStatus('\uFEFF<?xml version="1.0"?><!--a--><multistatus xmlns="DAV:"/>'),
		).toEqual({
			responses: [],
		});
		const response = parseDavMultiStatus(
			'<multistatus xmlns="DAV:"><response><href>x</href><status>HTTP/9.8 199 </status></response></multistatus>',
		).responses[0];
		expect(response?.status).toEqual({
			httpVersion: '9.8',
			code: 199,
			reasonPhrase: '',
			isSuccessful: false,
		});
	});

	it('supports XML-name processing-instruction targets and validates the XML declaration', () => {
		expect(
			parseDavMultiStatus(
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><?a:b data?>' +
					'<multistatus xmlns="DAV:"/>',
			),
		).toEqual({ responses: [] });
		expectParseError('<?xml version="&#49;.0"?><multistatus xmlns="DAV:"/>', 'MALFORMED_XML');
	});

	it.each([
		'<!DOCTYPE multistatus><multistatus xmlns="DAV:"/>',
		'<!DOCTYPE multistatus [<!ENTITY x "value">]><multistatus xmlns="DAV:"/>',
		'<!DOCTYPE multistatus [<!-- ] --> <!ENTITY x "value">]><multistatus xmlns="DAV:"/>',
		'<!DOCTYPE multistatus SYSTEM "private.dtd"><multistatus xmlns="DAV:"/>',
		'<!DOCTYPE multistatus PUBLIC "id" "private.dtd"><multistatus xmlns="DAV:"/>',
		'<!ENTITY % x SYSTEM "private.dtd"><multistatus xmlns="DAV:"/>',
	])('rejects actual DTD/entity declarations before parsing', (xml) => {
		expectParseError(xml, 'FORBIDDEN_DECLARATION');
	});

	it.each(['<!DOCTYPE multistatus', '<!ENTITY x "value"'])(
		'classifies unfinished forbidden declarations as truncated',
		(xml) => {
			expectParseError(xml, 'TRUNCATED_XML');
		},
	);

	it('treats declaration keywords case-sensitively', () => {
		expectParseError('<!doctype multistatus><multistatus xmlns="DAV:"/>', 'MALFORMED_XML');
	});

	it('does not mistake declaration markers in valid content contexts for declarations', () => {
		const xml = propstatDocument(
			propstat(
				'<displayname>&lt;!DOCTYPE safe&gt;</displayname>' +
					'<x:data xmlns:x="urn:x"><![CDATA[<!ENTITY safe>]]><!-- <!DOCTYPE safe> --><?p <!ENTITY safe>?></x:data>',
			),
		);
		expect(parseDavMultiStatus(xml).responses).toHaveLength(1);
	});

	it.each([
		['&custom;', 'UNSUPPORTED_ENTITY_REFERENCE'],
		['&#0;', 'INVALID_CHARACTER_REFERENCE'],
		['&#xD800;', 'INVALID_CHARACTER_REFERENCE'],
		['&#x110000;', 'INVALID_CHARACTER_REFERENCE'],
		['&#xZZ;', 'INVALID_CHARACTER_REFERENCE'],
		['&#X41;', 'INVALID_CHARACTER_REFERENCE'],
	] as const)('rejects unsupported or illegal references', (reference, code) => {
		expectParseError(propstatDocument(propstat(`<displayname>${reference}</displayname>`)), code);
	});

	it('accepts depth 64 and rejects depth 65', () => {
		const nested = (count: number) => '<x xmlns="urn:x">'.repeat(count) + '</x>'.repeat(count);
		const baseDepth = 5; // multistatus, response, propstat, prop, property

		expect(() =>
			parseDavMultiStatus(
				propstatDocument(propstat(`<p xmlns="urn:p">${nested(64 - baseDepth)}</p>`)),
			),
		).not.toThrow();
		expectParseError(
			propstatDocument(propstat(`<p xmlns="urn:p">${nested(65 - baseDepth)}</p>`)),
			'MAX_DEPTH_EXCEEDED',
		);
	});

	it('accepts 100000 elements and rejects 100001 elements', () => {
		const documentWithElements = (count: number) => {
			const fixedElements = 6; // multistatus, response, href, propstat, prop, status
			return propstatDocument(propstat('<x xmlns="urn:x"/>'.repeat(count - fixedElements)));
		};

		expect(() => parseDavMultiStatus(documentWithElements(100_000))).not.toThrow();
		expectParseError(documentWithElements(100_001), 'MAX_ELEMENT_COUNT_EXCEEDED');
	});

	it('applies namespace scope to the declaring element while keeping unprefixed attributes unqualified', () => {
		const xml =
			'<multistatus xmlns="DAV:"><response><href>x</href><propstat><prop>' +
			'<x xmlns="urn:outer" a="1"><y xmlns="" b="2"/></x>' +
			'</prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>';
		const response = parseDavMultiStatus(xml).responses[0];
		if (response?.kind !== 'propstat') throw new Error('unexpected test result');
		expect(response.successfulProperties[0]).toMatchObject({
			name: { namespaceUri: 'urn:outer', localName: 'x' },
			attributes: [{ name: { namespaceUri: null, localName: 'a' }, value: '1' }],
			children: [
				{
					name: { namespaceUri: null, localName: 'y' },
					attributes: [{ name: { namespaceUri: null, localName: 'b' }, value: '2' }],
				},
			],
		});
	});

	it('supports nested prefix rebinding and aliases to the same namespace', () => {
		const response = parseDavMultiStatus(
			propstatDocument(
				propstat(
					'<a:x xmlns:a="urn:one"><a:y xmlns:a="urn:two" xmlns:b="urn:two" b:value="ok"/></a:x>',
				),
			),
		).responses[0];
		if (response?.kind !== 'propstat') throw new Error('unexpected test result');
		expect(response.successfulProperties[0]).toMatchObject({
			name: { namespaceUri: 'urn:one', localName: 'x' },
			children: [
				{
					name: { namespaceUri: 'urn:two', localName: 'y' },
					attributes: [{ name: { namespaceUri: 'urn:two', localName: 'value' }, value: 'ok' }],
				},
			],
		});
	});

	it.each([
		['<x xmlns:p="u" xmlns:p="v"/>', 'DUPLICATE_ATTRIBUTE'],
		['<x xmlns:p=""/>', 'INVALID_NAMESPACE_DECLARATION'],
		['<x xmlns:xml="not-xml"/>', 'INVALID_NAMESPACE_DECLARATION'],
		['<x xmlns:xmlns="urn:x"/>', 'INVALID_NAMESPACE_DECLARATION'],
		['<x xmlns="http://www.w3.org/2000/xmlns/"/>', 'INVALID_NAMESPACE_DECLARATION'],
		['<x p:a="1"/>', 'UNBOUND_NAMESPACE_PREFIX'],
		['<p:x/>', 'UNBOUND_NAMESPACE_PREFIX'],
		['<x a="1" a="2"/>', 'DUPLICATE_ATTRIBUTE'],
		['<x xmlns:a="u" xmlns:b="u" a:v="1" b:v="2"/>', 'DUPLICATE_ATTRIBUTE'],
		['<x:a:b/>', 'INVALID_QUALIFIED_NAME'],
	] as const)('rejects invalid namespace and attribute constructs', (property, code) => {
		expectParseError(propstatDocument(propstat(property)), code);
	});

	it.each([
		['<multistatus xmlns="DAV:"><response></multistatus>', 'MALFORMED_XML'],
		['<multistatus xmlns="DAV:"><response>', 'TRUNCATED_XML'],
		['<multistatus xmlns="DAV:"><!--', 'TRUNCATED_XML'],
		['<multistatus xmlns="DAV:"><![CDATA[', 'TRUNCATED_XML'],
		['<multistatus xmlns="DAV:"><?p', 'TRUNCATED_XML'],
		['<multistatus xmlns="DAV:"><?p? bad?></multistatus>', 'MALFORMED_XML'],
		['<multistatus xmlns="DAV:"></multistatus><x/>', 'MALFORMED_XML'],
	] as const)('classifies malformed and truncated XML', (xml, code) => {
		expectParseError(xml, code);
	});

	it.each([
		['<x:multistatus xmlns:x="urn:not-dav"/>', 'INVALID_MULTISTATUS'],
		[
			'<multistatus xmlns="DAV:"><response><href>x</href></response></multistatus>',
			'INVALID_RESPONSE',
		],
		[
			'<multistatus xmlns="DAV:"><response><href>x</href><href>x</href><status>HTTP/1.1 200 OK</status></response></multistatus>',
			'INVALID_RESPONSE',
		],
		[
			propstatDocument(
				'<propstat><prop/><status>HTTP/1.1 200 OK</status><status>HTTP/1.1 404 Nope</status></propstat>',
			),
			'INVALID_PROPSTAT',
		],
		[
			propstatDocument(propstat('<displayname/>') + '<status>HTTP/1.1 200 OK</status>'),
			'INVALID_RESPONSE',
		],
	] as const)('rejects invalid DAV shapes', (xml, code) => {
		expectProtocolError(xml, code);
	});

	it('does not allow unknown structural wrappers to fulfill direct DAV requirements', () => {
		expectProtocolError(
			'<multistatus xmlns="DAV:"><response><extension><href>x</href>' +
				'<status>HTTP/1.1 200 OK</status></extension></response></multistatus>',
			'INVALID_RESPONSE',
		);
	});

	it.each([
		'http/1.1 200 OK',
		'HTTP/1.1 099 Bad',
		'HTTP/1.1 600 Bad',
		'HTTP/1.1 200',
		'HTTP/1.1  200 OK',
		' HTTP/1.1 200 OK',
		'HTTP/1.1 200 OK\n',
		'HTTP/10.1 200 OK',
	])('rejects invalid strict HTTP status text', (status) => {
		expectProtocolError(
			`<multistatus xmlns="DAV:"><response><href>x</href><status>${status}</status></response></multistatus>`,
			'INVALID_STATUS',
		);
	});

	it('never includes private source data or dynamic fields in errors', () => {
		const sentinel = 'PRIVATE-CALENDAR-SENTINEL';
		const inputs = [
			`<multistatus xmlns="DAV:"><response><href>${sentinel}</href>`,
			`<multistatus xmlns="DAV:"><response><href>${sentinel}</href></response></multistatus>`,
		];

		for (const input of inputs) {
			try {
				parseDavMultiStatus(input);
				expect.unreachable('Expected failure');
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error as object));
				expect(`${String(error)} ${serialized}`).not.toContain(sentinel);
				expect(error).not.toHaveProperty('cause');
			}
		}
	});
});
