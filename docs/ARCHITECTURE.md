# Architecture

The package separates n8n presentation concerns from protocol behavior so that
operations and provider adapters can evolve without duplicating CalDAV logic.

```text
n8n UI and operations
          │
          ▼
application coordination
     ┌────┴──────────────┐
     ▼                   ▼
discovery         calendar/event services
     │             ┌─────┴──────────┐
     ├────────────►│ XML protocol   │
     │             └─────┬──────────┘
     │                   │
     │             ┌─────▼──────────┐
     │             │ iCalendar      │
     │             │ parser/serializer
     │             └─────┬──────────┘
     └──────────────┬────┘
                    ▼
          CalDAV/WebDAV transport
                    │
                    ▼
              remote server
```

Provider adapters supply narrow interoperability rules to discovery,
transport, XML, and iCalendar boundaries without owning n8n UI behavior.

## Layer responsibilities

### n8n UI and operations

Define resources, operations, fields, item mapping, and n8n-specific errors.
Delegate protocol work to application services. Do not build XML, iCalendar, or
HTTP requests here.

Event time input is an explicit `timed` or `allDay` union. The n8n layer owns
strict expression normalization and projects native Date/DateTime values to
calendar dates with the workflow timezone; it never derives all-day dates from
the host timezone.

### CalDAV/WebDAV transport

Own authenticated HTTP requests, WebDAV methods, headers, redirects, timeouts,
TLS settings, response limits, and normalized transport errors. Treat URLs and
ETags as opaque protocol values.

### Discovery

Coordinate current-user principal, calendar-home, and calendar collection
discovery. Use the transport and XML layers rather than parsing responses or
performing raw requests directly.

### XML protocol

Build and parse namespace-aware WebDAV/CalDAV XML documents. Convert XML to
typed protocol objects and apply defensive input limits. Do not depend on n8n
UI types.

Time-range REPORT construction owns the fixed UTC `CALDAV:timezone` context
used to make all-day overlap semantics independent of server configuration.

### iCalendar parser/serializer

Parse and serialize `VCALENDAR`, `VEVENT`, time zones, alarms, recurrence, and
raw ICS while preserving data outside the simplified event model whenever
possible.

The public event read model discriminates editable UTC or IANA timed events, editable
Gregorian all-day events with an exclusive end date, and safe read-only events
whose time representation is unsupported. Structured time changes preserve
unrelated components and parameters, and explicit timed/all-day conversions
never infer a timezone or duration.

`icalendar/timeZones.ts` owns the checked-in IANA TZDB 2026c Zone/Link identity
oracle, deterministic `Intl` instant/local conversion, and the pure synchronous
finite `VTIMEZONE` generator. Generated definitions contain explicit
`STANDARD`/`DAYLIGHT` transitions only, stay within parser and serializer
resource limits, and are returned only after their closed event coverage is
proved. Embedded `VTIMEZONE` rules remain authoritative when reading an event.
Unsupported or ambiguous representations project to the read-only event branch
rather than inventing an instant.

`discovery/timeZoneReferences.ts` owns RFC 7809 capability detection and RFC
7808 TZDIST lookup. It keeps authenticated CalDAV discovery separate from
anonymous TZDIST requests, filters untrusted service targets, validates strong
ETags and calendar content, and scopes positive and negative caches to one
node execution.

`events/timeZoneAuthoring.ts` is the authoring selection boundary. It prefers a
verified server reference, falls back to a generated embedded definition only
for finite coverage, and returns private-safe typed failures when neither route
can prove a safe representation. Create resolves this selection before UID and
serialization; Update derives final bounds after its read and resolves only
when the patch actually changes time. Patching adds at most one newly authored
definition and removes an old one only when no preserved property still
references its exact source `TZID`.

### Provider adapters

Contain small, explicit interoperability rules. The default adapter follows
standards; the iCloud adapter handles only confirmed iCloud behavior. Provider
logic must not leak into workflow-facing identifiers or event fields.

## Planned structure

```text
credentials/
nodes/CalDav/
├── actions/
│   ├── calendar/
│   └── event/
├── discovery/
├── icalendar/
├── providers/
├── transport/
└── xml/
```

Introduce modules in these directories as their corresponding milestones are
implemented.

## Design rules

1. Expose only implemented and tested operations in the n8n UI.
2. Keep public calendar and event models provider-neutral.
3. Accept an optional event UID and generate a UUID when it is absent.
4. Preserve remote resource URLs and ETags as opaque server values.
5. Use ETag preconditions for concurrency-sensitive update and delete requests.
6. Treat XML and iCalendar inputs as untrusted.
7. Keep credentials out of output, logs, errors, and URLs.
8. Preserve recurrence and raw iCalendar data that an operation does not
   intentionally replace.
9. Add dependencies only when the implementation needs them and the project has
   made the relevant publishing and n8n Cloud-support decision.
