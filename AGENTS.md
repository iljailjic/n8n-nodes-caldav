# n8n community node

## Overview

This project contains an n8n community node. n8n is a workflow automation
platform where users build workflows from nodes. Nodes can trigger workflows,
fetch or send data, and transform data. Credentials store sensitive connection
details for services and APIs used by nodes.

Community node packages use the name `n8n-nodes-<n>` or
`@org/n8n-nodes-<n>`. Nodes submitted for use in n8n Cloud must also comply
with the applicable n8n Cloud requirements.

## Important notes

- Follow this file and its linked supporting documents over illustrative code
  examples.
- Treat all examples in these documents as incomplete patterns. Do not copy
  them verbatim or infer requirements from example-specific names or values.
- Replace example names such as `Example`, `Wordpress`, or `wordpressApi` with
  names belonging to the service being implemented.
- Implement the complete issue scope, including production code, credentials,
  tests, documentation, and package metadata where applicable.
- Derive expected behavior and tests from the issue, accepted public contract,
  architecture, and authoritative API documentation. Never rewrite tests to
  match accidental implementation behavior.

## Project structure

The main package directories are:

```text
.
├── nodes/
│   └── Example/
│       ├── Example.node.ts
│       └── ...
├── credentials/
│   └── Example.credentials.ts
├── package.json
└── ...
```

The `n8n` object in `package.json` contains paths to the transpiled node and
credential files:

```json
{
  "name": "n8n-nodes-example",
  "version": "1.0.0",
  "n8n": {
    "n8nNodesApiVersion": 1,
    "strict": true,
    "credentials": [
      "dist/credentials/Example.credentials.js"
    ],
    "nodes": [
      "dist/nodes/Example/Example.node.js"
    ]
  }
}
```

Update `n8n.nodes` and `n8n.credentials` whenever nodes or credentials are
added, removed, moved, or renamed. Remove or rename initial example files when
they are replaced by the real integration.

## Key guidelines

- Use the `n8n-node` CLI whenever practical for build, lint, and development.
- Resolve all lint and type-check errors and warnings unless a documented,
  issue-specific reason makes that impossible.
- Use precise TypeScript types wherever possible.
- Update `CHANGELOG.md` whenever the npm package version changes.
- Read `.agents/workflow.md` before planning or starting a task.

## Repository-local runtime boundary

- Treat the Git repository root as the complete writable filesystem boundary.
- Never create or modify files in `/tmp`, `$TMPDIR`, the home directory,
  sibling directories, external worktrees, or global configuration.
- Store caches and temporary build state only under the persistent
  repository-local `.codex-runtime/` directory.
- Never delete `.codex-runtime/` or its contents as cleanup. Reuse it across
  runs and never commit it.
- Run npm-based commands with repository-local temporary and cache paths:

  ```bash
  mkdir -p .codex-runtime/tmp .codex-runtime/npm-cache
  TMPDIR="$PWD/.codex-runtime/tmp" \
  npm_config_cache="$PWD/.codex-runtime/npm-cache" \
  npm <arguments>
  ```

- Run `n8n-node dev` with
  `--custom-user-folder "$PWD/.codex-runtime/n8n-node-cli"`. Do not use its
  default home-directory location.

## GitHub repository and delivery workflow

### Repository policy

- Treat `https://github.com/iljailjic/n8n-nodes-caldav` as the canonical public
  repository and `main` as its default and protected branch.
- Never modify, commit to, or push directly to `main`.
- Use one focused branch per issue named
  `codex/issue-<number>-<short-description>` unless the user explicitly names
  another branch.
- Invoking `github-feature-orchestrator` for a specific issue or milestone is
  explicit authorization for its routine delivery operations: creating and
  switching issue branches, making scoped commits, pushing only issue branches,
  creating or updating draft pull requests targeting `main`, updating issue and
  pull-request comments and labels, polling CI, and committing and pushing fixes
  required by implementation, review, local validation, or CI.
- That authorization never permits committing or pushing to `main`, merging or
  closing a pull request, force-pushing, deleting branches, creating or changing
  tags or releases, publishing to npm, or modifying repository settings,
  permissions, workflows, protection rules, variables, or secrets.
- Only the orchestrator may mutate Git or GitHub state. Subagents may read the
  repository and, when their role permits it, edit the already-selected working
  tree. Subagents must never switch or create branches, stage files, commit,
  merge, rebase, reset, stash, clean, push, create or update pull requests, or
  mutate issues, labels, comments, Actions, releases, settings, or secrets.
