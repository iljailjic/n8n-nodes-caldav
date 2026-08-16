import { XmlBuildError } from './errors';
import { escapeXmlAttribute, escapeXmlText } from './escape';
import { XML_NAMESPACE_DECLARATIONS, XML_QUALIFIED_NAMES } from './namespaces';
import type { XmlQualifiedName } from './namespaces';

export type PropfindPropertyName =
	| 'currentUserPrincipal'
	| 'calendarHomeSet'
	| 'resourceType'
	| 'displayName'
	| 'calendarDescription'
	| 'calendarTimezone'
	| 'supportedCalendarComponentSet'
	| 'currentUserPrivilegeSet'
	| 'getEtag';

export interface PropfindExpandedPropertyName {
	readonly namespaceUri: string;
	readonly localName: string;
}

export interface CalendarUidQueryInput {
	readonly uid: string;
}

export interface CalendarTimeRangeQueryInput {
	readonly start: Date;
	readonly end: Date;
}

export const CURRENT_USER_PRINCIPAL_PROPERTIES: readonly ['currentUserPrincipal'] = Object.freeze([
	'currentUserPrincipal',
]);

export const CALENDAR_HOME_PROPERTIES: readonly ['calendarHomeSet'] = Object.freeze([
	'calendarHomeSet',
]);

export const CALENDAR_COLLECTION_PROPERTIES: readonly [
	'resourceType',
	'displayName',
	'calendarDescription',
	'calendarTimezone',
	'supportedCalendarComponentSet',
	'currentUserPrivilegeSet',
] = Object.freeze([
	'resourceType',
	'displayName',
	'calendarDescription',
	'calendarTimezone',
	'supportedCalendarComponentSet',
	'currentUserPrivilegeSet',
]);

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

const DATE_GET_TIME = Date.prototype.getTime;
const DATE_GET_UTC_FULL_YEAR = Date.prototype.getUTCFullYear;
const DATE_GET_UTC_MONTH = Date.prototype.getUTCMonth;
const DATE_GET_UTC_DATE = Date.prototype.getUTCDate;
const DATE_GET_UTC_HOURS = Date.prototype.getUTCHours;
const DATE_GET_UTC_MINUTES = Date.prototype.getUTCMinutes;
const DATE_GET_UTC_SECONDS = Date.prototype.getUTCSeconds;
const DATE_GET_UTC_MILLISECONDS = Date.prototype.getUTCMilliseconds;

interface ValidatedUtcDate {
	readonly timestamp: number;
	readonly year: number;
	readonly month: number;
	readonly day: number;
	readonly hours: number;
	readonly minutes: number;
	readonly seconds: number;
}

const PROPFIND_PROPERTY_NAMES: Readonly<Record<PropfindPropertyName, XmlQualifiedName>> =
	Object.freeze({
		currentUserPrincipal: XML_QUALIFIED_NAMES.currentUserPrincipal,
		calendarHomeSet: XML_QUALIFIED_NAMES.calendarHomeSet,
		resourceType: XML_QUALIFIED_NAMES.resourceType,
		displayName: XML_QUALIFIED_NAMES.displayName,
		calendarDescription: XML_QUALIFIED_NAMES.calendarDescription,
		calendarTimezone: XML_QUALIFIED_NAMES.calendarTimezone,
		supportedCalendarComponentSet: XML_QUALIFIED_NAMES.supportedCalendarComponentSet,
		currentUserPrivilegeSet: XML_QUALIFIED_NAMES.currentUserPrivilegeSet,
		getEtag: XML_QUALIFIED_NAMES.getEtag,
	});

const XML_LOCAL_NAME = /^[A-Za-z_][A-Za-z0-9._-]*$/;

function hasPropfindPropertyName(value: unknown): value is PropfindPropertyName {
	return (
		typeof value === 'string' &&
		Object.prototype.hasOwnProperty.call(PROPFIND_PROPERTY_NAMES, value)
	);
}

