# Changelog

Changes from published releases and declared project milestones will be
documented in this file.

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
