/* eslint-disable @n8n/community-nodes/require-node-api-error -- This domain service is mapped to NodeOperationError at the node boundary. */

import type {
	CalendarEventTimeZoneExecutionContext,
	CalendarEventTimeZoneReference,
} from '../discovery/timeZoneReferences';
import { parseICalendarResource } from '../icalendar/parser';
import type { ICalendarComponent } from '../icalendar/parser';
import {
	assertVTimeZoneCovers,
	canonicalizeIanaTimeZone,
	generateFiniteVTimeZone,
} from '../icalendar/timeZones';
import type { FiniteTimeZoneCoverage, IanaTimeZoneId } from '../icalendar/timeZones';
import type { AbsoluteHttpUrl } from '../transport/url';

export const CalendarEventTimeZoneAuthoringErrorCode = Object.freeze({
	UNBOUNDED_REQUIRES_REFERENCE: 'UNBOUNDED_REQUIRES_REFERENCE',
	UNREPRESENTABLE_TIME_ZONE: 'UNREPRESENTABLE_TIME_ZONE',
} as const);

export type CalendarEventTimeZoneAuthoringErrorCode =
	(typeof CalendarEventTimeZoneAuthoringErrorCode)[keyof typeof CalendarEventTimeZoneAuthoringErrorCode];

const ERROR_MESSAGES: Readonly<Record<CalendarEventTimeZoneAuthoringErrorCode, string>> = {
	UNBOUNDED_REQUIRES_REFERENCE:
		'An unbounded IANA recurrence requires server time-zone reference support.',
	UNREPRESENTABLE_TIME_ZONE:
		'The selected IANA time zone cannot be represented safely for this calendar event.',
};

export class CalDavCalendarEventTimeZoneAuthoringError extends Error {
	readonly code: CalendarEventTimeZoneAuthoringErrorCode;

	constructor(code: CalendarEventTimeZoneAuthoringErrorCode) {
		super(ERROR_MESSAGES[code]);
		this.name = 'CalDavAuthoringError';
		this.code = code;
	}
}

export type CalendarEventTimeZoneAuthoringCoverage =
	| { readonly kind: 'finite'; readonly interval: FiniteTimeZoneCoverage }
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

async function verifiedReference(
	input: CalendarEventTimeZoneAuthoringInput,
): Promise<CalendarEventTimeZoneAuthoringRules | undefined> {
	if (input.referenceContext === undefined) return undefined;
	try {
		const reference = await input.referenceContext.resolveReference(
			input.calendarUrl,
			input.timeZone,
		);
		const definition = referenceDefinition(reference, input.timeZone);
		if (input.coverage.kind === 'finite') {
			assertVTimeZoneCovers(definition, input.timeZone, input.coverage.interval);
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
	const reference = await verifiedReference(input);
	if (reference !== undefined) return reference;
	if (input.coverage.kind === 'unbounded') {
		throw new CalDavCalendarEventTimeZoneAuthoringError('UNBOUNDED_REQUIRES_REFERENCE');
	}
	try {
		if (input.reusableDefinition !== undefined) {
			assertVTimeZoneCovers(input.reusableDefinition, input.timeZone, input.coverage.interval);
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
