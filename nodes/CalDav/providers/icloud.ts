import type { AbsoluteHttpUrl } from '../transport/url';
import { standardCalDavProviderAdapter } from './standard';
import {
	CalDavProviderId,
	type CalDavCredentialTargetContext,
	type CalDavProviderAdapter,
} from './types';

const ICLOUD_CALDAV_HOSTNAME = /^(?:caldav|p[0-9]{2}-caldav)\.icloud\.com$/;

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
	matchesConfiguredServerUrl: isTrustedICloudCalDavUrl,
	allowsCredentialForwarding: (context: CalDavCredentialTargetContext): boolean =>
		standardCalDavProviderAdapter.allowsCredentialForwarding(context) ||
		(isTrustedICloudCalDavUrl(context.configuredUrl) &&
			isTrustedICloudCalDavUrl(context.fromUrl) &&
			isTrustedICloudCalDavUrl(context.targetUrl)),
});
