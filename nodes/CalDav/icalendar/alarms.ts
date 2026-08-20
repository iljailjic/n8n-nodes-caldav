import { createHash } from 'node:crypto';

import { ICALENDAR_MAX_COMPONENTS, ICALENDAR_MAX_DEPTH, ICALENDAR_MAX_PROPERTIES } from './parser';
import type {
	ICalendarComponent,
	ICalendarEntry,
	ICalendarParameter,
	ICalendarProperty,
	ICalendarValue,
} from './parser';

export type CalendarAlarmAction = 'display' | 'audio' | 'email';
export type CalendarAlarmReference = 'start' | 'end';
export type CalendarAlarmDirection = 'before' | 'after' | 'at';
export type CalendarAlarmUnit = 'minute' | 'hour' | 'day' | 'week';

export type CalendarAlarmTrigger =
	| { readonly reference: CalendarAlarmReference; readonly direction: 'at' }
	| {
			readonly reference: CalendarAlarmReference;
			readonly direction: 'before' | 'after';
			readonly value: number;
			readonly unit: CalendarAlarmUnit;
	  };

export type CalendarAlarmSelector =
	| { readonly kind: 'uid'; readonly uid: string }
	| { readonly kind: 'legacy'; readonly position: number; readonly fingerprint: string };

export interface DisplayCalendarAlarm {
	readonly selector: CalendarAlarmSelector;
	readonly uid?: string;
	readonly action: 'display';
	readonly trigger: CalendarAlarmTrigger;
	readonly description: string;
}

export interface AudioCalendarAlarm {
	readonly selector: CalendarAlarmSelector;
	readonly uid?: string;
	readonly action: 'audio';
	readonly trigger: CalendarAlarmTrigger;
}

export interface EmailCalendarAlarm {
	readonly selector: CalendarAlarmSelector;
	readonly uid?: string;
	readonly action: 'email';
	readonly trigger: CalendarAlarmTrigger;
	readonly subject: string;
	readonly body: string;
	readonly recipients: readonly string[];
}

export type SupportedCalendarAlarm = DisplayCalendarAlarm | AudioCalendarAlarm | EmailCalendarAlarm;

export type UnsupportedCalendarAlarmReason =
	| 'invalidAlarm'
	| 'unsupportedAction'
	| 'absoluteTrigger'
	| 'repeatingAlarm'
	| 'attachment'
	| 'proximityTrigger'
	| 'unsupportedTrigger'
	| 'unsupportedRecipient';

export interface UnsupportedCalendarAlarm {
	readonly kind: 'unsupported';
	readonly reason: UnsupportedCalendarAlarmReason;
	readonly alarmParts: readonly string[];
}

export type CalendarAlarm = SupportedCalendarAlarm | UnsupportedCalendarAlarm;

export type CalendarAlarmInput =
	| {
			readonly action: 'display';
			readonly trigger: CalendarAlarmTrigger;
			readonly description?: string;
	  }
	| { readonly action: 'audio'; readonly trigger: CalendarAlarmTrigger }
	| {
			readonly action: 'email';
			readonly trigger: CalendarAlarmTrigger;
			readonly subject: string;
			readonly body: string;
			readonly recipients: readonly string[];
	  };

export type CalendarAlarmEdit =
	| {
			readonly action: 'display';
			readonly trigger?: CalendarAlarmTrigger;
			readonly description?: string;
	  }
	| { readonly action: 'audio'; readonly trigger?: CalendarAlarmTrigger }
	| {
			readonly action: 'email';
			readonly trigger?: CalendarAlarmTrigger;
			readonly subject?: string;
			readonly body?: string;
			readonly recipients?: readonly string[];
	  };

export type CalendarAlarmMutation =
	| { readonly kind: 'add'; readonly alarm: CalendarAlarmInput }
	| {
			readonly kind: 'edit';
			readonly selector: CalendarAlarmSelector;
			readonly alarm: CalendarAlarmEdit;
	  }
	| { readonly kind: 'remove'; readonly selector: CalendarAlarmSelector };

export type CalendarAlarmUidGenerator = () => string;

export type CalendarAlarmField =
	| 'alarms'
	| 'selector'
	| 'action'
	| 'trigger'
	| 'reference'
	| 'direction'
	| 'value'
	| 'unit'
	| 'description'
	| 'subject'
	| 'body'
	| 'recipients'
	| 'uid';

export const CalendarAlarmErrorCode = Object.freeze({
	INVALID_INPUT: 'INVALID_INPUT',
	UNKNOWN_FIELD: 'UNKNOWN_FIELD',
	INVALID_SELECTOR: 'INVALID_SELECTOR',
	STALE_SELECTOR: 'STALE_SELECTOR',
	ALARM_NOT_FOUND: 'ALARM_NOT_FOUND',
	AMBIGUOUS_SELECTOR: 'AMBIGUOUS_SELECTOR',
	READ_ONLY_ALARM: 'READ_ONLY_ALARM',
	ACTION_MISMATCH: 'ACTION_MISMATCH',
	INVALID_ACTION: 'INVALID_ACTION',
	INVALID_TRIGGER: 'INVALID_TRIGGER',
	INVALID_TRIGGER_VALUE: 'INVALID_TRIGGER_VALUE',
	INVALID_TEXT: 'INVALID_TEXT',
	INVALID_RECIPIENT: 'INVALID_RECIPIENT',
	DUPLICATE_RECIPIENT: 'DUPLICATE_RECIPIENT',
	DUPLICATE_TARGET: 'DUPLICATE_TARGET',
	NO_CHANGES: 'NO_CHANGES',
	INVALID_GENERATED_UID: 'INVALID_GENERATED_UID',
	RESOURCE_LIMIT_EXCEEDED: 'RESOURCE_LIMIT_EXCEEDED',
} as const);

