import type { CalendarEventReadResult } from '../icalendar/eventReadModel';
import { normalizeCalendarCollectionUrl } from '../transport/url';
import type { AbsoluteHttpUrl } from '../transport/url';

interface ResolvedUidIdentity {
	readonly selectedCalendarUrl: AbsoluteHttpUrl;
	readonly effectiveCalendarUrl: AbsoluteHttpUrl;
}

const resolvedUidIdentities = new WeakMap<CalendarEventReadResult, ResolvedUidIdentity>();

export function registerResolvedUidIdentity(
	result: CalendarEventReadResult,
	selectedCalendarUrl: AbsoluteHttpUrl,
	effectiveCalendarUrl: AbsoluteHttpUrl,
): void {
	resolvedUidIdentities.set(
		result,
		Object.freeze({
			selectedCalendarUrl: normalizeCalendarCollectionUrl(selectedCalendarUrl),
			effectiveCalendarUrl: normalizeCalendarCollectionUrl(effectiveCalendarUrl),
		}),
	);
}

export function effectiveCalendarUrlForResolvedUid(
	result: CalendarEventReadResult,
	selectedCalendarUrl: AbsoluteHttpUrl,
): AbsoluteHttpUrl | undefined {
	const identity = resolvedUidIdentities.get(result);
	if (identity === undefined) return undefined;
	try {
		const selected = normalizeCalendarCollectionUrl(selectedCalendarUrl);
		return selected === identity.selectedCalendarUrl &&
			normalizeCalendarCollectionUrl(result.event.calendarUrl) === identity.effectiveCalendarUrl
			? identity.effectiveCalendarUrl
			: undefined;
	} catch {
		return undefined;
	}
}