function rootAttributes(includeCalDav: boolean): string {
	return includeCalDav
		? `${XML_NAMESPACE_DECLARATIONS.dav} ${XML_NAMESPACE_DECLARATIONS.caldav}`
		: XML_NAMESPACE_DECLARATIONS.dav;
}

function emptyElement(name: XmlQualifiedName, indentation: number): string {
	return `${'  '.repeat(indentation)}<${name.qualifiedName}/>`;
}

function invalidUidError(): XmlBuildError {
	return new XmlBuildError('INVALID_UID', 'Calendar UID must be a non-empty string', 'uid');
}

function validateUidInput(input: CalendarUidQueryInput): string {
	let uid: unknown;

	try {
		uid =
			typeof input === 'object' && input !== null
				? (input as unknown as { readonly uid?: unknown }).uid
				: undefined;
	} catch {
		throw invalidUidError();
	}

	if (typeof uid !== 'string' || uid.length === 0) {
		throw invalidUidError();
	}

	return escapeXmlText(uid);
}

function invalidDateError(field: 'start' | 'end'): XmlBuildError {
	return new XmlBuildError(
		'INVALID_DATE',
		'Calendar query dates must be valid Date objects',
		field,
	);
}

function readTimeRangeField(input: CalendarTimeRangeQueryInput, field: 'start' | 'end'): unknown {
	try {
		return typeof input === 'object' && input !== null
			? (input as unknown as Record<'start' | 'end', unknown>)[field]
			: undefined;
	} catch {
		throw invalidDateError(field);
	}
}

function validateDate(value: unknown, field: 'start' | 'end'): ValidatedUtcDate {
	let timestamp: number;

	try {
		timestamp = DATE_GET_TIME.call(value);
	} catch {
		throw invalidDateError(field);
	}

	if (!Number.isFinite(timestamp)) {
		throw invalidDateError(field);
	}

	let year: number;
	let month: number;
	let day: number;
	let hours: number;
	let minutes: number;
	let seconds: number;
	let milliseconds: number;

	try {
		year = DATE_GET_UTC_FULL_YEAR.call(value);
		month = DATE_GET_UTC_MONTH.call(value) + 1;
		day = DATE_GET_UTC_DATE.call(value);
		hours = DATE_GET_UTC_HOURS.call(value);
		minutes = DATE_GET_UTC_MINUTES.call(value);
		seconds = DATE_GET_UTC_SECONDS.call(value);
		milliseconds = DATE_GET_UTC_MILLISECONDS.call(value);
	} catch {
		throw invalidDateError(field);
	}

	if (year < 1 || year > 9999 || milliseconds !== 0) {
		throw new XmlBuildError(
			'INVALID_DATE',
			'Calendar query dates require a four-digit UTC year and zero milliseconds',
			field,
		);
	}

	return { timestamp, year, month, day, hours, minutes, seconds };
}

function formatUtcDate(value: ValidatedUtcDate): string {
	return [
		value.year.toString().padStart(4, '0'),
		value.month.toString().padStart(2, '0'),
		value.day.toString().padStart(2, '0'),
		'T',
		value.hours.toString().padStart(2, '0'),
		value.minutes.toString().padStart(2, '0'),
		value.seconds.toString().padStart(2, '0'),
		'Z',
	].join('');
}

function invalidPropertySetError(): XmlBuildError {
	return new XmlBuildError(
		'INVALID_PROPERTY_SET',
		'PROPFIND requires a non-empty property array',
		'properties',
	);
}

function unknownPropertyError(): XmlBuildError {
	return new XmlBuildError(
		'UNKNOWN_PROPERTY',
		'PROPFIND contains an unknown property',
		'properties',
	);
}

