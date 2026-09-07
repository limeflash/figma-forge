---
description: Roll back or inspect a journalled Figma write
argument-hint: "[operationId]"
allowed-tools: mcp__figma-forge__figma_forge_recover, mcp__figma-forge__figma_forge_status
---

Recover: $ARGUMENTS

1. `figma_forge_recover` with `action: "list"` to show recent operations and
   their status.
2. Unless the user named one, target the most recent failed operation. Show what
   it created and modified, and ask for confirmation before rolling back — the
   user may have made their own edits since.
3. Run `action: "rollback"`.
4. Report exactly what was reversed, what was skipped, and what failed. Nodes
   that could not be reversed still hold the change; name them so a human can
   look. Do not describe a partial rollback as a success.

Deleted content is in the quarantine page, not gone — `restore_quarantine`
brings it back, `purge_quarantine` clears it once the user is satisfied.
