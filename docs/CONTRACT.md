# CalDAV node contract

This document is the workflow-facing contract for the CalDAV community node.
It describes the behavior shipped on `main`; it is not a promise for deferred
CalDAV features.

## Compatibility baseline

The documentation and workflow examples target the workflow contract named
`1.0.0`. The validation matrix is n8n `2.39.8` on Node.js `24`, or the
official n8n `2.39.8` image. The package may still be published as a pre-1.0
development release: a beta or other pre-1.0 checkpoint is not itself a
compatibility baseline. The baseline names the workflow contract, not a
release or a promise of support for every n8n version.

### Saved workflow compatibility and migration

The initial CalDAV node is n8n node version `1` (`typeVersion: 1`). Existing
v1 saved workflows are the compatibility baseline. A change may remain in v1
only when it is additive and preserves all behavior observed by an omitted
parameter, including its default, visibility, validation, error text, and
output shape. New optional fields or operations must not change the behavior
of an existing v1 export when those fields are absent.

A change is breaking when it changes the meaning of an existing parameter or
omission, a default, a visible/hidden condition, an identifier mode, an error
branch or message relied on by workflows, or an output field's presence,
type, or meaning. Breaking changes require a light node-version increment and
version-gated runtime behavior: v1 keeps the old behavior, while the newer
version opts into the new behavior. Do not silently reinterpret an imported
v1 node as the newer behavior.

The v1 node must not introduce n8n `VersionedNodeType` full versioning. Use
the node's existing light-versioning shape for any future breaking change;
full versioning is reserved for a separately justified rewrite or a node that
already uses it. See [NODE-VERSIONING.md](NODE-VERSIONING.md) for the decision
rules and examples.

The saved-workflow compatibility matrix is intentionally navigable from the
repository: [`issue-61-v1-saved-workflows.json`](../test/unit/fixtures/workflows/issue-61-v1-saved-workflows.json)
covers every v1 Calendar/Event operation, both Resource URL and UID identifier
modes, both Structured and Raw ICS input modes, expression locators,
intentional default omissions, stable output samples, and Continue on Fail
error shapes. Its focused check is
[`issue-61-v1-workflow-compatibility.test.ts`](../test/unit/issue-61-v1-workflow-compatibility.test.ts).

The node requires a `CalDAV` credential with a server URL, username,
password, and an optional development-only TLS-validation bypass. Credentials
are managed by n8n and are never returned in node output.

For iCloud, set **Server URL** to `https://caldav.icloud.com`, use the Apple
Account email as **Username**, and use an Apple app-specific password as
**Password**. Discovery follows the current-user principal and calendar-home
properties, including trusted iCloud redirects and partition hosts, to find
calendar collections. The resulting collection and event URLs are opaque
values: pass them back to the node or choose **Calendar → From List** rather
than constructing iCloud paths yourself. Keep **Skip TLS Validation** disabled
outside isolated development environments.

## Resources and operations

| Resource | Operation | Required workflow input                                | Result                                             |
| -------- | --------- | ------------------------------------------------------ | -------------------------------------------------- |
| Calendar | Get       | Calendar collection URL                                | One calendar collection object                     |
| Calendar | Get Many  | Return All or a positive Limit                         | One item per discovered calendar                   |
| Event    | Create    | Calendar, Input Mode, and event fields                 | Created event, including resource URL and UID      |
| Event    | Get       | Calendar and Resource URL or UID                       | One normalized event                               |
| Event    | Get Many  | Calendar, inclusive Start, exclusive End               | One item per matching event                        |
| Event    | Update    | Calendar, identifier, optional ETag, and update fields | Authoritative updated event                        |
| Event    | Upsert    | Calendar, optional UID, Input Mode, and event fields   | Event plus `action: "create"` or `"update"`        |
| Event    | Delete    | Calendar, identifier, and the current ETag             | `{ calendarUrl, resourceUrl, uid, deleted: true }` |

Calendar selection accepts the searchable **From List** mode or an absolute
calendar collection URL. Calendar URLs and event resource URLs remain opaque
server values in output. A UID is an iCalendar identity, not a resource URL.

