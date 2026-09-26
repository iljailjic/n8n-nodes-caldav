import type { IExecuteFunctions, INode } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	update: vi.fn(),
	upsert: vi.fn(),
	query: vi.fn(),
	transport: vi.fn(),
}));
vi.mock('../../nodes/CalDav/transport/http', async (original) => ({
	...(await original<typeof import('../../nodes/CalDav/transport/http')>()),
	createN8nCalDavTransport: mocks.transport,
}));
vi.mock('../../nodes/CalDav/events/create', async (original) => ({
	...(await original<typeof import('../../nodes/CalDav/events/create')>()),
	createCalendarEvent: mocks.create,
}));
vi.mock('../../nodes/CalDav/events/update', async (original) => ({
	...(await original<typeof import('../../nodes/CalDav/events/update')>()),
	updateCalendarEvent: mocks.update,
}));
vi.mock('../../nodes/CalDav/events/upsert', async (original) => ({
	...(await original<typeof import('../../nodes/CalDav/events/upsert')>()),
	upsertCalendarEvent: mocks.upsert,
}));
vi.mock('../../nodes/CalDav/events/timeRangeQuery', async (original) => ({
	...(await original<typeof import('../../nodes/CalDav/events/timeRangeQuery')>()),
	queryCalendarEventsByTimeRange: mocks.query,
}));

import {
	CalDav,
	normalizeAlarmCreateParameter,
	normalizeAlarmMutationParameter,
} from '../../nodes/CalDav/CalDav.node';
import {
	normalizeStructuredTimedInput,
	parseStructuredTimedInput,
} from '../../nodes/CalDav/temporalInputs';
import { mapCalendarEventResource } from '../../nodes/CalDav/icalendar/eventReadModel';
import { parseICalendarResource } from '../../nodes/CalDav/icalendar/parser';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';

// Oracle: owner-approved issue-154-contract-r3. Fixed picker values follow n8n 2.40.7;
// expression tests supply resolved values, including recursive Luxon-to-ISO cleanup.
const URL = validateAbsoluteHttpUrl('https://calendar.example.test/temporal/');
const NODE: INode = {
	id: 'temporal',
	name: 'Temporal',
	type: 'calDav',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};
const EVENT = {
	calendarUrl: URL,
	resourceUrl: `${URL}event.ics`,
	etag: '"temporal"',
	uid: 'temporal@example.test',
	summary: 'Synthetic',
	timeMode: 'timed',
	accessMode: 'editable',
	timeZoneMode: 'utc',
	start: '2026-09-30T00:00:00Z',
	end: '2026-09-30T01:00:00Z',
	startLocal: '2026-09-30T00:00:00',
	endLocal: '2026-09-30T01:00:00',
};
function parameters(operation: string, extra: Record<string, unknown> = {}) {
	return {
		resource: 'event',
		operation,
		calendar: { __rl: true, mode: 'url', value: URL },
		uid: EVENT.uid,
		identifierMode: 'resourceUrl',
		resourceUrl: EVENT.resourceUrl,
		etag: '',
		timeMode: 'timed',
		timeZoneMode: 'utc',
		start: '2026-09-30T02:00:00',
		end: '2026-09-30T03:00:00',
		summary: 'Synthetic',
		additionalFields: {},
		fieldsToUpdate: { start: '2026-09-30T02:00:00' },
		returnAll: true,
		...extra,
	};
}
function context(
	rows: Record<string, unknown>[],
	zone = 'Europe/Prague',
	continueOnFail = false,
): IExecuteFunctions {
	return {
		getInputData: () => rows.map((_, i) => ({ json: { mapped: i } })),
		getNodeParameter: (name: string, i: number) => rows[i][name],
		getTimezone: () => zone,
		getNode: () => NODE,
		continueOnFail: () => continueOnFail,
	} as unknown as IExecuteFunctions;
}
async function execute(
	operation: string,
	extra: Record<string, unknown> = {},
	zone = 'Europe/Prague',
) {
	return new CalDav().execute.call(context([parameters(operation, extra)], zone));
}
function luxon(iso: string) {
	return { isLuxonDateTime: true, isValid: true, toJSDate: () => new Date(iso) };
}
function current(allDay = false) {
	const ics = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//Synthetic//EN',
		'BEGIN:VEVENT',
		`UID:${EVENT.uid}`,
		'DTSTAMP:20260901T000000Z',
		...(allDay
			? ['DTSTART;VALUE=DATE:20260930', 'DTEND;VALUE=DATE:20261001']
			: ['DTSTART:20260930T000000Z', 'DTEND:20260930T010000Z']),
		'SUMMARY:Synthetic',
		'END:VEVENT',
		'END:VCALENDAR',
		'',
	].join('\r\n');
	return mapCalendarEventResource({
		calendarUrl: URL,
		resourceUrl: validateAbsoluteHttpUrl(EVENT.resourceUrl),
		etag: EVENT.etag,
		resource: parseICalendarResource(Buffer.from(ics)),
	});
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.transport.mockResolvedValue({ serverUrl: URL, request: vi.fn() });
	mocks.create.mockResolvedValue(EVENT);
	mocks.update.mockResolvedValue(EVENT);
	mocks.upsert.mockResolvedValue({ action: 'create', event: EVENT });
	mocks.query.mockResolvedValue([]);
});