export type CalendarAlarmErrorCode =
	(typeof CalendarAlarmErrorCode)[keyof typeof CalendarAlarmErrorCode];

const ERROR_MESSAGES: Readonly<Record<CalendarAlarmErrorCode, string>> = {
	INVALID_INPUT: 'The calendar alarm input is invalid.',
	UNKNOWN_FIELD: 'The calendar alarm input contains an unsupported field.',
	INVALID_SELECTOR: 'The calendar alarm selector is invalid.',
	STALE_SELECTOR: 'The selected calendar alarm no longer matches the current event.',
	ALARM_NOT_FOUND: 'The selected calendar alarm was not found.',
	AMBIGUOUS_SELECTOR: 'The calendar event contains an ambiguous alarm selector.',
	READ_ONLY_ALARM: 'The selected calendar alarm is read-only in structured mode.',
	ACTION_MISMATCH: 'The selected calendar alarm action does not match the edit.',
	INVALID_ACTION: 'The calendar alarm action is invalid.',
	INVALID_TRIGGER: 'The calendar alarm trigger is invalid.',
	INVALID_TRIGGER_VALUE: 'The calendar alarm trigger value is invalid.',
	INVALID_TEXT: 'The calendar alarm text value is invalid.',
	INVALID_RECIPIENT: 'The calendar alarm recipient must be one mailto URI.',
	DUPLICATE_RECIPIENT: 'The calendar alarm contains a duplicate recipient.',
	DUPLICATE_TARGET: 'A calendar alarm can be targeted only once per mutation.',
	NO_CHANGES: 'The calendar alarm mutation does not contain any changes.',
	INVALID_GENERATED_UID: 'A generated calendar alarm UID is invalid.',
	RESOURCE_LIMIT_EXCEEDED: 'The calendar alarm mutation exceeds an iCalendar resource limit.',
};

export class CalDavCalendarAlarmError extends Error {
	readonly code: CalendarAlarmErrorCode;
	readonly field?: CalendarAlarmField;

	constructor(code: CalendarAlarmErrorCode, field?: CalendarAlarmField) {
		super(ERROR_MESSAGES[code]);
		this.name = 'CalDavCalendarAlarmError';
		this.code = code;
		if (field !== undefined) this.field = field;
	}
}

const MAX_INTEGER = 2_147_483_647;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX_PAIR_PATTERN = /^[0-9A-Fa-f]{2}$/;
const SAFE_FIELDS = new Set<CalendarAlarmField>([
	'alarms',
	'selector',
	'action',
	'trigger',
	'reference',
	'direction',
	'value',
	'unit',
	'description',
	'subject',
	'body',
	'recipients',
	'uid',
]);

function fail(code: CalendarAlarmErrorCode, field?: CalendarAlarmField): never {
	throw new CalDavCalendarAlarmError(code, field);
}

function hasOwn(value: object, key: PropertyKey): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function upper(value: string): string {
	return value.replace(/[a-z]/g, (character) =>
		String.fromCharCode(character.charCodeAt(0) - 0x20),
	);
}

function directComponents(
	component: ICalendarComponent,
	name: string,
): readonly ICalendarComponent[] {
	const expected = upper(name);
	return component.entries.filter(
		(entry): entry is ICalendarComponent =>
			entry.kind === 'component' && upper(entry.name) === expected,
	);
}

function directProperties(
	component: ICalendarComponent,
	name: string,
): readonly ICalendarProperty[] {
	const expected = upper(name);
	return component.entries.filter(
		(entry): entry is ICalendarProperty =>
			entry.kind === 'property' && upper(entry.name) === expected,
	);
}

function scalarText(property: ICalendarProperty): string | undefined {
	return upper(property.value.valueType) === 'TEXT' && property.value.textValues?.length === 1
		? property.value.textValues[0]
		: undefined;
}

function propertyPartOrder(
	component: ICalendarComponent,
	names: readonly string[],
): readonly string[] {
	const expected = new Set(names);
	const parts: string[] = [];
	for (const entry of component.entries) {
		if (entry.kind !== 'property') continue;
		const name = upper(entry.name);
		if (expected.has(name) && !parts.includes(name)) parts.push(name);
	}
	for (const name of names) if (!parts.includes(name)) parts.push(name);
	return Object.freeze(parts);
}

function unsupported(
	reason: UnsupportedCalendarAlarmReason,
	parts: readonly string[],
): UnsupportedCalendarAlarm {
	return Object.freeze({
		kind: 'unsupported',
		reason,
		alarmParts: Object.freeze([...new Set(parts)]),
	});
}

function isUnsupportedAlarm(alarm: CalendarAlarm): alarm is UnsupportedCalendarAlarm {
	return 'kind' in alarm && alarm.kind === 'unsupported';
}

function parameterValues(property: ICalendarProperty, name: string): readonly string[] {
	const expected = upper(name);
	return property.parameters
		.filter((parameter) => upper(parameter.name) === expected)
		.flatMap((parameter) => parameter.values.map(({ value }) => value));
}

function hasOnlyTriggerParameters(property: ICalendarProperty): boolean {
	const allowed = new Set(['RELATED', 'VALUE']);
	return property.parameters.every(
		(parameter) => allowed.has(upper(parameter.name)) && parameter.values.length === 1,
	);
}

function eventHasBoundary(master: ICalendarComponent, reference: CalendarAlarmReference): boolean {
	if (reference === 'start') return directProperties(master, 'DTSTART').length === 1;
	return (
		directProperties(master, 'DTEND').length === 1 ||
		directProperties(master, 'DURATION').length === 1
	);
}

