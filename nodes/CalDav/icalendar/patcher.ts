/* eslint-disable @n8n/community-nodes/require-node-api-error -- The accepted protocol-layer contract requires transport-independent typed errors, outside the n8n UI boundary. */

import { createCalendarEventPreservationContext } from './eventReadModel';
import type { CalendarDateString, CalendarEventPreservationContext } from './eventReadModel';
import { parseICalendarResource } from './parser';
import type { CalendarEventInstantProjector } from './serializer';
import { canonicalizeIanaTimeZone, projectInstantInTimeZone } from './timeZones';
import type { CalendarEventTimeZone } from './timeZones';
import type {
	ICalendarComponent,
	ICalendarEntry,
	ICalendarParameter,
	ICalendarProperty,
	ICalendarResource,
} from './parser';

export type SetPatch<T> = {
	readonly kind: 'set';
	readonly value: T;
};

export type OptionalFieldPatch<T> = SetPatch<T> | { readonly kind: 'remove' };

interface CalendarEventPatchCommon {
	readonly summary?: SetPatch<string>;
	readonly description?: OptionalFieldPatch<string>;
	readonly location?: OptionalFieldPatch<string>;
	readonly url?: OptionalFieldPatch<string>;
}

export type CalendarEventPatch = CalendarEventPatchCommon &
	(
		| {
				readonly timeMode: 'timed';
				readonly start?: SetPatch<Date>;
				readonly end?: SetPatch<Date>;
				readonly timeZone?: SetPatch<CalendarEventTimeZone>;
		  }
		| {
				readonly timeMode: 'allDay';
				readonly startDate?: SetPatch<CalendarDateString>;
				readonly endDate?: SetPatch<CalendarDateString>;
		  }
	);

export type CalendarEventPatchField =
	| 'start'
	| 'end'
	| 'startDate'
	| 'endDate'
	| 'timeZone'
	| 'summary'
	| 'description'
	| 'location'
	| 'url';

export const CalendarEventPatchErrorCode = Object.freeze({
	INVALID_INPUT: 'INVALID_INPUT',
	UNKNOWN_PATCH_FIELD: 'UNKNOWN_PATCH_FIELD',
	IMMUTABLE_FIELD: 'IMMUTABLE_FIELD',
	NO_CHANGES: 'NO_CHANGES',
	INVALID_CONTEXT: 'INVALID_CONTEXT',
	AMBIGUOUS_PROPERTY: 'AMBIGUOUS_PROPERTY',
	INVALID_DATE: 'INVALID_DATE',
	INVALID_TIME_RANGE: 'INVALID_TIME_RANGE',
	INVALID_TEXT: 'INVALID_TEXT',
	INVALID_URI: 'INVALID_URI',
	UNSUPPORTED_TIME: 'UNSUPPORTED_TIME',
	INCOMPATIBLE_PARAMETERS: 'INCOMPATIBLE_PARAMETERS',
	INVALID_METADATA: 'INVALID_METADATA',
} as const);

export type CalendarEventPatchErrorCode =
	(typeof CalendarEventPatchErrorCode)[keyof typeof CalendarEventPatchErrorCode];

const ERROR_MESSAGES: Readonly<Record<CalendarEventPatchErrorCode, string>> = {
	INVALID_INPUT: 'The calendar event patch input is invalid.',
	UNKNOWN_PATCH_FIELD: 'The calendar event patch contains an unsupported field.',
	IMMUTABLE_FIELD: 'The calendar event identity cannot be changed.',
	NO_CHANGES: 'The calendar event patch does not contain any changes.',
	INVALID_CONTEXT: 'The calendar event preservation context is invalid.',
	AMBIGUOUS_PROPERTY: 'The calendar event contains an ambiguous property.',
	INVALID_DATE: 'The calendar event patch date is invalid.',
	INVALID_TIME_RANGE: 'The event end must be later than its start.',
	INVALID_TEXT: 'The calendar event patch TEXT value is invalid.',
	INVALID_URI: 'The calendar event patch URI value is invalid.',
	UNSUPPORTED_TIME: 'The calendar event uses an unsupported time representation for this patch.',
	INCOMPATIBLE_PARAMETERS:
		'The calendar event property parameters are incompatible with this patch.',
	INVALID_METADATA: 'The calendar event revision metadata is invalid.',
};

export class CalDavCalendarEventPatchError extends Error {
	readonly code: CalendarEventPatchErrorCode;
	readonly field?: CalendarEventPatchField;

	constructor(code: CalendarEventPatchErrorCode, field?: CalendarEventPatchField) {
		super(ERROR_MESSAGES[code]);
		this.name = 'CalDavCalendarEventPatchError';
		this.code = code;
		if (field !== undefined) this.field = field;
	}
}

type PatchKind = 'set' | 'remove';

interface ValidatedOperation {
	readonly kind: PatchKind;
	readonly text?: string;
	readonly timestamp?: number;
	readonly calendarDate?: CalendarDateString;
	readonly timeZone?: CalendarEventTimeZone;
}

type ValidatedPatch = Partial<Readonly<Record<CalendarEventPatchField, ValidatedOperation>>> & {
	readonly timeMode?: 'timed' | 'allDay';
};

const PATCH_FIELDS = [
	'start',
	'end',
	'startDate',
	'endDate',
	'timeZone',
	'summary',
	'description',
	'location',
	'url',
] as const satisfies readonly CalendarEventPatchField[];
const PATCH_FIELD_SET = new Set<string>(['timeMode', ...PATCH_FIELDS]);
const OPTIONAL_FIELDS = new Set<CalendarEventPatchField>(['description', 'location', 'url']);
const PROPERTY_NAMES: Readonly<Record<CalendarEventPatchField, string>> = {
	start: 'DTSTART',
	end: 'DTEND',
	startDate: 'DTSTART',
	endDate: 'DTEND',
	timeZone: 'DTSTART',
	summary: 'SUMMARY',
	description: 'DESCRIPTION',
	location: 'LOCATION',
	url: 'URL',
};
const CANONICAL_ORDER = [
	'UID',
	'DTSTAMP',
	'LAST-MODIFIED',
	'DTSTART',
	'DTEND',
	'SUMMARY',
	'DESCRIPTION',
	'LOCATION',
	'URL',
] as const;
const CANONICAL_RANK = new Map<string, number>(CANONICAL_ORDER.map((name, index) => [name, index]));
const SINGLETON_NAMES = ['DTSTART', 'DTEND', 'SUMMARY', 'DESCRIPTION', 'LOCATION', 'URL'] as const;
const IMMUTABLE_KEY_FORMS = new Set(['UID', 'RECURRENCEID', 'RECURRENCE-ID']);
const UTC_DATE_TIME_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ICALENDAR_DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})$/;
const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*$/;
const HEX_PATTERN = /^[0-9A-Fa-f]$/;
const PRESERVATION_CONTEXT_PROVENANCE_VERIFIER = '__isCanonicalCalendarEventPreservationContext';
const PARSED_RESOURCE_PROVENANCE_VERIFIER = '__isParserProducedICalendarResource';
const INTERNAL_ERRORS = new WeakSet<object>();

