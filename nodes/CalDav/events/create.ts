/* eslint-disable @n8n/community-nodes/require-node-api-error -- The accepted application-service contract exposes sanitized domain failures outside the n8n UI boundary. */

import { mapCalendarEventResource } from '../icalendar/eventReadModel';
import type { CalendarEvent } from '../icalendar/eventReadModel';
import { parseICalendarResource } from '../icalendar/parser';
import { serializeBasicUtcEvent } from '../icalendar/serializer';
import { CalDavTransportError } from '../transport/http';
import type { CalDavTransport } from '../transport/http';
import { joinCalendarCollectionUrl } from '../transport/url';
import type { AbsoluteHttpUrl } from '../transport/url';
import { createCalendarEventResource, getCalendarEventMutationEtag } from './mutations';
import { resolveCalendarEventUid } from './uid';

export interface CalendarEventCreateInput {
	readonly calendarUrl: AbsoluteHttpUrl;
	readonly uid?: string;
	readonly start: Date;
	readonly end: Date;
	readonly summary: string;
	readonly description?: string;
	readonly location?: string;
	readonly url?: string;
}

export type CalendarEventCreateClock = () => Date;

export type CreatedCalendarEvent = Omit<CalendarEvent, 'etag' | 'summary' | 'extensions'> & {
	readonly etag: string;
	readonly summary: string;
};

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

const MAX_RESOURCE_SEGMENT_BYTES = 255;

function resourceNameForUid(uid: string): string {
	const encoded = Buffer.from(uid, 'utf8')
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/u, '');
	const resourceName = `${encoded}.ics`;
	if (Buffer.byteLength(resourceName, 'ascii') > MAX_RESOURCE_SEGMENT_BYTES) {
		throw new CalDavCalendarEventCreateError(CalendarEventCreateFailureCode.RESOURCE_NAME_TOO_LONG);
	}
	return resourceName;
}

function readClock(clock: CalendarEventCreateClock): Date {
	try {
		const value = clock();
		if (!(value instanceof Date)) {
			throw new CalDavCalendarEventCreateError(CalendarEventCreateFailureCode.INVALID_CLOCK);
		}
		const timestamp = Date.prototype.getTime.call(value);
		if (!Number.isFinite(timestamp)) {
			throw new CalDavCalendarEventCreateError(CalendarEventCreateFailureCode.INVALID_CLOCK);
		}
		const wholeSecond = new Date(Math.floor(timestamp / 1000) * 1000);
		const year = wholeSecond.getUTCFullYear();
		if (year < 1 || year > 9999) {
			throw new CalDavCalendarEventCreateError(CalendarEventCreateFailureCode.INVALID_CLOCK);
		}
		return wholeSecond;
	} catch (error) {
		if (error instanceof CalDavCalendarEventCreateError) throw error;
		throw new CalDavCalendarEventCreateError(CalendarEventCreateFailureCode.INVALID_CLOCK);
	}
}

function normalizeCreatedEvent(
	input: CalendarEventCreateInput,
	resourceUrl: AbsoluteHttpUrl,
	calendarData: string,
): Omit<CreatedCalendarEvent, 'etag'> {
	try {
		const resource = parseICalendarResource(Buffer.from(calendarData, 'utf8'));
		const event = mapCalendarEventResource({
			calendarUrl: input.calendarUrl,
			resourceUrl,
			resource,
		}).event;
		if (event.summary === undefined) {
			throw new CalDavCalendarEventCreateError(CalendarEventCreateFailureCode.NORMALIZATION_FAILED);
		}
		return Object.freeze({
			calendarUrl: event.calendarUrl,
			resourceUrl: event.resourceUrl,
			uid: event.uid,
			summary: event.summary,
			...(event.description === undefined ? {} : { description: event.description }),
			...(event.location === undefined ? {} : { location: event.location }),
			...(event.url === undefined ? {} : { url: event.url }),
			start: event.start,
			end: event.end,
		});
	} catch (error) {
		if (
			error instanceof CalDavCalendarEventCreateError &&
			error.code === CalendarEventCreateFailureCode.NORMALIZATION_FAILED
		) {
			throw error;
		}
		throw new CalDavCalendarEventCreateError(CalendarEventCreateFailureCode.NORMALIZATION_FAILED);
	}
}

function safeStatusCode(error: unknown): number | undefined {
	return error instanceof CalDavTransportError ? error.statusCode : undefined;
}

export async function createCalendarEvent(
	transport: CalDavTransport,
	input: CalendarEventCreateInput,
	clock: CalendarEventCreateClock,
): Promise<CreatedCalendarEvent> {
	const uid = resolveCalendarEventUid(input.uid);
	const resourceUrl = joinCalendarCollectionUrl(input.calendarUrl, resourceNameForUid(uid));
	const dtstamp = readClock(clock);
	const calendarData = serializeBasicUtcEvent({
		uid,
		dtstamp,
		start: input.start,
		end: input.end,
		summary: input.summary,
		...(input.description === undefined ? {} : { description: input.description }),
		...(input.location === undefined ? {} : { location: input.location }),
		...(input.url === undefined ? {} : { url: input.url }),
	});
	const normalized = normalizeCreatedEvent(input, resourceUrl, calendarData);
	const created = await createCalendarEventResource(
		transport,
		input.calendarUrl,
		resourceUrl,
		calendarData,
	);

	let canonicalResourceUrl = created.resourceUrl;
	let etag = created.etag;
	if (etag === undefined) {
		try {
			const metadata = await getCalendarEventMutationEtag(
				transport,
				input.calendarUrl,
				created.resourceUrl,
			);
			canonicalResourceUrl = metadata.resourceUrl;
			etag = metadata.etag;
		} catch (error) {
			throw new CalDavCalendarEventCreateError(
				CalendarEventCreateFailureCode.ETAG_RETRIEVAL_FAILED,
				safeStatusCode(error),
			);
		}
	}

	return Object.freeze({
		calendarUrl: normalized.calendarUrl,
		resourceUrl: canonicalResourceUrl,
		etag,
		uid: normalized.uid,
		summary: normalized.summary,
		...(normalized.description === undefined ? {} : { description: normalized.description }),
		...(normalized.location === undefined ? {} : { location: normalized.location }),
		...(normalized.url === undefined ? {} : { url: normalized.url }),
		start: normalized.start,
		end: normalized.end,
	});
}
