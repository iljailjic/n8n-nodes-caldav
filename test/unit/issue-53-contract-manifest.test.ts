// This test owns the accepted #53 matrix inventory; it does not infer requirements from code.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { readFile } from 'node:fs/promises';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { join } from 'node:path';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { cwd } from 'node:process';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { issue53CollectionRegistrations, issue53ItEach } from '../support/issue-53-contract-oracle';
import contractManifest from './fixtures/issue-53-contract-manifest.json';

const CONTRACT_REVISION = 'issue-53-contract-r1';

const REQUIRED_IDS = [
	'MATRIX-001',
	'MATRIX-002',
	'HARNESS-001',
	'HARNESS-002',
	'HARNESS-003',
	'HARNESS-004',
	'HARNESS-005',
	'HARNESS-006',
	'HARNESS-007',
	'CONNECTION-001',
	'AUTH-401-001',
	'AUTH-403-001',
	'DISCOVERY-001',
	'DISCOVERY-002',
	'CALENDAR-GET-001',
	'CALENDAR-MANY-001',
	'CALENDAR-MANY-002',
	'EVENT-CREATE-STRUCTURED-UTC-001',
	'EVENT-CREATE-UUID-001',
	'EVENT-CREATE-ALLDAY-001',
	'EVENT-CREATE-IANA-001',
	'EVENT-CREATE-RECURRENCE-001',
	'EVENT-CREATE-ALARMS-001',
	'EVENT-CREATE-RAW-001',
	'EVENT-GET-URL-001',
	'EVENT-GET-UID-001',
	'EVENT-GET-UNSUPPORTED-001',
	'EVENT-MANY-RANGE-001',
	'EVENT-MANY-ALLDAY-001',
	'EVENT-MANY-RECURRENCE-001',
	'EVENT-UPDATE-URL-001',
	'EVENT-UPDATE-UID-001',
	'EVENT-UPDATE-METADATA-001',
	'EVENT-UPDATE-TIME-001',
	'EVENT-UPDATE-PRESERVE-001',
	'EVENT-UPDATE-RAW-001',
	'EVENT-DELETE-URL-001',
	'EVENT-DELETE-UID-001',
	'EVENT-DELETE-UNSUPPORTED-001',
	'EVENT-UPSERT-UID-001',
	'EVENT-UPSERT-OMITTED-UID-001',
	'EVENT-UPSERT-TIME-001',
	'EVENT-UPSERT-RAW-001',
	'NODE-ITEM-001',
	'UID-NOT-FOUND-001',
	'UID-AMBIGUOUS-SYNTHETIC-001',
	'UID-NO-CONFLICT-LIVE-001',
	'CREATE-COLLISION-001',
	'UPDATE-STALE-ETAG-001',
	'DELETE-STALE-ETAG-001',
	'UPSERT-STALE-RACE-001',
	'MISSING-RESOURCE-URL-001',
	'READONLY-CREATE-001',
	'READONLY-UPDATE-001',
	'READONLY-DELETE-001',
	'READONLY-UPSERT-001',
	'RESPONSE-LIMIT-001',
	'RESOURCE-LIMIT-001',
	'MALFORMED-XML-001',
	'INVALID-MULTISTATUS-001',
	'FORBIDDEN-XML-DECLARATION-001',
	'MALFORMED-ICS-001',
	'VALIDATION-URL-001',
	'VALIDATION-UID-001',
	'VALIDATION-TIME-001',
	'VALIDATION-IANA-001',
	'VALIDATION-METADATA-001',
	'VALIDATION-RECURRENCE-001',
	'VALIDATION-ALARM-001',
	'VALIDATION-RAW-001',
	'QUALITY-001',
	'QUALITY-002',
	'QUALITY-003',
] as const;

interface ContractCase {
	readonly id: string;
	readonly source: string;
	readonly scenario: string;
}

interface ContractManifest {
	readonly revision: string;
	readonly cases: readonly ContractCase[];
}

const manifest = contractManifest as ContractManifest;

interface RegisteredOracle {
	readonly id: string;
	readonly source: string;
	readonly scenario: string;
}

interface LiteralOracleMetadata {
	readonly ids: readonly string[];
	readonly scenario: string;
}