function resolvePropfindProperties(properties: unknown): XmlQualifiedName[] {
	let isArray: boolean;

	try {
		isArray = Array.isArray(properties);
	} catch {
		throw invalidPropertySetError();
	}

	if (!isArray) {
		throw invalidPropertySetError();
	}

	let propertyCount: unknown;
	try {
		propertyCount = (properties as { readonly length?: unknown }).length;
	} catch {
		throw invalidPropertySetError();
	}

	if (
		typeof propertyCount !== 'number' ||
		!Number.isSafeInteger(propertyCount) ||
		propertyCount <= 0
	) {
		throw invalidPropertySetError();
	}

	const qualifiedProperties: XmlQualifiedName[] = [];
	for (let index = 0; index < propertyCount; index++) {
		let property: unknown;

		try {
			property = (properties as readonly unknown[])[index];
		} catch {
			throw unknownPropertyError();
		}

		if (!hasPropfindPropertyName(property)) {
			throw unknownPropertyError();
		}

		qualifiedProperties.push(PROPFIND_PROPERTY_NAMES[property]);
	}

	return qualifiedProperties;
}

const UTC_CALENDAR_TIMEZONE = [
	'BEGIN:VCALENDAR',
	'PRODID:-//n8n-nodes-caldav//EN',
	'VERSION:2.0',
	'BEGIN:VTIMEZONE',
	'TZID:UTC',
	'BEGIN:STANDARD',
	'DTSTART:19700101T000000',
	'TZOFFSETFROM:+0000',
	'TZOFFSETTO:+0000',
	'END:STANDARD',
	'END:VTIMEZONE',
	'END:VCALENDAR',
].join('&#13;\n');

function reportPrefixLines(): string[] {
	return [
		XML_DECLARATION,
		`<${XML_QUALIFIED_NAMES.calendarQuery.qualifiedName} ${rootAttributes(true)}>`,
		`  <${XML_QUALIFIED_NAMES.prop.qualifiedName}>`,
		emptyElement(XML_QUALIFIED_NAMES.getEtag, 2),
		emptyElement(XML_QUALIFIED_NAMES.calendarData, 2),
		`  </${XML_QUALIFIED_NAMES.prop.qualifiedName}>`,
		`  <${XML_QUALIFIED_NAMES.filter.qualifiedName}>`,
		`    <${XML_QUALIFIED_NAMES.compFilter.qualifiedName} name="VCALENDAR">`,
		`      <${XML_QUALIFIED_NAMES.compFilter.qualifiedName} name="VEVENT">`,
	];
}

function reportSuffixLines(includeUtcTimezone = false): string[] {
	return [
		`      </${XML_QUALIFIED_NAMES.compFilter.qualifiedName}>`,
		`    </${XML_QUALIFIED_NAMES.compFilter.qualifiedName}>`,
		`  </${XML_QUALIFIED_NAMES.filter.qualifiedName}>`,
		...(includeUtcTimezone
			? [
					`  <${XML_QUALIFIED_NAMES.timezone.qualifiedName}>${UTC_CALENDAR_TIMEZONE}</${XML_QUALIFIED_NAMES.timezone.qualifiedName}>`,
				]
			: []),
		`</${XML_QUALIFIED_NAMES.calendarQuery.qualifiedName}>`,
	];
}

export function buildPropfindRequest(properties: readonly PropfindPropertyName[]): string {
	const qualifiedProperties = resolvePropfindProperties(properties);
	const includeCalDav = qualifiedProperties.some(({ namespace }) => namespace === 'caldav');

	return [
		XML_DECLARATION,
		`<${XML_QUALIFIED_NAMES.propfind.qualifiedName} ${rootAttributes(includeCalDav)}>`,
		`  <${XML_QUALIFIED_NAMES.prop.qualifiedName}>`,
		...qualifiedProperties.map((property) => emptyElement(property, 2)),
		`  </${XML_QUALIFIED_NAMES.prop.qualifiedName}>`,
		`</${XML_QUALIFIED_NAMES.propfind.qualifiedName}>`,
	].join('\n');
}

