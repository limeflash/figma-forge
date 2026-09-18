---
description: Import finished HTML mockups (Claude Design exports, .dc.html, folders, .zip) into Figma as auto-layout screens grouped into sections
argument-hint: "<path to .html, folder or .zip> [what to import]"
allowed-tools: mcp__figma-forge__figma_forge_import_html, mcp__figma-forge__figma_forge_import_code, mcp__figma-forge__figma_forge_status, mcp__figma-forge__figma_forge_connect, mcp__figma-forge__figma_forge_inspect, mcp__figma-forge__figma_forge_recover
---

Import: $ARGUMENTS

Follow the `figma-import-html` skill.

1. **Survey.** `figma_forge_import_html { action: "survey", source }`. For a
   folder or zip, show the page list and agree with the user which pages to
   import. Skip `source` and `component` pages unless they ask for them. Then
   survey each chosen page.
2. **Tokens first.** If the survey reports a `tokens.css`, offer to import it
   with `figma_forge_import_code`, so colours bind to variables.
3. **Propose the structure** from the survey's `proposal`: sections (flows or
   groups of states), rows (one state each, with its caption) and screen names.
   Show it as a short outline and let the user rename, regroup or drop items
   before anything is written.
4. **Interactive states.** If the page is a prototype, use the reported
   clickables to add `steps` for each state the user wants. Survey with those
   steps when unsure what a state looks like.
5. **Mobile.** For device mocks, use `innerPage` with the device width, or the
   `inner` selector.
6. **Dry run** anything larger than a handful of screens, and report the
   warnings.
7. **Build.** Check `figma_forge_status` first. If Figma is not attached, tell
   the user how to open the plugin, then stop. After the build, show the
   section screenshots and links, name any missing fonts and rasterized parts,
   and give the `operationId` for undo.

Ask before writing into an existing page the user did not name.
