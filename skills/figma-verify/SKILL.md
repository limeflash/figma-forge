---
name: figma-verify
description: Check Figma content against design-system and structural invariants, interpret the violations, and recover from a failed write. Use after building or modifying anything in Figma, when the user asks whether a design is correct or on-system, or when a write failed and needs rolling back.
---

# Verification and recovery

## Verifying

`figma_forge_verify` runs invariants over a node, page, selection, or everything
a past operation touched (`scope: "operation"`, which is what runs automatically
after a write).

### What the rules mean

**Errors — the design will actually misbehave**

| Rule | What it means | Fix |
|---|---|---|
| `hardcoded-fill` | A raw colour with no variable or style behind it | `bind_paint_variable`, or `apply_style { kind: "fill" }` |
| `hardcoded-stroke` | Same, for strokes | As above |
| `detached-instance` | An instance lost its main component | Re-instantiate from the component; the overrides are not recoverable |
| `missing-font` | A font this file does not have | The user must install or replace it — you cannot fix this from here |
| `broken-style` / `broken-variable` | A reference that no longer resolves | Rebind, or re-import the library asset |
| `zero-size` | Effectively invisible | Usually a sizing mode set before the node had a layout context |
| `invalid-component-property` | A variant with no value | Set every variant property explicitly |

**Warnings — worth a look, not always wrong**

| Rule | Common legitimate reason |
|---|---|
| `unbound-spacing` | A genuinely one-off gap |
| `missing-autolayout` | An intentionally free-form canvas or illustration |
| `hardcoded-text-style` | A one-off label the system does not cover |
| `sibling-overlap` | An overlay or badge — set `layoutPositioning: "ABSOLUTE"` to say so on purpose |
| `off-canvas` | Content parked deliberately outside a frame |

Judge warnings in context. Reporting all of them as problems is as unhelpful as
reporting none.

### Reporting

Errors first, grouped by rule, with node ids. Warnings summarised by count
unless asked for detail. Then one line on what is clean.

For every error, say what the fix is in Figma Forge terms — bind a variable,
apply a style, swap a component — not just that something is wrong.

Verification is a report. Do not fix things unless asked.

## Recovering

Every real write is journalled to disk with the inverse of each mutation, under
CLAUDE_PLUGIN_DATA. The journal outlives both the MCP process and the Figma tab,
which is the point: it exists to still be there after something went wrong.

- `figma_forge_recover { action: "list" }` — recent operations and their status.
- `figma_forge_recover { action: "rollback" }` — reverses the most recent failed
  operation, or a named `operationId`.

### Before rolling back

Confirm with the user. Time has passed and they may have made their own edits;
replaying inverses over those is its own kind of damage.

### After rolling back

Read the result honestly. Recovery is partial-tolerant by design:

- `applied` — reversed cleanly.
- `skipped` — the node is gone, or there was nothing restorable. Usually fine.
- `failed` — **the change is still there.** Name those node ids. Do not describe
  a partial rollback as a success.

## What rollback cannot do

Figma has no transaction primitive. The journal is a good simulation, not a
guarantee:

- `figma_forge_execute` in `unsafe_in_place` mode is not journalled at all.
- Changes made by the user or another plugin after the write are not journalled
  and may be clobbered by an inverse.
- Component swaps can lose overrides on the way out and cannot restore them on
  the way back.

Figma's own undo is one boundary per commit, but it is a user-facing stack we do
not own — a later manual edit makes it ambiguous. The journal is authoritative.
