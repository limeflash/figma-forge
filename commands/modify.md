---
description: Plan and apply a bulk modification to existing Figma content
argument-hint: "<what to change>"
---

Modify: $ARGUMENTS

In-place edits are riskier than new builds — node ids and external references
have to survive — so the emphasis is on identifying the right nodes, not on
building fast.

1. **Find the targets by identity, not by name.** Use `figma_forge_inspect`
   with a selector, then confirm each instance's main component key. Two
   components can share a name; only the key tells you which one you have.
2. **Show the user the affected set before touching it.** Count, node ids, and
   anything you deliberately excluded.
3. **Prefer the smallest change.** Same component set → `set_component_properties`.
   Different component → `swap_instance`, which preserves overrides where it can.
   Never approximate by deleting an instance and drawing a shape.
4. **Dry run, then apply in place.** Do not use `scratch` for edits to existing
   content: cloning would break the ids other things point at.
5. **Report what you could not map.** Leave those nodes untouched and list them.
   A partial, honest migration beats a complete, silent one.

If verification fails after the write, the operation is journalled — offer
`/figma-forge:recover` rather than trying to patch it by hand.
