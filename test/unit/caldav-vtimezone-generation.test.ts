/* eslint-disable @n8n/community-nodes/no-restricted-globals -- Host-TZ invariance is an explicit issue-43 acceptance oracle. */

import { describe, expect, it } from 'vitest';

import { parseICalendarResource } from '../../nodes/CalDav/icalendar/parser';
import type { ICalendarComponent, ICalendarProperty } from '../../nodes/CalDav/icalendar/parser';
import { serializeICalendarResource } from '../../nodes/CalDav/icalendar/serializer';
import {
	assertVTimeZoneCovers,
	assertVTimeZoneReadableForInterval,
	CalDavVTimeZoneGenerationError,
	CalDavVTimeZoneGenerationErrorCode,
	canonicalizeIanaTimeZone,
	generateFiniteVTimeZone,
	projectInstantInTimeZone,
	vTimeZoneRulesAreSemanticallyEqual,
} from '../../nodes/CalDav/icalendar/timeZones';
import type { FiniteTimeZoneCoverage } from '../../nodes/CalDav/icalendar/timeZones';

const encoder = new TextEncoder();

function property(component: ICalendarComponent, name: string): ICalendarProperty {
	const matches = component.entries.filter(
		(entry): entry is ICalendarProperty =>
			entry.kind === 'property' && entry.name.toUpperCase() === name,
	);
	expect(matches).toHaveLength(1);
	return matches[0]!;
}

function observances(definition: ICalendarComponent): readonly ICalendarComponent[] {
	return definition.entries.filter(
		(entry): entry is ICalendarComponent => entry.kind === 'component',
	);
}

function fixtureDefinition(zone: string, observancesText: readonly string[]): ICalendarComponent {
	const resource = parseICalendarResource(
		encoder.encode(
			[
				'BEGIN:VCALENDAR',
				'VERSION:2.0',
				'BEGIN:VTIMEZONE',
				`TZID:${zone}`,
				...observancesText,
				'END:VTIMEZONE',
				'END:VCALENDAR',
				'',
			].join('\r\n'),
		),
	);
	const definition = resource.calendar.entries.find(
		(entry) => entry.kind === 'component' && entry.name === 'VTIMEZONE',
	);
	if (definition?.kind !== 'component') throw new Error('Missing synthetic VTIMEZONE.');
	return definition;
}

function resourceFor(definition: ICalendarComponent): string {
	const base = parseICalendarResource(
		encoder.encode(
			[
				'BEGIN:VCALENDAR',
				'VERSION:2.0',
				'PRODID:-//example.test//VTIMEZONE oracle//EN',
				'BEGIN:VEVENT',
				'UID:vtimezone-generation-oracle',
				'DTSTAMP:20400101T000000Z',
				'DTSTART:20400101T000000Z',
				'DTEND:20400101T010000Z',
				'SUMMARY:VTIMEZONE generation oracle',
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
				definition,
				...base.calendar.entries.slice(eventIndex),
			],
		},
	});
}

function offsetSeconds(instant: Date, timeZone: string): number {
	const local = projectInstantInTimeZone(instant, canonicalizeIanaTimeZone(timeZone));
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(local);
	if (match === null) throw new Error('Unexpected local projection.');
	const wall = new Date(0);
	wall.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	wall.setUTCHours(Number(match[4]), Number(match[5]), Number(match[6]), 0);
	return (wall.getTime() - instant.getTime()) / 1000;
}

function expectSemanticCoverage(
	timeZoneName: string,
	coverage: FiniteTimeZoneCoverage,
	instants: readonly string[],
): ICalendarComponent {
	const timeZone = canonicalizeIanaTimeZone(timeZoneName);
	const definition = generateFiniteVTimeZone(timeZone, coverage);
	assertVTimeZoneCovers(definition, timeZone, coverage);
	for (const value of instants) {
		const instant = new Date(value);
		expect(projectInstantInTimeZone(instant, timeZone, definition)).toBe(
			projectInstantInTimeZone(instant, timeZone),
		);
	}
	return definition;
}

