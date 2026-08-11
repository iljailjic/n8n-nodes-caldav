import { describe, expect, it, vi } from 'vitest';

import * as capabilities from '../../nodes/CalDav/discovery/capabilities';
import {
	CalDavCapabilityValidationError,
	CalDavCapabilityValidationFailureCode,
	validateCalDavCapability,
} from '../../nodes/CalDav/discovery/capabilities';
import { CalDavMethod } from '../../nodes/CalDav/transport/http';
import type { CalDavTransport, CalDavTransportResponse } from '../../nodes/CalDav/transport/http';

function response(dav?: string | readonly string[]): CalDavTransportResponse {
	return {
		statusCode: 200,
		headers: dav === undefined ? {} : { dav },
		effectiveUrl: 'https://effective.example.test/private-path/',
		body: Buffer.from('private-body-that-must-not-be-parsed'),
	};
}

function transport(dav?: string | readonly string[]): CalDavTransport & {
	request: ReturnType<typeof vi.fn>;
} {
	return {
		serverUrl: 'https://configured.example.test/',
		request: vi.fn().mockResolvedValue(response(dav)),
	};
}

describe('CalDAV capability validation', () => {
	it('exports the exact accepted runtime surface and stable error metadata', () => {
		expect(Object.keys(capabilities).sort()).toEqual(
			[
				'CalDavCapabilityValidationError',
				'CalDavCapabilityValidationFailureCode',
				'validateCalDavCapability',
			].sort(),
		);
		expect(CalDavCapabilityValidationFailureCode).toEqual({
			NOT_CALDAV: 'CALDAV_CAPABILITY_MISSING',
		});

		const error = new CalDavCapabilityValidationError('CALDAV_CAPABILITY_MISSING');
		expect(error).toMatchObject({
			name: 'CalDavCapabilityValidationError',
			code: 'CALDAV_CAPABILITY_MISSING',
			message: 'The endpoint does not advertise CalDAV calendar-access support.',
		});
		expect(error).not.toHaveProperty('cause');
		expect(error).not.toHaveProperty('statusCode');
		expect(Object.keys(error).sort()).toEqual(['code', 'name']);
	});

	it.each([
		['calendar-access', 'scalar exact token'],
		['1, calendar-access, extended-mkcol', 'comma-separated token'],
		['\tcalendar-access \t', 'surrounding SP and HTAB'],
		[['1', 'calendar-access'], 'array header value'],
	] as const)('accepts %j as an exact calendar-access signal (%s)', async (dav) => {
		const mockTransport = transport(dav);

		await expect(validateCalDavCapability(mockTransport)).resolves.toBeUndefined();
		expect(mockTransport.request).toHaveBeenCalledTimes(1);
		expect(mockTransport.request).toHaveBeenCalledWith({ method: CalDavMethod.OPTIONS });
		expect(Object.keys(mockTransport.request.mock.calls[0][0])).toEqual(['method']);
	});

	it.each([
		[undefined, 'missing'],
		['', 'empty'],
		['1, 2', 'unrelated'],
		['xcalendar-access', 'prefix substring'],
		['calendar-access-extra', 'suffix substring'],
		['"calendar-access"', 'quoted'],
		['calendar-access;level=1', 'parameterized'],
		['\ncalendar-access\n', 'non-HTTP whitespace'],
	] as const)('rejects the %s DAV value without another request', async (dav) => {
		const mockTransport = transport(dav);

		await expect(validateCalDavCapability(mockTransport)).rejects.toMatchObject({
			name: 'CalDavCapabilityValidationError',
			code: 'CALDAV_CAPABILITY_MISSING',
		});
		expect(mockTransport.request).toHaveBeenCalledTimes(1);
	});
});
