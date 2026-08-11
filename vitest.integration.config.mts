import { defineConfig, mergeConfig } from 'vitest/config';

import sharedConfig from './vitest.shared.config.mts';

const LIFECYCLE_HOOK_TIMEOUT_MS = 7 * 60_000;
const INTEGRATION_TEST_TIMEOUT_MS = 20 * 60_000;

export default mergeConfig(
	sharedConfig,
	defineConfig({
		test: {
			include: ['test/integration/**/*.integration.test.ts'],
			exclude: ['test/unit/**', 'test/integration/fixtures/**'],
			hookTimeout: LIFECYCLE_HOOK_TIMEOUT_MS,
			testTimeout: INTEGRATION_TEST_TIMEOUT_MS,
		},
	}),
);
