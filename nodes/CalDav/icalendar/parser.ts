/* eslint-disable @n8n/community-nodes/require-node-api-error -- The accepted protocol-layer contract requires transport-independent typed errors, outside the n8n UI boundary. */

export const ICALENDAR_MAX_RESOURCE_BYTES = 5_242_880;
export const ICALENDAR_MAX_COMPONENTS = 100_000;
export const ICALENDAR_MAX_PROPERTIES = 100_000;
export const ICALENDAR_MAX_DEPTH = 64;

export interface ICalendarResource {
	readonly kind: 'resource';
	readonly originalIcs: string;
	readonly calendar: ICalendarComponent;
}

export interface ICalendarComponent {
	readonly kind: 'component';
	readonly name: string;
	readonly entries: readonly ICalendarEntry[];
}

export type ICalendarEntry = ICalendarProperty | ICalendarComponent;

export interface ICalendarProperty {
	readonly kind: 'property';
	readonly name: string;
	readonly parameters: readonly ICalendarParameter[];
	readonly value: ICalendarValue;
}

export interface ICalendarParameter {
	readonly kind: 'parameter';
	readonly name: string;
	readonly values: readonly ICalendarParameterValue[];
}

export interface ICalendarParameterValue {
	readonly kind: 'parameterValue';
	readonly raw: string;
	readonly value: string;
	readonly quoted: boolean;
}

export interface ICalendarValue {
	readonly kind: 'value';
	readonly valueType: string;
	readonly raw: string;
	readonly textValues: readonly string[] | null;
}

export type CalDavICalendarParseErrorCode =
	| 'MAX_RESOURCE_SIZE_EXCEEDED'
	| 'INVALID_UTF8'
	| 'INVALID_LINE_ENDING'
	| 'INVALID_LINE_FOLD'
	| 'INVALID_CONTENT_LINE'
	| 'INVALID_PARAMETER'
	| 'INVALID_TEXT_ESCAPE'
	| 'INVALID_VALUE_TYPE'
	| 'INVALID_ROOT_COMPONENT'
	| 'UNEXPECTED_COMPONENT_END'
	| 'MISMATCHED_COMPONENT_END'
	| 'TRUNCATED_COMPONENT'
	| 'INVALID_COMPONENT_NESTING'
	| 'MISSING_VERSION'
	| 'DUPLICATE_VERSION'
	| 'UNSUPPORTED_VERSION'
	| 'MISSING_CALENDAR_COMPONENT'
	| 'METHOD_NOT_ALLOWED'
	| 'MIXED_COMPONENT_TYPES'
	| 'MISSING_UID'
	| 'DUPLICATE_UID'
	| 'MISMATCHED_UID'
	| 'MAX_COMPONENT_COUNT_EXCEEDED'
	| 'MAX_PROPERTY_COUNT_EXCEEDED'
	| 'MAX_DEPTH_EXCEEDED';

