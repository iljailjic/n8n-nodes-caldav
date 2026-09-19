# Workflow examples

These examples use fictional URLs and values. Select the `CalDAV` credential on
every node. Each of the four scenarios with a shipped fixture links to its
sanitized, importable workflow export; the Delete and failure-handling notes
remain prose guidance.

## Create a timed event, then read it by UID

[Importable fixture: `caldav-create-read.json`](../examples/workflows/caldav-create-read.json)

1. Add **CalDAV → Event → Create**.
2. Select the calendar from **From List** or enter
   `https://calendar.example.test/calendars/work/` in **By URL**.
3. Set **Input Mode** to `Structured`, **Time Mode** to `Timed`,
   **Time Zone Mode** to `UTC`, and enter:

   ```text
   UID:       planning-2026-09-21@example.test
   Start:     2026-09-21T09:00:00Z
   End:       2026-09-21T09:30:00Z
   Summary:   Planning check-in
   ```

   The returned item contains `calendarUrl`, `resourceUrl`, `uid`, and (when
   supplied by the server) `etag`. Leave UID blank when each Create should
   receive a new generated UUID; blank UID is not an idempotency key.

4. Add **CalDAV → Event → Get**, choose **Identifier Mode → UID**, and map
   `{{$json.uid}}` into **UID**. Map the same calendar URL into **Calendar**.
   The result includes normalized fields and `rawIcs`.

## Idempotent create-or-update with Upsert

[Importable fixture: `caldav-upsert.json`](../examples/workflows/caldav-upsert.json)

Use **Event → Upsert** when the workflow owns a stable UID:

```text
Calendar:    https://calendar.example.test/calendars/work/
Input Mode:  Structured
UID:         {{$json.externalId}}@example.test
Time Mode:   All-Day
Start Date:  {{$json.startDate}}
End Date:    {{$json.endDate}}
Summary:     {{$json.title}}
```

With a supplied UID, Upsert resolves that UID inside the selected calendar and
returns `action: "create"` or `action: "update"`. With a blank UID it always
creates a new event. Do not use Upsert to move an event between calendars.
The update result includes the authoritative `rawIcs` snapshot.

## Preservation-first Update with an ETag

[Importable fixture: `caldav-etag-update.json`](../examples/workflows/caldav-etag-update.json)

Wire an Event Get or Get Many node into **Event → Update**:

```text
Calendar:       {{$json.calendarUrl}}
Identifier:     Resource URL
Resource URL:   {{$json.resourceUrl}}
ETag:           {{$json.etag}}
Time Mode:      Timed
Fields to Update → Summary → Set → {{$json.nextSummary}}
```

Only selected fields change. Unselected properties, recurrence data, alarms,
and unknown iCalendar properties are preserved. If another writer changed the
resource, the ETag precondition fails as a concurrency conflict; handle that
branch explicitly instead of retrying with a newly fetched ETag blindly.

To replace the complete object intentionally, choose **Input Mode → Raw ICS**.
The Raw ICS body must be a complete validated `VCALENDAR`; properties omitted
from it are removed. Raw Update still requires the selected calendar and
matching event UID, and may use the mapped ETag.

The complete Raw ICS Create scenario is available as the
[importable `caldav-raw-ics-create.json` fixture](../examples/workflows/caldav-raw-ics-create.json).

## Query a date range

Use **Event → Get Many** with the same calendar locator and:

```text
Start:      2026-09-01T00:00:00Z
End:        2026-10-01T00:00:00Z
Return All: false
Limit:      100
```

The interval is `[Start, End)`: an event exactly at the exclusive end is not
selected. Each matching event is a separate output item, each with `rawIcs`
and paired-item provenance from the input that supplied the range.

## Delete safely

Use **Event → Delete only against a dedicated non-production test calendar**.
For example, use the fictional test locator
`https://calendar.example.test/calendars/dedicated-test/`, select **Identifier
Mode → Resource URL**, and map the `resourceUrl` and current `etag` from a
preceding read. Delete returns the canonical resource identity and
`deleted: true`. Delete requires a current ETag, so a missing or stale value is
a deliberate stop rather than an unconditional delete. Never point this
example at a production calendar or a calendar containing personal data.

## Handle per-item failures

When processing multiple input items, enable n8n **Continue on Fail** if the
workflow should keep successful items. Failed items are returned as:

```json
{
	"error": "A sanitized, item-specific failure message"
}
```

The node preserves each failed item's `pairedItem` reference. Keep `rawIcs`
out of logs and shared workflow data unless the workflow explicitly needs the
complete calendar object.
