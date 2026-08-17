const DAV_NAMESPACE = 'DAV:';
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';
const MAX_DEPTH = 64;
const MAX_ELEMENTS = 100_000;
const MAX_CALDAV_ERROR_DOCUMENT_BYTES = 8 * 1024;

export interface XmlExpandedName {
	readonly namespaceUri: string | null;
	readonly localName: string;
}

export interface DavXmlAttribute {
	readonly name: XmlExpandedName;
	readonly value: string;
}

export interface DavXmlText {
	readonly kind: 'text';
	readonly value: string;
}

export interface DavXmlElement {
	readonly kind: 'element';
	readonly name: XmlExpandedName;
	readonly attributes: readonly DavXmlAttribute[];
	readonly children: readonly DavXmlContent[];
}

export type DavXmlContent = DavXmlText | DavXmlElement;
export type DavProperty = DavXmlElement;

export interface DavStatus {
	readonly httpVersion: string;
	readonly code: number;
	readonly reasonPhrase: string;
	readonly isSuccessful: boolean;
}

export interface DavPropStat {
	readonly status: DavStatus;
	readonly properties: readonly DavProperty[];
}

export interface DavStatusResponse {
	readonly kind: 'status';
	readonly hrefs: readonly [string, ...string[]];
	readonly status: DavStatus;
	readonly propstats: readonly [];
	readonly successfulProperties: readonly [];
}

export interface DavPropertyResponse {
	readonly kind: 'propstat';
	readonly hrefs: readonly [string];
	readonly status: null;
	readonly propstats: readonly [DavPropStat, ...DavPropStat[]];
	readonly successfulProperties: readonly DavProperty[];
}

export type DavResponse = DavStatusResponse | DavPropertyResponse;

export interface DavMultiStatus {
	readonly responses: readonly DavResponse[];
}

export type CalDavXmlParseErrorCode =
	| 'FORBIDDEN_DECLARATION'
	| 'MALFORMED_XML'
	| 'TRUNCATED_XML'
	| 'INVALID_CHARACTER_REFERENCE'
	| 'UNSUPPORTED_ENTITY_REFERENCE'
	| 'DUPLICATE_ATTRIBUTE'
	| 'INVALID_QUALIFIED_NAME'
	| 'INVALID_NAMESPACE_DECLARATION'
	| 'UNBOUND_NAMESPACE_PREFIX'
	| 'MAX_DEPTH_EXCEEDED'
	| 'MAX_ELEMENT_COUNT_EXCEEDED';

export type CalDavXmlProtocolErrorCode =
	'INVALID_MULTISTATUS' | 'INVALID_RESPONSE' | 'INVALID_PROPSTAT' | 'INVALID_STATUS';

const PARSE_ERROR_MESSAGES: Readonly<Record<CalDavXmlParseErrorCode, string>> = {
	FORBIDDEN_DECLARATION: 'The XML document contains a forbidden declaration.',
	MALFORMED_XML: 'The XML document is malformed.',
	TRUNCATED_XML: 'The XML document ended unexpectedly.',
	INVALID_CHARACTER_REFERENCE: 'The XML document contains an invalid character reference.',
	UNSUPPORTED_ENTITY_REFERENCE: 'The XML document contains an unsupported entity reference.',
	DUPLICATE_ATTRIBUTE: 'The XML document contains a duplicate attribute.',
	INVALID_QUALIFIED_NAME: 'The XML document contains an invalid qualified name.',
	INVALID_NAMESPACE_DECLARATION: 'The XML document contains an invalid namespace declaration.',
	UNBOUND_NAMESPACE_PREFIX: 'The XML document uses an unbound namespace prefix.',
	MAX_DEPTH_EXCEEDED: 'The XML document exceeds the maximum nesting depth.',
	MAX_ELEMENT_COUNT_EXCEEDED: 'The XML document exceeds the maximum element count.',
};

const PROTOCOL_ERROR_MESSAGES: Readonly<Record<CalDavXmlProtocolErrorCode, string>> = {
	INVALID_MULTISTATUS: 'The WebDAV multistatus response is invalid.',
	INVALID_RESPONSE: 'A WebDAV response element is invalid.',
	INVALID_PROPSTAT: 'A WebDAV propstat element is invalid.',
	INVALID_STATUS: 'A WebDAV status element is invalid.',
};

export class CalDavXmlParseError extends Error {
	readonly code: CalDavXmlParseErrorCode;

	constructor(code: CalDavXmlParseErrorCode) {
		super(PARSE_ERROR_MESSAGES[code]);
		this.name = 'CalDavXmlParseError';
		this.code = code;
	}
}

