import type { AbsoluteHttpUrl } from '../transport/url';
import {
	CalDavProviderId,
	type CalDavCredentialTargetContext,
	type CalDavProviderAdapter,
} from './types';

function normalizedHostname(url: URL): string {
	const hostname = url.hostname.toLowerCase();
	return hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
}

function effectivePort(url: URL): string {
	if (url.port.length > 0) {
		return url.port;
	}

	return url.protocol === 'https:' ? '443' : '80';
}

function isSameOrigin(left: AbsoluteHttpUrl, right: AbsoluteHttpUrl): boolean {
	const leftUrl = new URL(left);
	const rightUrl = new URL(right);

	return (
		leftUrl.protocol === rightUrl.protocol &&
		normalizedHostname(leftUrl) === normalizedHostname(rightUrl) &&
		effectivePort(leftUrl) === effectivePort(rightUrl)
	);
}

export const standardCalDavProviderAdapter: CalDavProviderAdapter = Object.freeze({
	id: CalDavProviderId.STANDARD,
	matchesConfiguredServerUrl: (): boolean => false,
	allowsCredentialForwarding: ({
		configuredUrl,
		targetUrl,
	}: CalDavCredentialTargetContext): boolean => isSameOrigin(configuredUrl, targetUrl),
});
