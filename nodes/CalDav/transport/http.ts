/* eslint-disable @n8n/community-nodes/require-node-api-error -- The accepted protocol-layer contract requires transport-specific errors, outside the n8n UI boundary. */
/* eslint-disable @n8n/community-nodes/no-restricted-globals -- The accepted transport contract requires one explicit helper-and-stream deadline. */
// The accepted transport dependency boundary explicitly permits Node built-ins.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { Readable } from 'node:stream';

import type { IExecuteFunctions, IHttpRequestOptions, IN8nHttpFullResponse } from 'n8n-workflow';

import { validateAndNormalizeServerUrl } from '../../../credentials/CalDavApi.credentials';
import { defaultCalDavProviderRegistry } from '../providers/registry';
import type { CalDavProviderAdapter, CalDavProviderRegistry } from '../providers/types';
import {
	type AbsoluteHttpUrl,
	CalDavUrlValidationError,
	resolveCalDavHref,
	validateAbsoluteHttpUrl,
} from './url';

export const CALDAV_CREDENTIAL_TYPE = 'calDavApi';
export const CALDAV_REQUEST_TIMEOUT_MS = 30_000;
export const CALDAV_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
export const CALDAV_MAX_ERROR_EXCERPT_BYTES = 8 * 1024;
export const CALDAV_MAX_REDIRECTS = 5;

export const CalDavMethod = {
	OPTIONS: 'OPTIONS',
	PROPFIND: 'PROPFIND',
	REPORT: 'REPORT',
	GET: 'GET',
	PUT: 'PUT',
	DELETE: 'DELETE',
} as const;

export type CalDavMethod = (typeof CalDavMethod)[keyof typeof CalDavMethod];

export type CalDavRequestHeaders = Readonly<Record<string, string>>;
export type CalDavResponseHeaderValue = string | readonly string[];
export type CalDavResponseHeaders = Readonly<Record<string, CalDavResponseHeaderValue>>;

export interface CalDavTransportRequest {
	readonly method: CalDavMethod;
	readonly url?: AbsoluteHttpUrl;
	readonly headers?: CalDavRequestHeaders;
	readonly body?: string | Buffer;
}

export interface CalDavTransportResponse {
	readonly statusCode: number;
	readonly headers: CalDavResponseHeaders;
	readonly effectiveUrl: string;
	readonly etag?: string;
	readonly body: Buffer;
}

export type N8nCalDavRequestOptions = Omit<
	IHttpRequestOptions,
	| 'method'
	| 'encoding'
	| 'returnFullResponse'
	| 'ignoreHttpStatusErrors'
	| 'disableFollowRedirect'
	| 'sendCredentialsOnCrossOriginRedirect'
	| 'timeout'
> & {
	readonly method: CalDavMethod;
	readonly encoding: 'stream';
	readonly returnFullResponse: true;
	readonly ignoreHttpStatusErrors: true;
	readonly disableFollowRedirect: true;
	readonly sendCredentialsOnCrossOriginRedirect: false;
	readonly timeout: 30_000;
};

export interface CalDavRequestHelperAdapter {
	request(options: N8nCalDavRequestOptions): Promise<IN8nHttpFullResponse>;
}

export interface CalDavTransport {
	readonly serverUrl: string;
	request(input: CalDavTransportRequest): Promise<CalDavTransportResponse>;
}

export const CalDavTransportErrorCode = {
	AUTHENTICATION_FAILED: 'AUTHENTICATION_FAILED',
	AUTHORIZATION_FAILED: 'AUTHORIZATION_FAILED',
	NOT_FOUND: 'NOT_FOUND',
	TIMEOUT: 'TIMEOUT',
	RESPONSE_LIMIT_EXCEEDED: 'RESPONSE_LIMIT_EXCEEDED',
	REMOTE_PROTOCOL_ERROR: 'REMOTE_PROTOCOL_ERROR',
	NETWORK_ERROR: 'NETWORK_ERROR',
	INVALID_REDIRECT: 'INVALID_REDIRECT',
	INSECURE_REDIRECT: 'INSECURE_REDIRECT',
	UNTRUSTED_TARGET: 'UNTRUSTED_TARGET',
	REDIRECT_LOOP: 'REDIRECT_LOOP',
	REDIRECT_LIMIT_EXCEEDED: 'REDIRECT_LIMIT_EXCEEDED',
} as const;

