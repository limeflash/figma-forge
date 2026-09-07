---
description: Start the Figma Forge bridge and pair this project with an open Figma file
argument-hint: "[channel]"
allowed-tools: mcp__figma-forge__figma_forge_connect, mcp__figma-forge__figma_forge_status, mcp__figma-forge__figma_forge_design_system
---

Pair this project with Figma.

1. Call `figma_forge_connect`$ARGUMENTS.
2. If no Figma plugin is attached, show the user the exact port and channel to
   type into the plugin, then stop and wait — do not retry in a loop.
3. Once connected, report the file name and whether a design-system index is
   cached. If none is cached, offer to run `/figma-forge:index`.

Keep the output to a few lines. This is a setup step, not a report.
