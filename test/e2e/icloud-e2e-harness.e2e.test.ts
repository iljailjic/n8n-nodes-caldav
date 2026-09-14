// The live adapter intentionally adapts iCloud HTTP streams to the production transport.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { Readable } from 'node:stream';
/* eslint-disable @n8n/community-nodes/no-restricted-globals, @n8n/community-nodes/require-node-api-error -- The opt-in test suite reads only its own environment and reports stable public-safe codes. */

import { describe, expect, it } from 'vitest';

import { CalDav } from '../../nodes/CalDav/CalDav.node';
import { discoverCalendarCollections } from '../../nodes/CalDav/discovery/calendarCollections';
import { discoverCalendarHome } from '../../nodes/CalDav/discovery/calendarHome';
import {
	CalDavCapabilityValidationError,
	validateCalDavCapability,
} from '../../nodes/CalDav/discovery/capabilities';
import {
	discoverCurrentUserPrincipal,
	CurrentUserPrincipalDiscoveryKind,
} from '../../nodes/CalDav/discovery/currentUserPrincipal';
import { defaultCalDavProviderRegistry } from '../../nodes/CalDav/providers/registry';
import {
	CalDavMethod,
	createCalDavTransport,
	type CalDavRequestHelperAdapter,
	type N8nCalDavRequestOptions,
} from '../../nodes/CalDav/transport/http';
import { validateAbsoluteHttpUrl } from '../../nodes/CalDav/transport/url';

import {
	assertE2e,
	canonicalizeIcloudE2eUrl,
	IcloudE2eErrorCode,
	IcloudE2eHarnessError,
	readIcloudE2eInput,
	selectExactCalendar,
	serializeEvidence,
} from './support/icloud-e2e-harness';

const CONTRACT_REVISION = 'issue-55-contract-r1' as const;
const READ_ONLY_METHODS = new Set<CalDavMethod>([CalDavMethod.OPTIONS, CalDavMethod.PROPFIND]);

function liveInputOrUndefined(): ReturnType<typeof readIcloudE2eInput> | undefined {
	return process.env.CALDAV_ICLOUD_E2E_OPT_IN === '1' ? readIcloudE2eInput(process.env) : undefined;
}

function liveRequestAdapter(
	input: ReturnType<typeof readIcloudE2eInput>,
	observedMethods: CalDavMethod[],
): CalDavRequestHelperAdapter {
	return {
		async request(options: N8nCalDavRequestOptions) {
			assertE2e(READ_ONLY_METHODS.has(options.method));
			observedMethods.push(options.method);
			const response = await fetch(options.url, {
				method: options.method,
				headers: {
					...options.headers,
					Authorization: `Basic ${Buffer.from(`${input.username}:${input.appPassword}`, 'utf8').toString('base64')}`,
				},
				...(options.body === undefined ? {} : { body: options.body }),
				redirect: 'manual',
				signal: AbortSignal.timeout(30_000),
			});
			const headers: Record<string, string> = {};
			response.headers.forEach((value, name) => {
				headers[name] = value;
			});
			return {
				statusCode: response.status,
				headers,
				body: Readable.from(Buffer.from(await response.arrayBuffer())),
			};
		},
	};
}

