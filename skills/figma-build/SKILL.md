---
name: figma-build
description: Build new screens, components and layouts in Figma from design-system components using write plans. Use when asked to create, generate, design or lay out anything in a Figma file — a screen, a page, a flow, a component, or a section of UI.
---

# Building in Figma

Writes go through `figma_forge_apply_plan`. A plan is an ordered list of ops
applied under a journal, so a failure rolls back instead of leaving half a
screen behind.

## The order that works

1. **Find the precedent.** Search the screen graph for how this product already
   solves the adjacent problem, and inspect the closest screen at
   `detail: "full"`. Its spacing rhythm, radii and variable bindings are the
   specification.
2. **Resolve everything.** Every UI role in the brief → a concrete component key
   and legal property values. See `figma-design-system`.
3. **Write the plan.** All ops, with `$ref` names threading created nodes into
   later ops.
4. **Preview it.** `figma_forge_preview { title, ops }` renders the plan to HTML
   with real component images. Iterating there costs nothing and touches
   nothing; iterating in Figma costs a write and a screenshot each time.
5. **Dry run.** `dryRun: true` validates references, resolves components, and
   checks property legality without mutating. Fix what it rejects.
6. **Build.** `scratch: true` for new content when it should not land on the
   user's page until reviewed.
7. **Verify.** Verification runs automatically after a real write. Report what
   it found.

Skipping the dry run on anything with more than a few ops wastes more time than
it saves.

**Prefer cloning over recreating.** A `clone` of an existing, correctly built
node inherits its variable bindings, text styles and font settings exactly.
Rebuilding the same thing from `create_frame` and `create_text` reproduces it by
eye, and the difference shows up later as a colour that does not follow the
theme.

## Plan shape

```json
{
  "description": "Settings page — account section",
  "scratch": true,
  "ops": [
    { "op": "create_frame", "parent": "@scratch", "ref": "root", "name": "Settings",
      "autoLayout": "VERTICAL", "reason": "page container; the DS has no page-level component",
      "set": { "paddingTop": 32, "paddingLeft": 24, "paddingRight": 24, "itemSpacing": 16,
               "counterAxisSizingMode": "FIXED", "width": 720 } },

    { "op": "create_instance", "parent": "$root", "ref": "title",
      "componentKey": "5f1c…", "properties": { "Size": "L", "Label": "Account" } },

    { "op": "create_instance", "parent": "$root", "componentKey": "9ab2…",
      "properties": { "Variant": "Primary", "Label": "Save changes" } },

    { "op": "bind_variable", "node": "$root", "field": "itemSpacing",
      "variableKey": "spacing-md-key" }
  ]
}
```

### Node references

| Form | Means |
|---|---|
| `"1:23"` | a node id |
| `"$root"` | a node an earlier op created with `ref: "root"` |
| `"@page"` | the current page |
| `"@scratch"` | the Figma Forge scratch page (needs `scratch: true`) |
| `"@selection"` | the single selected node |

### Ops

`create_instance` · `create_frame` · `create_text` · `create_from_svg` · `clone`
· `set` · `set_text` · `set_component_properties` · `swap_instance` ·
`bind_variable` · `bind_paint_variable` · `apply_style` · `move` · `reorder` ·
`rename` · `resize` · `remove` · `set_selection` · `scroll_into_view`

## The raw-primitive gate

`create_frame`, `create_text`, `create_from_svg` require a `reason` string. This
is not paperwork — it is the check that stops a design system from being
bypassed by accident. A good reason names what you looked for and why nothing
fit:

> "layout container only; searched 'page container', 'section', 'stack' — the DS
> has no container component"

Layout frames, spacers and structural wrappers are legitimate. A rectangle
standing in for a button is not; find the button.

Set `allowRawPrimitives: true` only when the user has explicitly said they want
primitives.

## Auto layout, in the order Figma requires

Property order matters, and getting it wrong produces silently wrong geometry.
Figma Forge's `set` already applies layout keys first and sizing keys last, but
when writing ops by hand:

1. `layoutMode` before anything that depends on it.
2. `primaryAxisSizingMode` / `counterAxisSizingMode` — `AUTO` hugs, `FIXED` holds.
3. Padding, `itemSpacing`, alignment.
4. `layoutSizingHorizontal: "FILL"` on a **child**, and only when its parent has
   auto layout. Otherwise Figma rejects it.

`resize()` resets sizing modes to `FIXED`. If you resize and then want hugging
back, set the sizing mode after — which `set` does for you when both are in the
same op.

## Text

Text is the most common source of thrown writes. Fonts must be loaded before
characters can be set — Figma Forge handles this for `create_text`, `set_text`
and any `set` touching `characters`/`fontName`/`fontSize`. If you set text
through `figma_forge_execute` instead, call `loadFonts(node)` yourself first.

Prefer `apply_style { kind: "text" }` over setting `fontSize` and `fontName`
directly: a text style keeps the type scale intact and survives theme changes.

## Finishing

Report node ids, and offer to focus the canvas on the result. If verification
returned violations, lead with them — a screen with eight hardcoded colours is
not a finished screen, and the user would rather hear it now.

## Finishing

Set the text on every instance you create. A component ships with a placeholder
label — "Button", "Label", "Title" — and leaving it is the most visible way to
deliver something unfinished. Verification will not catch it: an unset label is
not a design-system violation, just work that was not done.
