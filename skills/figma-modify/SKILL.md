---
name: figma-modify
description: Change existing Figma content in place — swap components, update variants, rebind tokens, restructure layout, run bulk migrations. Use when asked to update, replace, restyle, migrate or fix something that already exists in a Figma file.
---

# Modifying existing content

Editing existing content is riskier than building new content, because node ids
are referenced by prototypes, comments, dev-mode links and other people's work.
The priorities are different: identify precisely, change minimally, preserve ids.

## Never build modifications on scratch

`scratch: true` is for new content. For edits, commit in place — cloning a
subtree and swapping it in would give every node a new id and break everything
pointing at the old ones.

## Find targets by identity

Names lie. Two component sets can both be called "Button"; a renamed instance
still points at its original main component.

1. Narrow structurally with a selector:
   `figma_forge_inspect { scope: "query", nodeId: "<screen>", selector: "INSTANCE" }`
2. Confirm each candidate's `component.key` from the inspection output.
3. Match on the key, not the name.

Show the user the affected set — count, ids, and anything you deliberately
excluded — before touching anything.

## Choose the smallest change

| Situation | Op | Why |
|---|---|---|
| Same component set, different variant | `set_component_properties` | Keeps the instance, its id, and every override |
| Different component | `swap_instance` | Preserves text and nested overrides where the shapes match |
| Wrong colour/spacing on a bound property | `bind_variable` / `bind_paint_variable` | Fixes the cause, not the symptom |
| Wrong colour on an unbound property | `apply_style` or bind a variable | Do not set a raw hex to "match" |
| Structure is wrong | `move` / `reorder` | Reparenting keeps ids |

Never delete an instance and draw a replacement. That is how a design system
quietly turns into a pile of rectangles.

## Bulk migrations

For "change all X to Y":

1. Resolve the target component and its legal variant values once.
2. Build one plan with one op per node. A single plan means a single journal and
   one rollback if it goes wrong.
3. Dry run it. On a large migration this catches the property-name mismatch that
   would otherwise fail on op #47 of 60.
4. Apply, then read the verification result.
5. **Report what you could not map.** Leave unmapped nodes untouched and list
   them. A partial migration the user can finish beats a complete one that
   approximated the last few.

## Deletes are quarantines

`remove` moves the node to a quarantine page with a breadcrumb back to its
original parent and index, and journals the inverse. Nothing is hard-deleted
during a plan.

- `figma_forge_recover { action: "restore_quarantine" }` puts them back.
- `figma_forge_recover { action: "purge_quarantine" }` clears them once the user
  is satisfied.

Tell the user where the content went rather than saying "deleted".

## Ask before

- replacing content the user did not name
- detaching instances (usually a mistake, and rarely reversible in a useful way)
- restructuring a page's top-level frames
- anything touching a published component or component set — that affects every
  file using the library, not just this one