const ERROR_MESSAGES: Readonly<Record<CalDavICalendarParseErrorCode, string>> = {
	MAX_RESOURCE_SIZE_EXCEEDED: 'The iCalendar resource exceeds the 5 MiB size limit.',
	INVALID_UTF8: 'The iCalendar resource is not valid UTF-8.',
	INVALID_LINE_ENDING: 'The iCalendar resource contains an invalid line ending.',
	INVALID_LINE_FOLD: 'The iCalendar resource contains an invalid folded line.',
	INVALID_CONTENT_LINE: 'The iCalendar resource contains an invalid content line.',
	INVALID_PARAMETER: 'The iCalendar resource contains an invalid property parameter.',
	INVALID_TEXT_ESCAPE: 'The iCalendar resource contains an invalid TEXT escape.',
	INVALID_VALUE_TYPE: 'The iCalendar property contains an invalid VALUE parameter.',
	INVALID_ROOT_COMPONENT: 'The iCalendar resource must contain exactly one VCALENDAR object.',
	UNEXPECTED_COMPONENT_END: 'The iCalendar resource contains an unexpected component end.',
	MISMATCHED_COMPONENT_END: 'The iCalendar resource contains a mismatched component end.',
	TRUNCATED_COMPONENT: 'The iCalendar resource ended before all components were closed.',
	INVALID_COMPONENT_NESTING: 'The iCalendar resource contains invalid component nesting.',
	MISSING_VERSION: 'The VCALENDAR component is missing the required VERSION property.',
	DUPLICATE_VERSION: 'The VCALENDAR component contains more than one VERSION property.',
	UNSUPPORTED_VERSION: 'The VCALENDAR VERSION is not supported.',
	MISSING_CALENDAR_COMPONENT: 'The VCALENDAR component does not contain a calendar component.',
	METHOD_NOT_ALLOWED: 'A CalDAV calendar-object resource must not contain METHOD.',
	MIXED_COMPONENT_TYPES: 'A CalDAV calendar-object resource must not mix calendar component types.',
	MISSING_UID: 'A calendar component is missing the required UID property.',
	DUPLICATE_UID: 'A calendar component contains more than one UID property.',
	MISMATCHED_UID: 'Calendar components in one resource must have the same UID.',
	MAX_COMPONENT_COUNT_EXCEEDED: 'The iCalendar resource exceeds the maximum component count.',
	MAX_PROPERTY_COUNT_EXCEEDED: 'The iCalendar resource exceeds the maximum property count.',
	MAX_DEPTH_EXCEEDED: 'The iCalendar resource exceeds the maximum nesting depth.',
};

export class CalDavICalendarParseError extends Error {
	readonly code: CalDavICalendarParseErrorCode;

	constructor(code: CalDavICalendarParseErrorCode) {
		super(ERROR_MESSAGES[code]);
		this.name = 'CalDavICalendarParseError';
		this.code = code;
	}
}

interface BeginLine {
	readonly kind: 'begin';
	readonly name: string;
}

interface EndLine {
	readonly kind: 'end';
	readonly name: string;
}

interface PropertyLine {
	readonly kind: 'propertyLine';
	readonly property: ICalendarProperty;
}

type ParsedLine = BeginLine | EndLine | PropertyLine;

interface ComponentFrame {
	readonly component: ICalendarComponent & { readonly entries: ICalendarEntry[] };
	hasChild: boolean;
}

const NAME_PATTERN = /^[A-Za-z0-9-]+$/;

const DEFAULT_VALUE_TYPES: Readonly<Record<string, string>> = {
	ACTION: 'TEXT',
	ATTACH: 'URI',
	ATTENDEE: 'CAL-ADDRESS',
	CALSCALE: 'TEXT',
	CATEGORIES: 'TEXT',
	CLASS: 'TEXT',
	COMMENT: 'TEXT',
	COMPLETED: 'DATE-TIME',
	CONTACT: 'TEXT',
	CREATED: 'DATE-TIME',
	DESCRIPTION: 'TEXT',
	DTEND: 'DATE-TIME',
	DTSTAMP: 'DATE-TIME',
	DTSTART: 'DATE-TIME',
	DUE: 'DATE-TIME',
	DURATION: 'DURATION',
	EXDATE: 'DATE-TIME',
	FREEBUSY: 'PERIOD',
	GEO: 'FLOAT',
	'LAST-MODIFIED': 'DATE-TIME',
	LOCATION: 'TEXT',
	METHOD: 'TEXT',
	ORGANIZER: 'CAL-ADDRESS',
	'PERCENT-COMPLETE': 'INTEGER',
	PRIORITY: 'INTEGER',
	PRODID: 'TEXT',
	RDATE: 'DATE-TIME',
	'RECURRENCE-ID': 'DATE-TIME',
	'RELATED-TO': 'TEXT',
	REPEAT: 'INTEGER',
	'REQUEST-STATUS': 'TEXT',
	RESOURCES: 'TEXT',
	RRULE: 'RECUR',
	SEQUENCE: 'INTEGER',
	STATUS: 'TEXT',
	SUMMARY: 'TEXT',
	TRANSP: 'TEXT',
	TRIGGER: 'DURATION',
	TZID: 'TEXT',
	TZNAME: 'TEXT',
	TZOFFSETFROM: 'UTC-OFFSET',
	TZOFFSETTO: 'UTC-OFFSET',
	TZURL: 'URI',
	UID: 'TEXT',
	URL: 'URI',
	VERSION: 'TEXT',
};

