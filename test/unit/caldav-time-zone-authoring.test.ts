import { describe, expect, it, vi } from 'vitest';

import type { CalendarEventTimeZoneExecutionContext } from '../../nodes/CalDav/discovery/timeZoneReferences';
import {
	CalDavCalendarEventTimeZoneAuthoringError,
	CalendarEventTimeZoneAuthoringErrorCode,
	resolveCalendarEventTimeZoneAuthoring,
} from '../../nodes/CalDav/events/timeZoneAuthoring';
import type { CalendarEventTimeZoneAuthoringRules } from '../../nodes/CalDav/events/timeZoneAuthoring';
import { parseICalendarResource } from '../../nodes/CalDav/icalendar/parser';
import { serializeICalendarResource } from '../../nodes/CalDav/icalendar/serializer';
import { canonicalizeIanaTimeZone } from '../../nodes/CalDav/icalendar/timeZones';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';
import { TZDIST_ZONE_RESPONSE } from './fixtures/time-zones/synthetic-time-zone-fixtures';

const CALENDAR_URL = validateAbsoluteHttpUrl('https://calendar.example.test/calendars/work/');
const TIME_ZONE = canonicalizeIanaTimeZone('Europe/Prague');
const FINITE_COVERAGE = Object.freeze({
	kind: 'finite' as const,
	interval: Object.freeze({
		start: new Date('2040-01-15T09:00:00Z'),
		end: new Date('2040-01-15T10:00:00Z'),
	}),
});
const UNBOUNDED_COVERAGE = Object.freeze({ kind: 'unbounded' as const });
const encoder = new TextEncoder();

function context(
	implementation: CalendarEventTimeZoneExecutionContext['resolveReference'],
): CalendarEventTimeZoneExecutionContext {
	return { resolveReference: vi.fn(implementation) };
}

function verifiedReference(): CalendarEventTimeZoneExecutionContext {
	return context(async () => ({
		timeZone: TIME_ZONE,
		etag: '"reference-etag"',
		calendarData: TZDIST_ZONE_RESPONSE,
		ruleSource: 'vtimezone',
	}));
}

function componentText(result: CalendarEventTimeZoneAuthoringRules): string {
	const base = parseICalendarResource(
		encoder.encode(
			[
				'BEGIN:VCALENDAR',
				'VERSION:2.0',
				'PRODID:-//example.test//authoring oracle//EN',
				'BEGIN:VEVENT',
				'UID:time-zone-authoring-oracle',
				'DTSTAMP:20400101T000000Z',
				'DTSTART:20400101T000000Z',
				'DTEND:20400101T010000Z',
				'SUMMARY:Time-zone authoring oracle',
				'END:VEVENT',
				'END:VCALENDAR',
				'',
			].join('\r\n'),
		),
	);
	const eventIndex = base.calendar.entries.findIndex(
		(entry) => entry.kind === 'component' && entry.name === 'VEVENT',
	);
	return serializeICalendarResource({
		kind: 'resource',
		originalIcs: '',
		calendar: {
			kind: 'component',
			name: 'VCALENDAR',
			entries: [
				...base.calendar.entries.slice(0, eventIndex),
				result.definition,
				...base.calendar.entries.slice(eventIndex),
			],
		},
	});
}

