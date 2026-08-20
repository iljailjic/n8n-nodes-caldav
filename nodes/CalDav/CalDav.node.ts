import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeListSearchResult,
	INodeParameterResourceLocator,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
	NodeEgressFilter,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
// TZDIST is an anonymous embedded client whose socket needs a connect-time secure
// lookup while retaining the original hostname for Host, SNI, and TLS checks.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { request as httpsRequest } from 'node:https';

import {
	CalDavCalendarCollectionGetError,
	CalendarCollectionGetFailureCode,
	getCalendarCollection,
} from './actions/calendar/get';
import { discoverCalendarsForCurrentUser } from './discovery/calendarDiscovery';
import {
	CalDavTimeZoneReferenceError,
	createCalendarEventTimeZoneExecutionContext,
} from './discovery/timeZoneReferences';
import type {
	CalendarEventTimeZoneExecutionContext,
	TimeZoneDistributionRequest,
	TimeZoneDistributionRequestInput,
} from './discovery/timeZoneReferences';
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
import { resolveCalendarEventUid } from './events/uid';
import {
	CalDavCalendarEventUpdateError,
	CalendarEventUpdateFailureCode,
	updateCalendarEvent,
} from './events/update';
import type { CalendarEventUpdateInput } from './events/update';
import {
	CalDavCalendarEventUpsertError,
	CalendarEventUpsertFailureCode,
	upsertCalendarEvent,
} from './events/upsert';
import type { CalendarEventUpsertInput } from './events/upsert';
import { bindCalendarEventTimeZoneExecutionContext } from './events/timeZoneExecutionContext';
import { CalDavCalendarEventTimeZoneAuthoringError } from './events/timeZoneAuthoring';
import { queryCalendarEventsByTimeRange } from './events/timeRangeQuery';
import { CalDavCalendarEventReadModelError } from './icalendar/eventReadModel';
import type {
	CalendarDateString,
	CalendarEvent,
	CalendarEventStatus,
	CalendarEventTransparency,
} from './icalendar/eventReadModel';
import { CalDavICalendarParseError } from './icalendar/parser';
import { CalDavRecurrenceRuleError, normalizeRecurrenceRule } from './icalendar/recurrence';
import type {
	RecurrenceField,
	RecurrenceRule,
	RecurrenceStartContext,
} from './icalendar/recurrence';
import { CalDavCalendarEventPatchError, CalendarEventPatchErrorCode } from './icalendar/patcher';
import type { CalendarEventPatch, OptionalFieldPatch } from './icalendar/patcher';
import {
	CalDavICalendarSerializeError,
	CalDavICalendarSerializeErrorCode,
} from './icalendar/serializer';
import {
	CalDavIanaTimeZoneError,
	CalDavIanaTimeZoneErrorCode,
	canonicalizeIanaTimeZone,
	listCanonicalIanaTimeZones,
	projectInstantInTimeZone,
	resolveLocalDateTimeInTimeZone,
} from './icalendar/timeZones';
import type { CalendarEventTimeZone } from './icalendar/timeZones';
import { isAbsoluteICalendarUri } from './icalendar/uri';
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
const UPDATE_OPERATION = 'update';
const UPSERT_OPERATION = 'upsert';
const DELETE_OPERATION = 'delete';
const RESOURCE_URL_IDENTIFIER_MODE = 'resourceUrl';
const UID_IDENTIFIER_MODE = 'uid';
const INVALID_LIMIT_MESSAGE = 'Limit must be an integer greater than or equal to 1.';
const UNSUPPORTED_OPERATION_MESSAGE = 'Unsupported CalDAV resource or operation.';
const READ_ONLY_EVENT_UPDATE_MESSAGE =
	'The calendar event is read-only because its time representation is unsupported.';
const GENERIC_GET_MANY_ERROR_MESSAGE = 'The Calendar Get Many operation failed.';
const GENERIC_LIST_SEARCH_ERROR_MESSAGE = 'The calendar list could not be loaded.';
const ZONED_ISO_INSTANT_PATTERN =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([zZ])|([+-])(\d{2}):(\d{2}))$/;
const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const RECURRENCE_WEEKDAY_OPTIONS = [
	{ name: 'Monday', value: 'monday' },
	{ name: 'Tuesday', value: 'tuesday' },
	{ name: 'Wednesday', value: 'wednesday' },
	{ name: 'Thursday', value: 'thursday' },
	{ name: 'Friday', value: 'friday' },
	{ name: 'Saturday', value: 'saturday' },
	{ name: 'Sunday', value: 'sunday' },
] as const;

const RECURRENCE_MONTH_OPTIONS = [
	{ name: 'January', value: 1 },
	{ name: 'February', value: 2 },
	{ name: 'March', value: 3 },
	{ name: 'April', value: 4 },
	{ name: 'May', value: 5 },
	{ name: 'June', value: 6 },
	{ name: 'July', value: 7 },
	{ name: 'August', value: 8 },
	{ name: 'September', value: 9 },
	{ name: 'October', value: 10 },
	{ name: 'November', value: 11 },
	{ name: 'December', value: 12 },
] as const;

export function recurrenceRuleDescriptor(
	timeMode: 'timed' | 'allDay',
	displayOptions?: INodeProperties['displayOptions'],
): INodeProperties {
	return {
		displayName: 'Recurrence',
		name: 'recurrence',
		type: 'fixedCollection',
		typeOptions: { multipleValues: false },
		default: {},
		...(displayOptions === undefined ? {} : { displayOptions }),
		options: [
			{
				displayName: 'Rule',
				name: 'rule',
				// eslint-disable-next-line n8n-nodes-base/node-param-fixed-collection-type-unsorted-items -- issue-47-contract-r1 fixes the recurrence control order.
				values: [
					{
						displayName: 'Frequency',
						name: 'frequency',
						type: 'options',
						required: true,
						default: 'daily',
						options: [
							{ name: 'Daily', value: 'daily' },
							{ name: 'Weekly', value: 'weekly' },
							{ name: 'Monthly', value: 'monthly' },
							{ name: 'Yearly', value: 'yearly' },
						],
					},
					{
						displayName: 'Interval',
						name: 'interval',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 2_147_483_647 },
						default: 1,
					},
					{
						displayName: 'Ends',
						name: 'endMode',
						type: 'options',
						default: 'never',
						options: [
							{ name: 'Never', value: 'never' },
							{ name: 'After Number of Occurrences', value: 'count' },
							{ name: 'On Date/Time', value: 'until' },
						],
					},
					{
						displayName: 'Count',
						name: 'count',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 2_147_483_647 },
						default: 1,
						displayOptions: { show: { endMode: ['count'] } },
					},
					{
						displayName: 'Until',
						name: 'until',
						type: 'dateTime',
						...(timeMode === 'allDay' ? { typeOptions: { dateOnly: true } } : {}),
						default: '',
						displayOptions: { show: { endMode: ['until'] } },
					},
					{
						displayName: 'By Day',
						name: 'byDay',
						type: 'fixedCollection',
						typeOptions: { multipleValues: true },
						default: {},
						placeholder: 'Add Day',
						options: [
							{
								displayName: 'Day',
								name: 'day',
								values: [
									{
										displayName: 'Weekday',
										name: 'weekday',
										type: 'options',
										default: 'monday',
										options: [...RECURRENCE_WEEKDAY_OPTIONS],
									},
									{
										displayName: 'Mode',
										name: 'ordinalMode',
										type: 'options',
										default: 'every',
										options: [
											{ name: 'Every', value: 'every' },
											{ name: 'Ordinal', value: 'ordinal' },
										],
									},
									{
										displayName: 'Ordinal',
										name: 'ordinal',
										type: 'number',
										typeOptions: { minValue: -53, maxValue: 53 },
										default: 1,
										displayOptions: { show: { ordinalMode: ['ordinal'] } },
									},
								],
							},
						],
					},
					{
						displayName: 'By Month Day',
						name: 'byMonthDay',
						type: 'fixedCollection',
						typeOptions: { multipleValues: true },
						default: {},
						placeholder: 'Add Month Day',
						options: [
							{
								displayName: 'Day',
								name: 'day',
								values: [
									{
										displayName: 'Value',
										name: 'value',
										type: 'number',
										typeOptions: { minValue: -31, maxValue: 31 },
										default: 1,
									},
								],
							},
						],
					},
					{
						displayName: 'By Month',
						name: 'byMonth',
						type: 'multiOptions',
						default: [],
						options: [...RECURRENCE_MONTH_OPTIONS],
					},
					{
						displayName: 'Week Starts On',
						name: 'weekStart',
						type: 'options',
						default: 'monday',
						options: [...RECURRENCE_WEEKDAY_OPTIONS],
						displayOptions: { show: { frequency: ['weekly'] } },
					},
				],
			},
		],
	};
}

export function recurrencePatchDescriptor(timeMode: 'timed' | 'allDay'): INodeProperties {
	const value = recurrenceRuleDescriptor(timeMode, { show: { action: ['set'] } });
	return {
		displayName: 'Recurrence',
		name: 'recurrence',
		type: 'fixedCollection',
		typeOptions: { multipleValues: false },
		default: {},
		required: true,
		options: [
			{
				displayName: 'Change',
				name: 'change',
				values: [
					{
						displayName: 'Action',
						name: 'action',
						type: 'options',
						required: true,
						noDataExpression: true,
						options: [
							{ name: 'Set', value: 'set' },
							{ name: 'Remove', value: 'remove' },
						],
						default: 'set',
					},
					{ ...value, displayName: 'Value', name: 'value' },
				],
			},
		],
	};
}

function recurrenceUiError(
	code: ConstructorParameters<typeof CalDavRecurrenceRuleError>[0],
	field?: RecurrenceField,
): never {
	// eslint-disable-next-line n8n-nodes-base/node-execute-block-wrong-error-thrown -- this exported pure parameter normalizer is outside execute and its domain error is mapped when #48 wires it into the node boundary.
	throw new CalDavRecurrenceRuleError(code, field);
}

function recurrenceUiRecord(
	value: unknown,
	allowedKeys: readonly string[],
	field?: RecurrenceField,
): Readonly<Record<string, PropertyDescriptor>> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return recurrenceUiError('INVALID_INPUT', field);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		return recurrenceUiError('INVALID_INPUT', field);
	}
	let descriptors: Readonly<Record<string, PropertyDescriptor>>;
	try {
		descriptors = Object.getOwnPropertyDescriptors(value);
	} catch {
		return recurrenceUiError('INVALID_INPUT', field);
	}
	if (Object.getOwnPropertySymbols(value).length > 0) return recurrenceUiError('UNKNOWN_FIELD');
	const allowed = new Set(allowedKeys);
	for (const [key, descriptor] of Object.entries(descriptors)) {
		if (!allowed.has(key)) return recurrenceUiError('UNKNOWN_FIELD');
		if (!descriptor.enumerable || !('value' in descriptor)) {
			return recurrenceUiError('INVALID_INPUT', field);
		}
	}
	return descriptors;
}

function recurrenceUiArray(value: unknown, field: RecurrenceField): readonly unknown[] {
	if (!Array.isArray(value) || value.length === 0) return recurrenceUiError('INVALID_INPUT', field);
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (Object.getOwnPropertySymbols(value).length > 0)
		return recurrenceUiError('INVALID_INPUT', field);
	const result: unknown[] = [];
	const allowed = new Set(['length']);
	for (let index = 0; index < value.length; index += 1) {
		const key = String(index);
		allowed.add(key);
		const descriptor = descriptors[key];
		if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
			return recurrenceUiError('INVALID_INPUT', field);
		}
		result.push(descriptor.value);
	}
	if (Object.keys(descriptors).some((key) => !allowed.has(key))) {
		return recurrenceUiError('INVALID_INPUT', field);
	}
	return result;
}

function recurrenceRows(
	value: unknown,
	field: 'byDay' | 'byMonthDay',
): readonly Readonly<Record<string, PropertyDescriptor>>[] {
	const wrapper = recurrenceUiRecord(value, ['day'], field);
	if (wrapper.day === undefined) return recurrenceUiError('INVALID_INPUT', field);
	return recurrenceUiArray(wrapper.day.value, field).map((row) =>
		recurrenceUiRecord(
			row,
			field === 'byDay' ? ['weekday', 'ordinalMode', 'ordinal'] : ['value'],
			field,
		),
	);
}