const UID_COMPONENT_NAMES = new Set(['VEVENT', 'VTODO', 'VJOURNAL', 'VFREEBUSY']);
const PARSED_RESOURCE_PROVENANCE = new WeakSet<object>();
const PARSED_RESOURCE_PROVENANCE_VERIFIER = '__isParserProducedICalendarResource';

function decodeUtf8(input: Uint8Array): string {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(input);
	} catch {
		throw new CalDavICalendarParseError('INVALID_UTF8');
	}
}

function unfoldLines(source: string): string[] {
	if (!source.endsWith('\n')) {
		throw new CalDavICalendarParseError('INVALID_LINE_ENDING');
	}

	for (let index = 0; index < source.length; index += 1) {
		if (source.charCodeAt(index) === 0x0d && source.charCodeAt(index + 1) !== 0x0a) {
			throw new CalDavICalendarParseError('INVALID_LINE_ENDING');
		}
	}

	const logicalLines: string[] = [];
	let physicalStart = 0;

	for (let index = 0; index < source.length; index += 1) {
		if (source.charCodeAt(index) !== 0x0a) continue;

		const physicalEnd =
			index > physicalStart && source.charCodeAt(index - 1) === 0x0d ? index - 1 : index;
		const physicalLine = source.slice(physicalStart, physicalEnd);
		physicalStart = index + 1;

		if (physicalLine.startsWith(' ') || physicalLine.startsWith('\t')) {
			const previousIndex = logicalLines.length - 1;
			if (previousIndex < 0) {
				throw new CalDavICalendarParseError('INVALID_LINE_FOLD');
			}
			logicalLines[previousIndex] = logicalLines[previousIndex]! + physicalLine.slice(1);
		} else {
			logicalLines.push(physicalLine);
		}
	}

	return logicalLines;
}

function isForbiddenParameterControl(character: string): boolean {
	const codeUnit = character.charCodeAt(0);
	return codeUnit < 0x20 || codeUnit === 0x7f;
}

function decodeParameterValue(value: string): string {
	let decoded = '';

	for (let index = 0; index < value.length; index += 1) {
		const character = value[index]!;
		if (character !== '^' || index + 1 >= value.length) {
			decoded += character;
			continue;
		}

		const escaped = value[index + 1]!;
		if (escaped === 'n') {
			decoded += '\n';
			index += 1;
		} else if (escaped === '^') {
			decoded += '^';
			index += 1;
		} else if (escaped === "'") {
			decoded += '"';
			index += 1;
		} else {
			decoded += `^${escaped}`;
			index += 1;
		}
	}

	return decoded;
}

function parseParameterValue(raw: string, allowEmpty: boolean): ICalendarParameterValue {
	let quoted = false;
	let encodedValue = raw;

	if (raw.startsWith('"')) {
		if (raw.length < 2 || !raw.endsWith('"')) {
			throw new CalDavICalendarParseError('INVALID_PARAMETER');
		}
		quoted = true;
		encodedValue = raw.slice(1, -1);
		if (encodedValue.includes('"')) {
			throw new CalDavICalendarParseError('INVALID_PARAMETER');
		}
	} else if (raw.includes('"')) {
		throw new CalDavICalendarParseError('INVALID_PARAMETER');
	}

	if (
		(!quoted && encodedValue.length === 0 && !allowEmpty) ||
		[...encodedValue].some(isForbiddenParameterControl)
	) {
		throw new CalDavICalendarParseError('INVALID_PARAMETER');
	}

	return {
		kind: 'parameterValue',
		raw,
		value: decodeParameterValue(encodedValue),
		quoted,
	};
}

function splitOutsideQuotes(value: string, delimiter: string): string[] {
	const parts: string[] = [];
	let start = 0;
	let quoted = false;

	for (let index = 0; index < value.length; index += 1) {
		const character = value[index]!;
		if (character === '"') {
			quoted = !quoted;
		} else if (character === delimiter && !quoted) {
			parts.push(value.slice(start, index));
			start = index + 1;
		}
	}

	if (quoted) {
		throw new CalDavICalendarParseError('INVALID_PARAMETER');
	}

	parts.push(value.slice(start));
	return parts;
}

