/* eslint-disable @n8n/community-nodes/require-node-api-error -- The accepted application-service contract exposes sanitized domain failures outside the n8n UI boundary. */

import {
	CalDavCalendarEventResourceGetError,
	CalendarEventResourceGetFailureCode,
	getCalendarEventByResourceUrl,
} from './getByResourceUrl';
import {
	CalDavCalendarEventMutationError,
	CalendarEventMutationFailureCode,
	updateCalendarEventResource,
} from './mutations';
import {
	CalDavCalendarEventUidResolutionError,
	CalendarEventUidResolutionFailureCode,
	resolveCalendarEventByUid,
} from './resolveByUid';
import type { CalendarEvent } from '../icalendar/eventReadModel';
import type {
	ICalendarComponent,
	ICalendarEntry,
	ICalendarParameter,
	ICalendarProperty,
	ICalendarResource,
	ICalendarValue,
} from '../icalendar/parser';
import {
	applyCalendarEventPatch,
	CalDavCalendarEventPatchError,
	CalendarEventPatchErrorCode,
} from '../icalendar/patcher';
import type { CalendarEventPatch } from '../icalendar/patcher';
import { serializeICalendarResource } from '../icalendar/serializer';
import { CalDavTransportError, CalDavTransportErrorCode } from '../transport/http';
import type { CalDavTransport } from '../transport/http';
import { normalizeCalendarCollectionUrl, validateAbsoluteHttpUrl } from '../transport/url';
import type { AbsoluteHttpUrl } from '../transport/url';

export type CalendarEventUpdateIdentifier =
	| { readonly kind: 'resourceUrl'; readonly resourceUrl: AbsoluteHttpUrl }
	| { readonly kind: 'uid'; readonly uid: string };

export interface CalendarEventUpdateInput {
	readonly calendarUrl: AbsoluteHttpUrl;
	readonly identifier: CalendarEventUpdateIdentifier;
	readonly patch: CalendarEventPatch;
	readonly etag?: string;
}

export type CalendarEventUpdateClock = () => Date;

export type UpdatedCalendarEvent = CalendarEvent & {
	readonly etag: string;
};

export const CalendarEventUpdateFailureCode = Object.freeze({
	INVALID_INPUT: 'INVALID_INPUT',
	INVALID_CLOCK: 'INVALID_CLOCK',
	CONFIRMATION_FAILED: 'CONFIRMATION_FAILED',
} as const);

export type CalendarEventUpdateFailureCode =
	(typeof CalendarEventUpdateFailureCode)[keyof typeof CalendarEventUpdateFailureCode];

const ERROR_MESSAGES: Readonly<Record<CalendarEventUpdateFailureCode, string>> = {
	INVALID_INPUT: 'The calendar event update input is invalid.',
	INVALID_CLOCK: 'The calendar event clock is invalid.',
	CONFIRMATION_FAILED: 'The event was updated, but its current state could not be verified.',
};

export class CalDavCalendarEventUpdateError extends Error {
	readonly code: CalendarEventUpdateFailureCode;
	readonly statusCode?: number;

	constructor(code: CalendarEventUpdateFailureCode, statusCode?: number) {
		super(ERROR_MESSAGES[code]);
		this.name = 'CalDavCalendarEventUpdateError';
		this.code = code;
		if (
			code === CalendarEventUpdateFailureCode.CONFIRMATION_FAILED &&
			Number.isInteger(statusCode) &&
			(statusCode as number) >= 100 &&
			(statusCode as number) <= 599
		) {
			this.statusCode = statusCode;
		}
	}
}

function invalidInput(): never {
	throw new CalDavCalendarEventUpdateError(CalendarEventUpdateFailureCode.INVALID_INPUT);
}

function snapshotInput(input: CalendarEventUpdateInput): CalendarEventUpdateInput {
	try {
		if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalidInput();
		const calendarUrl = input.calendarUrl;
		const identifier = input.identifier;
		const patch = input.patch;
		const etag = input.etag;
		if (
			typeof calendarUrl !== 'string' ||
			typeof identifier !== 'object' ||
			identifier === null ||
			Array.isArray(identifier) ||
			typeof patch !== 'object' ||
			patch === null ||
			Array.isArray(patch) ||
			(etag !== undefined && typeof etag !== 'string')
		) {
			return invalidInput();
		}
		if (Reflect.ownKeys(patch).length === 0) {
			throw new CalDavCalendarEventPatchError(CalendarEventPatchErrorCode.NO_CHANGES);
		}
		if (identifier.kind === 'resourceUrl') {
			if (typeof identifier.resourceUrl !== 'string') return invalidInput();
			return {
				calendarUrl,
				identifier: { kind: 'resourceUrl', resourceUrl: identifier.resourceUrl },
				patch,
				...(etag === undefined ? {} : { etag }),
			};
		}
		if (identifier.kind === 'uid') {
			if (typeof identifier.uid !== 'string') return invalidInput();
			return {
				calendarUrl,
				identifier: { kind: 'uid', uid: identifier.uid },
				patch,
				...(etag === undefined ? {} : { etag }),
			};
		}
		return invalidInput();
	} catch (error) {
		if (error instanceof CalDavCalendarEventPatchError) throw error;
		return invalidInput();
	}
}