export type CalDavTransportErrorCode =
	(typeof CalDavTransportErrorCode)[keyof typeof CalDavTransportErrorCode];

function isValidStatusCode(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599;
}

export abstract class CalDavTransportError extends Error {
	readonly code: CalDavTransportErrorCode;
	readonly statusCode?: number;

	protected constructor(code: CalDavTransportErrorCode, message: string, statusCode?: number) {
		super(message);
		this.name = new.target.name;
		this.code = code;
		if (isValidStatusCode(statusCode)) {
			this.statusCode = statusCode;
		}
	}
}

export class CalDavAuthenticationError extends CalDavTransportError {
	constructor(statusCode?: number) {
		super(
			CalDavTransportErrorCode.AUTHENTICATION_FAILED,
			'CalDAV authentication failed.',
			statusCode,
		);
	}
}

export class CalDavAuthorizationError extends CalDavTransportError {
	constructor(statusCode?: number) {
		super(
			CalDavTransportErrorCode.AUTHORIZATION_FAILED,
			'The CalDAV request is not authorized.',
			statusCode,
		);
	}
}

export class CalDavNotFoundError extends CalDavTransportError {
	constructor(statusCode?: number) {
		super(
			CalDavTransportErrorCode.NOT_FOUND,
			'The requested CalDAV resource was not found.',
			statusCode,
		);
	}
}

export class CalDavTimeoutError extends CalDavTransportError {
	constructor() {
		super(CalDavTransportErrorCode.TIMEOUT, 'The CalDAV request timed out after 30 seconds.');
	}
}

export class CalDavResponseLimitError extends CalDavTransportError {
	constructor() {
		super(
			CalDavTransportErrorCode.RESPONSE_LIMIT_EXCEEDED,
			'The CalDAV response exceeded the 10 MiB size limit.',
		);
	}
}

export class CalDavRemoteProtocolError extends CalDavTransportError {
	constructor(statusCode?: number) {
		super(
			CalDavTransportErrorCode.REMOTE_PROTOCOL_ERROR,
			'The CalDAV server returned an unexpected response.',
			statusCode,
		);
	}
}

export class CalDavNetworkError extends CalDavTransportError {
	constructor() {
		super(CalDavTransportErrorCode.NETWORK_ERROR, 'The CalDAV server could not be reached.');
	}
}

export class CalDavInvalidRedirectError extends CalDavTransportError {
	constructor(statusCode?: number) {
		super(
			CalDavTransportErrorCode.INVALID_REDIRECT,
			'The CalDAV server returned an invalid redirect.',
			statusCode,
		);
	}
}

export class CalDavInsecureRedirectError extends CalDavTransportError {
	constructor(statusCode?: number) {
		super(
			CalDavTransportErrorCode.INSECURE_REDIRECT,
			'The CalDAV redirect would use an insecure connection.',
			statusCode,
		);
	}
}

export class CalDavUntrustedTargetError extends CalDavTransportError {
	constructor(statusCode?: number) {
		super(
			CalDavTransportErrorCode.UNTRUSTED_TARGET,
			'The CalDAV request target is not trusted.',
			statusCode,
		);
	}
}

export class CalDavRedirectLoopError extends CalDavTransportError {
	constructor(statusCode?: number) {
		super(
			CalDavTransportErrorCode.REDIRECT_LOOP,
			'The CalDAV request encountered a redirect loop.',
			statusCode,
		);
	}
}

export class CalDavRedirectLimitError extends CalDavTransportError {
	constructor(statusCode?: number) {
		super(
			CalDavTransportErrorCode.REDIRECT_LIMIT_EXCEEDED,
			'The CalDAV request exceeded the 5-redirect limit.',
			statusCode,
		);
	}
}