function parseParameter(source: string): ICalendarParameter {
	const equalsIndex = source.indexOf('=');
	if (equalsIndex <= 0) {
		throw new CalDavICalendarParseError('INVALID_PARAMETER');
	}

	const name = source.slice(0, equalsIndex);
	if (!NAME_PATTERN.test(name)) {
		throw new CalDavICalendarParseError('INVALID_PARAMETER');
	}

	const isValueParameter = name.toUpperCase() === 'VALUE';
	const rawValues = splitOutsideQuotes(source.slice(equalsIndex + 1), ',');
	const values = rawValues.map((raw) => parseParameterValue(raw, isValueParameter));

	return { kind: 'parameter', name, values };
}

function findValueDelimiter(line: string): number {
	let quoted = false;

	for (let index = 0; index < line.length; index += 1) {
		const character = line[index]!;
		if (character === '"') {
			quoted = !quoted;
		} else if (character === ':' && !quoted) {
			return index;
		}
	}

	if (quoted) {
		throw new CalDavICalendarParseError('INVALID_PARAMETER');
	}
	throw new CalDavICalendarParseError('INVALID_CONTENT_LINE');
}

function decodeTextValues(raw: string): readonly string[] {
	const values: string[] = [];
	let decoded = '';

	for (let index = 0; index < raw.length; index += 1) {
		const character = raw[index]!;
		if (character === ',') {
			values.push(decoded);
			decoded = '';
			continue;
		}
		if (character !== '\\') {
			decoded += character;
			continue;
		}

		if (index + 1 >= raw.length) {
			throw new CalDavICalendarParseError('INVALID_TEXT_ESCAPE');
		}
		const escaped = raw[index + 1]!;
		if (escaped === '\\' || escaped === ',' || escaped === ';') {
			decoded += escaped;
		} else if (escaped === 'n' || escaped === 'N') {
			decoded += '\n';
		} else {
			throw new CalDavICalendarParseError('INVALID_TEXT_ESCAPE');
		}
		index += 1;
	}

	values.push(decoded);
	return values;
}

function parseProperty(
	name: string,
	parameterSources: readonly string[],
	raw: string,
): ICalendarProperty {
	const parameters = parameterSources.map(parseParameter);
	const valueParameters = parameters.filter(
		({ name: parameterName }) => parameterName.toUpperCase() === 'VALUE',
	);

	if (
		valueParameters.length > 1 ||
		(valueParameters.length === 1 &&
			(valueParameters[0]!.values.length !== 1 ||
				valueParameters[0]!.values[0]!.value.length === 0))
	) {
		throw new CalDavICalendarParseError('INVALID_VALUE_TYPE');
	}

	const valueType =
		valueParameters.length === 1
			? valueParameters[0]!.values[0]!.value.toUpperCase()
			: (DEFAULT_VALUE_TYPES[name.toUpperCase()] ?? 'TEXT');
	const textValues = valueType === 'TEXT' ? decodeTextValues(raw) : null;

	return {
		kind: 'property',
		name,
		parameters,
		value: { kind: 'value', valueType, raw, textValues },
	};
}

function parseContentLine(line: string): ParsedLine {
	const delimiterIndex = findValueDelimiter(line);
	const nameAndParameters = line.slice(0, delimiterIndex);
	const segments = splitOutsideQuotes(nameAndParameters, ';');
	const name = segments[0]!;

	if (!NAME_PATTERN.test(name)) {
		throw new CalDavICalendarParseError('INVALID_CONTENT_LINE');
	}

	const rawValue = line.slice(delimiterIndex + 1);
	const upperName = name.toUpperCase();
	if (upperName === 'BEGIN' || upperName === 'END') {
		if (segments.length !== 1 || !NAME_PATTERN.test(rawValue)) {
			throw new CalDavICalendarParseError('INVALID_CONTENT_LINE');
		}
		return { kind: upperName === 'BEGIN' ? 'begin' : 'end', name: rawValue };
	}

	return {
		kind: 'propertyLine',
		property: parseProperty(name, segments.slice(1), rawValue),
	};
}

