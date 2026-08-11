import type { AbsoluteHttpUrl } from '../transport/url';

export const CalDavProviderId = {
	STANDARD: 'standard',
	ICLOUD: 'icloud',
} as const;

export type CalDavProviderId = (typeof CalDavProviderId)[keyof typeof CalDavProviderId];

export interface CalDavCredentialTargetContext {
	readonly configuredUrl: AbsoluteHttpUrl;
	readonly fromUrl: AbsoluteHttpUrl;
	readonly targetUrl: AbsoluteHttpUrl;
}

export interface CalDavProviderAdapter {
	readonly id: string;
	matchesConfiguredServerUrl(configuredUrl: AbsoluteHttpUrl): boolean;
	allowsCredentialForwarding(context: CalDavCredentialTargetContext): boolean;
}

export interface CalDavProviderRegistry {
	select(configuredUrl: AbsoluteHttpUrl): CalDavProviderAdapter;
}