function fail(code: CalendarEventPatchErrorCode, field?: CalendarEventPatchField): never {
	const error = new CalDavCalendarEventPatchError(code, field);
	INTERNAL_ERRORS.add(error);
	throw error;
}

function validateStage<T>(
	callback: () => T,
	unexpectedCode: CalendarEventPatchErrorCode,
	field?: CalendarEventPatchField,
): T {
	try {
		return callback();
	} catch (error) {
		if (typeof error === 'object' && error !== null && INTERNAL_ERRORS.has(error)) throw error;
		return fail(unexpectedCode, field);
	}
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

function isPlainRecordPrototype(value: object): boolean {
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function descriptorsOf(value: object): Readonly<Record<PropertyKey, PropertyDescriptor>> {
	return Object.getOwnPropertyDescriptors(value);
}

function ownDataDescriptor(
	descriptors: Readonly<Record<PropertyKey, PropertyDescriptor>>,
	key: PropertyKey,
): PropertyDescriptor | undefined {
	const descriptor = descriptors[key];
	return descriptor !== undefined && 'value' in descriptor ? descriptor : undefined;
}

function hasOnlyDataProperties(value: object): boolean {
	return Reflect.ownKeys(value).every((key) => {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor !== undefined && 'value' in descriptor;
	});
}

function exactEnumerableRecord(
	value: unknown,
	expectedKeys: readonly string[],
): Readonly<Record<string, PropertyDescriptor>> | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
	if (!isPlainRecordPrototype(value) || Object.getOwnPropertySymbols(value).length > 0)
		return undefined;
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (Object.keys(descriptors).length !== expectedKeys.length) return undefined;
	for (const key of expectedKeys) {
		const descriptor = descriptors[key];
		if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
			return undefined;
		}
	}
	return descriptors;
}

function hasProvenance(owner: object, verifierName: string, value: unknown): boolean {
	const descriptor = Object.getOwnPropertyDescriptor(owner, verifierName);
	return (
		descriptor !== undefined &&
		'value' in descriptor &&
		typeof descriptor.value === 'function' &&
		descriptor.value(value) === true
	);
}

function validateFrozenDataGraph(root: object): boolean {
	const visited = new WeakSet<object>();
	const active = new WeakSet<object>();

	const visit = (value: object): boolean => {
		if (active.has(value)) return false;
		if (visited.has(value)) return true;
		if (!Object.isFrozen(value) || !hasOnlyDataProperties(value)) return false;
		if (!Array.isArray(value) && !isPlainRecordPrototype(value)) return false;
		if (Object.getOwnPropertySymbols(value).length !== 0) return false;

		active.add(value);
		for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
			if (Array.isArray(value) && key === 'length') continue;
			if (!descriptor.enumerable || !('value' in descriptor)) return false;
			if (typeof descriptor.value === 'object' && descriptor.value !== null) {
				if (!visit(descriptor.value)) return false;
			}
		}
		active.delete(value);
		visited.add(value);
		return true;
	};

	return visit(root);
}

