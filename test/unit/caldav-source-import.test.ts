import type { IExecuteFunctions } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';

vi.mock('n8n-workflow', () => ({
	NodeConnectionTypes: { Main: 'main' },
}));

import { CalDav } from '../../nodes/CalDav/CalDav.node';

describe('CalDav source import', () => {
	it('exports the CalDav node class', () => {
		expect(CalDav).toBeTypeOf('function');
	});

	it('preserves passthrough execution without reading credentials', async () => {
		const node = new CalDav();
		const input = [{ json: { calendarId: 'calendar-1' } }];
		const executionContext = {
			getInputData: vi.fn().mockReturnValue(input),
			getCredentials: vi.fn(),
		} as unknown as IExecuteFunctions;

		await expect(node.execute.call(executionContext)).resolves.toEqual([input]);
		expect(executionContext.getCredentials).not.toHaveBeenCalled();
	});
});