- Before any write-enabled subagent starts, before every commit, and before
  every push, the orchestrator must verify that the checked-out branch exactly
  equals the Delivery Context head branch and differs from the remote default
  branch. Once a pull request exists, it must also verify that its head equals
  that branch and its base equals `main`.
- If a branch guard fails, do not edit, stage, commit, or push. Restore the
  intended issue branch when this is safe and unambiguous; otherwise report the
  exact blocker without altering existing user work.
- Keep commits meaningful and preserve them when merging. Merge commits and
  rebases are enabled; squash merging is disabled. Prefer a merge commit for a
  non-trivial or externally contributed pull request.
- Repository-owned source branches are normally deleted automatically after
  merge. Never force-push or delete `main`, and never rewrite or delete release
  tags matching `v*`.
- Keep Actions permissions read-only by default. Do not weaken branch
  protection, tag rules, required checks, workflow permissions, dependency
  security, or secret-scanning settings.

### Issues, milestones, and pull requests

- Use milestones for planned version outcomes and issues for independently
  implementable, reviewable features or technical enablers. Keep small
  implementation steps as an issue checklist instead of creating micro-issues.
- Assign roadmap work to the milestone in which it is intended to ship. Treat
  `docs/MVP.md` as the product roadmap and GitHub issues as the execution
  tracker.
- Resolve dependencies only from explicit GitHub relationships or dependency
  statements in issues, comments, or repository documentation. Do not infer a
  dependency from issue numbers, dates, or similar titles.
- Treat a code dependency as satisfied only after its change is present on the
  remote default branch. An unmerged pull request remains a blocker.
- Link each pull request to its issue with `Closes #<issue>`, keep it focused,
  use the repository pull-request template, and initially create it as a draft.
- GitHub requires a pull request to compare a head branch containing commits
  with a different base branch. Therefore create the issue branch before any
  file modification and create the draft pull request immediately after the
  first meaningful issue commit. When practical, make contract-derived tests
  the first meaningful commit so the draft pull request exists before
  production implementation begins.
- Resolve all review conversations and update the branch from `main` before
  merge when GitHub reports it as behind.
- Required CI checks are `Node.js 22` and `Node.js 24`. Both must pass before
  human review and merge. CI performs:
  - `npm ci`
  - `npm exec -- prettier --check .`
  - `npm run lint`
  - `npm test --if-present`
  - `npm run build`
  - `npm pack --dry-run` on Node.js 24
- GitHub Actions must remain pinned to immutable commit SHAs.
- Review Dependabot pull requests like any other change. Inspect breaking
  changes and overlap, process them one at a time, and do not merge an update
  only because CI is green.
- Human review and explicit merge authorization are mandatory. The
  orchestrator must stop at that gate after local validation, independent
  review, and required GitHub Actions are green.

### Versions and npm publication

- Do not publish versions below `1.0.0` to npm by default. Pre-`1.0.0`
  milestones are project development stages, not npm releases. Any exception
  requires explicit user authorization.
- Prepare a stable release only from `main`. The package version must be a
  stable SemVer version of at least `1.0.0`, `CHANGELOG.md` must contain the
  matching version section, and exactly one closed milestone with the same
  version must exist.
- Create the release tag as `v<package-version>` and ensure that it points to a
  commit contained in `main`. Do not run `npm run release`, create a version
  tag, or publish from a contribution branch.
- npm publication is triggered only by publishing a non-prerelease GitHub
  Release. `.github/workflows/publish.yml` validates the package identity,
  version, tag, changelog, `main` ancestry, and closed milestone; then it runs
  formatting, lint, tests, build, package verification, and `npm run release`
  on Node.js 24.
- Treat npm publication as inactive until the owner explicitly prepares and
  authorizes it. Never invent npm identity, credentials, secrets, or publishing
  settings.

## Context-specific docs

Load these before working on the relevant area:

| Working on... | Read first |
| --- | --- |
| Any node file in `nodes/` | `.agents/nodes.md` and `.agents/properties.md` |
| A declarative-style node | Above plus `.agents/nodes-declarative.md` |
| A programmatic-style node | Above plus `.agents/nodes-programmatic.md` |
| Files in `credentials/` | `.agents/credentials.md` |
| Adding a new version to a node | `.agents/versioning.md` |
| Starting a new task or planning | `.agents/workflow.md` |

## Additional resources

- https://docs.n8n.io/integrations/community-nodes/build-community-nodes/
- https://docs.n8n.io/integrations/creating-nodes/overview/
- https://docs.n8n.io/integrations/creating-nodes/build/reference/
- https://docs.n8n.io/integrations/creating-nodes/build/reference/ux-guidelines/
