import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeListSearchResult,
	INodeParameterResourceLocator,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	CalDavCalendarCollectionGetError,
	CalendarCollectionGetFailureCode,
	getCalendarCollection,
} from './actions/calendar/get';
import { discoverCalendarsForCurrentUser } from './discovery/calendarDiscovery';
import {
	CalDavCalendarCollectionDiscoveryError,
	type CalendarCollection,
} from './discovery/calendarCollections';
import {
	CalDavCalendarEventResourceGetError,
	CalendarEventResourceGetFailureCode,
	getCalendarEventByResourceUrl,
} from './events/getByResourceUrl';
import {
	CalDavCalendarEventCreateError,
	CalendarEventCreateFailureCode,
	createCalendarEvent,
} from './events/create';
import type { CalendarEventCreateInput } from './events/create';
import {
	CalDavCalendarEventMutationError,
	CalendarEventMutationFailureCode,
	deleteCalendarEventResource,
} from './events/mutations';
import {
	CalDavCalendarEventUidResolutionError,
	CalendarEventUidResolutionFailureCode,
	resolveCalendarEventByUid,
} from './events/resolveByUid';
import { queryCalendarEventsByTimeRange } from './events/timeRangeQuery';
import { CalDavCalendarEventReadModelError } from './icalendar/eventReadModel';
import type { CalendarEvent } from './icalendar/eventReadModel';
import { CalDavICalendarParseError } from './icalendar/parser';
import {
	CalDavICalendarSerializeError,
	CalDavICalendarSerializeErrorCode,
	serializeBasicUtcEvent,
} from './icalendar/serializer';
import { testCalDavApiCredentials } from './methods/credentialTest';
import { defaultCalDavProviderRegistry } from './providers/registry';
import type { CalDavProviderAdapter } from './providers/types';
import {
	CalDavTransportError,
	CalDavTransportErrorCode,
	createN8nCalDavTransport,
} from './transport/http';
import type { CalDavTransport } from './transport/http';
import {
	CalDavUrlValidationError,
	normalizeCalendarCollectionUrl,
	validateAbsoluteHttpUrl,
} from './transport/url';
import type { AbsoluteHttpUrl } from './transport/url';
import { XmlBuildError } from './xml/errors';
import { CalDavXmlParseError, CalDavXmlProtocolError } from './xml/parser';

const CALENDAR_RESOURCE = 'calendar';
const EVENT_RESOURCE = 'event';
const GET_OPERATION = 'get';
const GET_MANY_OPERATION = 'getMany';
const CREATE_OPERATION = 'create';
const DELETE_OPERATION = 'delete';
const RESOURCE_URL_IDENTIFIER_MODE = 'resourceUrl';
const UID_IDENTIFIER_MODE = 'uid';
const INVALID_LIMIT_MESSAGE = 'Limit must be an integer greater than or equal to 1.';
const UNSUPPORTED_OPERATION_MESSAGE = 'Unsupported CalDAV resource or operation.';
const GENERIC_GET_MANY_ERROR_MESSAGE = 'The Calendar Get Many operation failed.';
const GENERIC_LIST_SEARCH_ERROR_MESSAGE = 'The calendar list could not be loaded.';
const ZONED_ISO_INSTANT_PATTERN =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([zZ])|([+-])(\d{2}):(\d{2}))$/;

const GET_MESSAGES = {
	INVALID_CALENDAR_URL:
		'The Calendar URL is invalid. Enter an absolute HTTP(S) calendar collection URL.',
	UNTRUSTED: 'The Calendar URL targets an untrusted endpoint.',
	NOT_CALENDAR: 'The resource is not a calendar collection.',
	VEVENT_UNSUPPORTED: 'The calendar does not support VEVENT.',
	AUTHENTICATION: 'Calendar Get authentication failed.',
	AUTHORIZATION: 'Calendar Get is not authorized.',
	NOT_FOUND: 'The calendar was not found.',
	TLS: 'TLS certificate validation failed.',
	TIMEOUT: 'Calendar Get timed out.',
	RESPONSE_LIMIT: 'The Calendar Get response exceeded the size limit.',
	REDIRECT: 'The CalDAV server returned an unsafe or invalid redirect.',
	NETWORK: 'The CalDAV server could not be reached.',
	INVALID_RESPONSE: 'The CalDAV server returned an invalid calendar response.',
	GENERIC: 'Calendar Get failed.',
} as const;

const EVENT_GET_MESSAGES = {
	INVALID_CALENDAR_URL:
		'The Calendar URL is invalid. Enter an absolute HTTP(S) calendar collection URL.',
	INVALID_RESOURCE_URL:
		'The Event Resource URL is invalid or does not belong to the selected calendar.',
	INVALID_UID: 'UID must be a non-empty valid iCalendar text value.',
	AUTHENTICATION: 'Event Get authentication failed.',
	AUTHORIZATION: 'Event Get is not authorized.',
	NOT_FOUND: 'The calendar event was not found.',
	AMBIGUOUS:
		'More than one calendar event with the requested UID was found in the selected calendar.',
	TLS: 'TLS certificate validation failed.',
	TIMEOUT: 'Event Get timed out.',
	RESPONSE_LIMIT: 'The Event Get response exceeded the size limit.',
	REDIRECT: 'The CalDAV server returned an unsafe or invalid redirect.',
	UNTRUSTED: 'The Event Resource URL targets an untrusted endpoint.',
	NETWORK: 'The CalDAV server could not be reached.',
	MALFORMED_ICALENDAR: 'The CalDAV server returned malformed iCalendar event data.',
	UNSUPPORTED_EVENT: 'The calendar event uses an unsupported event representation.',
	INVALID_RESPONSE: 'The CalDAV server returned an invalid calendar-event response.',
	GENERIC: 'Event Get failed.',
} as const;

const EVENT_GET_MANY_MESSAGES = {
	INVALID_CALENDAR_URL:
		'The Calendar URL is invalid. Enter an absolute HTTP(S) calendar collection URL.',
	INVALID_START: 'Start must be a valid date and time with whole-second precision.',
	INVALID_END: 'End must be a valid date and time with whole-second precision.',
	INVALID_RANGE: 'End must be later than Start.',
	INVALID_RETURN_ALL: 'Return All must be true or false.',
	INVALID_LIMIT: 'Limit must be an integer greater than or equal to 1.',
	AUTHENTICATION: 'Event Get Many authentication failed.',
	AUTHORIZATION: 'Event Get Many is not authorized.',
	NOT_FOUND: 'The selected calendar was not found.',
	TLS: 'TLS certificate validation failed.',
	TIMEOUT: 'Event Get Many timed out.',
	RESPONSE_LIMIT: 'The Event Get Many response exceeded the size limit.',
	REDIRECT: 'The CalDAV server returned an unsafe or invalid redirect.',
	UNTRUSTED: 'The Calendar URL targets an untrusted endpoint.',
	NETWORK: 'The CalDAV server could not be reached.',
	MALFORMED_ICALENDAR: 'The CalDAV server returned malformed iCalendar event data.',
	UNSUPPORTED_EVENT: 'The calendar event uses an unsupported event representation.',
	INVALID_RESPONSE: 'The CalDAV server returned an invalid calendar-event response.',
	GENERIC: 'Event Get Many failed.',
} as const;

const EVENT_DELETE_MESSAGES = {
	INVALID_CALENDAR_URL:
		'The Calendar URL is invalid. Enter an absolute HTTP(S) calendar collection URL.',
	INVALID_RESOURCE_URL:
		'The Event Resource URL is invalid or does not belong to the selected calendar.',
	INVALID_UID: 'UID must be a non-empty valid iCalendar text value.',
	INVALID_ETAG: 'ETag must be a string.',
	AUTHENTICATION: 'Event Delete authentication failed.',
	AUTHORIZATION: 'Event Delete is not authorized.',
	NOT_FOUND: 'The calendar event was not found.',
	AMBIGUOUS:
		'More than one calendar event with the requested UID was found in the selected calendar.',
	MISSING_ETAG: 'The calendar event does not provide an ETag required for a safe mutation.',
	CONCURRENCY: 'The calendar event changed before the mutation could be applied.',
	TLS: 'TLS certificate validation failed.',
	TIMEOUT: 'Event Delete timed out.',
	RESPONSE_LIMIT: 'The Event Delete response exceeded the size limit.',
	REDIRECT: 'The CalDAV server returned an unsafe or invalid redirect.',
	UNTRUSTED: 'The Event Resource URL targets an untrusted endpoint.',
	NETWORK: 'The CalDAV server could not be reached.',
	MALFORMED_ICALENDAR: 'The CalDAV server returned malformed iCalendar event data.',
	UNSUPPORTED_EVENT: 'The calendar event uses an unsupported event representation.',
	INVALID_RESPONSE: 'The CalDAV server returned an invalid calendar-event mutation response.',
	GENERIC: 'Event Delete failed.',
} as const;