export class CalDavXmlProtocolError extends Error {
	readonly code: CalDavXmlProtocolErrorCode;

	constructor(code: CalDavXmlProtocolErrorCode) {
		super(PROTOCOL_ERROR_MESSAGES[code]);
		this.name = 'CalDavXmlProtocolError';
		this.code = code;
	}
}

interface QualifiedName {
	readonly raw: string;
	readonly prefix: string | null;
	readonly localName: string;
}

interface LexicalAttribute {
	readonly name: QualifiedName;
	readonly value: string;
}

interface InternalElement extends DavXmlElement {
	readonly rawName: string;
	readonly children: InternalContent[];
}

type InternalContent = DavXmlText | InternalElement;

function isXmlWhitespace(character: string): boolean {
	return character === ' ' || character === '\t' || character === '\n' || character === '\r';
}

function isAsciiDigitCode(codePoint: number): boolean {
	return codePoint >= 0x30 && codePoint <= 0x39;
}

function isNameStartCodePoint(codePoint: number): boolean {
	return (
		(codePoint >= 0x41 && codePoint <= 0x5a) ||
		codePoint === 0x5f ||
		(codePoint >= 0x61 && codePoint <= 0x7a) ||
		(codePoint >= 0xc0 && codePoint <= 0xd6) ||
		(codePoint >= 0xd8 && codePoint <= 0xf6) ||
		(codePoint >= 0xf8 && codePoint <= 0x2ff) ||
		(codePoint >= 0x370 && codePoint <= 0x37d) ||
		(codePoint >= 0x37f && codePoint <= 0x1fff) ||
		(codePoint >= 0x200c && codePoint <= 0x200d) ||
		(codePoint >= 0x2070 && codePoint <= 0x218f) ||
		(codePoint >= 0x2c00 && codePoint <= 0x2fef) ||
		(codePoint >= 0x3001 && codePoint <= 0xd7ff) ||
		(codePoint >= 0xf900 && codePoint <= 0xfdcf) ||
		(codePoint >= 0xfdf0 && codePoint <= 0xfffd) ||
		(codePoint >= 0x10000 && codePoint <= 0xeffff)
	);
}

function isNameCodePoint(codePoint: number): boolean {
	return (
		isNameStartCodePoint(codePoint) ||
		codePoint === 0x2d ||
		codePoint === 0x2e ||
		isAsciiDigitCode(codePoint) ||
		codePoint === 0xb7 ||
		(codePoint >= 0x300 && codePoint <= 0x36f) ||
		(codePoint >= 0x203f && codePoint <= 0x2040)
	);
}

function isLegalXmlCodePoint(codePoint: number): boolean {
	return (
		codePoint === 0x9 ||
		codePoint === 0xa ||
		codePoint === 0xd ||
		(codePoint >= 0x20 && codePoint <= 0xd7ff) ||
		(codePoint >= 0xe000 && codePoint <= 0xfffd) ||
		(codePoint >= 0x10000 && codePoint <= 0x10ffff)
	);
}

function normalizeAndValidateDocument(input: string): string {
	let result = '';

	for (let index = 0; index < input.length;) {
		const codePoint = input.codePointAt(index);
		if (codePoint === undefined || !isLegalXmlCodePoint(codePoint)) {
			throw new CalDavXmlParseError('MALFORMED_XML');
		}

		if (codePoint === 0xd) {
			result += '\n';
			index += input.charCodeAt(index + 1) === 0xa ? 2 : 1;
			continue;
		}

		result += String.fromCodePoint(codePoint);
		index += codePoint > 0xffff ? 2 : 1;
	}

	return result;
}

function scanUntil(source: string, start: number, terminator: string): number {
	let index = start;
	while (index < source.length) {
		if (source.startsWith(terminator, index)) return index + terminator.length;
		index += 1;
	}
	throw new CalDavXmlParseError('TRUNCATED_XML');
}

function scanForbiddenDeclaration(
	source: string,
	start: number,
	hasInternalSubset: boolean,
): never {
	let index = start;
	let quote: string | null = null;
	let subsetDepth = 0;

	while (index < source.length) {
		const character = source[index];
		if (quote !== null) {
			if (character === quote) quote = null;
		} else if (source.startsWith('<!--', index)) {
			index = scanUntil(source, index + 4, '-->');
			continue;
		} else if (source.startsWith('<?', index)) {
			index = scanUntil(source, index + 2, '?>');
			continue;
		} else if (character === '"' || character === "'") {
			quote = character;
		} else if (hasInternalSubset && character === '[') {
			subsetDepth += 1;
		} else if (hasInternalSubset && character === ']' && subsetDepth > 0) {
			subsetDepth -= 1;
		} else if (character === '>' && subsetDepth === 0) {
			throw new CalDavXmlParseError('FORBIDDEN_DECLARATION');
		}
		index += 1;
	}

	throw new CalDavXmlParseError('TRUNCATED_XML');
}

