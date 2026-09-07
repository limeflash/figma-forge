---
description: Show bridge, plugin, file and recent write state
allowed-tools: mcp__figma-forge__figma_forge_status
---

Call `figma_forge_status` and summarise:

- whether the bridge is up and which channel this project uses
- whether a Figma plugin is attached, and to which file
- how fresh the design-system index is
- the last few write operations and whether any failed

If a recent operation failed, say so first and mention `/figma-forge:recover`.