const SUPPORTED_METHODS = new Set<string>(Object.values(CalDavMethod));
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const TIMEOUT_ERROR_CODES = new Set(['ETIMEDOUT', 'ECONNABORTED']);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSupportedMethod(value: unknown): value is CalDavMethod {
	return typeof value === 'string' && SUPPORTED_METHODS.has(value);
}

function isTimeoutFailure(error: unknown): boolean {
	if (!isRecord(error)) {
		return false;
	}

	try {
		return typeof error.code === 'string' && TIMEOUT_ERROR_CODES.has(error.code);
	} catch {
		return false;
	}
}

function getRejectedResponse(error: unknown): unknown {
	if (!isRecord(error)) {
		return undefined;
	}

	try {
		const response = error.response;
		return isRecord(response) ? response : undefined;
	} catch {
		return undefined;
	}
}

function asciiLowercase(value: string): string {
	return value.replace(/[A-Z]/g, (character) =>
		String.fromCharCode(character.charCodeAt(0) + 0x20),
	);
}

function copyHeaderValue(value: unknown): CalDavResponseHeaderValue {
	if (typeof value === 'string') {
		return value;
	}

	if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
		return Object.freeze([...value]) as readonly string[];
	}

	throw new CalDavRemoteProtocolError();
}

function mergeHeaderValues(
	left: CalDavResponseHeaderValue,
	right: CalDavResponseHeaderValue,
): readonly string[] {
	const leftValues = typeof left === 'string' ? [left] : left;
	const rightValues = typeof right === 'string' ? [right] : right;
	return Object.freeze([...leftValues, ...rightValues]);
}

function normalizeHeaders(headers: unknown, statusCode: number): CalDavResponseHeaders {
	if (!isRecord(headers)) {
		throw new CalDavRemoteProtocolError(statusCode);
	}

	const normalized = Object.create(null) as Record<string, CalDavResponseHeaderValue>;
	const isRedirect = REDIRECT_STATUS_CODES.has(statusCode);

	try {
		const names = Object.keys(headers);
		const orderedNames = isRedirect
			? [
					...names.filter((name) => asciiLowercase(name) !== 'location'),
					...names.filter((name) => asciiLowercase(name) === 'location'),
				]
			: names;

		for (const name of orderedNames) {
			const normalizedName = asciiLowercase(name);
			let value: CalDavResponseHeaderValue;
			try {
				value = copyHeaderValue(headers[name]);
			} catch {
				if (isRedirect && normalizedName === 'location') {
					throw new CalDavInvalidRedirectError(statusCode);
				}
				throw new CalDavRemoteProtocolError(statusCode);
			}
			const previousValue = normalized[normalizedName];
			normalized[normalizedName] =
				previousValue === undefined ? value : mergeHeaderValues(previousValue, value);
		}
	} catch (error) {
		if (error instanceof CalDavInvalidRedirectError) {
			throw error;
		}
		if (error instanceof CalDavTransportError) {
			throw new CalDavRemoteProtocolError(statusCode);
		}
		throw new CalDavRemoteProtocolError(statusCode);
	}

	return Object.freeze(normalized);
}

function extractEtag(headers: CalDavResponseHeaders, statusCode: number): string | undefined {
	const value = headers.etag;
	if (value === undefined) {
		return undefined;
	}

	if (typeof value === 'string') {
		return value;
	}

	if (value.length === 1) {
		return value[0];
	}

	throw new CalDavRemoteProtocolError(statusCode);
}

function safeDestroy(stream: Readable): void {
	try {
		stream.destroy();
	} catch {
		// A hostile stream must not replace the stable transport error.
	}
}

function bufferStreamChunk(chunk: unknown): Buffer {
	if (Buffer.isBuffer(chunk)) {
		return chunk;
	}

	if (chunk instanceof Uint8Array) {
		return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
	}

	if (typeof chunk === 'string') {
		return Buffer.from(chunk, 'utf8');
	}

	throw new CalDavRemoteProtocolError();
}

