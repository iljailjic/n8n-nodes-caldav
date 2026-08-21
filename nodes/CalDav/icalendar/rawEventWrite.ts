/* eslint-disable @n8n/community-nodes/require-node-api-error -- This protocol boundary exposes privacy-safe typed failures outside the n8n UI layer. */

import { randomUUID } from 'node:crypto';

import type { CalendarEventUidGenerator } from '../events/uid';
import { resolveCalendarEventUid } from '../events/uid';
import {
	CalDavICalendarParseError,
	ICALENDAR_MAX_RESOURCE_BYTES,
	parseICalendarResource,
} from './parser';
import type {
	ICalendarComponent,
	ICalendarEntry,
	ICalendarParameter,
	ICalendarProperty,
	ICalendarResource,
} from './parser';
import {
	CalDavICalendarSerializeError,
	CalDavICalendarSerializeErrorCode,
	serializeICalendarResource,
} from './serializer';

export type RawCalendarEventOperation = 'create' | 'update' | 'upsert';
export type RawCalendarEventUidSource = 'supplied' | 'generated';

export interface RawCalendarEventWritePreparationInput {
	readonly operation: RawCalendarEventOperation;
	readonly rawIcs: string;
}

export interface PreparedRawCalendarEventWrite {
	readonly resource: ICalendarResource;
	readonly calendarData: string;
	readonly uid: string;
	readonly uidSource: RawCalendarEventUidSource;
}

export const RawCalendarEventFailureCode = Object.freeze({
	INVALID_INPUT_MODE: 'INVALID_INPUT_MODE',
	INVALID_INPUT: 'INVALID_INPUT',
	INVALID_RESOURCE: 'INVALID_RESOURCE',
	METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
	UNSUPPORTED_COMPONENT: 'UNSUPPORTED_COMPONENT',
	INVALID_EVENT_SET: 'INVALID_EVENT_SET',
	INVALID_UID_SET: 'INVALID_UID_SET',
	UID_REQUIRED: 'UID_REQUIRED',
	UID_MISMATCH: 'UID_MISMATCH',
	NO_CHANGES: 'NO_CHANGES',
	RESOURCE_LIMIT_EXCEEDED: 'RESOURCE_LIMIT_EXCEEDED',
} as const);

export type RawCalendarEventFailureCode =
	(typeof RawCalendarEventFailureCode)[keyof typeof RawCalendarEventFailureCode];

const ERROR_MESSAGES: Readonly<Record<RawCalendarEventFailureCode, string>> = Object.freeze({
	INVALID_INPUT_MODE: 'Input Mode must be Structured or Raw ICS.',
	INVALID_INPUT: 'Raw ICS must be a non-empty valid iCalendar string.',
	INVALID_RESOURCE: 'Raw ICS must contain one valid VCALENDAR event resource.',
	METHOD_NOT_ALLOWED: 'Raw ICS must not contain a METHOD property.',
	UNSUPPORTED_COMPONENT: 'Raw ICS may contain only VEVENT and VTIMEZONE components.',
	INVALID_EVENT_SET:
		'Raw ICS must contain exactly one master VEVENT and valid same-UID recurrence exceptions.',
	INVALID_UID_SET:
		'Raw ICS VEVENT UIDs must be all absent or exactly one identical UID on every VEVENT.',
	UID_REQUIRED: 'Raw ICS Update requires exactly one identical UID on every VEVENT.',
	UID_MISMATCH: 'Raw ICS UID does not match the target calendar event.',
	NO_CHANGES: 'Raw ICS does not change the calendar event.',
	RESOURCE_LIMIT_EXCEEDED: 'The calendar event exceeds the supported size limit.',
});

export class CalDavRawCalendarEventError extends Error {
	readonly code: RawCalendarEventFailureCode;

	constructor(code: RawCalendarEventFailureCode) {
		super(ERROR_MESSAGES[code]);
		this.name = 'CalDavRawCalendarEventError';
		this.code = code;
	}
}

