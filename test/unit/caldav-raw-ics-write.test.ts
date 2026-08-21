import { describe, expect, it, vi } from 'vitest';

import {
	CalDavRawCalendarEventError,
	prepareRawCalendarEventWrite,
	rawCalendarEventResourcesAreSemanticallyEqual,
} from '../../nodes/CalDav/icalendar/rawEventWrite';

const UID = 'raw-write@example.test';

function calendar(eventLines: readonly string[], extra: readonly string[] = []): string {
	return [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//example.test//Raw write tests//EN',
		...extra,
		...eventLines,
		'END:VCALENDAR',
		'',
	].join('\r\n');
}

function event(uid: string | null = UID, overrides: readonly string[] = []): readonly string[] {
	return [
		'BEGIN:VEVENT',
		...(uid === null ? [] : [`UID:${uid}`]),
		'DTSTAMP:20400101T000000Z',
		'DTSTART:20400102T100000Z',
		'DTEND:20400102T110000Z',
		'SUMMARY:Raw write',
		...overrides,
		'END:VEVENT',
	];
}

function endRelatedAlarm(): readonly string[] {
	return [
		'BEGIN:VALARM',
		'ACTION:DISPLAY',
		'TRIGGER;RELATED=END:-PT5M',
		'DESCRIPTION:Private end alarm',
		'END:VALARM',
	];
}

function failure(run: () => unknown): CalDavRawCalendarEventError {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(CalDavRawCalendarEventError);
		return error as CalDavRawCalendarEventError;
	}
	throw new Error('Expected Raw ICS preparation to fail.');
}

