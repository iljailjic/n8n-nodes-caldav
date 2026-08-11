import { expect, it } from 'vitest';

it('fails deliberately so the outer lifecycle oracle can verify mandatory cleanup', () => {
	expect('synthetic deliberate failure').toBe('synthetic success');
});
