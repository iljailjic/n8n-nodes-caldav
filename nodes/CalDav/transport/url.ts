declare const absoluteHttpUrlBrand: unique symbol;

export type AbsoluteHttpUrl = string & {
	readonly [absoluteHttpUrlBrand]: true;
};

export const CalDavUrlErrorCode = {
	MALFORMED_URL: 'MALFORMED_URL',
	MALFORMED_PERCENT_ENCODING: 'MALFORMED_PERCENT_ENCODING',
	UNSUPPORTED_SCHEME: 'UNSUPPORTED_SCHEME',
	USERINFO_NOT_ALLOWED: 'USERINFO_NOT_ALLOWED',
	FRAGMENT_NOT_ALLOWED: 'FRAGMENT_NOT_ALLOWED',
	DOT_SEGMENT_NOT_ALLOWED: 'DOT_SEGMENT_NOT_ALLOWED',
	INSECURE_PROTOCOL_DOWNGRADE: 'INSECURE_PROTOCOL_DOWNGRADE',
	INVALID_RESOURCE_NAME: 'INVALID_RESOURCE_NAME',
} as const;

export type CalDavUrlErrorCode = (typeof CalDavUrlErrorCode)[keyof typeof CalDavUrlErrorCode];

const ERROR_MESSAGES: Record<CalDavUrlErrorCode, string> = {
	MALFORMED_URL: 'The URL is malformed.',
	MALFORMED_PERCENT_ENCODING: 'The URL contains malformed percent-encoding.',
	UNSUPPORTED_SCHEME: 'The URL scheme is not supported.',
	USERINFO_NOT_ALLOWED: 'URL userinfo is not allowed.',
	FRAGMENT_NOT_ALLOWED: 'URL fragments are not allowed.',
	DOT_SEGMENT_NOT_ALLOWED: 'URL dot segments are not allowed.',
	INSECURE_PROTOCOL_DOWNGRADE: 'An insecure protocol downgrade is not allowed.',
	INVALID_RESOURCE_NAME: 'The calendar resource name is invalid.',
};

const SCHEME_PREFIX = /^[A-Za-z][A-Za-z\d+.-]*:/;
const HTTP_SCHEME_PREFIX = /^https?:/i;
const MALFORMED_PERCENT_TRIPLET = /%(?![\dA-Fa-f]{2})/;
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

export class CalDavUrlValidationError extends Error {
	readonly code: CalDavUrlErrorCode;

	constructor(code: CalDavUrlErrorCode) {
		super(ERROR_MESSAGES[code]);
		this.name = 'CalDavUrlValidationError';
		this.code = code;
	}
}

function fail(code: CalDavUrlErrorCode): never {
	throw new CalDavUrlValidationError(code);
}

function containsRawControl(input: string): boolean {
	return Array.from(input).some((character) => {
		const codePoint = character.codePointAt(0);
		return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
	});
}

