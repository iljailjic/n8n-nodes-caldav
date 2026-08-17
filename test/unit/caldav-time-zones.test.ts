/* eslint-disable @n8n/community-nodes/no-restricted-globals -- The issue-42 host-timezone invariance oracle intentionally changes and restores TZ within one isolated test. */

import { describe, expect, it } from 'vitest';

import {
	CalDavIanaTimeZoneError,
	IANA_TIME_ZONE_DATABASE_VERSION,
	canonicalizeIanaTimeZone,
	listCanonicalIanaTimeZones,
	projectInstantInTimeZone,
	resolveLocalDateTimeInTimeZone,
} from '../../nodes/CalDav/icalendar/timeZones';
import type {
	CalendarEventTimeZone,
	IanaTimeZoneId,
	LocalDateTimeString,
	TimeZoneRuleSource,
} from '../../nodes/CalDav/icalendar/timeZones';
import {
	ALIAS_ORACLE,
	CANONICAL_ZONE_ORACLE,
	INSTANT_PROJECTION_ORACLE,
	INVALID_ZONE_ORACLE,
	PINNED_TZDB_VERSION,
	TRANSITION_ORACLE,
	UTC_EQUIVALENT_ZONE_ORACLE,
} from './fixtures/time-zones/synthetic-time-zone-fixtures';
import tzdbOracle from './fixtures/time-zones/tzdb-2026c-oracle.json';

const UTC_EQUIVALENT_PRIMARY_ZONES = new Set(['Etc/GMT', 'Etc/UTC']);
const DISALLOWED_IMPLEMENTATION_LINKS = new Set([
	'CET',
	'CST6CDT',
	'EET',
	'EST',
	'EST5EDT',
	'HST',
	'MET',
	'MST',
	'MST7MDT',
	'PST8PDT',
	'WET',
]);

function resolveOracleLink(name: string): string {
	const links = new Map(tzdbOracle.links.map((link) => [link.name, link.target]));
	const seen = new Set<string>();
	let target = name;
	while (links.has(target)) {
		if (seen.has(target)) throw new Error('The checked-in TZDB Link oracle contains a cycle.');
		seen.add(target);
		target = links.get(target)!;
	}
	return target;
}

function captureError(action: () => unknown): CalDavIanaTimeZoneError {
	try {
		action();
	} catch (error) {
		expect(error).toBeInstanceOf(CalDavIanaTimeZoneError);
		return error as CalDavIanaTimeZoneError;
	}
	throw new Error('Expected time-zone operation to fail.');
}

function iso(value: Date): string {
	return value.toISOString().replace('.000Z', 'Z');
}

function typeSurface(
	zone: IanaTimeZoneId,
	local: LocalDateTimeString,
	eventZone: CalendarEventTimeZone,
	rules: TimeZoneRuleSource,
): readonly unknown[] {
	return [zone, local, eventZone, rules];
}

describe('pinned IANA TZDB 2026c identity oracle', () => {
	it('exports the exact contract surface and pinned revision', () => {
		expect(IANA_TIME_ZONE_DATABASE_VERSION).toBe(PINNED_TZDB_VERSION);
		expect(CalDavIanaTimeZoneError).toBeTypeOf('function');
		expect(canonicalizeIanaTimeZone).toBeTypeOf('function');
		expect(listCanonicalIanaTimeZones).toBeTypeOf('function');
		expect(projectInstantInTimeZone).toBeTypeOf('function');
		expect(resolveLocalDateTimeInTimeZone).toBeTypeOf('function');
		expect(typeSurface).toBeTypeOf('function');
	});

	it.each(ALIAS_ORACLE)(
		'canonicalizes $input to the stable 2026c primary $canonical',
		({ input, canonical }) => {
			expect(canonicalizeIanaTimeZone(input)).toBe(canonical);
		},
	);

	it('returns only sorted, unique, non-UTC primary Zones and never aliases', () => {
		const zones = listCanonicalIanaTimeZones();
		const expected = tzdbOracle.zones
			.filter((zone) => !UTC_EQUIVALENT_PRIMARY_ZONES.has(zone))
			.sort();
		expect(tzdbOracle.version).toBe(PINNED_TZDB_VERSION);
		expect(zones).toEqual(expected);
		expect(new Set(zones).size).toBe(zones.length);
		expect(zones).toEqual(expect.arrayContaining(CANONICAL_ZONE_ORACLE));
		expect(zones).not.toEqual(expect.arrayContaining(['US/Eastern', 'Asia/Calcutta', 'UTC']));
		for (const zone of zones) expect(canonicalizeIanaTimeZone(zone)).toBe(zone);
	});

	it('resolves every checked-in 2026c Link chain and ASCII case variant to one primary spelling', () => {
		for (const link of tzdbOracle.links) {
			if (DISALLOWED_IMPLEMENTATION_LINKS.has(link.name)) {
				expect(captureError(() => canonicalizeIanaTimeZone(link.name)).code).toBe(
					'INVALID_TIME_ZONE',
				);
				continue;
			}
			const canonical = resolveOracleLink(link.name);
			if (UTC_EQUIVALENT_PRIMARY_ZONES.has(canonical)) {
				expect(captureError(() => canonicalizeIanaTimeZone(link.name)).code).toBe('UTC_EQUIVALENT');
				continue;
			}
			expect(canonicalizeIanaTimeZone(link.name)).toBe(canonical);
			expect(canonicalizeIanaTimeZone(link.name.toUpperCase())).toBe(canonical);
		}
	});

	it.each(INVALID_ZONE_ORACLE)(
		'rejects invalid/private identifier %# without echoing it',
		(zone) => {
			const error = captureError(() => canonicalizeIanaTimeZone(zone));
			expect(error.code).toBe('INVALID_TIME_ZONE');
			expect(String(error)).not.toContain(zone || 'Unknown/Nowhere');
		},
	);

	it.each(UTC_EQUIVALENT_ZONE_ORACLE)(
		'rejects UTC-equivalent identity %# without changing mode',
		(zone) => {
			const error = captureError(() => canonicalizeIanaTimeZone(zone));
			expect(error.code).toBe('UTC_EQUIVALENT');
			expect(String(error)).not.toContain(zone);
		},
	);
});