The node UI maps to these operation-specific parameters:

| Operation         | UI parameters                                                                                                                                                                         | Output fields                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Calendar Get      | `Calendar` (From List or By URL)                                                                                                                                                      | `url`, optional `displayName`, `description`, `timezone`, `color`, `supportedComponents`, `canRead`, `canWrite`, and `extensions` |
| Calendar Get Many | `Return All`; when false, positive `Limit`                                                                                                                                            | One calendar object per item, with the fields above                                                                               |
| Event Create      | `Calendar`, `Input Mode`; Structured adds `UID`, `Time Mode`, timed `Time Zone Mode`/`Time Zone`/`Start`/`End` or all-day `Start Date`/`End Date`, `Summary`, and `Additional Fields` | Event output; Create does not add `rawIcs`                                                                                        |
| Event Get         | `Calendar`, `Identifier Mode`, then `Resource URL` or `UID`                                                                                                                           | Normalized event fields plus `rawIcs`                                                                                             |
| Event Get Many    | `Calendar`, inclusive `Start`, exclusive `End`, `Return All`; when false, positive `Limit`                                                                                            | One normalized event plus `rawIcs` per item                                                                                       |
| Event Update      | `Calendar`, `Input Mode`, `Identifier Mode`, `Resource URL` or `UID`, optional `ETag`; Structured adds `Time Mode` and `Fields to Update`, Raw adds `Raw ICS`                         | Authoritative normalized event plus `rawIcs`                                                                                      |
| Event Upsert      | `Calendar`, `Input Mode`; Structured adds optional `UID`, `Time Mode`, time fields, `Summary`, and `Additional Fields`; Raw adds `Raw ICS`                                            | `action` (`create` or `update`) plus normalized event; update includes `rawIcs`                                                   |
| Event Delete      | `Calendar`, `Identifier Mode`, `Resource URL` or `UID`, optional `ETag`                                                                                                               | `calendarUrl`, `resourceUrl`, `uid`, `deleted: true`                                                                              |

`Additional Fields` for structured Create are `Description`, `Location`, `URL`,
`Categories`, `Status`, `Transparency`, `Recurrence`, and `Alarms`. Structured
Update and Upsert expose explicit Set/Remove patches for optional fields;
omitting a field leaves it unchanged. `Time Zone` is a dynamically loaded
canonical IANA option, not free-form provider metadata.

Event Get, Update, and Delete select either **Resource URL** or **UID**. Update
and Delete use an ETag when supplied; Delete requires a current ETag from the
input or the resolved resource, and Update uses the ETag as an `If-Match`
precondition when present. A stale precondition is
reported as a concurrency conflict. UID lookup is bounded and provider-aware;
an incomplete iCloud lookup never turns an Upsert into an accidental Create.

## Event input modes

Create, Update, and Upsert expose **Structured** and **Raw ICS** input modes.

Structured mode supports:

- timed events in UTC or a canonical IANA time zone;
- all-day events using Gregorian `Start Date` and exclusive `End Date`;
- summary, description, location, URL, categories, status, transparency,
  recurrence, and multiple DISPLAY/AUDIO/EMAIL alarms;
- preservation-first Update and Upsert patches, including unknown iCalendar
  properties and unsupported recurrence data.

Raw ICS mode accepts one complete, validated `VCALENDAR` event object. Raw
Update and the update branch of Raw Upsert replace the complete stored
calendar object, so omitted properties are removed. Raw Create and Upsert
insert a generated UUID when the VEVENT has no UID. Raw Update requires the
body UID to match the selected event. Raw input is bounded and subject to the
same calendar, ETag, parser-security, and CalDAV request safeguards.

For structured timed IANA authoring, the node prefers a verified RFC 7808/7809
server reference. For finite events it can generate a minimal embedded
`VTIMEZONE` from the bundled IANA TZDB 2026c identity list and proves coverage
before writing. Unbounded IANA recurrence authoring requires a verified server
reference. Reads treat an embedded `VTIMEZONE` as authoritative. Unsupported
time representations are readable and deletable but are read-only for
structured Update.