function parseAllLines(lines: readonly string[]): ParsedLine[] {
	const parsedLines: ParsedLine[] = [];
	let componentCount = 0;
	let propertyCount = 0;
	let lexicalDepth = 0;

	for (const line of lines) {
		const parsedLine = parseContentLine(line);
		parsedLines.push(parsedLine);

		if (parsedLine.kind === 'begin') {
			componentCount += 1;
			if (componentCount > ICALENDAR_MAX_COMPONENTS) {
				throw new CalDavICalendarParseError('MAX_COMPONENT_COUNT_EXCEEDED');
			}
			lexicalDepth += 1;
			if (lexicalDepth > ICALENDAR_MAX_DEPTH) {
				throw new CalDavICalendarParseError('MAX_DEPTH_EXCEEDED');
			}
		} else if (parsedLine.kind === 'end') {
			if (lexicalDepth > 0) lexicalDepth -= 1;
		} else {
			propertyCount += 1;
			if (propertyCount > ICALENDAR_MAX_PROPERTIES) {
				throw new CalDavICalendarParseError('MAX_PROPERTY_COUNT_EXCEEDED');
			}
		}
	}

	return parsedLines;
}

function childIsAllowed(parentName: string, childName: string): boolean {
	const parent = parentName.toUpperCase();
	const child = childName.toUpperCase();

	if (parent === 'VCALENDAR') {
		return !['VCALENDAR', 'VALARM', 'STANDARD', 'DAYLIGHT'].includes(child);
	}
	if (parent === 'VEVENT' || parent === 'VTODO') return child === 'VALARM';
	if (parent === 'VTIMEZONE') return child === 'STANDARD' || child === 'DAYLIGHT';
	return false;
}

function buildComponentTree(lines: readonly ParsedLine[]): ICalendarComponent {
	const stack: ComponentFrame[] = [];
	const roots: ICalendarComponent[] = [];
	let hasTopLevelMaterial = false;

	for (const line of lines) {
		if (line.kind === 'begin') {
			const component: ICalendarComponent & { readonly entries: ICalendarEntry[] } = {
				kind: 'component',
				name: line.name,
				entries: [],
			};
			const parent = stack[stack.length - 1];
			if (parent === undefined) {
				roots.push(component);
			} else {
				if (!childIsAllowed(parent.component.name, component.name)) {
					throw new CalDavICalendarParseError('INVALID_COMPONENT_NESTING');
				}
				parent.component.entries.push(component);
				parent.hasChild = true;
			}
			stack.push({ component, hasChild: false });
			continue;
		}

		if (line.kind === 'end') {
			const frame = stack[stack.length - 1];
			if (frame === undefined) {
				throw new CalDavICalendarParseError('UNEXPECTED_COMPONENT_END');
			}
			if (frame.component.name.toUpperCase() !== line.name.toUpperCase()) {
				throw new CalDavICalendarParseError('MISMATCHED_COMPONENT_END');
			}
			stack.pop();
			continue;
		}

		const frame = stack[stack.length - 1];
		if (frame === undefined) {
			hasTopLevelMaterial = true;
		} else {
			if (frame.hasChild) {
				throw new CalDavICalendarParseError('INVALID_COMPONENT_NESTING');
			}
			frame.component.entries.push(line.property);
		}
	}

	if (stack.length > 0) {
		throw new CalDavICalendarParseError('TRUNCATED_COMPONENT');
	}

	const root = roots[0];
	if (
		hasTopLevelMaterial ||
		roots.length !== 1 ||
		root === undefined ||
		root.name.toUpperCase() !== 'VCALENDAR'
	) {
		throw new CalDavICalendarParseError('INVALID_ROOT_COMPONENT');
	}

	return root;
}

function directProperties(component: ICalendarComponent, name: string): ICalendarProperty[] {
	const upperName = name.toUpperCase();
	return component.entries.filter(
		(entry): entry is ICalendarProperty =>
			entry.kind === 'property' && entry.name.toUpperCase() === upperName,
	);
}

