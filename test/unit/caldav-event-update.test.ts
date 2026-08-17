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
import type { ICalendarComponent, ICalendarEntry } from '../../nodes/CalDav/icalendar/parser';
import { applyCalendarEventPatch } from '../../nodes/CalDav/icalendar/patcher';
import type { CalendarEventPatch } from '../../nodes/CalDav/icalendar/patcher';
import { serializeICalendarResource } from '../../nodes/CalDav/icalendar/serializer';
import { CalDavNotFoundError, CalDavResponseLimitError } from '../../nodes/CalDav/transport/http';
import type { CalDavTransport } from '../../nodes/CalDav/transport/http';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';
import type { AbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';
import { SUPPORTED_EMBEDDED_IANA_EVENT } from './fixtures/time-zones/synthetic-time-zone-fixtures';

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
		readonly timeZoneDefinition?: ICalendarComponent;
	} = {},
): CalendarEventReadResult {
	return mapCalendarEventResource({
		calendarUrl: CALENDAR_URL,
		resourceUrl: options.resourceUrl ?? RESOURCE_URL,
		...(Object.hasOwn(options, 'etag') ? { etag: options.etag } : {}),
		resource: parseICalendarResource(Buffer.from(calendarText, 'utf8')),
		...(options.timeZoneDefinition === undefined
			? {}
			: { timeZoneDefinition: options.timeZoneDefinition }),
	});
}

function timeZoneDefinition(calendarText: string): ICalendarComponent {
	const definitions = parseICalendarResource(
		Buffer.from(calendarText, 'utf8'),
	).calendar.entries.filter(
		(entry): entry is ICalendarComponent =>
			entry.kind === 'component' && entry.name === 'VTIMEZONE',
	);
	if (definitions.length !== 1) throw new Error('Expected exactly one synthetic VTIMEZONE.');
	return definitions[0]!;
}

function timeZoneDefinitionText(calendarText: string): string {
	const start = calendarText.indexOf('BEGIN:VTIMEZONE\r\n');
	const marker = 'END:VTIMEZONE';
	const end = calendarText.indexOf(marker, start);
	if (start < 0 || end < 0) throw new Error('Expected one serialized synthetic VTIMEZONE.');
	return calendarText.slice(start, end + marker.length);
}

function reorderGeneratedTimeZoneLikeVObject(calendarText: string): string {
	const resource = parseICalendarResource(Buffer.from(calendarText, 'utf8'));
	const propertyOrder = new Map([
		['DTSTART', 0],
		['RDATE', 1],
		['TZOFFSETFROM', 2],
		['TZOFFSETTO', 3],
	]);
	const componentOrder = new Map([
		['STANDARD', 0],
		['DAYLIGHT', 1],
	]);
	const reorderObservance = (entry: ICalendarEntry): ICalendarEntry =>
		entry.kind === 'component' && ['STANDARD', 'DAYLIGHT'].includes(entry.name)
			? {
					...entry,
					entries: [...entry.entries].sort(
						(left, right) =>
							(propertyOrder.get(left.name) ?? 4) - (propertyOrder.get(right.name) ?? 4),
					),
				}
			: entry;
	const entries = resource.calendar.entries.map((entry): ICalendarEntry => {
		if (entry.kind !== 'component' || entry.name !== 'VTIMEZONE') return entry;
		return {
			...entry,
			entries: entry.entries.map(reorderObservance).sort((left, right) => {
				if (left.kind !== 'component' || right.kind !== 'component') return 0;
				return (componentOrder.get(left.name) ?? 2) - (componentOrder.get(right.name) ?? 2);
			}),
		};
	});
	return serializeICalendarResource({
		...resource,
		calendar: { ...resource.calendar, entries },
	});
}

