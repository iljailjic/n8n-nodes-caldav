/* eslint-disable @n8n/community-nodes/require-node-api-error -- protocol-layer typed errors are mapped at the node boundary. */

import { parseICalendarResource } from './parser';
import type { ICalendarComponent, ICalendarProperty, ICalendarResource } from './parser';
import {
	CalDavIanaTimeZoneError,
	canonicalizeIanaTimeZone,
	resolveLocalDateTimeInTimeZone,
} from './timeZones';
import type { IanaTimeZoneId, LocalDateTimeString } from './timeZones';
import type { CalendarEventTimeZoneExecutionContext } from '../discovery/timeZoneReferences';
import type { AbsoluteHttpUrl } from '../transport/url';

export const CalendarEventReadModelErrorCode = Object.freeze({
	NOT_VEVENT_RESOURCE: 'NOT_VEVENT_RESOURCE',
	INVALID_EVENT_IDENTITY: 'INVALID_EVENT_IDENTITY',
	MISSING_MASTER_EVENT: 'MISSING_MASTER_EVENT',
	MULTIPLE_MASTER_EVENTS: 'MULTIPLE_MASTER_EVENTS',
	AMBIGUOUS_EVENT_PROPERTY: 'AMBIGUOUS_EVENT_PROPERTY',
	INVALID_EVENT_PROPERTY: 'INVALID_EVENT_PROPERTY',
	UNSUPPORTED_EVENT_TIME: 'UNSUPPORTED_EVENT_TIME',
	INVALID_EVENT_TIME_RANGE: 'INVALID_EVENT_TIME_RANGE',
	INVALID_EVENT_EXTENSIONS: 'INVALID_EVENT_EXTENSIONS',
} as const);

export type CalendarEventReadModelErrorCode =
	(typeof CalendarEventReadModelErrorCode)[keyof typeof CalendarEventReadModelErrorCode];

const ERROR_MESSAGES: Readonly<Record<CalendarEventReadModelErrorCode, string>> = {
	NOT_VEVENT_RESOURCE: 'The calendar object resource does not contain a supported VEVENT set.',
	INVALID_EVENT_IDENTITY: 'The calendar object resource has invalid event identity.',
	MISSING_MASTER_EVENT: 'The calendar object resource does not contain a master VEVENT.',
	MULTIPLE_MASTER_EVENTS: 'The calendar object resource contains more than one master VEVENT.',
	AMBIGUOUS_EVENT_PROPERTY: 'The calendar object resource contains an ambiguous event property.',
	INVALID_EVENT_PROPERTY: 'The calendar object resource contains an invalid event property.',
	UNSUPPORTED_EVENT_TIME:
		'The calendar object resource uses an unsupported event time representation.',
	INVALID_EVENT_TIME_RANGE: 'The event end must be later than the event start.',
	INVALID_EVENT_EXTENSIONS: 'The event provider extensions are invalid.',
};

export class CalDavCalendarEventReadModelError extends Error {
	readonly code: CalendarEventReadModelErrorCode;

	constructor(code: CalendarEventReadModelErrorCode) {
		super(ERROR_MESSAGES[code]);
		this.name = 'CalDavCalendarEventReadModelError';
		this.code = code;
	}
}

export type UtcDateTimeString = string & {
	readonly __utcDateTimeString: unique symbol;
};

export type CalendarDateString = string & {
	readonly __calendarDateString: unique symbol;
};

export type CalendarEventEditableTimeMode = 'timed' | 'allDay';
export type CalendarEventAccessMode = 'editable' | 'readOnly';
export type CalendarEventReadOnlyReason = 'unsupportedTimeRepresentation';

export type CalendarEventExtensionValue =
	| null
	| boolean
	| number
	| string
	| readonly CalendarEventExtensionValue[]
	| { readonly [key: string]: CalendarEventExtensionValue };

export type CalendarEventExtensions = Readonly<
	Record<string, Readonly<Record<string, CalendarEventExtensionValue>>>
>;

export interface CalendarEventResourceInput {
	readonly calendarUrl: AbsoluteHttpUrl;
	readonly resourceUrl: AbsoluteHttpUrl;
	readonly etag?: string;
	readonly resource: ICalendarResource;
	readonly timeZoneDefinition?: ICalendarComponent;
	readonly extensions?: CalendarEventExtensions;
}

interface CalendarEventCommon {
	readonly calendarUrl: AbsoluteHttpUrl;
	readonly resourceUrl: AbsoluteHttpUrl;
	readonly etag?: string;
	readonly uid: string;
	readonly summary?: string;
	readonly description?: string;
	readonly location?: string;
	readonly url?: string;
	readonly extensions?: CalendarEventExtensions;
}

