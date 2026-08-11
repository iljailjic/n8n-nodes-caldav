import type {
	ICredentialDataDecryptedObject,
	ICredentialsDecrypted,
	ICredentialTestFunctions,
	INodeCredentialTestResult,
} from 'n8n-workflow';

import {
	CalDavCalendarHomeDiscoveryError,
	CalendarHomeDiscoveryFailureCode,
	discoverCalendarHome,
} from '../discovery/calendarHome';
import {
	CalDavCapabilityValidationError,
	validateCalDavCapability,
} from '../discovery/capabilities';
import {
	CalDavCurrentUserPrincipalDiscoveryError,
	CurrentUserPrincipalDiscoveryKind,
	discoverCurrentUserPrincipal,
} from '../discovery/currentUserPrincipal';
import {
	CalDavAuthenticationError,
	CalDavAuthorizationError,
	CalDavNetworkError,
	CalDavNotFoundError,
	CalDavRemoteProtocolError,
	CalDavResponseLimitError,
	CalDavTimeoutError,
	CalDavTlsError,
	CalDavTransportError,
	CalDavTransportErrorCode,
	createN8nCalDavTransport,
} from '../transport/http';
import { CalDavUrlValidationError, validateAbsoluteHttpUrl } from '../transport/url';
import { XmlBuildError } from '../xml/errors';
import { CalDavXmlParseError, CalDavXmlProtocolError } from '../xml/parser';

const RESULT_MESSAGES = {
	SUCCESS: 'CalDAV connection successful.',
	AUTHENTICATION: 'Authentication failed. Check the CalDAV username and password.',
	FORBIDDEN: 'The CalDAV account is not permitted to access this endpoint.',
	NOT_CALDAV: 'The server URL does not identify a CalDAV endpoint.',
	INCOMPLETE_DISCOVERY: 'CalDAV discovery did not provide a usable principal and calendar home.',
	INVALID_SERVER_URL: 'The CalDAV server URL is invalid.',
	TLS: 'TLS certificate validation failed. Check the server certificate or enable Skip TLS Validation only for development.',
	NETWORK: 'The CalDAV server could not be reached.',
	TIMEOUT: 'The CalDAV connection test timed out.',
	RESPONSE_LIMIT: 'The CalDAV server response exceeded the allowed size.',
	REDIRECT: 'The CalDAV server returned an unsafe or invalid redirect.',
	PROTOCOL: 'The CalDAV server returned an invalid protocol response.',
	XML: 'The CalDAV server returned invalid XML.',
	RESOURCE_URL: 'The CalDAV server returned an invalid resource URL.',
	UNKNOWN: 'The CalDAV connection test failed.',
} as const;

type CredentialTestPhase = 'preflight' | 'capability' | 'principal' | 'home';

function authenticationFailure(): never {
	throw new CalDavAuthenticationError();
}

function validateCredentialPreflight(
	credential: ICredentialsDecrypted<ICredentialDataDecryptedObject>,
): void {
	const credentials = credential.data;
	if (
		credentials === undefined ||
		typeof credentials.username !== 'string' ||
		credentials.username.length === 0 ||
		typeof credentials.password !== 'string' ||
		credentials.password.length === 0
	) {
		return authenticationFailure();
	}

	if (typeof credentials.serverUrl !== 'string') {
		throw new CalDavUrlValidationError('MALFORMED_URL');
	}
	validateAbsoluteHttpUrl(credentials.serverUrl.trim());
}

function isRedirectFailure(error: CalDavTransportError): boolean {
	return (
		error.code === CalDavTransportErrorCode.INVALID_REDIRECT ||
		error.code === CalDavTransportErrorCode.INSECURE_REDIRECT ||
		error.code === CalDavTransportErrorCode.UNTRUSTED_TARGET ||
		error.code === CalDavTransportErrorCode.REDIRECT_LOOP ||
		error.code === CalDavTransportErrorCode.REDIRECT_LIMIT_EXCEEDED
	);
}

function mapFailure(error: unknown, phase: CredentialTestPhase): string {
	if (error instanceof CalDavAuthenticationError) {
		return RESULT_MESSAGES.AUTHENTICATION;
	}
	if (error instanceof CalDavAuthorizationError) {
		return RESULT_MESSAGES.FORBIDDEN;
	}
	if (error instanceof CalDavTlsError) {
		return RESULT_MESSAGES.TLS;
	}
	if (error instanceof CalDavTimeoutError) {
		return RESULT_MESSAGES.TIMEOUT;
	}
	if (error instanceof CalDavResponseLimitError) {
		return RESULT_MESSAGES.RESPONSE_LIMIT;
	}
	if (error instanceof CalDavTransportError && isRedirectFailure(error)) {
		return RESULT_MESSAGES.REDIRECT;
	}
	if (error instanceof CalDavNetworkError) {
		return RESULT_MESSAGES.NETWORK;
	}
	if (error instanceof CalDavCapabilityValidationError) {
		return RESULT_MESSAGES.NOT_CALDAV;
	}
	if (error instanceof CalDavNotFoundError) {
		return phase === 'capability'
			? RESULT_MESSAGES.NOT_CALDAV
			: RESULT_MESSAGES.INCOMPLETE_DISCOVERY;
	}
	if (error instanceof CalDavCalendarHomeDiscoveryError) {
		if (error.code === CalendarHomeDiscoveryFailureCode.FORBIDDEN) {
			return RESULT_MESSAGES.FORBIDDEN;
		}
		if (error.code === CalendarHomeDiscoveryFailureCode.MISSING) {
			return RESULT_MESSAGES.INCOMPLETE_DISCOVERY;
		}
		return RESULT_MESSAGES.PROTOCOL;
	}
	if (error instanceof CalDavCurrentUserPrincipalDiscoveryError) {
		return RESULT_MESSAGES.PROTOCOL;
	}
	if (
		error instanceof CalDavXmlParseError ||
		error instanceof CalDavXmlProtocolError ||
		error instanceof XmlBuildError
	) {
		return RESULT_MESSAGES.XML;
	}
	if (error instanceof CalDavUrlValidationError) {
		return phase === 'preflight'
			? RESULT_MESSAGES.INVALID_SERVER_URL
			: RESULT_MESSAGES.RESOURCE_URL;
	}
	if (error instanceof CalDavRemoteProtocolError) {
		return RESULT_MESSAGES.PROTOCOL;
	}

	return RESULT_MESSAGES.UNKNOWN;
}

function safeFailureMessage(error: unknown, phase: CredentialTestPhase): string {
	try {
		return mapFailure(error, phase);
	} catch {
		return RESULT_MESSAGES.UNKNOWN;
	}
}

export async function testCalDavApiCredentials(
	this: ICredentialTestFunctions,
	credential: ICredentialsDecrypted<ICredentialDataDecryptedObject>,
): Promise<INodeCredentialTestResult> {
	let phase: CredentialTestPhase = 'preflight';

	try {
		validateCredentialPreflight(credential);
		const transport = await createN8nCalDavTransport(this, credential);

		phase = 'capability';
		await validateCalDavCapability(transport);

		phase = 'principal';
		const principal = await discoverCurrentUserPrincipal(transport);
		if (principal.kind !== CurrentUserPrincipalDiscoveryKind.AUTHENTICATED) {
			return { status: 'Error', message: RESULT_MESSAGES.INCOMPLETE_DISCOVERY };
		}

		phase = 'home';
		await discoverCalendarHome(transport, principal.principalUrl);

		return { status: 'OK', message: RESULT_MESSAGES.SUCCESS };
	} catch (error) {
		return { status: 'Error', message: safeFailureMessage(error, phase) };
	}
}
