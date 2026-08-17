/* eslint-disable @n8n/community-nodes/require-node-api-error -- The accepted protocol-layer contract requires transport-independent typed errors, outside the n8n UI boundary. */

import {
	ICALENDAR_MAX_COMPONENTS,
	ICALENDAR_MAX_DEPTH,
	ICALENDAR_MAX_PROPERTIES,
	ICALENDAR_MAX_RESOURCE_BYTES,
} from './parser';
import type {
	ICalendarComponent,
	ICalendarEntry,
	ICalendarParameter,
	ICalendarProperty,
	ICalendarResource,
} from './parser';
import { projectInstantInTimeZone } from './timeZones';
import type { CalendarEventTimeZone, IanaTimeZoneId, LocalDateTimeString } from './timeZones';
import { isAbsoluteICalendarUri } from './uri';

export const CALDAV_ICALENDAR_PRODID = '-//iljailjic//n8n-nodes-caldav//EN';

interface BasicEventSerializationCommon {
	readonly uid: string;
	readonly dtstamp: Date;
	readonly summary: string;
	readonly description?: string;
	readonly location?: string;
	readonly url?: string;
}

export type BasicUtcEventSerializationInput = BasicEventSerializationCommon &
	(
		| {
				readonly timeMode?: 'timed';
				readonly start: Date;
				readonly end: Date;
		  }
		| {
				readonly timeMode: 'allDay';
				readonly startDate: string;
				readonly endDate: string;
		  }
	);

export type BasicTimedEventSerializationInput = BasicEventSerializationCommon & {
	readonly timeMode?: 'timed';
	readonly start: Date;
	readonly end: Date;
	readonly timeZone: CalendarEventTimeZone;
};

export type CalendarEventInstantProjector = (
	instant: Date,
	timeZone: IanaTimeZoneId,
) => LocalDateTimeString;

export type BasicUtcEventSerializationField =
	| 'uid'
	| 'dtstamp'
	| 'timeMode'
	| 'start'
	| 'end'
	| 'startDate'
	| 'endDate'
	| 'summary'
	| 'description'
	| 'location'
	| 'url';

export const CalDavICalendarSerializeErrorCode = Object.freeze({
	INVALID_INPUT: 'INVALID_INPUT',
	MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
	INVALID_DATE: 'INVALID_DATE',
	INVALID_TIME_RANGE: 'INVALID_TIME_RANGE',
	INVALID_TEXT: 'INVALID_TEXT',
	INVALID_URI: 'INVALID_URI',
	RESOURCE_LIMIT_EXCEEDED: 'RESOURCE_LIMIT_EXCEEDED',
} as const);

export type CalDavICalendarSerializeErrorCode =
	(typeof CalDavICalendarSerializeErrorCode)[keyof typeof CalDavICalendarSerializeErrorCode];

const ERROR_MESSAGES: Readonly<Record<CalDavICalendarSerializeErrorCode, string>> = {
	INVALID_INPUT: 'The iCalendar serialization input is invalid.',
	MISSING_REQUIRED_FIELD: 'A required iCalendar field is missing.',
	INVALID_DATE: 'The iCalendar date is invalid.',
	INVALID_TIME_RANGE: 'The iCalendar event end must be later than its start.',
	INVALID_TEXT: 'The iCalendar TEXT value is invalid.',
	INVALID_URI: 'The iCalendar URI value is invalid.',
	RESOURCE_LIMIT_EXCEEDED: 'The iCalendar resource exceeds a serialization limit.',
};

export class CalDavICalendarSerializeError extends Error {
	readonly code: CalDavICalendarSerializeErrorCode;
	readonly field?: BasicUtcEventSerializationField;

	constructor(code: CalDavICalendarSerializeErrorCode, field?: BasicUtcEventSerializationField) {
		super(ERROR_MESSAGES[code]);
		this.name = 'CalDavICalendarSerializeError';
		this.code = code;
		if (field !== undefined) this.field = field;
	}
}

interface BasicInputSnapshotCommon {
	readonly uid: string;
	readonly dtstamp: number;
	readonly summary: string;
	readonly description?: string;
	readonly location?: string;
	readonly url?: string;
}