function parseTrigger(
	property: ICalendarProperty,
	master: ICalendarComponent,
): CalendarAlarmTrigger | undefined {
	if (!hasOnlyTriggerParameters(property)) return undefined;
	const values = parameterValues(property, 'VALUE');
	if (values.length > 1) return undefined;
	if (values.length === 1 && upper(values[0]!) !== 'DURATION') return undefined;
	if (upper(property.value.valueType) !== 'DURATION') return undefined;
	const related = parameterValues(property, 'RELATED');
	if (related.length > 1) return undefined;
	const reference: CalendarAlarmReference =
		related.length === 0 || upper(related[0]!) === 'START'
			? 'start'
			: upper(related[0]!) === 'END'
				? 'end'
				: undefined!;
	if (reference === undefined || !eventHasBoundary(master, reference)) return undefined;

	const match = /^([+-]?)(?:PT(\d+)([MHS])|P(\d+)([DW]))$/.exec(property.value.raw);
	if (match === null) return undefined;
	const amountText = match[2] ?? match[4];
	const designator = match[3] ?? match[5];
	if (amountText === undefined || designator === undefined) return undefined;
	const amount = Number(amountText);
	if (!Number.isSafeInteger(amount) || amount > MAX_INTEGER) return undefined;
	if (amount === 0) return Object.freeze({ reference, direction: 'at' });
	if (designator === 'S') return undefined;
	const unitByDesignator = {
		M: 'minute',
		H: 'hour',
		D: 'day',
		W: 'week',
	} as const;
	const unit = unitByDesignator[designator as keyof typeof unitByDesignator];
	if (unit === undefined) return undefined;
	return Object.freeze({
		reference,
		direction: match[1] === '-' ? 'before' : 'after',
		value: amount,
		unit,
	});
}