describe('iCloud E2E discovery contract (fictional synthetic regressions)', () => {
	it('requires opt-in HTTPS input and canonicalizes identity without retaining secrets', () => {
		expect(() => readIcloudE2eInput({})).toThrow(IcloudE2eHarnessError);
		expect(() =>
			readIcloudE2eInput({
				CALDAV_ICLOUD_E2E_OPT_IN: '1',
				CALDAV_ICLOUD_E2E_SERVER_URL: 'https://user:secret@calendar.example.test/',
				CALDAV_ICLOUD_E2E_USERNAME: 'fictional-user',
				CALDAV_ICLOUD_E2E_APP_PASSWORD: 'fictional-password',
				CALDAV_ICLOUD_E2E_CALENDAR_DISPLAY_NAME: 'Fictional Calendar',
			}),
		).toThrow(IcloudE2eHarnessError);
		expect(canonicalizeIcloudE2eUrl('https://CALENDAR.example.test:443/discovery/../dav/')).toBe(
			'https://calendar.example.test/dav/',
		);
	});

	it('selects exactly one fictional calendar by canonical URL identity', () => {
		expect(
			selectExactCalendar(
				[
					{
						displayName: 'Fictional Calendar',
						url: 'https://CALENDAR.example.test:443/dav/calendars/',
					},
				],
				'Fictional Calendar',
			),
		).toEqual({
			displayName: 'Fictional Calendar',
			url: 'https://calendar.example.test/dav/calendars/',
		});
		let notFound: unknown;
		try {
			selectExactCalendar([], 'Fictional Calendar');
		} catch (error) {
			notFound = error;
		}
		expect(notFound).toMatchObject({ code: IcloudE2eErrorCode.CALENDAR_NOT_FOUND });
		let ambiguous: unknown;
		try {
			selectExactCalendar(
				[
					{ displayName: 'Fictional Calendar', url: 'https://calendar.example.test/a/' },
					{ displayName: 'Fictional Calendar', url: 'https://calendar.example.test/b/' },
				],
				'Fictional Calendar',
			);
		} catch (error) {
			ambiguous = error;
		}
		expect(ambiguous).toMatchObject({ code: IcloudE2eErrorCode.CALENDAR_AMBIGUOUS });
	});

	it('emits only privacy-safe, discovery-only evidence', () => {
		const evidence = serializeEvidence({
			schemaVersion: 'icloud-e2e-evidence/v2',
			mode: 'fake',
			sourceRevision: CONTRACT_REVISION,
			outcome: 'passed',
			scenarios: [
				'capability',
				'redirect-principal-home',
				'calendar-list',
				'resource-locator-get-contract',
			],
			requestMethods: ['OPTIONS', 'PROPFIND'],
			errorCodes: [],
		});
		expect(evidence).toMatch(/^ICLOUD_E2E_EVIDENCE /);
		expect(evidence).not.toContain('fictional-password');
		expect(evidence).not.toContain('calendar.example.test');
		expect(evidence).not.toContain('GET');
		expect(evidence).not.toContain('PUT');
		expect(evidence).not.toContain('DELETE');
	});

	it('keeps the established event Get resource-locator contract synthetic and out of live I/O', () => {
		const properties = new CalDav().description.properties;
		const calendar = properties.find((property) => property.name === 'calendar');
		const eventGet = properties.find(
			(property) =>
				property.name === 'operation' && property.displayOptions?.show?.resource?.includes('event'),
		);
		expect(calendar).toMatchObject({
			type: 'resourceLocator',
			default: { mode: 'url', value: '' },
		});
		expect(eventGet?.options).toContainEqual(
			expect.objectContaining({ name: 'Get', value: 'get' }),
		);
		expect(READ_ONLY_METHODS.has(CalDavMethod.GET)).toBe(false);
	});
});

const liveInput = liveInputOrUndefined();

describe.runIf(liveInput !== undefined)('iCloud E2E live read-only discovery', () => {
	it('validates capability, redirect-safe principal/home discovery, and the selected calendar list', async () => {
		const input = liveInput!;
		const observedMethods: CalDavMethod[] = [];
		const transport = createCalDavTransport(
			input.serverUrl,
			liveRequestAdapter(input, observedMethods),
		);
		const scenarios: string[] = [];
		const errorCodes: IcloudE2eErrorCode[] = [];
		let outcome: 'passed' | 'failed' = 'failed';

		try {
			await validateCalDavCapability(transport);
			scenarios.push('capability');

			const principal = await discoverCurrentUserPrincipal(transport);
			assertE2e(principal.kind === CurrentUserPrincipalDiscoveryKind.AUTHENTICATED);
			assertE2e(canonicalizeIcloudE2eUrl(principal.principalUrl) === principal.principalUrl);
			const home = await discoverCalendarHome(transport, principal.principalUrl);
			assertE2e(canonicalizeIcloudE2eUrl(home.calendarHomeUrl) === home.calendarHomeUrl);
			scenarios.push('redirect-principal-home');

			const provider = defaultCalDavProviderRegistry.select(
				validateAbsoluteHttpUrl(transport.serverUrl),
			);
			const calendars = await discoverCalendarCollections(
				transport,
				home.calendarHomeUrl,
				provider,
			);
			const selected = selectExactCalendar(
				calendars.map((calendar) => ({
					displayName: calendar.displayName ?? '',
					url: calendar.url,
				})),
				input.calendarDisplayName,
			);
			assertE2e(canonicalizeIcloudE2eUrl(selected.url) === selected.url);
			scenarios.push('calendar-list');
			scenarios.push('resource-locator-get-contract');
			outcome = 'passed';
		} catch (error) {
			errorCodes.push(
				error instanceof IcloudE2eHarnessError
					? error.code
					: error instanceof CalDavCapabilityValidationError
						? IcloudE2eErrorCode.CAPABILITY_FAILED
						: IcloudE2eErrorCode.DISCOVERY_FAILED,
			);
			throw error;
		} finally {
			assertE2e(observedMethods.every((method) => READ_ONLY_METHODS.has(method)));
			// eslint-disable-next-line no-console -- The manual workflow log receives only aggregate, privacy-safe evidence.
			console.info(
				serializeEvidence({
					schemaVersion: 'icloud-e2e-evidence/v2',
					mode: 'live',
					sourceRevision: CONTRACT_REVISION,
					outcome,
					scenarios,
					requestMethods: [...new Set(observedMethods)],
					errorCodes,
				}),
			);
		}
	});
});