describe('r3 strict timed grammar and precision', () => {
	it.each([
		'2026-09-30T12:00:00.9Z',
		'2026-09-30T12:00:00.999999999z',
		new Date('2026-09-30T12:00:00.999Z'),
		luxon('2026-09-30T12:00:00.999Z'),
	])('floors every absolute input family without rounding: %s', (value) => {
		expect(normalizeStructuredTimedInput(value)?.toISOString()).toBe('2026-09-30T12:00:00.000Z');
	});
	it.each(['1969-12-31T23:59:59.900Z', new Date(-100), luxon('1969-12-31T23:59:59.900Z')])(
		'floors negative epochs toward negative infinity: %s',
		(value) => {
			expect(normalizeStructuredTimedInput(value)?.getTime()).toBe(-1000);
		},
	);
	it.each([
		'2026-02-29T12:00:00Z',
		'2100-02-29T12:00:00Z',
		'2026-04-31T12:00:00Z',
		'0000-01-01T00:00:00Z',
		'10000-01-01T00:00:00Z',
		'2026-09-30T24:00:00Z',
		'2026-09-30T12:60:00Z',
		'2026-09-30T12:00:60Z',
		'2026-09-30T12:00:00+24:00',
		'2026-09-30T12:00:00+01:60',
		'2026-09-30 12:00:00',
		'2026-09-30T12:00',
		'2026-09-30',
		' 2026-09-30T12:00:00Z',
		'2026-09-30T12:00:00Z ',
		'2026-09-30T12:00:00[Europe/Prague]',
		'1790769600000',
		1790769600000,
		null,
		true,
		[],
		{},
		new Date(NaN),
		{ isLuxonDateTime: true, isValid: false, toJSDate: () => new Date() },
		'0001-01-01T00:00:00+00:01',
		'9999-12-31T23:59:59-00:01',
	])('rejects invalid components/types before normalization: %s', (value) => {
		expect(parseStructuredTimedInput(value)).toBeUndefined();
	});
	it.each([
		'0001-01-01T00:00:00Z',
		'9999-12-31T23:59:59Z',
		'2000-02-29T12:00:00Z',
		'2026-09-30T12:00:00+23:59',
	])('accepts valid Gregorian and offset boundaries: %s', (value) => {
		expect(parseStructuredTimedInput(value)?.kind).toBe('instant');
	});
	it('preserves offsets across date rollover', () => {
		expect(normalizeStructuredTimedInput('2026-09-30T23:30:00.99-04:00')?.toISOString()).toBe(
			'2026-10-01T03:30:00.000Z',
		);
	});
});

