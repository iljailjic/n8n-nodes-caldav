import { ICALENDAR_MAX_RESOURCE_BYTES } from '../../../../nodes/CalDav/icalendar/parser';

export const RAW_ICS_PRIVATE_SENTINEL = 'raw-ics-private-sentinel-7bd713';

export const RAW_ICS_FIDELITY_FIXTURE = [
	'BEGIN:VCALENDAR',
	'vErSiOn:2.0',
	'PRODID:-//example.test//Raw ICS contract//EN',
	'BEGIN:VTIMEZONE',
	'TZID:Synthetic/Unused',
	`X-PRIVATE-ZONE:${RAW_ICS_PRIVATE_SENTINEL}`,
	'END:VTIMEZONE',
	'BEGIN:VEVENT',
	'UID:raw-fidelity@example.test',
	'DTSTAMP:20400101T000000Z',
	'DTSTART:20400102T100000Z',
	'DTEND:20400102T103000Z',
	'SUMMARY:Mixed Unicode — Žluťoučký Ω',
	'DESCRIPTION:folded first segment',
	' second segment',
	'X-MiXeD;X-Quoted="A,B":opaque-value',
	'RRULE:FREQ=DAILY;COUNT=2',
	'EXDATE:20400103T100000Z',
	'BEGIN:VALARM',
	'TRIGGER:-PT15M',
	'ACTION:DISPLAY',
	'DESCRIPTION:Reminder',
	'END:VALARM',
	'END:VEVENT',
	'BEGIN:VEVENT',
	'UID:raw-fidelity@example.test',
	'RECURRENCE-ID:20400103T100000Z',
	'DTSTART:20400103T120000Z',
	'DTEND:20400103T123000Z',
	'SUMMARY:Exception',
	'END:VEVENT',
	'END:VCALENDAR',
	'',
].join('\r\n');

export function compactEventIcs(
	uid: string,
	summary: string,
	newline: '\r\n' | '\n' = '\r\n',
): string {
	return [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//example.test//Raw ICS oracle//EN',
		'BEGIN:VEVENT',
		`UID:${uid}`,
		'DTSTAMP:20400101T000000Z',
		'DTSTART:20400102T100000Z',
		'DTEND:20400102T103000Z',
		`SUMMARY:${summary}`,
		'END:VEVENT',
		'END:VCALENDAR',
		'',
	].join(newline);
}

export function exactSizeEventIcs(size = ICALENDAR_MAX_RESOURCE_BYTES): string {
	const prefix = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'BEGIN:VEVENT',
		'UID:raw-size@example.test',
		'DTSTART:20400102T100000Z',
		'DTEND:20400102T103000Z',
		'X-PAD:',
	].join('\r\n');
	const suffix = '\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
	return prefix + 'p'.repeat(size - Buffer.byteLength(prefix + suffix, 'utf8')) + suffix;
}

export function xmlText(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
}

export function reportResponse(href: string, etag: string, calendarDataMarkup: string): string {
	return [
		'<d:response>',
		`<d:href>${xmlText(href)}</d:href>`,
		'<d:propstat><d:prop>',
		`<d:getetag>${xmlText(etag)}</d:getetag>`,
		`<c:calendar-data>${calendarDataMarkup}</c:calendar-data>`,
		'</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>',
		'</d:response>',
	].join('');
}

export function multiStatus(responses: string, declaration = '<?xml version="1.0"?>'): string {
	return `${declaration}<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${responses}</d:multistatus>`;
}
