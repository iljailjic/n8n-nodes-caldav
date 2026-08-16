import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	randomUUID: vi.fn(),
}));

vi.mock('node:crypto', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:crypto')>()),
	randomUUID: mocks.randomUUID,
}));

import { resolveCalendarEventUid } from '../../nodes/CalDav/events/uid';
import {
	CalDavICalendarSerializeError,
	CalDavICalendarSerializeErrorCode,
} from '../../nodes/CalDav/icalendar/serializer';

const CANONICAL_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INVALID_CONTROL_CODE_POINTS = [
	...Array.from({ length: 9 }, (_value, codePoint) => codePoint),
	...Array.from({ length: 21 }, (_value, index) => index + 0x0b),
	0x7f,
].map((codePoint) => ({
	label: `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`,
	value: `private${String.fromCodePoint(codePoint)}uid`,
}));

async function captureError(action: () => unknown): Promise<unknown> {
	try {
		await action();
	} catch (error) {
		return error;
	}
	throw new Error('Expected UID resolution to fail.');
}

beforeEach(() => {
	mocks.randomUUID.mockReset().mockReturnValue('8d66a6f8-24fd-4dca-8b4f-a84ddb223c8b');
});

describe('calendar-event UID service', () => {
	it('delegates omitted production values exactly once to node:crypto randomUUID', () => {
		const resolved = resolveCalendarEventUid(undefined);

		expect(resolved).toBe('8d66a6f8-24fd-4dca-8b4f-a84ddb223c8b');
		expect(resolved).toMatch(CANONICAL_UUID_V4);
		expect(mocks.randomUUID).toHaveBeenCalledTimes(1);
		expect(mocks.randomUUID).toHaveBeenCalledWith();
	});

	it('accepts an injectable deterministic generator for 10,000 distinct canonical UUIDv4 values', () => {
		let index = 0;
		const generator = vi.fn(() => {
			const suffix = index.toString(16).padStart(12, '0');
			index += 1;
			return `00000000-0000-4000-8000-${suffix}`;
		});
		const values = Array.from({ length: 10_000 }, () =>
			resolveCalendarEventUid(undefined, generator),
		);

		expect(generator).toHaveBeenCalledTimes(10_000);
		expect(values).toHaveLength(10_000);
		expect(values.every((value) => CANONICAL_UUID_V4.test(value))).toBe(true);
		expect(new Set(values).size).toBe(10_000);
		expect(mocks.randomUUID).not.toHaveBeenCalled();
	});

	it('preserves a valid supplied opaque iCalendar TEXT value byte-for-byte without generation', () => {
		const supplied = '  opaque,;\\\n\tŽ🚀/UID  ';
		const generator = vi.fn(() => '00000000-0000-4000-8000-000000000000');

		expect(resolveCalendarEventUid(supplied, generator)).toBe(supplied);
		expect(generator).not.toHaveBeenCalled();
		expect(mocks.randomUUID).not.toHaveBeenCalled();
	});

	it.each([
		['non-string', 12, CalDavICalendarSerializeErrorCode.INVALID_INPUT],
		['explicit empty string', '', CalDavICalendarSerializeErrorCode.MISSING_REQUIRED_FIELD],
		['unpaired high surrogate', 'private\ud800uid', CalDavICalendarSerializeErrorCode.INVALID_TEXT],
		['unpaired low surrogate', 'private\udc00uid', CalDavICalendarSerializeErrorCode.INVALID_TEXT],
	] as const)(
		'rejects %s with the established serializer error and zero generation',
		async (_label, supplied, code) => {
			const generator = vi.fn(() => '00000000-0000-4000-8000-000000000000');
			const error = await captureError(() => resolveCalendarEventUid(supplied as never, generator));

			expect(error).toBeInstanceOf(CalDavICalendarSerializeError);
			expect(error).toMatchObject({ code, field: 'uid' });
			expect(generator).not.toHaveBeenCalled();
			expect(mocks.randomUUID).not.toHaveBeenCalled();
		},
	);

	it.each(INVALID_CONTROL_CODE_POINTS)(
		'rejects control character $label as INVALID_TEXT without generation',
		async ({ value }) => {
			const generator = vi.fn(() => '00000000-0000-4000-8000-000000000000');
			const error = await captureError(() => resolveCalendarEventUid(value, generator));

			expect(error).toBeInstanceOf(CalDavICalendarSerializeError);
			expect(error).toMatchObject({
				code: CalDavICalendarSerializeErrorCode.INVALID_TEXT,
				field: 'uid',
			});
			expect(generator).not.toHaveBeenCalled();
			expect(mocks.randomUUID).not.toHaveBeenCalled();
		},
	);
});