describe('r3 local context and DST', () => {
	it.each([
		['Europe/Prague', '2026-03-29T02:30:00', 'nonexistent'],
		['Europe/Prague', '2026-10-25T02:30:00', 'ambiguous'],
		['Australia/Lord_Howe', '2026-10-04T02:15:00', 'nonexistent'],
		['Australia/Lord_Howe', '2026-04-05T01:45:00', 'ambiguous'],
		['Pacific/Apia', '2011-12-30T12:00:00', 'nonexistent'],
	])('rejects %s %s with field-specific correction', (zone, value, reason) => {
		expect(() => normalizeStructuredTimedInput(value, zone, 'Until')).toThrow(
			new RegExp(`Until.*${reason}`),
		);
		try {
			normalizeStructuredTimedInput(value, zone, 'Until');
		} catch (error) {
			expect(String(error)).not.toContain(value);
		}
	});
	it('retains both disambiguated fold instants at the normalization boundary', () => {
		expect(
			normalizeStructuredTimedInput('2026-10-25T02:30:00+02:00', 'Europe/Prague')?.toISOString(),
		).toBe('2026-10-25T00:30:00.000Z');
		expect(
			normalizeStructuredTimedInput('2026-10-25T02:30:00+01:00', 'Europe/Prague')?.toISOString(),
		).toBe('2026-10-25T01:30:00.000Z');
	});
	it.each(['2026-09-30T12:00:00Z', '2026-09-30T12:00:00'])(
		'fails invalid effective zones even for %s',
		(value) => {
			expect(() => normalizeStructuredTimedInput(value, 'Private/Canary', 'Start')).toThrow(
				/Start.*valid effective time zone/,
			);
		},
	);
	it('uses execution timezone for query and action timezone independently for authoring', async () => {
		await execute('getMany');
		expect(mocks.query.mock.calls[0][2]).toMatchObject({
			start: new Date('2026-09-30T00:00:00Z'),
			end: new Date('2026-09-30T01:00:00Z'),
		});
		await execute('create');
		expect(mocks.create.mock.calls[0][1]).toMatchObject({
			start: new Date('2026-09-30T02:00:00Z'),
		});
		await execute(
			'create',
			{ timeZoneMode: 'iana', timeZone: 'europe/prague' },
			'America/New_York',
		);
		expect(mocks.create.mock.calls[1][1]).toMatchObject({
			start: new Date('2026-09-30T00:00:00Z'),
			timeZone: { timeZoneMode: 'iana', timeZone: 'Europe/Prague' },
		});
	});
	it('honors configured global timezone supplied by n8n getTimezone', async () => {
		await execute('getMany', {}, 'America/New_York');
		expect(mocks.query.mock.calls[0][2].start).toEqual(new Date('2026-09-30T06:00:00Z'));
	});
	it.each(['getMany', 'create', 'upsert'])(
		'rejects collapsed %s ranges before I/O',
		async (operation) => {
			await expect(
				execute(operation, { start: '2026-09-30T12:00:00.1Z', end: '2026-09-30T12:00:00.9Z' }),
			).rejects.toBeInstanceOf(NodeOperationError);
			expect(mocks.transport).not.toHaveBeenCalled();
		},
	);
	it('rejects second-fold IANA authoring with UTC guidance rather than substituting its instant', async () => {
		await expect(
			execute('create', {
				timeZoneMode: 'iana',
				timeZone: 'Europe/Prague',
				start: '2026-10-25T02:30:00+01:00',
				end: '2026-10-25T03:30:00+01:00',
			}),
		).rejects.toThrow(/UTC/);
		expect(mocks.create).not.toHaveBeenCalled();
	});
});