function recipientIsValid(value: string): boolean {
	if (!/^mailto:/i.test(value)) return false;
	const address = value.slice(value.indexOf(':') + 1);
	if (address.length === 0 || /[?#,\r\n]/.test(address)) return false;
	for (let index = 0; index < address.length; index += 1) {
		if (address[index] === '%') {
			if (!HEX_PAIR_PATTERN.test(address.slice(index + 1, index + 3))) return false;
			index += 2;
		}
	}
	const at = address.lastIndexOf('@');
	if (at <= 0 || at !== address.indexOf('@') || at === address.length - 1) return false;
	const local = address.slice(0, at);
	const domain = address.slice(at + 1);
	if (!/^(?:[A-Za-z0-9!$&'*+\-/=?^_`{|}~.]|%[0-9A-Fa-f]{2})+$/.test(local)) return false;
	if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
	if (/^\[(?:IPv6:)?[0-9A-Fa-f:.]+\]$/.test(domain)) return true;
	if (
		!/^(?:[A-Za-z0-9-]|%[0-9A-Fa-f]{2})(?:(?:[A-Za-z0-9.-]|%[0-9A-Fa-f]{2})*(?:[A-Za-z0-9]|%[0-9A-Fa-f]{2}))?$/.test(
			domain,
		)
	) {
		return false;
	}
	return (
		!domain.includes('..') &&
		!domain.split('.').some((label) => label.startsWith('-') || label.endsWith('-'))
	);
}

function fingerprintValue(value: ICalendarValue): unknown {
	return {
		valueType: upper(value.valueType),
		value: value.textValues === null ? value.raw : [...value.textValues],
	};
}

function fingerprintParameter(parameter: ICalendarParameter): unknown {
	return {
		name: upper(parameter.name),
		values: parameter.values.map(({ value }) => value),
	};
}

function fingerprintEntry(entry: ICalendarEntry): unknown {
	return entry.kind === 'component'
		? {
				kind: 'component',
				name: upper(entry.name),
				entries: entry.entries.map(fingerprintEntry),
			}
		: {
				kind: 'property',
				name: upper(entry.name),
				parameters: entry.parameters.map(fingerprintParameter),
				value: fingerprintValue(entry.value),
			};
}

export function calendarAlarmFingerprint(component: ICalendarComponent): string {
	return createHash('sha256')
		.update(JSON.stringify(fingerprintEntry(component)))
		.digest('hex');
}

interface AlarmClassification {
	readonly projection: CalendarAlarm;
	readonly action?: CalendarAlarmAction;
	readonly trigger?: CalendarAlarmTrigger;
	readonly uid?: string;
}

function classifyAlarm(
	component: ICalendarComponent,
	master: ICalendarComponent,
	position: number,
	usableUidCounts: ReadonlyMap<string, number>,
): AlarmClassification {
	const actions = directProperties(component, 'ACTION');
	const triggers = directProperties(component, 'TRIGGER');
	const actionText = actions.length === 1 ? scalarText(actions[0]!) : undefined;
	if (
		actions.length !== 1 ||
		triggers.length !== 1 ||
		actionText === undefined ||
		actionText.length === 0
	) {
		const missing = [
			...(actions.length === 1 && actionText !== undefined && actionText.length > 0
				? []
				: ['ACTION']),
			...(triggers.length === 1 ? [] : ['TRIGGER']),
		];
		return { projection: unsupported('invalidAlarm', propertyPartOrder(component, missing)) };
	}

	const actionToken = upper(actionText);
	if (actionToken !== 'DISPLAY' && actionToken !== 'AUDIO' && actionToken !== 'EMAIL') {
		return { projection: unsupported('unsupportedAction', ['ACTION']) };
	}
	const action = actionToken.toLowerCase() as CalendarAlarmAction;
	const triggerProperty = triggers[0]!;
	const valueTokens = parameterValues(triggerProperty, 'VALUE');
	if (
		upper(triggerProperty.value.valueType) === 'DATE-TIME' ||
		valueTokens.some((value) => upper(value) === 'DATE-TIME')
	) {
		return { projection: unsupported('absoluteTrigger', ['TRIGGER']) };
	}
	const repeats = directProperties(component, 'REPEAT');
	const durations = directProperties(component, 'DURATION');
	if (repeats.length > 0 || durations.length > 0) {
		return {
			projection: unsupported(
				'repeatingAlarm',
				propertyPartOrder(component, [
					...(repeats.length > 0 ? ['REPEAT'] : []),
					...(durations.length > 0 ? ['DURATION'] : []),
				]),
			),
		};
	}
	if (directProperties(component, 'ATTACH').length > 0) {
		return { projection: unsupported('attachment', ['ATTACH']) };
	}
	if (directProperties(component, 'PROXIMITY').length > 0) {
		return { projection: unsupported('proximityTrigger', ['PROXIMITY']) };
	}
	const trigger = parseTrigger(triggerProperty, master);
	if (trigger === undefined) {
		return { projection: unsupported('unsupportedTrigger', ['TRIGGER']) };
	}

	const descriptions = directProperties(component, 'DESCRIPTION');
	const summaries = directProperties(component, 'SUMMARY');
	const attendees = directProperties(component, 'ATTENDEE');
	if (
		(action === 'display' &&
			(descriptions.length !== 1 || scalarText(descriptions[0]!) === undefined)) ||
		(action === 'email' &&
			(summaries.length !== 1 ||
				scalarText(summaries[0]!) === undefined ||
				descriptions.length !== 1 ||
				scalarText(descriptions[0]!) === undefined ||
				attendees.length === 0))
	) {
		const required = [
			...(action === 'email' && (summaries.length !== 1 || scalarText(summaries[0]!) === undefined)
				? ['SUMMARY']
				: []),
			...(descriptions.length !== 1 || scalarText(descriptions[0]!) === undefined
				? ['DESCRIPTION']
				: []),
			...(action === 'email' && attendees.length === 0 ? ['ATTENDEE'] : []),
		];
		return { projection: unsupported('invalidAlarm', propertyPartOrder(component, required)) };
	}
	const recipients = attendees.map((property) => property.value.raw);
	if (action === 'email' && attendees.some((property) => !recipientIsValid(property.value.raw))) {
		return { projection: unsupported('unsupportedRecipient', ['ATTENDEE']) };
	}

	const uidProperties = directProperties(component, 'UID');
	const candidateUid = uidProperties.length === 1 ? scalarText(uidProperties[0]!) : undefined;
	const uid =
		candidateUid !== undefined && candidateUid.length > 0 && usableUidCounts.get(candidateUid) === 1
			? candidateUid
			: undefined;
	const selector: CalendarAlarmSelector = Object.freeze(
		uid === undefined
			? { kind: 'legacy', position, fingerprint: calendarAlarmFingerprint(component) }
			: { kind: 'uid', uid },
	);
	const common = {
		selector,
		...(uid === undefined ? {} : { uid }),
		action,
		trigger,
	};
	let projection: SupportedCalendarAlarm;
	if (action === 'display') {
		projection = Object.freeze({
			...common,
			action,
			description: scalarText(descriptions[0]!)!,
		});
	} else if (action === 'audio') {
		projection = Object.freeze({ ...common, action });
	} else {
		projection = Object.freeze({
			...common,
			action,
			subject: scalarText(summaries[0]!)!,
			body: scalarText(descriptions[0]!)!,
			recipients: Object.freeze(recipients),
		});
	}
	return { projection, action, trigger, ...(uid === undefined ? {} : { uid }) };
}

function usableUidCounts(alarms: readonly ICalendarComponent[]): ReadonlyMap<string, number> {
	const counts = new Map<string, number>();
	for (const alarm of alarms) {
		const properties = directProperties(alarm, 'UID');
		const uid = properties.length === 1 ? scalarText(properties[0]!) : undefined;
		if (uid !== undefined && uid.length > 0) counts.set(uid, (counts.get(uid) ?? 0) + 1);
	}
	return counts;
}

export function projectCalendarAlarms(master: ICalendarComponent): readonly CalendarAlarm[] {
	const alarms = directComponents(master, 'VALARM');
	const uidCounts = usableUidCounts(alarms);
	return Object.freeze(
		alarms.map((alarm, index) => classifyAlarm(alarm, master, index + 1, uidCounts).projection),
	);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function snapshotData(value: unknown, seen = new WeakSet<object>()): unknown {
	if (typeof value !== 'object' || value === null) return value;
	if (seen.has(value)) fail('INVALID_INPUT', 'alarms');
	seen.add(value);
	if (Array.isArray(value)) {
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (Object.getOwnPropertySymbols(value).length > 0) fail('INVALID_INPUT', 'alarms');
		for (let index = 0; index < value.length; index += 1) {
			const descriptor = descriptors[String(index)];
			if (
				descriptor === undefined ||
				!descriptor.enumerable ||
				!('value' in descriptor) ||
				descriptor.value === undefined
			) {
				fail('INVALID_INPUT', 'alarms');
			}
		}
		if (Object.keys(descriptors).some((key) => key !== 'length' && !/^\d+$/.test(key))) {
			fail('UNKNOWN_FIELD', 'alarms');
		}
		const result = value.map((entry) => snapshotData(entry, seen));
		seen.delete(value);
		return result;
	}
	if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length > 0) {
		fail('INVALID_INPUT', 'alarms');
	}
	const result: Record<string, unknown> = {};
	for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
		if (!descriptor.enumerable || !('value' in descriptor) || descriptor.value === undefined) {
			fail('INVALID_INPUT', 'alarms');
		}
		result[key] = snapshotData(descriptor.value, seen);
	}
	seen.delete(value);
	return result;
}

function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
	if (!isPlainRecord(value)) fail('INVALID_INPUT', 'alarms');
	for (const key of Object.keys(value)) if (!allowed.includes(key)) fail('UNKNOWN_FIELD', 'alarms');
	return value;
}

function validateText(value: unknown, field: CalendarAlarmField, allowEmpty = false): string {
	if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) fail('INVALID_TEXT', field);
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) fail('INVALID_TEXT', field);
			index += 1;
			continue;
		}
		if (code >= 0xdc00 && code <= 0xdfff) fail('INVALID_TEXT', field);
		if (code === 0x09 || code === 0x0a) continue;
		if (code < 0x20 || code === 0x7f) fail('INVALID_TEXT', field);
	}
	return value;
}