function snapshotCanonicalContext(value: unknown): CalendarEventPreservationContext {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('INVALID_CONTEXT');
	if (
		!hasProvenance(
			createCalendarEventPreservationContext,
			PRESERVATION_CONTEXT_PROVENANCE_VERIFIER,
			value,
		)
	) {
		fail('INVALID_CONTEXT');
	}
	let descriptors: Readonly<Record<PropertyKey, PropertyDescriptor>>;
	try {
		descriptors = descriptorsOf(value);
		if (!isPlainRecordPrototype(value) || !Object.isFrozen(value)) fail('INVALID_CONTEXT');
	} catch {
		fail('INVALID_CONTEXT');
	}

	const keys = Object.keys(descriptors);
	if (
		keys.length !== 3 ||
		!['resource', 'master', 'exceptions'].every((key) => {
			const descriptor = ownDataDescriptor(descriptors, key);
			return descriptor !== undefined && descriptor.enumerable;
		}) ||
		Object.getOwnPropertySymbols(value).length !== 0
	) {
		fail('INVALID_CONTEXT');
	}

	if (!validateFrozenDataGraph(value)) fail('INVALID_CONTEXT');
	const resource = ownDataDescriptor(descriptors, 'resource')!.value as ICalendarResource;
	const master = ownDataDescriptor(descriptors, 'master')!.value as ICalendarComponent;
	const exceptions = ownDataDescriptor(descriptors, 'exceptions')!
		.value as readonly ICalendarComponent[];
	if (!hasProvenance(parseICalendarResource, PARSED_RESOURCE_PROVENANCE_VERIFIER, resource)) {
		fail('INVALID_CONTEXT');
	}
	if (!Array.isArray(exceptions)) fail('INVALID_CONTEXT');

	const calendarDescriptors = descriptorsOf(resource.calendar as unknown as object);
	const entries = ownDataDescriptor(calendarDescriptors, 'entries')?.value;
	if (!Array.isArray(entries)) fail('INVALID_CONTEXT');
	const objectComponents = (entries as readonly unknown[]).filter(
		(entry): entry is ICalendarComponent => {
			if (typeof entry !== 'object' || entry === null) return false;
			const entryDescriptors = descriptorsOf(entry);
			return (
				ownDataDescriptor(entryDescriptors, 'kind')?.value === 'component' &&
				asciiUpperCase(String(ownDataDescriptor(entryDescriptors, 'name')?.value)) !== 'VTIMEZONE'
			);
		},
	);
	if (
		objectComponents.some((component) => asciiUpperCase(component.name) !== 'VEVENT') ||
		!objectComponents.includes(master)
	) {
		fail('INVALID_CONTEXT');
	}
	const selectedMaster = objectComponents.filter(
		(component) => directProperties(component, 'RECURRENCE-ID').length === 0,
	);
	const selectedExceptions = objectComponents.filter(
		(component) => directProperties(component, 'RECURRENCE-ID').length === 1,
	);
	if (
		selectedMaster.length !== 1 ||
		selectedMaster[0] !== master ||
		selectedExceptions.length !== exceptions.length ||
		selectedExceptions.some((exception, index) => exception !== exceptions[index])
	) {
		fail('INVALID_CONTEXT');
	}

	return { resource, master, exceptions };
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

function textValue(property: ICalendarProperty): string | undefined {
	return property.value.textValues?.length === 1 ? property.value.textValues[0] : undefined;
}

function validateIdentity(context: CalendarEventPreservationContext): void {
	let uid: string | undefined;
	const recurrenceKeys = new Set<string>();
	for (const [index, event] of [context.master, ...context.exceptions].entries()) {
		const uids = directProperties(event, 'UID');
		if (uids.length !== 1) fail('INVALID_CONTEXT');
		const eventUid = textValue(uids[0]!);
		if (eventUid === undefined || eventUid.length === 0) fail('INVALID_CONTEXT');
		if (uid === undefined) uid = eventUid;
		else if (eventUid !== uid) fail('INVALID_CONTEXT');

		const recurrenceIds = directProperties(event, 'RECURRENCE-ID');
		if ((index === 0 && recurrenceIds.length !== 0) || (index > 0 && recurrenceIds.length !== 1)) {
			fail('INVALID_CONTEXT');
		}
		if (index > 0) {
			const recurrenceId = recurrenceIds[0]!;
			const key = `${recurrenceId.value.valueType}\u0000${recurrenceId.value.raw}\u0000${recurrenceId.parameters
				.filter((parameter) => asciiUpperCase(parameter.name) === 'TZID')
				.flatMap((parameter) => parameter.values.map((value) => value.value))
				.join('\u0000')}`;
			if (recurrenceKeys.has(key)) fail('INVALID_CONTEXT');
			recurrenceKeys.add(key);
		}
	}
}

function validateSingletonsAndMetadata(master: ICalendarComponent): {
	readonly dtstamp: ICalendarProperty;
	readonly lastModified?: ICalendarProperty;
} {
	for (const name of SINGLETON_NAMES) {
		if (directProperties(master, name).length > 1) fail('AMBIGUOUS_PROPERTY');
	}

	const dtstamps = directProperties(master, 'DTSTAMP');
	const lastModified = directProperties(master, 'LAST-MODIFIED');
	if (dtstamps.length > 1 || lastModified.length > 1) fail('AMBIGUOUS_PROPERTY');
	if (dtstamps.length !== 1) fail('INVALID_METADATA');
	if (!isValidRevisionProperty(dtstamps[0]!)) fail('INVALID_METADATA');
	if (lastModified[0] !== undefined && !isValidRevisionProperty(lastModified[0])) {
		fail('INVALID_METADATA');
	}
	return { dtstamp: dtstamps[0]!, ...(lastModified[0] ? { lastModified: lastModified[0] } : {}) };
}

function snapshotPatch(patch: unknown): Readonly<Record<string, unknown>> {
	if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) fail('INVALID_INPUT');
	if (!isPlainRecordPrototype(patch)) fail('INVALID_INPUT');
	const descriptors = Object.getOwnPropertyDescriptors(patch);
	if (Object.getOwnPropertySymbols(patch).length > 0) fail('INVALID_INPUT');
	const keys = Object.keys(descriptors);
	if (keys.length === 0) fail('NO_CHANGES');
	for (const descriptor of Object.values(descriptors)) {
		if (!descriptor.enumerable || !('value' in descriptor)) fail('INVALID_INPUT');
	}

	for (const key of keys) {
		const normalized = asciiUpperCase(key).replace(/[_ ]/g, '');
		if (IMMUTABLE_KEY_FORMS.has(normalized)) fail('IMMUTABLE_FIELD');
	}
	for (const key of keys) {
		if (!PATCH_FIELD_SET.has(key)) fail('UNKNOWN_PATCH_FIELD');
	}

	const snapshot: Record<string, unknown> = {};
	for (const key of keys) {
		snapshot[key] = descriptors[key]!.value;
	}
	return Object.freeze(snapshot);
}