describe('r3 structured authoring entry paths and date projection', () => {
	it.each(['create', 'upsert'])(
		'normalizes Date, Luxon and serialized mapped leaves identically for %s',
		async (operation) => {
			for (const value of [
				'2026-09-30T12:00:00.999Z',
				new Date('2026-09-30T12:00:00.999Z'),
				luxon('2026-09-30T12:00:00.999Z'),
			])
				await execute(operation, { start: value, end: '2026-09-30T13:00:00Z' });
			const service = operation === 'create' ? mocks.create : mocks.upsert;
			for (const call of service.mock.calls)
				expect(call[1].start).toEqual(new Date('2026-09-30T12:00:00Z'));
		},
	);
	it.each(['create', 'upsert'])(
		'projects all-day instant/date objects in workflow zone for %s',
		async (operation) => {
			for (const value of [
				'2026-09-30T23:30:00.999-04:00',
				new Date('2026-10-01T03:30:00.999Z'),
				luxon('2026-10-01T03:30:00.999Z'),
			])
				await execute(operation, {
					timeMode: 'allDay',
					start: undefined,
					end: undefined,
					startDate: value,
					endDate: '2026-10-02',
					timeZoneMode: undefined,
				});
			const service = operation === 'create' ? mocks.create : mocks.upsert;
			for (const call of service.mock.calls)
				expect(call[1]).toMatchObject({ startDate: '2026-10-01', endDate: '2026-10-02' });
		},
	);
	it.each(['create', 'upsert'])(
		'preserves literal dates and rejects local dateTime in date-only %s leaves',
		async (operation) => {
			await execute(
				operation,
				{
					timeMode: 'allDay',
					start: undefined,
					end: undefined,
					startDate: '2026-09-30',
					endDate: '2026-10-01',
				},
				'America/New_York',
			);
			await expect(
				execute(operation, {
					timeMode: 'allDay',
					start: undefined,
					end: undefined,
					startDate: '2026-09-30T23:30:00',
					endDate: '2026-10-02',
				}),
			).rejects.toThrow(/Start Date/);
		},
	);
	it.each(['create', 'upsert'])(
		'normalizes nested Until using final action zone for %s',
		async (operation) => {
			const rule = {
				rule: { frequency: 'daily', endMode: 'until', until: '2026-09-30T02:00:00.999' },
			};
			const recurrence = operation === 'create' ? rule : { change: { action: 'set', value: rule } };
			await execute(operation, {
				timeZoneMode: 'iana',
				timeZone: 'Europe/Prague',
				additionalFields: { recurrence },
			});
			const input = (operation === 'create' ? mocks.create : mocks.upsert).mock.calls[0][1];
			const normalized = operation === 'create' ? input.recurrence : input.recurrence.value;
			expect(normalized.end).toEqual({
				kind: 'until',
				value: { kind: 'dateTime', dateTime: '2026-09-30T00:00:00Z' },
			});
		},
	);
	it('continues mixed inputs with exact pairing and private-safe field failures', async () => {
		const rows = [parameters('getMany', { start: 'Private/Canary' }), parameters('getMany')];
		const result = await new CalDav().execute.call(context(rows, 'Europe/Prague', true));
		expect(result[0][0]).toMatchObject({
			pairedItem: { item: 0 },
			json: { error: expect.stringMatching(/Start/) },
		});
		expect(JSON.stringify(result)).not.toContain('Private/Canary');
		expect(mocks.query).toHaveBeenCalledOnce();
	});
	it('reuses UTC/local output leaves with their respective contexts', async () => {
		await execute('create', { start: EVENT.start, end: EVENT.end });
		expect(mocks.create.mock.calls[0][1].start).toEqual(new Date(EVENT.start));
		await execute('create', {
			start: '2026-09-30T02:00:00',
			end: '2026-09-30T03:00:00',
			timeZoneMode: 'iana',
			timeZone: 'Europe/Prague',
		});
		expect(mocks.create.mock.calls[1][1].start).toEqual(new Date(EVENT.start));
		await expect(execute('update', { fieldsToUpdate: EVENT })).rejects.toThrow(/Fields to Update/);
	});
});

