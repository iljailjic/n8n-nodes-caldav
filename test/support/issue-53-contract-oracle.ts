import { it } from 'vitest';

type Issue53Oracle = () => void | Promise<void>;

const collectionRegistrations: string[] = [];

/** Returns the contract IDs whose wrappers registered an active Vitest test during collection. */
export function issue53CollectionRegistrations(): readonly string[] {
	return collectionRegistrations;
}

/**
 * Registers one executable Vitest oracle for the accepted issue #53 contract IDs.
 * The manifest test statically verifies these literal IDs and this callback shape.
 */
export function issue53It(
	ids: readonly string[],
	name: string,
	oracle: Issue53Oracle,
	timeout?: number,
): void {
	if (ids.length === 0 || new Set(ids).size !== ids.length) {
		throw new Error('An issue #53 oracle must declare one or more unique contract IDs.');
	}

	it(`[issue-53:${ids.join(',')}] ${name}`, oracle, timeout);
	collectionRegistrations.push(...ids);
}

/** Registers parameterized executable Vitest oracles with the same contract metadata. */
export function issue53ItEach<T>(
	ids: readonly string[],
	cases: readonly [T, ...T[]],
	name: string,
	oracle: (testCase: T) => void | Promise<void>,
): void {
	if (ids.length === 0 || new Set(ids).size !== ids.length || cases.length === 0) {
		throw new Error('An issue #53 oracle must declare unique IDs and one or more cases.');
	}

	it(`[issue-53:${ids.join(',')}] ${name}`, async () => {
		for (const testCase of cases) await oracle(testCase);
	});
	collectionRegistrations.push(...ids);
}