type BasicInputSnapshot = BasicInputSnapshotCommon &
	(
		| {
				readonly timeMode: 'timed';
				readonly start: number;
				readonly end: number;
				readonly timeZone: CalendarEventTimeZone;
		  }
		| { readonly timeMode: 'allDay'; readonly startDate: string; readonly endDate: string }
	);

const NAME_PATTERN = /^[A-Za-z0-9-]+$/;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

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

function fail(
	code: CalDavICalendarSerializeErrorCode,
	field?: BasicUtcEventSerializationField,
): never {
	throw new CalDavICalendarSerializeError(code, field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidUnicodeScalarSequence(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			index += 1;
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			return false;
		}
	}
	return true;
}

function isValidText(value: string): boolean {
	if (!isValidUnicodeScalarSequence(value)) return false;
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit === 0x09 || codeUnit === 0x0a) continue;
		if (codeUnit < 0x20 || codeUnit === 0x7f) return false;
	}
	return true;
}

function isValidRawValue(value: string): boolean {
	if (!isValidUnicodeScalarSequence(value)) return false;
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit === 0x09) continue;
		if (codeUnit < 0x20 || codeUnit === 0x7f) return false;
	}
	return true;
}

function isValidParameterValue(value: string): boolean {
	if (!isValidUnicodeScalarSequence(value)) return false;
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit === 0x0a) continue;
		if (codeUnit < 0x20 || codeUnit === 0x7f) return false;
	}
	return true;
}

function escapeText(value: string): string {
	let escaped = '';
	for (const character of value) {
		if (character === '\\') escaped += '\\\\';
		else if (character === ',') escaped += '\\,';
		else if (character === ';') escaped += '\\;';
		else if (character === '\n') escaped += '\\n';
		else escaped += character;
	}
	return escaped;
}

function encodeParameterValue(value: string): string {
	let encoded = '';
	for (const character of value) {
		if (character === '^') encoded += '^^';
		else if (character === '\n') encoded += '^n';
		else if (character === '"') encoded += "^'";
		else encoded += character;
	}
	return encoded;
}

function parameterValueNeedsQuotes(value: string): boolean {
	return value.length === 0 || value.includes(':') || value.includes(';') || value.includes(',');
}

function requiredString(value: unknown, field: 'uid' | 'summary', allowEmpty: boolean): string {
	if (value === undefined || (!allowEmpty && value === '')) {
		fail('MISSING_REQUIRED_FIELD', field);
	}
	if (typeof value !== 'string') fail('INVALID_INPUT', field);
	if (!isValidText(value)) fail('INVALID_TEXT', field);
	return value;
}

function optionalText(value: unknown, field: 'description' | 'location'): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'string') fail('INVALID_INPUT', field);
	if (!isValidText(value)) fail('INVALID_TEXT', field);
	return value;
}

function dateTimestamp(value: unknown, field: 'dtstamp' | 'start' | 'end'): number {
	if (value === undefined) fail('MISSING_REQUIRED_FIELD', field);
	if (!(value instanceof Date)) fail('INVALID_INPUT', field);

	let timestamp: number;
	try {
		timestamp = Date.prototype.getTime.call(value);
	} catch {
		fail('INVALID_DATE', field);
	}
	if (!Number.isFinite(timestamp)) fail('INVALID_DATE', field);

	const snapshot = new Date(timestamp);
	const year = snapshot.getUTCFullYear();
	if (snapshot.getUTCMilliseconds() !== 0 || year < 1 || year > 9999) {
		fail('INVALID_DATE', field);
	}
	return timestamp;
}

function isLeapYear(year: number): boolean {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
	if (month === 2) return isLeapYear(year) ? 29 : 28;
	if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
	return 31;
}

function calendarDate(value: unknown, field: 'startDate' | 'endDate'): string {
	if (value === undefined) fail('MISSING_REQUIRED_FIELD', field);
	if (typeof value !== 'string') fail('INVALID_INPUT', field);
	const match = CALENDAR_DATE_PATTERN.exec(value);
	if (match === null) fail('INVALID_DATE', field);
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (
		year < 1 ||
		year > 9999 ||
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > daysInMonth(year, month)
	) {
		fail('INVALID_DATE', field);
	}
	return value;
}

