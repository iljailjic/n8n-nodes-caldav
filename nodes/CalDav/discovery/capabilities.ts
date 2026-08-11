import { CalDavMethod, type CalDavTransport } from '../transport/http';

export const CalDavCapabilityValidationFailureCode = {
	NOT_CALDAV: 'CALDAV_CAPABILITY_MISSING',
} as const;
export type CalDavCapabilityValidationFailureCode =
	(typeof CalDavCapabilityValidationFailureCode)[keyof typeof CalDavCapabilityValidationFailureCode];

export class CalDavCapabilityValidationError extends Error {
	readonly code: CalDavCapabilityValidationFailureCode;

	constructor(code: CalDavCapabilityValidationFailureCode) {
		super('The endpoint does not advertise CalDAV calendar-access support.');
		this.name = 'CalDavCapabilityValidationError';
		this.code = code;
	}
}

function trimsOnlyHttpWhitespace(value: string): string {
	return value.replace(/^[ \t]+|[ \t]+$/g, '');
}

export async function validateCalDavCapability(transport: CalDavTransport): Promise<void> {
	const response = await transport.request({ method: CalDavMethod.OPTIONS });
	const davHeader = response.headers.dav;
	const values =
		davHeader === undefined ? [] : typeof davHeader === 'string' ? [davHeader] : davHeader;
	const hasCalendarAccess = values.some((value) =>
		value.split(',').some((token) => trimsOnlyHttpWhitespace(token) === 'calendar-access'),
	);

	if (!hasCalendarAccess) {
		throw new CalDavCapabilityValidationError(CalDavCapabilityValidationFailureCode.NOT_CALDAV);
	}
}
