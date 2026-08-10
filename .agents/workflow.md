# Workflow

## Scope and authority

When `github-feature-orchestrator` is invoked for an issue or milestone, run
the complete implementation, review, validation, pull-request, and CI loop
autonomously until the mandatory human review and merge gate.

Do not ask for confirmation of routine plans, implementation choices, tests,
branch operations, commits, pushes, draft pull-request operations, review
fixes, or CI fixes. Ask the user only when a material business decision cannot
be derived from the issue, accepted architecture, repository documentation, or
authoritative external documentation without inventing behavior.

## Git ownership and branch guard

- Only the orchestrator may create or switch branches, stage files, commit,
  merge, rebase, reset, stash, clean, push, or mutate GitHub state.
- Contract architects and reviewers are read-only.
- Implementers and CI fixers may edit only the current issue working tree and
  must never perform Git or GitHub mutations.
- Before starting any write-enabled subagent, and again before every commit or
  push, the orchestrator must verify:
  - the current branch equals the Delivery Context head branch;
  - the current branch is not the remote default branch;
  - the head branch follows the repository naming convention;
  - once a pull request exists, its head is the current branch and its base is
    `main`.
- A write-enabled subagent must refuse to edit when the Delivery Context does
  not contain `branch_guard: passed` for the current head branch.
- Never use a commit to `main` as a fallback when branch preparation or push
  fails.

## Implementation process

1. Gather requirements from the issue, its comments, linked issues and pull
   requests, milestone context, explicit dependencies, product documentation,
   existing public interfaces, and authoritative API documentation.
2. Have `github_contract_architect` define a versioned public contract and
   externally observable acceptance scenarios. Every clause and scenario must
   cite its requirement or architectural source.
3. Record the accepted contract revision in the GitHub issue. Do not request
   approval unless repository instructions explicitly require design approval.
4. Decide the node style:
   - Prefer declarative style for straightforward HTTP or REST request and
     response mappings.
   - Use programmatic style for dependent API calls, complex control flow,
     aggregation, or transformations that cannot be expressed declaratively.
   - Record why declarative style is insufficient when programmatic style is
     selected.
5. Plan implementation and tests against the accepted contract before editing.
   Proceed without asking the user to confirm the plan.
6. Write tests exclusively from requirements, the accepted contract, and
   externally observable behavior. Never derive test expectations from the
   implementation merely to make it pass.
7. When practical, create contract-derived tests before production code. The
   orchestrator may use that first meaningful test commit to push the issue
   branch and open the draft pull request before production implementation.
8. Implement the complete issue scope, including node files, credential files,
   helpers, tests, documentation, `package.json`, and `CHANGELOG.md` where
   applicable.
9. Inspect the actual diff and remove unrelated changes from the issue scope
   without discarding pre-existing user work.
10. Run all relevant local formatting, linting, type checks, tests, builds, and
    package checks. Fix failures and rerun the complete relevant validation.
11. Have `github_task_reviewer` independently review the diff against the
    issue, architecture, accepted contract revision, compatibility, and test
    oracle.
12. Send actionable findings back to `github_task_implementer`, fix them, rerun
    validation, and repeat independent review until no actionable finding
    remains.
13. Commit verified changes, push only the issue branch, update the draft pull
    request, and poll required GitHub Actions.
14. Send branch-caused CI failures to `github_ci_fixer`, then rerun local
    validation and independent review before committing and pushing each fix.
15. When local validation, independent review, and required Actions are green,
    mark the pull request ready for human review and stop at the merge gate.

## Repository-local runtime

All writable runtime state must stay inside the repository:

```bash
mkdir -p \
  .codex-runtime/tmp \
  .codex-runtime/npm-cache \
  .codex-runtime/n8n-node-cli
```

Prefix every npm, npx, or npm-exec invocation with:

```bash
TMPDIR="$PWD/.codex-runtime/tmp" \
npm_config_cache="$PWD/.codex-runtime/npm-cache"
```

Examples:

```bash
TMPDIR="$PWD/.codex-runtime/tmp" \
npm_config_cache="$PWD/.codex-runtime/npm-cache" \
npm ci

TMPDIR="$PWD/.codex-runtime/tmp" \
npm_config_cache="$PWD/.codex-runtime/npm-cache" \
npm run lint

TMPDIR="$PWD/.codex-runtime/tmp" \
npm_config_cache="$PWD/.codex-runtime/npm-cache" \
npm test --if-present
```

Run development mode only with a repository-local user folder:

```bash
TMPDIR="$PWD/.codex-runtime/tmp" \
npm_config_cache="$PWD/.codex-runtime/npm-cache" \
npm exec -- n8n-node dev \
  --custom-user-folder "$PWD/.codex-runtime/n8n-node-cli"
```

Never delete `.codex-runtime/` or its contents. Never write tool state to the
home directory or `/tmp`.

## Quality requirements

- Use the `n8n-node` CLI whenever practical.
- Resolve lint and type-check errors and warnings unless a documented external
  blocker makes resolution impossible.
- Use precise types wherever possible.
- Verify credential security: sensitive values use password presentation,
  secrets are never logged, and secrets are never hardcoded.
- Verify UX against the applicable n8n UX guidance.
- Automated local validation and GitHub Actions are mandatory. Manual n8n UI
  verification may be listed as an optional human-review step, but it must not
  interrupt autonomous delivery unless repository instructions explicitly make
  it a required gate.
- Do not run `n8n-node release` or `npm run release` during issue delivery.

## CLI reference

- `n8n-node build` compiles and prepares the node package.
- `n8n-node lint` lints the node; use `--fix` only for relevant, reviewable
  fixes.
- `n8n-node cloud-support` reports or manages Cloud eligibility. Do not change
  Cloud-support mode unless the issue explicitly requires it.
- `n8n-node release` performs release and publication operations and is outside
  the autonomous issue-delivery authority.