function calendarDataWithTimeZone(
	timeZone: string,
	retainedEventProperty?: string,
): { readonly calendarData: string; readonly referenceData: string } {
	const referenceData = SUPPORTED_EMBEDDED_IANA_EVENT.replaceAll('Europe/Prague', timeZone);
	const definition = timeZoneDefinitionText(referenceData);
	const calendarWithDefinition = calendarData().replace(
		'BEGIN:VEVENT',
		`${definition}\r\nBEGIN:VEVENT`,
	);
	return {
		calendarData:
			retainedEventProperty === undefined
				? calendarWithDefinition
				: calendarWithDefinition.replace(
						'SUMMARY:Before update',
						`SUMMARY:Before update\r\n${retainedEventProperty}`,
					),
		referenceData,
	};
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
	it('preserves a source TZID alias when timezone is omitted', async () => {
		const aliased = SUPPORTED_EMBEDDED_IANA_EVENT.replaceAll('Europe/Prague', 'US/Eastern');
		const current = readResult(aliased, { etag: '"snapshot"' });
		mocks.getCalendarEventByResourceUrl
			.mockResolvedValueOnce(current)
			.mockImplementationOnce(async () => {
				const sent = mocks.updateCalendarEventResource.mock.calls[0]![3] as string;
				return readResult(sent, { etag: '"implicit-confirmed"' });
			});
		mocks.updateCalendarEventResource.mockResolvedValue({
			statusCode: 204,
			resourceUrl: RESOURCE_URL,
		});

		await updateCalendarEvent(
			TRANSPORT,
			resourceInput({ start: { kind: 'set', value: new Date('2040-07-15T06:00:00Z') } }),
			() => CLOCK,
		);

		const implicit = mocks.updateCalendarEventResource.mock.calls[0]![3] as string;
		expect(implicit).toContain(
			'DTSTART;TZID=US/Eastern:20400715T090000\r\nDTEND;TZID=US/Eastern:20400715T110000',
		);
	});

	it('resolves an explicit canonical IANA target instead of reusing its source alias definition', async () => {
		const aliased = SUPPORTED_EMBEDDED_IANA_EVENT.replaceAll('Europe/Prague', 'US/Eastern');
		const canonicalReference = SUPPORTED_EMBEDDED_IANA_EVENT.replaceAll(
			'Europe/Prague',
			'America/New_York',
		);
		const current = readResult(aliased, { etag: '"snapshot"' });
		const resolveReference = vi.fn().mockResolvedValue({
			timeZone: 'America/New_York',
			etag: '"canonical-reference"',
			calendarData: canonicalReference,
			ruleSource: 'vtimezone',
		});
		mocks.getCalendarEventByResourceUrl
			.mockResolvedValueOnce(current)
			.mockImplementationOnce(async () => {
				const sent = mocks.updateCalendarEventResource.mock.calls[0]![3] as string;
				return readResult(sent, {
					etag: '"explicit-confirmed"',
					timeZoneDefinition: timeZoneDefinition(canonicalReference),
				});
			});
		mocks.updateCalendarEventResource.mockResolvedValue({
			statusCode: 204,
			resourceUrl: RESOURCE_URL,
		});

		await expect(
			updateCalendarEvent(
				TRANSPORT,
				resourceInput({
					timeZone: {
						kind: 'set',
						value: { timeZoneMode: 'iana', timeZone: 'America/New_York' },
					},
				}),
				() => CLOCK,
				{ resolveReference },
			),
		).resolves.toMatchObject({
			accessMode: 'editable',
			etag: '"explicit-confirmed"',
			timeZoneMode: 'iana',
			timeZone: 'America/New_York',
		});
		const explicit = mocks.updateCalendarEventResource.mock.calls[0]![3] as string;
		expect(explicit).toContain(
			'DTSTART;TZID=America/New_York:20400715T100000\r\nDTEND;TZID=America/New_York:20400715T110000',
		);
		expect(explicit).not.toContain('DTSTART;TZID=US/Eastern:');
		expect(explicit).not.toContain('DTEND;TZID=US/Eastern:');
		expect(resolveReference).toHaveBeenCalledOnce();
		expect(resolveReference).toHaveBeenCalledWith(CALENDAR_URL, 'America/New_York');
		expect(mocks.updateCalendarEventResource).toHaveBeenCalledOnce();
		expect(mocks.getCalendarEventByResourceUrl).toHaveBeenCalledTimes(2);
		expect(mocks.getCalendarEventByResourceUrl.mock.invocationCallOrder[0]).toBeLessThan(
			resolveReference.mock.invocationCallOrder[0]!,
		);
		expect(resolveReference.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.updateCalendarEventResource.mock.invocationCallOrder[0]!,
		);
		expect(mocks.updateCalendarEventResource.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.getCalendarEventByResourceUrl.mock.invocationCallOrder[1]!,
		);
	});

	it('accepts Radicale vobject reordering of a generated VTIMEZONE during confirmation', async () => {
		const current = readResult(SUPPORTED_EMBEDDED_IANA_EVENT, { etag: '"snapshot"' });
		const resolveReference = vi.fn().mockRejectedValue(new Error('unavailable'));
		mocks.getCalendarEventByResourceUrl
			.mockResolvedValueOnce(current)
			.mockImplementationOnce(async () => {
				const sent = mocks.updateCalendarEventResource.mock.calls[0]![3] as string;
				const reordered = reorderGeneratedTimeZoneLikeVObject(sent);
				expect(reordered).not.toBe(sent);
				return readResult(reordered, { etag: '"confirmed"' });
			});
		mocks.updateCalendarEventResource.mockResolvedValue({
			statusCode: 204,
			resourceUrl: RESOURCE_URL,
		});

		await expect(
			updateCalendarEvent(
				TRANSPORT,
				resourceInput({
					timeZone: {
						kind: 'set',
						value: { timeZoneMode: 'iana', timeZone: 'America/New_York' },
					},
				}),
				() => CLOCK,
				{ resolveReference },
			),
		).resolves.toMatchObject({
			etag: '"confirmed"',
			timeZoneMode: 'iana',
			timeZone: 'America/New_York',
		});
		expect(resolveReference).toHaveBeenCalledOnce();
		expect(mocks.updateCalendarEventResource).toHaveBeenCalledOnce();
		expect(mocks.getCalendarEventByResourceUrl).toHaveBeenCalledTimes(2);
	});

	it('rejects changed VTIMEZONE data even when its entries are reordered', async () => {
		const current = readResult(SUPPORTED_EMBEDDED_IANA_EVENT, { etag: '"snapshot"' });
		const resolveReference = vi.fn().mockRejectedValue(new Error('unavailable'));
		mocks.getCalendarEventByResourceUrl
			.mockResolvedValueOnce(current)
			.mockImplementationOnce(async () => {
				const sent = mocks.updateCalendarEventResource.mock.calls[0]![3] as string;
				const reordered = reorderGeneratedTimeZoneLikeVObject(sent);
				const changed = reordered.replace(
					/RDATE:(\d{8}T\d{5})\d/,
					(_match, prefix: string) => `RDATE:${prefix}1`,
				);
				expect(changed).not.toBe(reordered);
				const readBack = readResult(changed, { etag: '"changed"' });
				expect(readBack.event.accessMode).toBe('editable');
				return readBack;
			});
		mocks.updateCalendarEventResource.mockResolvedValue({
			statusCode: 204,
			resourceUrl: RESOURCE_URL,
		});

		await expect(
			updateCalendarEvent(
				TRANSPORT,
				resourceInput({
					timeZone: {
						kind: 'set',
						value: { timeZoneMode: 'iana', timeZone: 'America/New_York' },
					},
				}),
				() => CLOCK,
				{ resolveReference },
			),
		).rejects.toMatchObject({ code: CalendarEventUpdateFailureCode.CONFIRMATION_FAILED });
		expect(mocks.updateCalendarEventResource).toHaveBeenCalledOnce();
		expect(mocks.getCalendarEventByResourceUrl).toHaveBeenCalledTimes(2);
	});

	it('preserves embedded IANA authority and representation when a bound changes without a timezone patch', async () => {
		const current = readResult(SUPPORTED_EMBEDDED_IANA_EVENT, { etag: '"snapshot"' });
		mocks.getCalendarEventByResourceUrl
			.mockResolvedValueOnce(current)
			.mockImplementationOnce(async () => {
				const sent = mocks.updateCalendarEventResource.mock.calls[0]![3] as string;
				return readResult(sent, { etag: '"confirmed"' });
			});
		mocks.updateCalendarEventResource.mockResolvedValue({
			statusCode: 204,
			resourceUrl: RESOURCE_URL,
		});

		const result = await updateCalendarEvent(
			TRANSPORT,
			resourceInput({ start: { kind: 'set', value: new Date('2040-07-15T06:00:00Z') } }),
			() => CLOCK,
		);

		const sent = mocks.updateCalendarEventResource.mock.calls[0]![3] as string;
		expect(sent).toContain('BEGIN:VTIMEZONE');
		expect(sent).toContain(
			'DTSTART;TZID=Europe/Prague:20400715T090000\r\nDTEND;TZID=Europe/Prague:20400715T110000',
		);
		expect(result).toMatchObject({
			start: '2040-07-15T06:00:00Z',
			end: '2040-07-15T08:00:00Z',
			timeZoneMode: 'iana',
			timeZone: 'Europe/Prague',
		});
	});

	it('performs a non-time IANA update without reference lookup or generation', async () => {
		const current = readResult(SUPPORTED_EMBEDDED_IANA_EVENT, { etag: '"snapshot"' });
		const resolveReference = vi.fn().mockRejectedValue(new Error('private-reference'));
		mocks.getCalendarEventByResourceUrl
			.mockResolvedValueOnce(current)
			.mockImplementationOnce(async () => {
				const sent = mocks.updateCalendarEventResource.mock.calls[0]![3] as string;
				return readResult(sent, { etag: '"confirmed"' });
			});
		mocks.updateCalendarEventResource.mockResolvedValue({
			statusCode: 204,
			resourceUrl: RESOURCE_URL,
		});

		await expect(
			updateCalendarEvent(
				TRANSPORT,
				resourceInput({ summary: { kind: 'set', value: 'Text only' } }),
				() => CLOCK,
				{ resolveReference },
			),
		).resolves.toMatchObject({ summary: 'Text only', timeZone: 'Europe/Prague' });
		expect(resolveReference).not.toHaveBeenCalled();
		const sent = mocks.updateCalendarEventResource.mock.calls[0]![3] as string;
		expect(sent).toContain('TZID:Europe/Prague');
		expect(sent).toContain('DTSTART;TZID=Europe/Prague:20400715T100000');
	});

	it('rejects unsafe finite fallback after the resource read but before patch clock or PUT', async () => {
		const current = readResult(calendarData(), { etag: '"snapshot"' });
		mocks.getCalendarEventByResourceUrl.mockResolvedValueOnce(current);
		const resolveReference = vi.fn().mockRejectedValue(new Error('private-reference'));
		const clock = vi.fn(() => CLOCK);
		const error = await updateCalendarEvent(
			TRANSPORT,
			resourceInput({
				timeMode: 'timed',
				timeZone: {
					kind: 'set',
					value: { timeZoneMode: 'iana', timeZone: 'Europe/Prague' },
				},
				start: { kind: 'set', value: new Date('0001-01-01T00:00:00Z') },
				end: { kind: 'set', value: new Date('9999-12-31T23:59:59Z') },
			} as CalendarEventPatch),
			clock,
			{ resolveReference },
		).catch((failure: unknown) => failure);
		expect(error).toMatchObject({
			code: 'UNREPRESENTABLE_TIME_ZONE',
			message: 'The selected IANA time zone cannot be represented safely for this calendar event.',
		});
		expect(mocks.getCalendarEventByResourceUrl).toHaveBeenCalledOnce();
		expect(resolveReference).toHaveBeenCalledOnce();
		expect(clock).not.toHaveBeenCalled();
		expect(mocks.updateCalendarEventResource).not.toHaveBeenCalled();
		expect(JSON.stringify(error)).not.toMatch(/Prague|calendar\.example|0001|9999|private/i);
	});

	it('rejects an unsafe preserved target definition before reference, patch clock, or PUT', async () => {
		const unsafeTargetDefinition = [
			'BEGIN:VTIMEZONE',
			'TZID:US/Eastern',
			'BEGIN:STANDARD',
			'DTSTART:20400101T000000',
			'TZOFFSETFROM:-0500',
			'END:STANDARD',
			'END:VTIMEZONE',
		].join('\r\n');
		const resourceWithUnsafeTarget = calendarData().replace(
			'BEGIN:VEVENT',
			`${unsafeTargetDefinition}\r\nBEGIN:VEVENT`,
		);
		mocks.getCalendarEventByResourceUrl.mockResolvedValueOnce(
			readResult(resourceWithUnsafeTarget, { etag: '"snapshot"' }),
		);
		const resolveReference = vi.fn().mockResolvedValue({
			timeZone: 'America/New_York',
			etag: '"private-reference-etag"',
			calendarData: SUPPORTED_EMBEDDED_IANA_EVENT.replaceAll('Europe/Prague', 'America/New_York'),
			ruleSource: 'vtimezone',
		});
		const clock = vi.fn(() => CLOCK);

		const error = await updateCalendarEvent(
			TRANSPORT,
			resourceInput({
				timeZone: {
					kind: 'set',
					value: { timeZoneMode: 'iana', timeZone: 'America/New_York' },
				},
			}),
			clock,
			{ resolveReference },
		).catch((failure: unknown) => failure);

		expect(error).toMatchObject({
			code: 'UNREPRESENTABLE_TIME_ZONE',
			message: 'The selected IANA time zone cannot be represented safely for this calendar event.',
		});
		expect(mocks.getCalendarEventByResourceUrl).toHaveBeenCalledOnce();
		expect(resolveReference).not.toHaveBeenCalled();
		expect(clock).not.toHaveBeenCalled();
		expect(mocks.updateCalendarEventResource).not.toHaveBeenCalled();
		expect(JSON.stringify(error)).not.toMatch(
			/New_York|US\/Eastern|calendar\.example|2040|private|VTIMEZONE/i,
		);
	});

	it('removes one unreferenced safe target definition when verified reference authoring succeeds', async () => {
		const { calendarData: currentData, referenceData } =
			calendarDataWithTimeZone('America/New_York');
		const current = readResult(currentData, { etag: '"snapshot"' });
		const resolveReference = vi.fn().mockResolvedValue({
			timeZone: 'America/New_York',
			etag: '"reference"',
			calendarData: referenceData,
			ruleSource: 'vtimezone',
		});
		mocks.getCalendarEventByResourceUrl
			.mockResolvedValueOnce(current)
			.mockImplementationOnce(async () => {
				const sent = mocks.updateCalendarEventResource.mock.calls[0]![3] as string;
				return readResult(sent, {
					etag: '"confirmed"',
					timeZoneDefinition: timeZoneDefinition(referenceData),
				});
			});
		mocks.updateCalendarEventResource.mockResolvedValue({
			statusCode: 204,
			resourceUrl: RESOURCE_URL,
		});

		await expect(
			updateCalendarEvent(
				TRANSPORT,
				resourceInput({
					timeZone: {
						kind: 'set',
						value: { timeZoneMode: 'iana', timeZone: 'America/New_York' },
					},
				}),
				() => CLOCK,
				{ resolveReference },
			),
		).resolves.toMatchObject({
			accessMode: 'editable',
			timeZoneMode: 'iana',
			timeZone: 'America/New_York',
		});
		const sent = mocks.updateCalendarEventResource.mock.calls[0]![3] as string;
		expect(sent).not.toContain('BEGIN:VTIMEZONE');
		expect(sent).toContain('DTSTART;TZID=America/New_York:');
		expect(sent).toContain('DTEND;TZID=America/New_York:');
		expect(mocks.getCalendarEventByResourceUrl).toHaveBeenCalledTimes(2);
		expect(resolveReference).toHaveBeenCalledOnce();
		expect(mocks.updateCalendarEventResource).toHaveBeenCalledOnce();
		expect(mocks.getCalendarEventByResourceUrl.mock.invocationCallOrder[0]).toBeLessThan(
			resolveReference.mock.invocationCallOrder[0]!,
		);
		expect(resolveReference.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.updateCalendarEventResource.mock.invocationCallOrder[0]!,
		);
		expect(mocks.updateCalendarEventResource.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.getCalendarEventByResourceUrl.mock.invocationCallOrder[1]!,
		);
	});

	it.each([
		['retained target reference', 'X-RELATED;TZID=US/Eastern:20400102T101500'],
		['uncertain retained ownership', 'X-RELATED;TZID=Private/Unparseable:20400102T101500'],
	])('rejects target-definition removal for %s', async (_scenario, retainedProperty) => {
		const { calendarData: currentData, referenceData } = calendarDataWithTimeZone(
			'US/Eastern',
			retainedProperty,
		);
		const current = readResult(currentData, { etag: '"snapshot"' });
		mocks.getCalendarEventByResourceUrl.mockResolvedValueOnce(current);
		const resolveReference = vi.fn().mockResolvedValue({
			timeZone: 'America/New_York',
			etag: '"private-reference"',
			calendarData: referenceData.replaceAll('US/Eastern', 'America/New_York'),
			ruleSource: 'vtimezone',
		});
		const clock = vi.fn(() => CLOCK);

		const error = await updateCalendarEvent(
			TRANSPORT,
			resourceInput({
				timeZone: {
					kind: 'set',
					value: { timeZoneMode: 'iana', timeZone: 'America/New_York' },
				},
			}),
			clock,
			{ resolveReference },
		).catch((failure: unknown) => failure);

		expect(error).toMatchObject({
			code: 'UNREPRESENTABLE_TIME_ZONE',
			message: 'The selected IANA time zone cannot be represented safely for this calendar event.',
		});
		expect(mocks.getCalendarEventByResourceUrl).toHaveBeenCalledOnce();
		expect(resolveReference).toHaveBeenCalledOnce();
		expect(clock).not.toHaveBeenCalled();
		expect(mocks.updateCalendarEventResource).not.toHaveBeenCalled();
		expect(serializeICalendarResource(current.context.resource)).toBe(currentData);
		expect(JSON.stringify(error)).not.toMatch(
			/New_York|US\/Eastern|Unparseable|calendar\.example|2040|private|X-RELATED/i,
		);
	});

	it.each(['US/Eastern', 'us/eastern'])(
		'uses exact reusable alias %s on the wire when verified reference authoring is unavailable',
		async (sourceTimeZone) => {
			const { calendarData: currentData } = calendarDataWithTimeZone(sourceTimeZone);
			const current = readResult(currentData, { etag: '"snapshot"' });
			const resolveReference = vi.fn().mockRejectedValue(new Error('private-reference'));
			mocks.getCalendarEventByResourceUrl
				.mockResolvedValueOnce(current)
				.mockImplementationOnce(async () => {
					const sent = mocks.updateCalendarEventResource.mock.calls[0]![3] as string;
					return readResult(sent, { etag: '"confirmed"' });
				});
			mocks.updateCalendarEventResource.mockResolvedValue({
				statusCode: 204,
				resourceUrl: RESOURCE_URL,
			});

			await expect(
				updateCalendarEvent(
					TRANSPORT,
					resourceInput({
						timeZone: {
							kind: 'set',
							value: { timeZoneMode: 'iana', timeZone: 'America/New_York' },
						},
					}),
					() => CLOCK,
					{ resolveReference },
				),
			).resolves.toMatchObject({
				accessMode: 'editable',
				timeZoneMode: 'iana',
				timeZone: 'America/New_York',
			});
			const sent = mocks.updateCalendarEventResource.mock.calls[0]![3] as string;
			expect(sent.match(/BEGIN:VTIMEZONE/g)).toHaveLength(1);
			expect(sent).toContain(`TZID:${sourceTimeZone}`);
			expect(sent).toContain(`DTSTART;TZID=${sourceTimeZone}:`);
			expect(sent).toContain(`DTEND;TZID=${sourceTimeZone}:`);
			expect(sent).not.toContain('TZID=America/New_York');
			expect(resolveReference).toHaveBeenCalledOnce();
			expect(mocks.updateCalendarEventResource).toHaveBeenCalledOnce();
		},
	);

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
			timeZoneMode: 'utc',
			startLocal: '2040-01-02T10:00:00',
			endLocal: '2040-01-02T10:30:00',
		});
		expect(Object.isFrozen(result)).toBe(true);
		expect(confirmed.calendarData).toContain('X-UNKNOWN;X-SOURCE=MiXeD:opaque-value');
		expect(confirmed.calendarData).toContain('BEGIN:VALARM');
	});

	it('returns the authoritative safe read-only projection after a successful PUT and GET', async () => {
		const patch: CalendarEventPatch = { summary: { kind: 'set', value: 'After update' } };
		const current = readResult(calendarData(), { etag: '"snapshot"' });
		const confirmed = updatedRead(current, patch, { etag: '"authoritative"' });
		const readOnlyConfirmed: CalendarEventReadResult = {
			...confirmed.result,
			event: Object.freeze({
				calendarUrl: confirmed.result.event.calendarUrl,
				resourceUrl: confirmed.result.event.resourceUrl,
				etag: confirmed.result.event.etag,
				uid: confirmed.result.event.uid,
				summary: confirmed.result.event.summary,
				timeMode: 'unsupported',
				accessMode: 'readOnly',
				readOnlyReason: 'unsupportedTimeRepresentation',
			}),
		};
		mocks.getCalendarEventByResourceUrl
			.mockResolvedValueOnce(current)
			.mockResolvedValueOnce(readOnlyConfirmed);
		mocks.updateCalendarEventResource.mockResolvedValue({
			statusCode: 204,
			resourceUrl: RESOURCE_URL,
		});

		await expect(
			updateCalendarEvent(TRANSPORT, resourceInput(patch), () => CLOCK),
		).resolves.toEqual(readOnlyConfirmed.event);
		expect(mocks.updateCalendarEventResource).toHaveBeenCalledTimes(1);
		expect(mocks.getCalendarEventByResourceUrl).toHaveBeenCalledTimes(2);
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
	it('rejects a mixed-zone recurring event as read-only before clock, ETag, patching, or PUT', async () => {
		const mixedRecurrence = SUPPORTED_EMBEDDED_IANA_EVENT.replace(
			'END:VCALENDAR\r\n',
			[
				'BEGIN:VEVENT',
				'UID:synthetic-time-zone-event',
				'RECURRENCE-ID;TZID=Europe/Prague:20400722T100000',
				'DTSTART;TZID=America/New_York:20400722T040000',
				'DTEND;TZID=America/New_York:20400722T050000',
				'END:VEVENT',
				'END:VCALENDAR',
				'',
			].join('\r\n'),
		);
		const current = readResult(mixedRecurrence, { etag: '"snapshot"' });
		expect(current.event.accessMode).toBe('readOnly');
		mocks.getCalendarEventByResourceUrl.mockResolvedValue(current);
		const clock = vi.fn().mockReturnValue(CLOCK);

		await expect(
			updateCalendarEvent(
				TRANSPORT,
				resourceInput({ summary: { kind: 'set', value: 'Must not change' } }),
				clock,
			),
		).rejects.toMatchObject({ code: CalendarEventUpdateFailureCode.READ_ONLY });
		expect(clock).not.toHaveBeenCalled();
		expect(mocks.updateCalendarEventResource).not.toHaveBeenCalled();
	});

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
