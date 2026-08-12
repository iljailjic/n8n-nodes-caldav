import { describe, expect, it, vi } from 'vitest';

vi.mock('n8n-workflow', () => ({
	NodeConnectionTypes: { Main: 'main' },
}));

import { CalDav } from '../../nodes/CalDav/CalDav.node';

describe('CalDav source import', () => {
	it('exports the CalDav node class', () => {
		expect(CalDav).toBeTypeOf('function');
	});

	it('preserves the accepted node identity and single main input/output', () => {
		const node = new CalDav();
		expect(node.description).toMatchObject({
			name: 'calDav',
			version: 1,
			inputs: ['main'],
			outputs: ['main'],
		});
	});
});
