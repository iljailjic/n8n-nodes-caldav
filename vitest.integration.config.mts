import { defineConfig, mergeConfig } from 'vitest/config';

import sharedConfig from './vitest.shared.config.mts';
import { issue53ExecutionReporter } from './test/support/issue-53-execution-reporter';

const LIFECYCLE_HOOK_TIMEOUT_MS = 7 * 60_000;
const INTEGRATION_TEST_TIMEOUT_MS = 20 * 60_000;

export default mergeConfig(
	sharedConfig,
	defineConfig({
		test: {
			reporters: ['default', issue53ExecutionReporter('integration')],
			include: ['test/integration/**/*.integration.test.ts'],
			exclude: ['test/unit/**', 'test/integration/fixtures/**'],
			hookTimeout: LIFECYCLE_HOOK_TIMEOUT_MS,
			testTimeout: INTEGRATION_TEST_TIMEOUT_MS,
		},
	}),
);
