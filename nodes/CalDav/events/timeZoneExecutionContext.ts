import type { CalendarEventTimeZoneExecutionContext } from '../discovery/timeZoneReferences';
import type { CalDavTransport } from '../transport/http';

const TIME_ZONE_CONTEXTS = new WeakMap<CalDavTransport, CalendarEventTimeZoneExecutionContext>();

export function bindCalendarEventTimeZoneExecutionContext(
	transport: CalDavTransport,
	context: CalendarEventTimeZoneExecutionContext,
): void {
	TIME_ZONE_CONTEXTS.set(transport, context);
}

export function calendarEventTimeZoneExecutionContext(
	transport: CalDavTransport,
): CalendarEventTimeZoneExecutionContext | undefined {
	return TIME_ZONE_CONTEXTS.get(transport);
}
