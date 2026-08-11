import { describe, expect, it } from 'vitest';

import {
	CalDavUrlErrorCode,
	CalDavUrlValidationError,
	joinCalendarCollectionUrl,
	resolveCalDavHref,
	validateAbsoluteHttpUrl,
} from '../../nodes/CalDav/transport/url';

type ExpectedErrorCode = CalDavUrlValidationError['code'];

function expectUrlError(operation: () => unknown, code: ExpectedErrorCode): void {
	try {
		operation();
	} catch (error) {
		expect(error).toBeInstanceOf(CalDavUrlValidationError);
		expect((error as CalDavUrlValidationError).code).toBe(code);
		return;
	}

	throw new Error('Expected URL validation to fail');
}

describe('CalDavUrlErrorCode', () => {
	it('exports exactly the accepted typed error codes', () => {
		expect(CalDavUrlErrorCode).toEqual({
			MALFORMED_URL: 'MALFORMED_URL',
			MALFORMED_PERCENT_ENCODING: 'MALFORMED_PERCENT_ENCODING',
			UNSUPPORTED_SCHEME: 'UNSUPPORTED_SCHEME',
			USERINFO_NOT_ALLOWED: 'USERINFO_NOT_ALLOWED',
			FRAGMENT_NOT_ALLOWED: 'FRAGMENT_NOT_ALLOWED',
			DOT_SEGMENT_NOT_ALLOWED: 'DOT_SEGMENT_NOT_ALLOWED',
			INSECURE_PROTOCOL_DOWNGRADE: 'INSECURE_PROTOCOL_DOWNGRADE',
			INVALID_RESOURCE_NAME: 'INVALID_RESOURCE_NAME',
		});
	});
});

describe('validateAbsoluteHttpUrl', () => {
	it.each([
		['HTTPS://EXAMPLE.COM:443/a', 'https://example.com/a'],
		['https://測試/☃ x', 'https://xn--g6w251d/%E2%98%83%20x'],
		[
			'https://example.test/cal/a%2Fb/%20/%E2%98%83/',
			'https://example.test/cal/a%2Fb/%20/%E2%98%83/',
		],
		[
			'https://example.test/a space/雪/%2eprofile',
			'https://example.test/a%20space/%E9%9B%AA/%2eprofile',
		],
	] as const)('canonicalizes %s', (input, expected) => {
		expect(validateAbsoluteHttpUrl(input)).toBe(expected);
	});

	it.each([
		['ftp://example.test/a', 'UNSUPPORTED_SCHEME'],
		['mailto:user@example.test', 'UNSUPPORTED_SCHEME'],
		['/relative/path', 'MALFORMED_URL'],
		['https://', 'MALFORMED_URL'],
		['https:///example.test/path', 'MALFORMED_URL'],
		['not a url', 'MALFORMED_URL'],
	] as const)('rejects invalid absolute input %s', (input, code) => {
		expectUrlError(() => validateAbsoluteHttpUrl(input), code);
	});

	it.each([
		'https://user@example.test/private',
		'https://user:password@example.test/private',
		'https://@example.test/private',
	])('rejects userinfo in %s', (input) => {
		expectUrlError(() => validateAbsoluteHttpUrl(input), 'USERINFO_NOT_ALLOWED');
	});

	it('does not disclose rejected URL data in errors', () => {
		const input = 'https://private-user:private-password@example.test/private-path?secret=value';

		try {
			validateAbsoluteHttpUrl(input);
		} catch (error) {
			expect(error).toBeInstanceOf(CalDavUrlValidationError);
			const message = (error as CalDavUrlValidationError).message;
			expect(message).not.toContain('private-user');
			expect(message).not.toContain('private-password');
			expect(message).not.toContain('private-path');
			expect(message).not.toContain('secret');
			return;
		}

		throw new Error('Expected URL validation to fail');
	});

	it.each(['https://example.test/a#section', 'https://example.test/#'])(
		'rejects fragments in %s',
		(input) => {
			expectUrlError(() => validateAbsoluteHttpUrl(input), 'FRAGMENT_NOT_ALLOWED');
		},
	);

	it('preserves an encoded fragment delimiter', () => {
		expect(validateAbsoluteHttpUrl('https://example.test/a%23b')).toBe(
			'https://example.test/a%23b',
		);
	});

	it.each(['.', '..', '%2e', '.%2e', '%2e.', '%2e%2e', '%2E%2E'])(
		'rejects a literal or encoded dot path segment %s',
		(segment) => {
			expectUrlError(
				() => validateAbsoluteHttpUrl(`https://example.test/safe/${segment}/resource`),
				'DOT_SEGMENT_NOT_ALLOWED',
			);
		},
	);

	it.each(['%', '%2', '%GG'])('rejects malformed percent escape %s', (escape) => {
		expectUrlError(
			() => validateAbsoluteHttpUrl(`https://example.test/resource${escape}`),
			'MALFORMED_PERCENT_ENCODING',
		);
	});

	it.each([
		' https://example.test/a',
		'https://example.test/a\n',
		'https://example.test/a\tb',
		'https://example.test/a\\b',
	])('rejects parser-normalized whitespace, controls, or reverse solidus in %j', (input) => {
		expectUrlError(() => validateAbsoluteHttpUrl(input), 'MALFORMED_URL');
	});
});

