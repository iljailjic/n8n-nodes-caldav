// Repository reads are required for deterministic workflow contract tests.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { readFile } from 'node:fs/promises';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { resolve } from 'node:path';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { cwd } from 'node:process';

import { describe, expect, it } from 'vitest';

const workflowPath = resolve(cwd(), '.github/workflows/icloud-e2e.yml');
const packagePath = resolve(cwd(), 'package.json');
const gitignorePath = resolve(cwd(), '.gitignore');
const envExamplePath = resolve(cwd(), '.env.icloud-e2e.example');
const e2eConfigPath = resolve(cwd(), 'vitest.e2e.config.mts');

describe('iCloud E2E workflow contract', () => {
	it('forces the documented dry run out of live mode before the subsequent opt-in run', async () => {
		const packageManifest = JSON.parse(await readFile(packagePath, 'utf8')) as {
			scripts: Record<string, string>;
		};
		const dryRun = packageManifest.scripts['test:e2e:icloud:dry-run'];
		const compositeRun = packageManifest.scripts['test:e2e:icloud'];

		expect(dryRun).toBe(
			'CALDAV_ICLOUD_E2E_OPT_IN=0 node --env-file-if-exists=.env.icloud-e2e ./node_modules/vitest/vitest.mjs run --config vitest.e2e.config.mts',
		);
		expect(compositeRun).toBe(
			'CALDAV_ICLOUD_E2E_OPT_IN=0 node --env-file-if-exists=.env.icloud-e2e ./node_modules/vitest/vitest.mjs run --config vitest.e2e.config.mts && CALDAV_ICLOUD_E2E_OPT_IN=1 node --env-file-if-exists=.env.icloud-e2e ./node_modules/vitest/vitest.mjs run --config vitest.e2e.config.mts',
		);
		expect(compositeRun).not.toContain('npm run test:e2e:icloud:dry-run');
	});

	it('loads an ignored local env file while committing only placeholder values', async () => {
		const [gitignore, example] = await Promise.all([
			readFile(gitignorePath, 'utf8'),
			readFile(envExamplePath, 'utf8'),
		]);
		expect(gitignore).toMatch(/^\.env\.\*$/m);
		expect(gitignore).toMatch(/^!\.env\.\*\.example$/m);
		expect(example).toContain('CALDAV_ICLOUD_E2E_SERVER_URL=https://caldav.icloud.com/');
		expect(example).toContain('CALDAV_ICLOUD_E2E_USERNAME=dedicated-apple-account@example.com');
		expect(example).toContain(
			'CALDAV_ICLOUD_E2E_APP_PASSWORD=replace-with-apple-app-specific-password',
		);
		expect(example).toContain('CALDAV_ICLOUD_E2E_CALENDAR_DISPLAY_NAME=CalDAV E2E');
		expect(example).not.toContain('CALDAV_ICLOUD_E2E_OPT_IN=1');
	});

	it('keeps the local cleanup diagnostic outside the normal E2E suite', async () => {
		const e2eConfig = await readFile(e2eConfigPath, 'utf8');
		expect(e2eConfig).toContain("'test/e2e/tmp-icloud-cleanup.e2e.test.ts'");
	});

	it('keeps #56 event-query evidence and raw ICS confined to the opt-in test process', async () => {
		const [workflow, e2eTest] = await Promise.all([
			readFile(workflowPath, 'utf8'),
			readFile(resolve(cwd(), 'test/e2e/icloud-e2e-harness.e2e.test.ts'), 'utf8'),
		]);
		expect(workflow).not.toMatch(/actions\/(upload|download)-artifact@/);
		expect(e2eTest).toContain("schemaVersion: 'icloud-e2e-evidence/v3'");
		expect(e2eTest).toContain('assertPrivateRawIcs');
		expect(e2eTest).toContain('run-owned-seed');
	});

	it('is manually dispatched, explicitly confirmed, main-only, and cannot persist checkout credentials', async () => {
		const workflow = await readFile(workflowPath, 'utf8');
		expect(workflow).toMatch(/^on:\n\s+workflow_dispatch:/m);
		expect(workflow).not.toMatch(/^\s*(push|pull_request|schedule):/m);
		expect(workflow).toMatch(/required:\s*true/);
		expect(workflow).toMatch(/type:\s*boolean/);
		expect(workflow).toMatch(/github\.ref\s*==\s*'refs\/heads\/main'/);
		expect(workflow).toMatch(/contents:\s*read/);
		expect(workflow).toMatch(/persist-credentials:\s*false/);
		expect(workflow).toMatch(
			/CALDAV_ICLOUD_E2E_SERVER_URL:\s*\$\{\{ secrets\.CALDAV_ICLOUD_E2E_SERVER_URL \}\}/,
		);
		expect(workflow).toMatch(
			/CALDAV_ICLOUD_E2E_CALENDAR_DISPLAY_NAME:\s*\$\{\{ secrets\.CALDAV_ICLOUD_E2E_CALENDAR_DISPLAY_NAME \}\}/,
		);
		expect(workflow).not.toContain('vars.CALDAV_ICLOUD_E2E_CALENDAR_DISPLAY_NAME');
	});

	it('uses immutable actions, no artifacts, and isolates a calendar without making CI required', async () => {
		const workflow = await readFile(workflowPath, 'utf8');
		const actions = [...workflow.matchAll(/^\s*uses:\s*[^\s@]+@([^\s#]+)(?:\s|#|$)/gm)];
		expect(actions).not.toHaveLength(0);
		for (const action of actions) {
			expect(action[1]).toMatch(/^[0-9a-f]{40}$/i);
		}
		expect(workflow).not.toMatch(/actions\/(upload|download)-artifact@/);
		expect(workflow).toMatch(
			/concurrency:[\s\S]{0,240}group:[\s\S]{0,240}(hashFiles|sha256|hash)/i,
		);
		// A workflow_dispatch-only workflow cannot become a PR-required check.
		expect(workflow).not.toMatch(/^\s*(push|pull_request):/m);
	});
});