function snapshotBasicInput(
	input: BasicUtcEventSerializationInput,
	timeZone: CalendarEventTimeZone,
): BasicInputSnapshot {
	if (!isRecord(input)) fail('INVALID_INPUT');

	const uid = requiredString(input.uid, 'uid', false);
	const dtstamp = dateTimestamp(input.dtstamp, 'dtstamp');
	const mode = input.timeMode ?? 'timed';
	let time:
		| {
				readonly timeMode: 'timed';
				readonly start: number;
				readonly end: number;
				readonly timeZone: CalendarEventTimeZone;
		  }
		| { readonly timeMode: 'allDay'; readonly startDate: string; readonly endDate: string };
	if (mode === 'timed') {
		if ('startDate' in input || 'endDate' in input) fail('INVALID_INPUT', 'timeMode');
		const start = dateTimestamp(input.start, 'start');
		const end = dateTimestamp(input.end, 'end');
		time = { timeMode: 'timed', start, end, timeZone };
	} else if (mode === 'allDay') {
		if ('start' in input || 'end' in input) fail('INVALID_INPUT', 'timeMode');
		const startDate = calendarDate(input.startDate, 'startDate');
		const endDate = calendarDate(input.endDate, 'endDate');
		time = { timeMode: 'allDay', startDate, endDate };
	} else {
		fail('INVALID_INPUT', 'timeMode');
	}

	const summary = requiredString(input.summary, 'summary', true);
	const description = optionalText(input.description, 'description');
	const location = optionalText(input.location, 'location');
	const urlValue = input.url;
	let url: string | undefined;
	if (urlValue !== undefined) {
		if (typeof urlValue !== 'string') fail('INVALID_INPUT', 'url');
		if (!isAbsoluteICalendarUri(urlValue)) fail('INVALID_URI', 'url');
		url = urlValue;
	}
	if (
		(time.timeMode === 'timed' && time.end <= time.start) ||
		(time.timeMode === 'allDay' && time.endDate <= time.startDate)
	) {
		fail('INVALID_TIME_RANGE');
	}
	return { uid, dtstamp, ...time, summary, description, location, url };
}

function formatUtcDateTime(timestamp: number): string {
	const date = new Date(timestamp);
	return (
		String(date.getUTCFullYear()).padStart(4, '0') +
		String(date.getUTCMonth() + 1).padStart(2, '0') +
		String(date.getUTCDate()).padStart(2, '0') +
		'T' +
		String(date.getUTCHours()).padStart(2, '0') +
		String(date.getUTCMinutes()).padStart(2, '0') +
		String(date.getUTCSeconds()).padStart(2, '0') +
		'Z'
	);
}

function textProperty(name: string, value: string): ICalendarProperty {
	return {
		kind: 'property',
		name,
		parameters: [],
		value: { kind: 'value', valueType: 'TEXT', raw: '', textValues: [value] },
	};
}

function rawProperty(name: string, valueType: string, raw: string): ICalendarProperty {
	return {
		kind: 'property',
		name,
		parameters: [],
		value: { kind: 'value', valueType, raw, textValues: null },
	};
}

function dateProperty(name: string, raw: string): ICalendarProperty {
	return {
		kind: 'property',
		name,
		parameters: [
			{
				kind: 'parameter',
				name: 'VALUE',
				values: [{ kind: 'parameterValue', raw: 'DATE', value: 'DATE', quoted: false }],
			},
		],
		value: { kind: 'value', valueType: 'DATE', raw, textValues: null },
	};
}

function ianaDateTimeProperty(name: string, raw: string, timeZone: string): ICalendarProperty {
	return {
		kind: 'property',
		name,
		parameters: [
			{
				kind: 'parameter',
				name: 'TZID',
				values: [{ kind: 'parameterValue', raw: timeZone, value: timeZone, quoted: false }],
			},
		],
		value: { kind: 'value', valueType: 'DATE-TIME', raw, textValues: null },
	};
}

