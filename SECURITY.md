# Security policy

## Supported versions

Beginning with 1.0.0, the latest minor release of the current major version is
supported. Reports concerning unreleased development milestones are evaluated
against the current `main` branch.

## Reporting a vulnerability

Do not open a public issue containing exploit details, credentials, or private
calendar data.

Use
[GitHub Private Vulnerability Reporting](https://github.com/iljailjic/n8n-nodes-caldav/security/advisories/new).

## Security model

- CalDAV credentials are managed by n8n and restricted to the CalDAV node.
- TLS certificate validation is enabled by default.
- Redirects and server-provided `href` values are treated as untrusted protocol
  data and never used as a source of credentials.
- XML and iCalendar input are untrusted. XML containing DTD or entity
  declarations is rejected before parsing.
- HTTP errors are converted to bounded messages that do not contain credentials
  or private response bodies.
- Update and delete operations use conditional requests when an ETag is
  available.
- Runtime dependencies are reviewed before adoption and pinned through the
  lockfile.
- Releases use GitHub Actions and npm provenance.

The node runs with the privileges of the n8n process. Install only reviewed
versions from a trusted registry and protect the n8n instance accordingly.