describe('validated Raw ICS write preparation', () => {
	it('accepts complex recurrence, scheduling, alarm, X-content and an embedded timezone', () => {
		const rawIcs = calendar(
			[
				'BEGIN:VEVENT',
				`UID:${UID}`,
				'DTSTAMP:20400101T000000Z',
				'DTSTART;TZID=Europe/Prague:20400102T100000',
				'DTEND;TZID=Europe/Prague:20400102T110000',
				'RRULE:FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=1;COUNT=3',
				'EXDATE;TZID=Europe/Prague:20400203T100000',
				'RDATE;TZID=Europe/Prague:20400302T100000',
				'ORGANIZER:mailto:owner@example.test',
				'ATTENDEE;CN=Guest:mailto:guest@example.test',
				'ATTACH:https://example.test/file',
				'X-PRIVATE;X-ORDER=Kept:opaque',
				'BEGIN:VALARM',
				'ACTION:DISPLAY',
				'TRIGGER:-PT15M',
				'DESCRIPTION:Reminder',
				'END:VALARM',
				'END:VEVENT',
				'BEGIN:VEVENT',
				`UID:${UID}`,
				'DTSTAMP:20400101T000001Z',
				'RECURRENCE-ID;TZID=Europe/Prague:20400203T100000',
				'DTSTART;TZID=Europe/Prague:20400203T120000',
				'DTEND;TZID=Europe/Prague:20400203T130000',
				'END:VEVENT',
			],
			[
				'BEGIN:VTIMEZONE',
				'TZID:Europe/Prague',
				'BEGIN:STANDARD',
				'DTSTART:19701025T030000',
				'TZOFFSETFROM:+0200',
				'TZOFFSETTO:+0100',
				'END:STANDARD',
				'END:VTIMEZONE',
			],
		);

		const prepared = prepareRawCalendarEventWrite({ operation: 'create', rawIcs });

		expect(prepared).toMatchObject({ uid: UID, uidSource: 'supplied' });
		expect(prepared.calendarData).toContain('X-PRIVATE;X-ORDER=Kept:opaque');
		expect(prepared.resource.originalIcs).toBe(prepared.calendarData);
		expect(Object.isFrozen(prepared.resource)).toBe(true);
	});

	it('preserves standard COLOR on VEVENT', () => {
		const prepared = prepareRawCalendarEventWrite({
			operation: 'create',
			rawIcs: calendar(event(UID, ['COLOR:turquoise'])),
		});

		expect(prepared.calendarData).toContain('COLOR:turquoise');
	});

	it('accepts real leap-day values, action-specific alarms and recurring timezone observances', () => {
		const rawIcs = calendar(
			[
				'BEGIN:VEVENT',
				`UID:${UID}`,
				'DTSTAMP:20400229T235959Z',
				'DTSTART:20400229T100000Z',
				'DTEND:20400229T110000Z',
				'STATUS:CONFIRMED',
				'TRANSP:OPAQUE',
				'BEGIN:VALARM',
				'ACTION:DISPLAY',
				'TRIGGER:-PT15M',
				'DESCRIPTION:Display reminder',
				'DURATION:PT5M',
				'REPEAT:2',
				'END:VALARM',
				'BEGIN:VALARM',
				'ACTION:EMAIL',
				'TRIGGER;VALUE=DATE-TIME:20400229T090000Z',
				'DESCRIPTION:Email reminder',
				'SUMMARY:Event reminder',
				'ATTENDEE:mailto:guest@example.test',
				'END:VALARM',
				'BEGIN:VALARM',
				'ACTION:AUDIO',
				'TRIGGER:PT0S',
				'ATTACH:https://example.test/reminder.wav',
				'END:VALARM',
				'END:VEVENT',
			],
			[
				'BEGIN:VTIMEZONE',
				'TZID:Custom/Recurring',
				'BEGIN:STANDARD',
				'DTSTART:19701025T030000',
				'TZOFFSETFROM:+0200',
				'TZOFFSETTO:+0100',
				'RRULE:BYMONTH=10;FREQ=YEARLY;BYDAY=-1SU;UNTIL=20501030T020000Z',
				'RDATE:19801026T030000',
				'COMMENT:First note',
				'COMMENT:Second note',
				'END:STANDARD',
				'END:VTIMEZONE',
			],
		);

		expect(() => prepareRawCalendarEventWrite({ operation: 'create', rawIcs })).not.toThrow();
	});

	it.each([
		[
			'DATE DTSTART and DATE UNTIL',
			calendar([
				'BEGIN:VEVENT',
				`UID:${UID}`,
				'DTSTAMP:20400101T000000Z',
				'DTSTART;VALUE=DATE:20400102',
				'DTEND;VALUE=DATE:20400103',
				'RRULE:FREQ=DAILY;UNTIL=20400105',
				'END:VEVENT',
			]),
		],
		[
			'floating DTSTART and floating UNTIL',
			calendar([
				'BEGIN:VEVENT',
				`UID:${UID}`,
				'DTSTAMP:20400101T000000Z',
				'DTSTART:20400102T100000',
				'DTEND:20400102T110000',
				'RRULE:FREQ=DAILY;UNTIL=20400105T100000',
				'END:VEVENT',
			]),
		],
		[
			'UTC DTSTART and UTC UNTIL',
			calendar(event(UID, ['RRULE:FREQ=DAILY;UNTIL=20400105T100000Z'])),
		],
	] as const)('accepts %s', (_name, rawIcs) => {
		expect(() => prepareRawCalendarEventWrite({ operation: 'create', rawIcs })).not.toThrow();
	});

	it('preserves IANA/X tokens and ignores generic extension alarms while accepting second 60', () => {
		const rawIcs = calendar([
			'BEGIN:VEVENT',
			`UID:${UID}`,
			'DTSTAMP:20400101T100060Z',
			'DTSTART:20400102T100000Z',
			'DTEND:20400102T110000Z',
			'STATUS:IANA-STATUS',
			'TRANSP:X-VENDOR-TRANSPARENCY',
			'CLASS:IANA-CLASSIFICATION',
			'ATTENDEE;ROLE=IANA-ROLE;CUTYPE=IANA-CUTYPE:mailto:guest@example.test',
			'BEGIN:VALARM',
			'ACTION:PROCEDURE',
			'TRIGGER:-PT5M',
			'DURATION:PT1M',
			'REPEAT:2',
			'PROCEDURE-DATA:opaque-iana',
			'X-PROCEDURE-DATA:opaque',
			'END:VALARM',
			'BEGIN:VALARM',
			'ACTION:X-VENDOR-ACTION',
			'TRIGGER;VALUE=DATE-TIME:20400102T090000Z',
			'X-VENDOR-DATA:preserved',
			'END:VALARM',
			'END:VEVENT',
		]);

		const prepared = prepareRawCalendarEventWrite({ operation: 'create', rawIcs });

		expect(prepared.calendarData).toContain('ACTION:PROCEDURE');
		expect(prepared.calendarData).toContain('ACTION:X-VENDOR-ACTION');
		expect(prepared.calendarData).toContain('PROCEDURE-DATA:opaque-iana');
		expect(prepared.calendarData).toContain('ROLE=IANA-ROLE');
		expect(prepared.calendarData).toContain('DTSTAMP:20400101T100060Z');
	});

	it.each([
		['DTEND', calendar(event(UID, endRelatedAlarm()))],
		[
			'DURATION',
			calendar(event(UID, endRelatedAlarm())).replace('DTEND:20400102T110000Z', 'DURATION:PT1H'),
		],
	] as const)('accepts an END-related alarm when VEVENT has %s', (_endKind, rawIcs) => {
		const prepared = prepareRawCalendarEventWrite({ operation: 'create', rawIcs });

		expect(prepared.calendarData).toContain('TRIGGER;RELATED=END:-PT5M');
	});

	it('rejects an END-related alarm without a VEVENT end before generating a UID', () => {
		const generator = vi.fn(() => '00000000-0000-4000-8000-000000000051');
		const rawIcs = calendar(event(null, endRelatedAlarm())).replace(
			'DTEND:20400102T110000Z\r\n',
			'',
		);

		const error = failure(() =>
			prepareRawCalendarEventWrite({ operation: 'create', rawIcs }, generator),
		);

		expect(error).toMatchObject({
			code: 'INVALID_RESOURCE',
			message: 'Raw ICS must contain one valid VCALENDAR event resource.',
		});
		expect(JSON.stringify(error)).not.toContain('Private end alarm');
		expect(generator).not.toHaveBeenCalled();
	});

	it.each(['create', 'upsert'] as const)(
		'generates exactly once and inserts the same UID into every VEVENT for %s',
		(operation) => {
			const generated = '00000000-0000-4000-8000-000000000051';
			const generator = vi.fn(() => generated);
			const rawIcs = calendar([
				...event(null, ['RRULE:FREQ=DAILY;COUNT=2']),
				'BEGIN:VEVENT',
				'DTSTAMP:20400101T000001Z',
				'RECURRENCE-ID:20400103T100000Z',
				'DTSTART:20400103T120000Z',
				'DTEND:20400103T130000Z',
				'END:VEVENT',
			]);

			const prepared = prepareRawCalendarEventWrite({ operation, rawIcs }, generator);

			expect(generator).toHaveBeenCalledOnce();
			expect(prepared.uidSource).toBe('generated');
			expect(prepared.calendarData.match(new RegExp(`UID:${generated}`, 'g'))).toHaveLength(2);
			expect(prepared.calendarData.indexOf(`UID:${generated}`)).toBeGreaterThan(
				prepared.calendarData.indexOf('BEGIN:VEVENT'),
			);
		},
	);

	it('requires a UID for Update and rejects partial, duplicate and differing identity sets', () => {
		expect(
			failure(() =>
				prepareRawCalendarEventWrite({ operation: 'update', rawIcs: calendar(event(null)) }),
			).code,
		).toBe('UID_REQUIRED');
		const partial = calendar([
			...event(UID, ['RRULE:FREQ=DAILY;COUNT=2']),
			'BEGIN:VEVENT',
			'DTSTAMP:20400101T000001Z',
			'RECURRENCE-ID:20400103T100000Z',
			'DTSTART:20400103T120000Z',
			'DTEND:20400103T130000Z',
			'END:VEVENT',
		]);
		expect(
			failure(() => prepareRawCalendarEventWrite({ operation: 'create', rawIcs: partial })).code,
		).toBe('INVALID_UID_SET');
		for (const rawIcs of [
			calendar(event(UID, [`UID:${UID}`])),
			calendar([
				...event(UID, ['RRULE:FREQ=DAILY;COUNT=2']),
				'BEGIN:VEVENT',
				'UID:different@example.test',
				'DTSTAMP:20400101T000001Z',
				'RECURRENCE-ID:20400103T100000Z',
				'DTSTART:20400103T120000Z',
				'DTEND:20400103T130000Z',
				'END:VEVENT',
			]),
		]) {
			expect(
				failure(() => prepareRawCalendarEventWrite({ operation: 'create', rawIcs })).code,
			).toBe('INVALID_UID_SET');
		}
	});

	it.each([
		['METHOD', calendar(event(), ['METHOD:PUBLISH']), 'METHOD_NOT_ALLOWED'],
		[
			'mixed VTODO',
			calendar([...event(), 'BEGIN:VTODO', `UID:${UID}`, 'END:VTODO']),
			'UNSUPPORTED_COMPONENT',
		],
		['multiple masters', calendar([...event(), ...event()]), 'INVALID_EVENT_SET'],
		[
			'exception only',
			calendar([
				'BEGIN:VEVENT',
				`UID:${UID}`,
				'DTSTAMP:20400101T000000Z',
				'RECURRENCE-ID:20400102T100000Z',
				'DTSTART:20400102T100000Z',
				'END:VEVENT',
			]),
			'INVALID_EVENT_SET',
		],
	] as const)('rejects %s with a stable private-safe category', (_name, rawIcs, code) => {
		const error = failure(() => prepareRawCalendarEventWrite({ operation: 'create', rawIcs }));
		expect(error.code).toBe(code);
		expect(JSON.stringify(error)).not.toContain(UID);
	});

	it('rejects unresolved TZID, malformed nesting, controls, surrogates and oversize input', () => {
		const cases = [
			calendar([
				'BEGIN:VEVENT',
				`UID:${UID}`,
				'DTSTAMP:20400101T000000Z',
				'DTSTART;TZID=Missing/Zone:20400102T100000',
				'DTEND;TZID=Missing/Zone:20400102T110000',
				'END:VEVENT',
			]),
			calendar(event()).replace('END:VEVENT', 'END:VTODO'),
			calendar(event(UID, ['X-BAD:\u0000private'])),
			calendar(event(UID, ['SUMMARY:\ud800private'])),
		];
		for (const rawIcs of cases) {
			const error = failure(() => prepareRawCalendarEventWrite({ operation: 'create', rawIcs }));
			expect(['INVALID_INPUT', 'INVALID_RESOURCE']).toContain(error.code);
			expect(error.message).not.toContain('private');
		}
		const oversized = `${calendar(event())}${'x'.repeat(5_242_881)}`;
		expect(
			failure(() => prepareRawCalendarEventWrite({ operation: 'create', rawIcs: oversized })).code,
		).toBe('RESOURCE_LIMIT_EXCEEDED');
	});

	it.each([
		['impossible DTSTART date', calendar(event()).replace('20400102T100000Z', '20400230T100000Z')],
		[
			'impossible DTSTAMP month and time',
			calendar(event()).replace('20400101T000000Z', '20401301T250000Z'),
		],
		['DTEND before DTSTART', calendar(event()).replace('20400102T110000Z', '20400102T090000Z')],
		[
			'RRULE BYMONTHDAY with WEEKLY frequency',
			calendar(event(UID, ['RRULE:FREQ=WEEKLY;BYMONTHDAY=1'])),
		],
		[
			'numeric RRULE BYDAY with DAILY frequency',
			calendar(event(UID, ['RRULE:FREQ=DAILY;BYDAY=1MO'])),
		],
		[
			'DATE DTSTART with UTC DATE-TIME UNTIL',
			calendar([
				'BEGIN:VEVENT',
				`UID:${UID}`,
				'DTSTAMP:20400101T000000Z',
				'DTSTART;VALUE=DATE:20400102',
				'DTEND;VALUE=DATE:20400103',
				'RRULE:FREQ=DAILY;UNTIL=20400105T000000Z',
				'END:VEVENT',
			]),
		],
		[
			'UTC DTSTART with local UNTIL',
			calendar(event(UID, ['RRULE:FREQ=DAILY;UNTIL=20400105T100000'])),
		],
		[
			'floating DTSTART with UTC UNTIL',
			calendar([
				'BEGIN:VEVENT',
				`UID:${UID}`,
				'DTSTAMP:20400101T000000Z',
				'DTSTART:20400102T100000',
				'DTEND:20400102T110000',
				'RRULE:FREQ=DAILY;UNTIL=20400105T100000Z',
				'END:VEVENT',
			]),
		],
		[
			'DATE DTSTART with BYHOUR',
			calendar([
				'BEGIN:VEVENT',
				`UID:${UID}`,
				'DTSTAMP:20400101T000000Z',
				'DTSTART;VALUE=DATE:20400102',
				'DTEND;VALUE=DATE:20400103',
				'RRULE:FREQ=DAILY;BYHOUR=10',
				'END:VEVENT',
			]),
		],
		[
			'VTIMEZONE local UNTIL',
			calendar(event(), [
				'BEGIN:VTIMEZONE',
				'TZID:Invalid/Until',
				'BEGIN:STANDARD',
				'DTSTART:20400101T020000',
				'TZOFFSETFROM:+0200',
				'TZOFFSETTO:+0100',
				'RRULE:FREQ=YEARLY;UNTIL=20500101T020000',
				'END:STANDARD',
				'END:VTIMEZONE',
			]),
		],
		['invalid STATUS token', calendar(event(UID, ['STATUS:NOT_A_STATUS']))],
		['invalid TRANSP token', calendar(event(UID, ['TRANSP:IN/VISIBLE']))],
		['invalid URL', calendar(event(UID, ['URL:not a uri']))],
		['invalid organizer CAL-ADDRESS', calendar(event(UID, ['ORGANIZER:not-a-calendar-address']))],
		['invalid SEQUENCE integer', calendar(event(UID, ['SEQUENCE:1.5']))],
		['out-of-range PRIORITY integer', calendar(event(UID, ['PRIORITY:10']))],
		[
			'event DURATION with a dangling T',
			calendar(event()).replace('DTEND:20400102T110000Z', 'DURATION:P1DT'),
		],
		[
			'VALARM TRIGGER duration with a dangling T',
			calendar(
				event(UID, [
					'BEGIN:VALARM',
					'ACTION:DISPLAY',
					'TRIGGER:P1DT',
					'DESCRIPTION:Private reminder',
					'END:VALARM',
				]),
			),
		],
		[
			'VALARM DURATION with a dangling T',
			calendar(
				event(UID, [
					'BEGIN:VALARM',
					'ACTION:DISPLAY',
					'TRIGGER:-PT5M',
					'DESCRIPTION:Private reminder',
					'DURATION:P1DT',
					'REPEAT:2',
					'END:VALARM',
				]),
			),
		],
		[
			'RDATE period with an explicit end before its start',
			calendar(event(UID, ['RDATE;VALUE=PERIOD:20400102T120000Z/20400102T110000Z'])),
		],
		[
			'RDATE period with an extra slash segment',
			calendar(
				event(UID, ['RDATE;VALUE=PERIOD:20400102T120000Z/20400102T130000Z/20400102T140000Z']),
			),
		],
		[
			'invalid VTIMEZONE offset',
			calendar(event(), [
				'BEGIN:VTIMEZONE',
				'TZID:Invalid/Offset',
				'BEGIN:STANDARD',
				'DTSTART:20400101T020000',
				'TZOFFSETFROM:+2460',
				'TZOFFSETTO:+0100',
				'END:STANDARD',
				'END:VTIMEZONE',
			]),
		],
		[
			'impossible observance date',
			calendar(event(), [
				'BEGIN:VTIMEZONE',
				'TZID:Invalid/Date',
				'BEGIN:DAYLIGHT',
				'DTSTART:20400230T020000',
				'TZOFFSETFROM:+0100',
				'TZOFFSETTO:+0200',
				'END:DAYLIGHT',
				'END:VTIMEZONE',
			]),
		],
		[
			'COLOR inside VALARM',
			calendar(
				event(UID, [
					'BEGIN:VALARM',
					'ACTION:DISPLAY',
					'TRIGGER:-PT5M',
					'DESCRIPTION:Private reminder',
					'COLOR:private-color',
					'END:VALARM',
				]),
			),
		],
		[
			'COLOR inside VTIMEZONE',
			calendar(event(), [
				'BEGIN:VTIMEZONE',
				'TZID:Private/Color',
				'COLOR:private-color',
				'BEGIN:STANDARD',
				'DTSTART:20400101T020000',
				'TZOFFSETFROM:+0200',
				'TZOFFSETTO:+0100',
				'END:STANDARD',
				'END:VTIMEZONE',
			]),
		],
		[
			'DISPLAY alarm without DESCRIPTION',
			calendar(event(UID, ['BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT5M', 'END:VALARM'])),
		],
		[
			'EMAIL alarm without SUMMARY and ATTENDEE',
			calendar(
				event(UID, [
					'BEGIN:VALARM',
					'ACTION:EMAIL',
					'TRIGGER:-PT5M',
					'DESCRIPTION:Private reminder',
					'END:VALARM',
				]),
			),
		],
		[
			'AUDIO alarm with DISPLAY-only DESCRIPTION',
			calendar(
				event(UID, [
					'BEGIN:VALARM',
					'ACTION:AUDIO',
					'TRIGGER:-PT5M',
					'DESCRIPTION:Private reminder',
					'END:VALARM',
				]),
			),
		],
		[
			'REPEAT without DURATION',
			calendar(
				event(UID, [
					'BEGIN:VALARM',
					'ACTION:DISPLAY',
					'TRIGGER:-PT5M',
					'DESCRIPTION:Private reminder',
					'REPEAT:2',
					'END:VALARM',
				]),
			),
		],
		[
			'generic alarm without TRIGGER',
			calendar(
				event(UID, [
					'BEGIN:VALARM',
					'ACTION:PROCEDURE',
					'X-PROCEDURE-DATA:Private generic alarm',
					'END:VALARM',
				]),
			),
		],
		[
			'generic alarm with duplicate TRIGGER',
			calendar(
				event(UID, [
					'BEGIN:VALARM',
					'ACTION:X-VENDOR-ACTION',
					'TRIGGER:-PT5M',
					'TRIGGER:-PT10M',
					'X-VENDOR-DATA:Private generic alarm',
					'END:VALARM',
				]),
			),
		],
		[
			'generic alarm with invalid TRIGGER',
			calendar(
				event(UID, [
					'BEGIN:VALARM',
					'ACTION:PROCEDURE',
					'TRIGGER:NOT-A-DURATION',
					'X-PROCEDURE-DATA:Private generic alarm',
					'END:VALARM',
				]),
			),
		],
		[
			'generic alarm with REPEAT without DURATION',
			calendar(
				event(UID, [
					'BEGIN:VALARM',
					'ACTION:PROCEDURE',
					'TRIGGER:-PT5M',
					'REPEAT:2',
					'X-PROCEDURE-DATA:Private generic alarm',
					'END:VALARM',
				]),
			),
		],
	] as const)('rejects malformed RFC-defined content: %s', (_name, rawIcs) => {
		const error = failure(() => prepareRawCalendarEventWrite({ operation: 'create', rawIcs }));
		expect(error).toMatchObject({
			code: 'INVALID_RESOURCE',
			message: 'Raw ICS must contain one valid VCALENDAR event resource.',
		});
		expect(JSON.stringify(error)).not.toContain('Private');
	});

	it('compares decoded semantics while ignoring folding and TEXT escape spelling', () => {
		const first = prepareRawCalendarEventWrite({
			operation: 'update',
			rawIcs: calendar(event(UID, ['DESCRIPTION:one\\,two'])),
		});
		const second = prepareRawCalendarEventWrite({
			operation: 'update',
			rawIcs: calendar(event(UID, ['DESCRIPTION:one\\,', ' two'])),
		});
		expect(rawCalendarEventResourcesAreSemanticallyEqual(first.resource, second.resource)).toBe(
			true,
		);
	});

	it('compares component, property and parameter names case-insensitively', () => {
		const canonical = prepareRawCalendarEventWrite({
			operation: 'update',
			rawIcs: calendar(event(UID, ['DESCRIPTION;LANGUAGE=en:Case normalized'])),
		});
		const mixedCase = prepareRawCalendarEventWrite({
			operation: 'update',
			rawIcs: calendar(event(UID, ['description;language=en:Case normalized']))
				.replace('BEGIN:VCALENDAR', 'begin:vcalendar')
				.replace('BEGIN:VEVENT', 'Begin:Vevent')
				.replace('END:VEVENT', 'End:Vevent')
				.replace('END:VCALENDAR', 'end:vcalendar')
				.replace('VERSION:', 'version:')
				.replace('PRODID:', 'ProdId:')
				.replace('UID:', 'uid:')
				.replace('DTSTAMP:', 'DtStamp:')
				.replace('DTSTART:', 'dtstart:')
				.replace('DTEND:', 'DtEnd:')
				.replace('SUMMARY:', 'summary:'),
		});

		expect(
			rawCalendarEventResourcesAreSemanticallyEqual(canonical.resource, mixedCase.resource),
		).toBe(true);
	});
});