function basicResource(
	input: BasicInputSnapshot,
	projectInstant: CalendarEventInstantProjector = projectInstantInTimeZone,
	timeZoneDefinition?: ICalendarComponent,
): ICalendarResource {
	if (
		timeZoneDefinition !== undefined &&
		(input.timeMode !== 'timed' || input.timeZone.timeZoneMode !== 'iana')
	) {
		fail('INVALID_INPUT');
	}
	const timeProperties =
		input.timeMode === 'allDay'
			? [
					dateProperty('DTSTART', input.startDate.split('-').join('')),
					dateProperty('DTEND', input.endDate.split('-').join('')),
				]
			: input.timeZone.timeZoneMode === 'utc'
				? [
						rawProperty('DTSTART', 'DATE-TIME', formatUtcDateTime(input.start)),
						rawProperty('DTEND', 'DATE-TIME', formatUtcDateTime(input.end)),
					]
				: [
						ianaDateTimeProperty(
							'DTSTART',
							projectInstant(new Date(input.start), input.timeZone.timeZone).replace(/[-:]/g, ''),
							input.timeZone.timeZone,
						),
						ianaDateTimeProperty(
							'DTEND',
							projectInstant(new Date(input.end), input.timeZone.timeZone).replace(/[-:]/g, ''),
							input.timeZone.timeZone,
						),
					];
	const eventEntries: ICalendarEntry[] = [
		textProperty('UID', input.uid),
		rawProperty('DTSTAMP', 'DATE-TIME', formatUtcDateTime(input.dtstamp)),
		...timeProperties,
		textProperty('SUMMARY', input.summary),
	];
	if (input.description !== undefined) {
		eventEntries.push(textProperty('DESCRIPTION', input.description));
	}
	if (input.location !== undefined) eventEntries.push(textProperty('LOCATION', input.location));
	if (input.url !== undefined) eventEntries.push(rawProperty('URL', 'URI', input.url));

	return {
		kind: 'resource',
		originalIcs: '',
		calendar: {
			kind: 'component',
			name: 'VCALENDAR',
			entries: [
				textProperty('VERSION', '2.0'),
				textProperty('PRODID', CALDAV_ICALENDAR_PRODID),
				...(timeZoneDefinition === undefined ? [] : [timeZoneDefinition]),
				{ kind: 'component', name: 'VEVENT', entries: eventEntries },
			],
		},
	};
}

function preflightResource(resource: unknown): ICalendarResource {
	if (!isRecord(resource) || resource.kind !== 'resource') fail('INVALID_INPUT');
	if (typeof resource.originalIcs !== 'string') fail('INVALID_INPUT');
	if (!isRecord(resource.calendar)) fail('INVALID_INPUT');

	const stack: Array<{ readonly component: unknown; readonly depth: number }> = [
		{ component: resource.calendar, depth: 1 },
	];
	const seen = new WeakSet<object>();
	let componentCount = 0;
	let propertyCount = 0;

	while (stack.length > 0) {
		const frame = stack.pop()!;
		if (!isRecord(frame.component) || frame.component.kind !== 'component') fail('INVALID_INPUT');
		if (seen.has(frame.component)) fail('INVALID_INPUT');
		seen.add(frame.component);

		componentCount += 1;
		if (componentCount > ICALENDAR_MAX_COMPONENTS || frame.depth > ICALENDAR_MAX_DEPTH) {
			fail('RESOURCE_LIMIT_EXCEEDED');
		}
		if (typeof frame.component.name !== 'string' || !NAME_PATTERN.test(frame.component.name)) {
			fail('INVALID_INPUT');
		}
		if (!Array.isArray(frame.component.entries)) fail('INVALID_INPUT');

		for (let index = frame.component.entries.length - 1; index >= 0; index -= 1) {
			const entry: unknown = frame.component.entries[index];
			if (!isRecord(entry)) fail('INVALID_INPUT');
			if (entry.kind === 'component') {
				stack.push({ component: entry, depth: frame.depth + 1 });
			} else if (entry.kind === 'property') {
				propertyCount += 1;
				if (propertyCount > ICALENDAR_MAX_PROPERTIES) fail('RESOURCE_LIMIT_EXCEEDED');
			} else {
				fail('INVALID_INPUT');
			}
		}
	}

	return resource as unknown as ICalendarResource;
}

