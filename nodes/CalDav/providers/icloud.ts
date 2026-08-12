import type { AbsoluteHttpUrl } from '../transport/url';
import type { DavXmlElement } from '../xml/parser';
import { standardCalDavProviderAdapter } from './standard';
import {
	CalDavProviderId,
	type CalDavCalendarCollectionPropertyView,
	type CalDavCredentialTargetContext,
	type CalDavProviderAdapter,
	type CalDavProviderCalendarCollectionMetadata,
} from './types';

const ICLOUD_CALDAV_HOSTNAME = /^(?:caldav|p[0-9]{2}-caldav)\.icloud\.com$/;
const ICLOUD_CALENDAR_NAMESPACE = 'http://apple.com/ns/ical/';
const ICLOUD_CALENDAR_COLOR = Object.freeze({
	namespaceUri: ICLOUD_CALENDAR_NAMESPACE,
	localName: 'calendar-color',
});

function readText(element: DavXmlElement): string {
	if (element.attributes.length !== 0) {
		throw new Error('Invalid iCloud calendar property.');
	}

	let value = '';
	for (const child of element.children) {
		if (child.kind === 'element') {
			throw new Error('Invalid iCloud calendar property.');
		}
		value += child.value;
	}
	return value;
}

function readCalendarCollectionProperties(
	properties: CalDavCalendarCollectionPropertyView,
): CalDavProviderCalendarCollectionMetadata {
	const colors = properties.get(ICLOUD_CALENDAR_NAMESPACE, 'calendar-color');
	if (colors.length === 0) {
		return {};
	}
	if (colors.length > 1) {
		throw new Error('Ambiguous iCloud calendar property.');
	}

	return { color: readText(colors[0]) };
}

function normalizedHostname(url: URL): string {
	const hostname = url.hostname.toLowerCase();
	return hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
}

export function isTrustedICloudCalDavUrl(url: AbsoluteHttpUrl): boolean {
	const parsedUrl = new URL(url);

	return (
		parsedUrl.protocol === 'https:' &&
		(parsedUrl.port.length === 0 || parsedUrl.port === '443') &&
		ICLOUD_CALDAV_HOSTNAME.test(normalizedHostname(parsedUrl))
	);
}

export const iCloudCalDavProviderAdapter: CalDavProviderAdapter = Object.freeze({
	id: CalDavProviderId.ICLOUD,
	calendarCollectionProperties: Object.freeze([ICLOUD_CALENDAR_COLOR]),
	matchesConfiguredServerUrl: isTrustedICloudCalDavUrl,
	allowsCredentialForwarding: (context: CalDavCredentialTargetContext): boolean =>
		standardCalDavProviderAdapter.allowsCredentialForwarding(context) ||
		(isTrustedICloudCalDavUrl(context.configuredUrl) &&
			isTrustedICloudCalDavUrl(context.fromUrl) &&
			isTrustedICloudCalDavUrl(context.targetUrl)),
	readCalendarCollectionProperties,
});