const EVENT_CREATE_MESSAGES = {
	INVALID_CALENDAR_URL:
		'The Calendar URL is invalid. Enter an absolute HTTP(S) calendar collection URL.',
	INVALID_UID: 'UID must be a non-empty valid iCalendar text value.',
	RESOURCE_NAME_TOO_LONG: 'UID is too long to create a safe event resource name.',
	INVALID_START: 'Start must be a valid date and time with whole-second precision.',
	INVALID_END: 'End must be a valid date and time with whole-second precision.',
	INVALID_RANGE: 'End must be later than Start.',
	INVALID_SUMMARY: 'Summary must be a valid iCalendar text value.',
	INVALID_DESCRIPTION: 'Description must be a valid iCalendar text value.',
	INVALID_LOCATION: 'Location must be a valid iCalendar text value.',
	INVALID_URL: 'URL must be a valid absolute URI without a fragment.',
	INVALID_ADDITIONAL_FIELDS: 'Additional Fields must be an object.',
	RESOURCE_LIMIT: 'The calendar event exceeds the supported size limit.',
	AUTHENTICATION: 'Event Create authentication failed.',
	AUTHORIZATION: 'Event Create is not authorized for the selected calendar.',
	NOT_FOUND: 'The selected calendar was not found.',
	CONFLICT: 'A calendar event already exists for this UID in the selected calendar.',
	TLS: 'TLS certificate validation failed.',
	TIMEOUT: 'Event Create timed out.',
	RESPONSE_LIMIT: 'The Event Create response exceeded the size limit.',
	REDIRECT: 'The CalDAV server returned an unsafe or invalid redirect.',
	UNTRUSTED: 'The Event Create target is not trusted.',
	NETWORK: 'The CalDAV server could not be reached.',
	INVALID_RESPONSE: 'The CalDAV server returned an invalid calendar-event creation response.',
	PARTIAL_SUCCESS: 'The event was created, but its required ETag could not be retrieved.',
	GENERIC: 'Event Create failed.',
} as const;

interface SafeNodeFailure {
	readonly message: string;
	readonly httpCode?: string;
}

function apiFailure(message: string, error?: CalDavTransportError): SafeNodeFailure {
	return {
		message,
		...(error?.statusCode === undefined ? {} : { httpCode: String(error.statusCode) }),
	};
}

function transportFailure(error: CalDavTransportError): SafeNodeFailure {
	switch (error.code) {
		case CalDavTransportErrorCode.AUTHENTICATION_FAILED:
			return apiFailure(GET_MESSAGES.AUTHENTICATION, error);
		case CalDavTransportErrorCode.AUTHORIZATION_FAILED:
			return apiFailure(GET_MESSAGES.AUTHORIZATION, error);
		case CalDavTransportErrorCode.NOT_FOUND:
			return apiFailure(GET_MESSAGES.NOT_FOUND, error);
		case CalDavTransportErrorCode.TLS_VALIDATION_FAILED:
			return apiFailure(GET_MESSAGES.TLS, error);
		case CalDavTransportErrorCode.TIMEOUT:
			return apiFailure(GET_MESSAGES.TIMEOUT, error);
		case CalDavTransportErrorCode.RESPONSE_LIMIT_EXCEEDED:
			return apiFailure(GET_MESSAGES.RESPONSE_LIMIT, error);
		case CalDavTransportErrorCode.UNTRUSTED_TARGET:
			return apiFailure(GET_MESSAGES.UNTRUSTED, error);
		case CalDavTransportErrorCode.INVALID_REDIRECT:
		case CalDavTransportErrorCode.INSECURE_REDIRECT:
		case CalDavTransportErrorCode.REDIRECT_LOOP:
		case CalDavTransportErrorCode.REDIRECT_LIMIT_EXCEEDED:
			return apiFailure(GET_MESSAGES.REDIRECT, error);
		case CalDavTransportErrorCode.NETWORK_ERROR:
			return apiFailure(GET_MESSAGES.NETWORK, error);
		case CalDavTransportErrorCode.PRECONDITION_FAILED:
		case CalDavTransportErrorCode.REMOTE_PROTOCOL_ERROR:
			return apiFailure(GET_MESSAGES.INVALID_RESPONSE, error);
	}
}

function safeGetFailure(error: unknown): SafeNodeFailure {
	if (error instanceof CalDavCalendarCollectionGetError) {
		return apiFailure(
			error.code === CalendarCollectionGetFailureCode.NOT_CALENDAR
				? GET_MESSAGES.NOT_CALENDAR
				: GET_MESSAGES.VEVENT_UNSUPPORTED,
		);
	}
	if (error instanceof CalDavTransportError) {
		return transportFailure(error);
	}
	if (
		error instanceof CalDavCalendarCollectionDiscoveryError ||
		error instanceof CalDavXmlParseError ||
		error instanceof CalDavXmlProtocolError ||
		error instanceof XmlBuildError ||
		error instanceof CalDavUrlValidationError
	) {
		return apiFailure(GET_MESSAGES.INVALID_RESPONSE);
	}
	return apiFailure(GET_MESSAGES.GENERIC);
}

function calendarLocatorUrl(value: unknown): AbsoluteHttpUrl | undefined {
	try {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) {
			return undefined;
		}
		const locator = value as Partial<INodeParameterResourceLocator> & { readonly __rl?: unknown };
		if (
			locator.__rl !== true ||
			(locator.mode !== 'url' && locator.mode !== 'list') ||
			typeof locator.value !== 'string' ||
			locator.value.length === 0
		) {
			return undefined;
		}
		return normalizeCalendarCollectionUrl(validateAbsoluteHttpUrl(locator.value));
	} catch {
		return undefined;
	}
}

function isValidXmlText(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (
			codePoint === undefined ||
			(codePoint !== 0x9 &&
				codePoint !== 0xa &&
				codePoint !== 0xd &&
				(codePoint < 0x20 ||
					(codePoint > 0xd7ff && codePoint < 0xe000) ||
					(codePoint > 0xfffd && codePoint < 0x10000) ||
					codePoint > 0x10ffff))
		) {
			return false;
		}
	}
	return true;
}

function eventJson(event: CalendarEvent): IDataObject {
	return {
		calendarUrl: event.calendarUrl,
		resourceUrl: event.resourceUrl,
		...(event.etag === undefined ? {} : { etag: event.etag }),
		uid: event.uid,
		...(event.summary === undefined ? {} : { summary: event.summary }),
		...(event.description === undefined ? {} : { description: event.description }),
		...(event.location === undefined ? {} : { location: event.location }),
		...(event.url === undefined ? {} : { url: event.url }),
		start: event.start,
		end: event.end,
	};
}

function eventTransportFailure(error: CalDavTransportError): SafeNodeFailure {
	switch (error.code) {
		case CalDavTransportErrorCode.AUTHENTICATION_FAILED:
			return apiFailure(EVENT_GET_MESSAGES.AUTHENTICATION, error);
		case CalDavTransportErrorCode.AUTHORIZATION_FAILED:
			return apiFailure(EVENT_GET_MESSAGES.AUTHORIZATION, error);
		case CalDavTransportErrorCode.NOT_FOUND:
			return apiFailure(EVENT_GET_MESSAGES.NOT_FOUND, error);
		case CalDavTransportErrorCode.TLS_VALIDATION_FAILED:
			return apiFailure(EVENT_GET_MESSAGES.TLS, error);
		case CalDavTransportErrorCode.TIMEOUT:
			return apiFailure(EVENT_GET_MESSAGES.TIMEOUT, error);
		case CalDavTransportErrorCode.RESPONSE_LIMIT_EXCEEDED:
			return apiFailure(EVENT_GET_MESSAGES.RESPONSE_LIMIT, error);
		case CalDavTransportErrorCode.INVALID_REDIRECT:
		case CalDavTransportErrorCode.INSECURE_REDIRECT:
		case CalDavTransportErrorCode.REDIRECT_LOOP:
		case CalDavTransportErrorCode.REDIRECT_LIMIT_EXCEEDED:
			return apiFailure(EVENT_GET_MESSAGES.REDIRECT, error);
		case CalDavTransportErrorCode.UNTRUSTED_TARGET:
			return apiFailure(EVENT_GET_MESSAGES.UNTRUSTED, error);
		case CalDavTransportErrorCode.NETWORK_ERROR:
			return apiFailure(EVENT_GET_MESSAGES.NETWORK, error);
		case CalDavTransportErrorCode.PRECONDITION_FAILED:
		case CalDavTransportErrorCode.REMOTE_PROTOCOL_ERROR:
			return apiFailure(EVENT_GET_MESSAGES.INVALID_RESPONSE, error);
	}
}

interface EventGetFailure extends SafeNodeFailure {
	readonly configuration: boolean;
}

function eventGetFailure(error: unknown): EventGetFailure {
	if (
		error instanceof CalDavCalendarEventResourceGetError &&
		error.code === CalendarEventResourceGetFailureCode.OUTSIDE_CALENDAR
	) {
		return { message: EVENT_GET_MESSAGES.INVALID_RESOURCE_URL, configuration: true };
	}
	if (error instanceof XmlBuildError && error.code === 'INVALID_UID') {
		return { message: EVENT_GET_MESSAGES.INVALID_UID, configuration: true };
	}
	if (error instanceof CalDavTransportError) {
		return { ...eventTransportFailure(error), configuration: false };
	}
	if (error instanceof CalDavCalendarEventUidResolutionError) {
		if (error.code === CalendarEventUidResolutionFailureCode.NOT_FOUND) {
			return { message: EVENT_GET_MESSAGES.NOT_FOUND, configuration: false };
		}
		if (error.code === CalendarEventUidResolutionFailureCode.AMBIGUOUS) {
			return { message: EVENT_GET_MESSAGES.AMBIGUOUS, configuration: false };
		}
		return { message: EVENT_GET_MESSAGES.INVALID_RESPONSE, configuration: false };
	}
	if (error instanceof CalDavICalendarParseError) {
		return { message: EVENT_GET_MESSAGES.MALFORMED_ICALENDAR, configuration: false };
	}
	if (error instanceof CalDavCalendarEventReadModelError) {
		return { message: EVENT_GET_MESSAGES.UNSUPPORTED_EVENT, configuration: false };
	}
	if (
		error instanceof CalDavCalendarEventResourceGetError ||
		error instanceof CalDavXmlParseError ||
		error instanceof CalDavXmlProtocolError ||
		error instanceof CalDavUrlValidationError ||
		error instanceof XmlBuildError
	) {
		return { message: EVENT_GET_MESSAGES.INVALID_RESPONSE, configuration: false };
	}
	return { message: EVENT_GET_MESSAGES.GENERIC, configuration: false };
}