function validateParameter(parameter: unknown): asserts parameter is ICalendarParameter {
	if (!isRecord(parameter) || parameter.kind !== 'parameter') fail('INVALID_INPUT');
	if (typeof parameter.name !== 'string' || !NAME_PATTERN.test(parameter.name)) {
		fail('INVALID_INPUT');
	}
	if (!Array.isArray(parameter.values) || parameter.values.length === 0) fail('INVALID_INPUT');

	for (const value of parameter.values) {
		if (!isRecord(value) || value.kind !== 'parameterValue') fail('INVALID_INPUT');
		if (
			typeof value.raw !== 'string' ||
			typeof value.value !== 'string' ||
			typeof value.quoted !== 'boolean' ||
			!isValidParameterValue(value.value)
		) {
			fail('INVALID_INPUT');
		}
	}
}

function effectiveValueType(property: ICalendarProperty): string {
	const valueParameters = property.parameters.filter(
		(parameter) => parameter.name.toUpperCase() === 'VALUE',
	);
	if (valueParameters.length > 1) fail('INVALID_INPUT');
	if (valueParameters.length === 1) {
		const values = valueParameters[0]!.values;
		if (values.length !== 1 || values[0]!.value.length === 0) fail('INVALID_INPUT');
		return values[0]!.value.toUpperCase();
	}
	return DEFAULT_VALUE_TYPES[property.name.toUpperCase()] ?? 'TEXT';
}

