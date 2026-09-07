---
name: figma-runtime
description: Run raw JavaScript against the Figma Plugin API through figma_forge_execute for operations the typed write ops do not cover. Use when a task needs Plugin API calls with no typed equivalent, for complex read-only analysis across many nodes, or when a typed plan cannot express the operation.
---

# The compatibility execution lane

`figma_forge_execute` runs JavaScript inside the Figma plugin sandbox. It exists
for what the typed ops do not cover — and it should stay the exception, because
it has no journal and cannot be rolled back.

**Reach for `figma_forge_apply_plan` first.** Use this lane for analysis, for
Plugin API surfaces with no typed op, and for one-off operations the user has
explicitly asked for.

## Modes

| Mode | What it allows | When |
|---|---|---|
| `read` (default) | Inspection. `figma.create*` and friends throw; document changes are detected and reported as violations. | Analysis, measurement, auditing |
| `scratch` | Mutations, confined to the scratch page. Anything touched outside comes back as a violation. | Experiments, generated content that gets reviewed before placement |
| `unsafe_in_place` | Everything, no guard rails, no journal. | Only with the user's explicit go-ahead, for something genuinely unrepresentable otherwise |

The guards are honest, not absolute: `read` blocks the obvious ways to create
nodes, but a determined script can still assign to a node property. That is why
change detection runs alongside — always read the `violations` array in the
result. A `read` call reporting mutations means the script did something it
should not have.

## What is in scope

```
figma            the Plugin API (guarded in read mode)
target           the node named by targetId
scratch          the scratch page (scratch mode)
params           values you passed in
select(node, s)  CSS-like query → chainable QueryResult
matches(node, s) test one node
set(node, props) batch assignment with correct ordering
createAutoLayout(direction, props)
screenshot(node, opts)
summarize(node, opts)
rgbToHex(color)
loadFonts(textNode)
bridge           persistent helper modules
modules          modules loaded via `use`
console          captured into the result's logs
```

Top-level `await` works. The last expression is returned; nodes are serialised
to summaries automatically, so `return figma.currentPage.children` is safe.

## Selector syntax

`select()` and `node.query()` take a CSS-like selector:

```
FRAME                      by type
[name=Card]                exact attribute
[name*=btn] [name^=ic-]    contains, starts with, ends with ($=)
[fills.0.type=SOLID]       dot paths, with * for array wildcards
FRAME > TEXT               child
FRAME TEXT                 descendant
A + B   A ~ B              adjacent, general sibling
:not(…) :is(…) :nth-child(n) :first-child :last-child
INSTANCE, COMPONENT        union
```

`QueryResult` chains: `.first()` `.last()` `.toArray()` `.each()` `.map()`
`.filter()` `.values(keys)` `.set(props)` `.query(selector)`.

## Sandbox facts that bite

Read `references/plugin-api-notes.md` for the full list. The ones that cause
most failures:

- **No `fetch`, no DOM, no reliable timers.** Anything network-shaped has to
  happen on the Claude Code side.
- **Fonts must be loaded before any text write.** `await loadFonts(node)`, or
  `await figma.loadFontAsync(node.fontName)` on a fresh text node.
- **This file uses `documentAccess: "dynamic-page"`.** Use `getNodeByIdAsync`,
  `getMainComponentAsync`, `page.loadAsync()`. The synchronous versions throw.
- **Paint and effect arrays are immutable.** Clone, modify the copy, reassign.
- **`resize()` resets sizing modes to FIXED.** Set `layoutSizing*` after.
- **Mixed values are `figma.mixed`,** not `undefined` — compare against it
  explicitly.

## Persistent helpers

`figma_forge_modules` stores a helper inside the Figma document so it survives
restarts:

```
{ action: "define", name: "audit", source: "module.exports = { … }" }
```

Load it with `figma_forge_execute { use: ["audit"] }`, then call
`modules.audit.…`. Modules are hash-pinned: a module whose source changed
underneath a caller fails loudly rather than running something unreviewed.

Keep them small and genuinely reusable. Do not persist one-off model-generated
code into someone's document.

## Reporting

Always surface `violations` and `logs`. A result that "worked" while reporting a
scratch-mode violation did not work — it wrote somewhere it was not supposed to,
and the user needs to know before that becomes a mystery later.