const UTF8_ENCODER = new TextEncoder();
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{8}$/;
const LOCAL_DATE_TIME_PATTERN = /^\d{8}T\d{6}$/;
const UTC_DATE_TIME_PATTERN = /^\d{8}T\d{6}Z$/;
const UTC_OFFSET_PATTERN = /^[+-](?:0\d|1\d|2[0-3])[0-5]\d(?:[0-5]\d)?$/;
const DURATION_PATTERN = /^[+-]?P(?=\d|T\d)(?:\d+W|(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?)$/;

function fail(code: RawCalendarEventFailureCode): never {
	throw new CalDavRawCalendarEventError(code);
}

function isValidUnicodeScalarSequence(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			return false;
		}
	}
	return true;
}

function properties(component: ICalendarComponent, name: string): readonly ICalendarProperty[] {
	const expected = name.toUpperCase();
	return component.entries.filter(
		(entry): entry is ICalendarProperty =>
			entry.kind === 'property' && entry.name.toUpperCase() === expected,
	);
}

function components(component: ICalendarComponent): readonly ICalendarComponent[] {
	return component.entries.filter(
		(entry): entry is ICalendarComponent => entry.kind === 'component',
	);
}

function decodedText(property: ICalendarProperty): string | undefined {
	return property.value.textValues?.length === 1 ? property.value.textValues[0] : undefined;
}

function parameter(property: ICalendarProperty, name: string): readonly ICalendarParameter[] {
	const expected = name.toUpperCase();
	return property.parameters.filter(({ name: candidate }) => candidate.toUpperCase() === expected);
}

function singleParameterValue(property: ICalendarProperty, name: string): string | undefined {
	const selected = parameter(property, name);
	return selected.length === 1 && selected[0]!.values.length === 1
		? selected[0]!.values[0]!.value
		: undefined;
}

function valueShape(property: ICalendarProperty): 'date' | 'dateTime' | undefined {
	const raw = property.value.raw;
	if (property.value.valueType === 'DATE' && DATE_PATTERN.test(raw)) return 'date';
	if (
		property.value.valueType === 'DATE-TIME' &&
		(LOCAL_DATE_TIME_PATTERN.test(raw) || UTC_DATE_TIME_PATTERN.test(raw))
	) {
		return 'dateTime';
	}
	return undefined;
}

function timeZoneForm(property: ICalendarProperty): string | undefined {
	return singleParameterValue(property, 'TZID');
}

function validateDateProperty(property: ICalendarProperty, allowList: boolean): void {
	const values = allowList ? property.value.raw.split(',') : [property.value.raw];
	if (values.length === 0 || values.some((value) => value.length === 0))
		return fail('INVALID_RESOURCE');
	const valueType = property.value.valueType;
	const tzids = parameter(property, 'TZID');
	if (tzids.length > 1 || (tzids.length === 1 && tzids[0]!.values.length !== 1)) {
		return fail('INVALID_RESOURCE');
	}
	for (const value of values) {
		if (valueType === 'DATE') {
			if (!DATE_PATTERN.test(value) || tzids.length > 0) return fail('INVALID_RESOURCE');
		} else if (valueType === 'DATE-TIME') {
			if (!LOCAL_DATE_TIME_PATTERN.test(value) && !UTC_DATE_TIME_PATTERN.test(value)) {
				return fail('INVALID_RESOURCE');
			}
			if (value.endsWith('Z') && tzids.length > 0) return fail('INVALID_RESOURCE');
		} else if (property.name.toUpperCase() === 'RDATE' && valueType === 'PERIOD') {
			const [start, end] = value.split('/');
			if (
				end === undefined ||
				(!LOCAL_DATE_TIME_PATTERN.test(start!) && !UTC_DATE_TIME_PATTERN.test(start!)) ||
				(!LOCAL_DATE_TIME_PATTERN.test(end) &&
					!UTC_DATE_TIME_PATTERN.test(end) &&
					!DURATION_PATTERN.test(end))
			) {
				return fail('INVALID_RESOURCE');
			}
		} else {
			return fail('INVALID_RESOURCE');
		}
	}
}