describe('r3 Update deferred final context', () => {
	it('resolves local bounds after reading existing context and honors an explicit zone patch', async () => {
		await execute('update', {
			fieldsToUpdate: { start: '2026-09-30T02:00:00.999', end: '2026-09-30T03:00:00' },
		});
		const input = mocks.update.mock.calls[0][1];
		const existing = current();
		const prague = {
			...existing,
			event: {
				...existing.event,
				timeMode: 'timed',
				timeZoneMode: 'iana',
				timeZone: 'Europe/Prague',
			},
		};
		expect(input.resolveTemporalPatch(prague)).toMatchObject({
			start: { kind: 'set', value: new Date(EVENT.start) },
			end: { kind: 'set', value: new Date(EVENT.end) },
		});
		await execute('update', {
			fieldsToUpdate: {
				start: '2026-09-30T02:00:00',
				timeZone: { change: { timeZoneMode: 'utc' } },
			},
		});
		expect(mocks.update.mock.calls[1][1].resolveTemporalPatch(prague).start.value).toEqual(
			new Date('2026-09-30T02:00:00Z'),
		);
	});
	it('requires explicit zone for local all-day conversion while preserving absolute conversion', async () => {
		await execute('update', {
			fieldsToUpdate: { start: '2026-09-30T02:00:00', end: '2026-09-30T03:00:00' },
		});
		expect(() => mocks.update.mock.calls[0][1].resolveTemporalPatch(current(true))).toThrow(
			/explicit time-zone patch/,
		);
		await execute('update', { fieldsToUpdate: { start: EVENT.start, end: EVENT.end } });
		expect(mocks.update.mock.calls[1][1].resolveTemporalPatch(current(true))).toMatchObject({
			start: { value: new Date(EVENT.start) },
			end: { value: new Date(EVENT.end) },
		});
	});
	it('preserves omitted bounds in a zone-only patch', async () => {
		await execute('update', {
			fieldsToUpdate: { timeZone: { change: { timeZoneMode: 'iana', timeZone: 'Europe/Prague' } } },
		});
		expect(mocks.update.mock.calls[0][1].patch).toEqual({
			timeMode: 'timed',
			timeZone: { kind: 'set', value: { timeZoneMode: 'iana', timeZone: 'Europe/Prague' } },
		});
	});
});

describe('r3 alarm temporal controls remain strict', () => {
	it.each(['minute', 'hour', 'day', 'week'])(
		'preserves RFC %s units and integer limits',
		(unit) => {
			for (const value of [1, 2147483647])
				expect(
					normalizeAlarmCreateParameter(
						{ alarm: [{ action: 'audio', reference: 'end', direction: 'after', value, unit }] },
						'Synthetic',
					)[0].trigger,
				).toEqual({ reference: 'end', direction: 'after', value, unit });
		},
	);
	it.each(['1', 0, -1, 1.5, 2147483648, {}, 'PT1H'])(
		'rejects unsupported alarm numeric value %s',
		(value) => {
			expect(() =>
				normalizeAlarmCreateParameter(
					{
						alarm: [
							{ action: 'audio', reference: 'start', direction: 'before', value, unit: 'day' },
						],
					},
					'Synthetic',
				),
			).toThrow();
		},
	);
	it('normalizes At and edited nested trigger collections', () => {
		expect(
			normalizeAlarmCreateParameter(
				{ alarm: [{ action: 'audio', reference: 'start', direction: 'at' }] },
				'Synthetic',
			)[0].trigger,
		).toEqual({ reference: 'start', direction: 'at' });
		expect(
			normalizeAlarmMutationParameter({
				change: [
					{
						kind: 'edit',
						selectorKind: 'uid',
						alarmUid: 'synthetic-alarm',
						action: 'audio',
						fields: {
							trigger: {
								change: [{ reference: 'end', direction: 'before', value: 2, unit: 'week' }],
							},
						},
					},
				],
			})[0],
		).toMatchObject({
			alarm: { trigger: { reference: 'end', direction: 'before', value: 2, unit: 'week' } },
		});
	});
});