describe('instant/local conversion', () => {
	it.each(INSTANT_PROJECTION_ORACLE)(
		'projects $instant into $zone as $local and round-trips the represented instant',
		({ zone, instant, local }) => {
			const canonical = canonicalizeIanaTimeZone(zone);
			const projected = projectInstantInTimeZone(new Date(instant), canonical);
			expect(projected).toBe(local);
			expect(iso(resolveLocalDateTimeInTimeZone(projected, canonical))).toBe(instant);
		},
	);

	it('uses RFC 5545 first-occurrence and pre-gap-offset transition semantics', () => {
		const prague = canonicalizeIanaTimeZone('Europe/Prague');
		const newYork = canonicalizeIanaTimeZone('America/New_York');
		expect(iso(resolveLocalDateTimeInTimeZone(TRANSITION_ORACLE.pragueGap.local, prague))).toBe(
			TRANSITION_ORACLE.pragueGap.resolved,
		);
		expect(iso(resolveLocalDateTimeInTimeZone(TRANSITION_ORACLE.pragueOverlap.local, prague))).toBe(
			TRANSITION_ORACLE.pragueOverlap.first,
		);
		expect(iso(resolveLocalDateTimeInTimeZone(TRANSITION_ORACLE.newYorkGap.local, newYork))).toBe(
			TRANSITION_ORACLE.newYorkGap.resolved,
		);
		expect(
			iso(resolveLocalDateTimeInTimeZone(TRANSITION_ORACLE.newYorkOverlap.local, newYork)),
		).toBe(TRANSITION_ORACLE.newYorkOverlap.first);
	});

	it('makes the second overlap occurrence visibly fail the authoring round-trip', () => {
		const zone = canonicalizeIanaTimeZone('Europe/Prague');
		const second = new Date(TRANSITION_ORACLE.pragueOverlap.second);
		const local = projectInstantInTimeZone(second, zone);
		expect(local).toBe(TRANSITION_ORACLE.pragueOverlap.local);
		expect(iso(resolveLocalDateTimeInTimeZone(local, zone))).toBe(
			TRANSITION_ORACLE.pragueOverlap.first,
		);
		expect(iso(resolveLocalDateTimeInTimeZone(local, zone))).not.toBe(iso(second));
	});

	it('is invariant under the host TZ environment and uses no default locale behavior', () => {
		const previous = process.env.TZ;
		try {
			const results = ['UTC', 'Pacific/Honolulu', 'Europe/Berlin'].map((hostTimeZone) => {
				process.env.TZ = hostTimeZone;
				return projectInstantInTimeZone(
					new Date('2040-07-15T16:00:00Z'),
					canonicalizeIanaTimeZone('America/New_York'),
				);
			});
			expect(results).toEqual([
				'2040-07-15T12:00:00',
				'2040-07-15T12:00:00',
				'2040-07-15T12:00:00',
			]);
		} finally {
			if (previous === undefined) delete process.env.TZ;
			else process.env.TZ = previous;
		}
	});

	it.each([
		[new Date('0001-01-01T00:00:00Z'), 'America/New_York'],
		[new Date('9999-12-31T23:59:59Z'), 'Pacific/Kiritimati'],
	] as const)('rejects a local projection outside years 0001-9999', (instant, zoneName) => {
		const error = captureError(() =>
			projectInstantInTimeZone(instant, canonicalizeIanaTimeZone(zoneName)),
		);
		expect(error.code).toBe('UNREPRESENTABLE_INSTANT');
	});

	it.each([
		['invalid Date', new Date(Number.NaN)],
		['fractional second', new Date('2040-01-01T00:00:00.001Z')],
	] as const)('rejects %s rather than rounding', (_label, instant) => {
		const error = captureError(() =>
			projectInstantInTimeZone(instant, canonicalizeIanaTimeZone('Europe/Prague')),
		);
		expect(error.code).toBe('UNREPRESENTABLE_INSTANT');
	});
});
