import contractManifest from '../unit/fixtures/issue-53-contract-manifest.json';

type TestScope = 'unit' | 'integration';

interface CompletedTestCase {
	readonly name: string;
	result(): { readonly state: string };
}

const CONTRACT_MARKER = /^\[issue-53:([A-Z0-9-]+(?:,[A-Z0-9-]+)*)\] /;

function contractIds(name: unknown): readonly string[] | undefined {
	if (typeof name !== 'string') return undefined;
	const match = CONTRACT_MARKER.exec(name);
	return match?.[1].split(',');
}

/**
 * Verifies collected-and-executed Issue #53 case IDs at Vitest run completion.
 * Unit and integration discovery are deliberately separate, so each run proves
 * its manifest-owned subset; their manifest union remains exactly 73 IDs.
 */
export function issue53ExecutionReporter(scope: TestScope) {
	const states = new Map<string, string[]>();

	return {
		onTestCaseResult(testCase: CompletedTestCase): void {
			for (const id of contractIds(testCase.name) ?? []) {
				const previous = states.get(id) ?? [];
				states.set(id, [...previous, testCase.result().state]);
			}
		},

		onTestRunEnd(): void {
			const expected = contractManifest.cases
				.filter(({ source }) => source.startsWith(`test/${scope}/`))
				.map(({ id }) => id)
				.sort();
			const unknown = [...states.keys()].filter((id) => !expected.includes(id)).sort();
			const missing = expected.filter((id) => !states.has(id));
			const duplicates = [...states.entries()]
				.filter(([, executions]) => executions.length !== 1)
				.map(([id]) => id)
				.sort();
			const nonPassing = [...states.entries()]
				.filter(([, executions]) => executions.some((state) => state !== 'passed'))
				.map(([id, executions]) => `${id}=${executions.join(',')}`)
				.sort();

			if (unknown.length || missing.length || duplicates.length || nonPassing.length) {
				throw new Error(
					`Issue #53 ${scope} runtime execution proof failed: ` +
						`unknown=[${unknown.join(',')}], missing=[${missing.join(',')}], ` +
						`duplicates=[${duplicates.join(',')}], non-passing=[${nonPassing.join(',')}].`,
				);
			}
		},
	};
}
