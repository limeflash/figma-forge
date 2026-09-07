---
description: Build or refresh the design-system index for the paired Figma file
argument-hint: "[--page]"
allowed-tools: mcp__figma-forge__figma_forge_design_system, mcp__figma-forge__figma_forge_status
---

Rebuild the design-system index.

Call `figma_forge_design_system` with `action: "refresh"`. Pass
`scope: "page"` if the user asked to limit it to the current page ($ARGUMENTS).

A full scan on a large file takes a while — say so before starting rather than
going quiet.

Then report what the design system actually contains: component sets, styles,
variable collections and their modes, and any warnings the index returned.
Warnings about truncated scans or unreadable libraries matter; do not drop them.