export interface TimedCalendarEvent extends CalendarEventCommon {
	readonly timeMode: 'timed';
	readonly accessMode: 'editable';
	readonly start: UtcDateTimeString;
	readonly end: UtcDateTimeString;
	readonly timeZoneMode: 'utc' | 'iana';
	readonly timeZone?: IanaTimeZoneId;
	readonly startLocal: LocalDateTimeString;
	readonly endLocal: LocalDateTimeString;
}

export interface AllDayCalendarEvent extends CalendarEventCommon {
	readonly timeMode: 'allDay';
	readonly accessMode: 'editable';
	readonly startDate: CalendarDateString;
	readonly endDate: CalendarDateString;
}

export type EditableCalendarEvent = TimedCalendarEvent | AllDayCalendarEvent;

export interface ReadOnlyCalendarEvent extends CalendarEventCommon {
	readonly timeMode: 'unsupported';
	readonly accessMode: 'readOnly';
	readonly readOnlyReason: 'unsupportedTimeRepresentation';
}

export type CalendarEvent = EditableCalendarEvent | ReadOnlyCalendarEvent;

export interface CalendarEventPreservationContext {
	readonly resource: ICalendarResource;
	readonly master: ICalendarComponent;
	readonly exceptions: readonly ICalendarComponent[];
}

export interface CalendarEventReadResult {
	readonly event: CalendarEvent;
	readonly context: CalendarEventPreservationContext;
}

const PROJECTED_SINGLETONS = [
	'UID',
	'SUMMARY',
	'DESCRIPTION',
	'LOCATION',
	'URL',
	'DTSTART',
	'DTEND',
	'DURATION',
	'RECURRENCE-ID',
] as const;
const UNSAFE_EXTENSION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const PARSER_KINDS = new Set([
	'resource',
	'component',
	'property',
	'parameter',
	'parameterValue',
	'value',
]);
const UTC_DATE_TIME_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
const DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})$/;
const LOCAL_DATE_TIME_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/;
const PRESERVATION_CONTEXT_PROVENANCE = new WeakSet<object>();
const PRESERVATION_CONTEXT_PROVENANCE_VERIFIER = '__isCanonicalCalendarEventPreservationContext';

function fail(code: CalendarEventReadModelErrorCode): never {
	throw new CalDavCalendarEventReadModelError(code);
}

function asciiUpperCase(value: string): string {
	let upper = '';
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		upper +=
			codeUnit >= 0x61 && codeUnit <= 0x7a ? String.fromCharCode(codeUnit - 0x20) : value[index]!;
	}
	return upper;
}

function directComponents(component: ICalendarComponent): readonly ICalendarComponent[] {
	return component.entries.filter(
		(entry): entry is ICalendarComponent => entry.kind === 'component',
	);
}

function directProperties(
	component: ICalendarComponent,
	name: string,
): readonly ICalendarProperty[] {
	const expectedName = asciiUpperCase(name);
	return component.entries.filter(
		(entry): entry is ICalendarProperty =>
			entry.kind === 'property' && asciiUpperCase(entry.name) === expectedName,
	);
}

function singleText(property: ICalendarProperty): string | undefined {
	if (
		asciiUpperCase(property.value.valueType) !== 'TEXT' ||
		property.value.textValues === null ||
		property.value.textValues.length !== 1
	) {
		return undefined;
	}
	return property.value.textValues[0];
}

function validateEventIdentity(events: readonly ICalendarComponent[]): string {
	let resourceUid: string | undefined;

	for (const event of events) {
		const uids = directProperties(event, 'UID');
		if (uids.length !== 1) fail('INVALID_EVENT_IDENTITY');

		const uid = singleText(uids[0]!);
		if (uid === undefined || uid.length === 0) fail('INVALID_EVENT_IDENTITY');
		if (resourceUid === undefined) resourceUid = uid;
		else if (resourceUid !== uid) fail('INVALID_EVENT_IDENTITY');
	}

	return resourceUid!;
}

