import { joinCalendarCollectionUrl } from '../transport/url';
import type { AbsoluteHttpUrl } from '../transport/url';

export const CALENDAR_EVENT_RESOURCE_SEGMENT_MAX_BYTES = 255;

function assertResourceSegmentLength(resourceName: string): string | undefined {
	return Buffer.byteLength(resourceName, 'ascii') <= CALENDAR_EVENT_RESOURCE_SEGMENT_MAX_BYTES
		? resourceName
		: undefined;
}

export function calendarEventBase64UrlResourceNameForUid(uid: string): string | undefined {
	const encoded = Buffer.from(uid, 'utf8')
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/u, '');
	return assertResourceSegmentLength(`${encoded}.ics`);
}

export function calendarEventEncodedUidResourceName(uid: string): string | undefined {
	try {
		return assertResourceSegmentLength(`${encodeURIComponent(uid)}.ics`);
	} catch {
		return undefined;
	}
}

export function calendarEventResourceUrlForBase64Uid(
	calendarUrl: AbsoluteHttpUrl,
	uid: string,
): AbsoluteHttpUrl | undefined {
	const resourceName = calendarEventBase64UrlResourceNameForUid(uid);
	return resourceName === undefined
		? undefined
		: joinCalendarCollectionUrl(calendarUrl, resourceName);
}

export function calendarEventResourceUrlForEncodedUid(
	calendarUrl: AbsoluteHttpUrl,
	uid: string,
): AbsoluteHttpUrl | undefined {
	const resourceName = calendarEventEncodedUidResourceName(uid);
	return resourceName === undefined
		? undefined
		: joinCalendarCollectionUrl(calendarUrl, resourceName);
}