function directComponents(component: ICalendarComponent): ICalendarComponent[] {
	return component.entries.filter(
		(entry): entry is ICalendarComponent => entry.kind === 'component',
	);
}

function decodedUid(property: ICalendarProperty): string {
	return property.value.textValues === null
		? property.value.raw
		: property.value.textValues.join(',');
}

function validateCalendar(calendar: ICalendarComponent): void {
	const versions = directProperties(calendar, 'VERSION');
	if (versions.length === 0) {
		throw new CalDavICalendarParseError('MISSING_VERSION');
	}
	if (versions.length > 1) {
		throw new CalDavICalendarParseError('DUPLICATE_VERSION');
	}
	if (versions[0]!.value.raw !== '2.0') {
		throw new CalDavICalendarParseError('UNSUPPORTED_VERSION');
	}

	const calendarComponents = directComponents(calendar);
	if (calendarComponents.length === 0) {
		throw new CalDavICalendarParseError('MISSING_CALENDAR_COMPONENT');
	}
	if (directProperties(calendar, 'METHOD').length > 0) {
		throw new CalDavICalendarParseError('METHOD_NOT_ALLOWED');
	}

	const objectComponents = calendarComponents.filter(
		(component) => component.name.toUpperCase() !== 'VTIMEZONE',
	);
	const componentTypes = new Set(objectComponents.map(({ name }) => name.toUpperCase()));
	if (componentTypes.size > 1) {
		throw new CalDavICalendarParseError('MIXED_COMPONENT_TYPES');
	}

	let resourceUid: string | null = null;
	for (const component of objectComponents) {
		if (!UID_COMPONENT_NAMES.has(component.name.toUpperCase())) continue;

		const uids = directProperties(component, 'UID');
		if (uids.length === 0) {
			throw new CalDavICalendarParseError('MISSING_UID');
		}
		if (uids.length > 1) {
			throw new CalDavICalendarParseError('DUPLICATE_UID');
		}

		const uid = decodedUid(uids[0]!);
		if (uid.length === 0) {
			throw new CalDavICalendarParseError('MISSING_UID');
		}
		if (resourceUid === null) {
			resourceUid = uid;
		} else if (resourceUid !== uid) {
			throw new CalDavICalendarParseError('MISMATCHED_UID');
		}
	}
}

function freezeParameter(parameter: ICalendarParameter): void {
	for (const value of parameter.values) Object.freeze(value);
	Object.freeze(parameter.values);
	Object.freeze(parameter);
}

function freezeProperty(property: ICalendarProperty): void {
	for (const parameter of property.parameters) freezeParameter(parameter);
	Object.freeze(property.parameters);
	if (property.value.textValues !== null) Object.freeze(property.value.textValues);
	Object.freeze(property.value);
	Object.freeze(property);
}

function freezeComponent(component: ICalendarComponent): void {
	for (const entry of component.entries) {
		if (entry.kind === 'component') freezeComponent(entry);
		else freezeProperty(entry);
	}
	Object.freeze(component.entries);
	Object.freeze(component);
}

export function parseICalendarResource(input: Uint8Array): ICalendarResource {
	if (input.byteLength > ICALENDAR_MAX_RESOURCE_BYTES) {
		throw new CalDavICalendarParseError('MAX_RESOURCE_SIZE_EXCEEDED');
	}

	const originalIcs = decodeUtf8(input);
	const lines = unfoldLines(originalIcs);
	const parsedLines = parseAllLines(lines);
	const calendar = buildComponentTree(parsedLines);
	validateCalendar(calendar);
	freezeComponent(calendar);

	const resource = Object.freeze({ kind: 'resource' as const, originalIcs, calendar });
	PARSED_RESOURCE_PROVENANCE.add(resource);
	return resource;
}

Object.defineProperty(parseICalendarResource, PARSED_RESOURCE_PROVENANCE_VERIFIER, {
	value: (value: unknown): boolean =>
		typeof value === 'object' && value !== null && PARSED_RESOURCE_PROVENANCE.has(value),
	enumerable: false,
	writable: false,
	configurable: false,
});
