export interface SyntheticDiscoveryResponse {
	readonly statusCode: number;
	readonly headers?: Readonly<Record<string, string | readonly string[]>>;
	readonly body?: string;
}

export interface SyntheticDiscoveryStep {
	readonly id: string;
	readonly method: string;
	readonly url: string;
	readonly depth?: string;
	readonly response?: SyntheticDiscoveryResponse;
	readonly error?: unknown;
}

export interface SyntheticDiscoveryFixture {
	readonly id: string;
	readonly configuredUrl: string;
	readonly steps: readonly SyntheticDiscoveryStep[];
}

const STANDARD_PRINCIPAL = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:"><d:response><d:href>/fictional/root/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/fictional/principals/user/</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;

const STANDARD_HOME = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/fictional/principals/user/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/fictional/homes/user/</d:href></c:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;

const STANDARD_COLLECTIONS = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
 <d:response><d:href>calendars/team/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Team</d:displayname><c:calendar-description>Synthetic calendar</c:calendar-description><c:supported-calendar-component-set><c:comp name="VEVENT"/><c:comp name="VTODO"/></c:supported-calendar-component-set><d:current-user-privilege-set><d:privilege><d:read/></d:privilege></d:current-user-privilege-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><d:displayname>Failed fictional value</d:displayname></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>
 <d:response><d:href>https://collections.example.test/public/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><d:displayname>Unavailable</d:displayname><c:calendar-description>Unavailable</c:calendar-description><d:current-user-privilege-set/></d:prop><d:status>HTTP/1.1 403 Forbidden</d:status></d:propstat></d:response>
 <d:response><d:href>principals/ignored/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><d:principal/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
 <d:response><d:href>tasks/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;

const ICLOUD_STYLE_PRINCIPAL = `<?xml version="1.0"?>
<multistatus xmlns="DAV:"><response><href>/fictional/root/</href><propstat><prop><current-user-principal><href>/fictional/principals/user/</href></current-user-principal></prop><status>HTTP/1.1 200 OK</status></propstat><propstat><prop><current-user-principal><href>/failed/</href></current-user-principal></prop><status>HTTP/1.1 404 Not Found</status></propstat></response></multistatus>`;

const ICLOUD_STYLE_HOME = `<?xml version="1.0"?>
<w:multistatus xmlns:w="DAV:" xmlns:calendar="urn:ietf:params:xml:ns:caldav"><w:response><w:href>/fictional/principals/user/</w:href><w:propstat><w:prop><calendar:calendar-home-set><w:href>/fictional/homes/user/</w:href></calendar:calendar-home-set></w:prop><w:status>HTTP/1.1 200 OK</w:status></w:propstat><w:propstat><w:prop><calendar:calendar-home-set><w:href>/failed/</w:href></calendar:calendar-home-set></w:prop><w:status>HTTP/1.1 403 Forbidden</w:status></w:propstat></w:response></w:multistatus>`;

const ICLOUD_STYLE_COLLECTIONS = `<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:calendar="urn:ietf:params:xml:ns:caldav">
 <response><href>calendars/team/</href><propstat><prop><resourcetype><collection/><calendar:calendar/></resourcetype><displayname>Team</displayname></prop><status>HTTP/1.1 200 OK</status></propstat><propstat><prop><calendar:calendar-description>Synthetic calendar</calendar:calendar-description><calendar:supported-calendar-component-set><calendar:comp name="VEVENT"/><calendar:comp name="VTODO"/></calendar:supported-calendar-component-set><current-user-privilege-set><privilege><read/></privilege></current-user-privilege-set></prop><status>HTTP/1.1 299 Synthetic Success</status></propstat><propstat><prop><displayname>Failed fictional value</displayname></prop><status>HTTP/1.1 404 Not Found</status></propstat></response>
 <response><href>https://collections.example.test/public/</href><propstat><prop><resourcetype><collection/><calendar:calendar/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat><propstat><prop><displayname>Unavailable</displayname><calendar:calendar-description>Unavailable</calendar:calendar-description><current-user-privilege-set/></prop><status>HTTP/1.1 403 Forbidden</status></propstat></response>
 <response><href>principals/ignored/</href><propstat><prop><resourcetype><collection/><principal/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
 <response><href>tasks/</href><propstat><prop><resourcetype><collection/><calendar:calendar/></resourcetype><calendar:supported-calendar-component-set><calendar:comp name="VTODO"/></calendar:supported-calendar-component-set></prop><status>HTTP/1.1 200 OK</status></propstat></response>
</multistatus>`;

