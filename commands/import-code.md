---
description: Import design tokens from CSS or Tailwind into Figma variables, or map Storybook components
argument-hint: "<path to tokens.css, tailwind.config.js, or index.json>"
allowed-tools: mcp__figma-forge__figma_forge_import_code, mcp__figma-forge__figma_forge_design_system, mcp__figma-forge__figma_forge_status
---

Import from: $ARGUMENTS

1. **Work out the source** from the path: a `.css` file is `css` (or `tailwind`
   if it has an `@theme` layer), `tailwind.config.*` is `tailwind`, and
   `index.json` / `stories.json` is `storybook`. If the path is ambiguous or
   missing, ask rather than guessing.
2. **Preview.** Run `action: "preview"` and show the user what would be created:
   collections, modes, counts by type, and — importantly — anything in the
   `unsupported` list.
3. **Confirm before writing.** This creates variables in their real file. Show
   the collection name and mode names you are about to use.
4. **Apply**, then report created / updated / unchanged / conflicts.

Conflicts are the interesting part. A hand-authored variable with the same name
is not overwritten; surface it and ask whether to adopt it (`takeOwnership`)
rather than deciding for them.

For Storybook, use `action: "map"` — it needs a design-system index, so refresh
one first if `figma_forge_status` says none is cached.
