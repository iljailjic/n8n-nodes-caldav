/** Sanitized protocol-only provider histories; event fields below are synthetic. */
import expanded from './issue-157-provider-expanded.json';

interface Case {
	readonly id: string;
	readonly name: string;
	readonly zone: string;
	readonly localStart: string;
	readonly expectedStart: string;
	readonly expectedByProvider?: Partial<Record<'radicale' | 'icloud', string>>;
}

export const ISSUE_157_PROVIDER_CASES: readonly Case[] = [
	{
		id: '01',
		name: 'Prague',
		zone: 'Europe/Prague',
		localStart: '20261006T092000',
		expectedStart: '2026-10-06T07:20:00Z',
	},
	{
		id: '02',
		name: 'New York',
		zone: 'America/New_York',
		localStart: '20261006T092000',
		expectedStart: '2026-10-06T13:20:00Z',
	},
	{
		id: '03',
		name: 'Lord Howe',
		zone: 'Australia/Lord_Howe',
		localStart: '20261006T092000',
		expectedStart: '2026-10-05T22:20:00Z',
	},
	{
		id: '04',
		name: 'Chatham',
		zone: 'Pacific/Chatham',
		localStart: '20261006T092000',
		expectedStart: '2026-10-05T19:35:00Z',
	},
	{
		id: '05',
		name: 'Kathmandu',
		zone: 'Asia/Kathmandu',
		localStart: '20261006T092000',
		expectedStart: '2026-10-06T03:35:00Z',
	},
	{
		id: '06',
		name: 'Kolkata',
		zone: 'Asia/Kolkata',
		localStart: '20261006T092000',
		expectedStart: '2026-10-06T03:50:00Z',
	},
	{
		id: '07',
		name: 'Apia embedded-rule history',
		zone: 'Pacific/Apia',
		localStart: '20261006T092000',
		expectedStart: '2026-10-05T19:20:00Z',
		expectedByProvider: { radicale: '2026-10-05T20:20:00Z' },
	},
	{
		id: '08',
		name: 'Casablanca provider +01 history',
		zone: 'Africa/Casablanca',
		localStart: '20261006T092000',
		expectedStart: '2026-10-06T08:20:00Z',
	},
	{
		id: '10',
		name: 'fractional offset input projected into Prague',
		zone: 'Europe/Prague',
		localStart: '20261006T053500',
		expectedStart: '2026-10-06T03:35:00Z',
	},
];

export function syntheticProviderCalendarData(
	testCase: Case,
	provider: 'radicale' | 'icloud',
): string {
	const end = testCase.localStart.replace('092000', '093500').replace('053500', '055000');
	const definition = (expanded.cases[provider] as Record<string, string>)[testCase.id];
	if (!definition) throw new Error(`Missing sanitized ${provider} history for ${testCase.id}.`);
	return [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//example.test//Synthetic issue 157 provider shape//EN',
		definition.trimEnd(),
		'BEGIN:VEVENT',
		'UID:synthetic-issue-157@example.test',
		'DTSTAMP:20260101T000000Z',
		`DTSTART;TZID=${testCase.zone}:${testCase.localStart}`,
		`DTEND;TZID=${testCase.zone}:${end}`,
		'SUMMARY:Synthetic provider event',
		'END:VEVENT',
		'END:VCALENDAR',
		'',
	].join('\r\n');
}