const EVENT_SINGLETONS = new Set([
	'CLASS',
	'COLOR',
	'CREATED',
	'DESCRIPTION',
	'DTEND',
	'DTSTAMP',
	'DTSTART',
	'DURATION',
	'GEO',
	'LAST-MODIFIED',
	'LOCATION',
	'ORGANIZER',
	'PRIORITY',
	'RECURRENCE-ID',
	'RRULE',
	'SEQUENCE',
	'STATUS',
	'SUMMARY',
	'TRANSP',
	'UID',
	'URL',
]);

function validateAlarm(alarm: ICalendarComponent): void {
	if (components(alarm).length > 0) return fail('INVALID_RESOURCE');
	if (properties(alarm, 'ACTION').length !== 1 || properties(alarm, 'TRIGGER').length !== 1) {
		return fail('INVALID_RESOURCE');
	}
	const action = decodedText(properties(alarm, 'ACTION')[0]!)?.toUpperCase();
	if (action === undefined || !['AUDIO', 'DISPLAY', 'EMAIL'].includes(action)) {
		return fail('INVALID_RESOURCE');
	}
	if ((properties(alarm, 'REPEAT').length === 0) !== (properties(alarm, 'DURATION').length === 0)) {
		return fail('INVALID_RESOURCE');
	}
	for (const name of ['ACTION', 'TRIGGER', 'REPEAT', 'DURATION'] as const) {
		if (properties(alarm, name).length > 1) return fail('INVALID_RESOURCE');
	}
}

function validateEvent(event: ICalendarComponent): void {
	for (const name of EVENT_SINGLETONS) {
		if (properties(event, name).length > 1 && name !== 'UID') return fail('INVALID_RESOURCE');
	}
	if (properties(event, 'DTSTAMP').length !== 1 || properties(event, 'DTSTART').length !== 1) {
		return fail('INVALID_RESOURCE');
	}
	if (properties(event, 'DTEND').length > 0 && properties(event, 'DURATION').length > 0) {
		return fail('INVALID_RESOURCE');
	}
	const dtstamp = properties(event, 'DTSTAMP')[0]!;
	if (dtstamp.value.valueType !== 'DATE-TIME' || !UTC_DATE_TIME_PATTERN.test(dtstamp.value.raw)) {
		return fail('INVALID_RESOURCE');
	}
	const start = properties(event, 'DTSTART')[0]!;
	validateDateProperty(start, false);
	for (const name of ['DTEND', 'RECURRENCE-ID', 'EXDATE', 'RDATE'] as const) {
		for (const property of properties(event, name))
			validateDateProperty(property, name !== 'DTEND');
	}
	const end = properties(event, 'DTEND')[0];
	if (
		end !== undefined &&
		(valueShape(end) !== valueShape(start) || timeZoneForm(end) !== timeZoneForm(start))
	) {
		return fail('INVALID_RESOURCE');
	}
	for (const property of properties(event, 'DURATION')) {
		if (property.value.valueType !== 'DURATION' || !DURATION_PATTERN.test(property.value.raw)) {
			return fail('INVALID_RESOURCE');
		}
	}
	for (const property of properties(event, 'RRULE')) {
		if (
			property.value.valueType !== 'RECUR' ||
			!/^(?:[A-Z-]+=[^;:\r\n]+)(?:;[A-Z-]+=[^;:\r\n]+)*$/.test(property.value.raw)
		) {
			return fail('INVALID_RESOURCE');
		}
	}
	for (const child of components(event)) {
		if (child.name.toUpperCase() !== 'VALARM') return fail('INVALID_RESOURCE');
		validateAlarm(child);
	}
}