function selectMaster(events: readonly ICalendarComponent[]): {
	readonly master: ICalendarComponent;
	readonly exceptions: readonly ICalendarComponent[];
} {
	const masters: ICalendarComponent[] = [];
	const exceptions: ICalendarComponent[] = [];

	for (const event of events) {
		const recurrenceIds = directProperties(event, 'RECURRENCE-ID');
		if (recurrenceIds.length > 1) fail('AMBIGUOUS_EVENT_PROPERTY');
		if (recurrenceIds.length === 0) masters.push(event);
		else exceptions.push(event);
	}

	if (masters.length === 0) fail('MISSING_MASTER_EVENT');
	if (masters.length > 1) fail('MULTIPLE_MASTER_EVENTS');
	return { master: masters[0]!, exceptions };
}

type RecurrenceIdentityForm = 'date' | 'utc' | 'floating' | 'local';

interface RecurrenceIdentityShape {
	readonly form: RecurrenceIdentityForm;
	readonly key: string;
}

function parameterValues(property: ICalendarProperty, name: string): readonly string[][] {
	const expectedName = asciiUpperCase(name);
	return property.parameters
		.filter((parameter) => asciiUpperCase(parameter.name) === expectedName)
		.map((parameter) => parameter.values.map((value) => value.value));
}

function isValidCalendarDateParts(match: RegExpExecArray): boolean {
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	return (
		year >= 1 &&
		year <= 9999 &&
		month >= 1 &&
		month <= 12 &&
		day >= 1 &&
		day <= daysInMonth(year, month)
	);
}

function isValidCalendarDateTimeMatch(match: RegExpExecArray): boolean {
	return (
		isValidCalendarDateParts(match) &&
		Number(match[4]) <= 23 &&
		Number(match[5]) <= 59 &&
		Number(match[6]) <= 60
	);
}

function recurrenceIdentityShape(property: ICalendarProperty): RecurrenceIdentityShape | undefined {
	if (property.value.textValues !== null) return undefined;

	const valueType = asciiUpperCase(property.value.valueType);
	const tzidParameters = parameterValues(property, 'TZID');
	if (tzidParameters.length > 1) return undefined;
	const tzidValues = tzidParameters[0];
	if (tzidValues !== undefined && (tzidValues.length !== 1 || tzidValues[0]!.length === 0)) {
		return undefined;
	}

	if (valueType === 'DATE') {
		if (tzidValues !== undefined) return undefined;
		const match = DATE_PATTERN.exec(property.value.raw);
		if (match === null || !isValidCalendarDateParts(match)) return undefined;
		return { form: 'date', key: property.value.raw };
	}

	if (valueType !== 'DATE-TIME') return undefined;
	if (property.value.raw.endsWith('Z')) {
		if (tzidValues !== undefined) return undefined;
		const match = UTC_DATE_TIME_PATTERN.exec(property.value.raw);
		if (match === null || !isValidCalendarDateTimeMatch(match)) return undefined;
		return { form: 'utc', key: property.value.raw };
	}

	const match = LOCAL_DATE_TIME_PATTERN.exec(property.value.raw);
	if (match === null || !isValidCalendarDateTimeMatch(match)) return undefined;
	if (tzidValues === undefined) return { form: 'floating', key: property.value.raw };
	return { form: 'local', key: `${tzidValues[0]!}\u0000${property.value.raw}` };
}

function validateExceptionIdentities(
	master: ICalendarComponent,
	exceptions: readonly ICalendarComponent[],
): void {
	if (exceptions.length === 0) return;

	const masterStarts = directProperties(master, 'DTSTART');
	if (masterStarts.length > 1) fail('AMBIGUOUS_EVENT_PROPERTY');
	if (masterStarts.length === 0) fail('INVALID_EVENT_PROPERTY');
	const masterShape = recurrenceIdentityShape(masterStarts[0]!);
	if (masterShape === undefined) fail('INVALID_EVENT_PROPERTY');

	const identities = new Set<string>();
	for (const exception of exceptions) {
		const recurrenceIds = directProperties(exception, 'RECURRENCE-ID');
		if (recurrenceIds.length !== 1) {
			fail(recurrenceIds.length > 1 ? 'AMBIGUOUS_EVENT_PROPERTY' : 'INVALID_EVENT_IDENTITY');
		}
		const shape = recurrenceIdentityShape(recurrenceIds[0]!);
		if (shape === undefined) fail('INVALID_EVENT_PROPERTY');
		const identityKey = `${shape.form}\u0000${shape.key}`;
		if (identities.has(identityKey)) fail('INVALID_EVENT_IDENTITY');
		identities.add(identityKey);
	}
}

