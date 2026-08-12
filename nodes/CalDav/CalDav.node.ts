import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { discoverCalendarHome } from './discovery/calendarHome';
import {
	discoverCalendarCollections,
	type CalendarCollection,
} from './discovery/calendarCollections';
import {
	discoverCurrentUserPrincipal,
	CurrentUserPrincipalDiscoveryKind,
	type AuthenticatedCurrentUserPrincipalOutcome,
	type CurrentUserPrincipalDiscoveryOutcome,
} from './discovery/currentUserPrincipal';
import { testCalDavApiCredentials } from './methods/credentialTest';
import { defaultCalDavProviderRegistry } from './providers/registry';
import { createN8nCalDavTransport } from './transport/http';
import { validateAbsoluteHttpUrl } from './transport/url';

const CALENDAR_RESOURCE = 'calendar';
const GET_MANY_OPERATION = 'getMany';
const INVALID_LIMIT_MESSAGE = 'Limit must be an integer greater than or equal to 1.';
const UNSUPPORTED_OPERATION_MESSAGE = 'The requested CalDAV operation is not supported.';
const GENERIC_GET_MANY_ERROR_MESSAGE = 'The Calendar Get Many operation failed.';

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

function requireAuthenticatedPrincipal(
	outcome: CurrentUserPrincipalDiscoveryOutcome,
	node: ReturnType<IExecuteFunctions['getNode']>,
	itemIndex: number,
): AuthenticatedCurrentUserPrincipalOutcome {
	if (outcome.kind !== CurrentUserPrincipalDiscoveryKind.AUTHENTICATED) {
		const message = SAFE_DOMAIN_ERROR_MESSAGES[outcome.code] ?? GENERIC_GET_MANY_ERROR_MESSAGE;
		throw new NodeApiError(node, { message }, { message, itemIndex });
	}
	return outcome;
}

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

function asJson(collection: CalendarCollection): IDataObject {
	return collection as unknown as IDataObject;
}

export class CalDav implements INodeType {
	methods = { credentialTest: { testCalDavApiCredentials } };

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
						name: 'Get Many',
						value: GET_MANY_OPERATION,
						description: 'Return accessible event calendars',
						action: 'Get many calendars',
					},
				],
				default: GET_MANY_OPERATION,
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
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const resource = this.getNodeParameter('resource', itemIndex);
				const operation = this.getNodeParameter('operation', itemIndex);
				if (resource !== CALENDAR_RESOURCE || operation !== GET_MANY_OPERATION) {
					throw new NodeOperationError(this.getNode(), UNSUPPORTED_OPERATION_MESSAGE, {
						itemIndex,
					});
				}

				const returnAll = this.getNodeParameter('returnAll', itemIndex) === true;
				const limit = returnAll
					? undefined
					: activeLimit(this.getNodeParameter('limit', itemIndex), itemIndex, this.getNode());
				const transport = await createN8nCalDavTransport(this);
				const principal = requireAuthenticatedPrincipal(
					await discoverCurrentUserPrincipal(transport),
					this.getNode(),
					itemIndex,
				);

				const home = await discoverCalendarHome(transport, principal.principalUrl);
				const provider = defaultCalDavProviderRegistry.select(
					validateAbsoluteHttpUrl(transport.serverUrl),
				);
				const collections = await discoverCalendarCollections(
					transport,
					home.calendarHomeUrl,
					provider,
				);
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
