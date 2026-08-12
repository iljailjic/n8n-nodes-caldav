import { standardCalDavProviderAdapter } from '../providers/standard';
import type {
	CalDavCalendarCollectionPropertyView,
	CalDavProviderAdapter,
	CalDavProviderCalendarCollectionMetadata,
} from '../providers/types';
import { CalDavMethod } from '../transport/http';
import type { CalDavTransport } from '../transport/http';
import { normalizeCalendarCollectionUrl, resolveCalDavHref } from '../transport/url';
import type { AbsoluteHttpUrl } from '../transport/url';
import { parseDavMultiStatus } from '../xml/parser';
import type { DavProperty, DavPropertyResponse, DavXmlContent, DavXmlElement } from '../xml/parser';
import { buildCalendarCollectionListingPropfind } from '../xml/requests';

export interface CalendarCollection {
	readonly url: AbsoluteHttpUrl;
	readonly displayName?: string;
	readonly description?: string;
	readonly timezone?: string;
	readonly color?: string;
	readonly supportedComponents?: readonly string[];
	readonly canRead: boolean | null;
	readonly canWrite: boolean | null;
	readonly extensions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export const CalendarCollectionDiscoveryFailureCode = {
	INVALID_RESPONSE: 'INVALID_CALENDAR_COLLECTION_RESPONSE',
	AMBIGUOUS_PROPERTY: 'AMBIGUOUS_CALENDAR_COLLECTION_PROPERTY',
} as const;
export type CalendarCollectionDiscoveryFailureCode =
	(typeof CalendarCollectionDiscoveryFailureCode)[keyof typeof CalendarCollectionDiscoveryFailureCode];

const ERROR_MESSAGES: Readonly<Record<CalendarCollectionDiscoveryFailureCode, string>> = {
	INVALID_CALENDAR_COLLECTION_RESPONSE:
		'The CalDAV server returned an invalid calendar-collection response.',
	AMBIGUOUS_CALENDAR_COLLECTION_PROPERTY:
		'The CalDAV server returned an ambiguous calendar-collection property.',
};

export class CalDavCalendarCollectionDiscoveryError extends Error {
	readonly code: CalendarCollectionDiscoveryFailureCode;