function preflightForbiddenDeclarations(source: string): void {
	let index = source.charCodeAt(0) === 0xfeff ? 1 : 0;

	while (index < source.length) {
		if (source[index] !== '<') {
			index += 1;
			continue;
		}

		if (source.startsWith('<!--', index)) {
			index = scanUntil(source, index + 4, '-->');
			continue;
		}
		if (source.startsWith('<![CDATA[', index)) {
			index = scanUntil(source, index + 9, ']]>');
			continue;
		}
		if (source.startsWith('<?', index)) {
			index = scanUntil(source, index + 2, '?>');
			continue;
		}
		if (source.startsWith('<!DOCTYPE', index) && isXmlWhitespace(source[index + 9] ?? '')) {
			scanForbiddenDeclaration(source, index + 10, true);
		}
		if (source.startsWith('<!ENTITY', index) && isXmlWhitespace(source[index + 8] ?? '')) {
			scanForbiddenDeclaration(source, index + 9, false);
		}

		let quote: string | null = null;
		index += 1;
		while (index < source.length) {
			const character = source[index];
			if (quote !== null) {
				if (character === quote) quote = null;
			} else if (character === '"' || character === "'") {
				quote = character;
			} else if (character === '>') {
				index += 1;
				break;
			}
			index += 1;
		}
		if (index >= source.length && source[source.length - 1] !== '>') {
			throw new CalDavXmlParseError('TRUNCATED_XML');
		}
	}
}

class XmlCursorParser {
	private index = 0;
	private elementCount = 0;

	constructor(private readonly source: string) {}

	parseDocument(): InternalElement {
		if (this.peekCodeUnit() === 0xfeff) this.index += 1;
		this.parseOptionalXmlDeclaration();
		this.skipMiscellaneous();

		if (this.atEnd()) throw new CalDavXmlParseError('TRUNCATED_XML');
		if (this.peek() !== '<') throw new CalDavXmlParseError('MALFORMED_XML');

		const namespaces = new Map<string, string>();
		namespaces.set('xml', XML_NAMESPACE);
		const root = this.parseElement(namespaces, 1);
		this.skipMiscellaneous();
		if (!this.atEnd()) throw new CalDavXmlParseError('MALFORMED_XML');
		return root;
	}

	private parseOptionalXmlDeclaration(): void {
		if (!this.source.startsWith('<?xml', this.index)) return;
		const afterTarget = this.source[this.index + 5];
		if (afterTarget !== undefined && !isXmlWhitespace(afterTarget) && afterTarget !== '?') return;

		this.index += 5;
		if (!this.consumeWhitespace()) throw new CalDavXmlParseError('MALFORMED_XML');
		this.expectDeclarationAttribute('version', '1.0');

		let sawEncoding = false;
		let sawStandalone = false;
		while (true) {
			if (!this.consumeWhitespace()) break;
			if (this.source.startsWith('?>', this.index)) break;
			const name = this.readNameToken();
			this.skipWhitespace();
			this.expectCharacter('=');
			this.skipWhitespace();
			const value = this.readDeclarationValue();
			if (name === 'encoding' && !sawEncoding && !sawStandalone && isEncodingName(value)) {
				sawEncoding = true;
			} else if (name === 'standalone' && !sawStandalone && (value === 'yes' || value === 'no')) {
				sawStandalone = true;
			} else {
				throw new CalDavXmlParseError('MALFORMED_XML');
			}
		}

		if (!this.source.startsWith('?>', this.index)) {
			if (this.atEnd()) throw new CalDavXmlParseError('TRUNCATED_XML');
			throw new CalDavXmlParseError('MALFORMED_XML');
		}
		this.index += 2;
	}

	private expectDeclarationAttribute(name: string, value: string): void {
		if (this.readNameToken() !== name) throw new CalDavXmlParseError('MALFORMED_XML');
		this.skipWhitespace();
		this.expectCharacter('=');
		this.skipWhitespace();
		if (this.readDeclarationValue() !== value) throw new CalDavXmlParseError('MALFORMED_XML');
	}

