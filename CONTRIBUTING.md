# Contributing

Keep changes focused on the accepted MVP. Expose an n8n operation only when its
implementation and tests are ready.

## Setup

```bash
npm ci
npm exec -- prettier --check .
npm run lint
npm test --if-present
npm run build
```

Use `npm run dev` for local inspection in the n8n node development environment.

Radicale integration tests require a working local Docker CLI and daemon. Run
only that suite with `npm run test:integration`; `npm test` runs both unit and
integration tests. The integration command builds or reuses the pinned image,
creates a uniquely named authenticated service on a random IPv4 loopback port,
waits for authenticated readiness, and performs mandatory teardown after
success or failure. Docker networks are internal and run storage is isolated,
so parallel invocations do not share credentials, ports, or calendar data.
Do not copy generated harness credentials or runtime data out of
`.codex-runtime/`.

## Change requirements

- Keep the public event and calendar model provider-neutral.
- Isolate provider-specific interoperability behavior in provider adapters.
- Keep n8n UI, transport, discovery, XML, iCalendar, and provider layers
  separate.
- Add fixtures and tests with each future XML or iCalendar implementation.
- Do not include real account names, account-specific URLs, passwords, calendar
  contents, or captured private responses.
- Preserve ETags and unknown recurrence data unless the operation explicitly replaces them.
- Expose an operation in the UI only when it is implemented and tested.
- Update `CHANGELOG.md` when a change affects published behavior or completes a
  declared milestone.

## Quality checks

Pull requests target `main`. Keep commits meaningful; merge commits and rebases
are accepted, while squash merging is not used. All required CI checks must
pass and review conversations must be resolved before merge.

Run the same project checks as CI:

```bash
npm exec -- prettier --check .
npm run lint
npm test --if-present
npm run build
npm pack --dry-run
```

Add and document a test command when the first functional module introduces a
test suite.

Do not run the release command or create version tags from a contribution
branch. Releases are created from `main` through the repository release
workflow.
