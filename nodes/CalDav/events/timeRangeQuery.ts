import { mapCalendarEventResource } from '../icalendar/eventReadModel';
import type { CalendarEventReadResult } from '../icalendar/eventReadModel';
import { parseICalendarResource } from '../icalendar/parser';
import { CalDavMethod } from '../transport/http';
import type { CalDavTransport } from '../transport/http';
import { resolveCalDavHref } from '../transport/url';
import type { AbsoluteHttpUrl } from '../transport/url';
import { CalDavXmlProtocolError, parseDavMultiStatus } from '../xml/parser';
import type { DavProperty } from '../xml/parser';
import { buildCalendarTimeRangeQueryReport } from '../xml/requests';
import type { CalendarTimeRangeQueryInput } from '../xml/requests';

const DAV_NAMESPACE = 'DAV:';
const CALDAV_NAMESPACE = 'urn:ietf:params:xml:ns:caldav';

interface ResourceCandidate {
	readonly calendarData: string;
	readonly etag?: string;
}

function invalidResponse(): never {
	throw new CalDavXmlProtocolError('INVALID_RESPONSE');
}

function isProperty(property: DavProperty, namespaceUri: string, localName: string): boolean {
	return property.name.namespaceUri === namespaceUri && property.name.localName === localName;
}

function readCharacterData(property: DavProperty): string {
	let value = '';
	for (const child of property.children) {
		if (child.kind === 'element') invalidResponse();
		value += child.value;
	}
	return value;
}

function selectRequestedProperty(
	properties: readonly DavProperty[],
	namespaceUri: string,
	localName: string,
): string | undefined {
	const matches = properties.filter((property) => isProperty(property, namespaceUri, localName));
	if (matches.length > 1) invalidResponse();
	return matches[0] === undefined ? undefined : readCharacterData(matches[0]);
}

function addCandidate(
	candidates: Map<AbsoluteHttpUrl, ResourceCandidate>,
	resourceUrl: AbsoluteHttpUrl,
	candidate: ResourceCandidate,
): void {
	const existing = candidates.get(resourceUrl);
	if (existing === undefined) {
		candidates.set(resourceUrl, candidate);
		return;
	}

	if (
		existing.calendarData !== candidate.calendarData ||
		(existing.etag !== undefined &&
			candidate.etag !== undefined &&
			existing.etag !== candidate.etag)
	) {
		invalidResponse();
	}

	if (existing.etag === undefined && candidate.etag !== undefined) {
		candidates.set(resourceUrl, candidate);
	}
}

function compareUnicodeScalars(left: string, right: string): number {
	let leftIndex = 0;
	let rightIndex = 0;

	while (leftIndex < left.length && rightIndex < right.length) {
		const leftCodePoint = left.codePointAt(leftIndex)!;
		const rightCodePoint = right.codePointAt(rightIndex)!;
		if (leftCodePoint !== rightCodePoint) return leftCodePoint < rightCodePoint ? -1 : 1;
		leftIndex += leftCodePoint > 0xffff ? 2 : 1;
		rightIndex += rightCodePoint > 0xffff ? 2 : 1;
	}

	if (leftIndex === left.length && rightIndex === right.length) return 0;
	return leftIndex === left.length ? -1 : 1;
}

function compareResults(left: CalendarEventReadResult, right: CalendarEventReadResult): number {
	const leftTime =
		left.event.timeMode === 'timed'
			? left.event.start
			: left.event.timeMode === 'allDay'
				? `${left.event.startDate}T00:00:00Z`
				: undefined;
	const rightTime =
		right.event.timeMode === 'timed'
			? right.event.start
			: right.event.timeMode === 'allDay'
				? `${right.event.startDate}T00:00:00Z`
				: undefined;
	if (leftTime !== undefined && rightTime === undefined) return -1;
	if (leftTime === undefined && rightTime !== undefined) return 1;
	return (
		(leftTime === undefined || rightTime === undefined
			? 0
			: compareUnicodeScalars(leftTime, rightTime)) ||
		compareUnicodeScalars(left.event.uid, right.event.uid) ||
		compareUnicodeScalars(left.event.resourceUrl, right.event.resourceUrl)
	);
}

export async function queryCalendarEventsByTimeRange(
	transport: CalDavTransport,
	calendarUrl: AbsoluteHttpUrl,
	range: CalendarTimeRangeQueryInput,
): Promise<readonly CalendarEventReadResult[]> {
	const body = buildCalendarTimeRangeQueryReport(range);
	const response = await transport.request({
		method: CalDavMethod.REPORT,
		url: calendarUrl,
		headers: {
			Depth: '1',
			'Content-Type': 'application/xml; charset=utf-8',
		},
		body,
	});

	if (response.statusCode !== 207) {
		throw new CalDavXmlProtocolError('INVALID_MULTISTATUS');
	}

	const multiStatus = parseDavMultiStatus(response.body.toString('utf8'));
	const candidates = new Map<AbsoluteHttpUrl, ResourceCandidate>();

	for (const resourceResponse of multiStatus.responses) {
		if (resourceResponse.hrefs.length !== 1) invalidResponse();
		const resourceUrl = resolveCalDavHref(response.effectiveUrl, resourceResponse.hrefs[0]);

		if (resourceResponse.kind === 'status') {
			if (resourceResponse.status.isSuccessful) invalidResponse();
			continue;
		}

		const calendarData = selectRequestedProperty(
			resourceResponse.successfulProperties,
			CALDAV_NAMESPACE,
			'calendar-data',
		);
		const etag = selectRequestedProperty(
			resourceResponse.successfulProperties,
			DAV_NAMESPACE,
			'getetag',
		);
		if (calendarData === undefined) continue;

		addCandidate(candidates, resourceUrl, {
			calendarData,
			...(etag === undefined ? {} : { etag }),
		});
	}

	const results: CalendarEventReadResult[] = [];
	for (const [resourceUrl, candidate] of candidates) {
		const resource = parseICalendarResource(Buffer.from(candidate.calendarData, 'utf8'));
		results.push(
			mapCalendarEventResource({
				calendarUrl,
				resourceUrl,
				...(candidate.etag === undefined ? {} : { etag: candidate.etag }),
				resource,
			}),
		);
	}

	results.sort(compareResults);
	return Object.freeze(results);
}
