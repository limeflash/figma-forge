---
description: Plan and build a new screen or component from the design system
argument-hint: "<what to build>"
---

Build: $ARGUMENTS

Follow this order. Do not skip the resolve step — a plan written from memory of
what components "probably" exist is the main way this goes wrong.

1. **Connect and orient.** `figma_forge_status`. If the index is missing or the
   user changed the file, refresh it.
2. **Resolve.** Search the design system for every UI role in the brief
   (container, field, button, text style, spacing and colour tokens). Resolve
   each winner to a concrete recipe: component key, variant property names and
   their legal values.
3. **Plan.** Write the `ops` list. Every visual element should be a
   `create_instance` of a resolved component. If some element genuinely has no
   component, that op needs a `reason` explaining why — expect to justify it.
4. **Dry run.** `figma_forge_apply_plan` with `dryRun: true`. Fix whatever it
   rejects. Invalid variant values and unresolvable parents both surface here.
5. **Build.** Re-run with `scratch: true` for a new screen, so a bad result
   never lands on the user's page. Apply for real only after verification passes.
6. **Verify and report.** The apply step verifies automatically; surface any
   violations honestly rather than reporting success. Finish with the node ids
   and offer to focus the canvas on them.

Ask before doing anything destructive: replacing existing content, removing
nodes, or writing into a page the user did not name.
