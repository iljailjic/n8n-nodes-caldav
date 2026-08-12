import { defineConfig } from 'vitest/config';

export default defineConfig({
	cacheDir: '.codex-runtime/vite-cache',
	test: {
		environment: 'node',
		globals: false,
		passWithNoTests: false,
	},
});
