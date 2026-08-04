# Version 1.0.0 MVP

Version 1.0.0 will provide a useful, general-purpose CalDAV node rather than a
single-workflow integration. iCloud is the first supported and fully tested
provider, while the public model remains standards-based.

## Required capabilities

### Credentials and connection test

- Configure server URL, username, password, and TLS validation.
- Store secrets through n8n credentials.
- Test authentication and CalDAV availability without exposing private response
  data.

### Discovery and calendar listing

- Discover the current-user principal.
- Discover the calendar-home collection.
- List accessible calendar collections.
- Handle relative and absolute `href` values, redirects, and iCloud partition
  hosts.

### Calendar resource

- Get.
- Get Many.

### Event resource

- Create.
- Get.
- Get Many over a date range.
- Update.
- Delete.
- Upsert.

Address events by CalDAV resource URL or UID where the server supports the
required lookup. Create and Upsert accept an optional UID; when absent, generate
a standards-compliant UUID. Do not assume an application-specific identifier.

### Event data

- Timed and all-day events.
- UTC and IANA time zones.
- Summary, description, location, and URL.
- Categories, status, and transparency.
- Reminders, including multiple alarms and supported display, audio, or email
  actions.
- Recurrence authoring and preservation.
- Raw ICS input and output as an interoperability escape hatch.

### Concurrency and interoperability

- Return resource URLs and ETags on reads and writes.
- Use `If-Match` for Update and Delete when an ETag is supplied.
- Surface precondition failures as concurrency conflicts.
- Define deterministic Upsert behavior without deleting historical events.
- Preserve unknown iCalendar properties whenever a structured operation does
  not intentionally replace them.
- Validate interoperability with iCloud, including discovery redirects,
  partition hosts, event CRUD, recurrence, alarms, all-day events, and time
  zones.

### Quality gates

- Reject XML containing DTD or entity declarations before parsing.
- Unit tests for transport-independent URL, XML, and iCalendar behavior.
- Integration tests against a local standards-compliant CalDAV server.
- Opt-in end-to-end tests against a dedicated iCloud test calendar.
- No credentials, private calendar data, or unbounded response bodies in logs
  and errors.
- Build and lint pass with the official n8n community-node tooling.

## Deferred beyond 1.0.0

- editing individual recurrence exceptions
- complex EXDATE/RDATE authoring
- scheduling inbox/outbox, attendees, and organizer workflows
- free/busy
- create/delete calendar collections
- moving events between calendars
- sync-token incremental synchronization
- sharing, delegation, and attachments
- provider-specific adapters beyond interoperability fixes needed for iCloud

## Development milestones

| Version      | Exit criterion                                                                      |
| ------------ | ----------------------------------------------------------------------------------- |
| 0.1.0        | Credentials, real connection test, transport/XML/discovery foundation               |
| 0.2.0        | Discovery fixtures and calendar listing validated against iCloud and a local server |
| 0.3.0        | Event Get and Get Many with time-range REPORT queries                               |
| 0.4.0        | Create, Update, Delete, ETag concurrency                                            |
| 0.5.0        | Upsert, all-day events, UTC and IANA time zones                                     |
| 0.6.0        | Reminders, recurrence, categories, status, transparency, raw iCalendar              |
| 1.0.0-beta.1 | Full integration and opt-in iCloud end-to-end suite                                 |
| 1.0.0        | Documentation, migration guarantees, security review, reproducible publish          |

Milestone closure records development progress. Versions before 1.0.0 are not
published to npm by the standard release workflow.