	private readDeclarationValue(): string {
		const quote = this.peek();
		if (quote !== '"' && quote !== "'") {
			if (this.atEnd()) throw new CalDavXmlParseError('TRUNCATED_XML');
			throw new CalDavXmlParseError('MALFORMED_XML');
		}
		this.index += 1;
		const start = this.index;
		while (!this.atEnd() && this.peek() !== quote) {
			if (this.peek() === '<' || this.peek() === '&') {
				throw new CalDavXmlParseError('MALFORMED_XML');
			}
			this.index += 1;
		}
		if (this.atEnd()) throw new CalDavXmlParseError('TRUNCATED_XML');
		const value = this.source.slice(start, this.index);
		this.index += 1;
		return value;
	}

	private skipMiscellaneous(): void {
		while (true) {
			this.skipWhitespace();
			if (this.source.startsWith('<!--', this.index)) {
				this.parseComment();
				continue;
			}
			if (this.source.startsWith('<?', this.index)) {
				this.parseProcessingInstruction();
				continue;
			}
			return;
		}
	}

	private parseElement(
		parentNamespaces: ReadonlyMap<string, string>,
		depth: number,
	): InternalElement {
		if (depth > MAX_DEPTH) throw new CalDavXmlParseError('MAX_DEPTH_EXCEEDED');
		this.elementCount += 1;
		if (this.elementCount > MAX_ELEMENTS) {
			throw new CalDavXmlParseError('MAX_ELEMENT_COUNT_EXCEEDED');
		}

		this.expectCharacter('<');
		if (this.atEnd()) throw new CalDavXmlParseError('TRUNCATED_XML');
		if (this.peek() === '/' || this.peek() === '!' || this.peek() === '?') {
			throw new CalDavXmlParseError('MALFORMED_XML');
		}

		const elementName = this.readQualifiedName();
		const lexicalAttributes: LexicalAttribute[] = [];
		const lexicalNames = new Set<string>();
		let emptyElement = false;

		while (true) {
			const hadWhitespace = this.consumeWhitespace();
			if (this.source.startsWith('/>', this.index)) {
				this.index += 2;
				emptyElement = true;
				break;
			}
			if (this.peek() === '>') {
				this.index += 1;
				break;
			}
			if (this.atEnd()) throw new CalDavXmlParseError('TRUNCATED_XML');
			if (!hadWhitespace) throw new CalDavXmlParseError('MALFORMED_XML');

			const name = this.readQualifiedName();
			if (lexicalNames.has(name.raw)) {
				throw new CalDavXmlParseError('DUPLICATE_ATTRIBUTE');
			}
			lexicalNames.add(name.raw);
			this.skipWhitespace();
			this.expectCharacter('=');
			this.skipWhitespace();
			lexicalAttributes.push({ name, value: this.readQuotedLiteral(true) });
		}

		const namespaces = new Map(parentNamespaces);
		const declaredPrefixes = new Set<string>();
		for (const attribute of lexicalAttributes) {
			if (!isNamespaceDeclaration(attribute.name)) continue;
			const prefix = attribute.name.prefix === 'xmlns' ? attribute.name.localName : '';
			if (declaredPrefixes.has(prefix)) {
				throw new CalDavXmlParseError('INVALID_NAMESPACE_DECLARATION');
			}
			declaredPrefixes.add(prefix);
			validateNamespaceDeclaration(prefix, attribute.value);
			if (attribute.value === '') namespaces.delete(prefix);
			else namespaces.set(prefix, attribute.value);
		}

		const expandedElementName = expandName(elementName, namespaces, true);
		const attributes: DavXmlAttribute[] = [];
		const expandedAttributeNames = new Set<string>();
		for (const attribute of lexicalAttributes) {
			if (isNamespaceDeclaration(attribute.name)) continue;
			const name = expandName(attribute.name, namespaces, false);
			const identity = `${name.namespaceUri === null ? '-1' : name.namespaceUri.length}:${name.namespaceUri ?? ''}:${name.localName}`;
			if (expandedAttributeNames.has(identity)) {
				throw new CalDavXmlParseError('DUPLICATE_ATTRIBUTE');
			}
			expandedAttributeNames.add(identity);
			attributes.push({ name, value: attribute.value });
		}

		const children: InternalContent[] = [];
		if (!emptyElement) this.parseElementContent(children, namespaces, depth, elementName.raw);

		return {
			kind: 'element',
			rawName: elementName.raw,
			name: expandedElementName,
			attributes,
			children,
		};
	}

