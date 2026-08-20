/* eslint-disable @n8n/community-nodes/require-node-api-error -- The application service exposes sanitized domain failures outside the n8n UI boundary. */

import type { CalendarEventTimeZoneExecutionContext } from '../discovery/timeZoneReferences';
import type {
	CalendarDateString,
	CalendarEvent,
	CalendarEventStatus,
	CalendarEventTransparency,
} from '../icalendar/eventReadModel';
import type { CalendarEventPatch, OptionalFieldPatch } from '../icalendar/patcher';
import { isAbsoluteICalendarUri } from '../icalendar/uri';
import {
	CalDavIanaTimeZoneError,
	CalDavIanaTimeZoneErrorCode,
	canonicalizeIanaTimeZone,
	projectInstantInTimeZone,
	resolveLocalDateTimeInTimeZone,
} from '../icalendar/timeZones';
import type { CalendarEventTimeZone } from '../icalendar/timeZones';
import {
	CalDavAuthorizationError,
	CalDavNotFoundError,
	CalDavPreconditionFailedError,
} from '../transport/http';
import type { CalDavTransport } from '../transport/http';
import { normalizeCalendarCollectionUrl, validateAbsoluteHttpUrl } from '../transport/url';
import type { AbsoluteHttpUrl } from '../transport/url';
import { CalDavCalendarEventCreateError, CalendarEventCreateFailureCode } from './create';
import type { CalendarEventCreateClock, CalendarEventCreateInput } from './create';
import { prepareCalendarEventCreate } from './createPreparation';
import {
	CalDavCalendarEventMutationError,
	CalendarEventMutationFailureCode,
	createCalendarEventResource,
	getCalendarEventMutationEtag,
} from './mutations';
import {
	CalDavCalendarEventUidResolutionError,
	CalendarEventUidResolutionFailureCode,
	resolveCalendarEventByUid,
} from './resolveByUid';
import { calendarEventTimeZoneExecutionContext } from './timeZoneExecutionContext';
import type { CalendarEventUidGenerator } from './uid';
import {
	CalDavCalendarEventUpdateError,
	CalendarEventUpdateFailureCode,
	assertResolvedCalendarEventUidIdentity,
	updateResolvedCalendarEvent,
} from './update';

interface CalendarEventUpsertCommon {
	readonly calendarUrl: AbsoluteHttpUrl;
	readonly uid?: string;
	readonly summary: string;
	readonly description?: OptionalFieldPatch<string>;
	readonly location?: OptionalFieldPatch<string>;
	readonly url?: OptionalFieldPatch<string>;
	readonly categories?: OptionalFieldPatch<readonly string[]>;
	readonly status?: OptionalFieldPatch<CalendarEventStatus>;
	readonly transparency?: OptionalFieldPatch<CalendarEventTransparency>;
}

export type CalendarEventUpsertInput = CalendarEventUpsertCommon &
	(
		| {
				readonly timeMode: 'timed';
				readonly start: Date;
				readonly end: Date;
				readonly timeZone?: CalendarEventTimeZone;
		  }
		| {
				readonly timeMode: 'allDay';
				readonly startDate: CalendarDateString;
				readonly endDate: CalendarDateString;
		  }
	);

export interface CalendarEventUpsertDependencies {
	readonly clock: CalendarEventCreateClock;
	readonly uidFactory: CalendarEventUidGenerator;
}

export type UpsertedCalendarEvent = CalendarEvent & { readonly etag: string };

export interface CalendarEventUpsertResult {
	readonly action: 'create' | 'update';
	readonly event: UpsertedCalendarEvent;
}

export const CalendarEventUpsertFailureCode = Object.freeze({
	CONCURRENCY_CONFLICT: 'UPSERT_CONCURRENCY_CONFLICT',
} as const);

export type CalendarEventUpsertFailureCode =
	(typeof CalendarEventUpsertFailureCode)[keyof typeof CalendarEventUpsertFailureCode];

export class CalDavCalendarEventUpsertError extends Error {
	readonly code: CalendarEventUpsertFailureCode;