function dateTimestamp(value: unknown, field?: CalendarEventPatchField): number {
	if (!(value instanceof Date)) fail('INVALID_DATE', field);
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

function isValidUnicodeScalarSequence(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			index += 1;
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
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

function validatePatchOperations(snapshot: Readonly<Record<string, unknown>>): ValidatedPatch {
	const validated: Partial<Record<CalendarEventPatchField, ValidatedOperation>> = {};
	const timeMode = snapshot.timeMode;
	if (timeMode !== undefined && timeMode !== 'timed' && timeMode !== 'allDay') {
		fail('INVALID_INPUT');
	}
	for (const field of PATCH_FIELDS) {
		if (!Object.prototype.hasOwnProperty.call(snapshot, field)) continue;
		const operationValue = snapshot[field];
		const setDescriptors = exactEnumerableRecord(operationValue, ['kind', 'value']);
		const removeDescriptors = exactEnumerableRecord(operationValue, ['kind']);
		let operation: { readonly kind: PatchKind; readonly value?: unknown };
		if (setDescriptors !== undefined && setDescriptors.kind!.value === 'set') {
			operation = { kind: 'set', value: setDescriptors.value!.value };
		} else if (removeDescriptors !== undefined && removeDescriptors.kind!.value === 'remove') {
			operation = { kind: 'remove' };
		} else {
			fail('INVALID_INPUT', field);
		}
		if (operation.kind === 'remove') {
			if (!OPTIONAL_FIELDS.has(field)) fail('INVALID_INPUT', field);
			validated[field] = { kind: 'remove' };
			continue;
		}

		if (field === 'start' || field === 'end') {
			validated[field] = { kind: 'set', timestamp: dateTimestamp(operation.value, field) };
		} else if (field === 'startDate' || field === 'endDate') {
			validated[field] = { kind: 'set', calendarDate: calendarDateValue(operation.value, field) };
		} else if (field === 'timeZone') {
			const descriptors = exactEnumerableRecord(operation.value, ['timeZoneMode']);
			const ianaDescriptors = exactEnumerableRecord(operation.value, ['timeZoneMode', 'timeZone']);
			if (descriptors?.timeZoneMode?.value === 'utc') {
				validated[field] = { kind: 'set', timeZone: { timeZoneMode: 'utc' } };
			} else if (
				ianaDescriptors?.timeZoneMode?.value === 'iana' &&
				typeof ianaDescriptors.timeZone?.value === 'string'
			) {
				validated[field] = {
					kind: 'set',
					timeZone: {
						timeZoneMode: 'iana',
						timeZone: canonicalizeIanaTimeZone(ianaDescriptors.timeZone.value),
					},
				};
			} else {
				fail('INVALID_INPUT', field);
			}
		} else {
			if (typeof operation.value !== 'string') fail('INVALID_INPUT', field);
			if (field === 'url') {
				if (!isAbsoluteUri(operation.value)) fail('INVALID_URI', field);
			} else if (!isValidText(operation.value)) fail('INVALID_TEXT', field);
			validated[field] = { kind: 'set', text: operation.value };
		}
	}
	return { ...validated, ...(timeMode === undefined ? {} : { timeMode }) };
}

function isUnreserved(character: string): boolean {
	return /^[A-Za-z0-9._~-]$/.test(character);
}

function isSubDelimiter(character: string): boolean {
	return "!$&'()*+,;=".includes(character);
}

function scanUriCharacters(
	value: string,
	allowsCharacter: (character: string) => boolean,
): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index]!;
		if (character === '%') {
			if (
				index + 2 >= value.length ||
				!HEX_PATTERN.test(value[index + 1]!) ||
				!HEX_PATTERN.test(value[index + 2]!)
			) {
				return false;
			}
			index += 2;
			continue;
		}
		if (character.charCodeAt(0) > 0x7f || !allowsCharacter(character)) return false;
	}
	return true;
}

function isPchar(character: string): boolean {
	return (
		isUnreserved(character) || isSubDelimiter(character) || character === ':' || character === '@'
	);
}

function isValidIpv4(value: string): boolean {
	const parts = value.split('.');
	return (
		parts.length === 4 &&
		parts.every((part) => {
			if (!/^\d{1,3}$/.test(part) || (part.length > 1 && part.startsWith('0'))) return false;
			const octet = Number(part);
			return octet >= 0 && octet <= 255;
		})
	);
}

function ipv6GroupCount(groups: readonly string[]): number | undefined {
	let count = 0;
	for (let index = 0; index < groups.length; index += 1) {
		const group = groups[index]!;
		if (group.includes('.')) {
			if (index !== groups.length - 1 || !isValidIpv4(group)) return undefined;
			count += 2;
		} else {
			if (!/^[0-9A-Fa-f]{1,4}$/.test(group)) return undefined;
			count += 1;
		}
	}
	return count;
}

function isValidIpv6(value: string): boolean {
	const compressionIndex = value.indexOf('::');
	if (compressionIndex !== value.lastIndexOf('::')) return false;
	if (compressionIndex === -1) return ipv6GroupCount(value.split(':')) === 8;
	const left = value.slice(0, compressionIndex);
	const right = value.slice(compressionIndex + 2);
	const leftCount = ipv6GroupCount(left === '' ? [] : left.split(':'));
	const rightCount = ipv6GroupCount(right === '' ? [] : right.split(':'));
	return leftCount !== undefined && rightCount !== undefined && leftCount + rightCount < 8;
}

function isValidIpLiteral(value: string): boolean {
	if (value.startsWith('v') || value.startsWith('V')) {
		const dotIndex = value.indexOf('.');
		if (dotIndex < 2 || !/^[0-9A-Fa-f]+$/.test(value.slice(1, dotIndex))) return false;
		const address = value.slice(dotIndex + 1);
		return (
			address.length > 0 &&
			[...address].every(
				(character) => isUnreserved(character) || isSubDelimiter(character) || character === ':',
			)
		);
	}
	return isValidIpv6(value);
}

function isValidAuthority(authority: string): boolean {
	const firstAt = authority.indexOf('@');
	if (firstAt !== authority.lastIndexOf('@')) return false;
	let hostAndPort = authority;
	if (firstAt >= 0) {
		const userInfo = authority.slice(0, firstAt);
		if (
			!scanUriCharacters(
				userInfo,
				(character) => isUnreserved(character) || isSubDelimiter(character) || character === ':',
			)
		) {
			return false;
		}
		hostAndPort = authority.slice(firstAt + 1);
	}
	if (hostAndPort.startsWith('[')) {
		const closingIndex = hostAndPort.indexOf(']');
		if (closingIndex < 0 || !isValidIpLiteral(hostAndPort.slice(1, closingIndex))) return false;
		const suffix = hostAndPort.slice(closingIndex + 1);
		return suffix === '' || (suffix.startsWith(':') && /^\d*$/.test(suffix.slice(1)));
	}
	const colonIndex = hostAndPort.lastIndexOf(':');
	let host = hostAndPort;
	if (colonIndex >= 0) {
		if (!/^\d*$/.test(hostAndPort.slice(colonIndex + 1))) return false;
		host = hostAndPort.slice(0, colonIndex);
	}
	return scanUriCharacters(
		host,
		(character) => isUnreserved(character) || isSubDelimiter(character),
	);
}

function isAbsoluteUri(value: string): boolean {
	if (value.length === 0 || value.includes('#')) return false;
	const colonIndex = value.indexOf(':');
	if (colonIndex <= 0 || !SCHEME_PATTERN.test(value.slice(0, colonIndex))) return false;
	const afterScheme = value.slice(colonIndex + 1);
	const queryIndex = afterScheme.indexOf('?');
	const hierarchy = queryIndex < 0 ? afterScheme : afterScheme.slice(0, queryIndex);
	const query = queryIndex < 0 ? undefined : afterScheme.slice(queryIndex + 1);
	if (
		query !== undefined &&
		!scanUriCharacters(
			query,
			(character) => isPchar(character) || character === '/' || character === '?',
		)
	) {
		return false;
	}
	let path = hierarchy;
	if (hierarchy.startsWith('//')) {
		const slashIndex = hierarchy.indexOf('/', 2);
		const authority = slashIndex < 0 ? hierarchy.slice(2) : hierarchy.slice(2, slashIndex);
		if (!isValidAuthority(authority)) return false;
		path = slashIndex < 0 ? '' : hierarchy.slice(slashIndex);
	}
	return scanUriCharacters(path, (character) => isPchar(character) || character === '/');
}