function validateTrigger(value: unknown, master: ICalendarComponent): CalendarAlarmTrigger {
	const input = record(value, ['reference', 'direction', 'value', 'unit']);
	const reference = input.reference;
	if (reference !== 'start' && reference !== 'end') fail('INVALID_TRIGGER', 'reference');
	if (!eventHasBoundary(master, reference)) fail('INVALID_TRIGGER', 'reference');
	const direction = input.direction;
	if (direction === 'at') {
		if (hasOwn(input, 'value') || hasOwn(input, 'unit')) fail('INVALID_TRIGGER', 'trigger');
		return Object.freeze({ reference, direction });
	}
	if (direction !== 'before' && direction !== 'after') fail('INVALID_TRIGGER', 'direction');
	if (
		typeof input.value !== 'number' ||
		!Number.isInteger(input.value) ||
		input.value < 1 ||
		input.value > MAX_INTEGER
	) {
		fail('INVALID_TRIGGER_VALUE', 'value');
	}
	if (!['minute', 'hour', 'day', 'week'].includes(input.unit as string)) {
		fail('INVALID_TRIGGER', 'unit');
	}
	return Object.freeze({
		reference,
		direction,
		value: input.value,
		unit: input.unit as CalendarAlarmUnit,
	});
}

function validateRecipients(value: unknown): readonly string[] {
	if (!Array.isArray(value) || value.length === 0) fail('INVALID_RECIPIENT', 'recipients');
	const recipients: string[] = [];
	const seen = new Set<string>();
	for (const recipient of value) {
		if (typeof recipient !== 'string' || !recipientIsValid(recipient)) {
			fail('INVALID_RECIPIENT', 'recipients');
		}
		if (seen.has(recipient)) fail('DUPLICATE_RECIPIENT', 'recipients');
		seen.add(recipient);
		recipients.push(recipient);
	}
	return Object.freeze(recipients);
}

function finalSummary(master: ICalendarComponent): string | undefined {
	const summaries = directProperties(master, 'SUMMARY');
	return summaries.length === 1 ? scalarText(summaries[0]!) : undefined;
}

function validateAlarmInput(value: unknown, master: ICalendarComponent): CalendarAlarmInput {
	const input = record(value, [
		'action',
		'trigger',
		'description',
		'subject',
		'body',
		'recipients',
	]);
	const action = input.action;
	if (action !== 'display' && action !== 'audio' && action !== 'email') {
		fail('INVALID_ACTION', 'action');
	}
	if (!hasOwn(input, 'trigger')) fail('INVALID_TRIGGER', 'trigger');
	const trigger = validateTrigger(input.trigger, master);
	if (action === 'display') {
		for (const key of ['subject', 'body', 'recipients']) {
			if (hasOwn(input, key)) fail('UNKNOWN_FIELD', 'action');
		}
		const description = hasOwn(input, 'description')
			? validateText(input.description, 'description')
			: validateText(finalSummary(master), 'description');
		return Object.freeze({ action, trigger, description });
	}
	if (action === 'audio') {
		for (const key of ['description', 'subject', 'body', 'recipients']) {
			if (hasOwn(input, key)) fail('UNKNOWN_FIELD', 'action');
		}
		return Object.freeze({ action, trigger });
	}
	if (hasOwn(input, 'description')) fail('UNKNOWN_FIELD', 'action');
	return Object.freeze({
		action,
		trigger,
		subject: validateText(input.subject, 'subject'),
		body: validateText(input.body, 'body'),
		recipients: validateRecipients(input.recipients),
	});
}

function validateAlarmEdit(value: unknown, master: ICalendarComponent): CalendarAlarmEdit {
	const input = record(value, [
		'action',
		'trigger',
		'description',
		'subject',
		'body',
		'recipients',
	]);
	const action = input.action;
	if (action !== 'display' && action !== 'audio' && action !== 'email') {
		fail('INVALID_ACTION', 'action');
	}
	if (Object.keys(input).length === 1) fail('NO_CHANGES');
	const trigger = hasOwn(input, 'trigger') ? validateTrigger(input.trigger, master) : undefined;
	if (action === 'display') {
		if (hasOwn(input, 'subject') || hasOwn(input, 'body') || hasOwn(input, 'recipients')) {
			fail('UNKNOWN_FIELD', 'action');
		}
		return Object.freeze({
			action,
			...(trigger === undefined ? {} : { trigger }),
			...(hasOwn(input, 'description')
				? { description: validateText(input.description, 'description') }
				: {}),
		});
	}
	if (action === 'audio') {
		if (
			hasOwn(input, 'description') ||
			hasOwn(input, 'subject') ||
			hasOwn(input, 'body') ||
			hasOwn(input, 'recipients')
		) {
			fail('UNKNOWN_FIELD', 'action');
		}
		return Object.freeze({ action, ...(trigger === undefined ? {} : { trigger }) });
	}
	if (hasOwn(input, 'description')) fail('UNKNOWN_FIELD', 'action');
	return Object.freeze({
		action,
		...(trigger === undefined ? {} : { trigger }),
		...(hasOwn(input, 'subject') ? { subject: validateText(input.subject, 'subject') } : {}),
		...(hasOwn(input, 'body') ? { body: validateText(input.body, 'body') } : {}),
		...(hasOwn(input, 'recipients') ? { recipients: validateRecipients(input.recipients) } : {}),
	});
}

