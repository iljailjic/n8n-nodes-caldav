# Security and privacy review record

This record belongs to issue #62 and records only evidence available in the
repository review. It is not a penetration-test certification or a scanner
approval.

## Review scope

- Reviewed revision: `98922ff` (`2026-09-20`), plus the pre-existing uncommitted
  test overlay `test/unit/caldav-time-zone-references.test.ts` and the supplied
  dependency-remediation overlay in `package.json`/`package-lock.json`.
- Boundaries reviewed: credential fields and credential-test mapping; URL and
  redirect resolution; shared HTTP transport; XML parser; iCalendar parser,
  serializer, raw writes, and preservation; provider policy and iCloud UID
  fallback; TZDIST reference lookup; ETag-guarded mutations; package manifest,
  lockfile, workflows, and opt-in iCloud E2E harness.

## Threat conclusions from source inspection

- Credentials are represented by n8n credential storage, the password field is
  marked secret, and credential-derived authentication is not forwarded to
  anonymous TZDIST requests or untrusted redirect targets.
- URL boundaries reject userinfo, fragments, malformed references, and insecure
  HTTPS-to-HTTP downgrades. iCloud cross-origin forwarding is restricted to
  trusted HTTPS iCloud hosts.
- XML DTD/entity declarations are rejected. XML and iCalendar inputs have
  bounded depth, count, and byte limits. Transport responses and error excerpts
  are bounded and mapped to sanitized typed failures.
- ETag preconditions remain required for destructive mutations. Incomplete
  iCloud UID scans fail safely rather than falling through to Upsert create.
- The package manifest has no bundled production runtime dependency and declares
  the host-provided `n8n-workflow` peer according to the repository policy (`*`).
  The supplied installed graph resolves the lockfile root to `n8n-workflow`
  2.40.1, `@n8n-utils` 1.48.0, and `nanoid` 3.3.18. Repository workflows pin
  third-party actions by commit and grant read-only contents permissions for CI
  and E2E.
- TZDIST egress validates both the logical URL and its pinned resolved address,
  retains the existing `binding.lookup` path, and does not create a fresh
  `createSecureLookup` path. Supplied regression evidence covers this boundary
  in `test/unit/caldav-event-time-zone-node.test.ts` and the existing
  `test/unit/caldav-time-zone-references.test.ts` suite.
- The iCloud workflow requires explicit manual opt-in, scopes a dedicated
  calendar by digest, and the harness provides ownership-checked conditional
  cleanup with a bounded retry count. No live E2E outcome is asserted here.

## Named regression evidence

The following tests are the evidence targets for the claims above; pass/fail
status must come from the validation runner, not this source-review record:

- `caldav-credentials.test.ts`, `caldav-credential-test.test.ts`
- `caldav-url.test.ts`, `caldav-redirects.test.ts`, `caldav-http.test.ts`
- `caldav-xml.test.ts`
- `caldav-icalendar-parser.test.ts`, `caldav-icalendar-serializer.test.ts`,
  `caldav-raw-ics-write.test.ts`
- `caldav-event-mutations.test.ts`, `caldav-event-upsert.test.ts`,
  `caldav-event-resolve-by-uid.test.ts`
- `caldav-time-zone-references.test.ts` (including redirect-boundary and
  credential-isolation cases in the working-tree overlay)
- `test/unit/caldav-event-time-zone-node.test.ts` (logical URL and pinned
  resolved-address TZDIST egress)
- `test/unit/icloud-e2e-workflow-contract.test.ts` and the opt-in iCloud E2E
  workflow

## Findings and disposition

The supplied remediation evidence reports that the initial production audit's
three high findings were remediated. The final production-only command
`npm audit --omit=dev --audit-level=high --json` exited 0 with zero
vulnerabilities (`.codex-runtime/validation-issue62/audit-prod-remediated.json`).
The pre-remediation full audit reported 10 moderate, 3 high, and 0 critical
findings; the final full-audit disposition is recorded below separately from
the production-only result.

The documentation correction for configured URL fragments is applied in
`docs/CONTRACT.md`; the enforced-boundary summary is synchronized in
`SECURITY.md` and `docs/ARCHITECTURE.md`.

Dependency validation bootstrap exited 0 and the installed dependency graph was
verified by the validator. These are validator-supplied outcomes; the review
record does not claim to have rerun the bootstrap locally.

## Final validator outcomes

Validator revision 5 reports the following outcomes for the final candidate;
the detailed logs are under `.codex-runtime/validation-issue62/r5-*`:

- Prettier passed.
- Lint passed with 0 errors and 52 known warnings.
- `npm test` passed, including 41 integration tests.
- Build passed.
- Package verification passed with 139 manifest entries.
- The sanitized package/workflow inspection passed and is recorded in
  `.codex-runtime/validation-issue62/package-workflow-inspection-r7.txt`: it
  checked exact package manifest/exports and the `ci`, `icloud-e2e`, and
  `publish` workflow permissions and secret references. It records
  `contents: read`, publish `id-token: write`, and scoped E2E/npm references;
  no secret values were read.
- Production audit exited 0 with zero vulnerabilities.
- Full audit exited 1 only for 10 moderate development/build-tool findings;
  it reported 0 high and 0 critical findings. Under the repository owner
  policy, these moderate dev/build findings are non-blocking.

The following evidence remains pending and is intentionally not invented:

1. Any additional inspection of built/packed artifacts or workflow logs for
   sentinel-secret absence beyond the validator's recorded inspection result.
2. A live opt-in iCloud E2E run proving cleanup outcome; the source and harness
   provide cleanup controls, but no live credentials or run result are present
   in this review checkout.