function validateEventSet(events: readonly ICalendarComponent[]): void {
	if (events.length === 0) return fail('INVALID_EVENT_SET');
	const masters = events.filter((event) => properties(event, 'RECURRENCE-ID').length === 0);
	if (masters.length !== 1) return fail('INVALID_EVENT_SET');
	const masterStart = properties(masters[0]!, 'DTSTART')[0];
	if (masterStart === undefined) return fail('INVALID_EVENT_SET');
	const masterShape = valueShape(masterStart);
	if (masterShape === undefined) return fail('INVALID_EVENT_SET');
	const masterTimeZone = timeZoneForm(masterStart);
	const identities = new Set<string>();
	for (const exception of events.filter((event) => event !== masters[0])) {
		const recurrenceIds = properties(exception, 'RECURRENCE-ID');
		if (recurrenceIds.length !== 1) return fail('INVALID_EVENT_SET');
		const recurrenceId = recurrenceIds[0]!;
		if (
			valueShape(recurrenceId) !== masterShape ||
			timeZoneForm(recurrenceId) !== masterTimeZone ||
			recurrenceId.value.raw.length === 0 ||
			identities.has(recurrenceId.value.raw)
		) {
			return fail('INVALID_EVENT_SET');
		}
		identities.add(recurrenceId.value.raw);
	}
}

function validateTimeZones(resource: ICalendarResource): void {
	const definitions = components(resource.calendar).filter(
		(component) => component.name.toUpperCase() === 'VTIMEZONE',
	);
	const identifiers = new Set<string>();
	for (const definition of definitions) {
		const tzids = properties(definition, 'TZID');
		const tzid = tzids.length === 1 ? decodedText(tzids[0]!) : undefined;
		if (tzid === undefined || tzid.length === 0 || identifiers.has(tzid)) {
			return fail('INVALID_RESOURCE');
		}
		identifiers.add(tzid);
		const observances = components(definition);
		if (
			observances.length === 0 ||
			observances.some(
				(observance) => !['STANDARD', 'DAYLIGHT'].includes(observance.name.toUpperCase()),
			)
		) {
			return fail('INVALID_RESOURCE');
		}
		for (const observance of observances) {
			if (
				properties(observance, 'DTSTART').length !== 1 ||
				properties(observance, 'TZOFFSETFROM').length !== 1 ||
				properties(observance, 'TZOFFSETTO').length !== 1
			) {
				return fail('INVALID_RESOURCE');
			}
			const start = properties(observance, 'DTSTART')[0]!;
			if (
				start.value.valueType !== 'DATE-TIME' ||
				!LOCAL_DATE_TIME_PATTERN.test(start.value.raw) ||
				parameter(start, 'TZID').length > 0
			) {
				return fail('INVALID_RESOURCE');
			}
			for (const name of ['TZOFFSETFROM', 'TZOFFSETTO'] as const) {
				const selected = properties(observance, name);
				if (
					selected.length !== 1 ||
					selected[0]!.value.valueType !== 'UTC-OFFSET' ||
					!UTC_OFFSET_PATTERN.test(selected[0]!.value.raw)
				) {
					return fail('INVALID_RESOURCE');
				}
			}
		}
	}

	const stack: ICalendarComponent[] = [resource.calendar];
	while (stack.length > 0) {
		const component = stack.pop()!;
		for (const entry of component.entries) {
			if (entry.kind === 'component') {
				stack.push(entry);
				continue;
			}
			for (const tzidParameter of parameter(entry, 'TZID')) {
				if (
					tzidParameter.values.length !== 1 ||
					!identifiers.has(tzidParameter.values[0]!.value) ||
					entry.value.valueType === 'DATE' ||
					entry.value.raw.endsWith('Z')
				) {
					return fail('INVALID_RESOURCE');
				}
			}
		}
	}
}

