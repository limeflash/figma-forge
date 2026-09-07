---
description: Find design-system components, styles and variables by intent
argument-hint: "<what you need, e.g. primary button>"
allowed-tools: mcp__figma-forge__figma_forge_design_system
---

Search the design system for: $ARGUMENTS

1. `figma_forge_design_system` with `action: "search"`.
2. For the best candidate, follow up with `action: "resolve"` so the user sees
   the exact property names and legal variant values.
3. Report the component key alongside the name — the key is what a write plan
   needs, and names are not unique.

If nothing matches, run `action: "overview"` and say what does exist rather than
guessing at a component that may not be there.