	private parseElementContent(
		children: InternalContent[],
		namespaces: ReadonlyMap<string, string>,
		depth: number,
		rawElementName: string,
	): void {
		while (true) {
			if (this.atEnd()) throw new CalDavXmlParseError('TRUNCATED_XML');
			if (this.source.startsWith('</', this.index)) {
				this.index += 2;
				const closingName = this.readQualifiedName();
				this.skipWhitespace();
				if (this.atEnd()) throw new CalDavXmlParseError('TRUNCATED_XML');
				this.expectCharacter('>');
				if (closingName.raw !== rawElementName) throw new CalDavXmlParseError('MALFORMED_XML');
				return;
			}
			if (this.source.startsWith('<!--', this.index)) {
				this.parseComment();
				continue;
			}
			if (this.source.startsWith('<?', this.index)) {
				this.parseProcessingInstruction();
				continue;
			}
			if (this.source.startsWith('<![CDATA[', this.index)) {
				this.index += 9;
				this.appendText(children, this.readUntil(']]>'));
				continue;
			}
			if (this.source.startsWith('<!', this.index)) {
				throw new CalDavXmlParseError('MALFORMED_XML');
			}
			if (this.peek() === '<') {
				children.push(this.parseElement(namespaces, depth + 1));
				continue;
			}
			this.appendText(children, this.readText());
		}
	}

	private readText(): string {
		let value = '';
		while (!this.atEnd() && this.peek() !== '<') {
			if (this.source.startsWith(']]>', this.index)) throw new CalDavXmlParseError('MALFORMED_XML');
			if (this.peek() === '&') value += this.readReference();
			else {
				value += this.peek();
				this.index += 1;
			}
		}
		return value;
	}

	private readQuotedLiteral(normalizeWhitespace: boolean): string {
		const quote = this.peek();
		if (quote !== '"' && quote !== "'") {
			if (this.atEnd()) throw new CalDavXmlParseError('TRUNCATED_XML');
			throw new CalDavXmlParseError('MALFORMED_XML');
		}
		this.index += 1;
		let value = '';
		while (!this.atEnd() && this.peek() !== quote) {
			const character = this.peek();
			if (character === '<') throw new CalDavXmlParseError('MALFORMED_XML');
			if (character === '&') value += this.readReference();
			else {
				value += normalizeWhitespace && isXmlWhitespace(character) ? ' ' : character;
				this.index += 1;
			}
		}
		if (this.atEnd()) throw new CalDavXmlParseError('TRUNCATED_XML');
		this.index += 1;
		return value;
	}

	private readReference(): string {
		this.expectCharacter('&');
		if (this.atEnd()) throw new CalDavXmlParseError('TRUNCATED_XML');
		let body = '';
		while (!this.atEnd() && this.peek() !== ';') {
			const character = this.peek();
			if (character === '<' || character === '&' || isXmlWhitespace(character)) {
				throw new CalDavXmlParseError('INVALID_CHARACTER_REFERENCE');
			}
			body += character;
			this.index += 1;
		}
		if (this.atEnd()) throw new CalDavXmlParseError('TRUNCATED_XML');
		this.index += 1;

		if (body.startsWith('#')) return decodeNumericReference(body);
		const predefined: Readonly<Record<string, string>> = {
			amp: '&',
			lt: '<',
			gt: '>',
			apos: "'",
			quot: '"',
		};
		const value = predefined[body];
		if (value === undefined) throw new CalDavXmlParseError('UNSUPPORTED_ENTITY_REFERENCE');
		return value;
	}

	private readQualifiedName(): QualifiedName {
		const raw = this.readNameToken();
		let colonIndex = -1;
		for (let index = 0; index < raw.length; index += 1) {
			if (raw[index] !== ':') continue;
			if (colonIndex !== -1) throw new CalDavXmlParseError('INVALID_QUALIFIED_NAME');
			colonIndex = index;
		}

		if (colonIndex === -1) {
			validateNcName(raw);
			return { raw, prefix: null, localName: raw };
		}

		const prefix = raw.slice(0, colonIndex);
		const localName = raw.slice(colonIndex + 1);
		validateNcName(prefix);
		validateNcName(localName);
		return { raw, prefix, localName };
	}

	private readNameToken(): string {
		const start = this.index;
		while (!this.atEnd()) {
			const character = this.peek();
			if (
				isXmlWhitespace(character) ||
				character === '/' ||
				character === '>' ||
				character === '=' ||
				character === '?'
			) {
				break;
			}
			this.index += 1;
		}
		if (start === this.index) {
			if (this.atEnd()) throw new CalDavXmlParseError('TRUNCATED_XML');
			throw new CalDavXmlParseError('INVALID_QUALIFIED_NAME');
		}
		return this.source.slice(start, this.index);
	}

