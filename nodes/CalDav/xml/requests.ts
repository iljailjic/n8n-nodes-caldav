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
	| 'supportedCalendarComponentSet'
	| 'getEtag';

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
	'supportedCalendarComponentSet',
] = Object.freeze([
	'resourceType',
	'displayName',
	'calendarDescription',
	'supportedCalendarComponentSet',
]);

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

const PROPFIND_PROPERTY_NAMES: Readonly<Record<PropfindPropertyName, XmlQualifiedName>> =
	Object.freeze({
		currentUserPrincipal: XML_QUALIFIED_NAMES.currentUserPrincipal,
		calendarHomeSet: XML_QUALIFIED_NAMES.calendarHomeSet,
		resourceType: XML_QUALIFIED_NAMES.resourceType,
		displayName: XML_QUALIFIED_NAMES.displayName,
		calendarDescription: XML_QUALIFIED_NAMES.calendarDescription,
		supportedCalendarComponentSet: XML_QUALIFIED_NAMES.supportedCalendarComponentSet,
		getEtag: XML_QUALIFIED_NAMES.getEtag,
	});

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

function validateUidInput(input: CalendarUidQueryInput): string {
	if (
		typeof input !== 'object' ||
		input === null ||
		typeof input.uid !== 'string' ||
		input.uid.length === 0
	) {
		throw new XmlBuildError('INVALID_UID', 'Calendar UID must be a non-empty string', 'uid');
	}

	return escapeXmlText(input.uid);
}

function validateDate(value: unknown, field: 'start' | 'end'): Date {
	if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
		throw new XmlBuildError(
			'INVALID_DATE',
			'Calendar query dates must be valid Date objects',
			field,
		);
	}

	const year = value.getUTCFullYear();
	if (year < 0 || year > 9999 || value.getUTCMilliseconds() !== 0) {
		throw new XmlBuildError(
			'INVALID_DATE',
			'Calendar query dates require a four-digit UTC year and zero milliseconds',
			field,
		);
	}

	return value;
}

function formatUtcDate(value: Date): string {
	return [
		value.getUTCFullYear().toString().padStart(4, '0'),
		(value.getUTCMonth() + 1).toString().padStart(2, '0'),
		value.getUTCDate().toString().padStart(2, '0'),
		'T',
		value.getUTCHours().toString().padStart(2, '0'),
		value.getUTCMinutes().toString().padStart(2, '0'),
		value.getUTCSeconds().toString().padStart(2, '0'),
		'Z',
	].join('');
}

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

function reportSuffixLines(): string[] {
	return [
		`      </${XML_QUALIFIED_NAMES.compFilter.qualifiedName}>`,
		`    </${XML_QUALIFIED_NAMES.compFilter.qualifiedName}>`,
		`  </${XML_QUALIFIED_NAMES.filter.qualifiedName}>`,
		`</${XML_QUALIFIED_NAMES.calendarQuery.qualifiedName}>`,
	];
}

export function buildPropfindRequest(properties: readonly PropfindPropertyName[]): string {
	if (!Array.isArray(properties) || properties.length === 0) {
		throw new XmlBuildError('INVALID_PROPERTY_SET', 'PROPFIND requires a non-empty property array');
	}

	const qualifiedProperties = properties.map((property) => {
		if (!hasPropfindPropertyName(property)) {
			throw new XmlBuildError('UNKNOWN_PROPERTY', 'PROPFIND contains an unknown property');
		}

		return PROPFIND_PROPERTY_NAMES[property];
	});
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

export function buildCalendarCollectionListingPropfind(): string {
	return buildPropfindRequest(CALENDAR_COLLECTION_PROPERTIES);
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
	const start = validateDate(
		typeof input === 'object' && input !== null ? input.start : undefined,
		'start',
	);
	const end = validateDate(
		typeof input === 'object' && input !== null ? input.end : undefined,
		'end',
	);

	if (end.getTime() <= start.getTime()) {
		throw new XmlBuildError('INVALID_TIME_RANGE', 'Calendar query end must be later than start');
	}

	const startAttribute = escapeXmlAttribute(formatUtcDate(start));
	const endAttribute = escapeXmlAttribute(formatUtcDate(end));

	return [
		...reportPrefixLines(),
		`        <${XML_QUALIFIED_NAMES.timeRange.qualifiedName} start="${startAttribute}" end="${endAttribute}"/>`,
		...reportSuffixLines(),
	].join('\n');
}