function matchingParameters(
	property: ICalendarProperty,
	name: string,
): readonly ICalendarParameter[] {
	const expected = asciiUpperCase(name);
	return property.parameters.filter((parameter) => asciiUpperCase(parameter.name) === expected);
}

function effectiveValueParameter(property: ICalendarProperty): string | undefined {
	const valueParameters = matchingParameters(property, 'VALUE');
	if (valueParameters.length === 0) return undefined;
	if (valueParameters.length !== 1 || valueParameters[0]!.values.length !== 1) return '';
	const value = valueParameters[0]!.values[0]!.value;
	return value.length === 0 ? '' : asciiUpperCase(value);
}

function parametersAreCompatible(
	property: ICalendarProperty,
	field: CalendarEventPatchField,
): boolean {
	const valueParameters = matchingParameters(property, 'VALUE');
	if (
		valueParameters.length > 1 ||
		(valueParameters[0] !== undefined &&
			(valueParameters[0].values.length !== 1 || valueParameters[0].values[0]!.value.length === 0))
	) {
		return false;
	}
	const tzidParameters = matchingParameters(property, 'TZID');
	if (
		tzidParameters.length > 1 ||
		(tzidParameters[0] !== undefined &&
			(tzidParameters[0].values.length !== 1 || tzidParameters[0].values[0]!.value.length === 0))
	) {
		return false;
	}
	if (tzidParameters.length !== 0) return false;

	const expected =
		field === 'url'
			? 'URI'
			: field === 'start' || field === 'end'
				? 'DATE-TIME'
				: field === 'startDate' || field === 'endDate'
					? 'DATE'
					: 'TEXT';
	const explicit = effectiveValueParameter(property);
	return explicit === undefined
		? asciiUpperCase(property.value.valueType) === expected
		: explicit === expected;
}

function validateTouchedParameters(master: ICalendarComponent, patch: ValidatedPatch): void {
	for (const field of PATCH_FIELDS) {
		if (field === 'timeZone') continue;
		if (patch.timeZone?.kind === 'set' && (field === 'start' || field === 'end')) continue;
		if (patch[field]?.kind !== 'set') continue;
		if (field === 'start' || field === 'end' || field === 'startDate' || field === 'endDate') {
			continue;
		}
		const property = directProperties(master, PROPERTY_NAMES[field])[0];
		if (property !== undefined && !parametersAreCompatible(property, field)) {
			fail('INCOMPATIBLE_PARAMETERS', field);
		}
	}
}

function isLeapYear(year: number): boolean {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
	if (month === 2) return isLeapYear(year) ? 29 : 28;
	if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
	return 31;
}

function calendarDateValue(value: unknown, field: 'startDate' | 'endDate'): CalendarDateString {
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
	return value as CalendarDateString;
}

function calendarDateKey(raw: string): string | undefined {
	const match = ICALENDAR_DATE_PATTERN.exec(raw);
	if (match === null) return undefined;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	return year >= 1 &&
		year <= 9999 &&
		month >= 1 &&
		month <= 12 &&
		day >= 1 &&
		day <= daysInMonth(year, month)
		? raw
		: undefined;
}

function utcDateTimeKey(raw: string): string | undefined {
	const match = UTC_DATE_TIME_PATTERN.exec(raw);
	if (match === null) return undefined;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (
		year < 1 ||
		year > 9999 ||
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > daysInMonth(year, month) ||
		Number(match[4]) > 23 ||
		Number(match[5]) > 59 ||
		Number(match[6]) > 60
	) {
		return undefined;
	}
	return raw.slice(0, -1).replace('T', '');
}