function eventDeleteTransportFailure(error: CalDavTransportError): SafeNodeFailure {
	switch (error.code) {
		case CalDavTransportErrorCode.AUTHENTICATION_FAILED:
			return apiFailure(EVENT_DELETE_MESSAGES.AUTHENTICATION, error);
		case CalDavTransportErrorCode.AUTHORIZATION_FAILED:
			return apiFailure(EVENT_DELETE_MESSAGES.AUTHORIZATION, error);
		case CalDavTransportErrorCode.NOT_FOUND:
			return apiFailure(EVENT_DELETE_MESSAGES.NOT_FOUND, error);
		case CalDavTransportErrorCode.PRECONDITION_FAILED:
			return apiFailure(EVENT_DELETE_MESSAGES.CONCURRENCY, error);
		case CalDavTransportErrorCode.TLS_VALIDATION_FAILED:
			return apiFailure(EVENT_DELETE_MESSAGES.TLS, error);
		case CalDavTransportErrorCode.TIMEOUT:
			return apiFailure(EVENT_DELETE_MESSAGES.TIMEOUT, error);
		case CalDavTransportErrorCode.RESPONSE_LIMIT_EXCEEDED:
			return apiFailure(EVENT_DELETE_MESSAGES.RESPONSE_LIMIT, error);
		case CalDavTransportErrorCode.INVALID_REDIRECT:
		case CalDavTransportErrorCode.INSECURE_REDIRECT:
		case CalDavTransportErrorCode.REDIRECT_LOOP:
		case CalDavTransportErrorCode.REDIRECT_LIMIT_EXCEEDED:
			return apiFailure(EVENT_DELETE_MESSAGES.REDIRECT, error);
		case CalDavTransportErrorCode.UNTRUSTED_TARGET:
			return apiFailure(EVENT_DELETE_MESSAGES.UNTRUSTED, error);
		case CalDavTransportErrorCode.NETWORK_ERROR:
			return apiFailure(EVENT_DELETE_MESSAGES.NETWORK, error);
		case CalDavTransportErrorCode.REMOTE_PROTOCOL_ERROR:
			return apiFailure(EVENT_DELETE_MESSAGES.INVALID_RESPONSE, error);
	}
}

interface EventDeleteFailure extends SafeNodeFailure {
	readonly configuration: boolean;
}

function eventDeleteFailure(error: unknown): EventDeleteFailure {
	if (error instanceof NodeApiError && error.message === EVENT_DELETE_MESSAGES.MISSING_ETAG) {
		return { message: EVENT_DELETE_MESSAGES.MISSING_ETAG, configuration: false };
	}
	if (
		error instanceof CalDavCalendarEventResourceGetError &&
		error.code === CalendarEventResourceGetFailureCode.OUTSIDE_CALENDAR
	) {
		return { message: EVENT_DELETE_MESSAGES.INVALID_RESOURCE_URL, configuration: true };
	}
	if (error instanceof XmlBuildError && error.code === 'INVALID_UID') {
		return { message: EVENT_DELETE_MESSAGES.INVALID_UID, configuration: true };
	}
	if (error instanceof CalDavTransportError) {
		return { ...eventDeleteTransportFailure(error), configuration: false };
	}
	if (error instanceof CalDavCalendarEventUidResolutionError) {
		if (error.code === CalendarEventUidResolutionFailureCode.NOT_FOUND) {
			return { message: EVENT_DELETE_MESSAGES.NOT_FOUND, configuration: false };
		}
		if (error.code === CalendarEventUidResolutionFailureCode.AMBIGUOUS) {
			return { message: EVENT_DELETE_MESSAGES.AMBIGUOUS, configuration: false };
		}
		return { message: EVENT_DELETE_MESSAGES.INVALID_RESPONSE, configuration: false };
	}
	if (error instanceof CalDavCalendarEventMutationError) {
		switch (error.code) {
			case CalendarEventMutationFailureCode.OUTSIDE_CALENDAR:
				return { message: EVENT_DELETE_MESSAGES.INVALID_RESPONSE, configuration: false };
			case CalendarEventMutationFailureCode.CONCURRENCY_CONFLICT:
				return { message: EVENT_DELETE_MESSAGES.CONCURRENCY, configuration: false };
			case CalendarEventMutationFailureCode.MISSING_ETAG:
				return { message: EVENT_DELETE_MESSAGES.MISSING_ETAG, configuration: false };
			case CalendarEventMutationFailureCode.CREATE_CONFLICT:
			case CalendarEventMutationFailureCode.INVALID_LOCATION:
			case CalendarEventMutationFailureCode.INVALID_RESPONSE:
				return { message: EVENT_DELETE_MESSAGES.INVALID_RESPONSE, configuration: false };
		}
	}
	if (error instanceof CalDavICalendarParseError) {
		return { message: EVENT_DELETE_MESSAGES.MALFORMED_ICALENDAR, configuration: false };
	}
	if (error instanceof CalDavCalendarEventReadModelError) {
		return { message: EVENT_DELETE_MESSAGES.UNSUPPORTED_EVENT, configuration: false };
	}
	if (
		error instanceof CalDavCalendarEventResourceGetError ||
		error instanceof CalDavXmlParseError ||
		error instanceof CalDavXmlProtocolError ||
		error instanceof CalDavUrlValidationError ||
		error instanceof XmlBuildError
	) {
		return { message: EVENT_DELETE_MESSAGES.INVALID_RESPONSE, configuration: false };
	}
	return { message: EVENT_DELETE_MESSAGES.GENERIC, configuration: false };
}

function eventCreateTransportFailure(error: CalDavTransportError): SafeNodeFailure {
	switch (error.code) {
		case CalDavTransportErrorCode.AUTHENTICATION_FAILED:
			return apiFailure(EVENT_CREATE_MESSAGES.AUTHENTICATION, error);
		case CalDavTransportErrorCode.AUTHORIZATION_FAILED:
			return apiFailure(EVENT_CREATE_MESSAGES.AUTHORIZATION, error);
		case CalDavTransportErrorCode.NOT_FOUND:
			return apiFailure(EVENT_CREATE_MESSAGES.NOT_FOUND, error);
		case CalDavTransportErrorCode.TLS_VALIDATION_FAILED:
			return apiFailure(EVENT_CREATE_MESSAGES.TLS, error);
		case CalDavTransportErrorCode.TIMEOUT:
			return apiFailure(EVENT_CREATE_MESSAGES.TIMEOUT, error);
		case CalDavTransportErrorCode.RESPONSE_LIMIT_EXCEEDED:
			return apiFailure(EVENT_CREATE_MESSAGES.RESPONSE_LIMIT, error);
		case CalDavTransportErrorCode.INVALID_REDIRECT:
		case CalDavTransportErrorCode.INSECURE_REDIRECT:
		case CalDavTransportErrorCode.REDIRECT_LOOP:
		case CalDavTransportErrorCode.REDIRECT_LIMIT_EXCEEDED:
			return apiFailure(EVENT_CREATE_MESSAGES.REDIRECT, error);
		case CalDavTransportErrorCode.UNTRUSTED_TARGET:
			return apiFailure(EVENT_CREATE_MESSAGES.UNTRUSTED, error);
		case CalDavTransportErrorCode.NETWORK_ERROR:
			return apiFailure(EVENT_CREATE_MESSAGES.NETWORK, error);
		case CalDavTransportErrorCode.PRECONDITION_FAILED:
		case CalDavTransportErrorCode.REMOTE_PROTOCOL_ERROR:
			return apiFailure(EVENT_CREATE_MESSAGES.INVALID_RESPONSE, error);
	}
}

interface EventCreateFailure extends SafeNodeFailure {
	readonly configuration: boolean;
}

function eventCreateSerializationFailure(error: CalDavICalendarSerializeError): EventCreateFailure {
	if (error.code === CalDavICalendarSerializeErrorCode.RESOURCE_LIMIT_EXCEEDED) {
		return { message: EVENT_CREATE_MESSAGES.RESOURCE_LIMIT, configuration: true };
	}
	if (error.code === CalDavICalendarSerializeErrorCode.INVALID_TIME_RANGE) {
		return { message: EVENT_CREATE_MESSAGES.INVALID_RANGE, configuration: true };
	}
	if (error.field === 'uid') {
		return { message: EVENT_CREATE_MESSAGES.INVALID_UID, configuration: true };
	}
	if (error.field === 'start') {
		return { message: EVENT_CREATE_MESSAGES.INVALID_START, configuration: true };
	}
	if (error.field === 'end') {
		return { message: EVENT_CREATE_MESSAGES.INVALID_END, configuration: true };
	}
	if (error.field === 'summary') {
		return { message: EVENT_CREATE_MESSAGES.INVALID_SUMMARY, configuration: true };
	}
	if (error.field === 'description') {
		return { message: EVENT_CREATE_MESSAGES.INVALID_DESCRIPTION, configuration: true };
	}
	if (error.field === 'location') {
		return { message: EVENT_CREATE_MESSAGES.INVALID_LOCATION, configuration: true };
	}
	if (error.field === 'url') {
		return { message: EVENT_CREATE_MESSAGES.INVALID_URL, configuration: true };
	}
	return { message: EVENT_CREATE_MESSAGES.GENERIC, configuration: false };
}

