# Radicale integration matrix

Issue #53 is validated by the checked-in manifest
[`test/unit/fixtures/issue-53-contract-manifest.json`](../test/unit/fixtures/issue-53-contract-manifest.json),
revision `issue-53-contract-r1`. The manifest is the stable inventory: every
case ID must occur exactly once, and the matrix has no skipped or TODO cases.
The unit test `test/unit/issue-53-contract-manifest.test.ts` checks that
inventory and its source paths.

This matrix proves behavior against a local, standards-oriented Radicale
service plus synthetic and unit oracles. It does not claim universal CalDAV
provider compatibility and does not include live iCloud coverage.

## Run the matrix

Requirements:

- Node.js 22 or 24 (the versions used by CI);
- a working local Docker CLI and daemon using the standard Docker socket;
- dependencies installed with `npm ci`.

Run only the Radicale suite:

```bash
npm run test:integration
```

Run the aggregate CI entry point (unit tests followed by the same integration
lifecycle):

```bash
npm test
```

Vitest discovery is deliberately separate: `vitest.config.mts` includes only
`test/unit/**/*.test.ts`, while `vitest.integration.config.mts` includes only
`test/integration/**/*.integration.test.ts`. The integration command builds or
reuses the test-only image from `test/integration/radicale/Dockerfile`, waits
for authenticated readiness, runs the matrix, and performs teardown on both
success and failure.

The contract check has two independent parts. During static collection, every
manifest entry is bound to one exact `issue53It`/`issue53ItEach` wrapper
registration, source file, literal ID, and scenario text; a substring or an
unrelated test in the same file is not sufficient. During runtime, the unit
and integration configurations are discovered in mutually exclusive runs and
must provide evidence for exactly 25 unit IDs and 48 integration IDs (73 IDs
total). The runtime evidence rejects missing, unknown, duplicate, or
non-passing IDs. These checks establish the contract only when the relevant
run completes successfully; they do not imply that Docker-backed integration
execution occurred when Docker is unavailable.

## Oracle and isolation model

| Oracle            | Manifest source                                                    | What it proves                                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live local        | `test/integration/radicale-harness.integration.test.ts`            | Real HTTP/WebDAV/CalDAV requests against a fresh authenticated Radicale service, including discovery, calendar filtering, event CRUD, time ranges, recurrence, alarms, raw ICS, ETags, read-only rights, and failure boundaries. |
| Synthetic/unit    | The `test/unit/caldav-*.test.ts` sources listed in the manifest    | Deterministic parser, validation, read-model, limit, error, recurrence, alarm, time-zone, and node-item behavior without a server.                                                                                               |
| Local static      | `test/unit/radicale-harness-static-contract.test.ts`               | Repository wiring, Vitest separation, CI Node versions, pinned image/base, package/compiler boundaries, network binding, and harness-only dependencies.                                                                          |
| Harness lifecycle | The `HARNESS-*` and `QUALITY-003` cases in the live/static sources | Run-scoped resource ownership, reset semantics, parallel isolation, bounded diagnostics, mandatory cleanup, and secret redaction.                                                                                                |

Each run creates unique fictional credentials and Docker identities, an
internal Docker network, a run-owned storage volume, and a random IPv4
loopback endpoint. The network is not published; the host proxy binds only to
`127.0.0.1`. Runtime state is under `.codex-runtime/radicale-harness/` and
`.codex-runtime/tmp/`. Teardown removes only resources carrying that run's
label, including the container, volume, and network. A failed test still
tears down before reporting failure, and a deliberate failure probe verifies
that a subsequent run can start.

The image is test-only: it uses the immutable official Python base pinned in
the Dockerfile and Radicale `3.7.7`. Python, Radicale, and harness artifacts
are not production or development package dependencies and are excluded from
the published package. The harness also probes that the runtime has no
external network egress after image build.

## Complete manifest matrix

The following groups enumerate every ID in `issue-53-contract-r1`. Rows are
thematic summaries for readability and do not imply that every grouped ID
shares an identical source, wrapper oracle, or scenario. The manifest is the
authoritative per-ID binding, and the contract test enforces each entry
individually.

### Harness, connection, discovery, and calendars — live local/harness