export function createCalendarEventPreservationContext(
	resource: ICalendarResource,
): CalendarEventPreservationContext {
	const objectComponents = directComponents(resource.calendar).filter(
		(component) => asciiUpperCase(component.name) !== 'VTIMEZONE',
	);
	if (
		objectComponents.length === 0 ||
		objectComponents.some((component) => asciiUpperCase(component.name) !== 'VEVENT')
	) {
		fail('NOT_VEVENT_RESOURCE');
	}

	validateEventIdentity(objectComponents);
	const { master, exceptions } = selectMaster(objectComponents);
	validateExceptionIdentities(master, exceptions);

	const context = {
		resource,
		master,
		exceptions: Object.freeze([...exceptions]),
	};
	const frozenContext = Object.freeze(context);
	PRESERVATION_CONTEXT_PROVENANCE.add(frozenContext);
	return frozenContext;
}

Object.defineProperty(
	createCalendarEventPreservationContext,
	PRESERVATION_CONTEXT_PROVENANCE_VERIFIER,
	{
		value: (value: unknown): boolean =>
			typeof value === 'object' && value !== null && PRESERVATION_CONTEXT_PROVENANCE.has(value),
		enumerable: false,
		writable: false,
		configurable: false,
	},
);

function validateMasterSingletons(master: ICalendarComponent): void {
	for (const name of PROJECTED_SINGLETONS) {
		if (directProperties(master, name).length > 1) fail('AMBIGUOUS_EVENT_PROPERTY');
	}
}

function optionalText(master: ICalendarComponent, name: string): string | undefined {
	const property = directProperties(master, name)[0];
	if (property === undefined) return undefined;

	const value = singleText(property);
	if (value === undefined) fail('INVALID_EVENT_PROPERTY');
	return value;
}

function optionalUri(master: ICalendarComponent): string | undefined {
	const property = directProperties(master, 'URL')[0];
	if (property === undefined) return undefined;
	if (asciiUpperCase(property.value.valueType) !== 'URI' || property.value.textValues !== null) {
		fail('INVALID_EVENT_PROPERTY');
	}
	return property.value.raw;
}

function requireDateTimeProperty(master: ICalendarComponent, name: string): ICalendarProperty {
	const property = directProperties(master, name)[0];
	if (property === undefined) fail('INVALID_EVENT_PROPERTY');
	const valueType = asciiUpperCase(property.value.valueType);
	if (valueType !== 'DATE-TIME' && valueType !== 'DATE') fail('INVALID_EVENT_PROPERTY');
	if (property.value.textValues !== null) fail('INVALID_EVENT_PROPERTY');
	return property;
}

function hasParameter(property: ICalendarProperty, name: string): boolean {
	const expectedName = asciiUpperCase(name);
	return property.parameters.some((parameter) => asciiUpperCase(parameter.name) === expectedName);
}

function isLeapYear(year: number): boolean {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
	if (month === 2) return isLeapYear(year) ? 29 : 28;
	if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
	return 31;
}

interface ParsedUtcDateTime {
	readonly formatted: UtcDateTimeString;
	readonly comparisonKey: string;
}

interface ParsedCalendarDate {
	readonly formatted: CalendarDateString;
	readonly comparisonKey: string;
}

interface ParsedLocalDateTime {
	readonly local: LocalDateTimeString;
	readonly rawKey: string;
}

function parseUtcDateTime(property: ICalendarProperty): ParsedUtcDateTime {
	if (hasParameter(property, 'TZID')) fail('UNSUPPORTED_EVENT_TIME');

	const match = UTC_DATE_TIME_PATTERN.exec(property.value.raw);
	if (match === null) fail('UNSUPPORTED_EVENT_TIME');
	const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const hour = Number(hourText);
	const minute = Number(minuteText);
	const second = Number(secondText);

	if (
		year === 0 ||
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > daysInMonth(year, month) ||
		hour > 23 ||
		minute > 59 ||
		second > 60
	) {
		fail('UNSUPPORTED_EVENT_TIME');
	}

	return {
		formatted:
			`${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}Z` as UtcDateTimeString,
		comparisonKey: `${yearText}${monthText}${dayText}${hourText}${minuteText}${secondText}`,
	};
}

function parseCalendarDate(property: ICalendarProperty): ParsedCalendarDate {
	if (hasParameter(property, 'TZID')) fail('UNSUPPORTED_EVENT_TIME');
	const match = DATE_PATTERN.exec(property.value.raw);
	if (match === null || !isValidCalendarDateParts(match)) fail('INVALID_EVENT_PROPERTY');
	const [, year, month, day] = match;
	return {
		formatted: `${year}-${month}-${day}` as CalendarDateString,
		comparisonKey: property.value.raw,
	};
}

