import { defineConfig, mergeConfig } from 'vitest/config';

import sharedConfig from './vitest.shared.config.mts';

export default mergeConfig(
	sharedConfig,
	defineConfig({
		test: {
			include: ['test/integration/fixtures/deliberate-failure.integration-fixture.ts'],
			exclude: ['test/unit/**', 'test/integration/**/*.integration.test.ts'],
		},
	}),
);