function isValidRevisionProperty(property: ICalendarProperty): boolean {
	return (
		asciiUpperCase(property.value.valueType) === 'DATE-TIME' &&
		property.value.textValues === null &&
		utcDateTimeKey(property.value.raw) !== undefined &&
		matchingParameters(property, 'VALUE').length === 0 &&
		matchingParameters(property, 'TZID').length === 0
	);
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

type EditableTimeMode = 'timed' | 'allDay';

interface TimePatchPlan {
	readonly remoteMode: EditableTimeMode;
	readonly targetMode: EditableTimeMode;
	readonly conversion: boolean;
	readonly touchesTime: boolean;
}

function timePropertyMode(property: ICalendarProperty): EditableTimeMode | undefined {
	if (property.value.textValues !== null) return undefined;
	const type = asciiUpperCase(property.value.valueType);
	if (
		type === 'DATE-TIME' &&
		utcDateTimeKey(property.value.raw) !== undefined &&
		parametersAreCompatible(property, 'start')
	) {
		return 'timed';
	}
	if (
		type === 'DATE' &&
		calendarDateKey(property.value.raw) !== undefined &&
		parametersAreCompatible(property, 'startDate')
	) {
		return 'allDay';
	}
	return undefined;
}

function safeUtcTimeProperty(property: ICalendarProperty): boolean {
	return timePropertyMode(property) === 'timed';
}

function conversionParametersAreSafe(property: ICalendarProperty): boolean {
	return property.parameters.every((parameter) => asciiUpperCase(parameter.name) === 'VALUE');
}

function planTimePatch(
	context: CalendarEventPreservationContext,
	patch: ValidatedPatch,
): TimePatchPlan {
	const hasTimedStart = patch.start?.kind === 'set';
	const hasTimedEnd = patch.end?.kind === 'set';
	const hasDateStart = patch.startDate?.kind === 'set';
	const hasDateEnd = patch.endDate?.kind === 'set';
	const hasTimeZone = patch.timeZone?.kind === 'set';
	const hasTimed = hasTimedStart || hasTimedEnd;
	const hasAllDay = hasDateStart || hasDateEnd;
	if ((hasTimed && hasAllDay) || (hasTimeZone && (hasAllDay || patch.timeMode === 'allDay'))) {
		fail('INVALID_INPUT');
	}
	if (!hasTimed && !hasAllDay && !hasTimeZone && patch.timeMode === undefined) {
		return {
			remoteMode: 'timed',
			targetMode: 'timed',
			conversion: false,
			touchesTime: false,
		};
	}
	const failureField: CalendarEventPatchField = hasTimeZone
		? 'timeZone'
		: hasTimed
			? hasTimedStart
				? 'start'
				: 'end'
			: hasDateStart
				? 'startDate'
				: 'endDate';
	const master = context.master;
	const starts = directProperties(master, 'DTSTART');
	const ends = directProperties(master, 'DTEND');
	if (
		starts.length !== 1 ||
		ends.length !== 1 ||
		directProperties(master, 'DURATION').length !== 0
	) {
		fail('UNSUPPORTED_TIME', failureField);
	}
	if (hasTimeZone) {
		if (
			directProperties(master, 'RRULE').length !== 0 ||
			directProperties(master, 'RDATE').length !== 0 ||
			directProperties(master, 'EXDATE').length !== 0 ||
			context.exceptions.length !== 0 ||
			((!hasTimedStart || !hasTimedEnd) &&
				(!safeUtcTimeProperty(starts[0]!) || !safeUtcTimeProperty(ends[0]!)))
		) {
			fail('UNSUPPORTED_TIME', failureField);
		}
		const startKey = hasTimedStart
			? utcDateTimeKey(formatUtcDateTime(patch.start!.timestamp!))
			: utcDateTimeKey(starts[0]!.value.raw);
		const endKey = hasTimedEnd
			? utcDateTimeKey(formatUtcDateTime(patch.end!.timestamp!))
			: utcDateTimeKey(ends[0]!.value.raw);
		if (startKey === undefined || endKey === undefined) fail('UNSUPPORTED_TIME', failureField);
		if (endKey <= startKey) fail('INVALID_TIME_RANGE');
		return { remoteMode: 'timed', targetMode: 'timed', conversion: false, touchesTime: true };
	}
	const startMode = timePropertyMode(starts[0]!);
	const endMode = timePropertyMode(ends[0]!);
	if (startMode === undefined || startMode !== endMode) fail('UNSUPPORTED_TIME', failureField);
	const remoteMode = startMode;
	const targetMode = patch.timeMode ?? (hasTimed ? 'timed' : hasAllDay ? 'allDay' : remoteMode);
	if ((targetMode === 'timed' && hasAllDay) || (targetMode === 'allDay' && hasTimed)) {
		fail('INVALID_INPUT');
	}
	const conversion = targetMode !== remoteMode;
	const touchesTime = hasTimed || hasAllDay || conversion;
	if (conversion) {
		if (
			(targetMode === 'timed' && (!hasTimedStart || !hasTimedEnd)) ||
			(targetMode === 'allDay' && (!hasDateStart || !hasDateEnd))
		) {
			fail('INVALID_INPUT', targetMode === 'timed' ? 'end' : 'endDate');
		}
		if (!conversionParametersAreSafe(starts[0]!) || !conversionParametersAreSafe(ends[0]!)) {
			fail('INCOMPATIBLE_PARAMETERS', targetMode === 'timed' ? 'start' : 'startDate');
		}
	}
	if (
		touchesTime &&
		(directProperties(master, 'RRULE').length !== 0 ||
			directProperties(master, 'RDATE').length !== 0 ||
			directProperties(master, 'EXDATE').length !== 0 ||
			context.exceptions.length !== 0)
	) {
		fail('UNSUPPORTED_TIME', failureField);
	}

	if (targetMode === 'timed') {
		const startKey = hasTimedStart
			? utcDateTimeKey(formatUtcDateTime(patch.start!.timestamp!))
			: remoteMode === 'timed'
				? utcDateTimeKey(starts[0]!.value.raw)
				: undefined;
		const endKey = hasTimedEnd
			? utcDateTimeKey(formatUtcDateTime(patch.end!.timestamp!))
			: remoteMode === 'timed'
				? utcDateTimeKey(ends[0]!.value.raw)
				: undefined;
		if (startKey === undefined || endKey === undefined) fail('UNSUPPORTED_TIME', failureField);
		if (endKey <= startKey) fail('INVALID_TIME_RANGE');
	} else {
		const startKey = hasDateStart
			? patch.startDate!.calendarDate!.split('-').join('')
			: remoteMode === 'allDay'
				? calendarDateKey(starts[0]!.value.raw)
				: undefined;
		const endKey = hasDateEnd
			? patch.endDate!.calendarDate!.split('-').join('')
			: remoteMode === 'allDay'
				? calendarDateKey(ends[0]!.value.raw)
				: undefined;
		if (startKey === undefined || endKey === undefined) fail('UNSUPPORTED_TIME', failureField);
		if (endKey <= startKey) fail('INVALID_TIME_RANGE');
	}

	return { remoteMode, targetMode, conversion, touchesTime };
}

function operationChanges(
	master: ICalendarComponent,
	field: CalendarEventPatchField,
	operation: ValidatedOperation,
): boolean {
	if (field === 'timeZone') {
		const starts = directProperties(master, 'DTSTART');
		const ends = directProperties(master, 'DTEND');
		if (starts.length !== 1 || ends.length !== 1) return true;
		const selected = operation.timeZone!;
		if (selected.timeZoneMode === 'utc') {
			return !starts[0]!.value.raw.endsWith('Z') || !ends[0]!.value.raw.endsWith('Z');
		}
		const startTzid = matchingParameters(starts[0]!, 'TZID');
		const endTzid = matchingParameters(ends[0]!, 'TZID');
		if (
			startTzid.length !== 1 ||
			endTzid.length !== 1 ||
			startTzid[0]!.values.length !== 1 ||
			endTzid[0]!.values.length !== 1
		) {
			return true;
		}
		try {
			return (
				canonicalizeIanaTimeZone(startTzid[0]!.values[0]!.value) !== selected.timeZone ||
				canonicalizeIanaTimeZone(endTzid[0]!.values[0]!.value) !== selected.timeZone
			);
		} catch {
			return true;
		}
	}
	const property = directProperties(master, PROPERTY_NAMES[field])[0];
	if (operation.kind === 'remove') return property !== undefined;
	if (property === undefined) return true;
	if (field === 'start' || field === 'end') {
		return (
			utcDateTimeKey(property.value.raw) !== utcDateTimeKey(formatUtcDateTime(operation.timestamp!))
		);
	}
	if (field === 'startDate' || field === 'endDate') {
		return calendarDateKey(property.value.raw) !== operation.calendarDate!.split('-').join('');
	}
	if (field === 'url') return property.value.raw !== operation.text;
	return property.value.textValues?.length !== 1 || property.value.textValues[0] !== operation.text;
}

function freezeProperty(property: ICalendarProperty): ICalendarProperty {
	for (const parameter of property.parameters) {
		for (const value of parameter.values) Object.freeze(value);
		Object.freeze(parameter.values);
		Object.freeze(parameter);
	}
	Object.freeze(property.parameters);
	if (property.value.textValues !== null) Object.freeze(property.value.textValues);
	Object.freeze(property.value);
	return Object.freeze(property);
}

function replacementProperty(
	existing: ICalendarProperty | undefined,
	name: string,
	field: CalendarEventPatchField | 'metadata',
	value: string,
	timePlan?: TimePatchPlan,
): ICalendarProperty {
	const isTimed = field === 'start' || field === 'end';
	const isAllDay = field === 'startDate' || field === 'endDate';
	const isText = field !== 'metadata' && !isTimed && !isAllDay && field !== 'url';
	const parameters: readonly ICalendarParameter[] =
		isAllDay && timePlan?.conversion === true
			? Object.freeze([
					{
						kind: 'parameter' as const,
						name: 'VALUE',
						values: [
							{
								kind: 'parameterValue' as const,
								raw: 'DATE',
								value: 'DATE',
								quoted: false,
							},
						],
					},
				])
			: isTimed && timePlan?.conversion === true
				? Object.freeze([])
				: (existing?.parameters ?? Object.freeze([]));
	return freezeProperty({
		kind: 'property',
		name: existing?.name ?? name,
		parameters,
		value: {
			kind: 'value',
			valueType: isText ? 'TEXT' : field === 'url' ? 'URI' : isAllDay ? 'DATE' : 'DATE-TIME',
			raw: isText ? '' : value,
			textValues: isText ? [value] : null,
		},
	});
}

function insertCanonical(entries: ICalendarEntry[], property: ICalendarProperty): void {
	const targetRank = CANONICAL_RANK.get(asciiUpperCase(property.name))!;
	let predecessorIndex = -1;
	let successorIndex = -1;
	let firstComponentIndex = entries.length;
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index]!;
		if (entry.kind === 'component') {
			firstComponentIndex = Math.min(firstComponentIndex, index);
			continue;
		}
		const rank = CANONICAL_RANK.get(asciiUpperCase(entry.name));
		if (rank === undefined) continue;
		if (rank < targetRank) predecessorIndex = index;
		else if (rank > targetRank && successorIndex < 0) successorIndex = index;
	}
	const index =
		predecessorIndex >= 0
			? predecessorIndex + 1
			: successorIndex >= 0
				? successorIndex
				: firstComponentIndex;
	entries.splice(index, 0, property);
}