function isDirectCalendarChild(
	calendarUrl: AbsoluteHttpUrl,
	resourceUrl: AbsoluteHttpUrl,
): boolean {
	try {
		const calendar = new URL(normalizeCalendarCollectionUrl(calendarUrl));
		const resource = new URL(validateAbsoluteHttpUrl(resourceUrl));
		if (calendar.origin !== resource.origin || !resource.pathname.startsWith(calendar.pathname)) {
			return false;
		}
		const child = resource.pathname.slice(calendar.pathname.length);
		return child.length > 0 && !child.endsWith('/') && !child.includes('/');
	} catch {
		return false;
	}
}

function assertSnapshotResourceUrl(
	identifier: CalendarEventUpdateIdentifier,
	selectedCalendarUrl: AbsoluteHttpUrl,
	snapshotCalendarUrl: AbsoluteHttpUrl,
	resourceUrl: AbsoluteHttpUrl,
	uid: string,
): void {
	let selected: AbsoluteHttpUrl | undefined;
	let snapshot: AbsoluteHttpUrl | undefined;
	try {
		selected = normalizeCalendarCollectionUrl(selectedCalendarUrl);
		snapshot = normalizeCalendarCollectionUrl(snapshotCalendarUrl);
	} catch {
		// The resolver-specific invalid-response type below remains authoritative.
	}
	if (
		selected !== undefined &&
		selected === snapshot &&
		isDirectCalendarChild(selected, resourceUrl) &&
		(identifier.kind !== 'uid' || identifier.uid === uid)
	) {
		return;
	}
	if (identifier.kind === 'resourceUrl') {
		throw new CalDavCalendarEventResourceGetError(
			CalendarEventResourceGetFailureCode.INVALID_RESPONSE,
		);
	}
	throw new CalDavCalendarEventUidResolutionError(
		CalendarEventUidResolutionFailureCode.INVALID_RESPONSE,
	);
}