function isSkippedOrTodoSuite(call: ts.CallExpression): boolean {
	return (
		ts.isPropertyAccessExpression(call.expression) &&
		ts.isIdentifier(call.expression.expression) &&
		call.expression.expression.text === 'describe' &&
		(call.expression.name.text === 'skip' || call.expression.name.text === 'todo')
	);
}

function isActiveSuiteCallback(functionNode: ts.FunctionExpression | ts.ArrowFunction): boolean {
	const parent = functionNode.parent;
	return (
		ts.isCallExpression(parent) &&
		!isSkippedOrTodoSuite(parent) &&
		parent.arguments[1] === functionNode &&
		ts.isIdentifier(parent.expression) &&
		parent.expression.text === 'describe'
	);
}

function hasExecutableContext(call: ts.CallExpression): boolean {
	for (let node: ts.Node = call; !ts.isSourceFile(node); node = node.parent) {
		const parent = node.parent;
		if (
			ts.isIfStatement(parent) ||
			ts.isConditionalExpression(parent) ||
			ts.isSwitchStatement(parent) ||
			ts.isCaseClause(parent) ||
			ts.isDefaultClause(parent) ||
			ts.isForStatement(parent) ||
			ts.isForInStatement(parent) ||
			ts.isForOfStatement(parent) ||
			ts.isWhileStatement(parent) ||
			ts.isDoStatement(parent) ||
			ts.isTryStatement(parent) ||
			ts.isBinaryExpression(parent)
		) {
			return false;
		}
		if (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) {
			if (!isActiveSuiteCallback(parent)) return false;
		}
	}
	return true;
}

function literalOracleMetadata(call: ts.CallExpression): LiteralOracleMetadata | undefined {
	const [ids] = call.arguments;
	const isEach = ts.isIdentifier(call.expression) && call.expression.text === 'issue53ItEach';
	const name = call.arguments[isEach ? 2 : 1];
	const oracle = call.arguments[isEach ? 3 : 2];
	if (
		ids === undefined ||
		!ts.isArrayLiteralExpression(ids) ||
		name === undefined ||
		!ts.isStringLiteral(name) ||
		oracle === undefined ||
		(!ts.isArrowFunction(oracle) && !ts.isFunctionExpression(oracle))
	) {
		return undefined;
	}

	const values = ids.elements.map((element) =>
		ts.isStringLiteral(element) ? element.text : undefined,
	);
	return values.every((value): value is string => value !== undefined)
		? { ids: values, scenario: name.text }
		: undefined;
}

function importsIssue53Oracle(sourceFile: ts.SourceFile): boolean {
	return sourceFile.statements.some(
		(statement) =>
			ts.isImportDeclaration(statement) &&
			ts.isStringLiteral(statement.moduleSpecifier) &&
			statement.moduleSpecifier.text.endsWith('/support/issue-53-contract-oracle'),
	);
}

function importsVitestDescribe(sourceFile: ts.SourceFile): boolean {
	return sourceFile.statements.some(
		(statement) =>
			ts.isImportDeclaration(statement) &&
			statement.moduleSpecifier.getText(sourceFile) === "'vitest'" &&
			statement.importClause?.namedBindings !== undefined &&
			ts.isNamedImports(statement.importClause.namedBindings) &&
			statement.importClause.namedBindings.elements.some(
				(element) => element.name.text === 'describe' && element.propertyName === undefined,
			),
	);
}

