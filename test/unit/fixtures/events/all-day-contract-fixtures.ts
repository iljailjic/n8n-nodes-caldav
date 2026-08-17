export function calendarObject(lines: readonly string[]): string {
	return [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//example.test//Issue 41 contract oracle//EN',
		...lines,
		'END:VCALENDAR',
		'',
	].join('\r\n');
}

export function eventComponent(uid: string, lines: readonly string[]): readonly string[] {
	return ['BEGIN:VEVENT', `UID:${uid}`, ...lines, 'END:VEVENT'];
}

export function allDayEvent(
	uid: string,
	startDate = '20240229',
	endDate = '20240301',
	extraLines: readonly string[] = [],
): string {
	return calendarObject(
		eventComponent(uid, [
			'DTSTAMP:20400101T000000Z',
			`DTSTART;VALUE=DATE:${startDate}`,
			`DTEND;VALUE=DATE:${endDate}`,
			`SUMMARY:All-day ${uid}`,
			...extraLines,
		]),
	);
}

export function timedEvent(
	uid: string,
	start = '20240229T100000Z',
	end = '20240229T110000Z',
	extraLines: readonly string[] = [],
): string {
	return calendarObject(
		eventComponent(uid, [
			'DTSTAMP:20400101T000000Z',
			`DTSTART:${start}`,
			`DTEND:${end}`,
			`SUMMARY:Timed ${uid}`,
			...extraLines,
		]),
	);
}

export function floatingEvent(uid: string): string {
	return calendarObject(
		eventComponent(uid, [
			'DTSTART:20240229T100000',
			'DTEND:20240229T110000',
			`SUMMARY:Floating ${uid}`,
		]),
	);
}

export function durationEvent(uid: string): string {
	return calendarObject(
		eventComponent(uid, ['DTSTART:20240229T100000Z', 'DURATION:PT1H', `SUMMARY:Duration ${uid}`]),
	);
}

export function dateWithTzidEvent(uid: string): string {
	return calendarObject(
		eventComponent(uid, [
			'DTSTART;TZID=Private/Contract;VALUE=DATE:20240229',
			'DTEND;TZID=Private/Contract;VALUE=DATE:20240301',
			`SUMMARY:TZID DATE ${uid}`,
		]),
	);
}

export function preservationEvent(uid: string, timeLines: readonly string[]): string {
	return calendarObject([
		'X-CALENDAR-OPAQUE;X-PARAM=MiXeD:calendar-value',
		'BEGIN:VTIMEZONE',
		'TZID:Unrelated/Zone',
		'X-TIMEZONE-OPAQUE:keep',
		'END:VTIMEZONE',
		...eventComponent(uid, [
			'DTSTAMP:20391231T235959Z',
			'LAST-MODIFIED:20391231T235959Z',
			...timeLines,
			'SEQUENCE:7',
			'ORGANIZER:mailto:organizer@example.test',
			'ATTENDEE:mailto:attendee@example.test',
			'X-OPAQUE;X-PARAM="one,two":opaque-content',
			'BEGIN:VALARM',
			'ACTION:DISPLAY',
			'TRIGGER:-PT10M',
			'DESCRIPTION:Preserve alarm',
			'END:VALARM',
		]),
	]);
}