## Event output

The normalized Event object has this common shape. Optional properties are
omitted when the source event does not contain them.

```text
{
  calendarUrl: string,
  resourceUrl: string,
  etag?: string,
  uid: string,
  summary?: string,
  description?: string,
  location?: string,
  url?: string,
  categories?: string[],
  status?: "tentative" | "confirmed" | "cancelled" | { kind: "unsupported", token: string },
  transparency?: "opaque" | "transparent" | { kind: "unsupported", token: string },
  timeMode: "timed" | "allDay" | "unsupported",
  accessMode: "editable" | "readOnly",
  recurrence?: RecurrenceProjection,
  alarms?: CalendarAlarm[],
  extensions?: CalendarEventExtensions,
  rawIcs?: string
}
```

The conditional time fields are:

- Editable timed events have `timeMode: "timed"`, `accessMode: "editable"`,
  UTC `start` and `end` strings, `timeZoneMode: "utc" | "iana"`, optional
  canonical IANA `timeZone`, and local `startLocal` and `endLocal` strings.
  The local fields are present for both UTC and IANA projections.
- Editable all-day events have `timeMode: "allDay"`,
  `accessMode: "editable"`, and Gregorian `startDate` and exclusive `endDate`
  strings. They do not have timed or time-zone fields.
- Unsupported representations have `timeMode: "unsupported"`,
  `accessMode: "readOnly"`, and
  `readOnlyReason: "unsupportedTimeRepresentation"`. They do not invent start
  or end values and can still be read or deleted.

`recurrence` is either a supported rule or an unsupported projection:

```text
{ frequency: "daily" | "weekly" | "monthly" | "yearly",
  interval?: positive integer,
  end?: { kind: "count", count: positive integer }
      | { kind: "until", value: { kind: "date", date: string }
                              | { kind: "dateTime", dateTime: string } },
  byMonth?: number[], byMonthDay?: number[],
  byDay?: { weekday: weekday, ordinal?: number }[],
  weekStart?: weekday }
```

An unsupported recurrence is `{ kind: "unsupported", reason:
"unsupportedRulePart" | "unsupportedCombination" | "invalidRule", ruleParts:
string[] }`. Each supported `alarms` entry includes a `selector` (UID or
legacy position/fingerprint), optional `uid`, an action of `"display"`,
`"audio"`, or `"email"`, and a trigger relative to `"start"` or `"end"`.
Relative triggers are `{ reference: "start" | "end", direction: "before" |
"after", value: number, unit: "minute" | "hour" | "day" | "week" }` or `{
reference: "start" | "end", direction: "at" }`;
display adds `description`, email adds `subject`, `body`, and `recipients`.
Unsupported alarms are `{ kind: "unsupported", reason, alarmParts }`.

`extensions` is a nested map keyed by namespace URI and property name. Values
may be null, boolean, number, string, arrays, or recursively nested objects.
It is a provider-neutral preservation surface; it does not expose credentials.

Successful reads include a flat `rawIcs` string: the decoded direct GET body,
the selected REPORT calendar-data content, or the authoritative post-update
snapshot, depending on the operation. Create and Upsert-create omit it.
Upsert-update includes it, including for a semantic no-op. Raw ICS may contain
private calendar data and follows normal n8n execution-data retention.

Every output item retains `pairedItem` provenance for the input item that
caused it. Get Many operations produce multiple output items, each paired with
the originating input. With **Continue on Fail**, invalid input and remote
failures become an item containing `{ "error": "..." }`; without it, the node
raises an item-aware n8n error.

Errors are sanitized and branchable. These representative messages preserve
the public behavior without exposing credentials or response bodies:

