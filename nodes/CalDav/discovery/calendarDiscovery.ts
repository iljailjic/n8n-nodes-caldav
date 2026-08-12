import { discoverCalendarHome } from './calendarHome';
import { discoverCalendarCollections, type CalendarCollection } from './calendarCollections';
import {
	discoverCurrentUserPrincipal,
	CurrentUserPrincipalDiscoveryKind,
	type CurrentUserPrincipalDiscoveryFailureCode,
} from './currentUserPrincipal';
import { defaultCalDavProviderRegistry } from '../providers/registry';
import type { CalDavTransport } from '../transport/http';
import { validateAbsoluteHttpUrl } from '../transport/url';

export class CalDavCalendarDiscoveryError extends Error {
	readonly code: CurrentUserPrincipalDiscoveryFailureCode;

	constructor(code: CurrentUserPrincipalDiscoveryFailureCode) {
		super('CalDAV calendar discovery failed.');
		this.name = 'CalDavCalendarDiscoveryError';
		this.code = code;
	}
}

export async function discoverCalendarsForCurrentUser(
	transport: CalDavTransport,
): Promise<readonly CalendarCollection[]> {
	const principal = await discoverCurrentUserPrincipal(transport);
	if (principal.kind !== CurrentUserPrincipalDiscoveryKind.AUTHENTICATED) {
		throw new CalDavCalendarDiscoveryError(principal.code);
	}

	const home = await discoverCalendarHome(transport, principal.principalUrl);
	const provider = defaultCalDavProviderRegistry.select(
		validateAbsoluteHttpUrl(transport.serverUrl),
	);
	return await discoverCalendarCollections(transport, home.calendarHomeUrl, provider);
}