async function consumeSuccessBody(stream: Readable, statusCode: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let retainedBytes = 0;

	try {
		for await (const rawChunk of stream) {
			const chunk = bufferStreamChunk(rawChunk);
			if (chunk.length === 0) {
				continue;
			}

			if (retainedBytes + chunk.length > CALDAV_MAX_RESPONSE_BYTES) {
				safeDestroy(stream);
				throw new CalDavResponseLimitError();
			}

			// Detach retained bytes from a potentially much larger pooled backing buffer.
			chunks.push(Buffer.from(chunk));
			retainedBytes += chunk.length;
		}
	} catch (error) {
		if (error instanceof CalDavResponseLimitError) {
			throw error;
		}
		if (isTimeoutFailure(error)) {
			throw new CalDavTimeoutError();
		}
		throw new CalDavRemoteProtocolError(statusCode);
	}

	return Buffer.concat(chunks, retainedBytes);
}

function sanitizeErrorExcerpt(excerpt: Buffer): Buffer {
	const normalizedControls = Array.from(excerpt.toString('utf8'), (character) => {
		const codePoint = character.codePointAt(0);
		return codePoint !== undefined &&
			(codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
			? ' '
			: character;
	}).join('');
	const redactedAuthorization = normalizedControls
		.replace(/\bauthorization\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^,;]+)/gi, 'Authorization: [REDACTED]')
		.replace(/\bbasic\s+[A-Za-z0-9+/_=-]+/gi, 'Basic [REDACTED]')
		.replace(/\b(https?:\/\/)[^/@\s]+@/gi, '$1[REDACTED]@');

	return Buffer.from(redactedAuthorization, 'utf8').subarray(0, CALDAV_MAX_ERROR_EXCERPT_BYTES);
}

async function consumeErrorExcerpt(stream: Readable, statusCode: number): Promise<void> {
	const chunks: Buffer[] = [];
	let retainedBytes = 0;

	try {
		for await (const rawChunk of stream) {
			const chunk = bufferStreamChunk(rawChunk);
			if (chunk.length === 0) {
				continue;
			}

			const remainingBytes = CALDAV_MAX_ERROR_EXCERPT_BYTES - retainedBytes;
			if (remainingBytes > 0) {
				const retainedChunk =
					chunk.length <= remainingBytes ? chunk : chunk.subarray(0, remainingBytes);
				// A slice would keep an arbitrarily large response chunk's backing store alive.
				chunks.push(Buffer.from(retainedChunk));
				retainedBytes += retainedChunk.length;
			}

			if (retainedBytes === CALDAV_MAX_ERROR_EXCERPT_BYTES) {
				safeDestroy(stream);
				break;
			}
		}
	} catch (error) {
		if (isTimeoutFailure(error)) {
			throw new CalDavTimeoutError();
		}
		throw new CalDavRemoteProtocolError(statusCode);
	}

	void sanitizeErrorExcerpt(Buffer.concat(chunks, retainedBytes));
}

function mapHttpFailure(statusCode: number): CalDavTransportError {
	if (statusCode === 401) {
		return new CalDavAuthenticationError(statusCode);
	}
	if (statusCode === 403) {
		return new CalDavAuthorizationError(statusCode);
	}
	if (statusCode === 404) {
		return new CalDavNotFoundError(statusCode);
	}
	return new CalDavRemoteProtocolError(statusCode);
}

function hasOversizedContentLength(headers: CalDavResponseHeaders): boolean {
	const value = headers['content-length'];
	const scalarValue =
		typeof value === 'string' ? value : value?.length === 1 ? value[0] : undefined;
	if (scalarValue === undefined || !/^\d+$/.test(scalarValue)) {
		return false;
	}

	return Number(scalarValue) > CALDAV_MAX_RESPONSE_BYTES;
}

interface CalDavResponseEnvelope {
	readonly statusCode: number;
	readonly headers: CalDavResponseHeaders;
	readonly body: Readable;
}

