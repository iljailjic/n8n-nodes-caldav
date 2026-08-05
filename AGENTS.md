# n8n community node

## Overview
This is a project containing code for an n8n community node. n8n is a workflow
automation platform where users build workflows with nodes, which are the
building block of a workflow. Nodes can perform a range of actions, such as
starting a workflow (called a "trigger node"), fetching and sending data, or
processing and manipulating it. Besides that there are credentials - entities
that store sensitive information on how to connect to external services and
APIs. A node can require some credentials to be used. Community nodes are a way
for anyone to create such nodes and add them to be used in n8n. All community
nodes are named in a format: `n8n-nodes-<n>` or `@org/n8n-nodes-<n>`.
Community nodes can also be submitted for approval to be used on n8n Cloud
version. In that case there are rules that the node needs to follow in order to
be approved

## Important notes
- Follow the **rules and guidelines in this document and the linked docs
  below** over any code examples.
- All code blocks in these docs are **illustrative and incomplete**.
  They **MUST NOT** be copied verbatim or assumed to be the final desired code.
- Replace example names like `Example`, `Wordpress`, `wordpressApi`, etc.
  with names that match the **actual service / node** you are building.
- When in doubt, **generalize from the patterns**, don't replicate the exact
  structure, fields, or values from the examples.
- Produce the **full implementation** needed for the current project
  (nodes, credentials, tests, etc.), not just fragments similar to examples.
- If an example omits parts (e.g. types, operations, properties), **infer and
  implement the missing parts** based on the real requirements / API docs.
- Never output `Wordpress`-specific code unless the project is actually about
  WordPress.

## Project structure
There are two main folders in this project:
- `nodes` contains all of the nodes in a package (there can be more than 1).
  The code for each node usually lives in its own folder
- `credentials` contains all of the credentials in a package. Usually it's just
  a single file for every credential
So it looks something like this:
.
├── nodes/
│   └── Example/
│       ├── Example.node.ts
│       └── ...
├── credentials/
│   └── Example.credentials.ts
├── package.json
└── ...
It's important to note that `package.json` has a special field `n8n` that have
information about nodes and credentials in a package:
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
`nodes` and `credentials` keys contain paths to transpiled JS files in a `dist`
folder for the nodes and credentials respectively. If you add/remove/rename
nodes and/or credentials, you need to make sure to update `n8n.nodes` and
`n8n.credentials` keys in `package.json` accordingly. Initial files in the
project _may_ contain example nodes and/or credentials that need to be
**removed or renamed** once you start making an actual node.

## Key guidelines
- Use the `n8n-node` CLI tool **whenever possible** for building, dev mode,
  linting, etc.
- **Always** address any lint/typecheck errors/warnings, unless there is a
  **very specific reason** to ignore/disable it
- Make sure to use **proper types whenever possible**
- If you are updating the npm package version, make sure to **update
  CHANGELOG.md** in the root of the repository
- Read `.agents/workflow.md` for more info

## GitHub repository and delivery workflow

### Repository policy

- Treat `https://github.com/iljailjic/n8n-nodes-caldav` as the canonical public
  repository and `main` as its default and protected branch.
- Do not commit or push directly to `main`. Create a focused branch and open a
  pull request targeting `main`. Agents should use `codex/<short-description>`
  unless the user specifies another branch name.
- Do not commit, push, merge, close a pull request, create a tag, create a
  GitHub Release, or publish to npm without explicit user authorization.
- Keep commits meaningful and preserve them when merging. Merge commits and
  rebases are enabled; squash merging is disabled. Prefer a merge commit for a
  non-trivial or externally contributed pull request.
- Repository-owned source branches are normally deleted automatically after
  merge. Never force-push or delete `main`, and never rewrite or delete release
  tags matching `v*`.
- Keep Actions permissions read-only by default. Do not weaken branch
  protection, tag rules, required checks, workflow permissions, dependency
  security, or secret-scanning settings without explicit user authorization.

### Issues, milestones, and pull requests

- Use milestones for planned version outcomes and issues for independently
  implementable, reviewable features or technical enablers. Keep small
  implementation steps as an issue checklist instead of creating
  micro-issues.
- Assign roadmap work to the milestone in which it is intended to ship. Treat
  `docs/MVP.md` as the product roadmap and GitHub issues as the execution
  tracker.
- Link pull requests to their issue where applicable. Keep each pull request
  focused and use the repository pull request template.
- Resolve all review conversations and update the branch from `main` before
  merge when GitHub reports it as behind.
- Required CI checks are `Node.js 22` and `Node.js 24`. Both must pass before
  merge. CI runs for pull requests targeting `main` and for direct updates to
  `main`, and performs:
  - `npm ci`
  - `npm exec -- prettier --check .`
  - `npm run lint`
  - `npm test --if-present`
  - `npm run build`
  - `npm pack --dry-run` on Node.js 24
- GitHub Actions must remain pinned to immutable commit SHAs.
- Dependabot checks npm and GitHub Actions weekly. Review automated pull
  requests like any other change: inspect breaking changes and overlap, merge
  them one at a time, and do not merge a dependency update only because its CI
  is green.

### Versions and npm publication

- Do not publish versions below `1.0.0` to npm by default. The pre-`1.0.0`
  milestones represent project development stages, not npm releases. Any
  exception requires explicit user authorization.
- Prepare a stable release only from `main`. The package version must be a
  stable SemVer version of at least `1.0.0`, `CHANGELOG.md` must contain the
  matching version section, and the milestone with the exact same version must
  exist exactly once and be closed.
- Create the release tag as `v<package-version>` and ensure it points to a
  commit contained in `main`. Do not run `npm run release`, create a version
  tag, or publish from a contribution branch.
- npm publication is triggered only by publishing a non-prerelease GitHub
  Release. `.github/workflows/publish.yml` validates the package identity,
  version, tag, changelog, `main` ancestry, and closed milestone; then it runs
  formatting, lint, tests, build, package verification, and `npm run release`
  on Node.js 24.
- Treat npm publication as inactive until the owner explicitly prepares and
  authorizes it. The first publication requires an owner-provided temporary
  `NPM_TOKEN` repository secret. After the package exists on npm, configure npm
  Trusted Publisher/OIDC for this repository and remove the temporary token.
  Never invent npm identity, credentials, secrets, or publishing settings.

## Context-specific docs
Load these before working on the relevant area:

| Working on...                        | Read first                                                          |
|--------------------------------------|---------------------------------------------------------------------|
| Any node file in `nodes/`            | `.agents/nodes.md` and `.agents/properties.md`                      |
| A declarative-style node             | above + `.agents/nodes-declarative.md`                              |
| A programmatic-style node            | above + `.agents/nodes-programmatic.md`                             |
| Files in `credentials/`              | `.agents/credentials.md`                                            |
| Adding a new version to a node       | `.agents/versioning.md`                                             |
| Starting a new task or planning      | `.agents/workflow.md`                                               |

## Additional resources
If you need any extra information, here are links to n8n's official docs
regarding building community nodes:
- https://docs.n8n.io/integrations/community-nodes/build-community-nodes/
- https://docs.n8n.io/integrations/creating-nodes/overview/
- https://docs.n8n.io/integrations/creating-nodes/build/reference/
- https://docs.n8n.io/integrations/creating-nodes/build/reference/ux-guidelines/
