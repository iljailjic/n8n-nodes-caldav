/* eslint-disable @n8n/community-nodes/require-node-api-error -- Confirmation failures are mapped to item-aware n8n errors at the node boundary. */

import type { CalendarEventTimeZoneExecutionContext } from '../discovery/timeZoneReferences';
import { calendarEventPreservationTimeZoneDefinition } from '../icalendar/eventReadModel';
import { recurrenceRulesAreSemanticallyEqual } from '../icalendar/recurrence';
import type { RecurrenceProjection, RecurrenceRule } from '../icalendar/recurrence';
import { vTimeZoneRulesAreSemanticallyEqual } from '../icalendar/timeZones';
import { CalDavTransportError } from '../transport/http';
import type { CalDavTransport } from '../transport/http';
import type { AbsoluteHttpUrl } from '../transport/url';
import type { CreatedCalendarEvent } from './create';
import type { PreparedCalendarEventCreate } from './createPreparation';
import { CalDavCalendarEventCreateError, CalendarEventCreateFailureCode } from './createErrors';
import { getCalendarEventByResourceUrl } from './getByResourceUrl';

function matchingRecurrence(
	expected: RecurrenceProjection | undefined,
	actual: RecurrenceProjection | undefined,
): boolean {
	if (expected === undefined || actual === undefined) return expected === actual;
	if ('kind' in expected || 'kind' in actual) return false;
	return recurrenceRulesAreSemanticallyEqual(expected as RecurrenceRule, actual as RecurrenceRule);
}

export async function confirmStructuredCalendarEventCreate(
	transport: CalDavTransport,
	calendarUrl: AbsoluteHttpUrl,
	resourceUrl: AbsoluteHttpUrl,
	prepared: PreparedCalendarEventCreate,
	timeZoneContext?: CalendarEventTimeZoneExecutionContext,
): Promise<CreatedCalendarEvent> {
	try {
		const confirmed = await getCalendarEventByResourceUrl(transport, calendarUrl, resourceUrl, {
			...(timeZoneContext === undefined ? {} : { timeZoneContext }),
		});
		const actual = confirmed.event;
		const expected = prepared.event;
		const matchingTime =
			actual.timeMode === 'timed' && expected.timeMode === 'timed'
				? actual.start === expected.start &&
					actual.end === expected.end &&
					actual.timeZoneMode === expected.timeZoneMode &&
					actual.timeZone === expected.timeZone
				: actual.timeMode === 'allDay' && expected.timeMode === 'allDay'
					? actual.startDate === expected.startDate && actual.endDate === expected.endDate
					: false;
		if (
			actual.etag === undefined ||
			actual.uid !== prepared.uid ||
			actual.resourceUrl !== resourceUrl ||
			actual.accessMode !== 'editable' ||
			!matchingTime ||
			!matchingRecurrence(expected.recurrence, actual.recurrence) ||
			(expected.timeMode === 'timed' &&
				expected.timeZoneMode === 'iana' &&
				(prepared.timeZoneDefinition === undefined ||
					expected.timeZone === undefined ||
					!vTimeZoneRulesAreSemanticallyEqual(
						prepared.timeZoneDefinition,
						calendarEventPreservationTimeZoneDefinition(confirmed.context),
						expected.timeZone,
						prepared.timeZoneCoverage?.kind === 'finite'
							? prepared.timeZoneCoverage.interval
							: undefined,
					)))
		) {
			throw new CalDavCalendarEventCreateError(CalendarEventCreateFailureCode.CONFIRMATION_FAILED);
		}
		return Object.freeze({ ...actual, etag: actual.etag });
	} catch (error) {
		if (error instanceof CalDavCalendarEventCreateError) throw error;
		throw new CalDavCalendarEventCreateError(
			CalendarEventCreateFailureCode.CONFIRMATION_FAILED,
			error instanceof CalDavTransportError ? error.statusCode : undefined,
		);
	}
}