function timePropertyIsSyntacticallyReadable(property: ICalendarProperty): boolean {
	if (property.value.textValues !== null) return false;
	const valueType = asciiUpperCase(property.value.valueType);
	if (valueType === 'DATE') {
		const match = DATE_PATTERN.exec(property.value.raw);
		return match !== null && isValidCalendarDateParts(match);
	}
	if (valueType !== 'DATE-TIME') return false;
	const utcMatch = UTC_DATE_TIME_PATTERN.exec(property.value.raw);
	if (utcMatch !== null) return isValidCalendarDateTimeMatch(utcMatch);
	const localMatch = LOCAL_DATE_TIME_PATTERN.exec(property.value.raw);
	return localMatch !== null && isValidCalendarDateTimeMatch(localMatch);
}

function parseLocalDateTime(property: ICalendarProperty): ParsedLocalDateTime | undefined {
	if (asciiUpperCase(property.value.valueType) !== 'DATE-TIME') return undefined;
	const match = LOCAL_DATE_TIME_PATTERN.exec(property.value.raw);
	if (match === null || !isValidCalendarDateTimeMatch(match) || Number(match[6]) > 59) {
		return undefined;
	}
	return {
		local:
			`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}` as LocalDateTimeString,
		rawKey: property.value.raw,
	};
}

function onlyTzid(property: ICalendarProperty): string | undefined {
	const tzids = parameterValues(property, 'TZID');
	if (tzids.length !== 1 || tzids[0]!.length !== 1 || tzids[0]![0]!.length === 0) return undefined;
	return tzids[0]![0]!;
}

function utcInstant(value: Date): UtcDateTimeString {
	return value.toISOString().replace('.000Z', 'Z') as UtcDateTimeString;
}

function isUtcExceptionDateTime(property: ICalendarProperty): boolean {
	try {
		return (
			asciiUpperCase(property.value.valueType) === 'DATE-TIME' &&
			property.value.textValues === null &&
			property.value.raw.endsWith('Z') &&
			parseUtcDateTime(property) !== undefined
		);
	} catch {
		return false;
	}
}

function isIanaExceptionDateTime(property: ICalendarProperty, timeZone: IanaTimeZoneId): boolean {
	const parsed = parseLocalDateTime(property);
	const identifier = onlyTzid(property);
	if (parsed === undefined || identifier === undefined) return false;
	try {
		return canonicalizeIanaTimeZone(identifier) === timeZone;
	} catch {
		return false;
	}
}

function exceptionsMatchTimedRepresentation(
	exceptions: readonly ICalendarComponent[],
	timeZoneMode: 'utc' | 'iana',
	timeZone?: IanaTimeZoneId,
): boolean {
	return exceptions.every((exception) => {
		const recurrenceIds = directProperties(exception, 'RECURRENCE-ID');
		const starts = directProperties(exception, 'DTSTART');
		const ends = directProperties(exception, 'DTEND');
		if (recurrenceIds.length !== 1 || starts.length !== 1 || ends.length > 1) return false;
		const properties = [recurrenceIds[0]!, starts[0]!, ...ends];
		return timeZoneMode === 'utc'
			? properties.every(isUtcExceptionDateTime)
			: timeZone !== undefined &&
					properties.every((property) => isIanaExceptionDateTime(property, timeZone));
	});
}