describe('r3 temporal leaf inventory and recurrence safety', () => {
	it.each(['create', 'upsert', 'getMany', 'update'])(
		'rejects invalid Start and End leaves before service calls for %s',
		async (operation) => {
			for (const field of ['start', 'end'])
				for (const value of [
					undefined,
					null,
					true,
					0,
					[],
					{},
					new Date(NaN),
					'2026-02-30T12:00:00.999Z',
					'2026-09-30T12:00',
				]) {
					const values =
						operation === 'update' ? { fieldsToUpdate: { [field]: value } } : { [field]: value };
					await expect(execute(operation, values)).rejects.toThrow(
						new RegExp(field === 'start' ? 'Start' : 'End'),
					);
				}
			expect(mocks.transport).not.toHaveBeenCalled();
		},
	);
	it.each(['create', 'upsert', 'update'])(
		'rejects invalid all-day date leaves before I/O for %s',
		async (operation) => {
			for (const field of ['startDate', 'endDate'])
				for (const value of [
					null,
					true,
					0,
					[],
					{},
					'2100-02-29',
					'0000-01-01',
					'2026-09-30T12:00:00',
				]) {
					const dates = { startDate: '2026-09-30', endDate: '2026-10-02', [field]: value };
					await expect(
						execute(
							operation,
							operation === 'update'
								? { timeMode: 'allDay', fieldsToUpdate: dates }
								: { ...dates, timeMode: 'allDay', start: undefined, end: undefined },
						),
					).rejects.toThrow(/Date/);
				}
			expect(mocks.transport).not.toHaveBeenCalled();
		},
	);
	it.each(['create', 'upsert'])(
		'normalizes all timed Until families and rejects earlier/malformed Until for %s',
		async (operation) => {
			const invoke = async (until: unknown) => {
				const value = { rule: { frequency: 'daily', endMode: 'until', until } };
				return execute(operation, {
					start: '2026-09-30T12:00:00Z',
					end: '2026-09-30T13:00:00Z',
					additionalFields: {
						recurrence: operation === 'create' ? value : { change: { action: 'set', value } },
					},
				});
			};
			for (const value of [
				'2026-09-30T12:00:00.999Z',
				new Date('2026-09-30T12:00:00.999Z'),
				luxon('2026-09-30T12:00:00.999Z'),
				'2026-09-30T12:00:00.999',
			])
				await invoke(value);
			const service = operation === 'create' ? mocks.create : mocks.upsert;
			for (const [, input] of service.mock.calls)
				expect(
					(operation === 'create' ? input.recurrence : input.recurrence.value).end.value.dateTime,
				).toBe('2026-09-30T12:00:00Z');
			for (const value of [
				'2026-09-30T11:59:59.999Z',
				'2026-09-30',
				'2026-02-30T12:00:00Z',
				undefined,
				null,
				0,
				{},
				[],
			])
				await expect(invoke(value)).rejects.toThrow();
			expect(service).toHaveBeenCalledTimes(4);
		},
	);
	it.each(['create', 'upsert'])(
		'projects all-day Until in workflow zone and allows equality for %s',
		async (operation) => {
			for (const until of [
				'2026-10-01',
				'2026-09-30T23:30:00.999-04:00',
				new Date('2026-10-01T03:30:00.999Z'),
				luxon('2026-10-01T03:30:00.999Z'),
			]) {
				const value = { rule: { frequency: 'daily', endMode: 'until', until } };
				await execute(operation, {
					timeMode: 'allDay',
					start: undefined,
					end: undefined,
					startDate: '2026-10-01',
					endDate: '2026-10-02',
					additionalFields: {
						recurrence: operation === 'create' ? value : { change: { action: 'set', value } },
					},
				});
			}
			const service = operation === 'create' ? mocks.create : mocks.upsert;
			for (const [, input] of service.mock.calls)
				expect(
					(operation === 'create' ? input.recurrence : input.recurrence.value).end.value,
				).toEqual({ kind: 'date', date: '2026-10-01' });
		},
	);
	it('resolves Update Until in its preserved final event zone', async () => {
		await execute('update', {
			fieldsToUpdate: {
				recurrence: {
					change: {
						action: 'set',
						value: {
							rule: { frequency: 'daily', endMode: 'until', until: '2026-09-30T02:00:00.999' },
						},
					},
				},
			},
		});
		const existing = current();
		const resolved = mocks.update.mock.calls[0][1].resolveTemporalPatch({
			...existing,
			event: {
				...existing.event,
				timeMode: 'timed',
				timeZoneMode: 'iana',
				timeZone: 'Europe/Prague',
			},
		});
		expect(resolved.recurrence.value.end.value).toEqual({
			kind: 'dateTime',
			dateTime: EVENT.start,
		});
	});
	it('uses authoritative embedded offsets rather than runtime IANA rules', () => {
		const definition = parseICalendarResource(
			Buffer.from(
				[
					'BEGIN:VCALENDAR',
					'VERSION:2.0',
					'PRODID:-//Synthetic//EN',
					'BEGIN:VTIMEZONE',
					'TZID:Europe/Prague',
					'BEGIN:STANDARD',
					'DTSTART:20200101T000000',
					'TZOFFSETFROM:+0300',
					'TZOFFSETTO:+0300',
					'END:STANDARD',
					'END:VTIMEZONE',
					'BEGIN:VEVENT',
					'UID:embedded@example.test',
					'DTSTAMP:20260901T000000Z',
					'DTSTART:20260930T000000Z',
					'DTEND:20260930T010000Z',
					'END:VEVENT',
					'END:VCALENDAR',
					'',
				].join('\r\n'),
			),
		).calendar.entries.find((entry) => entry.kind === 'component' && entry.name === 'VTIMEZONE');
		if (definition?.kind !== 'component') throw new Error('Synthetic VTIMEZONE missing.');
		expect(
			normalizeStructuredTimedInput('2026-09-30T03:00:00', 'Europe/Prague', 'Start', definition),
		).toEqual(new Date(EVENT.start));
	});
	it.each(['create', 'update', 'upsert'])(
		'passes complete-string Raw ICS unchanged through %s even with invalid workflow zone',
		async (operation) => {
			const rawIcs = [
				'BEGIN:VCALENDAR',
				'VERSION:2.0',
				'PRODID:-//Synthetic//EN',
				'BEGIN:VEVENT',
				'UID:raw@example.test',
				'DTSTAMP:20260901T000000Z',
				'DTSTART:20260930T020000',
				'DURATION:PT1H',
				'RRULE:FREQ=DAILY;COUNT=2',
				'END:VEVENT',
				'END:VCALENDAR',
				'',
			].join('\r\n');
			await execute(operation, { inputMode: 'rawIcs', rawIcs }, 'Private/Canary');
			const service =
				operation === 'create'
					? mocks.create
					: operation === 'update'
						? mocks.update
						: mocks.upsert;
			expect(service.mock.calls[0][1]).toMatchObject({ inputMode: 'rawIcs', rawIcs });
		},
	);
});

