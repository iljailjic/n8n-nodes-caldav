import type { AbsoluteHttpUrl } from '../transport/url';
import { iCloudCalDavProviderAdapter } from './icloud';
import { standardCalDavProviderAdapter } from './standard';
import type { CalDavProviderAdapter, CalDavProviderRegistry } from './types';

export function createCalDavProviderRegistry(
	extensions: readonly CalDavProviderAdapter[] = [],
): CalDavProviderRegistry {
	const snapshot = Object.freeze([...extensions]);
	const adapterIds = new Set<string>([standardCalDavProviderAdapter.id]);

	for (const extension of snapshot) {
		if (adapterIds.has(extension.id)) {
			throw new Error('Duplicate CalDAV provider adapter ID.');
		}
		adapterIds.add(extension.id);
	}

	return Object.freeze({
		select(configuredUrl: AbsoluteHttpUrl) {
			return (
				snapshot.find((extension) => extension.matchesConfiguredServerUrl(configuredUrl)) ??
				standardCalDavProviderAdapter
			);
		},
	});
}

export const defaultCalDavProviderRegistry: CalDavProviderRegistry = createCalDavProviderRegistry([
	iCloudCalDavProviderAdapter,
]);
