# Community-node eligibility checklist

Status recorded **2026-09-20** for `@iljailjic/n8n-nodes-caldav` `1.0.0-beta.1`.
This is a repository readiness record, not an n8n approval or Creator Portal
submission. Re-run the external and release-time checks when publishing a new
version.

## Baseline and official guidance

- Fixed compatibility baseline: n8n `2.39.8` with Node.js `24`, or the
  official n8n `2.39.8` image.
- Package engine declaration: Node.js `>=22 <25`; Node.js `22` and `24` are the
  supported CI lanes. The Node.js 24 lane is the baseline above.
- Compatibility intent: stable n8n 2.x. A later stable n8n release must be
  validated at release time before it is described as supported; this checklist
  does not claim that validation has occurred.
- Current official installation guidance: [Installation and
  management](https://docs.n8n.io/integrations/community-nodes/installation-and-management/).
  n8n documents npm community-node installation for self-hosted instances;
  unverified community nodes are not available on n8n Cloud.
- Current official node-development entry point: [Building community
  nodes](https://docs.n8n.io/integrations/community-nodes/building-community-nodes/).

## Repository-verifiable prerequisites

These checks can be established from this repository and its local validation
commands. Static metadata prerequisites are met; candidate-build and clean-host
checks remain release gates:

| Requirement                                    | Evidence in this repository                                                                                                                                         | Status                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Community package identity and discoverability | `package.json` name, description, homepage, repository, author, and `n8n-community-node-package` keyword                                                            | Met                   |
| Supported runtime declaration                  | `package.json` engines: `>=22 <25`                                                                                                                                  | Met                   |
| Strict n8n package metadata                    | `package.json` sets `n8n.strict` and `n8n.n8nNodesApiVersion`                                                                                                       | Met                   |
| Node and credential registration               | `package.json` registers the built node and credential entry points; `scripts/verify-package-contents.mjs` checks the paths                                         | Met                   |
| Public licensing and package scope             | MIT license, public publish configuration, and `files: ["dist"]`                                                                                                    | Met                   |
| Package contents                               | `npm run verify:package` checks the exact allowlisted manifest, including the expected `.js.map` files; it rejects missing, unexpected, duplicate, or bundled paths | Candidate-build check |
| Node/credential icons and UI metadata          | Registered node assets and node metadata are present under `nodes/CalDav/`; package verification covers the packed paths                                            | Met                   |
| Documentation and sanitized examples           | `README.md`, `docs/CONTRACT.md`, and `docs/WORKFLOW-EXAMPLES.md` document installation, credentials, operations, and privacy boundaries                             | Met                   |
| Quality gates                                  | `npm exec -- prettier --check .`, `npm run lint`, `npm test --if-present`, `npm run build`, and `npm run verify:package`                                            | Candidate-build check |

The repository has no claim that an n8n Creator Portal submission, verified-node
listing, or external security scanner has passed.

The current release-blocking gaps are the clean-host tarball install/load smoke
test and validation against the then-current stable n8n release. They are kept
separate from static repository evidence below.

## Pre-publication checks

Before publishing or submitting a candidate:

1. Run the repository quality suite and confirm the Node.js 22 and Node.js 24
   CI lanes are green.
2. Build the package and inspect `npm pack --dry-run` output. Confirm that the
   archive matches the exact allowlisted manifest, including only the expected
   built node, credential, metadata, and `.js.map` artifacts. The verifier does
   not inspect map contents or prove that an archive contains no secrets.
3. Install the resulting tarball into a clean, supported self-hosted n8n
   `2.39.8` / Node.js `24` environment. Confirm that the CalDAV node and
   credential load, operations and properties are discoverable, and the
   documented Community Nodes GUI flow works.
4. Repeat the smoke check against the then-current stable n8n release if it is
   newer than `2.39.8`. Record the exact n8n and Node.js versions; do not widen
   the compatibility claim until that run passes.
5. Separately review the packed archive, source-map contents, and generated
   logs for credentials, private calendar content, private filesystem paths,
   and unintended artifacts. This manual privacy review is distinct from the
   allowlisted-manifest verifier.
6. If submitting for n8n verification, publish the exact package through a
   GitHub Actions workflow with npm provenance, as required by the current
   [community-node building guidance](https://docs.n8n.io/integrations/community-nodes/building-community-nodes/).

The clean-host archive install/load check is a release-blocking prerequisite.
The local package verifier proves manifest/content constraints but is not, by
itself, proof that a clean n8n process loaded the tarball.

## Post-publication and external gates

These gates are outside the repository's local proof and must remain explicitly
unclaimed until their evidence exists:

- npm publication and registry install from the exact published version;
- n8n Creator Portal submission, review, and verified-community-node listing;
- any n8n-hosted or third-party security scanner, malware scan, or vulnerability
  report;
- confirmation that the published version is available through the n8n
  Community Nodes UI and remains installable on supported self-hosted n8n
  versions.

Record the date, package version, n8n version, Node.js version, archive
checksum, and the external result for each completed gate. A missing result is
unresolved; it is not a pass.

## Installation UX for users

This package is an unverified community node until an official n8n listing says
otherwise. Users must self-host n8n. In the n8n editor, use **Settings >
Community Nodes > Install**, enter `@iljailjic/n8n-nodes-caldav`, and confirm.
If the instance does not expose the GUI, follow n8n's [manual installation
instructions](https://docs.n8n.io/integrations/community-nodes/installation-and-management/manual-installation/)
or its [environment-variable installation
instructions](https://docs.n8n.io/integrations/community-nodes/installation-and-management/environment-variable-installation/).
Restart n8n as required by the selected installation method, then create the
CalDAV credential and add the CalDAV node to a workflow.