describe('F154-R01 exact stored TZID is authoritative for local Update', () => {
	function definition(tzid: string, offset: string) {
		return [
			'BEGIN:VTIMEZONE',
			`TZID:${tzid}`,
			'BEGIN:STANDARD',
			'DTSTART:20200101T000000',
			`TZOFFSETFROM:${offset}`,
			`TZOFFSETTO:${offset}`,
			'END:STANDARD',
			'END:VTIMEZONE',
		];
	}
	function resource(definitions: readonly string[][]) {
		return [
			'BEGIN:VCALENDAR',
			'VERSION:2.0',
			'PRODID:-//Synthetic exact TZID oracle//EN',
			...definitions.flat(),
			'BEGIN:VEVENT',
			`UID:${EVENT.uid}`,
			'DTSTAMP:20260901T000000Z',
			'DTSTART;TZID=US/Eastern:20260930T030000',
			'DTEND;TZID=US/Eastern:20260930T050000',
			'SUMMARY:Synthetic',
			'X-UNKNOWN:preserved',
			'END:VEVENT',
			'END:VCALENDAR',
			'',
		].join('\r\n');
	}
	it.each(['canonical-first', 'alias-first', 'retained-reference'] as const)(
		'keeps Start and Until at 09Z/04 local with %s rules',
		async (mode) => {
			const alias = definition('US/Eastern', '-0500');
			const decoy = definition('America/New_York', '-0400');
			const text = resource(
				mode === 'canonical-first'
					? [decoy, alias]
					: mode === 'alias-first'
						? [alias, decoy]
						: [decoy],
			);
			const retainedResource = parseICalendarResource(Buffer.from(resource([alias])));
			const retained = retainedResource.calendar.entries.find(
				(entry) => entry.kind === 'component' && entry.name === 'VTIMEZONE',
			);
			if (retained?.kind !== 'component')
				throw new Error('Synthetic reference definition missing.');
			const read = (ics: string) =>
				mapCalendarEventResource({
					calendarUrl: URL,
					resourceUrl: validateAbsoluteHttpUrl(EVENT.resourceUrl),
					etag: EVENT.etag,
					resource: parseICalendarResource(Buffer.from(ics)),
					...(mode === 'retained-reference' ? { timeZoneDefinition: retained } : {}),
				});
			const existing = read(text);
			expect(existing.event).toMatchObject({
				accessMode: 'editable',
				timeZone: 'America/New_York',
				start: '2026-09-30T08:00:00Z',
				startLocal: '2026-09-30T03:00:00',
			});
			await execute('update', {
				fieldsToUpdate: {
					start: '2026-09-30T04:00:00',
					recurrence: {
						change: {
							action: 'set',
							value: {
								rule: { frequency: 'daily', endMode: 'until', until: '2026-09-30T04:00:00' },
							},
						},
					},
				},
			});
			const input = mocks.update.mock.calls[0][1];
			const patch = input.resolveTemporalPatch(existing);
			expect(patch.start.value).toEqual(new Date('2026-09-30T09:00:00Z'));
			expect(patch.recurrence.value.end.value).toEqual({
				kind: 'dateTime',
				dateTime: '2026-09-30T09:00:00Z',
			});
			const { calendarEventPreservationTimeZoneDefinition } =
				await import('../../nodes/CalDav/icalendar/eventReadModel');
			const selected = calendarEventPreservationTimeZoneDefinition(existing.context);
			expect(selected?.entries).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						name: 'TZID',
						value: expect.objectContaining({ raw: 'US/Eastern' }),
					}),
				]),
			);
			expect(calendarEventPreservationTimeZoneDefinition({ ...existing.context })).toBeUndefined();
			expect(Object.keys(existing.context).sort()).toEqual(['exceptions', 'master', 'resource']);
			// A real coordinator invocation proves provenance and the preserved source TZID survive patching.
			const { updateCalendarEvent } = await vi.importActual<
				typeof import('../../nodes/CalDav/events/update')
			>('../../nodes/CalDav/events/update');
			let stored = text;
			const requests = vi.fn(
				async (request: {
					readonly method: string;
					readonly url: string;
					readonly body?: string;
				}) => {
					if (request.method === 'PUT') stored = request.body ?? '';
					return {
						statusCode: request.method === 'PUT' ? 204 : 200,
						effectiveUrl: request.url,
						headers: {},
						etag: EVENT.etag,
						body: Buffer.from(request.method === 'PUT' ? '' : stored),
					};
				},
			);
			// Referenced-rule fallback needs the already resolved read result; embedded modes exercise GET/PUT/GET.
			if (mode !== 'retained-reference') {
				const output = await updateCalendarEvent(
					{ serverUrl: URL, request: requests },
					input,
					() => new Date('2026-09-01T00:00:00Z'),
				);
				expect(output).toMatchObject({
					start: '2026-09-30T09:00:00Z',
					startLocal: '2026-09-30T04:00:00',
					end: '2026-09-30T10:00:00Z',
					recurrence: { end: { value: { dateTime: '2026-09-30T09:00:00Z' } } },
				});
				expect(stored).toContain('DTSTART;TZID=US/Eastern:20260930T040000');
				expect(stored).toContain('X-UNKNOWN:preserved');
				expect(requests.mock.calls.map(([request]) => request.method)).toEqual([
					'GET',
					'PUT',
					'GET',
				]);
			}
		},
	);
});
