export function calendar(lines: readonly string[]): string {
	return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR', ''].join('\r\n');
}

export function event(uid: string, lines: readonly string[]): readonly string[] {
	return ['BEGIN:VEVENT', `UID:${uid}`, ...lines, 'END:VEVENT'];
}

export function timedMaster(extra: readonly string[] = []): readonly string[] {
	return event('alarms@example.test', [
		'DTSTAMP:20400101T000000Z',
		'DTSTART:20400102T100000Z',
		'DTEND:20400102T110000Z',
		'SUMMARY:Alarm oracle',
		...extra,
	]);
}

export function allDayMaster(extra: readonly string[] = []): readonly string[] {
	return event('alarms-all-day@example.test', [
		'DTSTAMP:20400101T000000Z',
		'DTSTART;VALUE=DATE:20400102',
		'DTEND;VALUE=DATE:20400103',
		'SUMMARY:All-day alarm oracle',
		...extra,
	]);
}

export const MIXED_SUPPORTED_ALARMS = Object.freeze([
	'BEGIN:VALARM',
	'UID:11111111-1111-4111-8111-111111111111',
	'ACTION:DISPLAY',
	'TRIGGER:-PT15M',
	'DESCRIPTION:Display reminder',
	'END:VALARM',
	'BEGIN:VALARM',
	'UID:22222222-2222-4222-8222-222222222222',
	'ACTION:AUDIO',
	'TRIGGER;RELATED=END:PT1H',
	'END:VALARM',
	'BEGIN:VALARM',
	'UID:33333333-3333-4333-8333-333333333333',
	'ACTION:EMAIL',
	'TRIGGER:PT0S',
	'SUMMARY:Email subject',
	'DESCRIPTION:Email body',
	'ATTENDEE:mailto:first@example.test',
	'ATTENDEE:MAILTO:%73econd@example.test',
	'END:VALARM',
]);

export const PRESERVATION_ALARMS = Object.freeze([
	'BEGIN:VALARM',
	'UID:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
	'ACTION:DISPLAY',
	'X-BEFORE;X-PARAM="Keep,Quoted":opaque-before',
	'TRIGGER:-PT5M',
	'DESCRIPTION:Preserve me',
	'ACKNOWLEDGED:20400101T010203Z',
	'X-WR-ALARMUID:existing-apple-id',
	'END:VALARM',
	'BEGIN:VALARM',
	'ACTION:DISPLAY',
	'TRIGGER;VALUE=DATE-TIME:20400102T090000Z',
	'DESCRIPTION:Absolute read-only',
	'X-ABSOLUTE:keep-absolute',
	'END:VALARM',
	'BEGIN:VALARM',
	'ACTION:DISPLAY',
	'TRIGGER:-PT30M',
	'DESCRIPTION:Repeating read-only',
	'REPEAT:2',
	'DURATION:PT5M',
	'X-REPEAT:keep-repeat',
	'END:VALARM',
	'BEGIN:VALARM',
	'ACTION:AUDIO',
	'TRIGGER:-PT1H',
	'ATTACH:https://example.test/tone.wav',
	'END:VALARM',
]);

export const UNSUPPORTED_CLASSIFICATION_ALARMS = Object.freeze([
	'BEGIN:VALARM',
	'TRIGGER:-PT5M',
	'END:VALARM',
	'BEGIN:VALARM',
	'ACTION:PROCEDURE',
	'TRIGGER:-PT5M',
	'END:VALARM',
	'BEGIN:VALARM',
	'ACTION:DISPLAY',
	'TRIGGER;VALUE=DATE-TIME:20400102T090000Z',
	'DESCRIPTION:Absolute',
	'END:VALARM',
	'BEGIN:VALARM',
	'ACTION:DISPLAY',
	'TRIGGER:-PT5M',
	'DESCRIPTION:Repeat',
	'REPEAT:1',
	'DURATION:PT1M',
	'END:VALARM',
	'BEGIN:VALARM',
	'ACTION:AUDIO',
	'TRIGGER:-PT5M',
	'ATTACH:https://example.test/tone.wav',
	'END:VALARM',
	'BEGIN:VALARM',
	'ACTION:DISPLAY',
	'TRIGGER:-PT5M',
	'DESCRIPTION:Proximity',
	'PROXIMITY:ARRIVE',
	'END:VALARM',
	'BEGIN:VALARM',
	'ACTION:DISPLAY',
	'TRIGGER:-PT1H30M',
	'DESCRIPTION:Composite',
	'END:VALARM',
	'BEGIN:VALARM',
	'ACTION:EMAIL',
	'TRIGGER:-PT5M',
	'SUMMARY:Subject',
	'DESCRIPTION:Body',
	'ATTENDEE:mailto:first@example.test?subject=forbidden',
	'END:VALARM',
]);
