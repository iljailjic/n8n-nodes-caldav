# Changelog

Changes from published releases and declared project milestones will be
documented in this file.

## [0.1.0] - 2026-08-11

### Added

- Added provider-neutral CalDAV credentials with n8n-managed Basic authentication and a development-only TLS validation bypass.
- Added a read-only connection test covering CalDAV capability, current-user principal, and calendar-home discovery.
- Added bounded CalDAV/WebDAV transport with typed errors, response and redirect limits, same-origin redirects, and trusted iCloud partition-host redirects.
- Added deterministic URL and href handling plus namespace-aware WebDAV and CalDAV XML request building and multistatus parsing.
- Added offline unit coverage and Node.js 22 and 24 package-content verification for the 0.1.0 foundation.
