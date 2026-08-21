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
const DURATION_PATTERN =
	/^([+-])?P(?:(\d+)W|(?:(\d+)D)?(?:T(?=\d+[HMS])(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?)$/;
const INTEGER_PATTERN = /^[+-]?\d+$/;
const TOKEN_PATTERN = /^[A-Za-z0-9-]+$/;
const ABSOLUTE_URI_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\S*$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_INTEGER = 2_147_483_647;
const MIN_INTEGER = -2_147_483_648;

const KNOWN_PARAMETER_NAMES = new Set([
	'ALTREP',
	'CN',
	'CUTYPE',
	'DELEGATED-FROM',
	'DELEGATED-TO',
	'DIR',
	'ENCODING',
	'FMTTYPE',
	'LANGUAGE',
	'MEMBER',
	'PARTSTAT',
	'RANGE',
	'RELATED',
	'RELTYPE',
	'ROLE',
	'RSVP',
	'SENT-BY',
	'TZID',
	'VALUE',
]);

const KNOWN_PROPERTY_NAMES = new Set([
	'ACTION',
	'ATTACH',
	'ATTENDEE',
	'CALSCALE',
	'CATEGORIES',
	'CLASS',
	'COMMENT',
	'COMPLETED',
	'CONTACT',
	'CREATED',
	'DESCRIPTION',
	'DTEND',
	'DTSTAMP',
	'DTSTART',
	'DUE',
	'DURATION',
	'EXDATE',
	'FREEBUSY',
	'GEO',
	'LAST-MODIFIED',
	'LOCATION',
	'METHOD',
	'ORGANIZER',
	'PERCENT-COMPLETE',
	'PRIORITY',
	'PRODID',
	'RDATE',
	'RECURRENCE-ID',
	'RELATED-TO',
	'REPEAT',
	'REQUEST-STATUS',
	'RESOURCES',
	'RRULE',
	'SEQUENCE',
	'STATUS',
	'SUMMARY',
	'TRANSP',
	'TRIGGER',
	'TZID',
	'TZNAME',
	'TZOFFSETFROM',
	'TZOFFSETTO',
	'TZURL',
	'UID',
	'URL',
	'VERSION',
]);

const EVENT_PROPERTY_NAMES = new Set([
	'ATTACH',
	'ATTENDEE',
	'CATEGORIES',
	'CLASS',
	'COMMENT',
	'CONTACT',
	'CREATED',
	'DESCRIPTION',
	'DTEND',
	'DTSTAMP',
	'DTSTART',
	'DURATION',
	'EXDATE',
	'GEO',
	'LAST-MODIFIED',
	'LOCATION',
	'ORGANIZER',
	'PRIORITY',
	'RDATE',
	'RECURRENCE-ID',
	'RELATED-TO',
	'REQUEST-STATUS',
	'RESOURCES',
	'RRULE',
	'SEQUENCE',
	'STATUS',
	'SUMMARY',
	'TRANSP',
	'UID',
	'URL',
]);

const ALARM_PROPERTY_NAMES = new Set([
	'ACTION',
	'ATTACH',
	'ATTENDEE',
	'DESCRIPTION',
	'DURATION',
	'REPEAT',
	'SUMMARY',
	'TRIGGER',
]);

const TIME_ZONE_PROPERTY_NAMES = new Set(['LAST-MODIFIED', 'TZID', 'TZURL']);
const OBSERVANCE_PROPERTY_NAMES = new Set([
	'COMMENT',
	'DTSTART',
	'RDATE',
	'RRULE',
	'TZNAME',
	'TZOFFSETFROM',
	'TZOFFSETTO',
]);

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

function isValidDate(value: string): boolean {
	const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
	if (match === null) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (year < 1 || month < 1 || month > 12 || day < 1) return false;
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	return day <= days[month - 1]!;
}

function isValidTime(value: string): boolean {
	const match = /^(\d{2})(\d{2})(\d{2})$/.exec(value);
	if (match === null) return false;
	return Number(match[1]) <= 23 && Number(match[2]) <= 59 && Number(match[3]) <= 60;
}

function isValidDateTime(value: string, form: 'local' | 'utc' | 'either' = 'either'): boolean {
	const utc = value.endsWith('Z');
	if ((form === 'utc' && !utc) || (form === 'local' && utc)) return false;
	const source = utc ? value.slice(0, -1) : value;
	return (
		source.length === 15 &&
		source[8] === 'T' &&
		isValidDate(source.slice(0, 8)) &&
		isValidTime(source.slice(9))
	);
}

function isValidDuration(value: string, positiveOnly = false, allowZero = false): boolean {
	const match = DURATION_PATTERN.exec(value);
	if (match === null || (positiveOnly && match[1] === '-')) return false;
	const quantities = match.slice(2).filter((part): part is string => part !== undefined);
	return quantities.length > 0 && (allowZero || quantities.some((part) => /[1-9]/.test(part)));
}

function isValidAbsoluteUri(value: string): boolean {
	if (
		!ABSOLUTE_URI_PATTERN.test(value) ||
		/%(?![0-9A-Fa-f]{2})/.test(value) ||
		[...value].some((character) => {
			const codePoint = character.codePointAt(0)!;
			return codePoint <= 0x20 || codePoint >= 0x7f;
		})
	)
		return false;
	try {
		const parsed = new URL(value);
		return parsed.protocol.length > 1;
	} catch {
		return false;
	}
}

function integerValue(property: ICalendarProperty): number | undefined {
	if (property.value.valueType !== 'INTEGER' || !INTEGER_PATTERN.test(property.value.raw)) {
		return undefined;
	}
	const value = Number(property.value.raw);
	return Number.isSafeInteger(value) && value >= MIN_INTEGER && value <= MAX_INTEGER
		? value
		: undefined;
}

function requireValueType(property: ICalendarProperty, ...types: readonly string[]): void {
	if (!types.includes(property.value.valueType)) return fail('INVALID_RESOURCE');
}

function isExtensionToken(value: string): boolean {
	return TOKEN_PATTERN.test(value);
}

function validateParameterValue(name: string, value: string): void {
	const upper = value.toUpperCase();
	if (value.length === 0) return fail('INVALID_RESOURCE');
	switch (name) {
		case 'ALTREP':
		case 'DIR':
		case 'SENT-BY':
			if (!isValidAbsoluteUri(value)) return fail('INVALID_RESOURCE');
			break;
		case 'CUTYPE':
			if (
				!['INDIVIDUAL', 'GROUP', 'RESOURCE', 'ROOM', 'UNKNOWN'].includes(upper) &&
				!isExtensionToken(value)
			)
				return fail('INVALID_RESOURCE');
			break;
		case 'ENCODING':
			if (upper !== 'BASE64' && upper !== '8BIT') return fail('INVALID_RESOURCE');
			break;
		case 'FMTTYPE':
			if (!/^[^\s/;]+\/[^\s/;]+$/.test(value)) return fail('INVALID_RESOURCE');
			break;
		case 'LANGUAGE':
			if (!/^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value)) return fail('INVALID_RESOURCE');
			break;
		case 'MEMBER':
		case 'DELEGATED-FROM':
		case 'DELEGATED-TO':
			if (!isValidAbsoluteUri(value)) return fail('INVALID_RESOURCE');
			break;
		case 'PARTSTAT':
			if (
				!['NEEDS-ACTION', 'ACCEPTED', 'DECLINED', 'TENTATIVE', 'DELEGATED'].includes(upper) &&
				!isExtensionToken(value)
			)
				return fail('INVALID_RESOURCE');
			break;
		case 'RANGE':
			if (upper !== 'THISANDFUTURE') return fail('INVALID_RESOURCE');
			break;
		case 'RELATED':
			if (!['START', 'END'].includes(upper)) return fail('INVALID_RESOURCE');
			break;
		case 'RELTYPE':
			if (!['PARENT', 'CHILD', 'SIBLING'].includes(upper) && !isExtensionToken(value))
				return fail('INVALID_RESOURCE');
			break;
		case 'ROLE':
			if (
				!['CHAIR', 'REQ-PARTICIPANT', 'OPT-PARTICIPANT', 'NON-PARTICIPANT'].includes(upper) &&
				!isExtensionToken(value)
			)
				return fail('INVALID_RESOURCE');
			break;
		case 'RSVP':
			if (!['TRUE', 'FALSE'].includes(upper)) return fail('INVALID_RESOURCE');
			break;
		case 'TZID':
			if (value.includes(',')) return fail('INVALID_RESOURCE');
			break;
		case 'VALUE':
			if (!TOKEN_PATTERN.test(value)) return fail('INVALID_RESOURCE');
			break;
	}
}

function validateParameters(property: ICalendarProperty, allowedKnown: readonly string[]): void {
	const allowed = new Set(allowedKnown);
	const seen = new Set<string>();
	for (const selected of property.parameters) {
		const name = selected.name.toUpperCase();
		if (seen.has(name) || (KNOWN_PARAMETER_NAMES.has(name) && !allowed.has(name))) {
			return fail('INVALID_RESOURCE');
		}
		seen.add(name);
		if (selected.values.length === 0) return fail('INVALID_RESOURCE');
		for (const value of selected.values) validateParameterValue(name, value.value);
	}
}

function validateTextProperty(
	property: ICalendarProperty,
	allowedParameters: readonly string[] = [],
): void {
	requireValueType(property, 'TEXT');
	validateParameters(property, allowedParameters);
	if (property.value.textValues === null) return fail('INVALID_RESOURCE');
}

function validateUriProperty(property: ICalendarProperty): void {
	requireValueType(property, 'URI');
	validateParameters(property, []);
	if (!isValidAbsoluteUri(property.value.raw)) return fail('INVALID_RESOURCE');
}

function validateCalendarAddressProperty(
	property: ICalendarProperty,
	allowedParameters: readonly string[],
): void {
	requireValueType(property, 'CAL-ADDRESS');
	validateParameters(property, allowedParameters);
	if (
		!isValidAbsoluteUri(property.value.raw) ||
		property.value.raw.indexOf(':') === property.value.raw.length - 1
	)
		return fail('INVALID_RESOURCE');
}

function validateAttachment(property: ICalendarProperty): void {
	validateParameters(property, ['ENCODING', 'FMTTYPE', 'VALUE']);
	if (property.value.valueType === 'URI') {
		if (parameter(property, 'ENCODING').length > 0 || !isValidAbsoluteUri(property.value.raw)) {
			return fail('INVALID_RESOURCE');
		}
		return;
	}
	if (
		property.value.valueType !== 'BINARY' ||
		singleParameterValue(property, 'ENCODING')?.toUpperCase() !== 'BASE64' ||
		!BASE64_PATTERN.test(property.value.raw)
	) {
		return fail('INVALID_RESOURCE');
	}
}

interface RecurrenceContext {
	readonly start: ICalendarProperty;
	readonly timeZoneObservance?: boolean;
}

function validateRecurrenceRule(property: ICalendarProperty, context: RecurrenceContext): void {
	requireValueType(property, 'RECUR');
	validateParameters(property, []);
	const parts = property.value.raw.split(';');
	if (parts.length === 0 || parts.some((part) => part.length === 0))
		return fail('INVALID_RESOURCE');
	const parsed = new Map<string, string>();
	for (const part of parts) {
		const delimiter = part.indexOf('=');
		if (delimiter <= 0 || delimiter === part.length - 1) return fail('INVALID_RESOURCE');
		const name = part.slice(0, delimiter).toUpperCase();
		const value = part.slice(delimiter + 1).toUpperCase();
		if (!TOKEN_PATTERN.test(name) || parsed.has(name)) return fail('INVALID_RESOURCE');
		parsed.set(name, value);
	}
	const frequency = parsed.get('FREQ');
	if (
		frequency === undefined ||
		!['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(
			frequency,
		) ||
		(parsed.has('COUNT') && parsed.has('UNTIL'))
	) {
		return fail('INVALID_RESOURCE');
	}
	const positiveInteger = (name: string): void => {
		const value = parsed.get(name);
		if (
			value !== undefined &&
			(!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > MAX_INTEGER)
		)
			return fail('INVALID_RESOURCE');
	};
	positiveInteger('COUNT');
	positiveInteger('INTERVAL');
	const until = parsed.get('UNTIL');
	if (until !== undefined) {
		if (context.start.value.valueType === 'DATE') {
			if (!isValidDate(until)) return fail('INVALID_RESOURCE');
		} else if (context.start.value.valueType === 'DATE-TIME') {
			const mustBeUtc =
				context.timeZoneObservance === true ||
				context.start.value.raw.endsWith('Z') ||
				parameter(context.start, 'TZID').length > 0;
			if (!isValidDateTime(until, mustBeUtc ? 'utc' : 'local')) {
				return fail('INVALID_RESOURCE');
			}
		} else {
			return fail('INVALID_RESOURCE');
		}
	}
	const numericList = (
		name: string,
		minimum: number,
		maximum: number,
		disallowZero = false,
	): void => {
		const value = parsed.get(name);
		if (value === undefined) return;
		const values = value.split(',');
		if (
			values.length === 0 ||
			values.some((item) => {
				if (!/^[+-]?\d+$/.test(item)) return true;
				const numeric = Number(item);
				return numeric < minimum || numeric > maximum || (disallowZero && numeric === 0);
			})
		)
			return fail('INVALID_RESOURCE');
	};
	numericList('BYSECOND', 0, 60);
	numericList('BYMINUTE', 0, 59);
	numericList('BYHOUR', 0, 23);
	numericList('BYMONTH', 1, 12);
	numericList('BYMONTHDAY', -31, 31, true);
	numericList('BYYEARDAY', -366, 366, true);
	numericList('BYWEEKNO', -53, 53, true);
	numericList('BYSETPOS', -366, 366, true);
	if (
		context.start.value.valueType === 'DATE' &&
		['BYSECOND', 'BYMINUTE', 'BYHOUR'].some((name) => parsed.has(name))
	) {
		return fail('INVALID_RESOURCE');
	}
	const byDay = parsed.get('BYDAY');
	if (
		byDay !== undefined &&
		byDay.split(',').some((item) => {
			const match = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(item);
			if (match === null) return true;
			const ordinal = match[1] === undefined ? undefined : Number(match[1]);
			return ordinal !== undefined && (ordinal === 0 || ordinal < -53 || ordinal > 53);
		})
	) {
		return fail('INVALID_RESOURCE');
	}
	const hasNumericByDay = byDay?.split(',').some((item) => /^[+-]?\d/.test(item)) === true;
	if (
		(parsed.has('BYWEEKNO') && frequency !== 'YEARLY') ||
		(parsed.has('BYYEARDAY') && ['DAILY', 'WEEKLY', 'MONTHLY'].includes(frequency)) ||
		(parsed.has('BYMONTHDAY') && frequency === 'WEEKLY') ||
		(hasNumericByDay && !['MONTHLY', 'YEARLY'].includes(frequency)) ||
		(hasNumericByDay && frequency === 'YEARLY' && parsed.has('BYWEEKNO')) ||
		(parsed.has('BYSETPOS') &&
			![...parsed.keys()].some((name) => name.startsWith('BY') && name !== 'BYSETPOS'))
	) {
		return fail('INVALID_RESOURCE');
	}
	const weekStart = parsed.get('WKST');
	if (weekStart !== undefined && !/^(?:MO|TU|WE|TH|FR|SA|SU)$/.test(weekStart))
		return fail('INVALID_RESOURCE');
}

function rejectKnownPropertiesOutside(
	component: ICalendarComponent,
	allowed: ReadonlySet<string>,
): void {
	for (const entry of component.entries) {
		if (
			entry.kind === 'property' &&
			KNOWN_PROPERTY_NAMES.has(entry.name.toUpperCase()) &&
			!allowed.has(entry.name.toUpperCase())
		) {
			return fail('INVALID_RESOURCE');
		}
	}
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
	const propertyName = property.name.toUpperCase();
	validateParameters(property, [
		'TZID',
		'VALUE',
		...(propertyName === 'RECURRENCE-ID' ? ['RANGE'] : []),
	]);
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
			if (!isValidDate(value) || tzids.length > 0) return fail('INVALID_RESOURCE');
		} else if (valueType === 'DATE-TIME') {
			if (!isValidDateTime(value)) {
				return fail('INVALID_RESOURCE');
			}
			if (value.endsWith('Z') && tzids.length > 0) return fail('INVALID_RESOURCE');
		} else if (propertyName === 'RDATE' && valueType === 'PERIOD') {
			const segments = value.split('/');
			if (segments.length !== 2) return fail('INVALID_RESOURCE');
			const start = segments[0]!;
			const end = segments[1]!;
			const endIsDateTime = isValidDateTime(end);
			if (
				!isValidDateTime(start) ||
				(!endIsDateTime && !isValidDuration(end, true)) ||
				(endIsDateTime && (start.endsWith('Z') !== end.endsWith('Z') || end <= start)) ||
				(start.endsWith('Z') && tzids.length > 0)
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

function validateEventProperty(property: ICalendarProperty, eventStart: ICalendarProperty): void {
	const name = property.name.toUpperCase();
	switch (name) {
		case 'DTSTART':
		case 'DTEND':
		case 'RECURRENCE-ID':
		case 'EXDATE':
		case 'RDATE':
			validateDateProperty(property, ['EXDATE', 'RDATE'].includes(name));
			return;
		case 'DTSTAMP':
		case 'CREATED':
		case 'LAST-MODIFIED':
			requireValueType(property, 'DATE-TIME');
			validateParameters(property, ['VALUE']);
			if (!isValidDateTime(property.value.raw, 'utc')) return fail('INVALID_RESOURCE');
			return;
		case 'DURATION':
			requireValueType(property, 'DURATION');
			validateParameters(property, ['VALUE']);
			if (!isValidDuration(property.value.raw, true)) return fail('INVALID_RESOURCE');
			return;
		case 'RRULE':
			validateRecurrenceRule(property, { start: eventStart });
			return;
		case 'ATTACH':
			validateAttachment(property);
			return;
		case 'ATTENDEE':
			validateCalendarAddressProperty(property, [
				'CN',
				'CUTYPE',
				'DELEGATED-FROM',
				'DELEGATED-TO',
				'DIR',
				'LANGUAGE',
				'MEMBER',
				'PARTSTAT',
				'ROLE',
				'RSVP',
				'SENT-BY',
			]);
			return;
		case 'ORGANIZER':
			validateCalendarAddressProperty(property, ['CN', 'DIR', 'LANGUAGE', 'SENT-BY']);
			return;
		case 'URL':
			validateUriProperty(property);
			return;
		case 'SEQUENCE': {
			validateParameters(property, ['VALUE']);
			const value = integerValue(property);
			if (value === undefined || value < 0) return fail('INVALID_RESOURCE');
			return;
		}
		case 'PRIORITY': {
			validateParameters(property, ['VALUE']);
			const value = integerValue(property);
			if (value === undefined || value < 0 || value > 9) return fail('INVALID_RESOURCE');
			return;
		}
		case 'GEO': {
			requireValueType(property, 'FLOAT');
			validateParameters(property, ['VALUE']);
			const parts = property.value.raw.split(';');
			if (parts.length !== 2 || parts.some((part) => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(part)))
				return fail('INVALID_RESOURCE');
			const latitude = Number(parts[0]);
			const longitude = Number(parts[1]);
			if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180)
				return fail('INVALID_RESOURCE');
			return;
		}
		case 'STATUS': {
			validateTextProperty(property);
			const value = decodedText(property);
			if (
				value === undefined ||
				(!['TENTATIVE', 'CONFIRMED', 'CANCELLED'].includes(value.toUpperCase()) &&
					!isExtensionToken(value))
			)
				return fail('INVALID_RESOURCE');
			return;
		}
		case 'TRANSP': {
			validateTextProperty(property);
			const value = decodedText(property);
			if (
				value === undefined ||
				(!['OPAQUE', 'TRANSPARENT'].includes(value.toUpperCase()) && !isExtensionToken(value))
			)
				return fail('INVALID_RESOURCE');
			return;
		}
		case 'CLASS': {
			validateTextProperty(property);
			const value = decodedText(property);
			if (
				value === undefined ||
				(!['PUBLIC', 'PRIVATE', 'CONFIDENTIAL'].includes(value.toUpperCase()) &&
					!isExtensionToken(value))
			)
				return fail('INVALID_RESOURCE');
			return;
		}
		case 'RELATED-TO':
			validateTextProperty(property, ['RELTYPE']);
			return;
		case 'REQUEST-STATUS':
			validateTextProperty(property, ['LANGUAGE']);
			if (!/^\d+\.\d+(?:\.\d+)?;[^;]+(?:;.*)?$/.test(property.value.raw))
				return fail('INVALID_RESOURCE');
			return;
		case 'CATEGORIES':
		case 'RESOURCES':
			validateTextProperty(property, ['LANGUAGE']);
			return;
		case 'COMMENT':
		case 'CONTACT':
		case 'DESCRIPTION':
		case 'LOCATION':
		case 'SUMMARY':
			validateTextProperty(property, ['ALTREP', 'LANGUAGE']);
			return;
		case 'UID':
		case 'COLOR':
			validateTextProperty(property);
			return;
	}
}

function validateAlarm(alarm: ICalendarComponent): void {
	if (components(alarm).length > 0) return fail('INVALID_RESOURCE');
	rejectKnownPropertiesOutside(alarm, ALARM_PROPERTY_NAMES);
	if (properties(alarm, 'ACTION').length !== 1 || properties(alarm, 'TRIGGER').length !== 1) {
		return fail('INVALID_RESOURCE');
	}
	for (const name of ['REPEAT', 'DURATION'] as const) {
		if (properties(alarm, name).length > 1) return fail('INVALID_RESOURCE');
	}
	if ((properties(alarm, 'REPEAT').length === 0) !== (properties(alarm, 'DURATION').length === 0)) {
		return fail('INVALID_RESOURCE');
	}
	const actionProperty = properties(alarm, 'ACTION')[0]!;
	validateTextProperty(actionProperty);
	const action = decodedText(actionProperty)?.toUpperCase();
	if (action === undefined || !isExtensionToken(action)) return fail('INVALID_RESOURCE');

	const trigger = properties(alarm, 'TRIGGER')[0]!;
	validateParameters(trigger, ['RELATED', 'VALUE']);
	if (trigger.value.valueType === 'DURATION') {
		if (!isValidDuration(trigger.value.raw, false, true)) return fail('INVALID_RESOURCE');
	} else if (
		trigger.value.valueType !== 'DATE-TIME' ||
		!isValidDateTime(trigger.value.raw, 'utc') ||
		parameter(trigger, 'RELATED').length > 0
	) {
		return fail('INVALID_RESOURCE');
	}

	const repeats = properties(alarm, 'REPEAT');
	if (repeats.length === 1) {
		validateParameters(repeats[0]!, ['VALUE']);
		const repeat = integerValue(repeats[0]!);
		if (repeat === undefined || repeat < 1) return fail('INVALID_RESOURCE');
	}
	const durations = properties(alarm, 'DURATION');
	if (durations.length === 1) {
		requireValueType(durations[0]!, 'DURATION');
		validateParameters(durations[0]!, ['VALUE']);
		if (!isValidDuration(durations[0]!.value.raw, true)) return fail('INVALID_RESOURCE');
	}
	if (!['AUDIO', 'DISPLAY', 'EMAIL'].includes(action)) return;
	for (const name of ['DESCRIPTION', 'SUMMARY'] as const) {
		if (properties(alarm, name).length > 1) return fail('INVALID_RESOURCE');
	}

	for (const property of properties(alarm, 'DESCRIPTION'))
		validateTextProperty(property, ['ALTREP', 'LANGUAGE']);
	for (const property of properties(alarm, 'SUMMARY'))
		validateTextProperty(property, ['ALTREP', 'LANGUAGE']);
	for (const property of properties(alarm, 'ATTENDEE'))
		validateCalendarAddressProperty(property, [
			'CN',
			'CUTYPE',
			'DELEGATED-FROM',
			'DELEGATED-TO',
			'DIR',
			'LANGUAGE',
			'MEMBER',
			'PARTSTAT',
			'ROLE',
			'RSVP',
			'SENT-BY',
		]);
	for (const property of properties(alarm, 'ATTACH')) validateAttachment(property);

	const descriptions = properties(alarm, 'DESCRIPTION').length;
	const summaries = properties(alarm, 'SUMMARY').length;
	const attendees = properties(alarm, 'ATTENDEE').length;
	const attachments = properties(alarm, 'ATTACH').length;
	if (
		action === 'DISPLAY' &&
		(descriptions !== 1 || summaries > 0 || attendees > 0 || attachments > 0)
	)
		return fail('INVALID_RESOURCE');
	if (action === 'EMAIL' && (descriptions !== 1 || summaries !== 1 || attendees < 1))
		return fail('INVALID_RESOURCE');
	if (action === 'AUDIO' && (descriptions > 0 || summaries > 0 || attendees > 0 || attachments > 1))
		return fail('INVALID_RESOURCE');
}

function validateEvent(event: ICalendarComponent): void {
	rejectKnownPropertiesOutside(event, EVENT_PROPERTY_NAMES);
	for (const name of EVENT_SINGLETONS) {
		if (properties(event, name).length > 1 && name !== 'UID') return fail('INVALID_RESOURCE');
	}
	if (properties(event, 'DTSTAMP').length !== 1 || properties(event, 'DTSTART').length !== 1) {
		return fail('INVALID_RESOURCE');
	}
	if (properties(event, 'DTEND').length > 0 && properties(event, 'DURATION').length > 0) {
		return fail('INVALID_RESOURCE');
	}
	const start = properties(event, 'DTSTART')[0]!;
	for (const entry of event.entries) {
		if (entry.kind === 'property') validateEventProperty(entry, start);
	}
	const end = properties(event, 'DTEND')[0];
	if (
		end !== undefined &&
		(valueShape(end) !== valueShape(start) || timeZoneForm(end) !== timeZoneForm(start))
	) {
		return fail('INVALID_RESOURCE');
	}
	if (end !== undefined && end.value.raw <= start.value.raw) return fail('INVALID_RESOURCE');
	for (const child of components(event)) {
		if (child.name.toUpperCase() !== 'VALARM') return fail('INVALID_RESOURCE');
		validateAlarm(child);
	}
}

function validateEventSet(events: readonly ICalendarComponent[]): void {
	if (events.length === 0) return fail('INVALID_EVENT_SET');
	const masters = events.filter((event) => properties(event, 'RECURRENCE-ID').length === 0);
	if (masters.length !== 1) return fail('INVALID_EVENT_SET');
	if (
		events.length > 1 &&
		properties(masters[0]!, 'RRULE').length === 0 &&
		properties(masters[0]!, 'RDATE').length === 0
	) {
		return fail('INVALID_EVENT_SET');
	}
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
		rejectKnownPropertiesOutside(definition, TIME_ZONE_PROPERTY_NAMES);
		for (const name of TIME_ZONE_PROPERTY_NAMES) {
			if (properties(definition, name).length > 1) return fail('INVALID_RESOURCE');
		}
		const tzids = properties(definition, 'TZID');
		if (tzids.length === 1) validateTextProperty(tzids[0]!);
		const tzid = tzids.length === 1 ? decodedText(tzids[0]!) : undefined;
		if (tzid === undefined || tzid.length === 0 || identifiers.has(tzid)) {
			return fail('INVALID_RESOURCE');
		}
		identifiers.add(tzid);
		for (const lastModified of properties(definition, 'LAST-MODIFIED')) {
			requireValueType(lastModified, 'DATE-TIME');
			validateParameters(lastModified, ['VALUE']);
			if (!isValidDateTime(lastModified.value.raw, 'utc')) return fail('INVALID_RESOURCE');
		}
		for (const timeZoneUrl of properties(definition, 'TZURL')) validateUriProperty(timeZoneUrl);
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
			if (components(observance).length > 0) return fail('INVALID_RESOURCE');
			rejectKnownPropertiesOutside(observance, OBSERVANCE_PROPERTY_NAMES);
			for (const name of ['DTSTART', 'TZOFFSETFROM', 'TZOFFSETTO', 'RRULE'] as const) {
				if (properties(observance, name).length > 1) return fail('INVALID_RESOURCE');
			}
			if (
				properties(observance, 'DTSTART').length !== 1 ||
				properties(observance, 'TZOFFSETFROM').length !== 1 ||
				properties(observance, 'TZOFFSETTO').length !== 1
			) {
				return fail('INVALID_RESOURCE');
			}
			const start = properties(observance, 'DTSTART')[0]!;
			validateParameters(start, ['VALUE']);
			if (
				start.value.valueType !== 'DATE-TIME' ||
				!isValidDateTime(start.value.raw, 'local') ||
				parameter(start, 'TZID').length > 0
			) {
				return fail('INVALID_RESOURCE');
			}
			for (const name of ['TZOFFSETFROM', 'TZOFFSETTO'] as const) {
				const selected = properties(observance, name);
				if (
					selected.length !== 1 ||
					selected[0]!.value.valueType !== 'UTC-OFFSET' ||
					!UTC_OFFSET_PATTERN.test(selected[0]!.value.raw) ||
					/^-(?:0000|000000)$/.test(selected[0]!.value.raw)
				) {
					return fail('INVALID_RESOURCE');
				}
				validateParameters(selected[0]!, ['VALUE']);
			}
			for (const recurrenceRule of properties(observance, 'RRULE')) {
				validateRecurrenceRule(recurrenceRule, {
					start,
					timeZoneObservance: true,
				});
				if (!/(?:^|;)FREQ=YEARLY(?:;|$)/.test(recurrenceRule.value.raw.toUpperCase()))
					return fail('INVALID_RESOURCE');
			}
			for (const recurrenceDate of properties(observance, 'RDATE')) {
				validateParameters(recurrenceDate, ['VALUE']);
				requireValueType(recurrenceDate, 'DATE-TIME');
				const values = recurrenceDate.value.raw.split(',');
				if (values.length === 0 || values.some((value) => !isValidDateTime(value, 'local')))
					return fail('INVALID_RESOURCE');
			}
			for (const name of ['TZNAME', 'COMMENT'] as const) {
				for (const property of properties(observance, name))
					validateTextProperty(property, ['LANGUAGE']);
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
	rejectKnownPropertiesOutside(calendar, new Set(['VERSION', 'PRODID', 'CALSCALE']));
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
	validateTextProperty(versions[0]!);
	validateTextProperty(prodids[0]!);
	if (calscales.length === 1) validateTextProperty(calscales[0]!);
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
		left.name.toUpperCase() === right.name.toUpperCase() &&
		left.values.length === right.values.length &&
		left.values.every((value, index) => value.value === right.values[index]!.value)
	);
}

function sameProperty(left: ICalendarProperty, right: ICalendarProperty): boolean {
	return (
		left.name.toUpperCase() === right.name.toUpperCase() &&
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
		left.name.toUpperCase() === right.name.toUpperCase() &&
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
