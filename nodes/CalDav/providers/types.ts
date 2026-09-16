import type { AbsoluteHttpUrl } from '../transport/url';
import type { DavXmlElement } from '../xml/parser';
import type { PropfindExpandedPropertyName } from '../xml/requests';

export const CalDavProviderId = {
	STANDARD: 'standard',
	ICLOUD: 'icloud',
} as const;

export type CalDavProviderId = (typeof CalDavProviderId)[keyof typeof CalDavProviderId];

export const CalDavEventUidLookupStrategy = Object.freeze({
	CALENDAR_QUERY: 'calendar-query',
	ICLOUD_CANDIDATE_SCAN: 'icloud-candidate-scan',
} as const);

export type CalDavEventUidLookupStrategy =
	(typeof CalDavEventUidLookupStrategy)[keyof typeof CalDavEventUidLookupStrategy];

export interface CalDavProviderContext {
	readonly id: string;
	readonly eventUidLookupStrategy: CalDavEventUidLookupStrategy;
}

export interface CalDavCredentialTargetContext {
	readonly configuredUrl: AbsoluteHttpUrl;
	readonly fromUrl: AbsoluteHttpUrl;
	readonly targetUrl: AbsoluteHttpUrl;
}

export interface CalDavCalendarCollectionPropertyView {
	get(namespaceUri: string, localName: string): readonly DavXmlElement[];
}

export interface CalDavProviderCalendarCollectionMetadata {
	readonly color?: unknown;
	readonly extensions?: unknown;
}

export interface CalDavProviderAdapter {
	readonly id: string;
	readonly eventUidLookupStrategy: CalDavEventUidLookupStrategy;
	readonly calendarCollectionProperties?: readonly PropfindExpandedPropertyName[];
	matchesConfiguredServerUrl(configuredUrl: AbsoluteHttpUrl): boolean;
	allowsCredentialForwarding(context: CalDavCredentialTargetContext): boolean;
	readCalendarCollectionProperties?(
		properties: CalDavCalendarCollectionPropertyView,
	): CalDavProviderCalendarCollectionMetadata;
}

export interface CalDavProviderRegistry {
	select(configuredUrl: AbsoluteHttpUrl): CalDavProviderAdapter;
}
