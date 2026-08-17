export const PINNED_TZDB_VERSION = '2026c' as const;

export const CANONICAL_ZONE_ORACLE = Object.freeze([
	'Africa/Abidjan',
	'America/New_York',
	'Asia/Kathmandu',
	'Asia/Kolkata',
	'Australia/Lord_Howe',
	'Etc/GMT+5',
	'Europe/Prague',
	'Pacific/Auckland',
] as const);

export const ALIAS_ORACLE = Object.freeze([
	{ input: 'Europe/Prague', canonical: 'Europe/Prague' },
	{ input: 'europe/prague', canonical: 'Europe/Prague' },
	{ input: 'US/Eastern', canonical: 'America/New_York' },
	{ input: 'us/eastern', canonical: 'America/New_York' },
	{ input: 'Asia/Calcutta', canonical: 'Asia/Kolkata' },
	{ input: 'Asia/Katmandu', canonical: 'Asia/Kathmandu' },
] as const);

export const UTC_EQUIVALENT_ZONE_ORACLE = Object.freeze([
	'UTC',
	'utc',
	'Etc/UTC',
	'Etc/UCT',
	'Etc/Universal',
	'Etc/Zulu',
	'Etc/GMT',
	'Etc/GMT+0',
	'Etc/GMT-0',
	'Etc/GMT0',
	'GMT',
	'GMT+0',
	'GMT-0',
	'GMT0',
	'Greenwich',
	'UCT',
	'Universal',
	'Zulu',
] as const);

export const INVALID_ZONE_ORACLE = Object.freeze([
	'',
	' Europe/Prague',
	'Europe/Prague ',
	'+01:00',
	'GMT+01:00',
	'CET',
	'Eastern Standard Time',
	'Factory',
	'private/account-zone',
	'Europe/Pragu\u00e9',
	'Europe\\Prague',
	'../Europe/Prague',
	'Unknown/Nowhere',
] as const);

export interface InstantProjectionOracle {
	readonly zone: string;
	readonly instant: string;
	readonly local: string;
}

export const INSTANT_PROJECTION_ORACLE = Object.freeze([
	{ zone: 'Europe/Prague', instant: '2040-01-15T09:00:00Z', local: '2040-01-15T10:00:00' },
	{ zone: 'America/New_York', instant: '2040-07-15T16:00:00Z', local: '2040-07-15T12:00:00' },
	{ zone: 'Asia/Kolkata', instant: '2040-01-15T09:00:00Z', local: '2040-01-15T14:30:00' },
	{ zone: 'Asia/Kathmandu', instant: '2040-01-15T09:00:00Z', local: '2040-01-15T14:45:00' },
	{ zone: 'Australia/Lord_Howe', instant: '2040-01-15T09:00:00Z', local: '2040-01-15T20:00:00' },
	{ zone: 'Etc/GMT+5', instant: '2040-01-15T09:00:00Z', local: '2040-01-15T04:00:00' },
] satisfies readonly InstantProjectionOracle[]);

export const TRANSITION_ORACLE = Object.freeze({
	pragueGap: { local: '2040-03-25T02:30:00', resolved: '2040-03-25T01:30:00Z' },
	pragueOverlap: {
		local: '2040-10-28T02:30:00',
		first: '2040-10-28T00:30:00Z',
		second: '2040-10-28T01:30:00Z',
	},
	newYorkGap: { local: '2040-03-11T02:30:00', resolved: '2040-03-11T07:30:00Z' },
	newYorkOverlap: {
		local: '2040-11-04T01:30:00',
		first: '2040-11-04T05:30:00Z',
		second: '2040-11-04T06:30:00Z',
	},
});

export const PRIVACY_SENTINELS = Object.freeze({
	rejectedZone: 'Private/Account-42',
	calendarUrl: 'https://calendar.example.test/private-account/calendar/',
	serviceUrl: 'https://tzdist.example.test/private-service/',
	credential: 'basic-private-credential',
	cookie: 'private-cookie=secret',
	etag: '"private-etag"',
	date: '2040-10-28T01:30:00Z',
	serverBody: 'private-response-body',
});

export function timedEventIcs(
	startLine: string,
	endLine: string,
	components: readonly string[] = [],
): string {
	return [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//Synthetic Test Fixture//EN',
		...components,
		'BEGIN:VEVENT',
		'UID:synthetic-time-zone-event',
		'DTSTAMP:20400101T000000Z',
		startLine,
		endLine,
		'SUMMARY:Synthetic event',
		'X-SYNTHETIC-PRESERVE:opaque-value',
		'END:VEVENT',
		'END:VCALENDAR',
		'',
	].join('\r\n');
}