describe('resolveCalDavHref', () => {
	const effectiveResponseUrl = 'https://www.icloud.com/caldav/account/principal/?old=1';

	it.each([
		['/account/calendars/work/', 'https://www.icloud.com/account/calendars/work/'],
		['calendar/a%2Fb', 'https://www.icloud.com/caldav/account/principal/calendar/a%2Fb'],
		[
			'//p42-caldav.icloud.com/account/calendars/',
			'https://p42-caldav.icloud.com/account/calendars/',
		],
		['https://calendar.example.test/shared/%20/', 'https://calendar.example.test/shared/%20/'],
	] as const)('resolves %s against the effective response URL', (href, expected) => {
		expect(resolveCalDavHref(effectiveResponseUrl, href)).toBe(expected);
	});

	it('uses the effective iCloud partition host for relative hrefs', () => {
		expect(
			resolveCalDavHref('https://p42-caldav.icloud.com/account/principal/', 'calendars/work/'),
		).toBe('https://p42-caldav.icloud.com/account/principal/calendars/work/');
	});

	it('rejects an empty href instead of returning the base URL', () => {
		expectUrlError(() => resolveCalDavHref('https://example.test/calendars/', ''), 'MALFORMED_URL');
	});

	it('applies WHATWG query reference resolution', () => {
		const base = 'https://example.test/calendars/work/?old=1';

		expect(resolveCalDavHref(base, '?view=all')).toBe(
			'https://example.test/calendars/work/?view=all',
		);
		expect(resolveCalDavHref(base, 'event')).toBe('https://example.test/calendars/work/event');
	});

	it('preserves opaque percent triplets, their casing, and terminal slashes', () => {
		expect(
			resolveCalDavHref('https://example.test/calendars/', 'a%2Fb/%20/%E2%98%83/%23/%2eprofile/'),
		).toBe('https://example.test/calendars/a%2Fb/%20/%E2%98%83/%23/%2eprofile/');
	});

	it('encodes raw spaces and Unicode', () => {
		expect(resolveCalDavHref('https://example.test/calendars/', 'a space/雪')).toBe(
			'https://example.test/calendars/a%20space/%E9%9B%AA',
		);
	});

	it('allows HTTP to HTTPS upgrades and cross-origin HTTPS targets', () => {
		expect(
			resolveCalDavHref('http://example.test/principal/', 'https://p01.example.net/calendars/'),
		).toBe('https://p01.example.net/calendars/');
	});

	it('rejects HTTPS to HTTP downgrades', () => {
		expectUrlError(
			() => resolveCalDavHref('https://example.test/principal/', 'http://example.test/calendars/'),
			'INSECURE_PROTOCOL_DOWNGRADE',
		);
	});

	it.each([
		'https://user:password@example.test/calendars/',
		'//user@example.test/calendars/',
		'//@example.test/calendars/',
	])('rejects userinfo-bearing href %s', (href) => {
		expectUrlError(
			() => resolveCalDavHref('https://example.test/principal/', href),
			'USERINFO_NOT_ALLOWED',
		);
	});

	it.each(['event#section', '#section', '#'])('rejects fragment-bearing href %s', (href) => {
		expectUrlError(
			() => resolveCalDavHref('https://example.test/calendars/', href),
			'FRAGMENT_NOT_ALLOWED',
		);
	});

	it.each(['.', '..', '%2e', '.%2e', '%2e.', '%2e%2e'])(
		'rejects a literal or encoded dot href segment %s',
		(segment) => {
			expectUrlError(
				() => resolveCalDavHref('https://example.test/calendars/', `safe/${segment}/event`),
				'DOT_SEGMENT_NOT_ALLOWED',
			);
		},
	);

	it.each(['%', '%2', '%GG'])('rejects malformed percent escape %s in an href', (escape) => {
		expectUrlError(
			() => resolveCalDavHref('https://example.test/calendars/', `event${escape}`),
			'MALFORMED_PERCENT_ENCODING',
		);
	});

	it.each(['///example.test/path', '\\host/path', 'event\\name', '\tevent', 'event\n'])(
		'rejects parser-normalized href %j',
		(href) => {
			expectUrlError(
				() => resolveCalDavHref('https://example.test/calendars/', href),
				'MALFORMED_URL',
			);
		},
	);
});

