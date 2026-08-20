import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	resolveCalendarEventTimeZoneAuthoring: vi.fn(),
}));

vi.mock('../../nodes/CalDav/events/timeZoneAuthoring', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/events/timeZoneAuthoring')>()),
	resolveCalendarEventTimeZoneAuthoring: mocks.resolveCalendarEventTimeZoneAuthoring,
}));

import { bindCalendarEventTimeZoneExecutionContext } from '../../nodes/CalDav/events/timeZoneExecutionContext';
import {
	CalDavCalendarEventTimeZoneAuthoringError,
	CalendarEventTimeZoneAuthoringErrorCode,
} from '../../nodes/CalDav/events/timeZoneAuthoring';
import { upsertCalendarEvent } from '../../nodes/CalDav/events/upsert';
import { canonicalizeIanaTimeZone } from '../../nodes/CalDav/icalendar/timeZones';
import type { CalDavTransport } from '../../nodes/CalDav/transport/http';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';

describe('calendar-event Upsert IANA preparation ordering', () => {
	it('rejects an alarm Remove without an event UID before generators, clocks, or transport', async () => {
		const calendarUrl = validateAbsoluteHttpUrl('https://calendar.example.test/calendars/private/');
		const request = vi.fn();
		const transport: CalDavTransport = {
			serverUrl: 'https://calendar.example.test/',
			request,
		};
		const uidFactory = vi.fn(() => '00000000-0000-4000-8000-000000000045');
		const alarmUidFactory = vi.fn(() => '00000000-0000-4000-8000-000000000046');
		const clock = vi.fn(() => new Date('2040-01-01T00:00:00Z'));

		await expect(
			upsertCalendarEvent(
				transport,
				{
					calendarUrl,
					timeMode: 'timed',
					start: new Date('2040-01-02T10:00:00Z'),
					end: new Date('2040-01-02T11:00:00Z'),
					summary: 'No lookup',
					alarms: [{ kind: 'remove', selector: { kind: 'uid', uid: 'remote-alarm' } }],
				},
				{ clock, uidFactory, alarmUidFactory },
			),
		).rejects.toThrow('Additional Fields');
		expect(uidFactory).not.toHaveBeenCalled();
		expect(alarmUidFactory).not.toHaveBeenCalled();
		expect(clock).not.toHaveBeenCalled();
		expect(request).not.toHaveBeenCalled();
	});

	it('does not generate an omitted UID when finite IANA authoring selection fails', async () => {
		const calendarUrl = validateAbsoluteHttpUrl('https://calendar.example.test/calendars/private/');
		const request = vi.fn();
		const transport: CalDavTransport = {
			serverUrl: 'https://calendar.example.test/',
			request,
		};
		const resolveReference = vi.fn();
		bindCalendarEventTimeZoneExecutionContext(transport, { resolveReference });
		const failure = new CalDavCalendarEventTimeZoneAuthoringError(
			CalendarEventTimeZoneAuthoringErrorCode.UNREPRESENTABLE_TIME_ZONE,
		);
		mocks.resolveCalendarEventTimeZoneAuthoring.mockRejectedValueOnce(failure);
		const uidFactory = vi.fn(() => '00000000-0000-4000-8000-000000000044');
		const clock = vi.fn(() => new Date('2040-01-01T00:00:00Z'));

		const error = await upsertCalendarEvent(
			transport,
			{
				calendarUrl,
				timeMode: 'timed',
				start: new Date('2040-07-15T08:00:00Z'),
				end: new Date('2040-07-15T09:00:00Z'),
				timeZone: {
					timeZoneMode: 'iana',
					timeZone: canonicalizeIanaTimeZone('Europe/Prague'),
				},
				summary: 'Ordering oracle',
			},
			{ clock, uidFactory },
		).catch((caught: unknown) => caught);

		expect(error).toBe(failure);
		expect(mocks.resolveCalendarEventTimeZoneAuthoring).toHaveBeenCalledOnce();
		expect(uidFactory).not.toHaveBeenCalled();
		expect(clock).not.toHaveBeenCalled();
		expect(request).not.toHaveBeenCalled();
		expect(JSON.stringify(error)).not.toMatch(/Prague|calendar\.example|private/i);
	});
});
