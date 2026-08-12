import { describe, expect, it, vi } from 'vitest';

vi.mock('n8n-workflow', () => ({
	NodeConnectionTypes: { Main: 'main' },
}));

import { CalDav } from '../../nodes/CalDav/CalDav.node';

describe('CalDav source import', () => {
	it('exports the CalDav node class', () => {
		expect(CalDav).toBeTypeOf('function');
	});
});