function validateResource(resource: ICalendarResource): readonly ICalendarComponent[] {
	const calendar = resource.calendar;
	const versions = properties(calendar, 'VERSION');
	const prodids = properties(calendar, 'PRODID');
	const calscales = properties(calendar, 'CALSCALE');
	if (
		versions.length !== 1 ||
		decodedText(versions[0]!) !== '2.0' ||
		prodids.length !== 1 ||
		decodedText(prodids[0]!) === undefined ||
		decodedText(prodids[0]!)!.length === 0 ||
		calscales.length > 1 ||
		(calscales.length === 1 && decodedText(calscales[0]!)?.toUpperCase() !== 'GREGORIAN')
	) {
		return fail('INVALID_RESOURCE');
	}
	const direct = components(calendar);
	if (direct.some((component) => !['VEVENT', 'VTIMEZONE'].includes(component.name.toUpperCase()))) {
		return fail('UNSUPPORTED_COMPONENT');
	}
	const events = direct.filter((component) => component.name.toUpperCase() === 'VEVENT');
	validateEventSet(events);
	for (const event of events) validateEvent(event);
	validateTimeZones(resource);
	return events;
}

type UidClassification =
	{ readonly kind: 'absent' } | { readonly kind: 'supplied'; readonly uid: string };

function classifyUids(events: readonly ICalendarComponent[]): UidClassification {
	let absent = 0;
	let supplied: string | undefined;
	for (const event of events) {
		const uids = properties(event, 'UID');
		if (uids.length === 0) {
			absent += 1;
			continue;
		}
		if (uids.length !== 1) return fail('INVALID_UID_SET');
		const uid = decodedText(uids[0]!);
		if (uid === undefined || uid.length === 0) return fail('INVALID_UID_SET');
		if (supplied === undefined) supplied = uid;
		else if (supplied !== uid) return fail('INVALID_UID_SET');
	}
	if (absent === events.length) return { kind: 'absent' };
	if (absent > 0 || supplied === undefined) return fail('INVALID_UID_SET');
	return { kind: 'supplied', uid: supplied };
}

function generatedUid(generator: CalendarEventUidGenerator): string {
	try {
		const uid = resolveCalendarEventUid(undefined, generator);
		return typeof uid === 'string' && UUID_V4_PATTERN.test(uid) ? uid : fail('INVALID_INPUT');
	} catch (error) {
		if (error instanceof CalDavRawCalendarEventError) throw error;
		return fail('INVALID_INPUT');
	}
}

function uidProperty(uid: string): ICalendarProperty {
	return {
		kind: 'property',
		name: 'UID',
		parameters: [],
		value: { kind: 'value', valueType: 'TEXT', raw: uid, textValues: [uid] },
	};
}

function withInjectedUid(resource: ICalendarResource, uid: string): ICalendarResource {
	const calendar: ICalendarComponent = {
		kind: 'component',
		name: resource.calendar.name,
		entries: resource.calendar.entries.map((entry): ICalendarEntry =>
			entry.kind === 'component' && entry.name.toUpperCase() === 'VEVENT'
				? { ...entry, entries: [uidProperty(uid), ...entry.entries] }
				: entry,
		),
	};
	return { kind: 'resource', originalIcs: '', calendar };
}

function parseRaw(rawIcs: string): ICalendarResource {
	try {
		return parseICalendarResource(UTF8_ENCODER.encode(rawIcs), {
			allowMissingUid: true,
			deferUidValidation: true,
		});
	} catch (error) {
		if (error instanceof CalDavICalendarParseError) {
			if (error.code === 'MAX_RESOURCE_SIZE_EXCEEDED') return fail('RESOURCE_LIMIT_EXCEEDED');
			if (error.code === 'METHOD_NOT_ALLOWED') return fail('METHOD_NOT_ALLOWED');
			if (error.code === 'MIXED_COMPONENT_TYPES') return fail('UNSUPPORTED_COMPONENT');
			if (['DUPLICATE_UID', 'MISMATCHED_UID'].includes(error.code)) {
				return fail('INVALID_UID_SET');
			}
		}
		return fail('INVALID_RESOURCE');
	}
}