| IDs                                                                                                       | Scenario coverage                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HARNESS-001`, `HARNESS-002`, `HARNESS-003`, `HARNESS-006`, `QUALITY-003`                                 | Selected-run reset and reconnection; distinct parallel identities and confinement; deliberate-failure cleanup; bounded unavailability; nonzero failure after cleanup with redacted secret. |
| `CONNECTION-001`, `DISCOVERY-001`                                                                         | Discover the generated current-user principal and calendar home from fresh storage.                                                                                                        |
| `AUTH-401-001`                                                                                            | Reject an invalid password without invalidating the generated credential.                                                                                                                  |
| `AUTH-403-001`, `EVENT-GET-URL-001`, `EVENT-GET-UID-001`, `UID-NOT-FOUND-001`, `UID-NO-CONFLICT-LIVE-001` | Exact resource URL/UID retrieval plus live missing and forbidden boundaries.                                                                                                               |
| `DISCOVERY-002`, `CALENDAR-GET-001`                                                                       | Discover writable and read-only VEVENT calendars with accurate privileges.                                                                                                                 |
| `CALENDAR-MANY-001`, `CALENDAR-MANY-002`                                                                  | Empty-home behavior, sorting/filtering, duplicate/missing/empty collections, rights, and exclusion of VTODO-only collections.                                                              |

### Event operations — live local

| IDs                                                                                        | Scenario coverage                                                                                                 |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `EVENT-CREATE-STRUCTURED-UTC-001`, `CREATE-COLLISION-001`                                  | Unicode round trip and same-UID collision preservation.                                                           |
| `EVENT-CREATE-UUID-001`                                                                    | Canonical UUID generation for a blank node UID.                                                                   |
| `EVENT-CREATE-ALLDAY-001`, `EVENT-MANY-ALLDAY-001`                                         | Leap/year-boundary all-day round trips and half-open query boundaries.                                            |
| `EVENT-CREATE-IANA-001`, `EVENT-UPDATE-TIME-001`                                           | IANA event creation, range updates, zone changes, and finite generated fallback definitions.                      |
| `EVENT-CREATE-RECURRENCE-001`, `EVENT-MANY-RANGE-001`, `EVENT-MANY-RECURRENCE-001`         | Recurring master round trip without expansion and `[start,end)` overlap behavior.                                 |
| `EVENT-CREATE-ALARMS-001`                                                                  | Multiple alarm round trip through targeted edit, remove, and add.                                                 |
| `EVENT-CREATE-RAW-001`, `EVENT-UPDATE-RAW-001`, `EVENT-UPSERT-RAW-001`                     | Complex raw event create, replacement, upsert, authoritative read-back, and stale-ETag safety.                    |
| `EVENT-UPDATE-URL-001`, `EVENT-UPDATE-PRESERVE-001`                                        | Direct resource URL update with fetched/authoritative ETags and unknown-data preservation.                        |
| `EVENT-UPDATE-UID-001`                                                                     | UID update through `REPORT -> PUT -> GET` with the caller ETag.                                                   |
| `EVENT-UPDATE-METADATA-001`                                                                | Metadata preserve, replace, remove, and upsert with authoritative URL/ETag.                                       |
| `EVENT-DELETE-URL-001`, `EVENT-DELETE-UID-001`                                             | Conditional delete by resource URL and UID scoped to the selected calendar.                                       |
| `EVENT-UPSERT-UID-001`, `EVENT-UPSERT-OMITTED-UID-001`, `EVENT-UPSERT-TIME-001`            | Preservation-first UID upsert, omitted-UID conditional creates, and finite IANA fallback upsert without `DELETE`. |
| `UPDATE-STALE-ETAG-001`, `DELETE-STALE-ETAG-001`, `UPSERT-STALE-RACE-001`                  | One terminal concurrency conflict and preservation of the winning resource.                                       |
| `MISSING-RESOURCE-URL-001`                                                                 | Missing event reporting without issuing `DELETE`.                                                                 |
| `READONLY-CREATE-001`, `READONLY-UPDATE-001`, `READONLY-DELETE-001`, `READONLY-UPSERT-001` | Read-only denial mapping, no unsafe read-back/delete, and resource retention.                                     |

### Synthetic/unit and local static oracles

| Source                                                        | IDs                                                                                                   |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `test/unit/caldav-alarms-node-contract.test.ts`               | `VALIDATION-METADATA-001`, `VALIDATION-ALARM-001`                                                     |
| `test/unit/caldav-credentials.test.ts`                        | `VALIDATION-URL-001`                                                                                  |
| `test/unit/caldav-current-user-principal.test.ts`             | `MALFORMED-XML-001`, `INVALID-MULTISTATUS-001`                                                        |
| `test/unit/caldav-event-delete-resolution-regression.test.ts` | `EVENT-DELETE-UNSUPPORTED-001`                                                                        |
| `test/unit/caldav-event-read-model.test.ts`                   | `EVENT-GET-UNSUPPORTED-001`, `UID-AMBIGUOUS-SYNTHETIC-001`                                            |
| `test/unit/caldav-event-upsert.test.ts`                       | `RESOURCE-LIMIT-001`, `FORBIDDEN-XML-DECLARATION-001`, `VALIDATION-UID-001`                           |
| `test/unit/caldav-http.test.ts`                               | `RESPONSE-LIMIT-001`                                                                                  |
| `test/unit/caldav-icalendar-parser.test.ts`                   | `MALFORMED-ICS-001`                                                                                   |
| `test/unit/caldav-raw-ics-write-node.test.ts`                 | `NODE-ITEM-001`                                                                                       |
| `test/unit/caldav-raw-ics-write-services.test.ts`             | `VALIDATION-RAW-001`                                                                                  |
| `test/unit/caldav-recurrence-authoring-contract.test.ts`      | `VALIDATION-RECURRENCE-001`                                                                           |
| `test/unit/caldav-time-zones.test.ts`                         | `VALIDATION-TIME-001`, `VALIDATION-IANA-001`                                                          |
| `test/unit/radicale-harness-static-contract.test.ts`          | `MATRIX-001`, `MATRIX-002`, `HARNESS-004`, `HARNESS-005`, `HARNESS-007`, `QUALITY-001`, `QUALITY-002` |

## Interpreting failures

The integration output identifies a bounded harness lifecycle stage (Docker
capability, image build, startup, authenticated readiness, rights update,
storage reset, service stop, inspection, test, or cleanup). Treat failures in
those stages as harness/environment failures until the relevant local Docker
prerequisite or runtime state is corrected. A test-stage failure is a product
or contract failure only after the harness has started the isolated service and
completed authenticated readiness.

Diagnostics are intentionally privacy-safe and bounded. They redact generated
passwords and Basic Authorization values and do not print XML bodies, ICS
content, account names, private URLs, or unbounded response bodies. Do not
copy `.codex-runtime/` contents into issues or pull requests. Report the
stable case ID, lifecycle stage, Node version, and a short sanitized error
summary instead.