function getReferenceParts(input: string): { authority?: string; path: string } {
	const scheme = input.match(SCHEME_PREFIX);
	let pathStart = scheme?.[0].length ?? 0;

	if (input.slice(pathStart, pathStart + 2) !== '//') {
		const pathEnd = input.indexOf('?', pathStart);
		return {
			path: input.slice(pathStart, pathEnd === -1 ? input.length : pathEnd),
		};
	}

	const authorityStart = pathStart + 2;
	const authorityEndCandidate = input.slice(authorityStart).search(/[/?#]/);
	const authorityEnd =
		authorityEndCandidate === -1 ? input.length : authorityStart + authorityEndCandidate;
	pathStart = authorityEnd;

	const pathEnd = input.indexOf('?', pathStart);
	return {
		authority: input.slice(authorityStart, authorityEnd),
		path: input.slice(pathStart, pathEnd === -1 ? input.length : pathEnd),
	};
}

function assertSafeUrlReference(input: string): void {
	if (
		input.length === 0 ||
		(HTTP_SCHEME_PREFIX.test(input) && !/^https?:\/\//i.test(input)) ||
		containsRawControl(input) ||
		input.startsWith(' ') ||
		input.endsWith(' ') ||
		input.includes('\\')
	) {
		fail('MALFORMED_URL');
	}

	if (MALFORMED_PERCENT_TRIPLET.test(input)) {
		fail('MALFORMED_PERCENT_ENCODING');
	}

	if (input.includes('#')) {
		fail('FRAGMENT_NOT_ALLOWED');
	}

	const { authority, path } = getReferenceParts(input);
	if (authority === '') {
		fail('MALFORMED_URL');
	}

	if (authority?.includes('@')) {
		fail('USERINFO_NOT_ALLOWED');
	}

	if (path.split('/').some((segment) => DOT_SEGMENT.test(segment))) {
		fail('DOT_SEGMENT_NOT_ALLOWED');
	}
}

function assertSafeHrefReference(input: string): void {
	if (input.length === 0) {
		fail('MALFORMED_URL');
	}

	assertSafeUrlReference(input);
}

function parseUrl(input: string, base?: string): URL {
	try {
		return base === undefined ? new URL(input) : new URL(input, base);
	} catch {
		return fail('MALFORMED_URL');
	}
}

function assertHttpUrl(url: URL): void {
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		fail('UNSUPPORTED_SCHEME');
	}

	if (url.hostname.length === 0) {
		fail('MALFORMED_URL');
	}

	if (url.username.length > 0 || url.password.length > 0) {
		fail('USERINFO_NOT_ALLOWED');
	}

	if (url.hash.length > 0) {
		fail('FRAGMENT_NOT_ALLOWED');
	}
}

function serialize(url: URL): AbsoluteHttpUrl {
	return url.href as AbsoluteHttpUrl;
}

export function validateAbsoluteHttpUrl(input: string): AbsoluteHttpUrl {
	assertSafeUrlReference(input);

	const url = parseUrl(input);
	assertHttpUrl(url);

	return serialize(url);
}

export function resolveCalDavHref(effectiveResponseUrl: string, href: string): AbsoluteHttpUrl {
	const base = validateAbsoluteHttpUrl(effectiveResponseUrl);
	assertSafeHrefReference(href);

	const resolved = parseUrl(href, base);
	assertHttpUrl(resolved);

	if (base.startsWith('https:') && resolved.protocol === 'http:') {
		fail('INSECURE_PROTOCOL_DOWNGRADE');
	}

	return serialize(resolved);
}

export function normalizeCalendarCollectionUrl(collectionUrl: string): AbsoluteHttpUrl {
	const canonicalUrl = validateAbsoluteHttpUrl(collectionUrl);
	const parsedUrl = parseUrl(canonicalUrl);

	if (parsedUrl.pathname.endsWith('/')) {
		return canonicalUrl;
	}

	const queryIndex = canonicalUrl.indexOf('?');
	if (queryIndex === -1) {
		return `${canonicalUrl}/` as AbsoluteHttpUrl;
	}

	return `${canonicalUrl.slice(0, queryIndex)}/${canonicalUrl.slice(queryIndex)}` as AbsoluteHttpUrl;
}

function assertValidResourceName(resourceName: string): void {
	if (
		resourceName.length === 0 ||
		containsRawControl(resourceName) ||
		resourceName.includes('/') ||
		resourceName.includes('\\') ||
		resourceName.includes('?') ||
		resourceName.includes('#')
	) {
		fail('INVALID_RESOURCE_NAME');
	}

	if (MALFORMED_PERCENT_TRIPLET.test(resourceName)) {
		fail('MALFORMED_PERCENT_ENCODING');
	}

	if (DOT_SEGMENT.test(resourceName)) {
		fail('DOT_SEGMENT_NOT_ALLOWED');
	}
}

export function joinCalendarCollectionUrl(
	calendarCollectionUrl: string,
	resourceName: string,
): AbsoluteHttpUrl {
	const collection = parseUrl(validateAbsoluteHttpUrl(calendarCollectionUrl));
	assertValidResourceName(resourceName);

	collection.search = '';
	const delimiter = collection.pathname.endsWith('/') ? '' : '/';
	collection.pathname = `${collection.pathname}${delimiter}${resourceName}`;

	return serialize(collection);
}