describe('finite VTIMEZONE generation', () => {
	it('reads long constant and terminal histories without expanding every year', () => {
		const coverage = {
			start: new Date('2026-01-01T00:00:00Z'),
			end: new Date('9999-01-01T00:00:00Z'),
		};
		const constant = fixtureDefinition('Pacific/Apia', [
			'BEGIN:STANDARD',
			'DTSTART:20250101T000000',
			'TZOFFSETFROM:+1300',
			'TZOFFSETTO:+1300',
			'END:STANDARD',
		]);
		const terminal = fixtureDefinition('Asia/Kathmandu', [
			'BEGIN:STANDARD',
			'DTSTART:20200101T000000',
			'TZOFFSETFROM:+0530',
			'TZOFFSETTO:+0530',
			'END:STANDARD',
			'BEGIN:STANDARD',
			'DTSTART:20210101T000000',
			'TZOFFSETFROM:+0530',
			'TZOFFSETTO:+0545',
			'END:STANDARD',
		]);
		const start = Date.now();
		expect(() =>
			assertVTimeZoneReadableForInterval(
				constant,
				canonicalizeIanaTimeZone('Pacific/Apia'),
				coverage,
			),
		).not.toThrow();
		expect(() =>
			assertVTimeZoneReadableForInterval(
				terminal,
				canonicalizeIanaTimeZone('Asia/Kathmandu'),
				coverage,
			),
		).not.toThrow();
		expect(Date.now() - start).toBeLessThan(2000);
	});

	it('rejects long yearly coverage promptly and returns false during confirmation', () => {
		const zone = canonicalizeIanaTimeZone('Pacific/Apia');
		const coverage = {
			start: new Date('2026-01-01T00:00:00Z'),
			end: new Date('9999-01-01T00:00:00Z'),
		};
		const constant = fixtureDefinition('Pacific/Apia', [
			'BEGIN:STANDARD',
			'DTSTART:20250101T000000',
			'TZOFFSETFROM:+1300',
			'TZOFFSETTO:+1300',
			'END:STANDARD',
		]);
		const yearly = fixtureDefinition('Pacific/Apia', [
			'BEGIN:STANDARD',
			'DTSTART:20250101T000000',
			'TZOFFSETFROM:+1300',
			'TZOFFSETTO:+1300',
			'END:STANDARD',
			'BEGIN:DAYLIGHT',
			'DTSTART:20260301T000000',
			'RRULE:FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1',
			'TZOFFSETFROM:+1300',
			'TZOFFSETTO:+1400',
			'END:DAYLIGHT',
		]);
		const start = Date.now();
		expect(() => assertVTimeZoneReadableForInterval(yearly, zone, coverage)).toThrowError(
			expect.objectContaining({ code: 'UNREPRESENTABLE_TIME_ZONE' }),
		);
		expect(vTimeZoneRulesAreSemanticallyEqual(constant, yearly, zone, coverage)).toBe(false);
		expect(Date.now() - start).toBeLessThan(2000);
		expect(() =>
			assertVTimeZoneReadableForInterval(yearly, zone, {
				start: new Date('2026-03-02T00:00:00Z'),
				end: new Date('2026-09-01T00:00:00Z'),
			}),
		).not.toThrow();
	});
	it.each([
		['Africa/Casablanca', '2026-10-06T09:20:00Z', '2026-10-06T09:20:00'],
		['Asia/Kathmandu', '2026-10-06T03:35:00Z', '2026-10-06T09:20:00'],
		['Asia/Kolkata', '2026-10-06T03:50:00Z', '2026-10-06T09:20:00'],
	] as const)(
		'matches fixed 2026c authority for %s in generated finite rules',
		(name, instantText, expectedLocal) => {
			const instant = new Date(instantText);
			const zone = canonicalizeIanaTimeZone(name);
			const definition = generateFiniteVTimeZone(zone, {
				start: new Date(instant.getTime() - 86_400_000),
				end: new Date(instant.getTime() + 86_400_000),
			});
			expect(projectInstantInTimeZone(instant, zone)).toBe(expectedLocal);
			expect(projectInstantInTimeZone(instant, zone, definition)).toBe(expectedLocal);
			assertVTimeZoneCovers(definition, zone, {
				start: instant,
				end: new Date(instant.getTime() + 900_000),
			});
		},
	);
	it.each([
		{
			zone: 'Europe/Prague',
			start: '2038-01-01T00:00:00Z',
			end: '2042-12-31T23:59:59Z',
			instants: [
				'2038-01-15T12:00:00Z',
				'2038-03-28T01:00:00Z',
				'2040-07-15T12:00:00Z',
				'2042-10-26T01:00:00Z',
			],
		},
		{
			zone: 'America/New_York',
			start: '2038-01-01T00:00:00Z',
			end: '2042-12-31T23:59:59Z',
			instants: ['2038-03-14T07:00:00Z', '2040-07-15T12:00:00Z', '2042-11-02T06:00:00Z'],
		},
		{
			zone: 'Australia/Lord_Howe',
			start: '2038-01-01T00:00:00Z',
			end: '2042-12-31T23:59:59Z',
			instants: ['2038-01-15T12:00:00Z', '2040-04-01T15:00:00Z', '2042-10-04T16:00:00Z'],
		},
		{
			zone: 'Pacific/Apia',
			start: '2010-01-01T00:00:00Z',
			end: '2013-12-31T23:59:59Z',
			instants: ['2011-12-29T09:00:00Z', '2011-12-30T12:00:00Z', '2012-01-01T00:00:00Z'],
		},
		{
			zone: 'Africa/Casablanca',
			start: '2024-01-01T00:00:00Z',
			end: '2027-12-31T23:59:59Z',
			instants: ['2024-03-20T12:00:00Z', '2024-04-20T12:00:00Z', '2026-06-20T12:00:00Z'],
		},
		{
			zone: 'Asia/Kolkata',
			start: '2038-01-01T00:00:00Z',
			end: '2042-12-31T23:59:59Z',
			instants: ['2038-01-15T12:00:00Z', '2040-07-15T12:00:00Z', '2042-12-01T00:00:00Z'],
		},
		{
			zone: 'Pacific/Honolulu',
			start: '2038-01-01T00:00:00Z',
			end: '2042-12-31T23:59:59Z',
			instants: ['2038-01-15T12:00:00Z', '2040-07-15T12:00:00Z', '2042-12-01T00:00:00Z'],
		},
	] as const)(
		'matches runtime Intl semantics for $zone throughout a finite multi-year horizon',
		({ zone, start, end, instants }) => {
			const definition = expectSemanticCoverage(
				zone,
				{ start: new Date(start), end: new Date(end) },
				instants,
			);
			expect(property(definition, 'TZID').value.textValues).toEqual([
				canonicalizeIanaTimeZone(zone),
			]);
		},
	);

	it('emits only minimal finite observances and groups later identical signatures as ordered RDATE', () => {
		const definition = expectSemanticCoverage(
			'Europe/Prague',
			{ start: new Date('2038-01-01T00:00:00Z'), end: new Date('2042-12-31T23:59:59Z') },
			['2038-01-01T00:00:00Z', '2042-12-31T23:59:59Z'],
		);
		expect(definition.name).toBe('VTIMEZONE');
		expect(
			definition.entries.filter((entry) => entry.kind === 'property').map((entry) => entry.name),
		).toEqual(['TZID']);
		for (const observance of observances(definition)) {
			expect(['STANDARD', 'DAYLIGHT']).toContain(observance.name);
			const names = observance.entries.map((entry) => entry.name);
			expect(names.slice(0, 3)).toEqual(['DTSTART', 'TZOFFSETFROM', 'TZOFFSETTO']);
			expect(names.slice(3).every((name) => name === 'RDATE')).toBe(true);
			const rdates = observance.entries
				.filter(
					(entry): entry is ICalendarProperty =>
						entry.kind === 'property' && entry.name === 'RDATE',
				)
				.flatMap((entry) => entry.value.raw.split(','));
			expect(rdates).toEqual([...rdates].sort());
		}
		const serialized = resourceFor(definition);
		expect(serialized).not.toMatch(/(?:RRULE|TZNAME|TZURL|LAST-MODIFIED|COMMENT|X-[-A-Z0-9]+):/);
		const parsed = parseICalendarResource(encoder.encode(serialized));
		expect(
			parsed.calendar.entries.some(
				(entry) => entry.kind === 'component' && entry.name === 'VTIMEZONE',
			),
		).toBe(true);
	});

	it.each(['Asia/Kolkata', 'Pacific/Honolulu'])(
		'emits one constant STANDARD observance with equal offsets for %s',
		(zone) => {
			const definition = generateFiniteVTimeZone(canonicalizeIanaTimeZone(zone), {
				start: new Date('2040-01-01T00:00:00Z'),
				end: new Date('2041-01-01T00:00:00Z'),
			});
			expect(observances(definition)).toHaveLength(1);
			const constant = observances(definition)[0]!;
			expect(constant.name).toBe('STANDARD');
			expect(property(constant, 'TZOFFSETFROM').value.raw).toBe(
				property(constant, 'TZOFFSETTO').value.raw,
			);
		},
	);

	it('accepts a safe finite horizon longer than 100 years without a product cap', () => {
		const timeZone = canonicalizeIanaTimeZone('Etc/GMT+5');
		const coverage = {
			start: new Date('1900-01-01T00:00:00Z'),
			end: new Date('2201-01-01T00:00:00Z'),
		};
		const definition = generateFiniteVTimeZone(timeZone, coverage);
		expect(observances(definition)).toHaveLength(1);
		expect(() => assertVTimeZoneCovers(definition, timeZone, coverage)).not.toThrow();
	});

	it('keeps pinned 2026c historical signatures and second offsets across host time zones', () => {
		const zone = canonicalizeIanaTimeZone('Africa/Monrovia');
		const coverage = {
			start: new Date('1900-01-01T00:00:00Z'),
			end: new Date('1975-01-01T00:00:00Z'),
		};
		const definition = generateFiniteVTimeZone(zone, coverage);
		assertVTimeZoneCovers(definition, zone, coverage);
		const serialized = resourceFor(definition);
		expect(serialized).toContain('TZOFFSETTO:-004308');
		expect(serialized).toContain('TZOFFSETTO:-004430');
		expect(offsetSeconds(new Date('1900-01-01T00:00:00Z'), zone)).toBe(-43 * 60 - 8);
		expect(offsetSeconds(new Date('1930-01-01T00:00:00Z'), zone)).toBe(-44 * 60 - 30);
		expect(serialized).not.toMatch(/TZOFFSET(?:FROM|TO):-0{4}(?:00)?/);
	});

	it('is deterministic, copies coverage Dates, and is invariant under the host timezone', () => {
		const start = new Date('2039-01-01T00:00:00Z');
		const end = new Date('2041-12-31T23:59:59Z');
		const startSnapshot = start.getTime();
		const endSnapshot = end.getTime();
		const timeZone = canonicalizeIanaTimeZone('Australia/Lord_Howe');
		const previous = process.env.TZ;
		try {
			const outputs = ['UTC', 'Pacific/Honolulu', 'Europe/Prague'].map((host) => {
				process.env.TZ = host;
				return resourceFor(generateFiniteVTimeZone(timeZone, { start, end }));
			});
			expect(outputs[0]).toBe(outputs[1]);
			expect(outputs[1]).toBe(outputs[2]);
		} finally {
			if (previous === undefined) delete process.env.TZ;
			else process.env.TZ = previous;
		}
		expect(start.getTime()).toBe(startSnapshot);
		expect(end.getTime()).toBe(endSnapshot);
	});

	it.each([
		['invalid start', new Date(Number.NaN), new Date('2040-01-01T00:00:00Z')],
		['invalid end', new Date('2040-01-01T00:00:00Z'), new Date(Number.NaN)],
		['subsecond start', new Date('2040-01-01T00:00:00.001Z'), new Date('2040-01-02T00:00:00Z')],
		['subsecond end', new Date('2040-01-01T00:00:00Z'), new Date('2040-01-02T00:00:00.001Z')],
		['reversed', new Date('2040-01-02T00:00:00Z'), new Date('2040-01-01T00:00:00Z')],
	] as const)('rejects %s as INVALID_COVERAGE without echoing values', (_label, start, end) => {
		const error = (() => {
			try {
				generateFiniteVTimeZone(canonicalizeIanaTimeZone('Europe/Prague'), { start, end });
			} catch (failure) {
				return failure;
			}
			throw new Error('Expected generation failure.');
		})();
		expect(error).toBeInstanceOf(CalDavVTimeZoneGenerationError);
		expect(error).toMatchObject({ code: CalDavVTimeZoneGenerationErrorCode.INVALID_COVERAGE });
	});

	it('rejects years outside 0001-9999 and a finite horizon exceeding resource limits', () => {
		const yearZero = new Date(0);
		yearZero.setUTCFullYear(0, 0, 1);
		yearZero.setUTCHours(0, 0, 0, 0);
		const yearTenThousand = new Date(0);
		yearTenThousand.setUTCFullYear(10_000, 0, 1);
		yearTenThousand.setUTCHours(0, 0, 0, 0);
		const zone = canonicalizeIanaTimeZone('Europe/Prague');
		for (const coverage of [
			{ start: yearZero, end: new Date('2040-01-01T00:00:00Z') },
			{ start: new Date('2040-01-01T00:00:00Z'), end: yearTenThousand },
		]) {
			expect(() => generateFiniteVTimeZone(zone, coverage)).toThrowError(
				expect.objectContaining({ code: 'INVALID_COVERAGE' }),
			);
		}
		expect(() =>
			generateFiniteVTimeZone(zone, {
				start: new Date('0001-01-01T00:00:00Z'),
				end: new Date('9999-12-31T23:59:59Z'),
			}),
		).toThrowError(expect.objectContaining({ code: 'UNREPRESENTABLE_TIME_ZONE' }));
	});

	it('rejects a definition that cannot prove complete coverage with the typed safe error', () => {
		const timeZone = canonicalizeIanaTimeZone('Europe/Prague');
		const short = generateFiniteVTimeZone(timeZone, {
			start: new Date('2040-01-01T00:00:00Z'),
			end: new Date('2040-12-31T23:59:59Z'),
		});
		expect(() =>
			assertVTimeZoneCovers(short, timeZone, {
				start: new Date('2040-01-01T00:00:00Z'),
				end: new Date('2042-12-31T23:59:59Z'),
			}),
		).toThrowError(expect.objectContaining({ code: 'UNREPRESENTABLE_TIME_ZONE' }));
	});

	it('does not extrapolate a lone finite offset transition beyond its explicit onset', () => {
		const timeZone = canonicalizeIanaTimeZone('Europe/Prague');
		const generated = generateFiniteVTimeZone(timeZone, {
			start: new Date('2040-01-01T00:00:00Z'),
			end: new Date('2040-12-31T23:59:59Z'),
		});
		const changing = observances(generated).find(
			(observance) =>
				property(observance, 'TZOFFSETFROM').value.raw !==
				property(observance, 'TZOFFSETTO').value.raw,
		);
		expect(changing).toBeDefined();
		const incomplete: ICalendarComponent = {
			kind: 'component',
			name: 'VTIMEZONE',
			entries: [
				property(generated, 'TZID'),
				{ ...changing!, entries: changing!.entries.slice(0, 3) },
			],
		};
		expect(() =>
			assertVTimeZoneCovers(incomplete, timeZone, {
				start: new Date('2040-01-01T00:00:00Z'),
				end: new Date('2040-12-31T23:59:59Z'),
			}),
		).toThrowError(
			expect.objectContaining({
				code: CalDavVTimeZoneGenerationErrorCode.UNREPRESENTABLE_TIME_ZONE,
			}),
		);
	});
});