function applyFieldOperation(
	entries: ICalendarEntry[],
	field: CalendarEventPatchField,
	operation: ValidatedOperation,
	timePlan: TimePatchPlan,
	clearTimeParameters = false,
): void {
	const name = PROPERTY_NAMES[field];
	const index = entries.findIndex(
		(entry) => entry.kind === 'property' && asciiUpperCase(entry.name) === name,
	);
	if (operation.kind === 'remove') {
		if (index >= 0) entries.splice(index, 1);
		return;
	}
	const existing = index >= 0 ? (entries[index] as ICalendarProperty) : undefined;
	const value =
		field === 'start' || field === 'end'
			? formatUtcDateTime(operation.timestamp!)
			: field === 'startDate' || field === 'endDate'
				? operation.calendarDate!.split('-').join('')
				: operation.text!;
	let replacement = replacementProperty(existing, name, field, value, timePlan);
	if (clearTimeParameters && (field === 'start' || field === 'end')) {
		replacement = freezeProperty({ ...replacement, parameters: [] });
	}
	if (index >= 0) entries[index] = replacement;
	else insertCanonical(entries, replacement);
}

function applyTimeZoneOperation(
	entries: ICalendarEntry[],
	operation: ValidatedOperation,
	projectInstant: CalendarEventInstantProjector,
	renderedTimeZone?: string,
): void {
	const selected = operation.timeZone!;
	if (selected.timeZoneMode === 'utc') return;
	const outputTimeZone = renderedTimeZone ?? selected.timeZone;
	for (const name of ['DTSTART', 'DTEND'] as const) {
		const index = entries.findIndex(
			(entry) => entry.kind === 'property' && asciiUpperCase(entry.name) === name,
		);
		if (index < 0) fail('UNSUPPORTED_TIME', 'timeZone');
		const existing = entries[index] as ICalendarProperty;
		const raw = existing.value.raw;
		const match = UTC_DATE_TIME_PATTERN.exec(raw);
		if (match === null) fail('UNSUPPORTED_TIME', 'timeZone');
		const instant = new Date(
			`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`,
		);
		const local = projectInstant(instant, selected.timeZone).replace(/[-:]/g, '');
		entries[index] = freezeProperty({
			kind: 'property',
			name: existing.name,
			parameters: [
				{
					kind: 'parameter',
					name: 'TZID',
					values: [
						{
							kind: 'parameterValue',
							raw: outputTimeZone,
							value: outputTimeZone,
							quoted: false,
						},
					],
				},
			],
			value: { kind: 'value', valueType: 'DATE-TIME', raw: local, textValues: null },
		});
	}
}

function applyMetadata(
	entries: ICalendarEntry[],
	metadata: { readonly dtstamp: ICalendarProperty; readonly lastModified?: ICalendarProperty },
	modifiedAt: number,
): void {
	const raw = formatUtcDateTime(modifiedAt);
	const dtstampIndex = entries.indexOf(metadata.dtstamp);
	entries[dtstampIndex] = replacementProperty(metadata.dtstamp, 'DTSTAMP', 'metadata', raw);
	if (metadata.lastModified !== undefined) {
		const lastModifiedIndex = entries.indexOf(metadata.lastModified);
		entries[lastModifiedIndex] = replacementProperty(
			metadata.lastModified,
			'LAST-MODIFIED',
			'metadata',
			raw,
		);
	} else {
		entries.splice(
			dtstampIndex + 1,
			0,
			replacementProperty(undefined, 'LAST-MODIFIED', 'metadata', raw),
		);
	}
}