	private parseComment(): void {
		this.index += 4;
		while (!this.atEnd()) {
			if (this.source.startsWith('-->', this.index)) {
				this.index += 3;
				return;
			}
			if (this.source.startsWith('--', this.index)) throw new CalDavXmlParseError('MALFORMED_XML');
			this.index += 1;
		}
		throw new CalDavXmlParseError('TRUNCATED_XML');
	}

	private parseProcessingInstruction(): void {
		this.index += 2;
		const target = this.readNameToken();
		if (!isValidXmlName(target)) throw new CalDavXmlParseError('MALFORMED_XML');
		if (asciiLowerCase(target) === 'xml') throw new CalDavXmlParseError('MALFORMED_XML');
		if (!this.source.startsWith('?>', this.index) && !this.consumeWhitespace()) {
			throw new CalDavXmlParseError('MALFORMED_XML');
		}
		while (!this.atEnd()) {
			if (this.source.startsWith('?>', this.index)) {
				this.index += 2;
				return;
			}
			this.index += 1;
		}
		throw new CalDavXmlParseError('TRUNCATED_XML');
	}

	private readUntil(terminator: string): string {
		const start = this.index;
		while (!this.atEnd()) {
			if (this.source.startsWith(terminator, this.index)) {
				const value = this.source.slice(start, this.index);
				this.index += terminator.length;
				return value;
			}
			this.index += 1;
		}
		throw new CalDavXmlParseError('TRUNCATED_XML');
	}

	private appendText(children: InternalContent[], value: string): void {
		if (value === '') return;
		const previous = children[children.length - 1];
		if (previous?.kind === 'text') {
			children[children.length - 1] = { kind: 'text', value: previous.value + value };
		} else {
			children.push({ kind: 'text', value });
		}
	}

	private skipWhitespace(): void {
		while (!this.atEnd() && isXmlWhitespace(this.peek())) this.index += 1;
	}

	private consumeWhitespace(): boolean {
		const start = this.index;
		this.skipWhitespace();
		return this.index !== start;
	}

	private expectCharacter(character: string): void {
		if (this.peek() !== character) {
			if (this.atEnd()) throw new CalDavXmlParseError('TRUNCATED_XML');
			throw new CalDavXmlParseError('MALFORMED_XML');
		}
		this.index += 1;
	}

	private atEnd(): boolean {
		return this.index >= this.source.length;
	}

	private peek(): string {
		return this.source[this.index] ?? '';
	}

	private peekCodeUnit(): number {
		return this.source.charCodeAt(this.index);
	}
}

function validateNcName(name: string): void {
	if (name.length === 0) throw new CalDavXmlParseError('INVALID_QUALIFIED_NAME');
	let offset = 0;
	let first = true;
	while (offset < name.length) {
		const codePoint = name.codePointAt(offset);
		if (
			codePoint === undefined ||
			codePoint === 0x3a ||
			(first ? !isNameStartCodePoint(codePoint) : !isNameCodePoint(codePoint))
		) {
			throw new CalDavXmlParseError('INVALID_QUALIFIED_NAME');
		}
		first = false;
		offset += codePoint > 0xffff ? 2 : 1;
	}
}

function isValidXmlName(name: string): boolean {
	if (name.length === 0) return false;
	let offset = 0;
	let first = true;
	while (offset < name.length) {
		const codePoint = name.codePointAt(offset);
		if (
			codePoint === undefined ||
			(codePoint !== 0x3a &&
				(first ? !isNameStartCodePoint(codePoint) : !isNameCodePoint(codePoint)))
		) {
			return false;
		}
		first = false;
		offset += codePoint > 0xffff ? 2 : 1;
	}
	return true;
}

function isEncodingName(value: string): boolean {
	if (value.length === 0) return false;
	const first = value.charCodeAt(0);
	if (!((first >= 0x41 && first <= 0x5a) || (first >= 0x61 && first <= 0x7a))) return false;
	for (let index = 1; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (!(
			(code >= 0x41 && code <= 0x5a) ||
			(code >= 0x61 && code <= 0x7a) ||
			(code >= 0x30 && code <= 0x39) ||
			code === 0x2e ||
			code === 0x5f ||
			code === 0x2d
		)) {
			return false;
		}
	}
	return true;
}

function asciiLowerCase(value: string): string {
	let result = '';
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		result += String.fromCharCode(code >= 0x41 && code <= 0x5a ? code + 0x20 : code);
	}
	return result;
}

