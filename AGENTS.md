# Project instructions

## Scope and sources of truth

- This repository contains an n8n community node for CalDAV. Keep the core data model and behavior provider-neutral even when the first supported or best-tested provider is iCloud.
- Treat the active issue and its acceptance criteria as the source of truth for a requested change. Use `docs/MVP.md`, `docs/ARCHITECTURE.md`, `CONTRIBUTING.md`, and `SECURITY.md` for repository-wide constraints.
- Treat examples in documentation and `.agents/` as patterns, not complete implementations. Replace illustrative names and values with the real domain concepts required by the change.
- Implement only behavior that is complete and testable. Do not expose unfinished resources, operations, fields, or options in the n8n UI.

## Architecture and implementation

- Keep provider-neutral calendar and event models separate from provider-specific request, authentication, and compatibility logic.
- Keep transport, CalDAV protocol handling, provider adapters, mapping, and n8n presentation concerns separated as described in `docs/ARCHITECTURE.md`.
- Preserve CalDAV concurrency and round-trip semantics, including ETags, recurrence data, and unknown properties that must survive an update.
- Prefer precise TypeScript types. Avoid `any` unless an external boundary cannot be represented more accurately; narrow and validate external data before using it.
- Use n8n error types and item-aware error handling. Respect `continueOnFail()` where the operation supports per-item execution.
- Keep node and credential exports synchronized with the `n8n.nodes` and `n8n.credentials` entries in `package.json` whenever files are added, moved, renamed, or removed.
- Add or update `CHANGELOG.md` when published behavior or the package version changes.

## Security and privacy

- Never commit real account names, usernames, passwords, app-specific passwords, server URLs, calendar contents, captured private responses, or other user data.
- Mark secret credential properties with `typeOptions.password` and avoid returning secrets from credential tests or error messages.
- Use sanitized fixtures and examples. Preserve only the protocol details required to reproduce the behavior under test.
- Follow `SECURITY.md` for authentication, transport, logging, and disclosure requirements.

## Local runtime data

- Keep repository-local transient data under `.codex-runtime/`, including npm cache, temporary files, n8n CLI state, and local n8n user data.
- Do not commit `.codex-runtime/` or depend on its contents in production code or tests.
- When isolating npm state, use repository-local paths such as:

  ```sh
  npm_config_cache="$PWD/.codex-runtime/npm-cache" \
  TMPDIR="$PWD/.codex-runtime/tmp" \
  npm ci
  ```

- When running an interactive n8n development instance, use a repository-local user folder rather than the default user profile.

## Validation

- Match tests to the changed behavior. Add a regression test for a bug fix and focused unit or integration coverage for new behavior.
- Use deterministic fixtures for XML, iCalendar, time zones, recurrence, and provider responses. Do not require live user credentials for the default test suite.
- Run the repository checks relevant to the change. Before declaring a production change complete, run the full local quality suite:

  ```sh
  npm ci
  npm exec -- prettier --check .
  npm run lint
  npm test --if-present
  npm run build
  npm run verify:package
  ```

- Run `npm run test:integration` when the change affects behavior covered by the Radicale integration suite. Follow `CONTRIBUTING.md` for its Docker prerequisites.
- Use `npm run dev` for interactive node testing when static and automated checks are insufficient.
- If a listed command is renamed, use the current equivalent from `package.json` and update stale repository documentation in the same change.

## Releases

- Do not publish to npm or create a release unless the repository owner explicitly requests it.
- Keep the package version, `CHANGELOG.md`, release notes, and delivered scope consistent.
- Treat versions below `1.0.0` as pre-stable. Do not advance to a stable release implicitly.
- Release only code already present on the repository's default branch and use the repository's existing release automation.

## Context-specific guidance

Read only the guidance relevant to the files being changed:

| Area | Guidance |
| --- | --- |
| Node structure and choosing declarative or programmatic style | `.agents/nodes.md` |
| Declarative node routing and transformations | `.agents/nodes-declarative.md` |
| Programmatic node execution | `.agents/nodes-programmatic.md` |
| Node properties, display conditions, and dynamic options | `.agents/properties.md` |
| Credential definitions and credential tests | `.agents/credentials.md` |
| n8n node versioning | `.agents/versioning.md` |

