import type { IExecuteFunctions, INode } from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	createN8nCalDavTransport: vi.fn(),
}));

vi.mock('../../nodes/CalDav/transport/http', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../nodes/CalDav/transport/http')>()),
	createN8nCalDavTransport: mocks.createN8nCalDavTransport,
}));

import { CalDav } from '../../nodes/CalDav/CalDav.node';
import { CalDavMethod } from '../../nodes/CalDav/transport/http';
import type {
	CalDavTransport,
	CalDavTransportRequest,
	CalDavTransportResponse,
} from '../../nodes/CalDav/transport/http';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';

const CALENDAR_URL = validateAbsoluteHttpUrl('https://calendar.example.test/calendars/work/');
const RESOURCE_URL = validateAbsoluteHttpUrl(
	'https://calendar.example.test/calendars/work/random-name.ics',
);
const UID = 'delete-resolution@example.test';

const NODE: INode = {
	id: 'event-delete-resolution-regression',
	name: 'CalDAV Event Delete Resolution Regression',
	type: 'calDav',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

type IdentifierMode = 'resourceUrl' | 'uid';

interface DeleteParameters {
	readonly resource: 'event';
	readonly operation: 'delete';
	readonly calendar: unknown;
	readonly identifierMode: IdentifierMode;
	readonly resourceUrl?: string;
	readonly uid?: string;
	readonly etag: unknown;
}

function eventIcs(): string {
	return [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//example.test//Delete resolution oracle//EN',
		'BEGIN:VEVENT',
		`UID:${UID}`,
		'DTSTAMP:20400101T000000Z',
		'DTSTART:20400102T100000Z',
		'DTEND:20400102T103000Z',
		'SUMMARY:Delete resolution oracle',
		'END:VEVENT',
		'END:VCALENDAR',
		'',
	].join('\r\n');
}

function escapeXmlText(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function uidReportWithoutEtag(): Buffer {
	return Buffer.from(
		`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>${RESOURCE_URL}</d:href><d:propstat><d:prop><c:calendar-data>${escapeXmlText(eventIcs())}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
		'utf8',
	);
}

function response(
	statusCode: number,
	effectiveUrl: string,
	body: Buffer,
	headers: Readonly<Record<string, string>> = {},
): CalDavTransportResponse {
	return { statusCode, effectiveUrl, body, headers };
}

function transport(identifierMode: IdentifierMode): CalDavTransport & {
	readonly request: ReturnType<typeof vi.fn>;
} {
	return {
		serverUrl: 'https://calendar.example.test/',
		request: vi.fn(async (input: CalDavTransportRequest) => {
			if (identifierMode === 'resourceUrl' && input.method === CalDavMethod.GET) {
				return response(200, RESOURCE_URL, Buffer.from(eventIcs(), 'utf8'), {
					'content-type': 'text/calendar; charset=utf-8',
				});
			}
			if (identifierMode === 'uid' && input.method === CalDavMethod.REPORT) {
				return response(207, CALENDAR_URL, uidReportWithoutEtag(), {
					'content-type': 'application/xml; charset=utf-8',
				});
			}
			if (input.method === CalDavMethod.DELETE) {
				return response(204, RESOURCE_URL, Buffer.alloc(0));
			}
			throw new Error(`Unexpected ${input.method} request in Delete resolution oracle.`);
		}),
	};
}

function parameters(identifierMode: IdentifierMode, etag: unknown): DeleteParameters {
	return {
		resource: 'event',
		operation: 'delete',
		calendar: { __rl: true, mode: 'url', value: CALENDAR_URL },
		identifierMode,
		...(identifierMode === 'resourceUrl' ? { resourceUrl: RESOURCE_URL } : { uid: UID }),
		etag,
	};
}

function context(values: DeleteParameters): IExecuteFunctions {
	return {
		getInputData: vi.fn().mockReturnValue([{ json: { oracle: 'delete-resolution' } }]),
		getNodeParameter: vi.fn((name: keyof DeleteParameters, itemIndex: number) => {
			expect(itemIndex).toBe(0);
			return Reflect.get(values, name);
		}),
		getNode: vi.fn().mockReturnValue(NODE),
		continueOnFail: vi.fn().mockReturnValue(false),
	} as unknown as IExecuteFunctions;
}

async function captureError(executionContext: IExecuteFunctions): Promise<Error> {
	try {
		await new CalDav().execute.call(executionContext);
	} catch (error) {
		return error as Error;
	}
	throw new Error('Expected Event Delete resolution to fail.');
}

beforeEach(() => {
	mocks.createN8nCalDavTransport.mockReset();
});

describe('Event Delete missing-remote-ETag resolution regression', () => {
	it.each(['resourceUrl', 'uid'] as const)(
		'uses the non-empty caller ETag after real %s resolution omits the remote ETag',
		async (identifierMode) => {
			const liveTransport = transport(identifierMode);
			mocks.createN8nCalDavTransport.mockResolvedValue(liveTransport);
			const callerEtag = ' W/"caller-validator" ';

			await expect(
				new CalDav().execute.call(context(parameters(identifierMode, callerEtag))),
			).resolves.toEqual([
				[
					{
						json: {
							calendarUrl: CALENDAR_URL,
							resourceUrl: RESOURCE_URL,
							uid: UID,
							deleted: true,
						},
						pairedItem: { item: 0 },
					},
				],
			]);

			const requests = liveTransport.request.mock.calls.map(
				([request]) => request as CalDavTransportRequest,
			);
			expect(requests.map(({ method }) => method)).toEqual([
				identifierMode === 'resourceUrl' ? CalDavMethod.GET : CalDavMethod.REPORT,
				CalDavMethod.DELETE,
			]);
			expect(requests[1]).toEqual({
				method: CalDavMethod.DELETE,
				url: RESOURCE_URL,
				headers: { 'If-Match': callerEtag },
			});
		},
	);

	it.each([
		['resourceUrl', undefined],
		['resourceUrl', ''],
		['uid', undefined],
		['uid', ''],
	] as const)(
		'fails %s resolution with UI ETag %s as missing before DELETE',
		async (identifierMode, uiEtag) => {
			const liveTransport = transport(identifierMode);
			mocks.createN8nCalDavTransport.mockResolvedValue(liveTransport);

			const error = await captureError(context(parameters(identifierMode, uiEtag)));

			expect(error).toBeInstanceOf(NodeApiError);
			expect(error.message).toBe(
				'The calendar event does not provide an ETag required for a safe mutation.',
			);
			expect((error as NodeApiError).context.itemIndex).toBe(0);
			expect(liveTransport.request).toHaveBeenCalledTimes(1);
			expect(liveTransport.request.mock.calls[0][0].method).toBe(
				identifierMode === 'resourceUrl' ? CalDavMethod.GET : CalDavMethod.REPORT,
			);
			expect(
				liveTransport.request.mock.calls.some(
					([request]) => request.method === CalDavMethod.DELETE,
				),
			).toBe(false);
		},
	);
});