export function normalizeRecurrenceParameter(
	value: unknown,
	start: RecurrenceStartContext,
): RecurrenceRule {
	const outer = recurrenceUiRecord(value, ['rule']);
	if (outer.rule === undefined) return recurrenceUiError('INVALID_INPUT');
	const rule = recurrenceUiRecord(outer.rule.value, [
		'frequency',
		'interval',
		'endMode',
		'count',
		'until',
		'byDay',
		'byMonthDay',
		'byMonth',
		'weekStart',
	]);
	if (rule.frequency === undefined) return recurrenceUiError('INVALID_FREQUENCY', 'frequency');
	const normalized: Record<string, unknown> = { frequency: rule.frequency.value };
	if (rule.interval !== undefined) normalized.interval = rule.interval.value;
	const endMode = rule.endMode?.value ?? 'never';
	if (endMode === 'never') {
		if (rule.count !== undefined || rule.until !== undefined)
			return recurrenceUiError('INVALID_END', 'end');
	} else if (endMode === 'count') {
		if (rule.count === undefined || rule.until !== undefined)
			return recurrenceUiError('INVALID_END', 'end');
		normalized.end = { kind: 'count', count: rule.count.value };
	} else if (endMode === 'until') {
		if (rule.until === undefined || rule.count !== undefined)
			return recurrenceUiError('INVALID_END', 'end');
		normalized.end =
			start.timeMode === 'allDay'
				? { kind: 'until', value: { kind: 'date', date: rule.until.value } }
				: { kind: 'until', value: { kind: 'dateTime', dateTime: rule.until.value } };
	} else {
		return recurrenceUiError('INVALID_END', 'end');
	}
	if (rule.byMonth !== undefined) normalized.byMonth = rule.byMonth.value;
	if (rule.byMonthDay !== undefined) {
		normalized.byMonthDay = recurrenceRows(rule.byMonthDay.value, 'byMonthDay').map(
			(row) => row.value?.value,
		);
	}
	if (rule.byDay !== undefined) {
		normalized.byDay = recurrenceRows(rule.byDay.value, 'byDay').map((row) => {
			if (row.weekday === undefined) return recurrenceUiError('INVALID_BY_DAY', 'byDay');
			const ordinalMode = row.ordinalMode?.value ?? 'every';
			if (ordinalMode === 'every') {
				if (row.ordinal !== undefined) return recurrenceUiError('INVALID_BY_DAY', 'byDay');
				return { weekday: row.weekday.value };
			}
			if (ordinalMode !== 'ordinal' || row.ordinal === undefined) {
				return recurrenceUiError('INVALID_BY_DAY', 'byDay');
			}
			return { weekday: row.weekday.value, ordinal: row.ordinal.value };
		});
	}
	if (
		rule.weekStart !== undefined &&
		(rule.frequency.value === 'weekly' || rule.weekStart.value !== 'monday')
	) {
		normalized.weekStart = rule.weekStart.value;
	}
	return normalizeRecurrenceRule(normalized, start);
}

function categoriesDescriptor(
	name: string,
	displayName: string,
	displayOptions?: INodeProperties['displayOptions'],
): INodeProperties {
	return {
		displayName,
		name,
		type: 'fixedCollection',
		typeOptions: { multipleValues: true },
		default: {},
		placeholder: 'Add Category',
		...(displayOptions === undefined ? {} : { displayOptions }),
		options: [
			{
				displayName: 'Category',
				name: 'category',
				values: [
					{
						displayName: 'Value',
						name: 'value',
						type: 'string',
						default: '',
					},
				],
			},
		],
	};
}

function metadataEnumDescriptor(
	name: 'status' | 'transparency',
	displayName: string,
	options: readonly { readonly name: string; readonly value: string }[],
	displayOptions?: INodeProperties['displayOptions'],
): INodeProperties {
	return {
		displayName,
		name,
		type: 'options',
		options: [...options],
		default: '',
		...(displayOptions === undefined ? {} : { displayOptions }),
	};
}

const STATUS_OPTIONS = [
	{ name: 'Tentative', value: 'tentative' },
	{ name: 'Confirmed', value: 'confirmed' },
	{ name: 'Cancelled', value: 'cancelled' },
] as const;
const TRANSPARENCY_OPTIONS = [
	{ name: 'Opaque', value: 'opaque' },
	{ name: 'Transparent', value: 'transparent' },
] as const;

function optionalMetadataPatchDescriptor(
	name: 'categories' | 'status' | 'transparency',
	displayName: 'Categories' | 'Status' | 'Transparency',
): INodeProperties {
	const value =
		name === 'categories'
			? categoriesDescriptor('value', 'Value', { show: { action: ['set'] } })
			: metadataEnumDescriptor(
					name,
					'Value',
					name === 'status' ? STATUS_OPTIONS : TRANSPARENCY_OPTIONS,
					{ show: { action: ['set'] } },
				);
	return {
		displayName,
		name,
		type: 'fixedCollection',
		typeOptions: { multipleValues: false },
		default: {},
		required: true,
		options: [
			{
				displayName: 'Change',
				name: 'change',
				values: [
					{
						displayName: 'Action',
						name: 'action',
						type: 'options',
						required: true,
						noDataExpression: true,
						options: [
							{ name: 'Set', value: 'set' },
							{ name: 'Remove', value: 'remove' },
						],
						default: 'set',
					},
					{ ...value, displayName: 'Value', name: 'value' },
				],
			},
		],
	};
}

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
	INVALID_TIME_MODE: 'Time Mode must be Timed or All-Day.',
	RESOURCE_NAME_TOO_LONG: 'UID is too long to create a safe event resource name.',
	INVALID_START: 'Start must be a valid date and time with whole-second precision.',
	INVALID_END: 'End must be a valid date and time with whole-second precision.',
	INVALID_START_DATE: 'Start Date must be a valid calendar date.',
	INVALID_END_DATE: 'End Date must be a valid calendar date.',
	MIXED_TIME_FIELDS: 'The selected Time Mode cannot use fields from the other time mode.',
	INVALID_RANGE: 'End must be later than Start.',
	INVALID_SUMMARY: 'Summary must be a valid iCalendar text value.',
	INVALID_DESCRIPTION: 'Description must be a valid iCalendar text value.',
	INVALID_LOCATION: 'Location must be a valid iCalendar text value.',
	INVALID_URL: 'URL must be a valid absolute URI without a fragment.',
	INVALID_CATEGORIES: 'Categories must be a non-empty list of valid iCalendar text values.',
	INVALID_STATUS: 'Status must be Tentative, Confirmed, or Cancelled.',
	INVALID_TRANSPARENCY: 'Transparency must be Opaque or Transparent.',
	INVALID_ADDITIONAL_FIELDS: 'Additional Fields must be an object.',
	INVALID_TIME_ZONE_MODE: 'Time Zone Mode must be UTC or IANA.',
	INVALID_TIME_ZONE: 'Time Zone must be a valid IANA time zone identifier.',
	UTC_TIME_ZONE: 'Time Zone resolves to UTC. Use UTC Time Zone Mode.',
	UNREPRESENTABLE_START:
		'Start cannot be represented unambiguously in the selected IANA time zone. Use UTC mode for this instant.',
	UNREPRESENTABLE_END:
		'End cannot be represented unambiguously in the selected IANA time zone. Use UTC mode for this instant.',
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

const EVENT_UPDATE_MESSAGES = {
	INVALID_CALENDAR_URL:
		'The Calendar URL is invalid. Enter an absolute HTTP(S) calendar collection URL.',
	INVALID_RESOURCE_URL:
		'The Event Resource URL is invalid or does not belong to the selected calendar.',
	INVALID_UID: 'UID must be a non-empty valid iCalendar text value.',
	INVALID_ETAG: 'ETag must be a string.',
	INVALID_TIME_MODE: 'Time Mode must be Timed or All-Day.',
	INVALID_FIELDS: 'Fields to Update must be an object.',
	INVALID_TIME_ZONE_MODE: 'Time Zone Mode must be UTC or IANA.',
	INVALID_TIME_ZONE: 'Time Zone must be a valid IANA time zone identifier.',
	UTC_TIME_ZONE: 'Time Zone resolves to UTC. Use UTC Time Zone Mode.',
	READ_ONLY: 'The calendar event is read-only because its time representation is unsupported.',
	NO_CHANGES: 'The calendar event patch does not contain any changes.',
	INVALID_START: 'Start must be a valid date and time with whole-second precision.',
	INVALID_END: 'End must be a valid date and time with whole-second precision.',
	INVALID_START_DATE: 'Start Date must be a valid calendar date.',
	INVALID_END_DATE: 'End Date must be a valid calendar date.',
	INVALID_RANGE: 'End must be later than Start.',
	INVALID_SUMMARY: 'Summary must be a valid iCalendar text value.',
	INVALID_DESCRIPTION: 'Description must be a valid iCalendar text value.',
	INVALID_LOCATION: 'Location must be a valid iCalendar text value.',
	INVALID_URL: 'URL must be a valid absolute URI without a fragment.',
	INVALID_CATEGORIES: 'Categories must be a non-empty list of valid iCalendar text values.',
	INVALID_STATUS: 'Status must be Tentative, Confirmed, or Cancelled.',
	INVALID_TRANSPARENCY: 'Transparency must be Opaque or Transparent.',
	UNSUPPORTED_TIME: 'The calendar event uses an unsupported time representation for this patch.',
	INCOMPATIBLE_PARAMETERS:
		'The calendar event property parameters are incompatible with this patch.',
	AMBIGUOUS_PROPERTY: 'The calendar event contains an ambiguous property.',
	INVALID_METADATA: 'The calendar event revision metadata is invalid.',
	AUTHENTICATION: 'Event Update authentication failed.',
	AUTHORIZATION: 'Event Update is not authorized.',
	NOT_FOUND: 'The calendar event was not found.',
	AMBIGUOUS:
		'More than one calendar event with the requested UID was found in the selected calendar.',
	MISSING_ETAG: 'The calendar event does not provide an ETag required for a safe mutation.',
	CONCURRENCY: 'The calendar event changed before the mutation could be applied.',
	TLS: 'TLS certificate validation failed.',
	TIMEOUT: 'Event Update timed out.',
	RESPONSE_LIMIT: 'The Event Update response exceeded the size limit.',
	REDIRECT: 'The CalDAV server returned an unsafe or invalid redirect.',
	UNTRUSTED: 'The Event Resource URL targets an untrusted endpoint.',
	NETWORK: 'The CalDAV server could not be reached.',
	MALFORMED_ICALENDAR: 'The CalDAV server returned malformed iCalendar event data.',
	UNSUPPORTED_EVENT: 'The calendar event uses an unsupported event representation.',
	INVALID_RESPONSE: 'The CalDAV server returned an invalid calendar-event update response.',
	CONFIRMATION: 'The event was updated, but its current state could not be verified.',
	GENERIC: 'Event Update failed.',
} as const;