describe('calendar-event time-zone authoring selection', () => {
	it('prefers a verified reference for finite authoring and never embeds it', async () => {
		const referenceContext = verifiedReference();
		const result = await resolveCalendarEventTimeZoneAuthoring({
			calendarUrl: CALENDAR_URL,
			timeZone: TIME_ZONE,
			coverage: FINITE_COVERAGE,
			referenceContext,
		});
		expect(result).toMatchObject({ source: 'reference', embed: false });
		expect(result.definition.name).toBe('VTIMEZONE');
		expect(referenceContext.resolveReference).toHaveBeenCalledOnce();
		expect(referenceContext.resolveReference).toHaveBeenCalledWith(CALENDAR_URL, TIME_ZONE);
	});

	it('uses a verified reference for unbounded IANA authoring', async () => {
		const referenceContext = verifiedReference();
		await expect(
			resolveCalendarEventTimeZoneAuthoring({
				calendarUrl: CALENDAR_URL,
				timeZone: TIME_ZONE,
				coverage: UNBOUNDED_COVERAGE,
				referenceContext,
			}),
		).resolves.toMatchObject({ source: 'reference', embed: false });
	});

	it.each([
		['missing execution context', undefined],
		['unavailable service', context(async () => Promise.reject(new Error('private-unavailable')))],
		['unsafe service', context(async () => Promise.reject(new Error('private-unsafe')))],
		['unreachable service', context(async () => Promise.reject(new Error('private-unreachable')))],
		[
			'authentication-requiring service',
			context(async () => Promise.reject(new Error('private-auth'))),
		],
		[
			'malformed response',
			context(async () => ({
				timeZone: TIME_ZONE,
				etag: '"private-etag"',
				calendarData: 'private malformed calendar data',
				ruleSource: 'vtimezone',
			})),
		],
	] as const)('selects finite generated fallback for a %s', async (_label, referenceContext) => {
		const result = await resolveCalendarEventTimeZoneAuthoring({
			calendarUrl: CALENDAR_URL,
			timeZone: TIME_ZONE,
			coverage: FINITE_COVERAGE,
			...(referenceContext === undefined ? {} : { referenceContext }),
		});
		expect(result).toMatchObject({ source: 'generated', embed: true });
		const serialized = componentText(result);
		expect(serialized.match(/BEGIN:VTIMEZONE/g)).toHaveLength(1);
		expect(serialized).toContain('TZID:Europe/Prague');
		expect(serialized).not.toMatch(/private|RRULE|TZNAME|TZURL/i);
	});

	it('rejects unbounded fallback with the exact safe message and no generator activity', async () => {
		const referenceContext = context(async () => Promise.reject(new Error('private-reference')));
		const error = await resolveCalendarEventTimeZoneAuthoring({
			calendarUrl: CALENDAR_URL,
			timeZone: TIME_ZONE,
			coverage: UNBOUNDED_COVERAGE,
			referenceContext,
		}).catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(CalDavCalendarEventTimeZoneAuthoringError);
		expect(CalendarEventTimeZoneAuthoringErrorCode.UNBOUNDED_REQUIRES_REFERENCE).toBe(
			'UNBOUNDED_REQUIRES_REFERENCE',
		);
		expect(error).toMatchObject({
			code: 'UNBOUNDED_REQUIRES_REFERENCE',
			message: 'An unbounded IANA recurrence requires server time-zone reference support.',
		});
		expect(JSON.stringify(error)).not.toMatch(/private|Prague|calendar\.example|2040|etag/i);
	});

	it('maps every unsafe finite generation or coverage failure to one exact private-safe error', async () => {
		const error = await resolveCalendarEventTimeZoneAuthoring({
			calendarUrl: validateAbsoluteHttpUrl('https://calendar.example.test/private-calendar/'),
			timeZone: TIME_ZONE,
			coverage: {
				kind: 'finite',
				interval: {
					start: new Date('0001-01-01T00:00:00Z'),
					end: new Date('9999-12-31T23:59:59Z'),
				},
			},
		}).catch((failure: unknown) => failure);
		expect(error).toMatchObject({
			code: 'UNREPRESENTABLE_TIME_ZONE',
			message: 'The selected IANA time zone cannot be represented safely for this calendar event.',
		});
		expect(JSON.stringify(error)).not.toMatch(/Prague|calendar\.example|0001|9999|VTIMEZONE/i);
	});

	it('canonicalizes alias/case input and returns deterministic definitions for distinct zones', async () => {
		const coverage = {
			kind: 'finite' as const,
			interval: {
				start: new Date('2040-01-01T00:00:00Z'),
				end: new Date('2041-01-01T00:00:00Z'),
			},
		};
		const aliases = await Promise.all(
			['europe/prague', 'Europe/Prague'].map((timeZone) =>
				resolveCalendarEventTimeZoneAuthoring({
					calendarUrl: CALENDAR_URL,
					timeZone: canonicalizeIanaTimeZone(timeZone),
					coverage,
				}),
			),
		);
		expect(componentText(aliases[0]!)).toBe(componentText(aliases[1]!));

		const newYork = await resolveCalendarEventTimeZoneAuthoring({
			calendarUrl: CALENDAR_URL,
			timeZone: canonicalizeIanaTimeZone('America/New_York'),
			coverage,
		});
		expect(componentText(newYork)).not.toBe(componentText(aliases[0]!));
		expect(componentText(newYork)).toContain('TZID:America/New_York');
	});
});