function shadowsDescribe(sourceFile: ts.SourceFile): boolean {
	let shadowed = false;
	function visit(node: ts.Node): void {
		if (
			(ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isParameter(node)) &&
			node.name.getText(sourceFile) === 'describe'
		) {
			shadowed = true;
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return shadowed;
}

function isIssue53ItCall(node: ts.Node): node is ts.CallExpression {
	return (
		ts.isCallExpression(node) &&
		ts.isIdentifier(node.expression) &&
		(node.expression.text === 'issue53It' || node.expression.text === 'issue53ItEach')
	);
}

async function registeredOracles(source: string): Promise<readonly RegisteredOracle[]> {
	const sourceText = await readFile(join(cwd(), source), 'utf8');
	const sourceFile = ts.createSourceFile(source, sourceText, ts.ScriptTarget.Latest, true);
	expect(
		importsIssue53Oracle(sourceFile),
		`${source} must import the issue #53 oracle wrapper`,
	).toBe(true);
	expect(importsVitestDescribe(sourceFile), `${source} must import describe from Vitest`).toBe(
		true,
	);
	expect(shadowsDescribe(sourceFile), `${source} must not shadow describe`).toBe(false);
	const registrations: RegisteredOracle[] = [];

	function visit(node: ts.Node): void {
		if (isIssue53ItCall(node)) {
			expect(
				hasExecutableContext(node),
				`${source} must bind contract IDs in an active suite`,
			).toBe(true);
			const metadata = literalOracleMetadata(node);
			expect(metadata, `${source} must use literal IDs and an executable callback`).toBeDefined();
			for (const id of metadata?.ids ?? []) {
				registrations.push({ id, source, scenario: metadata?.scenario ?? '' });
			}
		}
		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return registrations;
}

function registrationsFromSource(source: string): readonly string[] {
	const sourceFile = ts.createSourceFile('fixture.test.ts', source, ts.ScriptTarget.Latest, true);
	const registrations: string[] = [];
	function visit(node: ts.Node): void {
		if (isIssue53ItCall(node)) {
			expect(hasExecutableContext(node), 'fixture must bind contract IDs in an active suite').toBe(
				true,
			);
			registrations.push(...(literalOracleMetadata(node)?.ids ?? []));
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return registrations;
}

describe('issue #53 accepted integration matrix manifest', () => {
	it('declares exactly the accepted contract revision and mandatory ID set once', () => {
		expect(manifest.revision).toBe(CONTRACT_REVISION);
		expect(manifest.cases.map(({ id }) => id)).toEqual([...REQUIRED_IDS]);
		expect(new Set(manifest.cases.map(({ id }) => id)).size).toBe(REQUIRED_IDS.length);
	});

	it('binds every mandatory ID exactly once to an executable literal-ID oracle', async () => {
		const declaredSources = [...new Set(manifest.cases.map(({ source }) => source))];
		for (const source of declaredSources) {
			expect(source).toMatch(/^test\/(?:unit|integration)\/.+\.test\.ts$/);
		}

		const registrations = (await Promise.all(declaredSources.map(registeredOracles)))
			.flat()
			.sort(({ id: left }, { id: right }) => left.localeCompare(right));
		const expected = manifest.cases
			.map(({ id, source, scenario }) => ({ id, source, scenario }))
			.sort(({ id: left }, { id: right }) => left.localeCompare(right));
		expect(registrations).toEqual(expected);
		expect(new Set(registrations.map(({ id }) => id)).size).toBe(REQUIRED_IDS.length);
		const collectionEvidence = [...issue53CollectionRegistrations()].sort();
		if (collectionEvidence.length > 0) {
			expect(collectionEvidence).toEqual(manifest.cases.map(({ id }) => id).sort());
		}
	});

	it('rejects inactive, skipped, todo, and arbitrary callback wrapper contexts', () => {
		for (const source of [
			"if (false) issue53It(['MATRIX-001'], 'inactive', () => {});",
			"describe.skip('skipped', () => issue53It(['MATRIX-001'], 'skipped', () => {}));",
			"describe.todo('todo', () => issue53It(['MATRIX-001'], 'todo', () => {}));",
			"queueMicrotask(() => issue53It(['MATRIX-001'], 'deferred', () => {}));",
			"false && issue53It(['MATRIX-001'], 'short circuit', () => {});",
		]) {
			expect(() => registrationsFromSource(source)).toThrow(/active suite/);
		}
		const shadowedDescribe = ts.createSourceFile(
			'fixture.test.ts',
			"const describe = () => undefined; describe('hidden', () => issue53It(['MATRIX-001'], 'hidden', () => {}));",
			ts.ScriptTarget.Latest,
			true,
		);
		expect(shadowsDescribe(shadowedDescribe)).toBe(true);
	});

	it('rejects empty parameterized case sets at type-check and wrapper-registration time', () => {
		// @ts-expect-error issue #53 parameterized oracle sets must be non-empty tuples.
		expect(() => issue53ItEach(['MATRIX-001'], [], 'empty', () => {})).toThrow('one or more cases');
	});
});