const EVENT_UPSERT_MESSAGES = {
	...EVENT_CREATE_MESSAGES,
	AUTHENTICATION: 'Event Upsert authentication failed.',
	AUTHORIZATION: 'Event Upsert is not authorized for the selected calendar.',
	NOT_FOUND: 'The selected calendar was not found.',
	AMBIGUOUS:
		'More than one calendar event with the requested UID was found in the selected calendar.',
	MISSING_ETAG: 'The calendar event does not provide an ETag required for a safe mutation.',
	CONCURRENCY: 'The calendar changed while Event Upsert was in progress.',
	TIMEOUT: 'Event Upsert timed out.',
	RESPONSE_LIMIT: 'The Event Upsert response exceeded the size limit.',
	INVALID_RESPONSE: 'The CalDAV server returned an invalid calendar-event upsert response.',
	CREATE_PARTIAL_SUCCESS: 'The event was created, but its required ETag could not be retrieved.',
	UPDATE_PARTIAL_SUCCESS: 'The event was updated, but its current state could not be verified.',
	GENERIC: 'Event Upsert failed.',
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
	const legacy = event as unknown as {
		readonly calendarUrl: string;
		readonly resourceUrl: string;
		readonly etag?: string;
		readonly uid: string;
		readonly summary?: string;
		readonly description?: string;
		readonly location?: string;
		readonly url?: string;
		readonly categories?: readonly string[];
		readonly status?: CalendarEvent['status'];
		readonly transparency?: CalendarEvent['transparency'];
		readonly recurrence?: CalendarEvent['recurrence'];
		readonly start?: string;
		readonly end?: string;
		readonly timeMode?: string;
		readonly accessMode?: string;
	};
	if (legacy.timeMode === undefined || legacy.accessMode === undefined) {
		return {
			calendarUrl: legacy.calendarUrl,
			resourceUrl: legacy.resourceUrl,
			...(legacy.etag === undefined ? {} : { etag: legacy.etag }),
			uid: legacy.uid,
			...(legacy.summary === undefined ? {} : { summary: legacy.summary }),
			...(legacy.description === undefined ? {} : { description: legacy.description }),
			...(legacy.location === undefined ? {} : { location: legacy.location }),
			...(legacy.url === undefined ? {} : { url: legacy.url }),
			...(legacy.categories === undefined ? {} : { categories: [...legacy.categories] }),
			...(legacy.status === undefined ? {} : { status: legacy.status as IDataObject[string] }),
			...(legacy.transparency === undefined
				? {}
				: { transparency: legacy.transparency as IDataObject[string] }),
			...(legacy.recurrence === undefined
				? {}
				: { recurrence: legacy.recurrence as unknown as IDataObject }),
			...(legacy.start === undefined ? {} : { start: legacy.start }),
			...(legacy.end === undefined ? {} : { end: legacy.end }),
		};
	}
	return {
		calendarUrl: event.calendarUrl,
		resourceUrl: event.resourceUrl,
		...(event.etag === undefined ? {} : { etag: event.etag }),
		uid: event.uid,
		...(event.summary === undefined ? {} : { summary: event.summary }),
		...(event.description === undefined ? {} : { description: event.description }),
		...(event.location === undefined ? {} : { location: event.location }),
		...(event.url === undefined ? {} : { url: event.url }),
		...(event.categories === undefined ? {} : { categories: [...event.categories] }),
		...(event.status === undefined ? {} : { status: event.status as IDataObject[string] }),
		...(event.transparency === undefined
			? {}
			: { transparency: event.transparency as IDataObject[string] }),
		timeMode: event.timeMode,
		accessMode: event.accessMode,
		...(event.timeMode === 'timed'
			? {
					start: event.start,
					end: event.end,
					...(event.timeZoneMode === undefined ? {} : { timeZoneMode: event.timeZoneMode }),
					...(event.timeZone === undefined ? {} : { timeZone: event.timeZone }),
					...(event.startLocal === undefined ? {} : { startLocal: event.startLocal }),
					...(event.endLocal === undefined ? {} : { endLocal: event.endLocal }),
				}
			: event.timeMode === 'allDay'
				? { startDate: event.startDate, endDate: event.endDate }
				: { readOnlyReason: event.readOnlyReason }),
		...(event.recurrence === undefined
			? {}
			: { recurrence: event.recurrence as unknown as IDataObject }),
		...(event.extensions === undefined ? {} : { extensions: event.extensions as IDataObject }),
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
	if (error.field === 'categories') {
		return { message: EVENT_CREATE_MESSAGES.INVALID_CATEGORIES, configuration: true };
	}
	if (error.field === 'status') {
		return { message: EVENT_CREATE_MESSAGES.INVALID_STATUS, configuration: true };
	}
	if (error.field === 'transparency') {
		return { message: EVENT_CREATE_MESSAGES.INVALID_TRANSPARENCY, configuration: true };
	}
	return { message: EVENT_CREATE_MESSAGES.GENERIC, configuration: false };
}

function eventCreateFailure(error: unknown): EventCreateFailure {
	if (error instanceof CalDavCalendarEventTimeZoneAuthoringError) {
		return { message: error.message, configuration: true };
	}
	if (error instanceof CalDavTimeZoneReferenceError) {
		return { message: error.message, configuration: false };
	}
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

function eventUpdateTransportFailure(error: CalDavTransportError): SafeNodeFailure {
	switch (error.code) {
		case CalDavTransportErrorCode.AUTHENTICATION_FAILED:
			return apiFailure(EVENT_UPDATE_MESSAGES.AUTHENTICATION, error);
		case CalDavTransportErrorCode.AUTHORIZATION_FAILED:
			return apiFailure(EVENT_UPDATE_MESSAGES.AUTHORIZATION, error);
		case CalDavTransportErrorCode.NOT_FOUND:
			return apiFailure(EVENT_UPDATE_MESSAGES.NOT_FOUND, error);
		case CalDavTransportErrorCode.PRECONDITION_FAILED:
			return apiFailure(EVENT_UPDATE_MESSAGES.CONCURRENCY, error);
		case CalDavTransportErrorCode.TLS_VALIDATION_FAILED:
			return apiFailure(EVENT_UPDATE_MESSAGES.TLS, error);
		case CalDavTransportErrorCode.TIMEOUT:
			return apiFailure(EVENT_UPDATE_MESSAGES.TIMEOUT, error);
		case CalDavTransportErrorCode.RESPONSE_LIMIT_EXCEEDED:
			return apiFailure(EVENT_UPDATE_MESSAGES.RESPONSE_LIMIT, error);
		case CalDavTransportErrorCode.INVALID_REDIRECT:
		case CalDavTransportErrorCode.INSECURE_REDIRECT:
		case CalDavTransportErrorCode.REDIRECT_LOOP:
		case CalDavTransportErrorCode.REDIRECT_LIMIT_EXCEEDED:
			return apiFailure(EVENT_UPDATE_MESSAGES.REDIRECT, error);
		case CalDavTransportErrorCode.UNTRUSTED_TARGET:
			return apiFailure(EVENT_UPDATE_MESSAGES.UNTRUSTED, error);
		case CalDavTransportErrorCode.NETWORK_ERROR:
			return apiFailure(EVENT_UPDATE_MESSAGES.NETWORK, error);
		case CalDavTransportErrorCode.REMOTE_PROTOCOL_ERROR:
			return apiFailure(EVENT_UPDATE_MESSAGES.INVALID_RESPONSE, error);
	}
}

interface EventUpdateFailure extends SafeNodeFailure {
	readonly configuration: boolean;
}

function eventUpdatePatchFailure(error: CalDavCalendarEventPatchError): EventUpdateFailure {
	switch (error.code) {
		case CalendarEventPatchErrorCode.NO_CHANGES:
			return { message: EVENT_UPDATE_MESSAGES.NO_CHANGES, configuration: true };
		case CalendarEventPatchErrorCode.INVALID_TIME_RANGE:
			return { message: EVENT_UPDATE_MESSAGES.INVALID_RANGE, configuration: true };
		case CalendarEventPatchErrorCode.INVALID_DATE:
			return {
				message:
					error.field === 'start'
						? EVENT_UPDATE_MESSAGES.INVALID_START
						: error.field === 'end'
							? EVENT_UPDATE_MESSAGES.INVALID_END
							: EVENT_UPDATE_MESSAGES.GENERIC,
				configuration: error.field === 'start' || error.field === 'end',
			};
		case CalendarEventPatchErrorCode.INVALID_TEXT:
			return {
				message:
					error.field === 'summary'
						? EVENT_UPDATE_MESSAGES.INVALID_SUMMARY
						: error.field === 'description'
							? EVENT_UPDATE_MESSAGES.INVALID_DESCRIPTION
							: error.field === 'categories'
								? EVENT_UPDATE_MESSAGES.INVALID_CATEGORIES
								: EVENT_UPDATE_MESSAGES.INVALID_LOCATION,
				configuration: true,
			};
		case CalendarEventPatchErrorCode.INVALID_URI:
			return { message: EVENT_UPDATE_MESSAGES.INVALID_URL, configuration: true };
		case CalendarEventPatchErrorCode.UNSUPPORTED_TIME:
			return { message: EVENT_UPDATE_MESSAGES.UNSUPPORTED_TIME, configuration: false };
		case CalendarEventPatchErrorCode.INCOMPATIBLE_PARAMETERS:
			return { message: EVENT_UPDATE_MESSAGES.INCOMPATIBLE_PARAMETERS, configuration: false };
		case CalendarEventPatchErrorCode.AMBIGUOUS_PROPERTY:
			return { message: EVENT_UPDATE_MESSAGES.AMBIGUOUS_PROPERTY, configuration: false };
		case CalendarEventPatchErrorCode.INVALID_METADATA:
			return { message: EVENT_UPDATE_MESSAGES.INVALID_METADATA, configuration: false };
		case CalendarEventPatchErrorCode.INVALID_INPUT:
			if (error.field === 'status') {
				return { message: EVENT_UPDATE_MESSAGES.INVALID_STATUS, configuration: true };
			}
			if (error.field === 'transparency') {
				return { message: EVENT_UPDATE_MESSAGES.INVALID_TRANSPARENCY, configuration: true };
			}
			if (error.field === 'categories') {
				return { message: EVENT_UPDATE_MESSAGES.INVALID_CATEGORIES, configuration: true };
			}
			return { message: EVENT_UPDATE_MESSAGES.GENERIC, configuration: false };
		case CalendarEventPatchErrorCode.UNKNOWN_PATCH_FIELD:
		case CalendarEventPatchErrorCode.IMMUTABLE_FIELD:
		case CalendarEventPatchErrorCode.INVALID_CONTEXT:
			return { message: EVENT_UPDATE_MESSAGES.GENERIC, configuration: false };
	}
}

function eventUpdateFailure(error: unknown): EventUpdateFailure {
	if (error instanceof Error && error.message === READ_ONLY_EVENT_UPDATE_MESSAGE) {
		return { message: READ_ONLY_EVENT_UPDATE_MESSAGE, configuration: true };
	}
	if (error instanceof CalDavCalendarEventTimeZoneAuthoringError) {
		return { message: error.message, configuration: true };
	}
	if (error instanceof CalDavTimeZoneReferenceError) {
		return { message: error.message, configuration: false };
	}
	if (error instanceof CalDavCalendarEventUpdateError) {
		if (error.code === CalendarEventUpdateFailureCode.READ_ONLY) {
			return { message: EVENT_UPDATE_MESSAGES.READ_ONLY, configuration: false };
		}
		if (error.code === CalendarEventUpdateFailureCode.CONFIRMATION_FAILED) {
			return {
				message: EVENT_UPDATE_MESSAGES.CONFIRMATION,
				configuration: false,
				...(error.statusCode === undefined ? {} : { httpCode: String(error.statusCode) }),
			};
		}
		return { message: EVENT_UPDATE_MESSAGES.GENERIC, configuration: false };
	}
	if (error instanceof CalDavCalendarEventPatchError) return eventUpdatePatchFailure(error);
	if (
		error instanceof CalDavCalendarEventResourceGetError &&
		error.code === CalendarEventResourceGetFailureCode.OUTSIDE_CALENDAR
	) {
		return { message: EVENT_UPDATE_MESSAGES.INVALID_RESOURCE_URL, configuration: true };
	}
	if (error instanceof XmlBuildError && error.code === 'INVALID_UID') {
		return { message: EVENT_UPDATE_MESSAGES.INVALID_UID, configuration: true };
	}
	if (error instanceof CalDavTransportError) {
		return { ...eventUpdateTransportFailure(error), configuration: false };
	}
	if (error instanceof CalDavCalendarEventUidResolutionError) {
		if (error.code === CalendarEventUidResolutionFailureCode.NOT_FOUND) {
			return { message: EVENT_UPDATE_MESSAGES.NOT_FOUND, configuration: false };
		}
		if (error.code === CalendarEventUidResolutionFailureCode.AMBIGUOUS) {
			return { message: EVENT_UPDATE_MESSAGES.AMBIGUOUS, configuration: false };
		}
		return { message: EVENT_UPDATE_MESSAGES.INVALID_RESPONSE, configuration: false };
	}
	if (error instanceof CalDavCalendarEventMutationError) {
		switch (error.code) {
			case CalendarEventMutationFailureCode.CONCURRENCY_CONFLICT:
				return { message: EVENT_UPDATE_MESSAGES.CONCURRENCY, configuration: false };
			case CalendarEventMutationFailureCode.MISSING_ETAG:
				return { message: EVENT_UPDATE_MESSAGES.MISSING_ETAG, configuration: false };
			case CalendarEventMutationFailureCode.OUTSIDE_CALENDAR:
			case CalendarEventMutationFailureCode.CREATE_CONFLICT:
			case CalendarEventMutationFailureCode.INVALID_LOCATION:
			case CalendarEventMutationFailureCode.INVALID_RESPONSE:
				return { message: EVENT_UPDATE_MESSAGES.INVALID_RESPONSE, configuration: false };
		}
	}
	if (error instanceof CalDavICalendarParseError) {
		return { message: EVENT_UPDATE_MESSAGES.MALFORMED_ICALENDAR, configuration: false };
	}
	if (error instanceof CalDavCalendarEventReadModelError) {
		return { message: EVENT_UPDATE_MESSAGES.UNSUPPORTED_EVENT, configuration: false };
	}
	if (
		error instanceof CalDavCalendarEventResourceGetError ||
		error instanceof CalDavICalendarSerializeError ||
		error instanceof CalDavXmlParseError ||
		error instanceof CalDavXmlProtocolError ||
		error instanceof CalDavUrlValidationError ||
		error instanceof XmlBuildError
	) {
		return { message: EVENT_UPDATE_MESSAGES.INVALID_RESPONSE, configuration: false };
	}
	return { message: EVENT_UPDATE_MESSAGES.GENERIC, configuration: false };
}

function eventUpsertTransportFailure(error: CalDavTransportError): SafeNodeFailure {
	switch (error.code) {
		case CalDavTransportErrorCode.AUTHENTICATION_FAILED:
			return apiFailure(EVENT_UPSERT_MESSAGES.AUTHENTICATION, error);
		case CalDavTransportErrorCode.AUTHORIZATION_FAILED:
			return apiFailure(EVENT_UPSERT_MESSAGES.AUTHORIZATION, error);
		case CalDavTransportErrorCode.NOT_FOUND:
			return apiFailure(EVENT_UPSERT_MESSAGES.NOT_FOUND, error);
		case CalDavTransportErrorCode.PRECONDITION_FAILED:
			return apiFailure(EVENT_UPSERT_MESSAGES.CONCURRENCY, error);
		case CalDavTransportErrorCode.TLS_VALIDATION_FAILED:
			return apiFailure(EVENT_UPSERT_MESSAGES.TLS, error);
		case CalDavTransportErrorCode.TIMEOUT:
			return apiFailure(EVENT_UPSERT_MESSAGES.TIMEOUT, error);
		case CalDavTransportErrorCode.RESPONSE_LIMIT_EXCEEDED:
			return apiFailure(EVENT_UPSERT_MESSAGES.RESPONSE_LIMIT, error);
		case CalDavTransportErrorCode.INVALID_REDIRECT:
		case CalDavTransportErrorCode.INSECURE_REDIRECT:
		case CalDavTransportErrorCode.REDIRECT_LOOP:
		case CalDavTransportErrorCode.REDIRECT_LIMIT_EXCEEDED:
			return apiFailure(EVENT_UPSERT_MESSAGES.REDIRECT, error);
		case CalDavTransportErrorCode.UNTRUSTED_TARGET:
			return apiFailure(EVENT_UPSERT_MESSAGES.UNTRUSTED, error);
		case CalDavTransportErrorCode.NETWORK_ERROR:
			return apiFailure(EVENT_UPSERT_MESSAGES.NETWORK, error);
		case CalDavTransportErrorCode.REMOTE_PROTOCOL_ERROR:
			return apiFailure(EVENT_UPSERT_MESSAGES.INVALID_RESPONSE, error);
	}
}

function eventUpsertFailure(error: unknown): EventUpdateFailure {
	if (
		error instanceof CalDavCalendarEventUpsertError &&
		error.code === CalendarEventUpsertFailureCode.CONCURRENCY_CONFLICT
	) {
		return { message: EVENT_UPSERT_MESSAGES.CONCURRENCY, configuration: false };
	}
	if (error instanceof CalDavCalendarEventCreateError) {
		if (error.code === CalendarEventCreateFailureCode.RESOURCE_NAME_TOO_LONG) {
			return { message: EVENT_UPSERT_MESSAGES.RESOURCE_NAME_TOO_LONG, configuration: true };
		}
		if (error.code === CalendarEventCreateFailureCode.ETAG_RETRIEVAL_FAILED) {
			return {
				message: EVENT_UPSERT_MESSAGES.CREATE_PARTIAL_SUCCESS,
				configuration: false,
				...(error.statusCode === undefined ? {} : { httpCode: String(error.statusCode) }),
			};
		}
		if (error.code === CalendarEventCreateFailureCode.INVALID_CLOCK) {
			return { message: EVENT_UPSERT_MESSAGES.GENERIC, configuration: false };
		}
		return { message: EVENT_UPSERT_MESSAGES.INVALID_RESPONSE, configuration: false };
	}
	if (
		error instanceof CalDavCalendarEventUpdateError &&
		error.code === CalendarEventUpdateFailureCode.CONFIRMATION_FAILED
	) {
		return {
			message: EVENT_UPSERT_MESSAGES.UPDATE_PARTIAL_SUCCESS,
			configuration: false,
			...(error.statusCode === undefined ? {} : { httpCode: String(error.statusCode) }),
		};
	}
	if (error instanceof CalDavCalendarEventUidResolutionError) {
		return {
			message:
				error.code === CalendarEventUidResolutionFailureCode.AMBIGUOUS
					? EVENT_UPSERT_MESSAGES.AMBIGUOUS
					: EVENT_UPSERT_MESSAGES.INVALID_RESPONSE,
			configuration: false,
		};
	}
	if (error instanceof CalDavCalendarEventMutationError) {
		return {
			message:
				error.code === CalendarEventMutationFailureCode.MISSING_ETAG
					? EVENT_UPSERT_MESSAGES.MISSING_ETAG
					: EVENT_UPSERT_MESSAGES.INVALID_RESPONSE,
			configuration: false,
		};
	}
	if (error instanceof CalDavTransportError) {
		return { ...eventUpsertTransportFailure(error), configuration: false };
	}
	if (error instanceof CalDavCalendarEventPatchError) {
		const failure = eventUpdatePatchFailure(error);
		return {
			...failure,
			message:
				failure.message === EVENT_UPDATE_MESSAGES.GENERIC
					? EVENT_UPSERT_MESSAGES.GENERIC
					: failure.message,
		};
	}
	if (error instanceof CalDavCalendarEventUpdateError) {
		return error.code === CalendarEventUpdateFailureCode.READ_ONLY
			? { message: EVENT_UPDATE_MESSAGES.READ_ONLY, configuration: false }
			: { message: EVENT_UPSERT_MESSAGES.GENERIC, configuration: false };
	}
	if (error instanceof CalDavCalendarEventTimeZoneAuthoringError) {
		return { message: error.message, configuration: true };
	}
	if (error instanceof CalDavTimeZoneReferenceError) {
		return { message: error.message, configuration: false };
	}
	if (error instanceof CalDavICalendarSerializeError) {
		const failure = eventCreateSerializationFailure(error);
		return {
			...failure,
			message:
				failure.message === EVENT_CREATE_MESSAGES.GENERIC
					? EVENT_UPSERT_MESSAGES.GENERIC
					: failure.message,
		};
	}
	if (error instanceof CalDavICalendarParseError) {
		return { message: EVENT_UPDATE_MESSAGES.MALFORMED_ICALENDAR, configuration: false };
	}
	if (error instanceof CalDavCalendarEventReadModelError) {
		return { message: EVENT_UPDATE_MESSAGES.UNSUPPORTED_EVENT, configuration: false };
	}
	if (
		error instanceof CalDavCalendarEventResourceGetError ||
		error instanceof CalDavXmlParseError ||
		error instanceof CalDavXmlProtocolError ||
		error instanceof CalDavUrlValidationError ||
		error instanceof XmlBuildError
	) {
		return { message: EVENT_UPSERT_MESSAGES.INVALID_RESPONSE, configuration: false };
	}
	return { message: EVENT_UPSERT_MESSAGES.GENERIC, configuration: false };
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
	return utcYear >= 1 && utcYear <= 9999;
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
		year < 1 ||
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

function isValidCreateUrl(value: string): boolean {
	return isAbsoluteICalendarUri(value);
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

function strictCalendarDate(value: string): CalendarDateString | undefined {
	const match = CALENDAR_DATE_PATTERN.exec(value);
	if (match === null) return undefined;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (
		year < 1 ||
		year > 9999 ||
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > daysInGregorianMonth(year, month)
	) {
		return undefined;
	}
	return value as CalendarDateString;
}

function calendarDateInstant(value: unknown): Date | undefined {
	if (value instanceof Date) {
		return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : undefined;
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
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
		return converted instanceof Date && Number.isFinite(converted.getTime())
			? new Date(converted.getTime())
			: undefined;
	} catch {
		return undefined;
	}
}

function workflowCalendarDate(
	execution: IExecuteFunctions,
	value: unknown,
): CalendarDateString | undefined {
	if (typeof value === 'string') return strictCalendarDate(value);
	const instant = calendarDateInstant(value);
	if (instant === undefined) return undefined;
	try {
		const timezone = execution.getTimezone();
		if (typeof timezone !== 'string' || timezone.length === 0) return undefined;
		const parts = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
			timeZone: timezone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		}).formatToParts(instant);
		const part = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
			parts.find((candidate) => candidate.type === type)?.value;
		const year = part('year');
		const month = part('month');
		const day = part('day');
		if (year === undefined || month === undefined || day === undefined) return undefined;
		return strictCalendarDate(`${year.padStart(4, '0')}-${month}-${day}`);
	} catch {
		return undefined;
	}
}

function ownAdditionalField(
	additionalFields: Record<PropertyKey, unknown>,
	name: 'description' | 'location' | 'url' | 'categories' | 'status' | 'transparency',
	present: boolean,
): { readonly present: boolean; readonly value?: unknown } {
	if (!present) return { present: false };
	try {
		return { present: true, value: Reflect.get(additionalFields, name) };
	} catch {
		return { present: true };
	}
}

function workflowCategories(value: unknown): readonly string[] | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
	try {
		if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
		const outer = Object.getOwnPropertyDescriptors(value);
		if (
			Object.keys(outer).length !== 1 ||
			outer.category === undefined ||
			!outer.category.enumerable ||
			!('value' in outer.category) ||
			!Array.isArray(outer.category.value) ||
			outer.category.value.length === 0
		) {
			return undefined;
		}
		const rows = outer.category.value as readonly unknown[];
		const categories: string[] = [];
		const seen = new Set<string>();
		for (const row of rows) {
			if (typeof row !== 'object' || row === null || Array.isArray(row)) return undefined;
			if (Object.getOwnPropertySymbols(row).length > 0) return undefined;
			const descriptors = Object.getOwnPropertyDescriptors(row);
			if (
				Object.keys(descriptors).length !== 1 ||
				descriptors.value === undefined ||
				!descriptors.value.enumerable ||
				!('value' in descriptors.value) ||
				typeof descriptors.value.value !== 'string' ||
				descriptors.value.value.length === 0 ||
				!isValidICalendarText(descriptors.value.value)
			) {
				return undefined;
			}
			const category = descriptors.value.value;
			if (!seen.has(category)) {
				seen.add(category);
				categories.push(category);
			}
		}
		return Object.freeze(categories);
	} catch {
		return undefined;
	}
}

function eventCreateInput(
	execution: IExecuteFunctions,
	itemIndex: number,
): CalendarEventCreateInput | string {
	const calendarUrl = calendarLocatorUrl(nodeParameter(execution, 'calendar', itemIndex));
	if (calendarUrl === undefined) return EVENT_CREATE_MESSAGES.INVALID_CALENDAR_URL;
	const timeZoneMode = nodeParameter(execution, 'timeZoneMode', itemIndex) ?? 'utc';
	let timeZone: CalendarEventTimeZone;
	if (timeZoneMode === 'utc') {
		timeZone = { timeZoneMode: 'utc' };
	} else if (timeZoneMode === 'iana') {
		const value = nodeParameter(execution, 'timeZone', itemIndex);
		try {
			if (typeof value !== 'string') return EVENT_CREATE_MESSAGES.INVALID_TIME_ZONE;
			timeZone = { timeZoneMode: 'iana', timeZone: canonicalizeIanaTimeZone(value) };
		} catch (error) {
			return error instanceof CalDavIanaTimeZoneError &&
				error.code === CalDavIanaTimeZoneErrorCode.UTC_EQUIVALENT
				? EVENT_CREATE_MESSAGES.UTC_TIME_ZONE
				: EVENT_CREATE_MESSAGES.INVALID_TIME_ZONE;
		}
	} else {
		return EVENT_CREATE_MESSAGES.INVALID_TIME_ZONE_MODE;
	}

	const uidValue = nodeParameter(execution, 'uid', itemIndex);
	if (typeof uidValue !== 'string' || !isValidICalendarText(uidValue)) {
		return EVENT_CREATE_MESSAGES.INVALID_UID;
	}
	if (uidValue.length > 0 && !createResourceNameFits(uidValue)) {
		return EVENT_CREATE_MESSAGES.RESOURCE_NAME_TOO_LONG;
	}

	const timeMode = nodeParameter(execution, 'timeMode', itemIndex) ?? 'timed';
	if (timeMode !== 'timed' && timeMode !== 'allDay') {
		return EVENT_CREATE_MESSAGES.INVALID_TIME_MODE;
	}
	const startValue = nodeParameter(execution, 'start', itemIndex);
	const endValue = nodeParameter(execution, 'end', itemIndex);
	const startDateValue = nodeParameter(execution, 'startDate', itemIndex);
	const endDateValue = nodeParameter(execution, 'endDate', itemIndex);
	if (
		(timeMode === 'timed' && (startDateValue !== undefined || endDateValue !== undefined)) ||
		(timeMode === 'allDay' && (startValue !== undefined || endValue !== undefined))
	) {
		return EVENT_CREATE_MESSAGES.MIXED_TIME_FIELDS;
	}

	let timeInput:
		| {
				readonly timeMode: 'timed';
				readonly start: Date;
				readonly end: Date;
				readonly timeZone: CalendarEventTimeZone;
		  }
		| {
				readonly timeMode: 'allDay';
				readonly startDate: CalendarDateString;
				readonly endDate: CalendarDateString;
		  };
	if (timeMode === 'timed') {
		const start = createDateTimeInstant(startValue);
		if (start === undefined) return EVENT_CREATE_MESSAGES.INVALID_START;
		const end = createDateTimeInstant(endValue);
		if (end === undefined) return EVENT_CREATE_MESSAGES.INVALID_END;
		if (end.getTime() <= start.getTime()) return EVENT_CREATE_MESSAGES.INVALID_RANGE;
		if (timeZone.timeZoneMode === 'iana') {
			const projectedStart = projectInstantInTimeZone(start, timeZone.timeZone);
			if (
				resolveLocalDateTimeInTimeZone(projectedStart, timeZone.timeZone).getTime() !==
				start.getTime()
			) {
				return EVENT_CREATE_MESSAGES.UNREPRESENTABLE_START;
			}
			const projectedEnd = projectInstantInTimeZone(end, timeZone.timeZone);
			if (
				resolveLocalDateTimeInTimeZone(projectedEnd, timeZone.timeZone).getTime() !== end.getTime()
			) {
				return EVENT_CREATE_MESSAGES.UNREPRESENTABLE_END;
			}
		}
		timeInput = { timeMode, start, end, timeZone };
	} else {
		const startDate = workflowCalendarDate(execution, startDateValue);
		if (startDate === undefined) return EVENT_CREATE_MESSAGES.INVALID_START_DATE;
		const endDate = workflowCalendarDate(execution, endDateValue);
		if (endDate === undefined) return EVENT_CREATE_MESSAGES.INVALID_END_DATE;
		if (endDate <= startDate) return EVENT_CREATE_MESSAGES.INVALID_RANGE;
		timeInput = { timeMode, startDate, endDate };
	}

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
		keys.some(
			(key) =>
				typeof key !== 'string' ||
				!['description', 'location', 'url', 'categories', 'status', 'transparency'].includes(key),
		)
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
	const categoriesField = ownAdditionalField(
		additionalFields,
		'categories',
		keys.includes('categories'),
	);
	const categories = categoriesField.present
		? workflowCategories(categoriesField.value)
		: undefined;
	if (categoriesField.present && categories === undefined) {
		return EVENT_CREATE_MESSAGES.INVALID_CATEGORIES;
	}
	const statusField = ownAdditionalField(additionalFields, 'status', keys.includes('status'));
	if (
		statusField.present &&
		statusField.value !== 'tentative' &&
		statusField.value !== 'confirmed' &&
		statusField.value !== 'cancelled'
	) {
		return EVENT_CREATE_MESSAGES.INVALID_STATUS;
	}
	const transparencyField = ownAdditionalField(
		additionalFields,
		'transparency',
		keys.includes('transparency'),
	);
	if (
		transparencyField.present &&
		transparencyField.value !== 'opaque' &&
		transparencyField.value !== 'transparent'
	) {
		return EVENT_CREATE_MESSAGES.INVALID_TRANSPARENCY;
	}

	return Object.freeze({
		calendarUrl,
		...(uidValue.length === 0 ? {} : { uid: uidValue }),
		...timeInput,
		summary,
		...(descriptionField.present ? { description: descriptionField.value as string } : {}),
		...(locationField.present ? { location: locationField.value as string } : {}),
		...(urlField.present ? { url: urlField.value as string } : {}),
		...(categoriesField.present ? { categories: categories! } : {}),
		...(statusField.present ? { status: statusField.value as CalendarEventStatus } : {}),
		...(transparencyField.present
			? { transparency: transparencyField.value as CalendarEventTransparency }
			: {}),
	});
}

type OptionalPatchExtraction<T> =
	{ readonly patch: OptionalFieldPatch<T> } | { readonly error: string };

function optionalUpdatePatchValue<T>(
	value: unknown,
	invalidValueMessage: string,
	validateValue: (value: unknown) => T | undefined,
): OptionalPatchExtraction<T> {
	try {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) {
			return { error: invalidValueMessage };
		}
		const outerDescriptors = Object.getOwnPropertyDescriptors(value);
		if (
			Object.getOwnPropertySymbols(value).length !== 0 ||
			Object.keys(outerDescriptors).some((key) => key !== 'change') ||
			outerDescriptors.change === undefined ||
			!outerDescriptors.change.enumerable ||
			!('value' in outerDescriptors.change)
		) {
			return { error: invalidValueMessage };
		}
		const change = outerDescriptors.change.value as unknown;
		if (typeof change !== 'object' || change === null || Array.isArray(change)) {
			return { error: invalidValueMessage };
		}
		const descriptors = Object.getOwnPropertyDescriptors(change);
		if (
			Object.getOwnPropertySymbols(change).length !== 0 ||
			Object.keys(descriptors).some((key) => key !== 'action' && key !== 'value') ||
			descriptors.action === undefined ||
			!descriptors.action.enumerable ||
			!('value' in descriptors.action)
		) {
			return { error: invalidValueMessage };
		}
		const action = descriptors.action.value;
		if (action === 'remove') return { patch: { kind: 'remove' } };
		const valueDescriptor = descriptors.value;
		const validatedValue =
			valueDescriptor !== undefined && 'value' in valueDescriptor
				? validateValue(valueDescriptor.value)
				: undefined;
		if (
			action !== 'set' ||
			valueDescriptor === undefined ||
			!valueDescriptor.enumerable ||
			!('value' in valueDescriptor) ||
			validatedValue === undefined
		) {
			return { error: invalidValueMessage };
		}
		return { patch: { kind: 'set', value: validatedValue } };
	} catch {
		return { error: invalidValueMessage };
	}
}