function updateClockValue(clock: CalendarEventUpdateClock): Date {
	try {
		const value = clock();
		if (!(value instanceof Date)) return new Date(Number.NaN);
		const timestamp = Date.prototype.getTime.call(value);
		if (!Number.isFinite(timestamp)) return new Date(Number.NaN);
		const copy = new Date(Math.floor(timestamp / 1000) * 1000);
		const year = copy.getUTCFullYear();
		return year >= 1 && year <= 9999 ? copy : new Date(Number.NaN);
	} catch {
		return new Date(Number.NaN);
	}
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameParameterValue(
	left: ICalendarParameter['values'][number],
	right: ICalendarParameter['values'][number],
): boolean {
	return left.kind === right.kind && left.value === right.value;
}

function sameParameter(left: ICalendarParameter, right: ICalendarParameter): boolean {
	return (
		left.kind === right.kind &&
		left.name === right.name &&
		left.values.length === right.values.length &&
		left.values.every((value, index) => sameParameterValue(value, right.values[index]!))
	);
}

function sameValue(left: ICalendarValue, right: ICalendarValue): boolean {
	if (left.kind !== right.kind || left.valueType !== right.valueType) return false;
	if (left.textValues === null || right.textValues === null) {
		return left.textValues === null && right.textValues === null && left.raw === right.raw;
	}
	return sameStrings(left.textValues, right.textValues);
}

function sameProperty(left: ICalendarProperty, right: ICalendarProperty): boolean {
	return (
		left.kind === right.kind &&
		left.name === right.name &&
		left.parameters.length === right.parameters.length &&
		left.parameters.every((parameter, index) =>
			sameParameter(parameter, right.parameters[index]!),
		) &&
		sameValue(left.value, right.value)
	);
}

function sameEntry(left: ICalendarEntry, right: ICalendarEntry): boolean {
	if (left.kind !== right.kind) return false;
	return left.kind === 'property'
		? sameProperty(left, right as ICalendarProperty)
		: sameComponent(left, right as ICalendarComponent);
}

function sameComponent(left: ICalendarComponent, right: ICalendarComponent): boolean {
	return (
		left.kind === right.kind &&
		left.name === right.name &&
		left.entries.length === right.entries.length &&
		left.entries.every((entry, index) => sameEntry(entry, right.entries[index]!))
	);
}

function semanticallyEquivalent(left: ICalendarResource, right: ICalendarResource): boolean {
	return left.kind === right.kind && sameComponent(left.calendar, right.calendar);
}

function safeStatusCode(error: unknown): number | undefined {
	return error instanceof CalDavTransportError ? error.statusCode : undefined;
}

function confirmationFailed(error?: unknown): never {
	throw new CalDavCalendarEventUpdateError(
		CalendarEventUpdateFailureCode.CONFIRMATION_FAILED,
		safeStatusCode(error),
	);
}

function isPostPutMetadataFailure(error: unknown): boolean {
	if (error instanceof CalDavCalendarEventMutationError) {
		return (
			error.code === CalendarEventMutationFailureCode.OUTSIDE_CALENDAR ||
			error.code === CalendarEventMutationFailureCode.INVALID_LOCATION ||
			error.code === CalendarEventMutationFailureCode.INVALID_RESPONSE
		);
	}
	return (
		error instanceof CalDavTransportError &&
		(error.statusCode === 200 ||
			error.statusCode === 204 ||
			error.code === CalDavTransportErrorCode.RESPONSE_LIMIT_EXCEEDED)
	);
}

export async function updateCalendarEvent(
	transport: CalDavTransport,
	input: CalendarEventUpdateInput,
	clock: CalendarEventUpdateClock,
): Promise<UpdatedCalendarEvent> {
	const snapshot = snapshotInput(input);
	const current =
		snapshot.identifier.kind === 'resourceUrl'
			? await getCalendarEventByResourceUrl(
					transport,
					snapshot.calendarUrl,
					snapshot.identifier.resourceUrl,
					{ allowMissingEtag: true },
				)
			: await resolveCalendarEventByUid(transport, snapshot.calendarUrl, snapshot.identifier.uid, {
					allowMissingEtag: true,
				});
	assertSnapshotResourceUrl(
		snapshot.identifier,
		snapshot.calendarUrl,
		current.event.calendarUrl,
		current.event.resourceUrl,
		current.event.uid,
	);
	if (current.event.accessMode === 'readOnly') {
		throw new Error(
			'The calendar event is read-only because its time representation is unsupported.',
		);
	}

	const etag =
		snapshot.etag !== undefined && snapshot.etag.length > 0 ? snapshot.etag : current.event.etag;
	if (etag === undefined) {
		throw new CalDavCalendarEventMutationError(CalendarEventMutationFailureCode.MISSING_ETAG);
	}

	const modifiedAt = updateClockValue(clock);
	let patchedResource: ICalendarResource;
	try {
		patchedResource = applyCalendarEventPatch(current.context, snapshot.patch, modifiedAt);
	} catch (error) {
		if (
			error instanceof CalDavCalendarEventPatchError &&
			error.code === CalendarEventPatchErrorCode.INVALID_DATE &&
			error.field === undefined
		) {
			throw new CalDavCalendarEventUpdateError(CalendarEventUpdateFailureCode.INVALID_CLOCK);
		}
		throw error;
	}
	const calendarData = serializeICalendarResource(patchedResource);

	let updatedResourceUrl: AbsoluteHttpUrl;
	try {
		const mutation = await updateCalendarEventResource(
			transport,
			current.event.calendarUrl,
			current.event.resourceUrl,
			calendarData,
			etag,
		);
		updatedResourceUrl = mutation.resourceUrl;
	} catch (error) {
		if (isPostPutMetadataFailure(error)) return confirmationFailed(error);
		throw error;
	}

	try {
		const confirmed = await getCalendarEventByResourceUrl(
			transport,
			current.event.calendarUrl,
			updatedResourceUrl,
		);
		if (
			confirmed.event.etag === undefined ||
			normalizeCalendarCollectionUrl(confirmed.event.calendarUrl) !==
				normalizeCalendarCollectionUrl(current.event.calendarUrl) ||
			!isDirectCalendarChild(current.event.calendarUrl, confirmed.event.resourceUrl) ||
			confirmed.event.uid !== current.event.uid ||
			(confirmed.event.accessMode === 'editable' &&
				!semanticallyEquivalent(patchedResource, confirmed.context.resource))
		) {
			return confirmationFailed();
		}

		return Object.freeze({ ...confirmed.event, etag: confirmed.event.etag });
	} catch (error) {
		if (error instanceof CalDavCalendarEventUpdateError) throw error;
		return confirmationFailed(error);
	}
}