export const PRAGUE_VTIMEZONE = [
	'BEGIN:VTIMEZONE',
	'TZID:Europe/Prague',
	'BEGIN:STANDARD',
	'DTSTART:20391030T030000',
	'TZOFFSETFROM:+0300',
	'TZOFFSETTO:+0200',
	'RDATE:20401028T030000',
	'END:STANDARD',
	'BEGIN:DAYLIGHT',
	'DTSTART:20400325T020000',
	'TZOFFSETFROM:+0200',
	'TZOFFSETTO:+0300',
	'RDATE:20410331T020000',
	'END:DAYLIGHT',
	'END:VTIMEZONE',
].join('\r\n');

export const MALFORMED_PRAGUE_VTIMEZONE = [
	'BEGIN:VTIMEZONE',
	'TZID:Europe/Prague',
	'BEGIN:STANDARD',
	'DTSTART:20401028T030000',
	'TZOFFSETFROM:+0300',
	'END:STANDARD',
	'END:VTIMEZONE',
].join('\r\n');

export const UNSUPPORTED_UNREFERENCED_VTIMEZONE = [
	'BEGIN:VTIMEZONE',
	'TZID:Private/Unused',
	'X-OPAQUE:preserve-me',
	'END:VTIMEZONE',
].join('\r\n');

export const SUPPORTED_UTC_EVENT = timedEventIcs(
	'DTSTART:20400115T090000Z',
	'DTEND:20400115T100000Z',
);

export const SUPPORTED_BARE_IANA_EVENT = timedEventIcs(
	'DTSTART;TZID=Europe/Prague:20400115T100000',
	'DTEND;TZID=Europe/Prague:20400115T110000',
);

export const SUPPORTED_EMBEDDED_IANA_EVENT = timedEventIcs(
	'DTSTART;TZID=Europe/Prague:20400715T100000',
	'DTEND;TZID=Europe/Prague:20400715T110000',
	[PRAGUE_VTIMEZONE],
);

export const READ_ONLY_EVENT_ORACLE = Object.freeze([
	{
		name: 'mixed UTC and IANA',
		ics: timedEventIcs('DTSTART:20400115T090000Z', 'DTEND;TZID=Europe/Prague:20400115T110000'),
	},
	{
		name: 'distinct zones',
		ics: timedEventIcs(
			'DTSTART;TZID=Europe/Prague:20400115T100000',
			'DTEND;TZID=America/New_York:20400115T110000',
		),
	},
	{
		name: 'floating local values',
		ics: timedEventIcs('DTSTART:20400115T100000', 'DTEND:20400115T110000'),
	},
	{
		name: 'date with TZID',
		ics: timedEventIcs(
			'DTSTART;VALUE=DATE;TZID=Europe/Prague:20400115',
			'DTEND;VALUE=DATE;TZID=Europe/Prague:20400116',
		),
	},
	{
		name: 'private TZID',
		ics: timedEventIcs(
			'DTSTART;TZID=Private/Account-42:20400115T100000',
			'DTEND;TZID=Private/Account-42:20400115T110000',
		),
	},
	{
		name: 'UTC-equivalent TZID',
		ics: timedEventIcs(
			'DTSTART;TZID=Etc/UTC:20400115T100000',
			'DTEND;TZID=Etc/UTC:20400115T110000',
		),
	},
	{
		name: 'missing embedded definition',
		ics: timedEventIcs(
			'DTSTART;TZID=Europe/Prague:20400115T100000',
			'DTEND;TZID=Europe/Prague:20400115T110000',
			[MALFORMED_PRAGUE_VTIMEZONE],
		),
	},
] as const);

export const TZDIST_CAPABILITIES = JSON.stringify({
	version: 1,
	info: { primarySource: 'synthetic-2026c' },
	actions: ['list', 'get'],
});

export const TZDIST_ZONE_RESPONSE = [
	'BEGIN:VCALENDAR',
	'VERSION:2.0',
	'PRODID:-//Synthetic TZDIST Fixture//EN',
	PRAGUE_VTIMEZONE,
	'END:VCALENDAR',
	'',
].join('\r\n');

export const CALDAV_TIMEZONE_SERVICE_SET_XML = `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
  <d:response>
    <d:href>/principals/synthetic/</d:href>
    <d:propstat><d:prop><cs:timezone-service-set>
      <d:href>https://tzdist-a.example.test/</d:href>
      <d:href>https://tzdist-b.example.test/</d:href>
      <d:href>https://tzdist-a.example.test/</d:href>
    </cs:timezone-service-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;
