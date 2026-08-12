export type XmlNamespaceKey = 'dav' | 'caldav';

export interface XmlQualifiedName {
	readonly namespace: XmlNamespaceKey;
	readonly namespaceUri: string;
	readonly prefix: 'd' | 'c';
	readonly localName: string;
	readonly qualifiedName: string;
}

export const XML_NAMESPACE_URIS: Readonly<{
	dav: 'DAV:';
	caldav: 'urn:ietf:params:xml:ns:caldav';
}> = Object.freeze({
	dav: 'DAV:',
	caldav: 'urn:ietf:params:xml:ns:caldav',
});

export const XML_NAMESPACE_PREFIXES: Readonly<{
	dav: 'd';
	caldav: 'c';
}> = Object.freeze({
	dav: 'd',
	caldav: 'c',
});

export const XML_NAMESPACE_DECLARATIONS: Readonly<{
	dav: 'xmlns:d="DAV:"';
	caldav: 'xmlns:c="urn:ietf:params:xml:ns:caldav"';
}> = Object.freeze({
	dav: 'xmlns:d="DAV:"',
	caldav: 'xmlns:c="urn:ietf:params:xml:ns:caldav"',
});

function createQualifiedName(namespace: XmlNamespaceKey, localName: string): XmlQualifiedName {
	const prefix = XML_NAMESPACE_PREFIXES[namespace];

	return Object.freeze({
		namespace,
		namespaceUri: XML_NAMESPACE_URIS[namespace],
		prefix,
		localName,
		qualifiedName: `${prefix}:${localName}`,
	});
}

export const XML_QUALIFIED_NAMES: Readonly<{
	propfind: XmlQualifiedName;
	prop: XmlQualifiedName;
	currentUserPrincipal: XmlQualifiedName;
	resourceType: XmlQualifiedName;
	displayName: XmlQualifiedName;
	getEtag: XmlQualifiedName;
	calendarHomeSet: XmlQualifiedName;
	calendarDescription: XmlQualifiedName;
	calendarTimezone: XmlQualifiedName;
	supportedCalendarComponentSet: XmlQualifiedName;
	currentUserPrivilegeSet: XmlQualifiedName;
	calendarQuery: XmlQualifiedName;
	calendarData: XmlQualifiedName;
	filter: XmlQualifiedName;
	compFilter: XmlQualifiedName;
	propFilter: XmlQualifiedName;
	textMatch: XmlQualifiedName;
	timeRange: XmlQualifiedName;
}> = Object.freeze({
	propfind: createQualifiedName('dav', 'propfind'),
	prop: createQualifiedName('dav', 'prop'),
	currentUserPrincipal: createQualifiedName('dav', 'current-user-principal'),
	resourceType: createQualifiedName('dav', 'resourcetype'),
	displayName: createQualifiedName('dav', 'displayname'),
	getEtag: createQualifiedName('dav', 'getetag'),
	calendarHomeSet: createQualifiedName('caldav', 'calendar-home-set'),
	calendarDescription: createQualifiedName('caldav', 'calendar-description'),
	calendarTimezone: createQualifiedName('caldav', 'calendar-timezone'),
	supportedCalendarComponentSet: createQualifiedName('caldav', 'supported-calendar-component-set'),
	currentUserPrivilegeSet: createQualifiedName('dav', 'current-user-privilege-set'),
	calendarQuery: createQualifiedName('caldav', 'calendar-query'),
	calendarData: createQualifiedName('caldav', 'calendar-data'),
	filter: createQualifiedName('caldav', 'filter'),
	compFilter: createQualifiedName('caldav', 'comp-filter'),
	propFilter: createQualifiedName('caldav', 'prop-filter'),
	textMatch: createQualifiedName('caldav', 'text-match'),
	timeRange: createQualifiedName('caldav', 'time-range'),
});
