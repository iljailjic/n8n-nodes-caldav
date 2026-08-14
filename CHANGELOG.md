# Changelog

Changes from published releases and declared project milestones will be
documented in this file.

## [0.4.0] - 2026-08-14

### Development checkpoint

- Added deterministic standards-compliant basic timed UTC VEVENT serialization with preservation-AST round trips, RFC escaping and parameter encoding, UTF-8-aware folding, and CRLF output (#33).
- Added shared conditional CalDAV mutation services with canonical resource metadata, opaque ETags, safe preconditions, and sanitized conflict mapping (#34).
- Added collision-safe Event Create with explicit UID, canonical URL and authoritative ETag output, item pairing, and Radicale collision validation (#35).
- Added preservation-first structured event patching with explicit set/remove semantics, deterministic revision metadata, and unknown-data retention (#36).
- Added conditional Event Update by Resource URL or UID with verified preservation read-back, canonical URL and authoritative current ETag output, and stale-ETag protection (#37).
- Added conditional Event Delete by Resource URL or UID with mandatory ETag preconditions, canonical deletion metadata, pairing, and stale/read-only validation (#38).

## [0.3.0] - 2026-08-13

### Development checkpoint

- Added bounded, preservation-first iCalendar parsing with explicit security limits (#26).
- Added provider-neutral UTC event projection with URL, UID, and ETag identity plus internal preservation context (#27).
- Added deterministic event resolution by UID (#28).
- Added deterministic `[start, end)` calendar-query REPORT results with recurrence non-expansion (#29).
- Added Event Get by Resource URL and UID (#30).
- Added Event Get Many with Return All and Limit handling, item pairing, and Radicale boundary validation (#31).

## [0.2.0] - 2026-08-12

### Development checkpoint

- Added a reproducible, isolated Radicale integration-test harness for authenticated CalDAV discovery and clean lifecycle validation (#19).
- Added provider-neutral VEVENT calendar collection discovery with canonical URLs, capability flags, and synthetic standard and iCloud pipeline coverage (#20, #21).
- Added the Calendar Get and Get Many operations with canonical URL identity, n8n item pairing, deterministic ordering, and bounded result handling (#22, #23).
- Added a searchable Calendar resource locator with From List and By URL modes while retaining canonical URLs as workflow identity (#24).

## [0.1.0] - 2026-08-11

### Added

- Added provider-neutral CalDAV credentials with n8n-managed Basic authentication and a development-only TLS validation bypass.
- Added a read-only connection test covering CalDAV capability, current-user principal, and calendar-home discovery.
- Added bounded CalDAV/WebDAV transport with typed errors, response and redirect limits, same-origin redirects, and trusted iCloud partition-host redirects.
- Added deterministic URL and href handling plus namespace-aware WebDAV and CalDAV XML request building and multistatus parsing.
- Added offline unit coverage and Node.js 22 and 24 package-content verification for the 0.1.0 foundation.