function normalizeResponseEnvelope(
	response: unknown,
	onStream: (stream: Readable) => void,
): CalDavResponseEnvelope {
	if (!isRecord(response)) {
		throw new CalDavRemoteProtocolError();
	}

	let rawBody: unknown;
	let bodyWasRead = false;
	try {
		rawBody = response.body;
		bodyWasRead = true;
	} catch {
		// Read the status below so a valid known status remains available on the stable error.
	}

	const stream = rawBody instanceof Readable ? rawBody : undefined;
	let knownStatusCode: number | undefined;

	try {
		if (stream !== undefined) {
			onStream(stream);
		}

		let statusCode: unknown;
		try {
			statusCode = response.statusCode;
		} catch {
			throw new CalDavRemoteProtocolError();
		}

		if (!isValidStatusCode(statusCode)) {
			throw new CalDavRemoteProtocolError();
		}
		knownStatusCode = statusCode;

		if (!bodyWasRead || stream === undefined) {
			throw new CalDavRemoteProtocolError(statusCode);
		}

		let rawHeaders: unknown;
		try {
			rawHeaders = response.headers;
		} catch {
			throw new CalDavRemoteProtocolError(statusCode);
		}

		const headers = normalizeHeaders(rawHeaders, statusCode);
		return {
			statusCode,
			headers,
			body: stream,
		};
	} catch (error) {
		if (stream !== undefined) {
			safeDestroy(stream);
		}
		if (error instanceof CalDavTransportError) {
			throw error;
		}
		throw new CalDavRemoteProtocolError(knownStatusCode);
	}
}

async function consumeFinalResponse(
	envelope: CalDavResponseEnvelope,
	effectiveUrl: AbsoluteHttpUrl,
): Promise<CalDavTransportResponse> {
	const { statusCode, headers, body: stream } = envelope;

	try {
		const etag = extractEtag(headers, statusCode);

		if (statusCode < 200 || statusCode > 299) {
			await consumeErrorExcerpt(stream, statusCode);
			throw mapHttpFailure(statusCode);
		}

		if (hasOversizedContentLength(headers)) {
			throw new CalDavResponseLimitError();
		}

		const body = await consumeSuccessBody(stream, statusCode);
		return {
			statusCode,
			headers,
			effectiveUrl,
			...(etag === undefined ? {} : { etag }),
			body,
		};
	} catch (error) {
		safeDestroy(stream);
		if (error instanceof CalDavTransportError) {
			throw error;
		}
		throw new CalDavRemoteProtocolError(statusCode);
	}
}

interface CalDavRequestState {
	readonly method: CalDavMethod;
	readonly url: AbsoluteHttpUrl;
	readonly headers?: CalDavRequestHeaders;
	readonly body?: string | Buffer;
}

function buildInitialRequestState(
	configuredUrl: AbsoluteHttpUrl,
	input: CalDavTransportRequest,
): CalDavRequestState {
	let method: unknown;
	let url: unknown;
	let headers: CalDavRequestHeaders | undefined;
	let body: string | Buffer | undefined;

	try {
		method = input.method;
		url = input.url;
		headers = input.headers;
		body = input.body;
	} catch {
		throw new CalDavRemoteProtocolError();
	}

	if (!isSupportedMethod(method)) {
		throw new CalDavRemoteProtocolError();
	}

	let canonicalUrl: AbsoluteHttpUrl;
	try {
		canonicalUrl = url === undefined ? configuredUrl : validateAbsoluteHttpUrl(url as string);
	} catch {
		throw new CalDavUntrustedTargetError();
	}

	return {
		method,
		url: canonicalUrl,
		...(headers === undefined ? {} : { headers }),
		...(body === undefined ? {} : { body }),
	};
}

function buildRequestOptions(state: CalDavRequestState): N8nCalDavRequestOptions {
	return {
		method: state.method,
		url: state.url,
		...(state.headers === undefined ? {} : { headers: state.headers }),
		...(state.body === undefined ? {} : { body: state.body }),
		encoding: 'stream',
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		disableFollowRedirect: true,
		sendCredentialsOnCrossOriginRedirect: false,
		timeout: CALDAV_REQUEST_TIMEOUT_MS,
	};
}