function eventCreateFailure(error: unknown): EventCreateFailure {
	if (error instanceof CalDavCalendarEventCreateError) {
		switch (error.code) {
			case CalendarEventCreateFailureCode.RESOURCE_NAME_TOO_LONG:
				return { message: EVENT_CREATE_MESSAGES.RESOURCE_NAME_TOO_LONG, configuration: true };
			case CalendarEventCreateFailureCode.ETAG_RETRIEVAL_FAILED:
				return {
					message: EVENT_CREATE_MESSAGES.PARTIAL_SUCCESS,
					configuration: false,
					...(error.statusCode === undefined ? {} : { httpCode: String(error.statusCode) }),
				};
			case CalendarEventCreateFailureCode.NORMALIZATION_FAILED:
				return { message: EVENT_CREATE_MESSAGES.INVALID_RESPONSE, configuration: false };
			case CalendarEventCreateFailureCode.INVALID_CLOCK:
				return { message: EVENT_CREATE_MESSAGES.GENERIC, configuration: false };
		}
	}
	if (error instanceof CalDavICalendarSerializeError) {
		return eventCreateSerializationFailure(error);
	}
	if (error instanceof CalDavCalendarEventMutationError) {
		switch (error.code) {
			case CalendarEventMutationFailureCode.CREATE_CONFLICT:
				return { message: EVENT_CREATE_MESSAGES.CONFLICT, configuration: false };
			case CalendarEventMutationFailureCode.OUTSIDE_CALENDAR:
			case CalendarEventMutationFailureCode.CONCURRENCY_CONFLICT:
			case CalendarEventMutationFailureCode.MISSING_ETAG:
			case CalendarEventMutationFailureCode.INVALID_LOCATION:
			case CalendarEventMutationFailureCode.INVALID_RESPONSE:
				return { message: EVENT_CREATE_MESSAGES.INVALID_RESPONSE, configuration: false };
		}
	}
	if (error instanceof CalDavTransportError) {
		return { ...eventCreateTransportFailure(error), configuration: false };
	}
	if (
		error instanceof CalDavICalendarParseError ||
		error instanceof CalDavCalendarEventReadModelError ||
		error instanceof CalDavUrlValidationError
	) {
		return { message: EVENT_CREATE_MESSAGES.INVALID_RESPONSE, configuration: false };
	}
	return { message: EVENT_CREATE_MESSAGES.GENERIC, configuration: false };
}

function eventDeleteValidator(
	uiEtag: string | undefined,
	serverEtag: string | undefined,
): string | undefined {
	if (uiEtag !== undefined && uiEtag.length > 0) {
		return uiEtag;
	}
	return serverEtag;
}

function eventDeleteApiError(
	node: ReturnType<IExecuteFunctions['getNode']>,
	failure: SafeNodeFailure,
	itemIndex: number,
): NodeApiError {
	const error = new NodeApiError(
		node,
		{},
		{
			message: failure.message,
			itemIndex,
			...(failure.httpCode === undefined ? {} : { httpCode: failure.httpCode }),
		},
	);
	if (failure.httpCode !== undefined) {
		error.context.httpCode = failure.httpCode;
	}
	return error;
}

function eventGetManyTransportFailure(error: CalDavTransportError): SafeNodeFailure {
	switch (error.code) {
		case CalDavTransportErrorCode.AUTHENTICATION_FAILED:
			return apiFailure(EVENT_GET_MANY_MESSAGES.AUTHENTICATION, error);
		case CalDavTransportErrorCode.AUTHORIZATION_FAILED:
			return apiFailure(EVENT_GET_MANY_MESSAGES.AUTHORIZATION, error);
		case CalDavTransportErrorCode.NOT_FOUND:
			return apiFailure(EVENT_GET_MANY_MESSAGES.NOT_FOUND, error);
		case CalDavTransportErrorCode.TLS_VALIDATION_FAILED:
			return apiFailure(EVENT_GET_MANY_MESSAGES.TLS, error);
		case CalDavTransportErrorCode.TIMEOUT:
			return apiFailure(EVENT_GET_MANY_MESSAGES.TIMEOUT, error);
		case CalDavTransportErrorCode.RESPONSE_LIMIT_EXCEEDED:
			return apiFailure(EVENT_GET_MANY_MESSAGES.RESPONSE_LIMIT, error);
		case CalDavTransportErrorCode.INVALID_REDIRECT:
		case CalDavTransportErrorCode.INSECURE_REDIRECT:
		case CalDavTransportErrorCode.REDIRECT_LOOP:
		case CalDavTransportErrorCode.REDIRECT_LIMIT_EXCEEDED:
			return apiFailure(EVENT_GET_MANY_MESSAGES.REDIRECT, error);
		case CalDavTransportErrorCode.UNTRUSTED_TARGET:
			return apiFailure(EVENT_GET_MANY_MESSAGES.UNTRUSTED, error);
		case CalDavTransportErrorCode.NETWORK_ERROR:
			return apiFailure(EVENT_GET_MANY_MESSAGES.NETWORK, error);
		case CalDavTransportErrorCode.PRECONDITION_FAILED:
		case CalDavTransportErrorCode.REMOTE_PROTOCOL_ERROR:
			return apiFailure(EVENT_GET_MANY_MESSAGES.INVALID_RESPONSE, error);
	}
}

function eventGetManyFailure(error: unknown): SafeNodeFailure {
	if (error instanceof CalDavTransportError) {
		return eventGetManyTransportFailure(error);
	}
	if (error instanceof CalDavICalendarParseError) {
		return apiFailure(EVENT_GET_MANY_MESSAGES.MALFORMED_ICALENDAR);
	}
	if (error instanceof CalDavCalendarEventReadModelError) {
		return apiFailure(EVENT_GET_MANY_MESSAGES.UNSUPPORTED_EVENT);
	}
	if (
		error instanceof CalDavXmlParseError ||
		error instanceof CalDavXmlProtocolError ||
		error instanceof CalDavUrlValidationError ||
		error instanceof XmlBuildError
	) {
		return apiFailure(EVENT_GET_MANY_MESSAGES.INVALID_RESPONSE);
	}
	return apiFailure(EVENT_GET_MANY_MESSAGES.GENERIC);
}

function daysInGregorianMonth(year: number, month: number): number {
	if (month === 2) {
		return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
	}
	return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isValidWholeSecondInstant(value: Date): boolean {
	const timestamp = value.getTime();
	if (!Number.isFinite(timestamp) || timestamp % 1000 !== 0) return false;
	const utcYear = value.getUTCFullYear();
	return utcYear >= 0 && utcYear <= 9999;
}

function parseZonedIsoInstant(value: string): Date | undefined {
	const match = ZONED_ISO_INSTANT_PATTERN.exec(value);
	if (match === null) return undefined;

	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	const fractionalSecond = match[7];
	const offsetHour = match[8] === undefined ? Number(match[10]) : 0;
	const offsetMinute = match[8] === undefined ? Number(match[11]) : 0;
	if (
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > daysInGregorianMonth(year, month) ||
		hour > 23 ||
		minute > 59 ||
		second > 59 ||
		(fractionalSecond !== undefined && !/^0+$/.test(fractionalSecond)) ||
		offsetHour > 23 ||
		offsetMinute > 59
	) {
		return undefined;
	}

	const localInstant = new Date(0);
	localInstant.setUTCFullYear(year, month - 1, day);
	localInstant.setUTCHours(hour, minute, second, 0);
	const offsetDirection = match[9] === '-' ? -1 : 1;
	const offsetMilliseconds = offsetDirection * (offsetHour * 60 + offsetMinute) * 60 * 1000;
	const instant = new Date(localInstant.getTime() - offsetMilliseconds);
	return isValidWholeSecondInstant(instant) ? instant : undefined;
}

function parseDateTimeInstant(value: unknown): Date | undefined {
	if (value instanceof Date) {
		return isValidWholeSecondInstant(value) ? new Date(value.getTime()) : undefined;
	}
	if (typeof value === 'string') {
		return parseZonedIsoInstant(value);
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}

	try {
		const dateTime = value as {
			readonly isLuxonDateTime?: unknown;
			readonly isValid?: unknown;
			readonly toJSDate?: unknown;
		};
		if (
			dateTime.isLuxonDateTime !== true ||
			dateTime.isValid !== true ||
			typeof dateTime.toJSDate !== 'function'
		) {
			return undefined;
		}
		const converted = dateTime.toJSDate.call(value) as unknown;
		return converted instanceof Date && isValidWholeSecondInstant(converted)
			? new Date(converted.getTime())
			: undefined;
	} catch {
		return undefined;
	}
}

function isValidICalendarText(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			index += 1;
			continue;
		}
		if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
		if (codeUnit === 0x09 || codeUnit === 0x0a) continue;
		if (codeUnit < 0x20 || codeUnit === 0x7f) return false;
	}
	return true;
}

function createResourceNameFits(uid: string): boolean {
	const byteLength = Buffer.byteLength(uid, 'utf8');
	const padding = byteLength % 3 === 0 ? 0 : 3 - (byteLength % 3);
	const unpaddedBase64Length = Math.ceil(byteLength / 3) * 4 - padding;
	return unpaddedBase64Length + '.ics'.length <= 255;
}

const CREATE_VALIDATION_DTSTAMP = new Date('2040-01-01T00:00:00Z');
const CREATE_VALIDATION_START = new Date('2040-01-01T01:00:00Z');
const CREATE_VALIDATION_END = new Date('2040-01-01T02:00:00Z');

function isValidCreateUrl(value: string): boolean {
	try {
		serializeBasicUtcEvent({
			uid: 'validation@example.test',
			dtstamp: CREATE_VALIDATION_DTSTAMP,
			start: CREATE_VALIDATION_START,
			end: CREATE_VALIDATION_END,
			summary: '',
			url: value,
		});
		return true;
	} catch {
		return false;
	}
}

