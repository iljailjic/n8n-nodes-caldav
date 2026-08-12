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
const GET_OPERATION = 'get';
const GET_MANY_OPERATION = 'getMany';
const INVALID_LIMIT_MESSAGE = 'Limit must be an integer greater than or equal to 1.';
const UNSUPPORTED_OPERATION_MESSAGE = 'Unsupported CalDAV resource or operation.';
const GENERIC_GET_MANY_ERROR_MESSAGE = 'The Calendar Get Many operation failed.';
const GENERIC_LIST_SEARCH_ERROR_MESSAGE = 'The calendar list could not be loaded.';

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
				options: [{ name: 'Calendar', value: CALENDAR_RESOURCE }],
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
					show: { resource: [CALENDAR_RESOURCE], operation: [GET_OPERATION] },
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

			if (
				resource !== CALENDAR_RESOURCE ||
				(operation !== GET_OPERATION && operation !== GET_MANY_OPERATION)
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