function allowsCredentialForwarding(
	providerAdapter: CalDavProviderAdapter,
	configuredUrl: AbsoluteHttpUrl,
	fromUrl: AbsoluteHttpUrl,
	targetUrl: AbsoluteHttpUrl,
): boolean {
	try {
		return providerAdapter.allowsCredentialForwarding({ configuredUrl, fromUrl, targetUrl });
	} catch {
		return false;
	}
}

function getRedirectLocation(headers: CalDavResponseHeaders, statusCode: number): string {
	const location = headers.location;

	if (typeof location === 'string') {
		if (location.length > 0) {
			return location;
		}
		throw new CalDavInvalidRedirectError(statusCode);
	}

	if (location?.length === 1 && location[0].length > 0) {
		return location[0];
	}

	throw new CalDavInvalidRedirectError(statusCode);
}

function resolveRedirectTarget(
	currentUrl: AbsoluteHttpUrl,
	location: string,
	statusCode: number,
): AbsoluteHttpUrl {
	try {
		return resolveCalDavHref(currentUrl, location);
	} catch (error) {
		if (error instanceof CalDavUrlValidationError && error.code === 'INSECURE_PROTOCOL_DOWNGRADE') {
			throw new CalDavInsecureRedirectError(statusCode);
		}
		throw new CalDavInvalidRedirectError(statusCode);
	}
}

function redirectedHeaders(
	headers: CalDavRequestHeaders | undefined,
	dropContentHeaders: boolean,
	statusCode: number,
): CalDavRequestHeaders | undefined {
	if (headers === undefined) {
		return undefined;
	}

	try {
		const redirected = Object.fromEntries(
			Object.entries(headers).filter(([name]) => {
				const normalizedName = asciiLowercase(name);
				return (
					normalizedName !== 'host' &&
					(!dropContentHeaders || !normalizedName.startsWith('content-'))
				);
			}),
		);
		return Object.freeze(redirected);
	} catch {
		throw new CalDavRemoteProtocolError(statusCode);
	}
}

function redirectIdentity(method: CalDavMethod, url: AbsoluteHttpUrl): string {
	return `${method}\u0000${url}`;
}

function normalizeServerUrl(serverUrl: unknown): string {
	const validation = validateAndNormalizeServerUrl(serverUrl);
	if (!validation.valid || typeof validation.newValue !== 'string') {
		throw new CalDavAuthenticationError();
	}
	return validation.newValue;
}