	constructor(code: CalendarEventUpsertFailureCode) {
		super('The calendar changed while Event Upsert was in progress.');
		this.name = 'CalDavCalendarEventUpsertError';
		this.code = code;
	}
}

const MESSAGES = {
	INVALID_CALENDAR_URL:
		'The Calendar URL is invalid. Enter an absolute HTTP(S) calendar collection URL.',
	INVALID_UID: 'UID must be a non-empty valid iCalendar text value.',
	INVALID_TIME_MODE: 'Time Mode must be Timed or All-Day.',
	INVALID_TIME_ZONE_MODE: 'Time Zone Mode must be UTC or IANA.',
	INVALID_TIME_ZONE: 'Time Zone must be a valid IANA time zone identifier.',
	UTC_TIME_ZONE: 'Time Zone resolves to UTC. Use UTC Time Zone Mode.',
	INVALID_START: 'Start must be a valid date and time with whole-second precision.',
	INVALID_END: 'End must be a valid date and time with whole-second precision.',
	INVALID_START_DATE: 'Start Date must be a valid calendar date.',
	INVALID_END_DATE: 'End Date must be a valid calendar date.',
	MIXED_TIME_FIELDS: 'The selected Time Mode cannot use fields from the other time mode.',
	INVALID_RANGE: 'End must be later than Start.',
	INVALID_SUMMARY: 'Summary must be a valid iCalendar text value.',
	INVALID_ADDITIONAL_FIELDS: 'Additional Fields must be an object.',
	INVALID_DESCRIPTION: 'Description must be a valid iCalendar text value.',
	INVALID_LOCATION: 'Location must be a valid iCalendar text value.',
	INVALID_URL: 'URL must be a valid absolute URI without a fragment.',
	INVALID_CATEGORIES: 'Categories must be a non-empty list of valid iCalendar text values.',
	INVALID_STATUS: 'Status must be Tentative, Confirmed, or Cancelled.',
	INVALID_TRANSPARENCY: 'Transparency must be Opaque or Transparent.',
	UNREPRESENTABLE_START:
		'Start cannot be represented unambiguously in the selected IANA time zone. Use UTC mode for this instant.',
	UNREPRESENTABLE_END:
		'End cannot be represented unambiguously in the selected IANA time zone. Use UTC mode for this instant.',
} as const;

class CalendarEventUpsertInputError extends Error {}