function optionalUpdatePatch(
	value: unknown,
	invalidValueMessage: string,
	validateValue: (value: string) => boolean,
): OptionalPatchExtraction<string> {
	return optionalUpdatePatchValue(value, invalidValueMessage, (candidate) =>
		typeof candidate === 'string' && validateValue(candidate) ? candidate : undefined,
	);
}

function eventUpsertInput(
	execution: IExecuteFunctions,
	itemIndex: number,
): CalendarEventUpsertInput | string {
	const calendarUrl = calendarLocatorUrl(nodeParameter(execution, 'calendar', itemIndex));
	if (calendarUrl === undefined) return EVENT_UPSERT_MESSAGES.INVALID_CALENDAR_URL;

	const uidValue = nodeParameter(execution, 'uid', itemIndex);
	if (typeof uidValue !== 'string' || (uidValue.length > 0 && !isValidICalendarText(uidValue))) {
		return EVENT_UPSERT_MESSAGES.INVALID_UID;
	}
	const timeMode = nodeParameter(execution, 'timeMode', itemIndex);
	if (timeMode !== 'timed' && timeMode !== 'allDay') {
		return EVENT_UPSERT_MESSAGES.INVALID_TIME_MODE;
	}

	let timeInput:
		| {
				readonly timeMode: 'timed';
				readonly start: Date;
				readonly end: Date;
				readonly timeZone: CalendarEventTimeZone;
		  }
		| {
				readonly timeMode: 'allDay';
				readonly startDate: CalendarDateString;
				readonly endDate: CalendarDateString;
		  };
	if (timeMode === 'timed') {
		const timeZoneMode = nodeParameter(execution, 'timeZoneMode', itemIndex);
		let timeZone: CalendarEventTimeZone;
		if (timeZoneMode === 'utc') {
			timeZone = { timeZoneMode: 'utc' };
		} else if (timeZoneMode === 'iana') {
			const value = nodeParameter(execution, 'timeZone', itemIndex);
			try {
				if (typeof value !== 'string') return EVENT_UPSERT_MESSAGES.INVALID_TIME_ZONE;
				timeZone = { timeZoneMode: 'iana', timeZone: canonicalizeIanaTimeZone(value) };
			} catch (error) {
				return error instanceof CalDavIanaTimeZoneError &&
					error.code === CalDavIanaTimeZoneErrorCode.UTC_EQUIVALENT
					? EVENT_UPSERT_MESSAGES.UTC_TIME_ZONE
					: EVENT_UPSERT_MESSAGES.INVALID_TIME_ZONE;
			}
		} else {
			return EVENT_UPSERT_MESSAGES.INVALID_TIME_ZONE_MODE;
		}
		const start = createDateTimeInstant(nodeParameter(execution, 'start', itemIndex));
		if (start === undefined) return EVENT_UPSERT_MESSAGES.INVALID_START;
		const end = createDateTimeInstant(nodeParameter(execution, 'end', itemIndex));
		if (end === undefined) return EVENT_UPSERT_MESSAGES.INVALID_END;
		timeInput = { timeMode, start, end, timeZone };
	} else {
		const startDate = workflowCalendarDate(
			execution,
			nodeParameter(execution, 'startDate', itemIndex),
		);
		if (startDate === undefined) return EVENT_UPSERT_MESSAGES.INVALID_START_DATE;
		const endDate = workflowCalendarDate(execution, nodeParameter(execution, 'endDate', itemIndex));
		if (endDate === undefined) return EVENT_UPSERT_MESSAGES.INVALID_END_DATE;
		timeInput = { timeMode, startDate, endDate };
	}

	const summary = nodeParameter(execution, 'summary', itemIndex);
	if (typeof summary !== 'string' || !isValidICalendarText(summary)) {
		return EVENT_UPSERT_MESSAGES.INVALID_SUMMARY;
	}
	const additionalValue = nodeParameter(execution, 'additionalFields', itemIndex);
	if (
		typeof additionalValue !== 'object' ||
		additionalValue === null ||
		Array.isArray(additionalValue)
	) {
		return EVENT_UPSERT_MESSAGES.INVALID_ADDITIONAL_FIELDS;
	}
	let descriptors: Readonly<Record<string, PropertyDescriptor>>;
	try {
		if (Object.getOwnPropertySymbols(additionalValue).length !== 0) {
			return EVENT_UPSERT_MESSAGES.INVALID_ADDITIONAL_FIELDS;
		}
		descriptors = Object.getOwnPropertyDescriptors(additionalValue);
	} catch {
		return EVENT_UPSERT_MESSAGES.INVALID_ADDITIONAL_FIELDS;
	}
	if (
		Object.keys(descriptors).some(
			(key) =>
				!['description', 'location', 'url', 'categories', 'status', 'transparency'].includes(key) ||
				!descriptors[key]!.enumerable ||
				!('value' in descriptors[key]!),
		)
	) {
		return EVENT_UPSERT_MESSAGES.INVALID_ADDITIONAL_FIELDS;
	}
	const patches: {
		description?: OptionalFieldPatch<string>;
		location?: OptionalFieldPatch<string>;
		url?: OptionalFieldPatch<string>;
		categories?: OptionalFieldPatch<readonly string[]>;
		status?: OptionalFieldPatch<CalendarEventStatus>;
		transparency?: OptionalFieldPatch<CalendarEventTransparency>;
	} = {};
	for (const [name, message, validator] of [
		['description', EVENT_UPSERT_MESSAGES.INVALID_DESCRIPTION, isValidICalendarText],
		['location', EVENT_UPSERT_MESSAGES.INVALID_LOCATION, isValidICalendarText],
		['url', EVENT_UPSERT_MESSAGES.INVALID_URL, isValidCreateUrl],
	] as const) {
		if (descriptors[name] === undefined) continue;
		const extracted = optionalUpdatePatch(descriptors[name].value, message, validator);
		if ('error' in extracted) return extracted.error;
		patches[name] = extracted.patch;
	}
	if (descriptors.categories !== undefined) {
		const extracted = optionalUpdatePatchValue(
			descriptors.categories.value,
			EVENT_UPSERT_MESSAGES.INVALID_CATEGORIES,
			workflowCategories,
		);
		if ('error' in extracted) return extracted.error;
		patches.categories = extracted.patch;
	}
	if (descriptors.status !== undefined) {
		const extracted = optionalUpdatePatchValue<CalendarEventStatus>(
			descriptors.status.value,
			EVENT_UPSERT_MESSAGES.INVALID_STATUS,
			(value) =>
				value === 'tentative' || value === 'confirmed' || value === 'cancelled' ? value : undefined,
		);
		if ('error' in extracted) return extracted.error;
		patches.status = extracted.patch;
	}
	if (descriptors.transparency !== undefined) {
		const extracted = optionalUpdatePatchValue<CalendarEventTransparency>(
			descriptors.transparency.value,
			EVENT_UPSERT_MESSAGES.INVALID_TRANSPARENCY,
			(value) => (value === 'opaque' || value === 'transparent' ? value : undefined),
		);
		if ('error' in extracted) return extracted.error;
		patches.transparency = extracted.patch;
	}
	if (timeInput.timeMode === 'timed') {
		if (timeInput.end.getTime() <= timeInput.start.getTime()) {
			return EVENT_UPSERT_MESSAGES.INVALID_RANGE;
		}
		if (timeInput.timeZone.timeZoneMode === 'iana') {
			if (
				resolveLocalDateTimeInTimeZone(
					projectInstantInTimeZone(timeInput.start, timeInput.timeZone.timeZone),
					timeInput.timeZone.timeZone,
				).getTime() !== timeInput.start.getTime()
			) {
				return EVENT_UPSERT_MESSAGES.UNREPRESENTABLE_START;
			}
			if (
				resolveLocalDateTimeInTimeZone(
					projectInstantInTimeZone(timeInput.end, timeInput.timeZone.timeZone),
					timeInput.timeZone.timeZone,
				).getTime() !== timeInput.end.getTime()
			) {
				return EVENT_UPSERT_MESSAGES.UNREPRESENTABLE_END;
			}
		}
	} else if (timeInput.endDate <= timeInput.startDate) {
		return EVENT_UPSERT_MESSAGES.INVALID_RANGE;
	}

	return Object.freeze({
		calendarUrl,
		...(uidValue.length === 0 ? {} : { uid: uidValue }),
		...timeInput,
		summary,
		...patches,
	}) as CalendarEventUpsertInput;
}