export function createCalDavTransport(
	serverUrl: unknown,
	adapter: CalDavRequestHelperAdapter,
	providerRegistry: CalDavProviderRegistry = defaultCalDavProviderRegistry,
): CalDavTransport {
	const normalizedServerUrl = normalizeServerUrl(serverUrl);
	let configuredUrl: AbsoluteHttpUrl;
	let providerAdapter: CalDavProviderAdapter;
	try {
		configuredUrl = validateAbsoluteHttpUrl(normalizedServerUrl);
		providerAdapter = providerRegistry.select(configuredUrl);
	} catch {
		throw new CalDavAuthenticationError();
	}

	return {
		serverUrl: normalizedServerUrl,
		async request(input: CalDavTransportRequest): Promise<CalDavTransportResponse> {
			let requestState = buildInitialRequestState(configuredUrl, input);
			if (
				!allowsCredentialForwarding(providerAdapter, configuredUrl, configuredUrl, requestState.url)
			) {
				throw new CalDavUntrustedTargetError();
			}

			let activeStream: Readable | undefined;
			let deadlineExpired = false;
			let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

			const requestAndConsume = (async () => {
				const visited = new Set<string>([redirectIdentity(requestState.method, requestState.url)]);
				let followedRedirects = 0;

				while (true) {
					if (deadlineExpired) {
						throw new CalDavTimeoutError();
					}

					const options = buildRequestOptions(requestState);
					let helperResponse: unknown;
					try {
						helperResponse = await adapter.request(options);
					} catch (error) {
						if (isTimeoutFailure(error)) {
							throw new CalDavTimeoutError();
						}

						const rejectedResponse = getRejectedResponse(error);
						if (rejectedResponse === undefined) {
							throw new CalDavNetworkError();
						}
						helperResponse = rejectedResponse;
					}

					if (deadlineExpired) {
						if (isRecord(helperResponse)) {
							try {
								if (helperResponse.body instanceof Readable) {
									safeDestroy(helperResponse.body);
								}
							} catch {
								// The deadline error remains authoritative.
							}
						}
						throw new CalDavTimeoutError();
					}

					const envelope = normalizeResponseEnvelope(helperResponse, (stream) => {
						activeStream = stream;
						if (deadlineExpired) {
							safeDestroy(stream);
						}
					});

					if (!REDIRECT_STATUS_CODES.has(envelope.statusCode)) {
						return await consumeFinalResponse(envelope, requestState.url);
					}

					try {
						const location = getRedirectLocation(envelope.headers, envelope.statusCode);
						const targetUrl = resolveRedirectTarget(
							requestState.url,
							location,
							envelope.statusCode,
						);
						if (
							!allowsCredentialForwarding(
								providerAdapter,
								configuredUrl,
								requestState.url,
								targetUrl,
							)
						) {
							throw new CalDavUntrustedTargetError(envelope.statusCode);
						}

						const followsSeeOther = envelope.statusCode === 303;
						const nextMethod = followsSeeOther ? CalDavMethod.GET : requestState.method;
						const identity = redirectIdentity(nextMethod, targetUrl);
						if (visited.has(identity)) {
							throw new CalDavRedirectLoopError(envelope.statusCode);
						}
						if (followedRedirects >= CALDAV_MAX_REDIRECTS) {
							throw new CalDavRedirectLimitError(envelope.statusCode);
						}

						const nextHeaders = redirectedHeaders(
							requestState.headers,
							followsSeeOther,
							envelope.statusCode,
						);
						await consumeErrorExcerpt(envelope.body, envelope.statusCode);
						safeDestroy(envelope.body);
						activeStream = undefined;

						visited.add(identity);
						followedRedirects += 1;
						requestState = {
							method: nextMethod,
							url: targetUrl,
							...(nextHeaders === undefined ? {} : { headers: nextHeaders }),
							...(followsSeeOther || requestState.body === undefined
								? {}
								: { body: requestState.body }),
						};
					} catch (error) {
						safeDestroy(envelope.body);
						activeStream = undefined;
						if (error instanceof CalDavTransportError) {
							throw error;
						}
						throw new CalDavInvalidRedirectError(envelope.statusCode);
					}
				}
			})();

			const deadline = new Promise<never>((_resolve, reject) => {
				timeoutHandle = setTimeout(() => {
					deadlineExpired = true;
					if (activeStream !== undefined) {
						safeDestroy(activeStream);
					}
					reject(new CalDavTimeoutError());
				}, CALDAV_REQUEST_TIMEOUT_MS);
			});

			try {
				return await Promise.race([requestAndConsume, deadline]);
			} finally {
				if (timeoutHandle !== undefined) {
					clearTimeout(timeoutHandle);
				}
			}
		},
	};
}

export function createN8nCalDavRequestHelperAdapter(
	context: IExecuteFunctions,
): CalDavRequestHelperAdapter {
	return {
		request(options: N8nCalDavRequestOptions): Promise<IN8nHttpFullResponse> {
			return context.helpers.httpRequestWithAuthentication.call(
				context,
				CALDAV_CREDENTIAL_TYPE,
				options as IHttpRequestOptions,
			);
		},
	};
}

export async function createN8nCalDavTransport(
	context: IExecuteFunctions,
): Promise<CalDavTransport> {
	try {
		const credentials = await context.getCredentials(CALDAV_CREDENTIAL_TYPE);
		if (
			typeof credentials.username !== 'string' ||
			credentials.username.length === 0 ||
			typeof credentials.password !== 'string' ||
			credentials.password.length === 0
		) {
			throw new CalDavAuthenticationError();
		}

		const serverUrl = normalizeServerUrl(credentials.serverUrl);
		return createCalDavTransport(serverUrl, createN8nCalDavRequestHelperAdapter(context));
	} catch {
		throw new CalDavAuthenticationError();
	}
}
