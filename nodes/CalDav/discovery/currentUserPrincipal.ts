import { CalDavMethod } from '../transport/http';
import type { CalDavTransport } from '../transport/http';
import { resolveCalDavHref } from '../transport/url';
import type { AbsoluteHttpUrl } from '../transport/url';
import { parseDavMultiStatus } from '../xml/parser';
import type { DavProperty, DavXmlElement } from '../xml/parser';
import { buildCurrentUserPrincipalPropfind } from '../xml/requests';

export const CurrentUserPrincipalDiscoveryKind = {
	AUTHENTICATED: 'authenticated',
	UNAUTHENTICATED: 'unauthenticated',
	UNAVAILABLE: 'unavailable',
} as const;
export type CurrentUserPrincipalDiscoveryKind =
	(typeof CurrentUserPrincipalDiscoveryKind)[keyof typeof CurrentUserPrincipalDiscoveryKind];

export const CurrentUserPrincipalDiscoveryFailureCode = {
	UNAUTHENTICATED: 'CURRENT_USER_PRINCIPAL_UNAUTHENTICATED',
	UNAVAILABLE: 'CURRENT_USER_PRINCIPAL_UNAVAILABLE',
	INVALID_RESPONSE: 'INVALID_CURRENT_USER_PRINCIPAL_RESPONSE',
	AMBIGUOUS_RESPONSE: 'AMBIGUOUS_CURRENT_USER_PRINCIPAL_RESPONSE',
} as const;
export type CurrentUserPrincipalDiscoveryFailureCode =
	(typeof CurrentUserPrincipalDiscoveryFailureCode)[keyof typeof CurrentUserPrincipalDiscoveryFailureCode];

export interface AuthenticatedCurrentUserPrincipalOutcome {
	readonly kind: 'authenticated';
	readonly principalUrl: AbsoluteHttpUrl;
}

export interface UnauthenticatedCurrentUserPrincipalOutcome {
	readonly kind: 'unauthenticated';
	readonly code: 'CURRENT_USER_PRINCIPAL_UNAUTHENTICATED';
	readonly message: 'The CalDAV server did not authenticate the current user.';
}

export interface UnavailableCurrentUserPrincipalOutcome {
	readonly kind: 'unavailable';
	readonly code: 'CURRENT_USER_PRINCIPAL_UNAVAILABLE';
	readonly message: 'The CalDAV current-user principal is unavailable.';
}

export type CurrentUserPrincipalDiscoveryOutcome =
	| AuthenticatedCurrentUserPrincipalOutcome
	| UnauthenticatedCurrentUserPrincipalOutcome
	| UnavailableCurrentUserPrincipalOutcome;

const ERROR_MESSAGES = {
	INVALID_CURRENT_USER_PRINCIPAL_RESPONSE:
		'The CalDAV server returned an invalid current-user principal response.',
	AMBIGUOUS_CURRENT_USER_PRINCIPAL_RESPONSE:
		'The CalDAV server returned an ambiguous current-user principal response.',
} as const;

export class CalDavCurrentUserPrincipalDiscoveryError extends Error {
	readonly code:
		'INVALID_CURRENT_USER_PRINCIPAL_RESPONSE' | 'AMBIGUOUS_CURRENT_USER_PRINCIPAL_RESPONSE';

	constructor(
		code: 'INVALID_CURRENT_USER_PRINCIPAL_RESPONSE' | 'AMBIGUOUS_CURRENT_USER_PRINCIPAL_RESPONSE',
	) {
		super(ERROR_MESSAGES[code]);
		this.name = 'CalDavCurrentUserPrincipalDiscoveryError';
		this.code = code;
	}
}

const DAV_NAMESPACE = 'DAV:';

function invalidResponse(): never {
	throw new CalDavCurrentUserPrincipalDiscoveryError(
		CurrentUserPrincipalDiscoveryFailureCode.INVALID_RESPONSE,
	);
}

function ambiguousResponse(): never {
	throw new CalDavCurrentUserPrincipalDiscoveryError(
		CurrentUserPrincipalDiscoveryFailureCode.AMBIGUOUS_RESPONSE,
	);
}