function eventUpdatePatch(
	execution: IExecuteFunctions,
	value: unknown,
	timeMode: 'timed' | 'allDay',
): CalendarEventPatch | string {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return EVENT_UPDATE_MESSAGES.INVALID_FIELDS;
	}

	let descriptors: Readonly<Record<string, PropertyDescriptor>>;
	try {
		if (Object.getOwnPropertySymbols(value).length !== 0) {
			return EVENT_UPDATE_MESSAGES.INVALID_FIELDS;
		}
		descriptors = Object.getOwnPropertyDescriptors(value);
	} catch {
		return EVENT_UPDATE_MESSAGES.INVALID_FIELDS;
	}
	const keys = Object.keys(descriptors);
	if (keys.length === 0) return EVENT_UPDATE_MESSAGES.NO_CHANGES;
	const allowed = new Set([
		'timeZone',
		'start',
		'end',
		'startDate',
		'endDate',
		'summary',
		'description',
		'location',
		'url',
		'categories',
		'status',
		'transparency',
	]);
	if (
		keys.some((key) => {
			const descriptor = descriptors[key]!;
			return !allowed.has(key) || !descriptor.enumerable || !('value' in descriptor);
		})
	) {
		return EVENT_UPDATE_MESSAGES.INVALID_FIELDS;
	}
	if (
		(timeMode === 'timed' &&
			(descriptors.startDate !== undefined || descriptors.endDate !== undefined)) ||
		(timeMode === 'allDay' &&
			(descriptors.timeZone !== undefined ||
				descriptors.start !== undefined ||
				descriptors.end !== undefined))
	) {
		return EVENT_UPDATE_MESSAGES.INVALID_FIELDS;
	}

	const patch: {
		timeMode: 'timed' | 'allDay';
		timeZone?: { readonly kind: 'set'; readonly value: CalendarEventTimeZone };
		start?: { readonly kind: 'set'; readonly value: Date };
		end?: { readonly kind: 'set'; readonly value: Date };
		startDate?: { readonly kind: 'set'; readonly value: string };
		endDate?: { readonly kind: 'set'; readonly value: string };
		summary?: { readonly kind: 'set'; readonly value: string };
		description?: OptionalFieldPatch<string>;
		location?: OptionalFieldPatch<string>;
		url?: OptionalFieldPatch<string>;
		categories?: OptionalFieldPatch<readonly string[]>;
		status?: OptionalFieldPatch<CalendarEventStatus>;
		transparency?: OptionalFieldPatch<CalendarEventTransparency>;
	} = { timeMode };
	if (descriptors.timeZone !== undefined) {
		const outer = descriptors.timeZone.value;
		if (typeof outer !== 'object' || outer === null || Array.isArray(outer)) {
			return EVENT_UPDATE_MESSAGES.INVALID_FIELDS;
		}
		const change = (outer as { readonly change?: unknown }).change;
		if (typeof change !== 'object' || change === null || Array.isArray(change)) {
			return EVENT_UPDATE_MESSAGES.INVALID_FIELDS;
		}
		const mode = (change as { readonly timeZoneMode?: unknown }).timeZoneMode;
		if (mode === 'utc') {
			patch.timeZone = { kind: 'set', value: { timeZoneMode: 'utc' } };
		} else if (mode === 'iana') {
			const value = (change as { readonly timeZone?: unknown }).timeZone;
			try {
				if (typeof value !== 'string') return EVENT_UPDATE_MESSAGES.INVALID_TIME_ZONE;
				patch.timeZone = {
					kind: 'set',
					value: { timeZoneMode: 'iana', timeZone: canonicalizeIanaTimeZone(value) },
				};
			} catch (error) {
				return error instanceof CalDavIanaTimeZoneError &&
					error.code === CalDavIanaTimeZoneErrorCode.UTC_EQUIVALENT
					? EVENT_UPDATE_MESSAGES.UTC_TIME_ZONE
					: EVENT_UPDATE_MESSAGES.INVALID_TIME_ZONE;
			}
		} else {
			return EVENT_UPDATE_MESSAGES.INVALID_TIME_ZONE_MODE;
		}
	}
	if (descriptors.start !== undefined) {
		const start = createDateTimeInstant(descriptors.start.value);
		if (start === undefined) return EVENT_UPDATE_MESSAGES.INVALID_START;
		patch.start = { kind: 'set', value: start };
	}
	if (descriptors.end !== undefined) {
		const end = createDateTimeInstant(descriptors.end.value);
		if (end === undefined) return EVENT_UPDATE_MESSAGES.INVALID_END;
		patch.end = { kind: 'set', value: end };
	}
	if (descriptors.startDate !== undefined) {
		const startDate = workflowCalendarDate(execution, descriptors.startDate.value);
		if (startDate === undefined) return EVENT_UPDATE_MESSAGES.INVALID_START_DATE;
		patch.startDate = { kind: 'set', value: startDate };
	}
	if (descriptors.endDate !== undefined) {
		const endDate = workflowCalendarDate(execution, descriptors.endDate.value);
		if (endDate === undefined) return EVENT_UPDATE_MESSAGES.INVALID_END_DATE;
		patch.endDate = { kind: 'set', value: endDate };
	}
	if (descriptors.summary !== undefined) {
		const summary = descriptors.summary.value;
		if (typeof summary !== 'string' || !isValidICalendarText(summary)) {
			return EVENT_UPDATE_MESSAGES.INVALID_SUMMARY;
		}
		patch.summary = { kind: 'set', value: summary };
	}
	if (descriptors.description !== undefined) {
		const extracted = optionalUpdatePatch(
			descriptors.description.value,
			EVENT_UPDATE_MESSAGES.INVALID_DESCRIPTION,
			isValidICalendarText,
		);
		if ('error' in extracted) return extracted.error;
		patch.description = extracted.patch;
	}
	if (descriptors.location !== undefined) {
		const extracted = optionalUpdatePatch(
			descriptors.location.value,
			EVENT_UPDATE_MESSAGES.INVALID_LOCATION,
			isValidICalendarText,
		);
		if ('error' in extracted) return extracted.error;
		patch.location = extracted.patch;
	}
	if (descriptors.url !== undefined) {
		const extracted = optionalUpdatePatch(
			descriptors.url.value,
			EVENT_UPDATE_MESSAGES.INVALID_URL,
			isValidCreateUrl,
		);
		if ('error' in extracted) return extracted.error;
		patch.url = extracted.patch;
	}
	if (descriptors.categories !== undefined) {
		const extracted = optionalUpdatePatchValue(
			descriptors.categories.value,
			EVENT_UPDATE_MESSAGES.INVALID_CATEGORIES,
			workflowCategories,
		);
		if ('error' in extracted) return extracted.error;
		patch.categories = extracted.patch;
	}
	if (descriptors.status !== undefined) {
		const extracted = optionalUpdatePatchValue<CalendarEventStatus>(
			descriptors.status.value,
			EVENT_UPDATE_MESSAGES.INVALID_STATUS,
			(value) =>
				value === 'tentative' || value === 'confirmed' || value === 'cancelled' ? value : undefined,
		);
		if ('error' in extracted) return extracted.error;
		patch.status = extracted.patch;
	}
	if (descriptors.transparency !== undefined) {
		const extracted = optionalUpdatePatchValue<CalendarEventTransparency>(
			descriptors.transparency.value,
			EVENT_UPDATE_MESSAGES.INVALID_TRANSPARENCY,
			(value) => (value === 'opaque' || value === 'transparent' ? value : undefined),
		);
		if ('error' in extracted) return extracted.error;
		patch.transparency = extracted.patch;
	}
	return Object.freeze(patch) as CalendarEventPatch;
}