function validateProperty(property: ICalendarProperty): void {
	if (property.kind !== 'property') fail('INVALID_INPUT');
	if (
		typeof property.name !== 'string' ||
		!NAME_PATTERN.test(property.name) ||
		property.name.toUpperCase() === 'BEGIN' ||
		property.name.toUpperCase() === 'END'
	) {
		fail('INVALID_INPUT');
	}
	if (!Array.isArray(property.parameters)) fail('INVALID_INPUT');
	for (const parameter of property.parameters) validateParameter(parameter);

	if (!isRecord(property.value) || property.value.kind !== 'value') fail('INVALID_INPUT');
	const { valueType, raw, textValues } = property.value;
	if (
		typeof valueType !== 'string' ||
		!NAME_PATTERN.test(valueType) ||
		valueType !== valueType.toUpperCase() ||
		typeof raw !== 'string'
	) {
		fail('INVALID_INPUT');
	}
	if (valueType !== effectiveValueType(property)) fail('INVALID_INPUT');

	if (valueType === 'TEXT') {
		if (!Array.isArray(textValues) || textValues.length === 0) fail('INVALID_INPUT');
		for (const text of textValues) {
			if (typeof text !== 'string') fail('INVALID_INPUT');
			if (!isValidText(text)) fail('INVALID_TEXT');
		}
	} else {
		if (textValues !== null || !isValidRawValue(raw)) fail('INVALID_INPUT');
	}
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

function validateComponent(component: ICalendarComponent, parentName?: string): void {
	if (parentName !== undefined && !childIsAllowed(parentName, component.name))
		fail('INVALID_INPUT');
	let hasChild = false;
	for (const entry of component.entries) {
		if (entry.kind === 'component') {
			hasChild = true;
			validateComponent(entry, component.name);
		} else {
			if (hasChild) fail('INVALID_INPUT');
			validateProperty(entry);
		}
	}
}

function directProperties(component: ICalendarComponent, name: string): ICalendarProperty[] {
	const expected = name.toUpperCase();
	return component.entries.filter(
		(entry): entry is ICalendarProperty =>
			entry.kind === 'property' && entry.name.toUpperCase() === expected,
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

function validateCalendar(resource: ICalendarResource): void {
	const calendar = resource.calendar;
	if (calendar.name.toUpperCase() !== 'VCALENDAR') fail('INVALID_INPUT');
	validateComponent(calendar);

	const versions = directProperties(calendar, 'VERSION');
	if (
		versions.length !== 1 ||
		versions[0]!.value.textValues === null ||
		versions[0]!.value.textValues.length !== 1 ||
		versions[0]!.value.textValues[0] !== '2.0'
	) {
		fail('INVALID_INPUT');
	}

	const calendarComponents = directComponents(calendar);
	if (calendarComponents.length === 0 || directProperties(calendar, 'METHOD').length > 0) {
		fail('INVALID_INPUT');
	}
	const objectComponents = calendarComponents.filter(
		(component) => component.name.toUpperCase() !== 'VTIMEZONE',
	);
	if (new Set(objectComponents.map(({ name }) => name.toUpperCase())).size > 1) {
		fail('INVALID_INPUT');
	}

	let resourceUid: string | undefined;
	for (const component of objectComponents) {
		if (!UID_COMPONENT_NAMES.has(component.name.toUpperCase())) continue;
		const uids = directProperties(component, 'UID');
		if (uids.length !== 1) fail('INVALID_INPUT');
		const uid = decodedUid(uids[0]!);
		if (uid.length === 0) fail('INVALID_INPUT');
		if (resourceUid === undefined) resourceUid = uid;
		else if (uid !== resourceUid) fail('INVALID_INPUT');
	}
}

function serializedParameter(parameter: ICalendarParameter): string {
	return `${parameter.name}=${parameter.values
		.map(({ value }) => {
			const encoded = encodeParameterValue(value);
			return parameterValueNeedsQuotes(encoded) ? `"${encoded}"` : encoded;
		})
		.join(',')}`;
}

function serializedProperty(property: ICalendarProperty): string {
	const parameters = property.parameters.map(serializedParameter);
	const prefix = `${property.name}${parameters.map((parameter) => `;${parameter}`).join('')}:`;
	const value =
		property.value.textValues === null
			? property.value.raw
			: property.value.textValues.map(escapeText).join(',');
	return prefix + value;
}

function appendComponentLines(component: ICalendarComponent, lines: string[]): void {
	lines.push(`BEGIN:${component.name}`);
	for (const entry of component.entries) {
		if (entry.kind === 'component') appendComponentLines(entry, lines);
		else lines.push(serializedProperty(entry));
	}
	lines.push(`END:${component.name}`);
}

function appendFoldedLine(logicalLine: string, output: string[], currentBytes: number): number {
	if (currentBytes + logicalLine.length + 2 > ICALENDAR_MAX_RESOURCE_BYTES) {
		fail('RESOURCE_LIMIT_EXCEEDED');
	}
	const bytes = UTF8_ENCODER.encode(logicalLine);
	let start = 0;
	let first = true;

	while (start < bytes.length || (bytes.length === 0 && first)) {
		const available = first ? 75 : 74;
		let end = Math.min(start + available, bytes.length);
		while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
		const physicalLine = `${first ? '' : ' '}${UTF8_DECODER.decode(bytes.subarray(start, end))}`;
		currentBytes += end - start + (first ? 0 : 1) + 2;
		if (currentBytes > ICALENDAR_MAX_RESOURCE_BYTES) fail('RESOURCE_LIMIT_EXCEEDED');
		output.push(physicalLine, '\r\n');
		start = end;
		first = false;
	}
	return currentBytes;
}

function serializeResource(resource: ICalendarResource): string {
	const logicalLines: string[] = [];
	appendComponentLines(resource.calendar, logicalLines);
	const output: string[] = [];
	let byteLength = 0;
	for (const line of logicalLines) byteLength = appendFoldedLine(line, output, byteLength);
	return output.join('');
}

export function serializeBasicUtcEvent(input: BasicUtcEventSerializationInput): string {
	try {
		return serializeICalendarResource(
			basicResource(snapshotBasicInput(input, { timeZoneMode: 'utc' })),
		);
	} catch (error) {
		if (error instanceof CalDavICalendarSerializeError) throw error;
		fail('INVALID_INPUT');
	}
}

export function serializeBasicTimedEvent(
	input: BasicTimedEventSerializationInput,
	projectInstant: CalendarEventInstantProjector = projectInstantInTimeZone,
	timeZoneDefinition?: ICalendarComponent,
): string {
	try {
		if (!isRecord(input.timeZone)) fail('INVALID_INPUT');
		return serializeICalendarResource(
			basicResource(snapshotBasicInput(input, input.timeZone), projectInstant, timeZoneDefinition),
		);
	} catch (error) {
		if (error instanceof CalDavICalendarSerializeError) throw error;
		fail('INVALID_INPUT');
	}
}

export function serializeICalendarResource(resource: ICalendarResource): string {
	try {
		const validatedResource = preflightResource(resource);
		validateCalendar(validatedResource);
		return serializeResource(validatedResource);
	} catch (error) {
		if (error instanceof CalDavICalendarSerializeError) throw error;
		fail('INVALID_INPUT');
	}
}
