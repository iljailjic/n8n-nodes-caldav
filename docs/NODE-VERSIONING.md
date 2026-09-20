# CalDAV node versioning policy

This policy governs changes to the workflow-facing CalDAV node. It is
deliberately narrower than package release versioning: a package beta or
pre-1.0 checkpoint does not reset the saved-workflow compatibility baseline.
The baseline is the shipped n8n node version `1` (`typeVersion: 1`) and the
contract described in [CONTRACT.md](CONTRACT.md).

## v1 change rule

Keep a change in v1 only when it is additive and an imported v1 workflow keeps
the same behavior when the new input is omitted. In particular, preserve:

- parameter defaults, omission semantics, and display visibility;
- accepted identifier and input modes;
- validation and Continue on Fail error behavior; and
- output field presence, types, meanings, and item pairing.

An optional field or operation can be added only if it is unreachable from an
existing v1 export unless explicitly configured. Do not use a new default to
silently alter an existing workflow.

## Breaking changes

Treat a changed default, omission, visibility condition, identifier meaning,
validation/error branch, or output contract as breaking. Add a light node
version (for example `1.1`) and gate the runtime behavior by the saved node
version:

```ts
const version = this.getNode().typeVersion;
if (version >= 1.1) {
	// New behavior for nodes explicitly saved at the newer light version.
} else {
	// Preserve v1 behavior for imported and existing workflows.
}
```

Do not silently migrate `typeVersion: 1` nodes to the new behavior. Update the
workflow-facing contract and add a fixture that proves both version branches.

## Full versioning boundary

Do not introduce `VersionedNodeType` full versioning for the initial v1 node.
This node should use light versioning for an incremental breaking change. Full
versioning is appropriate only for a separately justified rewrite with
materially different resources or operations, or for a node that already uses
full versioning; it is not a compatibility mechanism to add pre-emptively.

## Validation baseline

The initial validation host is n8n `2.39.8` on Node.js `24`, or the official
n8n `2.39.8` image. The sanitized v1 workflow matrix and focused test navigate
the operations, modes, omissions, locators, outputs, and errors that define
this baseline:

- [saved workflow fixture](../test/unit/fixtures/workflows/issue-61-v1-saved-workflows.json)
- [compatibility test](../test/unit/issue-61-v1-workflow-compatibility.test.ts)