| Failure category        | Example error text                                                                                                                              | Safe workflow action                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Invalid input           | `The Calendar URL is invalid. Enter an absolute HTTP(S) calendar collection URL.`                                                               | Correct the mapped parameter; do not retry unchanged input                             |
| Not found/ambiguous UID | `The calendar event was not found.` / `More than one calendar event with the requested UID was found in the selected calendar.`                 | Stop or select a unique identifier; Upsert must not create after an incomplete lookup  |
| Missing ETag            | `The calendar event does not provide an ETag required for a safe mutation.`                                                                     | Read the event again or use a provider that supplies ETags                             |
| Concurrency             | `The calendar event changed before the mutation could be applied.`                                                                              | Re-read, review the new state, then deliberately retry with the new ETag               |
| Authentication          | `CalDAV authentication failed. Check the CalDAV username and password.`                                                                         | Verify the Server URL, username, and password; for iCloud use an app-specific password |
| Authorization           | `The CalDAV server refused access to this resource.`                                                                                            | Select a calendar the account can access; do not retry unchanged credentials           |
| Timeout                 | `The CalDAV request timed out.`                                                                                                                 | Check server reachability, then retry deliberately; do not increase limits in a loop   |
| Response limit          | `The CalDAV server response exceeded the allowed size.`                                                                                         | Narrow the operation or date range; do not expect truncated data                       |
| Transport/security      | `TLS certificate validation failed.`, `The CalDAV server could not be reached.`, or `The CalDAV server returned an unsafe or invalid redirect.` | Surface the failure; do not log credentials or raw responses                           |

When **Continue on Fail** is enabled, the error text is placed in an output
item's `error` field and retains input pairing. Otherwise the node throws an
item-aware n8n error. HTTP precondition failures map to the concurrency branch;
they are never silently converted into an unconditional write.

## Troubleshooting

- **No calendars appear in From List:** verify the absolute Server URL,
  username, and password first. For iCloud, use an app-specific password and
  allow discovery to complete; use **By URL** only with a collection URL
  returned by discovery or supplied by the provider.
- **UID lookup reports not found or ambiguous:** confirm that the UID is an
  iCalendar UID in the selected collection, not a resource URL. A bounded or
  incomplete iCloud lookup fails safely; it never falls through to an Upsert
  create.
- **A mutation reports a missing or stale ETag:** read the event again and map
  its current `etag`. Review the new event before retrying a concurrency
  failure; do not turn the request into an unconditional write.
- **A structured update is read-only:** the event’s time representation is
  unsupported or ambiguous. It remains readable and deletable; use Raw ICS only
  when you intentionally supply a complete replacement object.
- **A TLS, redirect, or response-limit error occurs:** keep certificate
  validation enabled, verify the HTTPS endpoint, and inspect only the
  sanitized node error. Do not log credentials, `rawIcs`, or private response
  bodies.

For local validation, follow the deterministic Radicale matrix and Docker
prerequisites in [CONTRIBUTING.md](../CONTRIBUTING.md) and
[docs/RADICALE-INTEGRATION.md](RADICALE-INTEGRATION.md). The supported fixed
validation baseline for these examples is n8n `2.39.8` on Node.js `24` (or the
official n8n `2.39.8` image); the contract is intended for stable n8n 2.x use.

## Stability and security boundaries

The public calendar and event model is provider-neutral. iCloud behavior is
contained in a narrow adapter and may use bounded candidate checks and scans
for UID lookup. No credentials, private response bodies, calendar contents, or
account-specific URLs belong in workflow exports, logs, fixtures, or issues.

The node rejects unsafe XML declarations before parsing, applies response and
calendar-resource limits, and validates absolute HTTP(S) URLs without userinfo
or fragments. Calendar collection URLs, event resource URLs, and resolved
CalDAV `href` values use the same fragment-free URL boundary.
Insecure HTTPS-to-HTTP redirect downgrades are rejected and only trusted
redirects are followed. Use HTTPS and keep certificate validation enabled in
production. Deferred features include recurrence-exception editing,
scheduling, free/busy, collection mutation, sync tokens, sharing, delegation,
and attachments.

Related repository guidance: [README](../README.md), [MVP scope](MVP.md),
[architecture](ARCHITECTURE.md), [security policy](../SECURITY.md),
[contributing and validation](../CONTRIBUTING.md), and the
[importable workflow examples](WORKFLOW-EXAMPLES.md).