function validateSelector(value: unknown): CalendarAlarmSelector {
	const input = record(value, ['kind', 'uid', 'position', 'fingerprint']);
	if (input.kind === 'uid') {
		if (
			Object.keys(input).length !== 2 ||
			typeof input.uid !== 'string' ||
			input.uid.length === 0
		) {
			fail('INVALID_SELECTOR', 'selector');
		}
		return Object.freeze({ kind: 'uid', uid: input.uid });
	}
	if (input.kind === 'legacy') {
		if (
			Object.keys(input).length !== 3 ||
			typeof input.position !== 'number' ||
			!Number.isInteger(input.position) ||
			input.position < 1 ||
			typeof input.fingerprint !== 'string' ||
			!/^[0-9a-f]{64}$/.test(input.fingerprint)
		) {
			fail('INVALID_SELECTOR', 'selector');
		}
		return Object.freeze({
			kind: 'legacy',
			position: input.position,
			fingerprint: input.fingerprint,
		});
	}
	return fail('INVALID_SELECTOR', 'selector');
}

function validateMutationList(
	value: unknown,
	master: ICalendarComponent,
): readonly CalendarAlarmMutation[] {
	const snapshot = snapshotData(value);
	if (!Array.isArray(snapshot) || snapshot.length === 0) fail('INVALID_INPUT', 'alarms');
	return Object.freeze(
		snapshot.map((candidate): CalendarAlarmMutation => {
			const mutation = record(candidate, ['kind', 'alarm', 'selector']);
			if (mutation.kind === 'add') {
				if (Object.keys(mutation).length !== 2 || !hasOwn(mutation, 'alarm')) {
					fail('INVALID_INPUT', 'alarms');
				}
				return Object.freeze({ kind: 'add', alarm: validateAlarmInput(mutation.alarm, master) });
			}
			if (mutation.kind === 'edit') {
				if (
					Object.keys(mutation).length !== 3 ||
					!hasOwn(mutation, 'selector') ||
					!hasOwn(mutation, 'alarm')
				) {
					fail('INVALID_INPUT', 'alarms');
				}
				return Object.freeze({
					kind: 'edit',
					selector: validateSelector(mutation.selector),
					alarm: validateAlarmEdit(mutation.alarm, master),
				});
			}
			if (mutation.kind === 'remove') {
				if (Object.keys(mutation).length !== 2 || !hasOwn(mutation, 'selector')) {
					fail('INVALID_INPUT', 'alarms');
				}
				return Object.freeze({ kind: 'remove', selector: validateSelector(mutation.selector) });
			}
			return fail('INVALID_INPUT', 'alarms');
		}),
	);
}

function textProperty(name: string, value: string): ICalendarProperty {
	return Object.freeze({
		kind: 'property',
		name,
		parameters: Object.freeze([]),
		value: Object.freeze({
			kind: 'value',
			valueType: 'TEXT',
			raw: value,
			textValues: Object.freeze([value]),
		}),
	});
}

function rawProperty(
	name: string,
	valueType: string,
	raw: string,
	parameters: readonly ICalendarParameter[] = [],
): ICalendarProperty {
	return Object.freeze({
		kind: 'property',
		name,
		parameters: Object.freeze([...parameters]),
		value: Object.freeze({ kind: 'value', valueType, raw, textValues: null }),
	});
}

function parameter(name: string, value: string): ICalendarParameter {
	return Object.freeze({
		kind: 'parameter',
		name,
		values: Object.freeze([
			Object.freeze({ kind: 'parameterValue', raw: value, value, quoted: false }),
		]),
	});
}

function triggerProperty(trigger: CalendarAlarmTrigger): ICalendarProperty {
	const related = trigger.reference === 'end' ? [parameter('RELATED', 'END')] : [];
	if (trigger.direction === 'at') return rawProperty('TRIGGER', 'DURATION', 'PT0S', related);
	const designator = ({ minute: 'PT', hour: 'PT', day: 'P', week: 'P' } as const)[trigger.unit];
	const suffix = ({ minute: 'M', hour: 'H', day: 'D', week: 'W' } as const)[trigger.unit];
	const sign = trigger.direction === 'before' ? '-' : '';
	return rawProperty(
		'TRIGGER',
		'DURATION',
		`${sign}${designator}${trigger.value}${suffix}`,
		related,
	);
}

function attendeeProperty(recipient: string): ICalendarProperty {
	return rawProperty('ATTENDEE', 'CAL-ADDRESS', recipient);
}