function createDateTimeInstant(value: unknown): Date | undefined {
	try {
		const instant = parseDateTimeInstant(value);
		if (instant === undefined) return undefined;
		const year = instant.getUTCFullYear();
		return year >= 1 && year <= 9999 ? instant : undefined;
	} catch {
		return undefined;
	}
}

function ownAdditionalField(
	additionalFields: Record<PropertyKey, unknown>,
	name: 'description' | 'location' | 'url',
	present: boolean,
): { readonly present: boolean; readonly value?: unknown } {
	if (!present) return { present: false };
	try {
		return { present: true, value: Reflect.get(additionalFields, name) };
	} catch {
		return { present: true };
	}
}

function eventCreateInput(
	execution: IExecuteFunctions,
	itemIndex: number,
): CalendarEventCreateInput | string {
	const calendarUrl = calendarLocatorUrl(nodeParameter(execution, 'calendar', itemIndex));
	if (calendarUrl === undefined) return EVENT_CREATE_MESSAGES.INVALID_CALENDAR_URL;

	const uidValue = nodeParameter(execution, 'uid', itemIndex);
	if (typeof uidValue !== 'string' || uidValue.length === 0 || !isValidICalendarText(uidValue)) {
		return EVENT_CREATE_MESSAGES.INVALID_UID;
	}
	if (!createResourceNameFits(uidValue)) return EVENT_CREATE_MESSAGES.RESOURCE_NAME_TOO_LONG;

	const start = createDateTimeInstant(nodeParameter(execution, 'start', itemIndex));
	if (start === undefined) return EVENT_CREATE_MESSAGES.INVALID_START;
	const end = createDateTimeInstant(nodeParameter(execution, 'end', itemIndex));
	if (end === undefined) return EVENT_CREATE_MESSAGES.INVALID_END;

	const summary = nodeParameter(execution, 'summary', itemIndex);
	if (typeof summary !== 'string' || !isValidICalendarText(summary)) {
		return EVENT_CREATE_MESSAGES.INVALID_SUMMARY;
	}

	const additionalFieldsValue = nodeParameter(execution, 'additionalFields', itemIndex);
	if (
		typeof additionalFieldsValue !== 'object' ||
		additionalFieldsValue === null ||
		Array.isArray(additionalFieldsValue)
	) {
		return EVENT_CREATE_MESSAGES.INVALID_ADDITIONAL_FIELDS;
	}
	let keys: readonly PropertyKey[];
	try {
		keys = Reflect.ownKeys(additionalFieldsValue);
	} catch {
		return EVENT_CREATE_MESSAGES.INVALID_ADDITIONAL_FIELDS;
	}
	if (
		keys.some((key) => typeof key !== 'string' || !['description', 'location', 'url'].includes(key))
	) {
		return EVENT_CREATE_MESSAGES.INVALID_ADDITIONAL_FIELDS;
	}
	const additionalFields = additionalFieldsValue as Record<PropertyKey, unknown>;
	const descriptionField = ownAdditionalField(
		additionalFields,
		'description',
		keys.includes('description'),
	);
	if (
		descriptionField.present &&
		(typeof descriptionField.value !== 'string' || !isValidICalendarText(descriptionField.value))
	) {
		return EVENT_CREATE_MESSAGES.INVALID_DESCRIPTION;
	}
	const locationField = ownAdditionalField(additionalFields, 'location', keys.includes('location'));
	if (
		locationField.present &&
		(typeof locationField.value !== 'string' || !isValidICalendarText(locationField.value))
	) {
		return EVENT_CREATE_MESSAGES.INVALID_LOCATION;
	}
	const urlField = ownAdditionalField(additionalFields, 'url', keys.includes('url'));
	if (
		urlField.present &&
		(typeof urlField.value !== 'string' || !isValidCreateUrl(urlField.value))
	) {
		return EVENT_CREATE_MESSAGES.INVALID_URL;
	}

	if (end.getTime() <= start.getTime()) return EVENT_CREATE_MESSAGES.INVALID_RANGE;
	return Object.freeze({
		calendarUrl,
		uid: uidValue,
		start,
		end,
		summary,
		...(descriptionField.present ? { description: descriptionField.value as string } : {}),
		...(locationField.present ? { location: locationField.value as string } : {}),
		...(urlField.present ? { url: urlField.value as string } : {}),
	});
}

interface EventGetManyInput {
	readonly calendarUrl: AbsoluteHttpUrl;
	readonly start: Date;
	readonly end: Date;
	readonly limit?: number;
}

function nodeParameter(execution: IExecuteFunctions, name: string, itemIndex: number): unknown {
	try {
		return execution.getNodeParameter(name, itemIndex);
	} catch {
		return undefined;
	}
}

function eventGetManyInput(
	execution: IExecuteFunctions,
	itemIndex: number,
): EventGetManyInput | string {
	const calendarUrl = calendarLocatorUrl(nodeParameter(execution, 'calendar', itemIndex));
	if (calendarUrl === undefined) return EVENT_GET_MANY_MESSAGES.INVALID_CALENDAR_URL;

	const start = parseDateTimeInstant(nodeParameter(execution, 'start', itemIndex));
	if (start === undefined) return EVENT_GET_MANY_MESSAGES.INVALID_START;
	const end = parseDateTimeInstant(nodeParameter(execution, 'end', itemIndex));
	if (end === undefined) return EVENT_GET_MANY_MESSAGES.INVALID_END;
	if (start.getTime() >= end.getTime()) return EVENT_GET_MANY_MESSAGES.INVALID_RANGE;

	const returnAll = nodeParameter(execution, 'returnAll', itemIndex);
	if (typeof returnAll !== 'boolean') return EVENT_GET_MANY_MESSAGES.INVALID_RETURN_ALL;
	if (returnAll) return { calendarUrl, start, end };

	const limit = nodeParameter(execution, 'limit', itemIndex);
	if (
		typeof limit !== 'number' ||
		!Number.isFinite(limit) ||
		!Number.isInteger(limit) ||
		limit < 1
	) {
		return EVENT_GET_MANY_MESSAGES.INVALID_LIMIT;
	}
	return { calendarUrl, start, end, limit };
}

const SAFE_DOMAIN_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
	AUTHENTICATION_FAILED: 'CalDAV authentication failed.',
	AUTHORIZATION_FAILED: 'The CalDAV request is not authorized.',
	NOT_FOUND: 'The requested CalDAV resource was not found.',
	TLS_VALIDATION_FAILED: 'TLS certificate validation failed.',
	TIMEOUT: 'The CalDAV request timed out after 30 seconds.',
	RESPONSE_LIMIT_EXCEEDED: 'The CalDAV response exceeded the 10 MiB size limit.',
	REMOTE_PROTOCOL_ERROR: 'The CalDAV server returned an unexpected response.',
	NETWORK_ERROR: 'The CalDAV server could not be reached.',
	INVALID_REDIRECT: 'The CalDAV server returned an invalid redirect.',
	INSECURE_REDIRECT: 'The CalDAV redirect would use an insecure connection.',
	UNTRUSTED_TARGET: 'The CalDAV request target is not trusted.',
	REDIRECT_LOOP: 'The CalDAV request encountered a redirect loop.',
	REDIRECT_LIMIT_EXCEEDED: 'The CalDAV request exceeded the 5-redirect limit.',
	MALFORMED_URL: 'The URL is malformed.',
	MALFORMED_PERCENT_ENCODING: 'The URL contains malformed percent-encoding.',
	UNSUPPORTED_SCHEME: 'The URL scheme is not supported.',
	USERINFO_NOT_ALLOWED: 'URL userinfo is not allowed.',
	FRAGMENT_NOT_ALLOWED: 'URL fragments are not allowed.',
	DOT_SEGMENT_NOT_ALLOWED: 'URL dot segments are not allowed.',
	INSECURE_PROTOCOL_DOWNGRADE: 'An insecure protocol downgrade is not allowed.',
	INVALID_RESOURCE_NAME: 'The calendar resource name is invalid.',
	FORBIDDEN_DECLARATION: 'The XML document contains a forbidden declaration.',
	MALFORMED_XML: 'The XML document is malformed.',
	TRUNCATED_XML: 'The XML document ended unexpectedly.',
	INVALID_CHARACTER_REFERENCE: 'The XML document contains an invalid character reference.',
	UNSUPPORTED_ENTITY_REFERENCE: 'The XML document contains an unsupported entity reference.',
	DUPLICATE_ATTRIBUTE: 'The XML document contains a duplicate attribute.',
	INVALID_QUALIFIED_NAME: 'The XML document contains an invalid qualified name.',
	INVALID_NAMESPACE_DECLARATION: 'The XML document contains an invalid namespace declaration.',
	UNBOUND_NAMESPACE_PREFIX: 'The XML document uses an unbound namespace prefix.',
	MAX_DEPTH_EXCEEDED: 'The XML document exceeds the maximum nesting depth.',
	MAX_ELEMENT_COUNT_EXCEEDED: 'The XML document exceeds the maximum element count.',
	INVALID_MULTISTATUS: 'The WebDAV multistatus response is invalid.',
	INVALID_RESPONSE: 'A WebDAV response element is invalid.',
	INVALID_PROPSTAT: 'A WebDAV propstat element is invalid.',
	INVALID_STATUS: 'A WebDAV status element is invalid.',
	CURRENT_USER_PRINCIPAL_UNAUTHENTICATED:
		'The CalDAV server did not authenticate the current user.',
	CURRENT_USER_PRINCIPAL_UNAVAILABLE: 'The CalDAV current-user principal is unavailable.',
	INVALID_CURRENT_USER_PRINCIPAL_RESPONSE:
		'The CalDAV server returned an invalid current-user principal response.',
	AMBIGUOUS_CURRENT_USER_PRINCIPAL_RESPONSE:
		'The CalDAV server returned an ambiguous current-user principal response.',
	CALENDAR_HOME_MISSING: 'The CalDAV calendar-home property is unavailable.',
	CALENDAR_HOME_FORBIDDEN: 'The CalDAV calendar-home property is forbidden.',
	INVALID_CALENDAR_HOME_RESPONSE: 'The CalDAV server returned an invalid calendar-home response.',
	AMBIGUOUS_CALENDAR_HOME_RESPONSE:
		'The CalDAV server returned an ambiguous calendar-home response.',
	INVALID_CALENDAR_COLLECTION_RESPONSE:
		'The CalDAV server returned an invalid calendar-collection response.',
	AMBIGUOUS_CALENDAR_COLLECTION_PROPERTY:
		'The CalDAV server returned an ambiguous calendar-collection property.',
});
const SAFE_DOMAIN_ERROR_MESSAGE_SET = new Set(Object.values(SAFE_DOMAIN_ERROR_MESSAGES));

