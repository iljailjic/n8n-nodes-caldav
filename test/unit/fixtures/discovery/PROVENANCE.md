# Synthetic discovery fixture provenance

Every fixture and table case in this directory is fictional, synthetic, minimal, and hand-authored from the cited standards and accepted contracts. None was copied, sanitized, redacted, transformed, minimized, or otherwise derived from an iCloud account, a private response, or captured traffic. The values use reserved test domains except for the fixed public `caldav.icloud.com` and `p42-caldav.icloud.com` provider-policy grammar; the partition number and every path are invented and are never contacted.

Privacy review: the corpus contains no real person, account identifier, username, credential, authorization value, UID, calendar/event content, observed partition assignment, captured header set, or remote prose. Real account responses and values must never be committed as fixtures or published as test artifacts. Changes require the same manual provenance and private-data review.

## Inventory

Each inventory identifier below corresponds exactly to an exported fixture or table case.

- `standard-equivalent` — synthetic hand-authored RFC 4791 §§5.2.1–5.2.3 and 6.2.1 / RFC 4918 §§9.1 and 13 shape; relative and absolute hrefs, successful and failed propstats, optional failures, read-only access, and resource filtering; privacy reviewed: pass.
- `icloud-style-equivalent` — synthetic hand-authored contract C05/C13 shape; renamed/default namespace prefixes and split 2xx/failed propstats with standards-equivalent semantics; privacy reviewed: pass.
- `icloud-partition-relative` — synthetic hand-authored accepted iCloud routing contract C03/C06/C20 shape; trusted entry-to-partition redirect and effective-URL-relative principal, home, and calendar hrefs; privacy reviewed: pass.
- `missing-capability` — synthetic hand-authored capability contract C14/C15 shape; privacy reviewed: pass.
- `failed-principal-required-property` — synthetic hand-authored RFC 4918 propstat failure / principal contract C14/C15 shape; privacy reviewed: pass.
- `forbidden-home-required-property` — synthetic hand-authored RFC 4918 403 propstat / home contract C14/C15 shape; privacy reviewed: pass.
- `principal-href-malformed-whitespace`, `principal-href-empty`, `principal-href-fragment`, `principal-href-userinfo`, `principal-href-dot-segment`, `principal-href-backslash`, `principal-href-downgrade`, `principal-href-malformed-percent` — synthetic hand-authored principal href boundary cases from C08/C14/C16; privacy reviewed: pass for every named case.
- `home-href-malformed-whitespace`, `home-href-empty`, `home-href-fragment`, `home-href-userinfo`, `home-href-dot-segment`, `home-href-backslash`, `home-href-downgrade`, `home-href-malformed-percent` — synthetic hand-authored calendar-home href boundary cases from C08/C14/C16; privacy reviewed: pass for every named case.
- `collection-href-malformed-whitespace`, `collection-href-empty`, `collection-href-fragment`, `collection-href-userinfo`, `collection-href-dot-segment`, `collection-href-backslash`, `collection-href-downgrade`, `collection-href-malformed-percent` — synthetic hand-authored collection href boundary cases from C08/C14/C16; privacy reviewed: pass for every named case.
