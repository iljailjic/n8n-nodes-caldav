import { randomUUID } from 'node:crypto';

import {
	CalDavICalendarSerializeError,
	CalDavICalendarSerializeErrorCode,
} from '../icalendar/serializer';

export type CalendarEventUidGenerator = () => string;

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

export function resolveCalendarEventUid(
	uid: string | undefined,
	generator: CalendarEventUidGenerator = randomUUID,
): string {
	if (uid === undefined) return generator();
	if (typeof uid !== 'string') {
		throw new CalDavICalendarSerializeError(CalDavICalendarSerializeErrorCode.INVALID_INPUT, 'uid');
	}
	if (uid.length === 0) {
		throw new CalDavICalendarSerializeError(
			CalDavICalendarSerializeErrorCode.MISSING_REQUIRED_FIELD,
			'uid',
		);
	}
	if (!isValidICalendarText(uid)) {
		throw new CalDavICalendarSerializeError(CalDavICalendarSerializeErrorCode.INVALID_TEXT, 'uid');
	}
	return uid;
}
