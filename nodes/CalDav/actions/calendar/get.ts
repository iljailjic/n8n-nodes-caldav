import {
	CalDavCalendarCollectionDiscoveryError,
	CalendarCollectionDiscoveryFailureCode,
	discoverCalendarCollections,
} from '../../discovery/calendarCollections';
import type { CalendarCollection } from '../../discovery/calendarCollections';
import { standardCalDavProviderAdapter } from '../../providers/standard';
import type { CalDavProviderAdapter } from '../../providers/types';
import type { CalDavTransport } from '../../transport/http';
import { normalizeCalendarCollectionUrl } from '../../transport/url';
import type { AbsoluteHttpUrl } from '../../transport/url';

export const CalendarCollectionGetFailureCode = {
	NOT_CALENDAR: 'NOT_A_CALENDAR_COLLECTION',
	VEVENT_UNSUPPORTED: 'VEVENT_NOT_SUPPORTED',
} as const;

export type CalendarCollectionGetFailureCode =
	(typeof CalendarCollectionGetFailureCode)[keyof typeof CalendarCollectionGetFailureCode];

const ERROR_MESSAGES: Readonly<Record<CalendarCollectionGetFailureCode, string>> = {
	NOT_A_CALENDAR_COLLECTION: 'The resource is not a CalDAV calendar collection.',
	VEVENT_NOT_SUPPORTED: 'The calendar collection does not support VEVENT resources.',
};

export class CalDavCalendarCollectionGetError extends Error {
	readonly code: CalendarCollectionGetFailureCode;

	constructor(code: CalendarCollectionGetFailureCode) {
		super(ERROR_MESSAGES[code]);
		this.name = 'CalDavCalendarCollectionGetError';
		this.code = code;
	}
}

function invalidResponse(): never {
	throw new CalDavCalendarCollectionDiscoveryError(
		CalendarCollectionDiscoveryFailureCode.INVALID_RESPONSE,
	);
}

export async function getCalendarCollection(
	transport: CalDavTransport,
	calendarUrl: AbsoluteHttpUrl,
	provider: CalDavProviderAdapter = standardCalDavProviderAdapter,
): Promise<CalendarCollection> {
	const normalizedUrl = normalizeCalendarCollectionUrl(calendarUrl);
	const collections = await discoverCalendarCollections(transport, normalizedUrl, provider, {
		depth: '0',
		requireExactlyOneResponse: true,
		onRejected(reason) {
			if (reason === 'not-calendar') {
				throw new CalDavCalendarCollectionGetError(CalendarCollectionGetFailureCode.NOT_CALENDAR);
			}
			if (reason === 'vevent-unsupported') {
				throw new CalDavCalendarCollectionGetError(
					CalendarCollectionGetFailureCode.VEVENT_UNSUPPORTED,
				);
			}
			return invalidResponse();
		},
	});

	return collections[0] ?? invalidResponse();
}