function eventUpdateInput(
	execution: IExecuteFunctions,
	itemIndex: number,
): CalendarEventUpdateInput | string {
	const calendarUrl = calendarLocatorUrl(nodeParameter(execution, 'calendar', itemIndex));
	if (calendarUrl === undefined) return EVENT_UPDATE_MESSAGES.INVALID_CALENDAR_URL;

	const identifierMode = nodeParameter(execution, 'identifierMode', itemIndex);
	if (identifierMode !== RESOURCE_URL_IDENTIFIER_MODE && identifierMode !== UID_IDENTIFIER_MODE) {
		return UNSUPPORTED_OPERATION_MESSAGE;
	}
	const identifierValue = nodeParameter(execution, identifierMode, itemIndex);
	let identifier: CalendarEventUpdateInput['identifier'];
	if (identifierMode === RESOURCE_URL_IDENTIFIER_MODE) {
		try {
			if (typeof identifierValue !== 'string' || identifierValue.length === 0) {
				return EVENT_UPDATE_MESSAGES.INVALID_RESOURCE_URL;
			}
			identifier = {
				kind: 'resourceUrl',
				resourceUrl: validateAbsoluteHttpUrl(identifierValue),
			};
		} catch {
			return EVENT_UPDATE_MESSAGES.INVALID_RESOURCE_URL;
		}
	} else {
		if (
			typeof identifierValue !== 'string' ||
			identifierValue.length === 0 ||
			!isValidXmlText(identifierValue)
		) {
			return EVENT_UPDATE_MESSAGES.INVALID_UID;
		}
		identifier = { kind: 'uid', uid: identifierValue };
	}

	let etag: unknown;
	try {
		etag = execution.getNodeParameter('etag', itemIndex);
	} catch {
		return EVENT_UPDATE_MESSAGES.INVALID_ETAG;
	}
	if (etag !== undefined && typeof etag !== 'string') return EVENT_UPDATE_MESSAGES.INVALID_ETAG;
	const timeMode = nodeParameter(execution, 'timeMode', itemIndex) ?? 'timed';
	if (timeMode !== 'timed' && timeMode !== 'allDay') {
		return EVENT_UPDATE_MESSAGES.INVALID_TIME_MODE;
	}

	let fieldsToUpdate: unknown;
	try {
		fieldsToUpdate = execution.getNodeParameter('fieldsToUpdate', itemIndex);
	} catch {
		return EVENT_UPDATE_MESSAGES.INVALID_FIELDS;
	}
	const patch = eventUpdatePatch(execution, fieldsToUpdate, timeMode);
	if (typeof patch === 'string') return patch;

	return Object.freeze({
		calendarUrl,
		identifier,
		patch,
		...(typeof etag === 'string' && etag.length > 0 ? { etag } : {}),
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

interface AnonymousTimeZoneConnectionBinding {
	readonly hostname: string;
	readonly address: string;
	readonly lookup: ReturnType<NodeEgressFilter['createSecureLookup']>;
}

function normalizedConnectionHostname(hostname: string): string {
	let normalized = hostname.toLowerCase();
	if (normalized.startsWith('[') && normalized.endsWith(']')) {
		normalized = normalized.slice(1, -1);
	}
	return normalized.endsWith('.') ? normalized.slice(0, -1) : normalized;
}

function anonymousResponseHeaders(
	headers: IncomingHttpHeaders,
): Readonly<Record<string, string | readonly string[]>> {
	const normalized: Record<string, string | readonly string[]> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (typeof value === 'string') normalized[name.toLowerCase()] = value;
		else if (Array.isArray(value)) normalized[name.toLowerCase()] = Object.freeze([...value]);
	}
	return Object.freeze(normalized);
}

const ANONYMOUS_TIME_ZONE_TIMEOUT_MS = 30_000;
const ANONYMOUS_TIME_ZONE_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ANONYMOUS_TIME_ZONE_MAX_HEADER_BYTES = 64 * 1024;

async function anonymousTimeZoneRequest(
	execution: IExecuteFunctions,
	request: TimeZoneDistributionRequestInput,
	binding?: AnonymousTimeZoneConnectionBinding,
) {
	let logicalUrl: URL;
	try {
		logicalUrl = new URL(request.url);
	} catch {
		throw new NodeOperationError(execution.getNode(), 'Anonymous time zone request failed');
	}
	const hostname = normalizedConnectionHostname(logicalUrl.hostname);
	if (
		binding === undefined ||
		hostname !== binding.hostname ||
		!/^[0-9a-f:.]+$/i.test(binding.address)
	) {
		throw new NodeOperationError(execution.getNode(), 'Anonymous time zone request failed');
	}
	try {
		const egressFilter = execution.helpers.getSecureEgressFilter?.();
		let lookup = binding.lookup;
		if (egressFilter !== undefined) {
			const validation = await egressFilter.validateUrl(logicalUrl);
			if (!validation.ok) {
				throw new NodeOperationError(execution.getNode(), 'Anonymous time zone request failed');
			}
			lookup = egressFilter.createSecureLookup();
		}
		const accept = Object.entries(request.headers ?? {}).find(
			([name]) => name.toLowerCase() === 'accept',
		)?.[1];
		const headers = Object.freeze({
			...(accept === undefined ? {} : { Accept: accept }),
			Host: logicalUrl.host,
		});
		const response = await new Promise<{
			readonly statusCode: number;
			readonly headers: Readonly<Record<string, string | readonly string[]>>;
			readonly body: Buffer;
		}>((resolve, reject) => {
			const nativeRequest = logicalUrl.protocol === 'https:' ? httpsRequest : httpRequest;
			const client = nativeRequest(
				logicalUrl,
				{
					method: 'GET',
					headers,
					lookup,
					maxHeaderSize: ANONYMOUS_TIME_ZONE_MAX_HEADER_BYTES,
					...(logicalUrl.protocol === 'https:' ? { servername: binding.hostname } : {}),
				},
				(incoming) => {
					const chunks: Buffer[] = [];
					let size = 0;
					incoming.on('data', (chunk: Buffer | Uint8Array | string) => {
						const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
						size += buffer.length;
						if (size > ANONYMOUS_TIME_ZONE_MAX_RESPONSE_BYTES) {
							incoming.destroy(new Error('anonymous response exceeded size limit'));
							return;
						}
						chunks.push(buffer);
					});
					incoming.once('error', reject);
					incoming.once('end', () => {
						if (incoming.statusCode === undefined) {
							reject(new Error('anonymous response omitted status'));
							return;
						}
						resolve({
							statusCode: incoming.statusCode,
							headers: anonymousResponseHeaders(incoming.headers),
							body: Buffer.concat(chunks),
						});
					});
				},
			);
			client.setTimeout(ANONYMOUS_TIME_ZONE_TIMEOUT_MS, () => {
				client.destroy(new Error('anonymous request timed out'));
			});
			client.once('error', reject);
			client.end();
		});
		return { ...response, effectiveUrl: request.url };
	} catch {
		throw new NodeOperationError(execution.getNode(), 'Anonymous time zone request failed');
	}
}

export class CalDav implements INodeType {
	methods = {
		credentialTest: { testCalDavApiCredentials },
		listSearch: { searchCalendars },
		loadOptions: {
			async getIanaTimeZones() {
				return listCanonicalIanaTimeZones().map((timeZone) => ({
					name: timeZone,
					value: timeZone,
				}));
			},
		},
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
						name: 'Update',
						value: UPDATE_OPERATION,
						description: 'Update a calendar event',
						action: 'Update a calendar event',
					},
					{
						name: 'Upsert',
						value: UPSERT_OPERATION,
						description: 'Create or update a calendar event by UID',
						action: 'Upsert a calendar event',
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
						operation: [
							CREATE_OPERATION,
							GET_OPERATION,
							GET_MANY_OPERATION,
							UPDATE_OPERATION,
							UPSERT_OPERATION,
							DELETE_OPERATION,
						],
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
				default: '',
				description:
					'Optional event identity. Leave blank to use a generated UUID. Each separate Create without a UID creates a new identity.',
				displayOptions: {
					show: { resource: [EVENT_RESOURCE], operation: [CREATE_OPERATION] },
				},
			},
			{
				displayName: 'Time Mode',
				name: 'timeMode',
				type: 'options',
				required: true,
				noDataExpression: true,
				options: [
					{ name: 'Timed', value: 'timed' },
					{ name: 'All-Day', value: 'allDay' },
				],
				default: 'timed',
				displayOptions: {
					show: { resource: [EVENT_RESOURCE], operation: [CREATE_OPERATION] },
				},
			},
			{
				displayName: 'Time Zone Mode',
				name: 'timeZoneMode',
				type: 'options',
				required: true,
				default: 'utc',
				options: [
					{ name: 'UTC', value: 'utc' },
					{ name: 'IANA', value: 'iana' },
				],
				displayOptions: {
					show: {
						resource: [EVENT_RESOURCE],
						operation: [CREATE_OPERATION],
						timeMode: ['timed'],
					},
				},
			},
			{
				// eslint-disable-next-line n8n-nodes-base/node-param-display-name-wrong-for-dynamic-options -- issue-42-contract-r2 fixes this exact workflow-facing label.
				displayName: 'Time Zone',
				name: 'timeZone',
				// eslint-disable-next-line n8n-nodes-base/node-param-description-missing-from-dynamic-options -- the accepted contract intentionally keeps this descriptor minimal.
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getIanaTimeZones' },
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: [EVENT_RESOURCE],
						operation: [CREATE_OPERATION],
						timeMode: ['timed'],
						timeZoneMode: ['iana'],
					},
				},
			},
			{
				displayName: 'Start',
				name: 'start',
				type: 'dateTime',
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: [EVENT_RESOURCE],
						operation: [CREATE_OPERATION],
						timeMode: ['timed'],
					},
				},
			},
			{
				displayName: 'End',
				name: 'end',
				type: 'dateTime',
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: [EVENT_RESOURCE],
						operation: [CREATE_OPERATION],
						timeMode: ['timed'],
					},
				},
			},
			{
				displayName: 'Start Date',
				name: 'startDate',
				type: 'dateTime',
				typeOptions: { dateOnly: true },
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: [EVENT_RESOURCE],
						operation: [CREATE_OPERATION],
						timeMode: ['allDay'],
					},
				},
			},
			{
				displayName: 'End Date',
				name: 'endDate',
				type: 'dateTime',
				typeOptions: { dateOnly: true },
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: [EVENT_RESOURCE],
						operation: [CREATE_OPERATION],
						timeMode: ['allDay'],
					},
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
					categoriesDescriptor('categories', 'Categories'),
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
					metadataEnumDescriptor('status', 'Status', STATUS_OPTIONS),
					metadataEnumDescriptor('transparency', 'Transparency', TRANSPARENCY_OPTIONS),
					{
						displayName: 'URL',
						name: 'url',
						type: 'string',
						default: '',
					},
				],
			},
			{
				displayName: 'UID',
				name: 'uid',
				type: 'string',
				default: '',
				description:
					'Leave blank to generate a new UID; this always creates a new resource. A supplied UID is looked up in the selected calendar to choose Create or Update.',
				displayOptions: {
					show: { resource: [EVENT_RESOURCE], operation: [UPSERT_OPERATION] },
				},
			},
			{
				displayName: 'Time Mode',
				name: 'timeMode',
				type: 'options',
				required: true,
				noDataExpression: true,
				options: [
					{ name: 'Timed', value: 'timed' },
					{ name: 'All-Day', value: 'allDay' },
				],
				default: 'timed',
				displayOptions: {
					show: { resource: [EVENT_RESOURCE], operation: [UPSERT_OPERATION] },
				},
			},
			{
				displayName: 'Time Zone Mode',
				name: 'timeZoneMode',
				type: 'options',
				required: true,
				noDataExpression: true,
				default: 'utc',
				options: [
					{ name: 'UTC', value: 'utc' },
					{ name: 'IANA', value: 'iana' },
				],
				displayOptions: {
					show: {
						resource: [EVENT_RESOURCE],
						operation: [UPSERT_OPERATION],
						timeMode: ['timed'],
					},
				},
			},
			{
				// eslint-disable-next-line n8n-nodes-base/node-param-display-name-wrong-for-dynamic-options -- accepted Upsert contract fixes this exact label.
				displayName: 'Time Zone',
				name: 'timeZone',
				// eslint-disable-next-line n8n-nodes-base/node-param-description-missing-from-dynamic-options -- the accepted descriptor is intentionally minimal.
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getIanaTimeZones' },
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: [EVENT_RESOURCE],
						operation: [UPSERT_OPERATION],
						timeMode: ['timed'],
						timeZoneMode: ['iana'],
					},
				},
			},
			{
				displayName: 'Start',
				name: 'start',
				type: 'dateTime',
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: [EVENT_RESOURCE],
						operation: [UPSERT_OPERATION],
						timeMode: ['timed'],
					},
				},
			},
			{
				displayName: 'End',
				name: 'end',
				type: 'dateTime',
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: [EVENT_RESOURCE],
						operation: [UPSERT_OPERATION],
						timeMode: ['timed'],
					},
				},
			},
			{
				displayName: 'Start Date',
				name: 'startDate',
				type: 'dateTime',
				typeOptions: { dateOnly: true },
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: [EVENT_RESOURCE],
						operation: [UPSERT_OPERATION],
						timeMode: ['allDay'],
					},
				},
			},
			{
				displayName: 'End Date',
				name: 'endDate',
				type: 'dateTime',
				typeOptions: { dateOnly: true },
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: [EVENT_RESOURCE],
						operation: [UPSERT_OPERATION],
						timeMode: ['allDay'],
					},
				},
			},
			{
				displayName: 'Summary',
				name: 'summary',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: { resource: [EVENT_RESOURCE], operation: [UPSERT_OPERATION] },
				},
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: {
					show: { resource: [EVENT_RESOURCE], operation: [UPSERT_OPERATION] },
				},
				options: [
					optionalMetadataPatchDescriptor('categories', 'Categories'),
					...(['description', 'location'] as const).map((name) => ({
						displayName: `${name[0]!.toUpperCase()}${name.slice(1)}`,
						name,
						type: 'fixedCollection' as const,
						typeOptions: { multipleValues: false },
						default: {},
						required: true,
						options: [
							{
								displayName: 'Change',
								name: 'change',
								values: [
									{
										displayName: 'Action',
										name: 'action',
										type: 'options' as const,
										required: true,
										noDataExpression: true,
										options: [
											{ name: 'Set', value: 'set' },
											{ name: 'Remove', value: 'remove' },
										],
										default: 'set',
									},
									{
										displayName: 'Value',
										name: 'value',
										type: 'string' as const,
										...(name === 'description' ? { typeOptions: { rows: 4 } } : {}),
										default: '',
										displayOptions: { show: { action: ['set'] } },
									},
								],
							},
						],
					})),
					optionalMetadataPatchDescriptor('status', 'Status'),
					optionalMetadataPatchDescriptor('transparency', 'Transparency'),
					...(['url'] as const).map((name) => ({
						displayName: 'URL',
						name,
						type: 'fixedCollection' as const,
						typeOptions: { multipleValues: false },
						default: {},
						required: true,
						options: [
							{
								displayName: 'Change',
								name: 'change',
								values: [
									{
										displayName: 'Action',
										name: 'action',
										type: 'options' as const,
										required: true,
										noDataExpression: true,
										options: [
											{ name: 'Set', value: 'set' },
											{ name: 'Remove', value: 'remove' },
										],
										default: 'set',
									},
									{
										displayName: 'Value',
										name: 'value',
										type: 'string' as const,
										default: '',
										displayOptions: { show: { action: ['set'] } },
									},
								],
							},
						],
					})),
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
						operation: [GET_OPERATION, UPDATE_OPERATION, DELETE_OPERATION],
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
						operation: [GET_OPERATION, UPDATE_OPERATION, DELETE_OPERATION],
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
						operation: [GET_OPERATION, UPDATE_OPERATION, DELETE_OPERATION],
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
					show: {
						resource: [EVENT_RESOURCE],
						operation: [UPDATE_OPERATION, DELETE_OPERATION],
					},
				},
			},
			{
				displayName: 'Time Mode',
				name: 'timeMode',
				type: 'options',
				required: true,
				noDataExpression: true,
				options: [
					{ name: 'Timed', value: 'timed' },
					{ name: 'All-Day', value: 'allDay' },
				],
				default: 'timed',
				displayOptions: {
					show: { resource: [EVENT_RESOURCE], operation: [UPDATE_OPERATION] },
				},
			},
			{
				displayName: 'Fields to Update',
				name: 'fieldsToUpdate',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				required: true,
				displayOptions: {
					show: { resource: [EVENT_RESOURCE], operation: [UPDATE_OPERATION] },
				},
				// eslint-disable-next-line n8n-nodes-base/node-param-collection-type-unsorted-items -- issue-42-contract-r2 requires Time Zone, Start, End, Summary, Description, Location, URL order.
				options: [
					{
						displayName: 'Time Zone',
						name: 'timeZone',
						type: 'fixedCollection',
						typeOptions: { multipleValues: false },
						default: {},
						// eslint-disable-next-line n8n-nodes-base/node-param-collection-type-item-required -- selecting the atomic timezone patch requires a complete nested value.
						required: true,
						options: [
							{
								displayName: 'Change',
								name: 'change',
								values: [
									{
										displayName: 'Mode',
										name: 'timeZoneMode',
										type: 'options',
										options: [
											{ name: 'UTC', value: 'utc' },
											{ name: 'IANA', value: 'iana' },
										],
										default: 'utc',
									},
									{
										// eslint-disable-next-line n8n-nodes-base/node-param-display-name-wrong-for-dynamic-options -- issue-42-contract-r2 fixes this exact nested label.
										displayName: 'IANA Time Zone',
										name: 'timeZone',
										// eslint-disable-next-line n8n-nodes-base/node-param-description-missing-from-dynamic-options -- the parent collection explains the atomic choice.
										type: 'options',
										typeOptions: { loadOptionsMethod: 'getIanaTimeZones' },
										default: '',
										displayOptions: { show: { timeZoneMode: ['iana'] } },
									},
								],
							},
						],
					},
					{
						displayName: 'Start',
						name: 'start',
						type: 'dateTime',
						default: '',
						displayOptions: { show: { timeMode: ['timed'] } },
					},
					{
						displayName: 'End',
						name: 'end',
						type: 'dateTime',
						default: '',
						displayOptions: { show: { timeMode: ['timed'] } },
					},
					{
						displayName: 'Start Date',
						name: 'startDate',
						type: 'dateTime',
						typeOptions: { dateOnly: true },
						default: '',
						displayOptions: { show: { timeMode: ['allDay'] } },
					},
					{
						displayName: 'End Date',
						name: 'endDate',
						type: 'dateTime',
						typeOptions: { dateOnly: true },
						default: '',
						displayOptions: { show: { timeMode: ['allDay'] } },
					},
					{
						displayName: 'Summary',
						name: 'summary',
						type: 'string',
						default: '',
					},
					optionalMetadataPatchDescriptor('categories', 'Categories'),
					{
						displayName: 'Description',
						name: 'description',
						type: 'fixedCollection',
						typeOptions: { multipleValues: false },
						default: {},
						required: true,
						options: [
							{
								displayName: 'Change',
								name: 'change',
								values: [
									{
										displayName: 'Action',
										name: 'action',
										type: 'options',
										required: true,
										noDataExpression: true,
										options: [
											{ name: 'Set', value: 'set' },
											{ name: 'Remove', value: 'remove' },
										],
										default: 'set',
									},
									{
										displayName: 'Value',
										name: 'value',
										type: 'string',
										typeOptions: { rows: 4 },
										default: '',
										displayOptions: { show: { action: ['set'] } },
									},
								],
							},
						],
					},
					{
						displayName: 'Location',
						name: 'location',
						type: 'fixedCollection',
						typeOptions: { multipleValues: false },
						default: {},
						required: true,
						options: [
							{
								displayName: 'Change',
								name: 'change',
								values: [
									{
										displayName: 'Action',
										name: 'action',
										type: 'options',
										required: true,
										noDataExpression: true,
										options: [
											{ name: 'Set', value: 'set' },
											{ name: 'Remove', value: 'remove' },
										],
										default: 'set',
									},
									{
										displayName: 'Value',
										name: 'value',
										type: 'string',
										default: '',
										displayOptions: { show: { action: ['set'] } },
									},
								],
							},
						],
					},
					optionalMetadataPatchDescriptor('status', 'Status'),
					optionalMetadataPatchDescriptor('transparency', 'Transparency'),
					{
						displayName: 'URL',
						name: 'url',
						type: 'fixedCollection',
						typeOptions: { multipleValues: false },
						default: {},
						required: true,
						options: [
							{
								displayName: 'Change',
								name: 'change',
								values: [
									{
										displayName: 'Action',
										name: 'action',
										type: 'options',
										required: true,
										noDataExpression: true,
										options: [
											{ name: 'Set', value: 'set' },
											{ name: 'Remove', value: 'remove' },
										],
										default: 'set',
									},
									{
										displayName: 'Value',
										name: 'value',
										type: 'string',
										default: '',
										displayOptions: { show: { action: ['set'] } },
									},
								],
							},
						],
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		let getTransport: CalDavTransport | undefined;
		let getProvider: CalDavProviderAdapter | undefined;
		let timeZoneContext: CalendarEventTimeZoneExecutionContext | undefined;
		let hasIanaEventCreate: boolean | undefined;
		const ensureTimeZoneContext = (
			transport: CalDavTransport,
		): CalendarEventTimeZoneExecutionContext => {
			timeZoneContext ??= createCalendarEventTimeZoneExecutionContext({
				transport,
				request: ((request, binding?: AnonymousTimeZoneConnectionBinding) =>
					anonymousTimeZoneRequest(this, request, binding)) as TimeZoneDistributionRequest,
			});
			return timeZoneContext;
		};

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
			const isEventUpdate = resource === EVENT_RESOURCE && operation === UPDATE_OPERATION;
			const isEventUpsert = resource === EVENT_RESOURCE && operation === UPSERT_OPERATION;
			const isEventDelete = resource === EVENT_RESOURCE && operation === DELETE_OPERATION;
			if (
				!isCalendarOperation &&
				!isEventCreate &&
				!isEventGet &&
				!isEventGetMany &&
				!isEventUpdate &&
				!isEventUpsert &&
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
				if (hasIanaEventCreate === undefined) {
					hasIanaEventCreate = items.some(
						(_item, index) => (nodeParameter(this, 'timeZoneMode', index) ?? 'utc') === 'iana',
					);
				}
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
					if (hasIanaEventCreate && timeZoneContext === undefined) {
						timeZoneContext = ensureTimeZoneContext(getTransport);
					}
					const created = await createCalendarEvent(
						getTransport,
						input,
						() => new Date(),
						timeZoneContext,
					);
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

			if (isEventUpsert) {
				const input = eventUpsertInput(this, itemIndex);
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
					if (
						input.uid !== undefined ||
						(input.timeMode === 'timed' && input.timeZone?.timeZoneMode === 'iana')
					) {
						bindCalendarEventTimeZoneExecutionContext(
							getTransport,
							ensureTimeZoneContext(getTransport),
						);
					}
					const result = await upsertCalendarEvent(getTransport, input, {
						clock: () => new Date(),
						uidFactory: () => resolveCalendarEventUid(undefined),
					});
					returnData.push({
						json: { action: result.action, ...eventJson(result.event) },
						pairedItem: { item: itemIndex },
					});
				} catch (error) {
					const failure = eventUpsertFailure(error);
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
					const results = await queryCalendarEventsByTimeRange(
						getTransport,
						input.calendarUrl,
						{ start: input.start, end: input.end },
						ensureTimeZoneContext(getTransport),
					);
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

			if (isEventUpdate) {
				const input = eventUpdateInput(this, itemIndex);
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
					const updated = await updateCalendarEvent(
						getTransport,
						input,
						() => new Date(),
						ensureTimeZoneContext(getTransport),
					);
					returnData.push({ json: eventJson(updated), pairedItem: { item: itemIndex } });
				} catch (error) {
					const failure = eventUpdateFailure(error);
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
							? await resolveCalendarEventByUid(getTransport, calendarUrl, uid!, {
									timeZoneContext: ensureTimeZoneContext(getTransport),
								})
							: await getCalendarEventByResourceUrl(getTransport, calendarUrl, resourceUrl, {
									timeZoneContext: ensureTimeZoneContext(getTransport),
								});
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
