---
description: Run design-system and structural invariants over a page, node or selection
argument-hint: "[page|selection|<nodeId>]"
allowed-tools: mcp__figma-forge__figma_forge_verify, mcp__figma-forge__figma_forge_inspect
---

Verify: $ARGUMENTS (default: the current selection)

Call `figma_forge_verify` with the right scope. Then report:

- errors first, grouped by rule, with node ids
- warnings second, summarised by count unless the user asked for detail
- what is clean, in one line

For each error, say what the fix would be in Figma Forge terms — bind a
variable, apply a style, swap a component — not just what is wrong.

Do not fix anything unless the user asks. Verification is a report.