function componentFromInput(input: CalendarAlarmInput, uid: string): ICalendarComponent {
	const entries: ICalendarEntry[] = [
		textProperty('UID', uid),
		textProperty('ACTION', upper(input.action)),
		triggerProperty(input.trigger),
	];
	if (input.action === 'display') entries.push(textProperty('DESCRIPTION', input.description!));
	if (input.action === 'email') {
		entries.push(textProperty('SUMMARY', input.subject), textProperty('DESCRIPTION', input.body));
		entries.push(...input.recipients.map(attendeeProperty));
	}
	return Object.freeze({ kind: 'component', name: 'VALARM', entries: Object.freeze(entries) });
}

function generatedUid(factory: CalendarAlarmUidGenerator, existing: Set<string>): string {
	let uid: unknown;
	try {
		uid = factory();
	} catch {
		return fail('INVALID_GENERATED_UID', 'uid');
	}
	if (typeof uid !== 'string' || !UUID_V4_PATTERN.test(uid) || existing.has(uid)) {
		fail('INVALID_GENERATED_UID', 'uid');
	}
	existing.add(uid);
	return uid;
}

function insertAlarms(
	master: ICalendarComponent,
	additions: readonly ICalendarComponent[],
): ICalendarComponent {
	if (additions.length === 0) return master;
	const entries = [...master.entries];
	let insertion = entries.length;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index]!;
		if (entry.kind === 'component' && upper(entry.name) === 'VALARM') {
			insertion = index + 1;
			break;
		}
	}
	entries.splice(insertion, 0, ...additions);
	return Object.freeze({ kind: 'component', name: master.name, entries: Object.freeze(entries) });
}

function validateLimits(component: ICalendarComponent): void {
	let componentCount = 0;
	let propertyCount = 0;
	const visit = (current: ICalendarComponent, depth: number): void => {
		componentCount += 1;
		if (
			depth > ICALENDAR_MAX_DEPTH ||
			componentCount > ICALENDAR_MAX_COMPONENTS ||
			propertyCount > ICALENDAR_MAX_PROPERTIES
		) {
			fail('RESOURCE_LIMIT_EXCEEDED', 'alarms');
		}
		for (const entry of current.entries) {
			if (entry.kind === 'component') visit(entry, depth + 1);
			else propertyCount += 1;
		}
	};
	visit(component, 1);
	if (propertyCount > ICALENDAR_MAX_PROPERTIES) fail('RESOURCE_LIMIT_EXCEEDED', 'alarms');
}

export function authorCalendarAlarms(
	master: ICalendarComponent,
	value: unknown,
	uidFactory: CalendarAlarmUidGenerator,
): ICalendarComponent {
	const snapshot = snapshotData(value);
	if (!Array.isArray(snapshot) || snapshot.length === 0) fail('INVALID_INPUT', 'alarms');
	const inputs = snapshot.map((input) => validateAlarmInput(input, master));
	const existing = new Set<string>();
	for (const alarm of directComponents(master, 'VALARM')) {
		const uids = directProperties(alarm, 'UID');
		const uid = uids.length === 1 ? scalarText(uids[0]!) : undefined;
		if (uid !== undefined && uid.length > 0) existing.add(uid);
	}
	const additions = inputs.map((input) =>
		componentFromInput(input, generatedUid(uidFactory, existing)),
	);
	const result = insertAlarms(master, additions);
	validateLimits(result);
	return result;
}

interface ResolvedAlarm {
	readonly component: ICalendarComponent;
	readonly entryIndex: number;
	readonly position: number;
	readonly classification: AlarmClassification;
}

function alarmSnapshot(master: ICalendarComponent): readonly ResolvedAlarm[] {
	const alarmComponents = directComponents(master, 'VALARM');
	const counts = usableUidCounts(alarmComponents);
	let position = 0;
	return master.entries.flatMap((entry, entryIndex): readonly ResolvedAlarm[] => {
		if (entry.kind !== 'component' || upper(entry.name) !== 'VALARM') return [];
		position += 1;
		return [
			{
				component: entry,
				entryIndex,
				position,
				classification: classifyAlarm(entry, master, position, counts),
			},
		];
	});
}

function resolveSelector(
	alarms: readonly ResolvedAlarm[],
	selector: CalendarAlarmSelector,
): ResolvedAlarm {
	if (selector.kind === 'uid') {
		const matches = alarms.filter((alarm) => {
			const uids = directProperties(alarm.component, 'UID');
			return uids.length === 1 && scalarText(uids[0]!) === selector.uid;
		});
		if (matches.length === 0) fail('ALARM_NOT_FOUND', 'selector');
		if (matches.length > 1) fail('AMBIGUOUS_SELECTOR', 'selector');
		return matches[0]!;
	}
	const alarm = alarms[selector.position - 1];
	if (alarm === undefined) fail('ALARM_NOT_FOUND', 'selector');
	if (calendarAlarmFingerprint(alarm.component) !== selector.fingerprint) {
		fail('STALE_SELECTOR', 'selector');
	}
	return alarm;
}

function replaceProperty(
	entries: readonly ICalendarEntry[],
	name: string,
	replacement: ICalendarProperty,
): readonly ICalendarEntry[] {
	const expected = upper(name);
	const index = entries.findIndex(
		(entry) => entry.kind === 'property' && upper(entry.name) === expected,
	);
	if (index < 0) return Object.freeze([...entries, replacement]);
	const result = [...entries];
	result[index] = replacement;
	return Object.freeze(result);
}

function replaceRecipients(
	entries: readonly ICalendarEntry[],
	recipients: readonly string[],
): readonly ICalendarEntry[] {
	const first = entries.findIndex(
		(entry) => entry.kind === 'property' && upper(entry.name) === 'ATTENDEE',
	);
	const filtered = entries.filter(
		(entry) => entry.kind !== 'property' || upper(entry.name) !== 'ATTENDEE',
	);
	const insertion = first < 0 ? filtered.length : first;
	filtered.splice(insertion, 0, ...recipients.map(attendeeProperty));
	return Object.freeze(filtered);
}

