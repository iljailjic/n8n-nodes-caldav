/* eslint-disable @n8n/community-nodes/require-node-api-error -- This domain service is mapped to NodeOperationError at the node boundary. */

import type {
	CalendarEventTimeZoneExecutionContext,
	CalendarEventTimeZoneReference,
} from '../discovery/timeZoneReferences';
import { parseICalendarResource } from '../icalendar/parser';
import type { ICalendarComponent } from '../icalendar/parser';
import {
	assertVTimeZoneCovers,
	assertVTimeZoneReadableForInterval,
	CalDavIanaTimeZoneError,
	canonicalizeIanaTimeZone,
	generateFiniteVTimeZone,
} from '../icalendar/timeZones';
import type { FiniteTimeZoneCoverage, IanaTimeZoneId } from '../icalendar/timeZones';
import type { AbsoluteHttpUrl } from '../transport/url';

export const CalendarEventTimeZoneAuthoringErrorCode = Object.freeze({
	COUNT_REQUIRES_REFERENCE: 'COUNT_REQUIRES_REFERENCE',
	UNBOUNDED_REQUIRES_REFERENCE: 'UNBOUNDED_REQUIRES_REFERENCE',
	UNREPRESENTABLE_TIME_ZONE: 'UNREPRESENTABLE_TIME_ZONE',
	UNSUPPORTED_AUTHORING_TIME_ZONE: 'UNSUPPORTED_AUTHORING_TIME_ZONE',
} as const);

export type CalendarEventTimeZoneAuthoringErrorCode =
	(typeof CalendarEventTimeZoneAuthoringErrorCode)[keyof typeof CalendarEventTimeZoneAuthoringErrorCode];

export const UNSUPPORTED_AUTHORING_TIME_ZONE_MESSAGE =
	'The selected IANA time zone is not supported for structured event authoring.';

const ERROR_MESSAGES: Readonly<Record<CalendarEventTimeZoneAuthoringErrorCode, string>> = {
	COUNT_REQUIRES_REFERENCE:
		'A Count-bounded IANA recurrence requires server time-zone reference support.',
	UNBOUNDED_REQUIRES_REFERENCE:
		'An unbounded IANA recurrence requires server time-zone reference support.',
	UNREPRESENTABLE_TIME_ZONE:
		'The selected IANA time zone cannot be represented safely for this calendar event.',
	UNSUPPORTED_AUTHORING_TIME_ZONE: UNSUPPORTED_AUTHORING_TIME_ZONE_MESSAGE,
};

export class CalDavCalendarEventTimeZoneAuthoringError extends Error {
	readonly code: CalendarEventTimeZoneAuthoringErrorCode;

	constructor(code: CalendarEventTimeZoneAuthoringErrorCode) {
		super(ERROR_MESSAGES[code]);
		this.name = 'CalDavAuthoringError';
		this.code = code;
	}
}

export function isUnsupportedCalendarEventAuthoringTimeZone(timeZone: IanaTimeZoneId): boolean {
	return (
		timeZone === 'Australia/Lord_Howe' ||
		timeZone === 'Pacific/Apia' ||
		timeZone === 'Africa/Casablanca'
	);
}

export function assertSupportedCalendarEventAuthoringTimeZone(timeZone: IanaTimeZoneId): void {
	let canonical: IanaTimeZoneId;
	try {
		canonical = canonicalizeIanaTimeZone(timeZone);
	} catch (error) {
		if (error instanceof CalDavIanaTimeZoneError) return;
		throw error;
	}
	if (isUnsupportedCalendarEventAuthoringTimeZone(canonical)) {
		throw new CalDavCalendarEventTimeZoneAuthoringError('UNSUPPORTED_AUTHORING_TIME_ZONE');
	}
}

export type CalendarEventTimeZoneAuthoringCoverage =
	| { readonly kind: 'finite'; readonly interval: FiniteTimeZoneCoverage }
	| { readonly kind: 'count' }
	| { readonly kind: 'unbounded' };

export interface CalendarEventTimeZoneAuthoringInput {
	readonly calendarUrl: AbsoluteHttpUrl;
	readonly timeZone: IanaTimeZoneId;
	readonly coverage: CalendarEventTimeZoneAuthoringCoverage;
	readonly referenceContext?: CalendarEventTimeZoneExecutionContext;
}