export function prepareRawCalendarEventWrite(
	input: RawCalendarEventWritePreparationInput,
	uidGenerator: CalendarEventUidGenerator = randomUUID,
): PreparedRawCalendarEventWrite {
	if (
		typeof input !== 'object' ||
		input === null ||
		!['create', 'update', 'upsert'].includes(input.operation) ||
		typeof input.rawIcs !== 'string' ||
		input.rawIcs.length === 0 ||
		!isValidUnicodeScalarSequence(input.rawIcs)
	) {
		return fail('INVALID_INPUT');
	}
	if (UTF8_ENCODER.encode(input.rawIcs).byteLength > ICALENDAR_MAX_RESOURCE_BYTES) {
		return fail('RESOURCE_LIMIT_EXCEEDED');
	}
	const source = input.rawIcs.startsWith('\uFEFF') ? input.rawIcs.slice(1) : input.rawIcs;
	const initial = parseRaw(source);
	if (properties(initial.calendar, 'METHOD').length > 0) return fail('METHOD_NOT_ALLOWED');
	const events = validateResource(initial);
	const classification = classifyUids(events);
	if (classification.kind === 'absent' && input.operation === 'update') return fail('UID_REQUIRED');
	const uid = classification.kind === 'supplied' ? classification.uid : generatedUid(uidGenerator);
	const uidSource: RawCalendarEventUidSource =
		classification.kind === 'supplied' ? 'supplied' : 'generated';
	const serializable = classification.kind === 'supplied' ? initial : withInjectedUid(initial, uid);
	let calendarData: string;
	try {
		calendarData = serializeICalendarResource(serializable);
	} catch (error) {
		if (
			error instanceof CalDavICalendarSerializeError &&
			error.code === CalDavICalendarSerializeErrorCode.RESOURCE_LIMIT_EXCEEDED
		) {
			return fail('RESOURCE_LIMIT_EXCEEDED');
		}
		return fail('INVALID_RESOURCE');
	}
	if (UTF8_ENCODER.encode(calendarData).byteLength > ICALENDAR_MAX_RESOURCE_BYTES) {
		return fail('RESOURCE_LIMIT_EXCEEDED');
	}
	const resource = parseRaw(calendarData);
	const finalEvents = validateResource(resource);
	const finalClassification = classifyUids(finalEvents);
	if (finalClassification.kind !== 'supplied' || finalClassification.uid !== uid) {
		return fail('INVALID_RESOURCE');
	}
	return Object.freeze({ resource, calendarData, uid, uidSource });
}

function sameParameter(left: ICalendarParameter, right: ICalendarParameter): boolean {
	return (
		left.name === right.name &&
		left.values.length === right.values.length &&
		left.values.every((value, index) => value.value === right.values[index]!.value)
	);
}

function sameProperty(left: ICalendarProperty, right: ICalendarProperty): boolean {
	return (
		left.name === right.name &&
		left.parameters.length === right.parameters.length &&
		left.parameters.every((value, index) => sameParameter(value, right.parameters[index]!)) &&
		left.value.valueType === right.value.valueType &&
		(left.value.textValues === null || right.value.textValues === null
			? left.value.textValues === null &&
				right.value.textValues === null &&
				left.value.raw === right.value.raw
			: left.value.textValues.length === right.value.textValues.length &&
				left.value.textValues.every((value, index) => value === right.value.textValues![index]))
	);
}

function sameComponent(left: ICalendarComponent, right: ICalendarComponent): boolean {
	return (
		left.name === right.name &&
		left.entries.length === right.entries.length &&
		left.entries.every((entry, index) => {
			const candidate = right.entries[index]!;
			return (
				entry.kind === candidate.kind &&
				(entry.kind === 'property'
					? sameProperty(entry, candidate as ICalendarProperty)
					: sameComponent(entry, candidate as ICalendarComponent))
			);
		})
	);
}

export function rawCalendarEventResourcesAreSemanticallyEqual(
	left: ICalendarResource,
	right: ICalendarResource,
): boolean {
	return left.kind === right.kind && sameComponent(left.calendar, right.calendar);
}
