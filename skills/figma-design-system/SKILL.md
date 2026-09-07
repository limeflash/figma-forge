---
name: figma-design-system
description: Find and resolve Figma design-system assets — components, variants, styles, and variables — before writing anything to a file. Use when building or modifying Figma content, when the user mentions their design system or tokens, or when you need a component key, legal variant values, or a variable to bind.
---

# Working with the design system

The rule this plugin exists to enforce: **resolve before you write.** A plan
built from a guess about what components exist produces a screen that looks
plausible and is made of hardcoded rectangles. That is the failure this whole
system is designed to prevent.

## Identity is a key, never a name

Every component, style and variable has a Figma key. Names collide, get renamed,
and differ between the library and the file consuming it. When you report a
component to the user, report the name; when you put one in a plan, use the key.

## The three-step loop

**1. Orient** — `figma_forge_design_system { action: "overview" }`

What this design system actually contains: component sets, style counts,
variable collections and their modes. Do this once per file, not per request.
Note the mode names — a system with `Light`/`Dark` modes means colour variables
carry both, and binding a variable is what makes theming work.

**2. Search** — `action: "search", query: "primary button"`

Search by intent, in the user's words. Results are ranked with exact keys first,
and components the file already uses are boosted — an identically named
component nobody has ever placed is usually the wrong one.

Filter when you know the shape of the answer:

```
{ action: "search", query: "surface background", kinds: ["variable"], variableType: "COLOR" }
```

**3. Resolve** — `action: "resolve", key: "<component key>"`

This is the step people skip. It returns the exact property names, their legal
values, and every variant in the set. Passing a variant value that is not in
`variantOptions` fails the write, and guessing `"Primary"` when the system says
`"primary"` is a real and common failure.

Read the `propertyDefinitions` carefully:

- `VARIANT` properties must be one of `variantOptions`, exactly.
- `TEXT`, `BOOLEAN`, `INSTANCE_SWAP` properties are addressed by name; Figma
  stores them internally as `Label#1:0`, but Figma Forge accepts the bare name
  and normalises it.
- A property absent from the definitions does not exist. Do not invent one.

## Variables and tokens

`action: "variables"` lists local collections, their modes, and each variable's
values per mode.

Two things to know:

- **Library variables are invisible to a local scan.** They appear under
  `libraryCollections`, and they are not usable in the file until imported:
  `{ action: "import", variableKey }`. A `bind_variable` op with a `variableKey`
  imports it for you.
- **Instances inherit tokens from their main component.** An instance with no
  local binding is not necessarily unbound — it may be inheriting correctly.
  Check the main component before "fixing" it.

## When the design system does not have it

Say so plainly and give the user the choice. The options, in order of
preference:

1. A different component that fits the role (show what you found).
2. Composing existing components.
3. A raw primitive — which requires a written `reason` on the op, because the
   write layer rejects unjustified primitives.

Do not silently reach for option 3. The whole point of the gate is that
reaching for it is a decision someone made on purpose.

## Index freshness

The index is cached on disk per file, and writes mark touched nodes dirty. It
does **not** auto-rebuild — a full scan is the expensive operation in this
system. Refresh explicitly when:

- someone published library changes
- the user switched files
- you created components in this session
- `figma_forge_status` reports a large dirty count

`{ action: "refresh" }` rebuilds it; `{ action: "refresh", scope: "page" }`
limits the component scan to one page on very large files.

## Honest limits

The Figma Plugin API cannot enumerate a team library's components. The index
covers local components plus remote components the file already uses. If the
user expects a component that has never been placed in this file, it will not
appear — ask them to place one instance, or give you its key.
