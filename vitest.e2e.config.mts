import { defineConfig, mergeConfig } from 'vitest/config';

import sharedConfig from './vitest.shared.config.mts';

export default mergeConfig(
	sharedConfig,
	defineConfig({
		test: {
			testTimeout: 180_000,
			include: ['test/e2e/**/*.e2e.test.ts'],
			exclude: ['test/unit/**', 'test/integration/**', 'test/e2e/tmp-icloud-cleanup.e2e.test.ts'],
		},
	}),
);