function compareUnicodeScalarSequences(left: string, right: string): number {
	const leftScalars = Array.from(left);
	const rightScalars = Array.from(right);
	const sharedLength = Math.min(leftScalars.length, rightScalars.length);

	for (let index = 0; index < sharedLength; index++) {
		const leftScalar = leftScalars[index].codePointAt(0);
		const rightScalar = rightScalars[index].codePointAt(0);
		if (leftScalar !== rightScalar) {
			return (leftScalar ?? 0) < (rightScalar ?? 0) ? -1 : 1;
		}
	}

	if (leftScalars.length === rightScalars.length) return 0;
	return leftScalars.length < rightScalars.length ? -1 : 1;
}

function compareCalendarCollections(left: CalendarCollection, right: CalendarCollection): number {
	const displayNameComparison = compareUnicodeScalarSequences(
		left.displayName ?? '',
		right.displayName ?? '',
	);
	return displayNameComparison !== 0
		? displayNameComparison
		: compareUnicodeScalarSequences(left.url, right.url);
}

function activeLimit(
	value: unknown,
	itemIndex: number,
	node: ReturnType<IExecuteFunctions['getNode']>,
): number {
	if (
		typeof value !== 'number' ||
		!Number.isFinite(value) ||
		!Number.isInteger(value) ||
		value < 1
	) {
		throw new NodeOperationError(node, INVALID_LIMIT_MESSAGE, { itemIndex });
	}
	return value;
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== 'object' || error === null) return undefined;
	try {
		const code = (error as { readonly code?: unknown }).code;
		return typeof code === 'string' ? code : undefined;
	} catch {
		return undefined;
	}
}

function safeErrorMessage(error: unknown): string {
	if (error instanceof NodeOperationError) {
		return error.message === INVALID_LIMIT_MESSAGE ||
			error.message === UNSUPPORTED_OPERATION_MESSAGE
			? error.message
			: GENERIC_GET_MANY_ERROR_MESSAGE;
	}
	if (error instanceof NodeApiError && SAFE_DOMAIN_ERROR_MESSAGE_SET.has(error.message)) {
		return error.message;
	}
	const code = errorCode(error);
	return code === undefined
		? GENERIC_GET_MANY_ERROR_MESSAGE
		: (SAFE_DOMAIN_ERROR_MESSAGES[code] ?? GENERIC_GET_MANY_ERROR_MESSAGE);
}

function safeListSearchErrorMessage(error: unknown): string {
	if (error instanceof NodeApiError && SAFE_DOMAIN_ERROR_MESSAGE_SET.has(error.message)) {
		return error.message;
	}
	const code = errorCode(error);
	return code === undefined
		? GENERIC_LIST_SEARCH_ERROR_MESSAGE
		: (SAFE_DOMAIN_ERROR_MESSAGES[code] ?? GENERIC_LIST_SEARCH_ERROR_MESSAGE);
}

function capabilityValue(value: boolean | null): 'yes' | 'no' | 'unknown' {
	return value === null ? 'unknown' : value ? 'yes' : 'no';
}

function calendarOptionDescription(collection: CalendarCollection): string {
	return `Read: ${capabilityValue(collection.canRead)}; Write: ${capabilityValue(collection.canWrite)}`;
}

function calendarOptionLabels(
	collections: readonly CalendarCollection[],
): ReadonlyMap<CalendarCollection, string> {
	const candidates = collections.map((collection) => collection.displayName || collection.url);
	const counts = new Map<string, number>();
	for (const candidate of candidates) {
		counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
	}

	const labels = new Map<CalendarCollection, string>();
	collections.forEach((collection, index) => {
		const candidate = candidates[index];
		labels.set(
			collection,
			(counts.get(candidate) ?? 0) > 1 ? `${candidate} — ${collection.url}` : candidate,
		);
	});
	return labels;
}

async function searchCalendars(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	void paginationToken;
	try {
		const transport = await createN8nCalDavTransport(this);
		const collections = [...(await discoverCalendarsForCurrentUser(transport))].sort(
			compareCalendarCollections,
		);
		const labels = calendarOptionLabels(collections);
		const foldedFilter = filter?.toLowerCase();
		const selected =
			foldedFilter === undefined || foldedFilter.length === 0
				? collections
				: collections.filter((collection) => {
						const label = labels.get(collection) ?? collection.url;
						return (
							label.toLowerCase().includes(foldedFilter) ||
							collection.url.toLowerCase().includes(foldedFilter)
						);
					});

		return {
			results: selected.map((collection) => ({
				name: labels.get(collection) ?? collection.url,
				value: collection.url,
				description: calendarOptionDescription(collection),
			})),
		};
	} catch (error) {
		const message = safeListSearchErrorMessage(error);
		throw new NodeApiError(this.getNode(), {}, { message });
	}
}

function asJson(collection: CalendarCollection): IDataObject {
	return collection as unknown as IDataObject;
}

export class CalDav implements INodeType {
	methods = {
		credentialTest: { testCalDavApiCredentials },
		listSearch: { searchCalendars },
	};