function equivalentSteps(
	principalBody: string,
	homeBody: string,
	collectionsBody: string,
): readonly SyntheticDiscoveryStep[] {
	return Object.freeze([
		{
			id: 'capability',
			method: 'OPTIONS',
			url: 'https://calendar.example.test/fictional/root/',
			response: { statusCode: 200, headers: { DAV: '1, calendar-access' } },
		},
		{
			id: 'principal',
			method: 'PROPFIND',
			url: 'https://calendar.example.test/fictional/root/',
			depth: '0',
			response: { statusCode: 207, body: principalBody },
		},
		{
			id: 'home',
			method: 'PROPFIND',
			url: 'https://calendar.example.test/fictional/principals/user/',
			depth: '0',
			response: { statusCode: 207, body: homeBody },
		},
		{
			id: 'collections',
			method: 'PROPFIND',
			url: 'https://calendar.example.test/fictional/homes/user/',
			depth: '1',
			response: { statusCode: 207, body: collectionsBody },
		},
	]);
}

export const standardEquivalentFixture: SyntheticDiscoveryFixture = Object.freeze({
	id: 'standard-equivalent',
	configuredUrl: 'https://calendar.example.test/fictional/root/',
	steps: equivalentSteps(STANDARD_PRINCIPAL, STANDARD_HOME, STANDARD_COLLECTIONS),
});

export const iCloudStyleEquivalentFixture: SyntheticDiscoveryFixture = Object.freeze({
	id: 'icloud-style-equivalent',
	configuredUrl: 'https://calendar.example.test/fictional/root/',
	steps: equivalentSteps(ICLOUD_STYLE_PRINCIPAL, ICLOUD_STYLE_HOME, ICLOUD_STYLE_COLLECTIONS),
});

export const iCloudPartitionFixture: SyntheticDiscoveryFixture = Object.freeze({
	id: 'icloud-partition-relative',
	configuredUrl: 'https://caldav.icloud.com/fictional-entry/',
	steps: Object.freeze([
		{
			id: 'capability',
			method: 'OPTIONS',
			url: 'https://caldav.icloud.com/fictional-entry/',
			response: { statusCode: 200, headers: { DAV: 'calendar-access' } },
		},
		{
			id: 'principal-entry',
			method: 'PROPFIND',
			url: 'https://caldav.icloud.com/fictional-entry/',
			depth: '0',
			response: {
				statusCode: 302,
				headers: { Location: 'https://p42-caldav.icloud.com/fictional-zone/discovery/' },
			},
		},
		{
			id: 'principal-partition',
			method: 'PROPFIND',
			url: 'https://p42-caldav.icloud.com/fictional-zone/discovery/',
			depth: '0',
			response: {
				statusCode: 207,
				body: '<multistatus xmlns="DAV:"><response><href>/fictional/</href><propstat><prop><current-user-principal><href>principal/fictional-user/</href></current-user-principal></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>',
			},
		},
		{
			id: 'home',
			method: 'PROPFIND',
			url: 'https://p42-caldav.icloud.com/fictional-zone/discovery/principal/fictional-user/',
			depth: '0',
			response: {
				statusCode: 207,
				body: '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/fictional/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/fictional-zone/homes/fictional-user/</d:href></c:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>',
			},
		},
		{
			id: 'collections',
			method: 'PROPFIND',
			url: 'https://p42-caldav.icloud.com/fictional-zone/homes/fictional-user/',
			depth: '1',
			response: {
				statusCode: 207,
				body: '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>events/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:current-user-privilege-set><d:privilege><d:read/></d:privilege></d:current-user-privilege-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>',
			},
		},
	]),
});

export const unsafeHrefCases = Object.freeze([
	{ id: 'malformed-whitespace', href: ' href-sentinel', urlCode: 'MALFORMED_URL' },
	{ id: 'empty', href: '', urlCode: undefined },
	{ id: 'fragment', href: 'href-sentinel#fragment', urlCode: 'FRAGMENT_NOT_ALLOWED' },
	{
		id: 'userinfo',
		href: 'https://fictional-user:credential-sentinel@example.test/path',
		urlCode: 'USERINFO_NOT_ALLOWED',
	},
	{ id: 'dot-segment', href: '../href-sentinel', urlCode: 'DOT_SEGMENT_NOT_ALLOWED' },
	{ id: 'backslash', href: 'href\\sentinel', urlCode: 'MALFORMED_URL' },
	{
		id: 'downgrade',
		href: 'http://calendar.example.test/href-sentinel',
		urlCode: 'INSECURE_PROTOCOL_DOWNGRADE',
	},
	{ id: 'malformed-percent', href: 'href%GG-sentinel', urlCode: 'MALFORMED_PERCENT_ENCODING' },
] as const);

export const SYNTHETIC_DISCOVERY_CASE_IDS = Object.freeze([
	standardEquivalentFixture.id,
	iCloudStyleEquivalentFixture.id,
	iCloudPartitionFixture.id,
	'missing-capability',
	'failed-principal-required-property',
	'forbidden-home-required-property',
	...unsafeHrefCases.flatMap(({ id }) => [
		`principal-href-${id}`,
		`home-href-${id}`,
		`collection-href-${id}`,
	]),
]);
