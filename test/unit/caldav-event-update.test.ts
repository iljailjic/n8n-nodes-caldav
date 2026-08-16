import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	getCalendarEventByResourceUrl: vi.fn(),
	resolveCalendarEventByUid: vi.fn(),
	updateCalendarEventResource: vi.fn(),
}));

vi.mock('../../nodes/CalDav/events/getByResourceUrl', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/events/getByResourceUrl')>()),
	getCalendarEventByResourceUrl: mocks.getCalendarEventByResourceUrl,
}));

vi.mock('../../nodes/CalDav/events/resolveByUid', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/events/resolveByUid')>()),
	resolveCalendarEventByUid: mocks.resolveCalendarEventByUid,
}));

vi.mock('../../nodes/CalDav/events/mutations', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/events/mutations')>()),
	updateCalendarEventResource: mocks.updateCalendarEventResource,
}));

import {
	CalDavCalendarEventMutationError,
	CalendarEventMutationFailureCode,
} from '../../nodes/CalDav/events/mutations';
import {
	CalDavCalendarEventUpdateError,
	CalendarEventUpdateFailureCode,
	updateCalendarEvent,
} from '../../nodes/CalDav/events/update';
import type { CalendarEventUpdateInput } from '../../nodes/CalDav/events/update';
import { mapCalendarEventResource } from '../../nodes/CalDav/icalendar/eventReadModel';
import type { CalendarEventReadResult } from '../../nodes/CalDav/icalendar/eventReadModel';
import { parseICalendarResource } from '../../nodes/CalDav/icalendar/parser';
import { applyCalendarEventPatch } from '../../nodes/CalDav/icalendar/patcher';
import type { CalendarEventPatch } from '../../nodes/CalDav/icalendar/patcher';
import { serializeICalendarResource } from '../../nodes/CalDav/icalendar/serializer';
import { CalDavNotFoundError, CalDavResponseLimitError } from '../../nodes/CalDav/transport/http';
import type { CalDavTransport } from '../../nodes/CalDav/transport/http';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';
import type { AbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';

const CALENDAR_URL = validateAbsoluteHttpUrl('https://calendar.example.test/calendars/work/');
const RESOURCE_URL = validateAbsoluteHttpUrl(
	'https://calendar.example.test/calendars/work/original.ics',
);
const CANONICAL_URL = validateAbsoluteHttpUrl(
	'https://calendar.example.test/calendars/work/canonical.ics',
);
const CLOCK = new Date('2040-02-03T04:05:06.987Z');
const WHOLE_SECOND_CLOCK = new Date('2040-02-03T04:05:06.000Z');
const TRANSPORT: CalDavTransport = {
	serverUrl: 'https://calendar.example.test/',
	request: vi.fn(),
};

function calendarData(summary = 'Before update'): string {
	return [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//example.test//Update oracle//EN',
		'X-CALENDAR-ORACLE;X-PARAM="decoded,value":Opaque',
		'BEGIN:VEVENT',
		'UID:update@example.test',
		'DTSTAMP:20400101T000000Z',
		'DTSTART:20400102T100000Z',
		'DTEND:20400102T103000Z',
		`SUMMARY:${summary}`,
		'DESCRIPTION:Preserve or remove me',
		'X-UNKNOWN;X-SOURCE=MiXeD:opaque-value',
		'BEGIN:VALARM',
		'ACTION:DISPLAY',
		'DESCRIPTION:Private alarm',
		'TRIGGER:-PT10M',
		'END:VALARM',
		'END:VEVENT',
		'END:VCALENDAR',
		'',
	].join('\r\n');
}

function readResult(
	calendarText: string,
	options: {
		readonly resourceUrl?: AbsoluteHttpUrl;
		readonly etag?: string;
	} = {},
): CalendarEventReadResult {
	return mapCalendarEventResource({
		calendarUrl: CALENDAR_URL,
		resourceUrl: options.resourceUrl ?? RESOURCE_URL,
		...(Object.hasOwn(options, 'etag') ? { etag: options.etag } : {}),
		resource: parseICalendarResource(Buffer.from(calendarText, 'utf8')),
	});
}

function updatedRead(
	current: CalendarEventReadResult,
	patch: CalendarEventPatch,
	options: { readonly resourceUrl?: AbsoluteHttpUrl; readonly etag?: string } = {},
): { readonly calendarData: string; readonly result: CalendarEventReadResult } {
	const resource = applyCalendarEventPatch(current.context, patch, WHOLE_SECOND_CLOCK);
	const serialized = serializeICalendarResource(resource);
	return {
		calendarData: serialized,
		result: readResult(serialized, options),
	};
}

function resourceInput(
	patch: CalendarEventPatch,
	overrides: Partial<CalendarEventUpdateInput> = {},
): CalendarEventUpdateInput {
	return {
		calendarUrl: CALENDAR_URL,
		identifier: { kind: 'resourceUrl', resourceUrl: RESOURCE_URL },
		patch,
		...overrides,
	};
}

beforeEach(() => {
	mocks.getCalendarEventByResourceUrl.mockReset();
	mocks.resolveCalendarEventByUid.mockReset();
	mocks.updateCalendarEventResource.mockReset();
	vi.mocked(TRANSPORT.request).mockReset();
});

describe('calendar event Update coordinator requests and authoritative result', () => {
	it('performs URL GET -> conditional PUT -> GET, preserves unknown data, and returns frozen read-back', async () => {
		const patch: CalendarEventPatch = {
			summary: { kind: 'set', value: 'After update' },
			description: { kind: 'remove' },
		};
		const current = readResult(calendarData(), { etag: 'W/"snapshot"' });
		const confirmed = updatedRead(current, patch, {
			resourceUrl: CANONICAL_URL,
			etag: ' "current server etag" ',
		});
		mocks.getCalendarEventByResourceUrl
			.mockResolvedValueOnce(current)
			.mockResolvedValueOnce(confirmed.result);
		mocks.updateCalendarEventResource.mockResolvedValue({
			statusCode: 204,
			resourceUrl: CANONICAL_URL,
		});
		const clock = vi.fn().mockReturnValue(CLOCK);

		const result = await updateCalendarEvent(
			TRANSPORT,
			resourceInput(patch, { etag: ' W/"caller exact" ' }),
			clock,
		);

		expect(mocks.getCalendarEventByResourceUrl).toHaveBeenNthCalledWith(
			1,
			TRANSPORT,
			CALENDAR_URL,
			RESOURCE_URL,
			{ allowMissingEtag: true },
		);
		expect(mocks.updateCalendarEventResource).toHaveBeenCalledWith(
			TRANSPORT,
			CALENDAR_URL,
			RESOURCE_URL,
			confirmed.calendarData,
			' W/"caller exact" ',
		);
		expect(mocks.getCalendarEventByResourceUrl).toHaveBeenNthCalledWith(
			2,
			TRANSPORT,
			CALENDAR_URL,
			CANONICAL_URL,
		);
		expect(clock).toHaveBeenCalledTimes(1);
		expect(result).toEqual({
			calendarUrl: CALENDAR_URL,
			resourceUrl: CANONICAL_URL,
			etag: ' "current server etag" ',
			uid: 'update@example.test',
			summary: 'After update',
			timeMode: 'timed',
			accessMode: 'editable',
			start: '2040-01-02T10:00:00Z',
			end: '2040-01-02T10:30:00Z',
		});
		expect(Object.isFrozen(result)).toBe(true);
		expect(confirmed.calendarData).toContain('X-UNKNOWN;X-SOURCE=MiXeD:opaque-value');
		expect(confirmed.calendarData).toContain('BEGIN:VALARM');
	});

	it('uses one UID REPORT snapshot, a server-derived empty ETag, and one GET read-back', async () => {
		const patch: CalendarEventPatch = { location: { kind: 'set', value: '' } };
		const current = readResult(calendarData(), { etag: '' });
		const confirmed = updatedRead(current, patch, { etag: '"new"' });
		mocks.resolveCalendarEventByUid.mockResolvedValue(current);
		mocks.getCalendarEventByResourceUrl.mockResolvedValue(confirmed.result);
		mocks.updateCalendarEventResource.mockResolvedValue({
			statusCode: 200,
			resourceUrl: RESOURCE_URL,
			etag: 'W/"put-etag-need-not-match"',
		});

		await expect(
			updateCalendarEvent(
				TRANSPORT,
				{
					calendarUrl: CALENDAR_URL,
					identifier: { kind: 'uid', uid: 'update@example.test' },
					patch,
				},
				() => CLOCK,
			),
		).resolves.toMatchObject({ location: '', etag: '"new"' });
		expect(mocks.resolveCalendarEventByUid).toHaveBeenCalledWith(
			TRANSPORT,
			CALENDAR_URL,
			'update@example.test',
			{ allowMissingEtag: true },
		);
		expect(mocks.updateCalendarEventResource.mock.calls[0][4]).toBe('');
		expect(mocks.getCalendarEventByResourceUrl).toHaveBeenCalledTimes(1);
	});

	it('uses the snapshot validator only when the caller ETag is absent or empty', async () => {
		const patch: CalendarEventPatch = { summary: { kind: 'set', value: 'Changed' } };
		const current = readResult(calendarData(), { etag: 'W/"snapshot exact"' });
		const confirmed = updatedRead(current, patch, { etag: '"confirmed"' });
		mocks.getCalendarEventByResourceUrl
			.mockResolvedValueOnce(current)
			.mockResolvedValueOnce(confirmed.result)
			.mockResolvedValueOnce(current)
			.mockResolvedValueOnce(confirmed.result);
		mocks.updateCalendarEventResource.mockResolvedValue({
			statusCode: 204,
			resourceUrl: RESOURCE_URL,
		});

		await updateCalendarEvent(TRANSPORT, resourceInput(patch), () => CLOCK);
		await updateCalendarEvent(TRANSPORT, resourceInput(patch, { etag: '' }), () => CLOCK);

		expect(mocks.updateCalendarEventResource.mock.calls.map((call) => call[4])).toEqual([
			'W/"snapshot exact"',
			'W/"snapshot exact"',
		]);
	});
});

describe('calendar event Update coordinator fail-fast and confirmation behavior', () => {
	it('rejects an empty patch before any preservation read or clock access', async () => {
		const clock = vi.fn().mockReturnValue(CLOCK);

		await expect(updateCalendarEvent(TRANSPORT, resourceInput({}), clock)).rejects.toMatchObject({
			code: 'NO_CHANGES',
			message: 'The calendar event patch does not contain any changes.',
		});
		expect(mocks.getCalendarEventByResourceUrl).not.toHaveBeenCalled();
		expect(mocks.resolveCalendarEventByUid).not.toHaveBeenCalled();
		expect(clock).not.toHaveBeenCalled();
	});

	it('rejects missing snapshot ETag before clock, serialization, or PUT', async () => {
		mocks.getCalendarEventByResourceUrl.mockResolvedValue(readResult(calendarData()));
		const clock = vi.fn().mockReturnValue(CLOCK);

		await expect(
			updateCalendarEvent(
				TRANSPORT,
				resourceInput({ summary: { kind: 'set', value: 'Changed' } }),
				clock,
			),
		).rejects.toMatchObject({ code: CalendarEventMutationFailureCode.MISSING_ETAG });
		expect(clock).not.toHaveBeenCalled();
		expect(mocks.updateCalendarEventResource).not.toHaveBeenCalled();
	});

	it('reads a throwing clock once but lets semantic no-op win before clock validation', async () => {
		mocks.getCalendarEventByResourceUrl.mockResolvedValue(
			readResult(calendarData(), { etag: '"snapshot"' }),
		);
		const clock = vi.fn(() => {
			throw new Error('private-clock-sentinel');
		});

		await expect(
			updateCalendarEvent(
				TRANSPORT,
				resourceInput({ summary: { kind: 'set', value: 'Before update' } }),
				clock,
			),
		).rejects.toMatchObject({
			code: 'NO_CHANGES',
			message: 'The calendar event patch does not contain any changes.',
		});
		expect(clock).toHaveBeenCalledTimes(1);
		expect(mocks.updateCalendarEventResource).not.toHaveBeenCalled();
	});

	it('maps an invalid clock for an effective patch to Update INVALID_CLOCK before PUT', async () => {
		mocks.getCalendarEventByResourceUrl.mockResolvedValue(
			readResult(calendarData(), { etag: '"snapshot"' }),
		);

		await expect(
			updateCalendarEvent(
				TRANSPORT,
				resourceInput({ summary: { kind: 'set', value: 'Changed' } }),
				() => new Date(Number.NaN),
			),
		).rejects.toEqual(
			expect.objectContaining({
				name: 'CalDavCalendarEventUpdateError',
				code: CalendarEventUpdateFailureCode.INVALID_CLOCK,
				message: 'The calendar event clock is invalid.',
			}),
		);
		expect(mocks.updateCalendarEventResource).not.toHaveBeenCalled();
	});

	it('propagates a stale conditional mutation without a read-back or retry', async () => {
		const current = readResult(calendarData(), { etag: '"snapshot"' });
		mocks.getCalendarEventByResourceUrl.mockResolvedValue(current);
		mocks.updateCalendarEventResource.mockRejectedValue(
			new CalDavCalendarEventMutationError(CalendarEventMutationFailureCode.CONCURRENCY_CONFLICT),
		);

		await expect(
			updateCalendarEvent(
				TRANSPORT,
				resourceInput({ summary: { kind: 'set', value: 'Changed' } }),
				() => CLOCK,
			),
		).rejects.toMatchObject({ code: CalendarEventMutationFailureCode.CONCURRENCY_CONFLICT });
		expect(mocks.getCalendarEventByResourceUrl).toHaveBeenCalledTimes(1);
		expect(mocks.updateCalendarEventResource).toHaveBeenCalledTimes(1);
	});

	it('converts every post-PUT read, UID, semantic, or metadata failure to confirmation failure', async () => {
		const patch: CalendarEventPatch = { summary: { kind: 'set', value: 'Changed' } };
		const current = readResult(calendarData(), { etag: '"snapshot"' });
		const mismatch = readResult(calendarData('Server rewrote something else'), {
			etag: '"new"',
		});
		mocks.updateCalendarEventResource.mockResolvedValue({
			statusCode: 204,
			resourceUrl: RESOURCE_URL,
		});
		mocks.getCalendarEventByResourceUrl
			.mockResolvedValueOnce(current)
			.mockResolvedValueOnce(mismatch);

		await expect(
			updateCalendarEvent(TRANSPORT, resourceInput(patch), () => CLOCK),
		).rejects.toMatchObject({
			code: CalendarEventUpdateFailureCode.CONFIRMATION_FAILED,
			message: 'The event was updated, but its current state could not be verified.',
		});

		mocks.getCalendarEventByResourceUrl
			.mockReset()
			.mockResolvedValueOnce(current)
			.mockRejectedValueOnce(new CalDavNotFoundError(404));
		await expect(
			updateCalendarEvent(TRANSPORT, resourceInput(patch), () => CLOCK),
		).rejects.toMatchObject({
			code: CalendarEventUpdateFailureCode.CONFIRMATION_FAILED,
			statusCode: 404,
		});

		mocks.getCalendarEventByResourceUrl.mockReset().mockResolvedValueOnce(current);
		mocks.updateCalendarEventResource.mockRejectedValueOnce(
			new CalDavCalendarEventMutationError(CalendarEventMutationFailureCode.INVALID_RESPONSE),
		);
		await expect(
			updateCalendarEvent(TRANSPORT, resourceInput(patch), () => CLOCK),
		).rejects.toMatchObject({ code: CalendarEventUpdateFailureCode.CONFIRMATION_FAILED });

		mocks.getCalendarEventByResourceUrl.mockReset().mockResolvedValueOnce(current);
		mocks.updateCalendarEventResource.mockRejectedValueOnce(new CalDavResponseLimitError());
		await expect(
			updateCalendarEvent(TRANSPORT, resourceInput(patch), () => CLOCK),
		).rejects.toMatchObject({ code: CalendarEventUpdateFailureCode.CONFIRMATION_FAILED });
	});

	it('rejects a post-PUT authoritative read-back with a different UID without retrying', async () => {
		const patch: CalendarEventPatch = { summary: { kind: 'set', value: 'Changed' } };
		const current = readResult(calendarData(), { etag: '"snapshot"' });
		const confirmed = updatedRead(current, patch, { etag: '"new"' });
		const mismatchedUid = readResult(
			confirmed.calendarData.replace(
				'UID:update@example.test',
				'UID:different-read-back@example.test',
			),
			{ etag: '"new"' },
		);
		mocks.getCalendarEventByResourceUrl
			.mockResolvedValueOnce(current)
			.mockResolvedValueOnce(mismatchedUid);
		mocks.updateCalendarEventResource.mockResolvedValue({
			statusCode: 204,
			resourceUrl: RESOURCE_URL,
		});

		const result = await updateCalendarEvent(TRANSPORT, resourceInput(patch), () => CLOCK).catch(
			(error: unknown) => error,
		);

		expect(result).toBeInstanceOf(CalDavCalendarEventUpdateError);
		expect(result).toMatchObject({
			code: CalendarEventUpdateFailureCode.CONFIRMATION_FAILED,
			message: 'The event was updated, but its current state could not be verified.',
		});
		expect(mocks.getCalendarEventByResourceUrl).toHaveBeenCalledTimes(2);
		expect(mocks.updateCalendarEventResource).toHaveBeenCalledTimes(1);
		expect(mocks.resolveCalendarEventByUid).not.toHaveBeenCalled();
		expect(vi.mocked(TRANSPORT.request)).not.toHaveBeenCalled();
		expect(mocks.getCalendarEventByResourceUrl.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.updateCalendarEventResource.mock.invocationCallOrder[0]!,
		);
		expect(mocks.updateCalendarEventResource.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.getCalendarEventByResourceUrl.mock.invocationCallOrder[1]!,
		);
	});

	it('rejects a resolver snapshot or read-back that leaves the selected calendar', async () => {
		const patch: CalendarEventPatch = { summary: { kind: 'set', value: 'Changed' } };
		const current = readResult(calendarData(), { etag: '"snapshot"' });
		const foreignCalendar = validateAbsoluteHttpUrl(
			'https://calendar.example.test/calendars/foreign/',
		);
		mocks.getCalendarEventByResourceUrl.mockResolvedValueOnce({
			...current,
			event: {
				...current.event,
				calendarUrl: foreignCalendar,
				resourceUrl: validateAbsoluteHttpUrl(
					'https://calendar.example.test/calendars/foreign/event.ics',
				),
			},
		});

		await expect(
			updateCalendarEvent(TRANSPORT, resourceInput(patch), () => CLOCK),
		).rejects.toMatchObject({ code: 'INVALID_CALENDAR_EVENT_RESOURCE_RESPONSE' });
		expect(mocks.updateCalendarEventResource).not.toHaveBeenCalled();

		const confirmed = updatedRead(current, patch, { etag: '"new"' });
		mocks.getCalendarEventByResourceUrl
			.mockReset()
			.mockResolvedValueOnce(current)
			.mockResolvedValueOnce({
				...confirmed.result,
				event: {
					...confirmed.result.event,
					calendarUrl: foreignCalendar,
					resourceUrl: validateAbsoluteHttpUrl(
						'https://calendar.example.test/calendars/foreign/event.ics',
					),
				},
			});
		mocks.updateCalendarEventResource.mockResolvedValueOnce({
			statusCode: 204,
			resourceUrl: RESOURCE_URL,
		});
		await expect(
			updateCalendarEvent(TRANSPORT, resourceInput(patch), () => CLOCK),
		).rejects.toMatchObject({ code: CalendarEventUpdateFailureCode.CONFIRMATION_FAILED });
	});

	it('rejects only malformed coordinator envelopes as INVALID_INPUT without exposing values', async () => {
		const malformed = {
			calendarUrl: CALENDAR_URL,
			identifier: { kind: 'private-kind', uid: 'private-uid' },
			patch: { summary: { kind: 'set', value: 'private-summary' } },
		} as unknown as CalendarEventUpdateInput;

		const error = await updateCalendarEvent(TRANSPORT, malformed, () => CLOCK).catch(
			(failure: unknown) => failure,
		);
		expect(error).toBeInstanceOf(CalDavCalendarEventUpdateError);
		expect(error).toMatchObject({
			code: CalendarEventUpdateFailureCode.INVALID_INPUT,
			message: 'The calendar event update input is invalid.',
		});
		expect(JSON.stringify(error)).not.toMatch(/private-kind|private-uid|private-summary/);
		expect(mocks.getCalendarEventByResourceUrl).not.toHaveBeenCalled();
		expect(mocks.resolveCalendarEventByUid).not.toHaveBeenCalled();
	});
});
