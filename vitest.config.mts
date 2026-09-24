import { defineConfig, mergeConfig } from 'vitest/config';

import sharedConfig from './vitest.shared.config.mts';
import { issue53ExecutionReporter } from './test/support/issue-53-execution-reporter';

export default mergeConfig(
	sharedConfig,
	defineConfig({
		test: {
			reporters: ['default', issue53ExecutionReporter('unit')],
			include: ['test/unit/**/*.test.ts'],
			exclude: ['test/integration/**', 'test/e2e/**', '.codex-runtime/**'],
		},
	}),
);
