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

## Publishing

The delivery pull request and the GitHub Release are separate steps. Merge the
delivery pull request into `main` first. From the resulting `main` revision,
create the version tag and a **draft** GitHub Release for that tag. Keep the
release draft until the archive preparation and publication workflows finish.
The draft is a staging record for the reviewed package archive; it is not the
delivery pull request and does not publish the package.

### First publication: `1.0.0-beta.2`

The first npm publication is a one-time bootstrap because npm trusted publishing
cannot be used until the package exists. After the delivery pull request has
merged, prepare the `v1.0.0-beta.2` tag and its draft prerelease on `main`. Run
the **Prepare release archive** workflow from `main` with that tag. It validates
the tag and package metadata, runs the package checks, packs and verifies one
archive, and attaches that archive and its SHA-256 file to the draft release.
Review the draft and attached assets before publishing.

Create a short-lived **granular access token** scoped only to this package,
with read/write (publish and stage) permission and **Bypass 2FA** enabled.
npm requires Bypass 2FA for a noninteractive token publish. Add the token to
the repository's Actions secrets as `NPM_TOKEN`, then run **Publish first beta**
from `main` with `v1.0.0-beta.2`. This workflow accepts only that tag, verifies
the reviewed archive, publishes that exact archive to the `beta` dist-tag with
provenance, checks npm's registry metadata, and then marks the GitHub
prerelease as published. Do not put the token in a workflow input, commit,
local config file, or command line. Delete the `NPM_TOKEN` repository secret
and revoke or expire the temporary npm token as soon as the workflow has
completed successfully.

If archive preparation fails before assets are uploaded, fix the cause and
rerun it against the same draft tag. If it fails after upload, inspect the
draft's archive and checksum and their reported digests. The preparation phase
requires an empty asset list, so remove the uploaded assets from the draft
before rerunning that phase. If first-beta publication fails, inspect the
workflow phase and npm registry state before deciding to rerun. A failure
before npm accepts the archive can be corrected and retried with the same
reviewed archive. If npm accepted it but a later registry check or GitHub
Release update failed, do not attempt to publish the version again; confirm the
version, `beta` dist-tag, archive integrity, and provenance in npm, then resolve
the remaining release-state issue. Revoke the temporary token after recovery
is complete.

### Later publications

After the first package version exists, configure an npm trusted publisher at
the package's **Settings → Trusted Publishers** page. Select **GitHub Actions**
and set organization/user to `iljailjic`, repository to `n8n-nodes-caldav`, and
workflow filename to `publish.yml` (filename only; do not enter the
`.github/workflows/` path). Allow direct publishing with `npm publish`. The
regular **Publish** workflow grants `id-token: write` and publishes from this
workflow, so these settings must match exactly. See npm's [trusted publisher
setup](https://docs.npmjs.com/trusted-publishers/) for the current field
requirements.

For subsequent versions, use this npm trusted publisher with GitHub Actions
OIDC; do not add an npm token. Create the tag and draft GitHub Release from
`main`, run **Prepare release archive**, review its attached archive and
checksum, then publish the GitHub Release. Publishing the Release triggers the
**Publish** workflow, which validates the tag and reviewed assets and publishes
that exact archive with npm provenance. Prereleases receive the `next` dist-tag
and stable releases receive `latest`. The first-beta workflow is permanently
limited to `v1.0.0-beta.2` and is excluded from the regular publication
workflow. Publishing to npm or publishing a GitHub Release remains an explicit
repository-owner action; documentation and automation do not authorize either
action by themselves.