export function buildCurrentUserPrincipalPropfind(): string {
	return buildPropfindRequest(CURRENT_USER_PRINCIPAL_PROPERTIES);
}

export function buildCalendarHomeSetPropfind(): string {
	return buildPropfindRequest(CALENDAR_HOME_PROPERTIES);
}

function additionalCollectionProperties(
	properties: readonly PropfindExpandedPropertyName[],
): readonly {
	readonly prefix: string;
	readonly namespaceUri: string;
	readonly localName: string;
}[] {
	const result: { prefix: string; namespaceUri: string; localName: string }[] = [];
	const seen = new Set<string>();

	for (const property of properties) {
		if (
			typeof property !== 'object' ||
			property === null ||
			typeof property.namespaceUri !== 'string' ||
			property.namespaceUri.length === 0 ||
			typeof property.localName !== 'string' ||
			!XML_LOCAL_NAME.test(property.localName)
		) {
			throw unknownPropertyError();
		}

		const key = `{${property.namespaceUri}}${property.localName}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		result.push({
			prefix: `x${result.length}`,
			namespaceUri: property.namespaceUri,
			localName: property.localName,
		});
	}

	return result;
}

export function buildCalendarCollectionListingPropfind(
	additionalProperties: readonly PropfindExpandedPropertyName[] = [],
): string {
	const properties = additionalCollectionProperties(additionalProperties);
	if (properties.length === 0) {
		return buildPropfindRequest(CALENDAR_COLLECTION_PROPERTIES);
	}

	const namespaceDeclarations = properties
		.map(({ prefix, namespaceUri }) => `xmlns:${prefix}="${escapeXmlAttribute(namespaceUri)}"`)
		.join(' ');
	const standardProperties = CALENDAR_COLLECTION_PROPERTIES.map(
		(property) => PROPFIND_PROPERTY_NAMES[property],
	);

	return [
		XML_DECLARATION,
		`<${XML_QUALIFIED_NAMES.propfind.qualifiedName} ${rootAttributes(true)} ${namespaceDeclarations}>`,
		`  <${XML_QUALIFIED_NAMES.prop.qualifiedName}>`,
		...standardProperties.map((property) => emptyElement(property, 2)),
		...properties.map(({ prefix, localName }) => `    <${prefix}:${localName}/>`),
		`  </${XML_QUALIFIED_NAMES.prop.qualifiedName}>`,
		`</${XML_QUALIFIED_NAMES.propfind.qualifiedName}>`,
	].join('\n');
}

export function buildCalendarUidQueryReport(input: CalendarUidQueryInput): string {
	const escapedUid = validateUidInput(input);

	return [
		...reportPrefixLines(),
		`        <${XML_QUALIFIED_NAMES.propFilter.qualifiedName} name="UID">`,
		`          <${XML_QUALIFIED_NAMES.textMatch.qualifiedName} collation="i;octet">${escapedUid}</${XML_QUALIFIED_NAMES.textMatch.qualifiedName}>`,
		`        </${XML_QUALIFIED_NAMES.propFilter.qualifiedName}>`,
		...reportSuffixLines(),
	].join('\n');
}

export function buildCalendarTimeRangeQueryReport(input: CalendarTimeRangeQueryInput): string {
	const start = validateDate(readTimeRangeField(input, 'start'), 'start');
	const end = validateDate(readTimeRangeField(input, 'end'), 'end');

	if (end.timestamp <= start.timestamp) {
		throw new XmlBuildError('INVALID_TIME_RANGE', 'Calendar query end must be later than start');
	}

	const startAttribute = escapeXmlAttribute(formatUtcDate(start));
	const endAttribute = escapeXmlAttribute(formatUtcDate(end));

	return [
		...reportPrefixLines(),
		`        <${XML_QUALIFIED_NAMES.timeRange.qualifiedName} start="${startAttribute}" end="${endAttribute}"/>`,
		...reportSuffixLines(true),
	].join('\n');
}
