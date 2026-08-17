export const CalendarEventCreateFailureCode = Object.freeze({
	RESOURCE_NAME_TOO_LONG: 'CALENDAR_EVENT_CREATE_RESOURCE_NAME_TOO_LONG',
	INVALID_CLOCK: 'CALENDAR_EVENT_CREATE_INVALID_CLOCK',
	NORMALIZATION_FAILED: 'CALENDAR_EVENT_CREATE_NORMALIZATION_FAILED',
	ETAG_RETRIEVAL_FAILED: 'CALENDAR_EVENT_CREATE_ETAG_RETRIEVAL_FAILED',
} as const);

export type CalendarEventCreateFailureCode =
	(typeof CalendarEventCreateFailureCode)[keyof typeof CalendarEventCreateFailureCode];

const ERROR_MESSAGES: Readonly<Record<CalendarEventCreateFailureCode, string>> = {
	CALENDAR_EVENT_CREATE_RESOURCE_NAME_TOO_LONG:
		'UID is too long to create a safe event resource name.',
	CALENDAR_EVENT_CREATE_INVALID_CLOCK: 'The calendar event clock is invalid.',
	CALENDAR_EVENT_CREATE_NORMALIZATION_FAILED:
		'The serialized calendar event could not be normalized.',
	CALENDAR_EVENT_CREATE_ETAG_RETRIEVAL_FAILED:
		'The event was created, but its required ETag could not be retrieved.',
};

export class CalDavCalendarEventCreateError extends Error {
	readonly code: CalendarEventCreateFailureCode;
	readonly statusCode?: number;

	constructor(code: CalendarEventCreateFailureCode, statusCode?: number) {
		super(ERROR_MESSAGES[code]);
		this.name = 'CalDavCalendarEventCreateError';
		this.code = code;
		if (
			Number.isInteger(statusCode) &&
			(statusCode as number) >= 100 &&
			(statusCode as number) <= 599
		) {
			this.statusCode = statusCode;
		}
	}
}
