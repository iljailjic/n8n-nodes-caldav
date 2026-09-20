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

## Enforced boundaries

The following limits and invariants are enforced by the implementation and are
part of the security contract:

| Boundary            | Enforced behavior                                                                                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP transport      | 30-second request deadline, 10 MiB successful-response limit, 8 KiB retained error excerpt, and at most five redirects.                                                                                         |
| Redirects and URLs  | HTTP(S) only; no URL userinfo or fragments; HTTPS-to-HTTP downgrades are rejected; credentials are not forwarded to arbitrary cross-origin targets. iCloud forwarding is limited to trusted HTTPS iCloud hosts. |
| XML                 | DTD/entity declarations are rejected; parser depth and element count are each capped at 64 and 100,000.                                                                                                         |
| iCalendar           | Resource size is capped at 5 MiB; component count, property count, and nesting depth are each capped at 100,000, 100,000, and 64.                                                                               |
| iCloud UID fallback | At most 1,000 resources, 32 MiB aggregate body, and 60 seconds; incomplete scans fail safely and cannot cause an Upsert create.                                                                                 |
| Mutations           | Update and delete use ETag preconditions when available; delete requires a current ETag.                                                                                                                        |

Failures use stable typed/sanitized errors. Credentials, authorization headers,
raw response bodies, and private calendar data are not part of the public error
surface. The package currently bundles no production runtime dependency and
declares the host-provided `n8n-workflow` peer according to the repository
policy (`*`); the lockfile records the declared development tooling and
resolved graph.

The node runs with the privileges of the n8n process. Install only reviewed
versions from a trusted registry and protect the n8n instance accordingly.