function editComponent(
	resolved: ResolvedAlarm,
	edit: CalendarAlarmEdit,
): { readonly component: ICalendarComponent; readonly changed: boolean } {
	const projection = resolved.classification.projection;
	if (isUnsupportedAlarm(projection)) fail('READ_ONLY_ALARM', 'selector');
	if (projection.action !== edit.action) fail('ACTION_MISMATCH', 'action');
	let entries = resolved.component.entries;
	let changed = false;
	if (
		edit.trigger !== undefined &&
		JSON.stringify(edit.trigger) !== JSON.stringify(projection.trigger)
	) {
		entries = replaceProperty(entries, 'TRIGGER', triggerProperty(edit.trigger));
		changed = true;
	}
	if (
		edit.action === 'display' &&
		projection.action === 'display' &&
		edit.description !== undefined &&
		edit.description !== projection.description
	) {
		entries = replaceProperty(
			entries,
			'DESCRIPTION',
			textProperty('DESCRIPTION', edit.description),
		);
		changed = true;
	}
	if (edit.action === 'email' && projection.action === 'email') {
		if (edit.subject !== undefined && edit.subject !== projection.subject) {
			entries = replaceProperty(entries, 'SUMMARY', textProperty('SUMMARY', edit.subject));
			changed = true;
		}
		if (edit.body !== undefined && edit.body !== projection.body) {
			entries = replaceProperty(entries, 'DESCRIPTION', textProperty('DESCRIPTION', edit.body));
			changed = true;
		}
		if (
			edit.recipients !== undefined &&
			JSON.stringify(edit.recipients) !== JSON.stringify(projection.recipients)
		) {
			entries = replaceRecipients(entries, edit.recipients);
			changed = true;
		}
	}
	return {
		component: changed
			? Object.freeze({ kind: 'component', name: resolved.component.name, entries })
			: resolved.component,
		changed,
	};
}

export function applyCalendarAlarmMutations(
	master: ICalendarComponent,
	value: unknown,
	uidFactory: CalendarAlarmUidGenerator,
): ICalendarComponent {
	const mutations = validateMutationList(value, master);
	const alarms = alarmSnapshot(master);
	const plans: Array<
		| { readonly kind: 'add'; readonly alarm: CalendarAlarmInput }
		| { readonly kind: 'edit'; readonly resolved: ResolvedAlarm; readonly edit: CalendarAlarmEdit }
		| { readonly kind: 'remove'; readonly resolved: ResolvedAlarm }
	> = [];
	const targets = new Set<number>();
	for (const mutation of mutations) {
		if (mutation.kind === 'add') {
			plans.push(mutation);
			continue;
		}
		const resolved = resolveSelector(alarms, mutation.selector);
		if (
			'kind' in resolved.classification.projection &&
			resolved.classification.projection.kind === 'unsupported'
		) {
			fail('READ_ONLY_ALARM', 'selector');
		}
		if (mutation.kind === 'edit') {
			if (resolved.classification.action !== mutation.alarm.action)
				fail('ACTION_MISMATCH', 'action');
		}
		if (targets.has(resolved.entryIndex)) fail('DUPLICATE_TARGET', 'selector');
		targets.add(resolved.entryIndex);
		plans.push(
			mutation.kind === 'edit'
				? { kind: 'edit', resolved, edit: mutation.alarm }
				: { kind: 'remove', resolved },
		);
	}

	const existingUids = new Set<string>();
	for (const alarm of alarms) {
		const properties = directProperties(alarm.component, 'UID');
		const uid = properties.length === 1 ? scalarText(properties[0]!) : undefined;
		if (uid !== undefined && uid.length > 0) existingUids.add(uid);
	}
	const replacements = new Map<number, ICalendarComponent | null>();
	const additions: ICalendarComponent[] = [];
	let changed = false;
	for (const plan of plans) {
		if (plan.kind === 'add') {
			additions.push(componentFromInput(plan.alarm, generatedUid(uidFactory, existingUids)));
			changed = true;
		} else if (plan.kind === 'remove') {
			replacements.set(plan.resolved.entryIndex, null);
			changed = true;
		} else {
			const edited = editComponent(plan.resolved, plan.edit);
			if (edited.changed) {
				replacements.set(plan.resolved.entryIndex, edited.component);
				changed = true;
			}
		}
	}
	if (!changed) fail('NO_CHANGES');
	const entries = master.entries.flatMap((entry, index): readonly ICalendarEntry[] => {
		const replacement = replacements.get(index);
		if (replacement === null) return [];
		return [replacement ?? entry];
	});
	const result = insertAlarms(
		Object.freeze({ kind: 'component', name: master.name, entries: Object.freeze(entries) }),
		additions,
	);
	validateLimits(result);
	return result;
}

export function normalizeCalendarAlarmInputs(
	master: ICalendarComponent,
	value: unknown,
): readonly CalendarAlarmInput[] {
	const snapshot = snapshotData(value);
	if (!Array.isArray(snapshot) || snapshot.length === 0) fail('INVALID_INPUT', 'alarms');
	return Object.freeze(snapshot.map((input) => validateAlarmInput(input, master)));
}

export function normalizeCalendarAlarmMutations(
	master: ICalendarComponent,
	value: unknown,
): readonly CalendarAlarmMutation[] {
	return validateMutationList(value, master);
}

export function isCalendarAlarmErrorField(value: string): value is CalendarAlarmField {
	return SAFE_FIELDS.has(value as CalendarAlarmField);
}