function propertyTimeZoneId(property: ICalendarProperty): string | undefined {
	const parameters = matchingParameters(property, 'TZID');
	return parameters.length === 1 && parameters[0]!.values.length === 1
		? parameters[0]!.values[0]!.value
		: undefined;
}

function componentTimeZoneId(component: ICalendarComponent): string | undefined {
	const identifiers = directProperties(component, 'TZID');
	return identifiers.length === 1 && identifiers[0]!.value.textValues?.length === 1
		? identifiers[0]!.value.textValues[0]
		: undefined;
}

function masterTimeZoneId(component: ICalendarComponent): string | undefined {
	const starts = directProperties(component, 'DTSTART');
	const ends = directProperties(component, 'DTEND');
	if (starts.length !== 1 || ends.length !== 1) return undefined;
	const start = propertyTimeZoneId(starts[0]!);
	const end = propertyTimeZoneId(ends[0]!);
	return start !== undefined && start === end ? start : undefined;
}

function entryReferencesTimeZone(entry: ICalendarEntry, timeZoneId: string): boolean {
	if (entry.kind === 'property') return propertyTimeZoneId(entry) === timeZoneId;
	return entry.entries.some((child) => entryReferencesTimeZone(child, timeZoneId));
}

function reconcileTimeZoneDefinitions(
	context: CalendarEventPreservationContext,
	master: ICalendarComponent,
	timeZoneDefinition?: ICalendarComponent,
): readonly ICalendarEntry[] {
	const oldTimeZoneId = masterTimeZoneId(context.master);
	const newTimeZoneId = masterTimeZoneId(master);
	let calendarEntries = context.resource.calendar.entries.map((entry) =>
		entry === context.master ? master : entry,
	);
	if (oldTimeZoneId !== undefined && oldTimeZoneId !== newTimeZoneId) {
		const retainedReference = calendarEntries.some(
			(entry) =>
				!(entry.kind === 'component' && asciiUpperCase(entry.name) === 'VTIMEZONE') &&
				entryReferencesTimeZone(entry, oldTimeZoneId),
		);
		if (!retainedReference) {
			calendarEntries = calendarEntries.filter(
				(entry) =>
					!(
						entry.kind === 'component' &&
						asciiUpperCase(entry.name) === 'VTIMEZONE' &&
						componentTimeZoneId(entry) === oldTimeZoneId
					),
			);
		}
	}
	if (timeZoneDefinition !== undefined && newTimeZoneId !== undefined) {
		const target = canonicalizeIanaTimeZone(newTimeZoneId);
		const alreadyPresent = calendarEntries.some((entry) => {
			if (entry.kind !== 'component' || asciiUpperCase(entry.name) !== 'VTIMEZONE') return false;
			const identifier = componentTimeZoneId(entry);
			if (identifier === undefined) return false;
			try {
				return canonicalizeIanaTimeZone(identifier) === target;
			} catch {
				return false;
			}
		});
		if (!alreadyPresent) {
			const masterIndex = calendarEntries.indexOf(master);
			calendarEntries.splice(
				masterIndex < 0 ? calendarEntries.length : masterIndex,
				0,
				timeZoneDefinition,
			);
		}
	}
	return calendarEntries;
}

function constructResource(
	context: CalendarEventPreservationContext,
	patch: ValidatedPatch,
	metadata: { readonly dtstamp: ICalendarProperty; readonly lastModified?: ICalendarProperty },
	modifiedAt: number,
	timePlan: TimePatchPlan,
	projectInstant: CalendarEventInstantProjector,
	renderedTimeZone?: string,
	timeZoneDefinition?: ICalendarComponent,
): ICalendarResource {
	const masterEntries = [...context.master.entries];
	for (const field of PATCH_FIELDS) {
		const operation = patch[field];
		if (field === 'timeZone') continue;
		if (operation !== undefined && operationChanges(context.master, field, operation)) {
			applyFieldOperation(
				masterEntries,
				field,
				operation,
				timePlan,
				patch.timeZone?.kind === 'set',
			);
		}
	}
	if (
		patch.timeZone?.kind === 'set' &&
		(operationChanges(context.master, 'timeZone', patch.timeZone) ||
			patch.start !== undefined ||
			patch.end !== undefined)
	) {
		applyTimeZoneOperation(masterEntries, patch.timeZone, projectInstant, renderedTimeZone);
	}
	applyMetadata(masterEntries, metadata, modifiedAt);
	Object.freeze(masterEntries);
	const master = Object.freeze({
		kind: 'component' as const,
		name: context.master.name,
		entries: masterEntries,
	});
	const calendarEntries = reconcileTimeZoneDefinitions(context, master, timeZoneDefinition);
	Object.freeze(calendarEntries);
	const calendar = Object.freeze({
		kind: 'component' as const,
		name: context.resource.calendar.name,
		entries: calendarEntries,
	});
	return Object.freeze({ kind: 'resource', originalIcs: '', calendar });
}

export function applyCalendarEventPatch(
	context: CalendarEventPreservationContext,
	patch: CalendarEventPatch,
	modifiedAt: Date,
	projectInstant: CalendarEventInstantProjector = projectInstantInTimeZone,
	renderedTimeZone?: string,
	timeZoneDefinition?: ICalendarComponent,
): ICalendarResource {
	const canonicalContext = validateStage(
		() => snapshotCanonicalContext(context),
		'INVALID_CONTEXT',
	);
	validateIdentity(canonicalContext);
	const metadata = validateSingletonsAndMetadata(canonicalContext.master);
	const snapshot = validateStage(() => snapshotPatch(patch), 'INVALID_INPUT');
	const validatedPatch = validateStage(() => validatePatchOperations(snapshot), 'INVALID_INPUT');
	validateTouchedParameters(canonicalContext.master, validatedPatch);
	const timePlan = planTimePatch(canonicalContext, validatedPatch);
	if (
		!PATCH_FIELDS.some((field) => {
			const operation = validatedPatch[field];
			return operation !== undefined && operationChanges(canonicalContext.master, field, operation);
		})
	) {
		fail('NO_CHANGES');
	}
	const modifiedTimestamp = validateStage(() => dateTimestamp(modifiedAt), 'INVALID_DATE');
	return constructResource(
		canonicalContext,
		validatedPatch,
		metadata,
		modifiedTimestamp,
		timePlan,
		projectInstant,
		renderedTimeZone,
		timeZoneDefinition,
	);
}