function isPlainRecord(value: object): boolean {
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

type ExtensionValidationFailure = () => never;

function assertDataPropertiesOnly(
	value: object,
	failValidation: ExtensionValidationFailure,
): Readonly<Record<string, PropertyDescriptor>> {
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (Object.getOwnPropertySymbols(value).length > 0) failValidation();
	for (const descriptor of Object.values(descriptors)) {
		if (!('value' in descriptor)) failValidation();
	}
	return descriptors;
}

function isParserNode(descriptors: Readonly<Record<string, PropertyDescriptor>>): boolean {
	const kind = descriptors.kind;
	return kind !== undefined && 'value' in kind && PARSER_KINDS.has(kind.value as string);
}

function cloneExtensionValue(
	value: unknown,
	containerDepth: number,
	ancestors: WeakSet<object>,
	failValidation: ExtensionValidationFailure,
): CalendarEventExtensionValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) failValidation();
		return value;
	}
	if (typeof value !== 'object') failValidation();
	if (containerDepth >= 32) failValidation();
	if (ancestors.has(value)) failValidation();
	ancestors.add(value);

	try {
		if (Array.isArray(value)) {
			const descriptors = assertDataPropertiesOnly(value, failValidation);
			const expectedKeys = new Set(['length']);
			const snapshot: CalendarEventExtensionValue[] = [];
			for (let index = 0; index < value.length; index += 1) {
				const key = String(index);
				expectedKeys.add(key);
				const descriptor = descriptors[key];
				if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
					failValidation();
				}
				snapshot.push(
					cloneExtensionValue(descriptor.value, containerDepth + 1, ancestors, failValidation),
				);
			}
			if (Object.keys(descriptors).some((key) => !expectedKeys.has(key))) {
				failValidation();
			}
			return Object.freeze(snapshot);
		}

		if (!isPlainRecord(value)) failValidation();
		const descriptors = assertDataPropertiesOnly(value, failValidation);
		if (isParserNode(descriptors)) failValidation();
		const snapshot: Record<string, CalendarEventExtensionValue> = {};
		for (const [key, descriptor] of Object.entries(descriptors)) {
			if (UNSAFE_EXTENSION_KEYS.has(key) || !descriptor.enumerable) {
				failValidation();
			}
			snapshot[key] = cloneExtensionValue(
				descriptor.value,
				containerDepth + 1,
				ancestors,
				failValidation,
			);
		}
		return Object.freeze(snapshot);
	} finally {
		ancestors.delete(value);
	}
}

function snapshotExtensionsUnchecked(
	extensions: CalendarEventExtensions | undefined,
	failValidation: ExtensionValidationFailure,
): CalendarEventExtensions | undefined {
	if (extensions === undefined) return undefined;
	if (extensions === null || typeof extensions !== 'object' || !isPlainRecord(extensions)) {
		failValidation();
	}

	const descriptors = assertDataPropertiesOnly(extensions, failValidation);
	if (isParserNode(descriptors)) failValidation();
	const providerIds = Object.keys(descriptors);
	if (providerIds.length === 0) return undefined;

	const snapshot: Record<string, Readonly<Record<string, CalendarEventExtensionValue>>> = {};
	for (const providerId of providerIds) {
		const descriptor = descriptors[providerId]!;
		if (
			providerId.length === 0 ||
			UNSAFE_EXTENSION_KEYS.has(providerId) ||
			!descriptor.enumerable ||
			typeof descriptor.value !== 'object' ||
			descriptor.value === null ||
			!isPlainRecord(descriptor.value)
		) {
			failValidation();
		}
		const providerSnapshot = cloneExtensionValue(
			descriptor.value,
			-1,
			new WeakSet<object>(),
			failValidation,
		);
		if (Array.isArray(providerSnapshot) || providerSnapshot === null) {
			failValidation();
		}
		snapshot[providerId] = providerSnapshot as Readonly<
			Record<string, CalendarEventExtensionValue>
		>;
	}

	return Object.freeze(snapshot);
}

function snapshotExtensions(
	extensions: CalendarEventExtensions | undefined,
): CalendarEventExtensions | undefined {
	const internalErrors = new WeakSet<object>();
	const failValidation = (): never => {
		const error = new CalDavCalendarEventReadModelError('INVALID_EVENT_EXTENSIONS');
		internalErrors.add(error);
		throw error;
	};

	try {
		return snapshotExtensionsUnchecked(extensions, failValidation);
	} catch (error: unknown) {
		if (typeof error === 'object' && error !== null && internalErrors.has(error)) {
			throw error;
		}
		return fail('INVALID_EVENT_EXTENSIONS');
	}
}