function decodeNumericReference(body: string): string {
	let radix = 10;
	let index = 1;
	if (body[index] === 'x') {
		radix = 16;
		index += 1;
	}
	if (index >= body.length) throw new CalDavXmlParseError('INVALID_CHARACTER_REFERENCE');

	let codePoint = 0;
	for (; index < body.length; index += 1) {
		const code = body.charCodeAt(index);
		let digit = -1;
		if (code >= 0x30 && code <= 0x39) digit = code - 0x30;
		else if (radix === 16 && code >= 0x41 && code <= 0x46) digit = code - 0x41 + 10;
		else if (radix === 16 && code >= 0x61 && code <= 0x66) digit = code - 0x61 + 10;
		if (digit < 0 || digit >= radix) throw new CalDavXmlParseError('INVALID_CHARACTER_REFERENCE');
		codePoint = codePoint * radix + digit;
		if (codePoint > 0x10ffff) throw new CalDavXmlParseError('INVALID_CHARACTER_REFERENCE');
	}

	if (!isLegalXmlCodePoint(codePoint)) throw new CalDavXmlParseError('INVALID_CHARACTER_REFERENCE');
	return String.fromCodePoint(codePoint);
}

function isNamespaceDeclaration(name: QualifiedName): boolean {
	return (name.prefix === null && name.localName === 'xmlns') || name.prefix === 'xmlns';
}

function validateNamespaceDeclaration(prefix: string, namespaceUri: string): void {
	if (prefix === 'xmlns') throw new CalDavXmlParseError('INVALID_NAMESPACE_DECLARATION');
	if (namespaceUri === XMLNS_NAMESPACE)
		throw new CalDavXmlParseError('INVALID_NAMESPACE_DECLARATION');
	if (prefix === 'xml') {
		if (namespaceUri !== XML_NAMESPACE)
			throw new CalDavXmlParseError('INVALID_NAMESPACE_DECLARATION');
		return;
	}
	if (namespaceUri === XML_NAMESPACE)
		throw new CalDavXmlParseError('INVALID_NAMESPACE_DECLARATION');
	if (prefix !== '' && namespaceUri === '')
		throw new CalDavXmlParseError('INVALID_NAMESPACE_DECLARATION');
}

function expandName(
	name: QualifiedName,
	namespaces: ReadonlyMap<string, string>,
	isElement: boolean,
): XmlExpandedName {
	if (name.prefix === 'xmlns') throw new CalDavXmlParseError('INVALID_NAMESPACE_DECLARATION');
	if (name.prefix !== null) {
		const namespaceUri = namespaces.get(name.prefix);
		if (namespaceUri === undefined) throw new CalDavXmlParseError('UNBOUND_NAMESPACE_PREFIX');
		return { namespaceUri, localName: name.localName };
	}
	return {
		namespaceUri: isElement ? (namespaces.get('') ?? null) : null,
		localName: name.localName,
	};
}

function isExpandedName(
	element: InternalElement,
	namespaceUri: string,
	localName: string,
): boolean {
	return element.name.namespaceUri === namespaceUri && element.name.localName === localName;
}

function directElements(element: InternalElement): InternalElement[] {
	return element.children.filter((child): child is InternalElement => child.kind === 'element');
}

function directDavElements(element: InternalElement, localName: string): InternalElement[] {
	return directElements(element).filter((child) => isExpandedName(child, DAV_NAMESPACE, localName));
}

function readPcdata(element: InternalElement, errorCode: CalDavXmlProtocolErrorCode): string {
	let value = '';
	for (const child of element.children) {
		if (child.kind === 'element') throw new CalDavXmlProtocolError(errorCode);
		value += child.value;
	}
	return value;
}

