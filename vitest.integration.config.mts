import { defineConfig, mergeConfig } from 'vitest/config';

import sharedConfig from './vitest.shared.config.mts';

export default mergeConfig(
	sharedConfig,
	defineConfig({
		test: {
			include: ['test/integration/**/*.integration.test.ts'],
			exclude: ['test/unit/**', 'test/integration/fixtures/**'],
		},
	}),
);