export function mapCalendarEventResource(
	input: CalendarEventResourceInput,
): CalendarEventReadResult {
	const context = createCalendarEventPreservationContext(input.resource);
	const { master } = context;
	const uid = singleText(directProperties(master, 'UID')[0]!)!;
	validateMasterSingletons(master);

	const summary = optionalText(master, 'SUMMARY');
	const description = optionalText(master, 'DESCRIPTION');
	const location = optionalText(master, 'LOCATION');
	const url = optionalUri(master);
	const startProperty = requireDateTimeProperty(master, 'DTSTART');
	const endProperty = directProperties(master, 'DTEND')[0];
	const durationProperty = directProperties(master, 'DURATION')[0];
	if (endProperty !== undefined && durationProperty !== undefined) fail('INVALID_EVENT_PROPERTY');
	if (
		endProperty !== undefined &&
		(!['DATE-TIME', 'DATE'].includes(asciiUpperCase(endProperty.value.valueType)) ||
			endProperty.value.textValues !== null)
	) {
		fail('INVALID_EVENT_PROPERTY');
	}
	if (!timePropertyIsSyntacticallyReadable(startProperty)) fail('INVALID_EVENT_PROPERTY');
	if (endProperty !== undefined && !timePropertyIsSyntacticallyReadable(endProperty)) {
		fail('INVALID_EVENT_PROPERTY');
	}

	const extensions = snapshotExtensions(input.extensions);
	const common = {
		calendarUrl: input.calendarUrl,
		resourceUrl: input.resourceUrl,
		...(input.etag !== undefined ? { etag: input.etag } : {}),
		uid,
		...(summary !== undefined ? { summary } : {}),
		...(description !== undefined ? { description } : {}),
		...(location !== undefined ? { location } : {}),
		...(url !== undefined ? { url } : {}),
	};

	const startType = asciiUpperCase(startProperty.value.valueType);
	if (startType === 'DATE') {
		let event: CalendarEvent;
		if (
			durationProperty === undefined &&
			endProperty !== undefined &&
			asciiUpperCase(endProperty.value.valueType) === 'DATE' &&
			!hasParameter(startProperty, 'TZID') &&
			!hasParameter(endProperty, 'TZID')
		) {
			const start = parseCalendarDate(startProperty);
			const end = parseCalendarDate(endProperty);
			if (end.comparisonKey <= start.comparisonKey) fail('INVALID_EVENT_TIME_RANGE');
			event = Object.freeze({
				...common,
				timeMode: 'allDay',
				accessMode: 'editable',
				startDate: start.formatted,
				endDate: end.formatted,
				...(extensions !== undefined ? { extensions } : {}),
			});
		} else {
			event = Object.freeze({
				...common,
				timeMode: 'unsupported',
				accessMode: 'readOnly',
				readOnlyReason: 'unsupportedTimeRepresentation',
				...(extensions !== undefined ? { extensions } : {}),
			});
		}
		return Object.freeze({ event, context });
	}

	let timed:
		| {
				readonly start: UtcDateTimeString;
				readonly end: UtcDateTimeString;
				readonly timeZoneMode: 'utc';
				readonly startLocal: LocalDateTimeString;
				readonly endLocal: LocalDateTimeString;
		  }
		| {
				readonly start: UtcDateTimeString;
				readonly end: UtcDateTimeString;
				readonly timeZoneMode: 'iana';
				readonly timeZone: IanaTimeZoneId;
				readonly startLocal: LocalDateTimeString;
				readonly endLocal: LocalDateTimeString;
		  }
		| undefined;

	const effectiveEndProperty =
		endProperty ?? (durationProperty === undefined ? startProperty : undefined);
	if (durationProperty === undefined && effectiveEndProperty !== undefined) {
		if (startProperty.value.raw.endsWith('Z') && effectiveEndProperty.value.raw.endsWith('Z')) {
			try {
				const start = parseUtcDateTime(startProperty);
				const end = parseUtcDateTime(effectiveEndProperty);
				if (endProperty !== undefined && end.comparisonKey <= start.comparisonKey) {
					fail('INVALID_EVENT_TIME_RANGE');
				}
				timed = {
					start: start.formatted,
					end: end.formatted,
					timeZoneMode: 'utc',
					startLocal: start.formatted.slice(0, -1) as LocalDateTimeString,
					endLocal: end.formatted.slice(0, -1) as LocalDateTimeString,
				};
			} catch (error) {
				if (
					error instanceof CalDavCalendarEventReadModelError &&
					error.code === CalendarEventReadModelErrorCode.INVALID_EVENT_TIME_RANGE
				) {
					throw error;
				}
			}
		} else {
			const startLocal = parseLocalDateTime(startProperty);
			const endLocal = parseLocalDateTime(effectiveEndProperty);
			const startTzid = onlyTzid(startProperty);
			const endTzid = onlyTzid(effectiveEndProperty);
			if (
				startLocal !== undefined &&
				endLocal !== undefined &&
				startTzid !== undefined &&
				endTzid !== undefined &&
				startTzid === endTzid
			) {
				try {
					const timeZone = canonicalizeIanaTimeZone(startTzid);
					const definitions = directComponents(input.resource.calendar).filter(
						(component) =>
							asciiUpperCase(component.name) === 'VTIMEZONE' &&
							directProperties(component, 'TZID').some(
								(property) => singleText(property) === startTzid,
							),
					);
					let startInstant: Date | undefined;
					let endInstant: Date | undefined;
					const definition =
						definitions.length === 1
							? definitions[0]
							: definitions.length === 0
								? input.timeZoneDefinition
								: undefined;
					if (definition !== undefined) {
						const identifiers = directProperties(definition, 'TZID');
						const definitionTimeZone =
							identifiers.length === 1 ? singleText(identifiers[0]!) : undefined;
						if (
							definitionTimeZone === undefined ||
							canonicalizeIanaTimeZone(definitionTimeZone) !== timeZone
						) {
							throw new CalDavIanaTimeZoneError('UNSUPPORTED_DEFINITION');
						}
						startInstant = resolveLocalDateTimeInTimeZone(startLocal.local, timeZone, definition);
						endInstant = resolveLocalDateTimeInTimeZone(endLocal.local, timeZone, definition);
					}
					if (startInstant !== undefined && endInstant !== undefined) {
						if (endProperty !== undefined && endInstant.getTime() <= startInstant.getTime()) {
							fail('INVALID_EVENT_TIME_RANGE');
						}
						timed = {
							start: utcInstant(startInstant),
							end: utcInstant(endInstant),
							timeZoneMode: 'iana',
							timeZone,
							startLocal: startLocal.local,
							endLocal: endLocal.local,
						};
					}
				} catch (error) {
					if (
						error instanceof CalDavCalendarEventReadModelError &&
						error.code === CalendarEventReadModelErrorCode.INVALID_EVENT_TIME_RANGE
					) {
						throw error;
					}
				}
			}
		}
	}
	if (
		timed !== undefined &&
		!exceptionsMatchTimedRepresentation(
			context.exceptions,
			timed.timeZoneMode,
			timed.timeZoneMode === 'iana' ? timed.timeZone : undefined,
		)
	) {
		timed = undefined;
	}

	const event = Object.freeze(
		timed === undefined
			? {
					...common,
					timeMode: 'unsupported',
					accessMode: 'readOnly',
					readOnlyReason: 'unsupportedTimeRepresentation',
					...(extensions !== undefined ? { extensions } : {}),
				}
			: {
					...common,
					timeMode: 'timed',
					accessMode: 'editable',
					start: timed.start,
					end: timed.end,
					timeZoneMode: timed.timeZoneMode,
					...(timed.timeZoneMode === 'iana' ? { timeZone: timed.timeZone } : {}),
					startLocal: timed.startLocal,
					endLocal: timed.endLocal,
					...(extensions !== undefined ? { extensions } : {}),
				},
	) satisfies CalendarEvent;
	return Object.freeze({ event, context });
}