	constructor(code: CalendarCollectionDiscoveryFailureCode) {
		super(ERROR_MESSAGES[code]);
		this.name = 'CalDavCalendarCollectionDiscoveryError';
		this.code = code;
	}
}

const DAV_NAMESPACE = 'DAV:';
const CALDAV_NAMESPACE = 'urn:ietf:params:xml:ns:caldav';
const MAX_EXTENSION_DEPTH = 32;
const UNSAFE_EXTENSION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

interface SelectedProperties {
	readonly resourceType?: DavProperty;
	readonly displayName?: DavProperty;
	readonly description?: DavProperty;
	readonly timezone?: DavProperty;
	readonly componentSet?: DavProperty;
	readonly privilegeSet?: DavProperty;
	readonly componentSetFailedNon404: boolean;
	readonly successful: readonly DavProperty[];
}

function invalidResponse(): never {
	throw new CalDavCalendarCollectionDiscoveryError(
		CalendarCollectionDiscoveryFailureCode.INVALID_RESPONSE,
	);
}

function ambiguousProperty(): never {
	throw new CalDavCalendarCollectionDiscoveryError(
		CalendarCollectionDiscoveryFailureCode.AMBIGUOUS_PROPERTY,
	);
}

function isExpandedName(element: DavXmlElement, namespaceUri: string, localName: string): boolean {
	return element.name.namespaceUri === namespaceUri && element.name.localName === localName;
}

function expandedNameKey(namespaceUri: string | null, localName: string): string {
	return `{${namespaceUri ?? ''}}${localName}`;
}

function isXmlWhitespace(value: string): boolean {
	for (const character of value) {
		if (character !== ' ' && character !== '\t' && character !== '\n' && character !== '\r') {
			return false;
		}
	}
	return true;
}

function assertNoAttributes(element: DavXmlElement): void {
	if (element.attributes.length !== 0) {
		invalidResponse();
	}
}

function assertEmptyElement(element: DavXmlElement): void {
	assertNoAttributes(element);
	for (const child of element.children) {
		if (child.kind === 'element' || !isXmlWhitespace(child.value)) {
			invalidResponse();
		}
	}
}

function readText(element: DavXmlElement): string {
	assertNoAttributes(element);
	let value = '';
	for (const child of element.children) {
		if (child.kind === 'element') {
			return invalidResponse();
		}
		value += child.value;
	}
	return value;
}

function directElements(element: DavXmlElement): DavXmlElement[] {
	const elements: DavXmlElement[] = [];
	for (const child of element.children) {
		if (child.kind === 'text') {
			if (!isXmlWhitespace(child.value)) {
				invalidResponse();
			}
			continue;
		}
		elements.push(child);
	}
	return elements;
}

function isCalendarResourceType(property: DavProperty): boolean {
	assertNoAttributes(property);
	let collection = false;
	let calendar = false;
	for (const child of directElements(property)) {
		assertEmptyElement(child);
		collection ||= isExpandedName(child, DAV_NAMESPACE, 'collection');
		calendar ||= isExpandedName(child, CALDAV_NAMESPACE, 'calendar');
	}
	return collection && calendar;
}

function readSupportedComponents(property: DavProperty): readonly string[] {
	assertNoAttributes(property);
	const components: string[] = [];
	const seen = new Set<string>();

	for (const child of directElements(property)) {
		if (!isExpandedName(child, CALDAV_NAMESPACE, 'comp') || child.attributes.length !== 1) {
			return invalidResponse();
		}
		const attribute = child.attributes[0];
		if (
			attribute.name.namespaceUri !== null ||
			attribute.name.localName !== 'name' ||
			attribute.value.length === 0
		) {
			return invalidResponse();
		}
		for (const content of child.children) {
			if (content.kind === 'element' || !isXmlWhitespace(content.value)) {
				return invalidResponse();
			}
		}

		const identity = attribute.value.toUpperCase();
		if (!seen.has(identity)) {
			seen.add(identity);
			components.push(attribute.value);
		}
	}

	return Object.freeze(components);
}

function readPrivileges(property: DavProperty): { canRead: boolean; canWrite: boolean } {
	assertNoAttributes(property);
	let canRead = false;
	let canWrite = false;

	for (const privilege of directElements(property)) {
		if (!isExpandedName(privilege, DAV_NAMESPACE, 'privilege')) {
			return invalidResponse();
		}
		assertNoAttributes(privilege);
		const names = directElements(privilege);
		if (names.length !== 1) {
			return invalidResponse();
		}
		const name = names[0];
		assertEmptyElement(name);
		if (name.name.namespaceUri === DAV_NAMESPACE) {
			canRead ||= name.name.localName === 'read' || name.name.localName === 'all';
			canWrite ||= name.name.localName === 'write' || name.name.localName === 'all';
		}
	}

	return { canRead, canWrite };
}

function recognizedPropertyKey(
	property: DavProperty,
): keyof Omit<SelectedProperties, 'componentSetFailedNon404' | 'successful'> | undefined {
	if (isExpandedName(property, DAV_NAMESPACE, 'resourcetype')) return 'resourceType';
	if (isExpandedName(property, DAV_NAMESPACE, 'displayname')) return 'displayName';
	if (isExpandedName(property, CALDAV_NAMESPACE, 'calendar-description')) return 'description';
	if (isExpandedName(property, CALDAV_NAMESPACE, 'calendar-timezone')) return 'timezone';
	if (isExpandedName(property, CALDAV_NAMESPACE, 'supported-calendar-component-set')) {
		return 'componentSet';
	}
	if (isExpandedName(property, DAV_NAMESPACE, 'current-user-privilege-set')) {
		return 'privilegeSet';
	}
	return undefined;
}

function selectProperties(response: DavPropertyResponse): SelectedProperties {
	const selected: Partial<Record<keyof SelectedProperties, DavProperty>> = {};
	const successful: DavProperty[] = [];
	let componentSetFailedNon404 = false;

	for (const propstat of response.propstats) {
		for (const property of propstat.properties) {
			const key = recognizedPropertyKey(property);
			if (!propstat.status.isSuccessful) {
				if (key === 'componentSet' && propstat.status.code !== 404) {
					componentSetFailedNon404 = true;
				}
				continue;
			}

			successful.push(property);
			if (key !== undefined) {
				if (selected[key] !== undefined) {
					ambiguousProperty();
				}
				selected[key] = property;
			}
		}
	}

	return {
		...(selected as Omit<SelectedProperties, 'componentSetFailedNon404' | 'successful'>),
		componentSetFailedNon404,
		successful,
	};
}

function cloneContent(content: DavXmlContent): DavXmlContent {
	if (content.kind === 'text') {
		return Object.freeze({ kind: 'text' as const, value: content.value });
	}
	return cloneElement(content);
}

function cloneElement(element: DavXmlElement): DavXmlElement {
	return Object.freeze({
		kind: 'element' as const,
		name: Object.freeze({ ...element.name }),
		attributes: Object.freeze(
			element.attributes.map((attribute) =>
				Object.freeze({ name: Object.freeze({ ...attribute.name }), value: attribute.value }),
			),
		),
		children: Object.freeze(element.children.map(cloneContent)),
	});
}

function propertyView(properties: readonly DavProperty[]): CalDavCalendarCollectionPropertyView {
	const propertyMap = new Map<string, readonly DavXmlElement[]>();
	for (const property of properties) {
		const key = expandedNameKey(property.name.namespaceUri, property.name.localName);
		propertyMap.set(key, Object.freeze([...(propertyMap.get(key) ?? []), cloneElement(property)]));
	}

	return Object.freeze({
		get(namespaceUri: string, localName: string): readonly DavXmlElement[] {
			return propertyMap.get(expandedNameKey(namespaceUri, localName)) ?? Object.freeze([]);
		},
	});
}

function sanitizeJson(value: unknown, depth = 0): unknown {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') {
		return value;
	}
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : undefined;
	}
	if (depth >= MAX_EXTENSION_DEPTH || typeof value !== 'object') {
		return undefined;
	}
	if (Array.isArray(value)) {
		const result: unknown[] = [];
		for (const entry of value) {
			const sanitized = sanitizeJson(entry, depth + 1);
			if (sanitized === undefined) return undefined;
			result.push(sanitized);
		}
		return Object.freeze(result);
	}
	if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
		return undefined;
	}

	const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
	for (const [key, entry] of Object.entries(value)) {
		if (UNSAFE_EXTENSION_KEYS.has(key)) return undefined;
		const sanitized = sanitizeJson(entry, depth + 1);
		if (sanitized === undefined) return undefined;
		result[key] = sanitized;
	}
	return Object.freeze(result);
}

