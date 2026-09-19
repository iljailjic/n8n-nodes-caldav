# n8n-nodes-caldav

General-purpose CalDAV community node for [n8n](https://n8n.io/), designed for
standards-compliant calendar servers with first-class iCloud interoperability.

The node provides calendar and event automation without tying workflows to a
specific provider or use case. It handles CalDAV discovery, WebDAV semantics,
XML protocol data, iCalendar content, and provider-specific interoperability
behind a provider-neutral n8n interface.

## Features

- automatic CalDAV principal, calendar-home, and calendar discovery;
- calendar and event operations for n8n workflows;
- optional user-supplied event UIDs or automatically generated UUIDs;
- ETag-based concurrency protection;
- timed and all-day events with UTC and IANA time zones;
- recurrence, reminders, extended event fields, and raw ICS access;
- iCloud-first interoperability with a standards-based default path.

## Installation

Install `@iljailjic/n8n-nodes-caldav` through the Community Nodes section of your n8n
instance. See the
[n8n community node installation guide](https://docs.n8n.io/integrations/community-nodes/installation/)
for supported installation methods.

## Credentials

Configure a CalDAV account with:

- **Server URL** — the CalDAV service endpoint;
- **Username** — the CalDAV account name;
- **Password** — the CalDAV password;
- **Skip TLS Validation** — disabled by default and intended only for
  isolated development environments.

For iCloud:

- use `https://caldav.icloud.com` as the server URL;
- use the Apple Account email address as the username;
- use an Apple app-specific password instead of the main Apple Account
  password.

Credentials are stored through n8n's encrypted credential system.
Use HTTPS and keep certificate validation enabled in production.

## Operations

### Calendar

- Get
- Get Many

### Event

- Create
- Get
- Get Many
- Update
- Delete
- Upsert

Event operations cover timed and all-day events, UTC and IANA time zones,
description, location, URL, categories, status, transparency, reminders,
recurrence, and raw iCalendar data.

Event Create, Update, and Upsert provide an explicit **Input Mode**. Structured
mode uses the individual event fields and remains preservation-first: Event
Update changes only selected fields. Raw ICS mode accepts one complete,
validated `VCALENDAR` event object. Raw Update and the update branch of Raw
Upsert intentionally replace the entire stored calendar object, so properties
omitted from the Raw ICS input are removed. Raw mode still enforces event UID,
calendar URL, 5 MiB resource, ETag concurrency, parser-security, and CalDAV
request limits. A UID-less Raw Create or Upsert generates one UUID and inserts
it into the complete VEVENT set; Raw Update requires the body UID to match its
target.

Successful event reads expose the source calendar object as the flat `rawIcs`
JSON string alongside normalized event fields:

| Operation                 | `rawIcs` result                                              |
| ------------------------- | ------------------------------------------------------------ |
| Event Get by resource URL | Exact decoded direct GET body                                |
| Event Get by UID          | Selected REPORT `calendar-data` character content            |
| Event Get Many            | Corresponding REPORT `calendar-data` content for each item   |
| Event Create              | Omitted                                                      |
| Event Update              | Authoritative post-update GET body                           |
| Event Upsert Create       | Omitted                                                      |
| Event Upsert Update       | UID lookup content for a no-op, otherwise the final GET body |

Direct GET preserves the decoded calendar-resource body except for removing an
optional leading UTF-8 BOM. REPORT results follow XML character semantics, so
entities and CDATA are decoded and literal XML line endings are normalized.
Neither path unfolds, refolds, trims, or reconstructs the returned value.

Each decoded calendar resource is limited to 5 MiB, and the complete CalDAV
response is limited to 10 MiB. Limits are enforced without truncation. JSON
serialization may escape control characters, but parsing the workflow item
recovers the same JavaScript string.

> [!WARNING]
> `rawIcs` is sensitive workflow output and can contain calendar information
> that is absent from normalized fields. It follows normal n8n execution-data
> retention, so configure retention and access controls accordingly.

Raw ICS input is equally sensitive. It is stored in workflow configuration and
may be retained in execution data according to the n8n instance's retention and
access-control settings. Do not paste production calendar objects into shared
workflows, issue reports, logs, or test fixtures.

For Event Create, supply a UID to preserve that exact event identity, or leave
UID blank to generate a standards-compliant UUID. Each separate Create with a
blank UID generates a new identity; omission is not an idempotency mechanism.

Timed events default to UTC. In IANA mode, choose a canonical zone from the
node's bundled IANA TZDB 2026c list. Instants are serialized as local
`DTSTART`/`DTEND` values with one canonical `TZID`. The node first tries the
server-by-reference flow from RFC 7809 and RFC 7808. If no safe reference is
available for a finite event, it embeds a minimal finite `VTIMEZONE` generated
from the current runtime's `Intl` rules and proves that it covers the event
bounds before writing. Unbounded IANA recurrence authoring still requires a
verified server reference. Requests to the time-zone distribution service are
anonymous and never reuse CalDAV credentials.

For existing events, an embedded `VTIMEZONE` is authoritative. Time
representations that cannot be interpreted safely remain available as
read-only output and can still be deleted, but cannot be updated. UTC-equivalent
identifiers belong in UTC mode. During a daylight-saving overlap, use UTC mode
for the second occurrence of an ambiguous local time. Non-time updates preserve
the original time-zone spelling and definition without performing reference
lookup or generation. Explicit representation changes remove an old embedded
definition only when no preserved calendar content still references it.

See [docs/MVP.md](docs/MVP.md) for the complete version 1.0.0 scope and
acceptance criteria.

The stable workflow-facing field, output, error, and compatibility contract is
in [docs/CONTRACT.md](docs/CONTRACT.md). See
[docs/WORKFLOW-EXAMPLES.md](docs/WORKFLOW-EXAMPLES.md) for sanitized wiring
examples covering Create, Upsert, Update, Get Many, and Delete.

## Usage

1. Install the community node.
2. Create CalDAV credentials in n8n.
3. Add the CalDAV node to a workflow.
4. Select a calendar or event operation.
5. Map calendar identifiers, event data, UIDs, and ETags from previous workflow
   items as needed.

Use a dedicated test calendar when validating write operations against a new
provider.

## Compatibility

iCloud is the first fully tested provider. The public data model remains
provider-neutral and targets interoperable CalDAV servers.

Provider-specific behavior belongs in narrow adapters and must not leak into
workflow-facing calendar or event models.

## Roadmap

The implementation milestones leading to version 1.0.0 are:

- **0.1.0** — credentials, connection test, transport, XML, and discovery
  foundation;
- **0.2.0** — discovery hardening and calendar listing against iCloud and a local
  CalDAV server;
- **0.3.0** — Event Get and Get Many;
- **0.4.0** — Event Create, Update, and Delete with ETag concurrency;
- **0.5.0** — Upsert, UUID generation, time zones, and all-day events;
- **0.6.0** — reminders, recurrence, categories, status, transparency, and raw
  ICS;
- **1.0.0-beta.1** — full integration and opt-in iCloud end-to-end validation;
- **1.0.0** — stable, documented, interoperable release validated against
  iCloud and a standards-compliant local server.

Detailed exit criteria are maintained in [docs/MVP.md](docs/MVP.md).
Intermediate milestones track development progress; the first routinely
published npm release is version 1.0.0.

## Development

Install dependencies:

```bash
npm ci
```

Run the development environment:

```bash
npm run dev
```

Run quality checks:

```bash
npm run lint
npm test --if-present
npm run build
```

### Radicale integration tests

The integration suite requires a working Docker CLI and daemon using the
standard local Docker socket. Run it directly with:

```bash
npm run test:integration
```

That one command builds or reuses the digest-pinned Python image with the exact
Radicale test version, starts an isolated authenticated service, waits for an
authenticated CalDAV operation, runs only the integration suite, and always
tears down its run-owned containers, internal networks, and storage volumes.
Each invocation generates unique fictional credentials and Docker identities
and publishes a random port on IPv4 loopback only, so repeated and parallel
runs do not share service data or expose Radicale publicly. Runtime networking
has no external egress after the image build.

`npm test` remains the aggregate CI command and runs unit tests before the same
integration lifecycle. Harness runtime support stays under `.codex-runtime/`;
cleanup never removes that repository-local runtime directory. On failure, the
command reports the failed lifecycle stage without printing generated
credentials or private response bodies.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution requirements and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for module boundaries. The
[complete Radicale matrix](docs/RADICALE-INTEGRATION.md) lists every accepted
issue-53 contract ID, its oracle, and failure interpretation.

### Opt-in iCloud end-to-end tests

The iCloud suite is an opt-in, discovery-only interoperability check, not a
pull-request or scheduled check. Use a dedicated Apple account and calendar;
do not use a production account or calendar. The suite validates capability,
principal and calendar-home discovery, and exact calendar selection. It does
not read events or mutate calendars, events, or collections, and it refuses to
operate unless discovery finds exactly one calendar whose display name is an
exact match for the configured selector; it does not fall back to another
calendar.

Use an Apple app-specific password, not the Apple Account password. Create it
for the dedicated account, store it only in the ignored local E2E environment
file or the repository's GitHub Actions secrets, and revoke it after testing
or rotate it if it may have been exposed. The required names are:

```text
CALDAV_ICLOUD_E2E_SERVER_URL
CALDAV_ICLOUD_E2E_USERNAME
CALDAV_ICLOUD_E2E_APP_PASSWORD
CALDAV_ICLOUD_E2E_CALENDAR_DISPLAY_NAME
```

`CALDAV_ICLOUD_E2E_SERVER_URL` must be an absolute `https://` URL without
userinfo (username or password) or a fragment. Cleartext `http://` URLs are
rejected before credentials are used or any transport request is made.

Create the ignored local configuration from the committed placeholder file and
replace every value in `.env.icloud-e2e`:

```bash
cp .env.icloud-e2e.example .env.icloud-e2e
```

The npm scripts load `.env.icloud-e2e` automatically through Node.js. The real
file is covered by `.gitignore`; never force-add it or put live values in the
committed example. The scripts control `CALDAV_ICLOUD_E2E_OPT_IN` themselves:
the dry run forces it to `0`, and the composite live command sets it to `1`
only after the dry run succeeds.

Run the fake transport dry run first:

```bash
npm run test:e2e:icloud:dry-run
```

Only after that succeeds, and after confirming the dedicated account and empty
calendar, run locally without repeating the credentials:

```bash
npm run test:e2e:icloud
```

The GitHub Actions workflow is `iCloud E2E (manual)` in
`.github/workflows/icloud-e2e.yml`. It can be started only with
`workflow_dispatch` on `main`, with the required boolean
`confirm_live_icloud_e2e` explicitly enabled. Configure
`CALDAV_ICLOUD_E2E_SERVER_URL`, `CALDAV_ICLOUD_E2E_USERNAME`,
`CALDAV_ICLOUD_E2E_APP_PASSWORD`, and
`CALDAV_ICLOUD_E2E_CALENDAR_DISPLAY_NAME` as repository **Secrets**. The exact
display-name selector is sensitive; never put live values in workflow files, commands
committed to the repository, issues, or pull requests. GitHub injects these
values directly; the workflow does not create or consume the local env file.
It runs the fake dry run before the live job, uses least-privilege read-only
repository access, and serializes runs per calendar scope. It is not a required
CI or pull-request check.

The live run permits only `OPTIONS` and `PROPFIND` requests. Output is limited
to aggregate, privacy-safe evidence: the evidence schema revision, mode and
outcome, scenario names, observed request methods, and stable error codes. Do
not copy live responses, server or partition URLs, calendar names, XML,
iCalendar data, event content, credentials, or other live values into issues,
logs, artifacts, or chat. No event read or mutation is implied by this
documentation.

## Security

Do not include credentials, account-specific URLs, captured calendar responses,
or private calendar data in issues, fixtures, or logs. See
[SECURITY.md](SECURITY.md) for the security policy.

## License

[MIT](LICENSE.md)