function invalid(message: string): never {
	throw new CalendarEventUpsertInputError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function validInstant(value: unknown): Date | undefined {
	if (!(value instanceof Date)) return undefined;
	try {
		const timestamp = Date.prototype.getTime.call(value);
		if (!Number.isFinite(timestamp) || timestamp % 1000 !== 0) return undefined;
		const result = new Date(timestamp);
		const year = result.getUTCFullYear();
		return year >= 1 && year <= 9999 ? result : undefined;
	} catch {
		return undefined;
	}
}

function isLeapYear(year: number): boolean {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function validCalendarDate(value: unknown): CalendarDateString | undefined {
	if (typeof value !== 'string') return undefined;
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (match === null) return undefined;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!
		? (value as CalendarDateString)
		: undefined;
}

function validAbsoluteUri(value: string): boolean {
	return isAbsoluteICalendarUri(value);
}

function optionalPatch(
	value: unknown,
	message: string,
	validate: (value: string) => boolean,
): OptionalFieldPatch<string> {
	if (!isRecord(value)) return invalid(message);
	const keys = Reflect.ownKeys(value);
	if (value.kind === 'remove' && keys.length === 1 && keys[0] === 'kind') {
		return Object.freeze({ kind: 'remove' });
	}
	if (
		value.kind === 'set' &&
		keys.length === 2 &&
		keys.includes('kind') &&
		keys.includes('value') &&
		typeof value.value === 'string' &&
		validate(value.value)
	) {
		return Object.freeze({ kind: 'set', value: value.value });
	}
	return invalid(message);
}

function categoryList(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	let descriptors: Readonly<Record<string, PropertyDescriptor>>;
	try {
		if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
		descriptors = Object.getOwnPropertyDescriptors(value);
	} catch {
		return undefined;
	}
	const expectedKeys = new Set(['length']);
	const categories: string[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < value.length; index += 1) {
		const key = String(index);
		expectedKeys.add(key);
		const descriptor = descriptors[key];
		if (
			descriptor === undefined ||
			!descriptor.enumerable ||
			!('value' in descriptor) ||
			typeof descriptor.value !== 'string' ||
			descriptor.value.length === 0 ||
			!isValidICalendarText(descriptor.value)
		) {
			return undefined;
		}
		if (!seen.has(descriptor.value)) {
			seen.add(descriptor.value);
			categories.push(descriptor.value);
		}
	}
	if (Object.keys(descriptors).some((key) => !expectedKeys.has(key))) return undefined;
	return Object.freeze(categories);
}

function categoriesPatch(value: unknown): OptionalFieldPatch<readonly string[]> {
	if (!isRecord(value)) return invalid(MESSAGES.INVALID_CATEGORIES);
	const keys = Reflect.ownKeys(value);
	if (value.kind === 'remove' && keys.length === 1 && keys[0] === 'kind') {
		return Object.freeze({ kind: 'remove' });
	}
	const categories = categoryList(value.value);
	if (
		value.kind === 'set' &&
		keys.length === 2 &&
		keys.includes('kind') &&
		keys.includes('value') &&
		categories !== undefined
	) {
		return Object.freeze({ kind: 'set', value: categories });
	}
	return invalid(MESSAGES.INVALID_CATEGORIES);
}

function enumPatch<T extends string>(
	value: unknown,
	supported: readonly T[],
	message: string,
): OptionalFieldPatch<T> {
	if (!isRecord(value)) return invalid(message);
	const keys = Reflect.ownKeys(value);
	if (value.kind === 'remove' && keys.length === 1 && keys[0] === 'kind') {
		return Object.freeze({ kind: 'remove' });
	}
	if (
		value.kind === 'set' &&
		keys.length === 2 &&
		keys.includes('kind') &&
		keys.includes('value') &&
		typeof value.value === 'string' &&
		supported.includes(value.value as T)
	) {
		return Object.freeze({ kind: 'set', value: value.value as T });
	}
	return invalid(message);
}

function snapshotInput(input: CalendarEventUpsertInput): CalendarEventUpsertInput {
	if (!isRecord(input)) return invalid(MESSAGES.INVALID_CALENDAR_URL);
	let calendarUrl: AbsoluteHttpUrl;
	try {
		if (typeof input.calendarUrl !== 'string') return invalid(MESSAGES.INVALID_CALENDAR_URL);
		calendarUrl = normalizeCalendarCollectionUrl(validateAbsoluteHttpUrl(input.calendarUrl));
	} catch {
		return invalid(MESSAGES.INVALID_CALENDAR_URL);
	}

	const uid = input.uid;
	if (
		uid !== undefined &&
		(typeof uid !== 'string' || uid.length === 0 || !isValidICalendarText(uid))
	) {
		return invalid(MESSAGES.INVALID_UID);
	}
	if (input.timeMode !== 'timed' && input.timeMode !== 'allDay') {
		return invalid(MESSAGES.INVALID_TIME_MODE);
	}

	let time:
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
	if (input.timeMode === 'timed') {
		if ('startDate' in input || 'endDate' in input) return invalid(MESSAGES.MIXED_TIME_FIELDS);
		const zone = input.timeZone ?? { timeZoneMode: 'utc' as const };
		let timeZone: CalendarEventTimeZone;
		if (!isRecord(zone) || (zone.timeZoneMode !== 'utc' && zone.timeZoneMode !== 'iana')) {
			return invalid(MESSAGES.INVALID_TIME_ZONE_MODE);
		}
		if (zone.timeZoneMode === 'utc') {
			if (Reflect.ownKeys(zone).some((key) => key !== 'timeZoneMode')) {
				return invalid(MESSAGES.INVALID_TIME_ZONE_MODE);
			}
			timeZone = { timeZoneMode: 'utc' };
		} else {
			if (typeof zone.timeZone !== 'string') return invalid(MESSAGES.INVALID_TIME_ZONE);
			const keys = Reflect.ownKeys(zone);
			if (keys.length !== 2 || !keys.includes('timeZoneMode') || !keys.includes('timeZone')) {
				return invalid(MESSAGES.INVALID_TIME_ZONE);
			}
			try {
				timeZone = {
					timeZoneMode: 'iana',
					timeZone: canonicalizeIanaTimeZone(zone.timeZone),
				};
			} catch (error) {
				return invalid(
					error instanceof CalDavIanaTimeZoneError &&
						error.code === CalDavIanaTimeZoneErrorCode.UTC_EQUIVALENT
						? MESSAGES.UTC_TIME_ZONE
						: MESSAGES.INVALID_TIME_ZONE,
				);
			}
		}
		const start = validInstant(input.start);
		if (start === undefined) return invalid(MESSAGES.INVALID_START);
		const end = validInstant(input.end);
		if (end === undefined) return invalid(MESSAGES.INVALID_END);
		time = { timeMode: 'timed', start, end, timeZone };
	} else {
		if ('start' in input || 'end' in input || 'timeZone' in input) {
			return invalid(MESSAGES.MIXED_TIME_FIELDS);
		}
		const startDate = validCalendarDate(input.startDate);
		if (startDate === undefined) return invalid(MESSAGES.INVALID_START_DATE);
		const endDate = validCalendarDate(input.endDate);
		if (endDate === undefined) return invalid(MESSAGES.INVALID_END_DATE);
		time = { timeMode: 'allDay', startDate, endDate };
	}

	if (typeof input.summary !== 'string' || !isValidICalendarText(input.summary)) {
		return invalid(MESSAGES.INVALID_SUMMARY);
	}
	const allowed = new Set([
		'calendarUrl',
		'uid',
		'timeMode',
		'summary',
		'description',
		'location',
		'url',
		'categories',
		'status',
		'transparency',
		...(input.timeMode === 'timed' ? ['start', 'end', 'timeZone'] : ['startDate', 'endDate']),
	]);
	if (Reflect.ownKeys(input).some((key) => typeof key !== 'string' || !allowed.has(key))) {
		return invalid(MESSAGES.INVALID_ADDITIONAL_FIELDS);
	}
	const description =
		input.description === undefined
			? undefined
			: optionalPatch(input.description, MESSAGES.INVALID_DESCRIPTION, isValidICalendarText);
	const location =
		input.location === undefined
			? undefined
			: optionalPatch(input.location, MESSAGES.INVALID_LOCATION, isValidICalendarText);
	const url =
		input.url === undefined
			? undefined
			: optionalPatch(input.url, MESSAGES.INVALID_URL, validAbsoluteUri);
	const categories = input.categories === undefined ? undefined : categoriesPatch(input.categories);
	const status =
		input.status === undefined
			? undefined
			: enumPatch(
					input.status,
					['tentative', 'confirmed', 'cancelled'] as const,
					MESSAGES.INVALID_STATUS,
				);
	const transparency =
		input.transparency === undefined
			? undefined
			: enumPatch(
					input.transparency,
					['opaque', 'transparent'] as const,
					MESSAGES.INVALID_TRANSPARENCY,
				);
	if (time.timeMode === 'timed') {
		if (time.end.getTime() <= time.start.getTime()) return invalid(MESSAGES.INVALID_RANGE);
		if (time.timeZone.timeZoneMode === 'iana') {
			if (
				resolveLocalDateTimeInTimeZone(
					projectInstantInTimeZone(time.start, time.timeZone.timeZone),
					time.timeZone.timeZone,
				).getTime() !== time.start.getTime()
			) {
				return invalid(MESSAGES.UNREPRESENTABLE_START);
			}
			if (
				resolveLocalDateTimeInTimeZone(
					projectInstantInTimeZone(time.end, time.timeZone.timeZone),
					time.timeZone.timeZone,
				).getTime() !== time.end.getTime()
			) {
				return invalid(MESSAGES.UNREPRESENTABLE_END);
			}
		}
	} else if (time.endDate <= time.startDate) {
		return invalid(MESSAGES.INVALID_RANGE);
	}
	return Object.freeze({
		calendarUrl,
		...(uid === undefined ? {} : { uid }),
		...time,
		summary: input.summary,
		...(description === undefined ? {} : { description }),
		...(location === undefined ? {} : { location }),
		...(url === undefined ? {} : { url }),
		...(categories === undefined ? {} : { categories }),
		...(status === undefined ? {} : { status }),
		...(transparency === undefined ? {} : { transparency }),
	}) as CalendarEventUpsertInput;
}

function generatedUid(factory: CalendarEventUidGenerator): string {
	try {
		const value = factory();
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
			throw new Error('invalid generated UID');
		}
		return value;
	} catch {
		throw new Error('Event Upsert failed.');
	}
}

function createInput(
	input: CalendarEventUpsertInput,
	uid: string | undefined,
): CalendarEventCreateInput {
	const optional = (patch: OptionalFieldPatch<string> | undefined): string | undefined =>
		patch?.kind === 'set' ? patch.value : undefined;
	return Object.freeze({
		calendarUrl: input.calendarUrl,
		...(uid === undefined ? {} : { uid }),
		...(input.timeMode === 'timed'
			? {
					timeMode: 'timed' as const,
					start: input.start,
					end: input.end,
					timeZone: input.timeZone ?? { timeZoneMode: 'utc' as const },
				}
			: {
					timeMode: 'allDay' as const,
					startDate: input.startDate,
					endDate: input.endDate,
				}),
		summary: input.summary,
		...(optional(input.description) === undefined
			? {}
			: { description: optional(input.description) }),
		...(optional(input.location) === undefined ? {} : { location: optional(input.location) }),
		...(optional(input.url) === undefined ? {} : { url: optional(input.url) }),
		...(input.categories?.kind === 'set' ? { categories: input.categories.value } : {}),
		...(input.status?.kind === 'set' ? { status: input.status.value } : {}),
		...(input.transparency?.kind === 'set' ? { transparency: input.transparency.value } : {}),
	}) as CalendarEventCreateInput;
}

function updatePatch(input: CalendarEventUpsertInput): CalendarEventPatch {
	return Object.freeze({
		...(input.timeMode === 'timed'
			? {
					timeMode: 'timed' as const,
					start: { kind: 'set' as const, value: input.start },
					end: { kind: 'set' as const, value: input.end },
					timeZone: {
						kind: 'set' as const,
						value: input.timeZone ?? { timeZoneMode: 'utc' as const },
					},
				}
			: {
					timeMode: 'allDay' as const,
					startDate: { kind: 'set' as const, value: input.startDate },
					endDate: { kind: 'set' as const, value: input.endDate },
				}),
		summary: { kind: 'set' as const, value: input.summary },
		...(input.description === undefined ? {} : { description: input.description }),
		...(input.location === undefined ? {} : { location: input.location }),
		...(input.url === undefined ? {} : { url: input.url }),
		...(input.categories === undefined ? {} : { categories: input.categories }),
		...(input.status === undefined ? {} : { status: input.status }),
		...(input.transparency === undefined ? {} : { transparency: input.transparency }),
	}) as CalendarEventPatch;
}

function conflict(): never {
	throw new CalDavCalendarEventUpsertError(CalendarEventUpsertFailureCode.CONCURRENCY_CONFLICT);
}

function statusCode(error: unknown): number | undefined {
	try {
		return typeof error === 'object' &&
			error !== null &&
			'statusCode' in error &&
			Number.isInteger(error.statusCode)
			? (error.statusCode as number)
			: undefined;
	} catch {
		return undefined;
	}
}

function mapConflict(error: unknown, update: boolean): never {
	if (
		error instanceof CalDavCalendarEventUpsertError ||
		error instanceof CalDavPreconditionFailedError ||
		(error instanceof CalDavAuthorizationError && error.noUidConflict) ||
		(error instanceof CalDavCalendarEventMutationError &&
			(error.code === CalendarEventMutationFailureCode.CREATE_CONFLICT ||
				error.code === CalendarEventMutationFailureCode.CONCURRENCY_CONFLICT)) ||
		(update && error instanceof CalDavNotFoundError)
	) {
		return conflict();
	}
	throw error;
}

async function createBranch(
	transport: CalDavTransport,
	input: CalendarEventUpsertInput,
	uid: string | undefined,
	clock: CalendarEventCreateClock,
	uidFactory: CalendarEventUidGenerator,
	timeZoneContext?: CalendarEventTimeZoneExecutionContext,
): Promise<CalendarEventUpsertResult> {
	const prepared = await prepareCalendarEventCreate(
		createInput(input, uid),
		clock,
		timeZoneContext,
		() => generatedUid(uidFactory),
	);
	let mutation;
	try {
		mutation = await createCalendarEventResource(
			transport,
			input.calendarUrl,
			prepared.resourceUrl,
			prepared.calendarData,
		);
	} catch (error) {
		return mapConflict(error, false);
	}

	let resourceUrl = mutation.resourceUrl;
	let etag = mutation.etag;
	if (etag === undefined) {
		try {
			const metadata = await getCalendarEventMutationEtag(
				transport,
				input.calendarUrl,
				resourceUrl,
			);
			resourceUrl = metadata.resourceUrl;
			etag = metadata.etag;
		} catch (error) {
			throw new CalDavCalendarEventCreateError(
				CalendarEventCreateFailureCode.ETAG_RETRIEVAL_FAILED,
				statusCode(error),
			);
		}
	}
	const event = Object.freeze({ ...prepared.event, resourceUrl, etag });
	return Object.freeze({ action: 'create', event });
}

export async function upsertCalendarEvent(
	transport: CalDavTransport,
	input: CalendarEventUpsertInput,
	dependencies: CalendarEventUpsertDependencies,
): Promise<CalendarEventUpsertResult> {
	const snapshot = snapshotInput(input);
	const timeZoneContext = calendarEventTimeZoneExecutionContext(transport);
	const suppliedUid = snapshot.uid;
	if (suppliedUid === undefined) {
		return await createBranch(
			transport,
			snapshot,
			undefined,
			dependencies.clock,
			dependencies.uidFactory,
			timeZoneContext,
		);
	}

	let current;
	try {
		current = await resolveCalendarEventByUid(transport, snapshot.calendarUrl, suppliedUid, {
			allowMissingEtag: true,
			...(timeZoneContext === undefined ? {} : { timeZoneContext }),
		});
	} catch (error) {
		if (
			error instanceof CalDavCalendarEventUidResolutionError &&
			error.code === CalendarEventUidResolutionFailureCode.NOT_FOUND
		) {
			return await createBranch(
				transport,
				snapshot,
				suppliedUid,
				dependencies.clock,
				dependencies.uidFactory,
				timeZoneContext,
			);
		}
		throw error;
	}

	assertResolvedCalendarEventUidIdentity(snapshot.calendarUrl, suppliedUid, current);
	if (current.event.accessMode === 'readOnly') {
		throw new CalDavCalendarEventUpdateError(CalendarEventUpdateFailureCode.READ_ONLY);
	}
	if (current.event.etag === undefined) {
		throw new CalDavCalendarEventMutationError(CalendarEventMutationFailureCode.MISSING_ETAG);
	}
	try {
		const result = await updateResolvedCalendarEvent(
			transport,
			{
				calendarUrl: snapshot.calendarUrl,
				current,
				patch: updatePatch(snapshot),
				etag: current.event.etag,
			},
			dependencies.clock,
			timeZoneContext,
		);
		return Object.freeze({ action: 'update', event: result.event });
	} catch (error) {
		return mapConflict(error, true);
	}
}