export type CalendarEventTimeZoneAuthoringRules =
	| {
			readonly source: 'reference';
			readonly embed: false;
			readonly definition: ICalendarComponent;
	  }
	| {
			readonly source: 'generated';
			readonly embed: true;
			readonly definition: ICalendarComponent;
	  };

interface InternalCalendarEventTimeZoneAuthoringInput extends CalendarEventTimeZoneAuthoringInput {
	readonly reusableDefinition?: ICalendarComponent;
}

const encoder = new TextEncoder();

function referenceDefinition(
	reference: CalendarEventTimeZoneReference,
	timeZone: IanaTimeZoneId,
): ICalendarComponent {
	if (
		reference === null ||
		typeof reference !== 'object' ||
		reference.ruleSource !== 'vtimezone' ||
		canonicalizeIanaTimeZone(reference.timeZone) !== timeZone ||
		typeof reference.calendarData !== 'string'
	) {
		throw new Error('Invalid time-zone reference.');
	}
	const resource = parseICalendarResource(encoder.encode(reference.calendarData));
	const definitions = resource.calendar.entries.filter(
		(entry): entry is ICalendarComponent =>
			entry.kind === 'component' && entry.name.toUpperCase() === 'VTIMEZONE',
	);
	if (definitions.length !== 1) throw new Error('Invalid time-zone reference.');
	return definitions[0]!;
}

export async function resolveVerifiedCalendarEventTimeZoneDefinition(
	context: CalendarEventTimeZoneExecutionContext | undefined,
	calendarUrl: AbsoluteHttpUrl,
	timeZone: IanaTimeZoneId,
): Promise<ICalendarComponent | undefined> {
	if (context === undefined) return undefined;
	try {
		return referenceDefinition(await context.resolveReference(calendarUrl, timeZone), timeZone);
	} catch {
		return undefined;
	}
}

async function verifiedReference(
	input: CalendarEventTimeZoneAuthoringInput,
): Promise<CalendarEventTimeZoneAuthoringRules | undefined> {
	if (input.referenceContext === undefined) return undefined;
	try {
		const definition = await resolveVerifiedCalendarEventTimeZoneDefinition(
			input.referenceContext,
			input.calendarUrl,
			input.timeZone,
		);
		if (definition === undefined) return undefined;
		if (input.coverage.kind === 'finite') {
			assertVTimeZoneCovers(definition, input.timeZone, input.coverage.interval);
			assertVTimeZoneReadableForInterval(definition, input.timeZone, input.coverage.interval);
		}
		return Object.freeze({ source: 'reference', embed: false, definition });
	} catch {
		return undefined;
	}
}

export function resolveCalendarEventTimeZoneAuthoring(
	input: CalendarEventTimeZoneAuthoringInput,
): Promise<CalendarEventTimeZoneAuthoringRules>;
export async function resolveCalendarEventTimeZoneAuthoring(
	input: InternalCalendarEventTimeZoneAuthoringInput,
): Promise<CalendarEventTimeZoneAuthoringRules> {
	assertSupportedCalendarEventAuthoringTimeZone(input.timeZone);
	const reference = await verifiedReference(input);
	if (reference !== undefined) return reference;
	if (input.coverage.kind === 'unbounded') {
		throw new CalDavCalendarEventTimeZoneAuthoringError('UNBOUNDED_REQUIRES_REFERENCE');
	}
	if (input.coverage.kind === 'count') {
		throw new CalDavCalendarEventTimeZoneAuthoringError('COUNT_REQUIRES_REFERENCE');
	}
	try {
		if (input.reusableDefinition !== undefined) {
			assertVTimeZoneCovers(input.reusableDefinition, input.timeZone, input.coverage.interval);
			assertVTimeZoneReadableForInterval(
				input.reusableDefinition,
				input.timeZone,
				input.coverage.interval,
			);
			return Object.freeze({
				source: 'generated',
				embed: true,
				definition: input.reusableDefinition,
			});
		}
		return Object.freeze({
			source: 'generated',
			embed: true,
			definition: generateFiniteVTimeZone(input.timeZone, input.coverage.interval),
		});
	} catch {
		throw new CalDavCalendarEventTimeZoneAuthoringError('UNREPRESENTABLE_TIME_ZONE');
	}
}
