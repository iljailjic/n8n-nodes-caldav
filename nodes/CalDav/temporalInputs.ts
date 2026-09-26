/* eslint-disable @n8n/community-nodes/require-node-api-error -- Pure structured-input errors are mapped to item-aware n8n errors at the node boundary. */

import {
	CalDavStructuredLocalTimeError,
	projectInstantInTimeZone,
	resolveStructuredLocalDateTimeInTimeZone,
} from './icalendar/timeZones';
import type { ICalendarComponent } from './icalendar/parser';
import type { IanaTimeZoneId } from './icalendar/timeZones';

export class CalDavTemporalInputError extends Error {
	constructor(field: string, correction: string) {
		super(`${field} ${correction}`);
		this.name = 'CalDavTemporalInputError';
	}
}

export type StructuredTimedInput =
	| { readonly kind: 'instant'; readonly instant: Date }
	| { readonly kind: 'local'; readonly local: string };

const ISO =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([zZ])|([+-])(\d{2}):(\d{2}))?$/;

function validYear(instant: Date): boolean {
	return (
		Number.isFinite(instant.getTime()) &&
		instant.getUTCFullYear() >= 1 &&
		instant.getUTCFullYear() <= 9999
	);
}

function wholeSecond(instant: Date): Date | undefined {
	if (!validYear(instant)) return undefined;
	const result = new Date(Math.floor(instant.getTime() / 1000) * 1000);
	return validYear(result) ? result : undefined;
}

function nativeInstant(value: unknown): Date | undefined {
	try {
		return wholeSecond(new Date(Date.prototype.getTime.call(value)));
	} catch {
		return undefined;
	}
}

/** Validate components before any conversion; never invoke host-local date parsing. */
export function parseStructuredTimedInput(value: unknown): StructuredTimedInput | undefined {
	if (typeof value === 'string') {
		const match = ISO.exec(value);
		if (match === null) return undefined;
		const year = Number(match[1]);
		const month = Number(match[2]);
		const day = Number(match[3]);
		const hour = Number(match[4]);
		const minute = Number(match[5]);
		const second = Number(match[6]);
		const offsetHour = Number(match[10] ?? 0);
		const offsetMinute = Number(match[11] ?? 0);
		if (
			year < 1 ||
			month < 1 ||
			month > 12 ||
			day < 1 ||
			hour > 23 ||
			minute > 59 ||
			second > 59 ||
			offsetHour > 23 ||
			offsetMinute > 59
		)
			return undefined;
		const wall = new Date(0);
		wall.setUTCFullYear(year, month - 1, day);
		wall.setUTCHours(hour, minute, second, 0);
		if (
			wall.getUTCFullYear() !== year ||
			wall.getUTCMonth() !== month - 1 ||
			wall.getUTCDate() !== day
		)
			return undefined;
		if (match[8] === undefined && match[9] === undefined) {
			return { kind: 'local', local: value.slice(0, 19) };
		}
		// Offsets are whole minutes, so flooring any positive decimal fraction leaves this second.
		const offset = (match[9] === '-' ? -1 : 1) * (offsetHour * 60 + offsetMinute) * 60_000;
		const instant = wholeSecond(new Date(wall.getTime() - offset));
		return instant === undefined ? undefined : { kind: 'instant', instant };
	}
	const instant = nativeInstant(value);
	if (instant !== undefined) return { kind: 'instant', instant };
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
		)
			return undefined;
		const result = nativeInstant(dateTime.toJSDate.call(value));
		return result === undefined ? undefined : { kind: 'instant', instant: result };
	} catch {
		return undefined;
	}
}

export function normalizeStructuredTimedInput(
	value: unknown,
	zone: string = 'UTC',
	field: string = 'Date/time',
	definition?: ICalendarComponent,
): Date | undefined {
	const parsed = parseStructuredTimedInput(value);
	if (parsed === undefined) return undefined;
	// Validate the effective zone even when the caller supplies an absolute instant.
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: zone });
	} catch {
		throw new CalDavTemporalInputError(field, 'requires a valid effective time zone.');
	}
	if (parsed.kind === 'instant') {
		try {
			projectInstantInTimeZone(parsed.instant, zone as IanaTimeZoneId, definition);
			return parsed.instant;
		} catch {
			throw new CalDavTemporalInputError(
				field,
				'requires valid time-zone rules and a representable year.',
			);
		}
	}
	if (zone === 'UTC') {
		return normalizeStructuredTimedInput(`${parsed.local}Z`, 'UTC', field);
	}
	try {
		return wholeSecond(
			resolveStructuredLocalDateTimeInTimeZone(parsed.local, zone as IanaTimeZoneId, definition),
		);
	} catch (error) {
		if (error instanceof CalDavStructuredLocalTimeError) {
			throw new CalDavTemporalInputError(
				field,
				error.reason === 'gap'
					? 'is nonexistent in the effective time zone. Choose a valid local time.'
					: 'is ambiguous in the effective time zone. Supply an explicit instant or offset.',
			);
		}
		throw new CalDavTemporalInputError(
			field,
			'requires valid time-zone rules and a representable year.',
		);
	}
}