function referencedTimeZone(resource: ICalendarResource): IanaTimeZoneId | undefined {
	const context = createCalendarEventPreservationContext(resource);
	const starts = directProperties(context.master, 'DTSTART');
	const ends = directProperties(context.master, 'DTEND');
	if (starts.length !== 1 || ends.length !== 1) return undefined;
	const start = starts[0]!;
	const end = ends[0]!;
	if (parseLocalDateTime(start) === undefined || parseLocalDateTime(end) === undefined) {
		return undefined;
	}
	const startTzid = onlyTzid(start);
	const endTzid = onlyTzid(end);
	if (startTzid === undefined || startTzid !== endTzid) return undefined;
	let timeZone: IanaTimeZoneId;
	try {
		timeZone = canonicalizeIanaTimeZone(startTzid);
	} catch {
		return undefined;
	}
	const embedded = directComponents(resource.calendar).filter(
		(component) =>
			asciiUpperCase(component.name) === 'VTIMEZONE' &&
			directProperties(component, 'TZID').some((property) => singleText(property) === startTzid),
	);
	return embedded.length === 0 ? timeZone : undefined;
}

export async function mapCalendarEventResourceWithTimeZoneContext(
	input: CalendarEventResourceInput,
	timeZoneContext?: CalendarEventTimeZoneExecutionContext,
): Promise<CalendarEventReadResult> {
	const timeZone = referencedTimeZone(input.resource);
	if (timeZone === undefined || timeZoneContext === undefined)
		return mapCalendarEventResource(input);
	try {
		const reference = await timeZoneContext.resolveReference(input.calendarUrl, timeZone);
		const resource = parseICalendarResource(Buffer.from(reference.calendarData, 'utf8'));
		const definitions = directComponents(resource.calendar).filter(
			(component) => asciiUpperCase(component.name) === 'VTIMEZONE',
		);
		return mapCalendarEventResource({
			...input,
			...(definitions.length === 1 ? { timeZoneDefinition: definitions[0] } : {}),
		});
	} catch {
		return mapCalendarEventResource(input);
	}
}