function providerMetadata(
	provider: CalDavProviderAdapter,
	properties: readonly DavProperty[],
): CalDavProviderCalendarCollectionMetadata {
	if (provider.readCalendarCollectionProperties === undefined) {
		return {};
	}
	try {
		return provider.readCalendarCollectionProperties(propertyView(properties));
	} catch {
		return invalidResponse();
	}
}

function providerFields(
	provider: CalDavProviderAdapter,
	properties: readonly DavProperty[],
): Pick<CalendarCollection, 'color' | 'extensions'> {
	for (const requested of provider.calendarCollectionProperties ?? []) {
		if (
			properties.filter(
				(property) =>
					property.name.namespaceUri === requested.namespaceUri &&
					property.name.localName === requested.localName,
			).length > 1
		) {
			ambiguousProperty();
		}
	}
	const metadata = providerMetadata(provider, properties);
	const color = typeof metadata.color === 'string' ? metadata.color : undefined;
	const sanitized = sanitizeJson(metadata.extensions);
	const providerIdIsSafe =
		provider.id.length > 0 &&
		!UNSAFE_EXTENSION_KEYS.has(provider.id) &&
		typeof provider.id === 'string';
	const extensions =
		providerIdIsSafe &&
		sanitized !== undefined &&
		typeof sanitized === 'object' &&
		sanitized !== null &&
		!Array.isArray(sanitized)
			? Object.freeze({ [provider.id]: sanitized as Readonly<Record<string, unknown>> })
			: undefined;

	return {
		...(color === undefined ? {} : { color }),
		...(extensions === undefined ? {} : { extensions }),
	};
}

function parseCollection(
	response: DavPropertyResponse,
	effectiveUrl: string,
	provider: CalDavProviderAdapter,
): CalendarCollection | undefined {
	const href = response.hrefs[0];
	if (href.length === 0) {
		return invalidResponse();
	}
	const url = normalizeCalendarCollectionUrl(resolveCalDavHref(effectiveUrl, href));
	const selected = selectProperties(response);
	const isCalendar =
		selected.resourceType === undefined ? false : isCalendarResourceType(selected.resourceType);
	const displayName =
		selected.displayName === undefined ? undefined : readText(selected.displayName);
	const description =
		selected.description === undefined ? undefined : readText(selected.description);
	const timezone = selected.timezone === undefined ? undefined : readText(selected.timezone);
	let supportedComponents: readonly string[] | undefined;
	if (selected.componentSet !== undefined) {
		supportedComponents = readSupportedComponents(selected.componentSet);
	}
	const privileges =
		selected.privilegeSet === undefined
			? { canRead: null, canWrite: null }
			: readPrivileges(selected.privilegeSet);

	if (
		!isCalendar ||
		(supportedComponents !== undefined &&
			!supportedComponents.some((component) => component.toUpperCase() === 'VEVENT')) ||
		(supportedComponents === undefined && selected.componentSetFailedNon404)
	) {
		return undefined;
	}

	return Object.freeze({
		url,
		...(displayName === undefined ? {} : { displayName }),
		...(description === undefined ? {} : { description }),
		...(timezone === undefined ? {} : { timezone }),
		...(supportedComponents === undefined ? {} : { supportedComponents }),
		...privileges,
		...providerFields(provider, selected.successful),
	});
}

export async function discoverCalendarCollections(
	transport: CalDavTransport,
	calendarHomeUrl: AbsoluteHttpUrl,
	provider: CalDavProviderAdapter = standardCalDavProviderAdapter,
): Promise<readonly CalendarCollection[]> {
	const response = await transport.request({
		method: CalDavMethod.PROPFIND,
		url: calendarHomeUrl,
		headers: {
			Depth: '1',
			'Content-Type': 'application/xml; charset=utf-8',
		},
		body: buildCalendarCollectionListingPropfind(provider.calendarCollectionProperties),
	});

	if (response.statusCode !== 207) {
		return invalidResponse();
	}

	const multiStatus = parseDavMultiStatus(response.body.toString('utf8'));
	const results: CalendarCollection[] = [];
	const seen = new Set<string>();
	for (const davResponse of multiStatus.responses) {
		if (davResponse.kind !== 'propstat') {
			return invalidResponse();
		}
		const collection = parseCollection(davResponse, response.effectiveUrl, provider);
		if (collection !== undefined && !seen.has(collection.url)) {
			seen.add(collection.url);
			results.push(collection);
		}
	}

	return Object.freeze(results);
}
