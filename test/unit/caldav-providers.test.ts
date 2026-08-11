import { describe, expect, it, vi } from 'vitest';

import {
	iCloudCalDavProviderAdapter,
	isTrustedICloudCalDavUrl,
} from '../../nodes/CalDav/providers/icloud';
import {
	createCalDavProviderRegistry,
	defaultCalDavProviderRegistry,
} from '../../nodes/CalDav/providers/registry';
import { standardCalDavProviderAdapter } from '../../nodes/CalDav/providers/standard';
import { CalDavProviderId } from '../../nodes/CalDav/providers/types';
import type { CalDavProviderAdapter } from '../../nodes/CalDav/providers/types';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';

const absoluteUrl = validateAbsoluteHttpUrl;

describe('CalDAV provider adapters', () => {
	it('exports the fixed provider identifiers', () => {
		expect(CalDavProviderId).toEqual({ STANDARD: 'standard', ICLOUD: 'icloud' });
		expect(standardCalDavProviderAdapter.id).toBe('standard');
		expect(iCloudCalDavProviderAdapter.id).toBe('icloud');
	});

	it.each([
		'https://caldav.icloud.com/',
		'https://CALDAV.ICLOUD.COM/',
		'https://caldav.icloud.com./',
		'https://caldav.icloud.com:443/',
		'https://p00-caldav.icloud.com/',
		'https://p42-caldav.icloud.com/account/',
		'https://p99-caldav.icloud.com/',
	])('trusts the exact iCloud CalDAV HTTPS:443 grammar: %s', (input) => {
		expect(isTrustedICloudCalDavUrl(absoluteUrl(input))).toBe(true);
	});

	it.each([
		'http://caldav.icloud.com/',
		'https://caldav.icloud.com:444/',
		'https://icloud.com/',
		'https://www.icloud.com/',
		'https://contacts.icloud.com/',
		'https://x.caldav.icloud.com/',
		'https://caldav.icloud.com.example.test/',
		'https://caldav.icloud.com../',
		'https://p0-caldav.icloud.com/',
		'https://p000-caldav.icloud.com/',
		'https://pab-caldav.icloud.com/',
		'https://127.0.0.1/',
		'https://[::1]/',
		'https://caldаv.icloud.com/',
	])('rejects untrusted and lookalike iCloud targets: %s', (input) => {
		expect(isTrustedICloudCalDavUrl(absoluteUrl(input))).toBe(false);
	});

	it.each([
		['https://example.test/root', 'https://EXAMPLE.TEST:443/other', true],
		['http://example.test/root', 'http://example.test:80/other', true],
		['https://example.test./root', 'https://example.test/other', true],
		['https://example.test/', 'https://other.test/', false],
		['https://example.test/', 'https://example.test:444/', false],
		['http://example.test/', 'https://example.test/', false],
	] as const)('applies provider-neutral same-origin policy: %s -> %s', (from, to, expected) => {
		expect(
			standardCalDavProviderAdapter.allowsCredentialForwarding({
				configuredUrl: absoluteUrl(from),
				fromUrl: absoluteUrl(from),
				targetUrl: absoluteUrl(to),
			}),
		).toBe(expected);
		expect(standardCalDavProviderAdapter.matchesConfiguredServerUrl(absoluteUrl(from))).toBe(false);
	});

	it('allows only trusted iCloud cross-host transitions', () => {
		const configuredUrl = absoluteUrl('https://caldav.icloud.com/account/');

		expect(
			iCloudCalDavProviderAdapter.allowsCredentialForwarding({
				configuredUrl,
				fromUrl: configuredUrl,
				targetUrl: absoluteUrl('https://p42-caldav.icloud.com/account/'),
			}),
		).toBe(true);
		expect(
			iCloudCalDavProviderAdapter.allowsCredentialForwarding({
				configuredUrl,
				fromUrl: absoluteUrl('https://lookalike.example/'),
				targetUrl: absoluteUrl('https://p42-caldav.icloud.com/account/'),
			}),
		).toBe(false);
	});
});

describe('CalDAV provider registry', () => {
	function extension(id: string, matches: boolean): CalDavProviderAdapter {
		return {
			id,
			matchesConfiguredServerUrl: vi.fn().mockReturnValue(matches),
			allowsCredentialForwarding: vi.fn().mockReturnValue(false),
		};
	}

	it('evaluates a snapshotted extension list in order and falls back to standard', () => {
		const first = extension('first', false);
		const second = extension('second', true);
		const laterMutation = extension('later-mutation', true);
		const extensions = [first, second];
		const registry = createCalDavProviderRegistry(extensions);
		extensions.unshift(laterMutation);

		expect(registry.select(absoluteUrl('https://example.test/'))).toBe(second);
		expect(laterMutation.matchesConfiguredServerUrl).not.toHaveBeenCalled();
		expect(createCalDavProviderRegistry().select(absoluteUrl('https://example.test/'))).toBe(
			standardCalDavProviderAdapter,
		);
		expect(Object.isFrozen(registry)).toBe(true);
	});

	it.each([
		[extension('duplicate', false), extension('duplicate', true)],
		[extension('standard', false)],
	])('rejects duplicate adapter IDs', (...extensions) => {
		expect(() => createCalDavProviderRegistry(extensions)).toThrow(
			'Duplicate CalDAV provider adapter ID.',
		);
	});

	it('fixes iCloud as the only default extension', () => {
		expect(defaultCalDavProviderRegistry.select(absoluteUrl('https://caldav.icloud.com/'))).toBe(
			iCloudCalDavProviderAdapter,
		);
		expect(defaultCalDavProviderRegistry.select(absoluteUrl('https://example.test/'))).toBe(
			standardCalDavProviderAdapter,
		);
	});
});