	description: INodeTypeDescription = {
		displayName: 'CalDAV',
		name: 'calDav',
		icon: { light: 'file:caldav.svg', dark: 'file:caldav.dark.svg' },
		group: ['transform'],
		version: 1,
		description: 'Manage calendars and events over CalDAV',
		subtitle: 'CalDAV',
		defaults: { name: 'CalDAV' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [{ name: 'calDavApi', required: true, testedBy: 'testCalDavApiCredentials' }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Calendar', value: CALENDAR_RESOURCE },
					{ name: 'Event', value: EVENT_RESOURCE },
				],
				default: CALENDAR_RESOURCE,
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: [CALENDAR_RESOURCE] } },
				options: [
					{
						name: 'Get',
						value: GET_OPERATION,
						description: 'Retrieve a calendar collection',
						action: 'Retrieve a calendar collection',
					},
					{
						name: 'Get Many',
						value: GET_MANY_OPERATION,
						description: 'Return accessible event calendars',
						action: 'Get many calendars',
					},
				],
				default: GET_OPERATION,
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: [EVENT_RESOURCE] } },
				options: [
					{
						name: 'Create',
						value: CREATE_OPERATION,
						description: 'Create a calendar event',
						action: 'Create a calendar event',
					},
					{
						name: 'Get',
						value: GET_OPERATION,
						description: 'Retrieve a calendar event',
						action: 'Retrieve a calendar event',
					},
					{
						name: 'Get Many',
						value: GET_MANY_OPERATION,
						description: 'Retrieve events in a date range',
						action: 'Get many events',
					},
					{
						name: 'Delete',
						value: DELETE_OPERATION,
						description: 'Delete a calendar event',
						action: 'Delete a calendar event',
					},
				],
				default: GET_OPERATION,
			},
			{
				displayName: 'Return All',
				name: 'returnAll',
				type: 'boolean',
				default: false,
				description: 'Whether to return all results or only up to a given limit',
				displayOptions: {
					show: { resource: [CALENDAR_RESOURCE], operation: [GET_MANY_OPERATION] },
				},
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 50,
				description: 'Max number of results to return',
				displayOptions: {
					show: {
						resource: [CALENDAR_RESOURCE],
						operation: [GET_MANY_OPERATION],
						returnAll: [false],
					},
				},
			},
			{
				displayName: 'Calendar',
				name: 'calendar',
				type: 'resourceLocator',
				required: true,
				default: { mode: 'url', value: '' },
				displayOptions: {
					show: {
						resource: [CALENDAR_RESOURCE, EVENT_RESOURCE],
						operation: [CREATE_OPERATION, GET_OPERATION, GET_MANY_OPERATION, DELETE_OPERATION],
					},
					hide: {
						resource: [CALENDAR_RESOURCE],
						operation: [GET_MANY_OPERATION],
					},
				},
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						typeOptions: {
							searchListMethod: 'searchCalendars',
							searchable: true,
						},
					},
					{
						displayName: 'By URL',
						name: 'url',
						type: 'string',
						hint: 'Enter an absolute calendar collection URL',
					},
				],
			},
			{
				displayName: 'UID',
				name: 'uid',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: { resource: [EVENT_RESOURCE], operation: [CREATE_OPERATION] },
				},
			},
			{
				displayName: 'Start',
				name: 'start',
				type: 'dateTime',
				required: true,
				default: '',
				displayOptions: {
					show: { resource: [EVENT_RESOURCE], operation: [CREATE_OPERATION] },
				},
			},
			{
				displayName: 'End',
				name: 'end',
				type: 'dateTime',
				required: true,
				default: '',
				displayOptions: {
					show: { resource: [EVENT_RESOURCE], operation: [CREATE_OPERATION] },
				},
			},
			{
				displayName: 'Summary',
				name: 'summary',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: { resource: [EVENT_RESOURCE], operation: [CREATE_OPERATION] },
				},
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: {
					show: { resource: [EVENT_RESOURCE], operation: [CREATE_OPERATION] },
				},
				options: [
					{
						displayName: 'Description',
						name: 'description',
						type: 'string',
						typeOptions: { rows: 4 },
						default: '',
					},
					{
						displayName: 'Location',
						name: 'location',
						type: 'string',
						default: '',
					},
					{
						displayName: 'URL',
						name: 'url',
						type: 'string',
						default: '',
					},
				],
			},
			{
				displayName: 'Start',
				name: 'start',
				type: 'dateTime',
				required: true,
				default: '',
				description: 'Inclusive start of the date range',
				displayOptions: {
					show: { resource: [EVENT_RESOURCE], operation: [GET_MANY_OPERATION] },
				},
			},
			{
				displayName: 'End',
				name: 'end',
				type: 'dateTime',
				required: true,
				default: '',
				description: 'Exclusive end of the date range',
				displayOptions: {
					show: { resource: [EVENT_RESOURCE], operation: [GET_MANY_OPERATION] },
				},
			},
			{
				displayName: 'Return All',
				name: 'returnAll',
				type: 'boolean',
				default: false,
				description: 'Whether to return all results or only up to a given limit',
				displayOptions: {
					show: { resource: [EVENT_RESOURCE], operation: [GET_MANY_OPERATION] },
				},
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 50,
				description: 'Max number of results to return',
				displayOptions: {
					show: {
						resource: [EVENT_RESOURCE],
						operation: [GET_MANY_OPERATION],
						returnAll: [false],
					},
				},
			},
			{
				displayName: 'Identifier Mode',
				name: 'identifierMode',
				type: 'options',
				required: true,
				noDataExpression: true,
				options: [
					{ name: 'Resource URL', value: RESOURCE_URL_IDENTIFIER_MODE },
					{ name: 'UID', value: UID_IDENTIFIER_MODE },
				],
				default: RESOURCE_URL_IDENTIFIER_MODE,
				displayOptions: {
					show: {
						resource: [EVENT_RESOURCE],
						operation: [GET_OPERATION, DELETE_OPERATION],
					},
				},
			},
			{
				displayName: 'Resource URL',
				name: 'resourceUrl',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: [EVENT_RESOURCE],
						operation: [GET_OPERATION, DELETE_OPERATION],
						identifierMode: [RESOURCE_URL_IDENTIFIER_MODE],
					},
				},
			},
			{
				displayName: 'UID',
				name: 'uid',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: [EVENT_RESOURCE],
						operation: [GET_OPERATION, DELETE_OPERATION],
						identifierMode: [UID_IDENTIFIER_MODE],
					},
				},
			},
			{
				displayName: 'ETag',
				name: 'etag',
				type: 'string',
				default: '',
				displayOptions: {
					show: { resource: [EVENT_RESOURCE], operation: [DELETE_OPERATION] },
				},
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		let getTransport: CalDavTransport | undefined;
		let getProvider: CalDavProviderAdapter | undefined;

		for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
			let resource: unknown;
			let operation: unknown;
			try {
				resource = this.getNodeParameter('resource', itemIndex);
				operation = this.getNodeParameter('operation', itemIndex);
			} catch {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: UNSUPPORTED_OPERATION_MESSAGE },
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				throw new NodeOperationError(this.getNode(), UNSUPPORTED_OPERATION_MESSAGE, {
					itemIndex,
				});
			}

			const isCalendarOperation =
				resource === CALENDAR_RESOURCE &&
				(operation === GET_OPERATION || operation === GET_MANY_OPERATION);
			const isEventCreate = resource === EVENT_RESOURCE && operation === CREATE_OPERATION;
			const isEventGet = resource === EVENT_RESOURCE && operation === GET_OPERATION;
			const isEventGetMany = resource === EVENT_RESOURCE && operation === GET_MANY_OPERATION;
			const isEventDelete = resource === EVENT_RESOURCE && operation === DELETE_OPERATION;
			if (
				!isCalendarOperation &&
				!isEventCreate &&
				!isEventGet &&
				!isEventGetMany &&
				!isEventDelete
			) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: UNSUPPORTED_OPERATION_MESSAGE },
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				throw new NodeOperationError(this.getNode(), UNSUPPORTED_OPERATION_MESSAGE, { itemIndex });
			}

			if (isEventCreate) {
				const input = eventCreateInput(this, itemIndex);
				if (typeof input === 'string') {
					if (this.continueOnFail()) {
						returnData.push({ json: { error: input }, pairedItem: { item: itemIndex } });
						continue;
					}
					throw new NodeOperationError(this.getNode(), input, { itemIndex });
				}

				try {
					if (getTransport === undefined) {
						getTransport = await createN8nCalDavTransport(this);
					}
					const created = await createCalendarEvent(getTransport, input, () => new Date());
					returnData.push({ json: eventJson(created), pairedItem: { item: itemIndex } });
				} catch (error) {
					const failure = eventCreateFailure(error);
					if (this.continueOnFail()) {
						returnData.push({
							json: { error: failure.message },
							pairedItem: { item: itemIndex },
						});
						continue;
					}
					if (failure.configuration) {
						throw new NodeOperationError(this.getNode(), failure.message, { itemIndex });
					}
					throw eventDeleteApiError(this.getNode(), failure, itemIndex);
				}
				continue;
			}

			if (isEventGetMany) {
				const input = eventGetManyInput(this, itemIndex);
				if (typeof input === 'string') {
					if (this.continueOnFail()) {
						returnData.push({ json: { error: input }, pairedItem: { item: itemIndex } });
						continue;
					}
					throw new NodeOperationError(this.getNode(), input, { itemIndex });
				}

				try {
					if (getTransport === undefined) {
						getTransport = await createN8nCalDavTransport(this);
					}
					const results = await queryCalendarEventsByTimeRange(getTransport, input.calendarUrl, {
						start: input.start,
						end: input.end,
					});
					const selected = input.limit === undefined ? results : results.slice(0, input.limit);
					const projected = selected.map((result) => ({
						json: eventJson(result.event),
						pairedItem: { item: itemIndex },
					}));
					returnData.push(...projected);
				} catch (error) {
					const failure = eventGetManyFailure(error);
					if (this.continueOnFail()) {
						returnData.push({
							json: { error: failure.message },
							pairedItem: { item: itemIndex },
						});
						continue;
					}
					throw new NodeApiError(
						this.getNode(),
						{},
						{
							message: failure.message,
							itemIndex,
							...(failure.httpCode === undefined ? {} : { httpCode: failure.httpCode }),
						},
					);
				}
				continue;
			}

			if (isEventDelete) {
				const calendar = nodeParameter(this, 'calendar', itemIndex);
				const identifierMode = nodeParameter(this, 'identifierMode', itemIndex);

				const calendarUrl = calendarLocatorUrl(calendar);
				if (calendarUrl === undefined) {
					if (this.continueOnFail()) {
						returnData.push({
							json: { error: EVENT_DELETE_MESSAGES.INVALID_CALENDAR_URL },
							pairedItem: { item: itemIndex },
						});
						continue;
					}
					throw new NodeOperationError(this.getNode(), EVENT_DELETE_MESSAGES.INVALID_CALENDAR_URL, {
						itemIndex,
					});
				}

				if (
					identifierMode !== RESOURCE_URL_IDENTIFIER_MODE &&
					identifierMode !== UID_IDENTIFIER_MODE
				) {
					if (this.continueOnFail()) {
						returnData.push({
							json: { error: UNSUPPORTED_OPERATION_MESSAGE },
							pairedItem: { item: itemIndex },
						});
						continue;
					}
					throw new NodeOperationError(this.getNode(), UNSUPPORTED_OPERATION_MESSAGE, {
						itemIndex,
					});
				}

				let identifier: unknown;
				try {
					identifier = this.getNodeParameter(identifierMode, itemIndex);
				} catch {
					identifier = undefined;
				}

				let resourceUrl: AbsoluteHttpUrl | undefined;
				let uid: string | undefined;
				if (identifierMode === RESOURCE_URL_IDENTIFIER_MODE) {
					try {
						resourceUrl =
							typeof identifier === 'string' && identifier.length > 0
								? validateAbsoluteHttpUrl(identifier)
								: undefined;
					} catch {
						resourceUrl = undefined;
					}
					if (resourceUrl === undefined) {
						if (this.continueOnFail()) {
							returnData.push({
								json: { error: EVENT_DELETE_MESSAGES.INVALID_RESOURCE_URL },
								pairedItem: { item: itemIndex },
							});
							continue;
						}
						throw new NodeOperationError(
							this.getNode(),
							EVENT_DELETE_MESSAGES.INVALID_RESOURCE_URL,
							{ itemIndex },
						);
					}
				} else {
					uid =
						typeof identifier === 'string' && identifier.length > 0 && isValidXmlText(identifier)
							? identifier
							: undefined;
					if (uid === undefined) {
						if (this.continueOnFail()) {
							returnData.push({
								json: { error: EVENT_DELETE_MESSAGES.INVALID_UID },
								pairedItem: { item: itemIndex },
							});
							continue;
						}
						throw new NodeOperationError(this.getNode(), EVENT_DELETE_MESSAGES.INVALID_UID, {
							itemIndex,
						});
					}
				}

				let uiEtag: unknown;
				try {
					uiEtag = this.getNodeParameter('etag', itemIndex);
				} catch {
					if (this.continueOnFail()) {
						returnData.push({
							json: { error: EVENT_DELETE_MESSAGES.INVALID_ETAG },
							pairedItem: { item: itemIndex },
						});
						continue;
					}
					throw new NodeOperationError(this.getNode(), EVENT_DELETE_MESSAGES.INVALID_ETAG, {
						itemIndex,
					});
				}
				if (uiEtag !== undefined && typeof uiEtag !== 'string') {
					if (this.continueOnFail()) {
						returnData.push({
							json: { error: EVENT_DELETE_MESSAGES.INVALID_ETAG },
							pairedItem: { item: itemIndex },
						});
						continue;
					}
					throw new NodeOperationError(this.getNode(), EVENT_DELETE_MESSAGES.INVALID_ETAG, {
						itemIndex,
					});
				}

				try {
					if (getTransport === undefined) {
						getTransport = await createN8nCalDavTransport(this);
					}
					const result =
						resourceUrl === undefined
							? await resolveCalendarEventByUid(getTransport, calendarUrl, uid!, {
									allowMissingEtag: true,
								})
							: await getCalendarEventByResourceUrl(getTransport, calendarUrl, resourceUrl, {
									allowMissingEtag: true,
								});
					const validator = eventDeleteValidator(uiEtag, result.event.etag);
					if (validator === undefined) {
						const failure = { message: EVENT_DELETE_MESSAGES.MISSING_ETAG };
						if (this.continueOnFail()) {
							returnData.push({
								json: { error: failure.message },
								pairedItem: { item: itemIndex },
							});
							continue;
						}
						throw eventDeleteApiError(this.getNode(), failure, itemIndex);
					}
					await deleteCalendarEventResource(
						getTransport,
						result.event.calendarUrl,
						result.event.resourceUrl,
						validator,
					);
					returnData.push({
						json: {
							calendarUrl: result.event.calendarUrl,
							resourceUrl: result.event.resourceUrl,
							uid: result.event.uid,
							deleted: true,
						},
						pairedItem: { item: itemIndex },
					});
				} catch (error) {
					const failure = eventDeleteFailure(error);
					if (this.continueOnFail()) {
						returnData.push({
							json: { error: failure.message },
							pairedItem: { item: itemIndex },
						});
						continue;
					}
					if (failure.configuration) {
						throw new NodeOperationError(this.getNode(), failure.message, { itemIndex });
					}
					throw eventDeleteApiError(this.getNode(), failure, itemIndex);
				}
				continue;
			}

			if (isEventGet) {
				let calendar: unknown;
				let identifierMode: unknown;
				try {
					calendar = this.getNodeParameter('calendar', itemIndex);
					identifierMode = this.getNodeParameter('identifierMode', itemIndex);
				} catch {
					if (this.continueOnFail()) {
						returnData.push({
							json: { error: UNSUPPORTED_OPERATION_MESSAGE },
							pairedItem: { item: itemIndex },
						});
						continue;
					}
					throw new NodeOperationError(this.getNode(), UNSUPPORTED_OPERATION_MESSAGE, {
						itemIndex,
					});
				}

				const calendarUrl = calendarLocatorUrl(calendar);
				if (calendarUrl === undefined) {
					if (this.continueOnFail()) {
						returnData.push({
							json: { error: EVENT_GET_MESSAGES.INVALID_CALENDAR_URL },
							pairedItem: { item: itemIndex },
						});
						continue;
					}
					throw new NodeOperationError(this.getNode(), EVENT_GET_MESSAGES.INVALID_CALENDAR_URL, {
						itemIndex,
					});
				}

				if (
					identifierMode !== RESOURCE_URL_IDENTIFIER_MODE &&
					identifierMode !== UID_IDENTIFIER_MODE
				) {
					if (this.continueOnFail()) {
						returnData.push({
							json: { error: UNSUPPORTED_OPERATION_MESSAGE },
							pairedItem: { item: itemIndex },
						});
						continue;
					}
					throw new NodeOperationError(this.getNode(), UNSUPPORTED_OPERATION_MESSAGE, {
						itemIndex,
					});
				}

				let identifier: unknown;
				try {
					identifier = this.getNodeParameter(identifierMode, itemIndex);
				} catch {
					identifier = undefined;
				}

				let resourceUrl: AbsoluteHttpUrl | undefined;
				let uid: string | undefined;
				if (identifierMode === RESOURCE_URL_IDENTIFIER_MODE) {
					try {
						resourceUrl =
							typeof identifier === 'string' && identifier.length > 0
								? validateAbsoluteHttpUrl(identifier)
								: undefined;
					} catch {
						resourceUrl = undefined;
					}
					if (resourceUrl === undefined) {
						if (this.continueOnFail()) {
							returnData.push({
								json: { error: EVENT_GET_MESSAGES.INVALID_RESOURCE_URL },
								pairedItem: { item: itemIndex },
							});
							continue;
						}
						throw new NodeOperationError(this.getNode(), EVENT_GET_MESSAGES.INVALID_RESOURCE_URL, {
							itemIndex,
						});
					}
				} else {
					uid =
						typeof identifier === 'string' && identifier.length > 0 && isValidXmlText(identifier)
							? identifier
							: undefined;
					if (uid === undefined) {
						if (this.continueOnFail()) {
							returnData.push({
								json: { error: EVENT_GET_MESSAGES.INVALID_UID },
								pairedItem: { item: itemIndex },
							});
							continue;
						}
						throw new NodeOperationError(this.getNode(), EVENT_GET_MESSAGES.INVALID_UID, {
							itemIndex,
						});
					}
				}

				try {
					if (getTransport === undefined) {
						getTransport = await createN8nCalDavTransport(this);
					}
					const result =
						resourceUrl === undefined
							? await resolveCalendarEventByUid(getTransport, calendarUrl, uid!)
							: await getCalendarEventByResourceUrl(getTransport, calendarUrl, resourceUrl);
					returnData.push({ json: eventJson(result.event), pairedItem: { item: itemIndex } });
				} catch (error) {
					const failure = eventGetFailure(error);
					if (this.continueOnFail()) {
						returnData.push({
							json: { error: failure.message },
							pairedItem: { item: itemIndex },
						});
						continue;
					}
					if (failure.configuration) {
						throw new NodeOperationError(this.getNode(), failure.message, { itemIndex });
					}
					throw new NodeApiError(
						this.getNode(),
						{},
						{
							message: failure.message,
							itemIndex,
							...(failure.httpCode === undefined ? {} : { httpCode: failure.httpCode }),
						},
					);
				}
				continue;
			}

			if (operation === GET_OPERATION) {
				let calendar: unknown;
				try {
					calendar = this.getNodeParameter('calendar', itemIndex);
				} catch (error) {
					const failure = safeGetFailure(error);
					if (this.continueOnFail()) {
						returnData.push({
							json: { error: failure.message },
							pairedItem: { item: itemIndex },
						});
						continue;
					}
					throw new NodeApiError(
						this.getNode(),
						{},
						{
							message: failure.message,
							itemIndex,
							...(failure.httpCode === undefined ? {} : { httpCode: failure.httpCode }),
						},
					);
				}

				const calendarUrl = calendarLocatorUrl(calendar);
				if (calendarUrl === undefined) {
					if (this.continueOnFail()) {
						returnData.push({
							json: { error: GET_MESSAGES.INVALID_CALENDAR_URL },
							pairedItem: { item: itemIndex },
						});
						continue;
					}
					throw new NodeOperationError(this.getNode(), GET_MESSAGES.INVALID_CALENDAR_URL, {
						itemIndex,
					});
				}

				try {
					if (getTransport === undefined) {
						getTransport = await createN8nCalDavTransport(this);
					}
					if (getProvider === undefined) {
						getProvider = defaultCalDavProviderRegistry.select(
							validateAbsoluteHttpUrl(getTransport.serverUrl),
						);
					}
					const collection = await getCalendarCollection(getTransport, calendarUrl, getProvider);
					returnData.push({ json: asJson(collection), pairedItem: { item: itemIndex } });
				} catch (error) {
					const failure = safeGetFailure(error);
					if (this.continueOnFail()) {
						returnData.push({
							json: { error: failure.message },
							pairedItem: { item: itemIndex },
						});
						continue;
					}
					throw new NodeApiError(
						this.getNode(),
						{},
						{
							message: failure.message,
							itemIndex,
							...(failure.httpCode === undefined ? {} : { httpCode: failure.httpCode }),
						},
					);
				}
				continue;
			}

			try {
				const returnAllValue = this.getNodeParameter('returnAll', itemIndex);
				if (typeof returnAllValue !== 'boolean') {
					throw new NodeOperationError(this.getNode(), UNSUPPORTED_OPERATION_MESSAGE, {
						itemIndex,
					});
				}
				const returnAll = returnAllValue;
				const limit = returnAll
					? undefined
					: activeLimit(this.getNodeParameter('limit', itemIndex), itemIndex, this.getNode());
				const transport = await createN8nCalDavTransport(this);
				const collections = await discoverCalendarsForCurrentUser(transport);
				const selected = [...collections].sort(compareCalendarCollections);
				const output = limit === undefined ? selected : selected.slice(0, limit);
				for (const collection of output) {
					returnData.push({ json: asJson(collection), pairedItem: { item: itemIndex } });
				}
			} catch (error) {
				const message = safeErrorMessage(error);
				if (this.continueOnFail()) {
					returnData.push({ json: { error: message }, pairedItem: { item: itemIndex } });
					continue;
				}
				if (error instanceof NodeOperationError) {
					throw new NodeOperationError(this.getNode(), error, { itemIndex });
				}
				throw new NodeApiError(this.getNode(), { message }, { message, itemIndex });
			}
		}

		return [returnData];
	}
}