function parseStatus(element: InternalElement): DavStatus {
	const value = readPcdata(element, 'INVALID_STATUS');
	if (value.length < 13 || !value.startsWith('HTTP/'))
		throw new CalDavXmlProtocolError('INVALID_STATUS');
	const major = value.charCodeAt(5);
	const minor = value.charCodeAt(7);
	if (
		!isAsciiDigitCode(major) ||
		value[6] !== '.' ||
		!isAsciiDigitCode(minor) ||
		value[8] !== ' '
	) {
		throw new CalDavXmlProtocolError('INVALID_STATUS');
	}
	const hundreds = value.charCodeAt(9);
	const tens = value.charCodeAt(10);
	const units = value.charCodeAt(11);
	if (
		!isAsciiDigitCode(hundreds) ||
		!isAsciiDigitCode(tens) ||
		!isAsciiDigitCode(units) ||
		value[12] !== ' '
	) {
		throw new CalDavXmlProtocolError('INVALID_STATUS');
	}
	const code = (hundreds - 0x30) * 100 + (tens - 0x30) * 10 + (units - 0x30);
	if (code < 100 || code > 599) throw new CalDavXmlProtocolError('INVALID_STATUS');

	const reasonPhrase = value.slice(13);
	if (
		reasonPhrase.length > 0 &&
		(reasonPhrase.charCodeAt(0) === 0x20 ||
			reasonPhrase.charCodeAt(0) === 0x09 ||
			reasonPhrase.charCodeAt(reasonPhrase.length - 1) === 0x20 ||
			reasonPhrase.charCodeAt(reasonPhrase.length - 1) === 0x09)
	) {
		throw new CalDavXmlProtocolError('INVALID_STATUS');
	}
	for (let index = 0; index < reasonPhrase.length; index += 1) {
		const codeUnit = reasonPhrase.charCodeAt(index);
		if (
			codeUnit !== 0x09 &&
			!(codeUnit >= 0x20 && codeUnit <= 0x7e) &&
			!(codeUnit >= 0x80 && codeUnit <= 0xff)
		) {
			throw new CalDavXmlProtocolError('INVALID_STATUS');
		}
	}

	return {
		httpVersion: `${value[5]}.${value[7]}`,
		code,
		reasonPhrase,
		isSuccessful: code >= 200 && code <= 299,
	};
}

function toPublicElement(element: InternalElement): DavXmlElement {
	return {
		kind: 'element',
		name: element.name,
		attributes: element.attributes,
		children: element.children.map((child) =>
			child.kind === 'text' ? child : toPublicElement(child),
		),
	};
}

function parsePropStat(element: InternalElement): DavPropStat {
	const propElements = directDavElements(element, 'prop');
	const statusElements = directDavElements(element, 'status');
	if (propElements.length !== 1 || statusElements.length !== 1) {
		throw new CalDavXmlProtocolError('INVALID_PROPSTAT');
	}

	return {
		status: parseStatus(statusElements[0]),
		properties: directElements(propElements[0]).map(toPublicElement),
	};
}

function parseResponse(element: InternalElement): DavResponse {
	const hrefElements = directDavElements(element, 'href');
	const statusElements = directDavElements(element, 'status');
	const propstatElements = directDavElements(element, 'propstat');

	if (statusElements.length === 1 && propstatElements.length === 0 && hrefElements.length >= 1) {
		const hrefs = hrefElements.map((href) => readPcdata(href, 'INVALID_RESPONSE'));
		if (new Set(hrefs).size !== hrefs.length) throw new CalDavXmlProtocolError('INVALID_RESPONSE');
		return {
			kind: 'status',
			hrefs: hrefs as [string, ...string[]],
			status: parseStatus(statusElements[0]),
			propstats: [],
			successfulProperties: [],
		};
	}

	if (statusElements.length === 0 && propstatElements.length >= 1 && hrefElements.length === 1) {
		const href = readPcdata(hrefElements[0], 'INVALID_RESPONSE');
		const propstats = propstatElements.map(parsePropStat) as [DavPropStat, ...DavPropStat[]];
		return {
			kind: 'propstat',
			hrefs: [href],
			status: null,
			propstats,
			successfulProperties: propstats.flatMap((propstat) =>
				propstat.status.isSuccessful ? propstat.properties : [],
			),
		};
	}

	throw new CalDavXmlProtocolError('INVALID_RESPONSE');
}

export function parseDavMultiStatus(xml: string): DavMultiStatus {
	const normalized = normalizeAndValidateDocument(xml);
	preflightForbiddenDeclarations(normalized);
	const root = new XmlCursorParser(normalized).parseDocument();
	if (!isExpandedName(root, DAV_NAMESPACE, 'multistatus')) {
		throw new CalDavXmlProtocolError('INVALID_MULTISTATUS');
	}

	return {
		responses: directDavElements(root, 'response').map(parseResponse),
	};
}

export function hasCalDavNoUidConflict(xml: string): boolean {
	try {
		if (Buffer.byteLength(xml, 'utf8') > MAX_CALDAV_ERROR_DOCUMENT_BYTES) return false;
		const normalized = normalizeAndValidateDocument(xml);
		preflightForbiddenDeclarations(normalized);
		const root = new XmlCursorParser(normalized).parseDocument();
		if (!isExpandedName(root, DAV_NAMESPACE, 'error')) return false;
		return directElements(root).some((child) =>
			isExpandedName(child, 'urn:ietf:params:xml:ns:caldav', 'no-uid-conflict'),
		);
	} catch {
		return false;
	}
}
