---
name: figma-import
description: Import design tokens from code into Figma variables (CSS custom properties, Tailwind), and map Storybook components onto Figma components. Use when the user wants their code tokens in Figma, mentions Tailwind/CSS variables/Storybook as a source of truth, or asks to sync code and design.
---

# Importing from code

Two directions, and they are not symmetric.

**Tokens import cleanly.** A CSS custom property or a Tailwind theme value has a
direct Figma equivalent: a variable, in a collection, with modes for themes.

**Components do not.** Figma Forge deliberately does not convert React into
Figma components — the output is neither visually faithful nor editable, and it
rots the moment either side changes. Storybook import produces a *mapping*
instead: which of your stories already have a Figma component, and which do not.

## Always preview first

```
figma_forge_import_code { source: "css", path: "src/styles/tokens.css", action: "preview" }
```

Preview parses the file and shows what would be created without touching Figma
or even needing a connection. Read the `unsupported` list — box shadows, font
stacks and gradients have no single-value variable equivalent, and you should
tell the user what is being left behind rather than let them discover it later.

Then apply:

```
{ source: "css", path: "src/styles/tokens.css", action: "apply", dryRun: true }
```

`dryRun` on apply shows the create/update/conflict split against the real file.

## What each source reads

**`css`** — custom properties from `:root`, `html`, `@theme`, and dark-mode
blocks. Dark mode is detected from `.dark`, `[data-theme="dark"]`,
`[data-mode="dark"]` and `@media (prefers-color-scheme: dark)`; each becomes a
Figma mode. Component-scoped properties are skipped unless you pass
`includeAllSelectors`, because a `--local-gap` inside one component is not a
design token.

`var(--other-token)` references are preserved as Figma variable **aliases**, not
flattened. That is the point — flattening would destroy the semantic layer that
makes the token system worth importing.

**`tailwind`** — v4 and v3 need different files:

- v4: point at the stylesheet with the `@theme` layer. Colours are `oklch()` and
  are gamut-mapped to sRGB the way a browser does.
- v3: point at `tailwind.config.js`. The config is *executed* to read its theme,
  so it must import cleanly from its own directory. A config that only sets
  `content` has no theme of its own — the default palette lives inside Tailwind,
  not the file, and you will get an empty import with a warning saying so.

**`storybook`** — point at the generated `index.json` (or older
`stories.json`), not `main.js` or a story file. Story names come back as
*variant candidates*. They are a hint, not a fact: confirm against the real
component with `design_system { action: "resolve" }` before treating a story
name as a legal property value.

## Ownership and re-import

Every imported variable is stamped with the source it came from. This makes
re-import safe and useful:

- Unchanged tokens are skipped (`unchanged` in the result).
- Changed tokens update in place, keeping their Figma id and every binding.
- A variable someone authored by hand is **never** overwritten. It comes back as
  a conflict, and adopting it requires `takeOwnership: true` — a decision the
  user should make, not you.
- A type change (a token that was a colour and is now a number) is reported as a
  conflict, because Figma cannot change a variable's type. The old variable has
  to be removed by hand.

## Reporting

Lead with the numbers — created, updated, unchanged, conflicts — then:

- **Conflicts** by name and reason. These are the ones needing a human.
- **Alias failures**, which almost always mean the referenced token lives in a
  file that was not part of this import. Name the file to import next.
- **Unsupported values**, so nobody assumes their shadows made it across.

Do not describe an import with conflicts as complete.

## What this does not do

- It does not publish. Imported variables land in the file; publishing to a
  library stays a deliberate human action.
- It does not write back to code. This is one-directional.
- It does not reconcile a token that exists in both places with different values
  — it reports the conflict and stops.