function isExpandedName(element: DavXmlElement, localName: string): boolean {
	return element.name.namespaceUri === DAV_NAMESPACE && element.name.localName === localName;
}

function isXmlWhitespace(value: string): boolean {
	for (const character of value) {
		if (character !== ' ' && character !== '\t' && character !== '\n' && character !== '\r') {
			return false;
		}
	}

	return true;
}

function unavailableOutcome(): UnavailableCurrentUserPrincipalOutcome {
	return {
		kind: CurrentUserPrincipalDiscoveryKind.UNAVAILABLE,
		code: CurrentUserPrincipalDiscoveryFailureCode.UNAVAILABLE,
		message: 'The CalDAV current-user principal is unavailable.',
	};
}

function unauthenticatedOutcome(): UnauthenticatedCurrentUserPrincipalOutcome {
	return {
		kind: CurrentUserPrincipalDiscoveryKind.UNAUTHENTICATED,
		code: CurrentUserPrincipalDiscoveryFailureCode.UNAUTHENTICATED,
		message: 'The CalDAV server did not authenticate the current user.',
	};
}

function getOnlyPropertyValue(property: DavProperty): DavXmlElement {
	if (property.attributes.length !== 0) {
		return invalidResponse();
	}

	const elements: DavXmlElement[] = [];
	for (const child of property.children) {
		if (child.kind === 'element') {
			elements.push(child);
		} else if (!isXmlWhitespace(child.value)) {
			return invalidResponse();
		}
	}

	if (elements.length !== 1) {
		return invalidResponse();
	}

	return elements[0];
}

function readHref(element: DavXmlElement): string {
	if (element.attributes.length !== 0) {
		return invalidResponse();
	}

	let href = '';
	for (const child of element.children) {
		if (child.kind === 'element') {
			return invalidResponse();
		}
		href += child.value;
	}

	if (href.length === 0) {
		return invalidResponse();
	}

	return href;
}

function assertEmptyUnauthenticated(element: DavXmlElement): void {
	if (element.attributes.length !== 0) {
		return invalidResponse();
	}

	for (const child of element.children) {
		if (child.kind === 'element' || !isXmlWhitespace(child.value)) {
			return invalidResponse();
		}
	}
}

function readPrincipalProperty(
	property: DavProperty,
	effectiveUrl: string,
): CurrentUserPrincipalDiscoveryOutcome {
	const value = getOnlyPropertyValue(property);

	if (isExpandedName(value, 'href')) {
		return {
			kind: CurrentUserPrincipalDiscoveryKind.AUTHENTICATED,
			principalUrl: resolveCalDavHref(effectiveUrl, readHref(value)),
		};
	}

	if (isExpandedName(value, 'unauthenticated')) {
		assertEmptyUnauthenticated(value);
		return unauthenticatedOutcome();
	}

	return invalidResponse();
}

export async function discoverCurrentUserPrincipal(
	transport: CalDavTransport,
): Promise<CurrentUserPrincipalDiscoveryOutcome> {
	const response = await transport.request({
		method: CalDavMethod.PROPFIND,
		headers: {
			Depth: '0',
			'Content-Type': 'application/xml; charset=utf-8',
		},
		body: buildCurrentUserPrincipalPropfind(),
	});

	if (response.statusCode !== 207) {
		return invalidResponse();
	}

	const multiStatus = parseDavMultiStatus(response.body.toString('utf8'));
	if (multiStatus.responses.length === 0) {
		return unavailableOutcome();
	}
	if (multiStatus.responses.length > 1) {
		return ambiguousResponse();
	}

	const davResponse = multiStatus.responses[0];
	if (davResponse.kind !== 'propstat') {
		return invalidResponse();
	}

	const matches: DavProperty[] = [];
	for (const propstat of davResponse.propstats) {
		if (!propstat.status.isSuccessful) {
			continue;
		}
		for (const property of propstat.properties) {
			if (isExpandedName(property, 'current-user-principal')) {
				matches.push(property);
			}
		}
	}

	if (matches.length === 0) {
		return unavailableOutcome();
	}
	if (matches.length > 1) {
		return ambiguousResponse();
	}

	return readPrincipalProperty(matches[0], response.effectiveUrl);
}
