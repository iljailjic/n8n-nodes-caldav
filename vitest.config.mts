import { defineConfig, mergeConfig } from 'vitest/config';

import sharedConfig from './vitest.shared.config.mts';

export default mergeConfig(
	sharedConfig,
	defineConfig({
		test: {
			include: ['test/unit/**/*.test.ts'],
			exclude: ['test/integration/**', 'test/e2e/**'],
		},
	}),
);