describe('joinCalendarCollectionUrl', () => {
	it('canonicalizes the collection, preserves its opaque path, and clears its query', () => {
		const resourceName = '550e8400-e29b-41d4-a716-446655440000';

		expect(
			joinCalendarCollectionUrl('https://EXAMPLE.test:443/cal/a%2Fb/?view=all', resourceName),
		).toBe(`https://example.test/cal/a%2Fb/${resourceName}`);
	});

	it.each([
		['https://example.test/calendars/work', 'event', 'https://example.test/calendars/work/event'],
		['https://example.test/calendars/work/', 'event', 'https://example.test/calendars/work/event'],
		[
			'https://example.test/calendars/work/',
			'opaque%2Fname',
			'https://example.test/calendars/work/opaque%2Fname',
		],
		[
			'https://example.test/calendars/work/',
			'event 雪 ',
			'https://example.test/calendars/work/event%20%E9%9B%AA%20',
		],
	] as const)('joins %s and %s as one final segment', (collection, resourceName, expected) => {
		expect(joinCalendarCollectionUrl(collection, resourceName)).toBe(expected);
	});

	it.each([
		'',
		'/',
		'event/name',
		'\\',
		'event\\name',
		'?',
		'event?view=all',
		'#',
		'event#section',
	])('rejects invalid resource name %j', (resourceName) => {
		expectUrlError(
			() => joinCalendarCollectionUrl('https://example.test/calendars/work/', resourceName),
			'INVALID_RESOURCE_NAME',
		);
	});

	it.each(['.', '..', '%2e', '.%2e', '%2e.', '%2e%2e'])(
		'rejects dot-segment resource name %s',
		(resourceName) => {
			expectUrlError(
				() => joinCalendarCollectionUrl('https://example.test/calendars/work/', resourceName),
				'DOT_SEGMENT_NOT_ALLOWED',
			);
		},
	);

	it.each(['%', '%2', '%GG'])('rejects malformed resource-name percent escape %s', (escape) => {
		expectUrlError(
			() => joinCalendarCollectionUrl('https://example.test/calendars/work/', `event${escape}`),
			'MALFORMED_PERCENT_ENCODING',
		);
	});

	it('validates the collection URL before joining', () => {
		expectUrlError(
			() => joinCalendarCollectionUrl('ftp://example.test/calendars/', 'event'),
			'UNSUPPORTED_SCHEME',
		);
	});
});
