---
name: figma-build
description: Build new screens, components and layouts in Figma from design-system components using write plans. Use when asked to create, generate, design or lay out anything in a Figma file — a screen, a page, a flow, a component, or a section of UI.
---

# Building in Figma

Writes go through `figma_forge_apply_plan`. A plan is an ordered list of ops
applied under a journal, so a failure rolls back instead of leaving half a
screen behind.

## The order that works

1. **Resolve everything first.** Every UI role in the brief → a concrete
   component key and legal property values. See `figma-design-system`.
2. **Write the plan.** All ops, with `$ref` names threading created nodes into
   later ops.
3. **Dry run.** `dryRun: true` validates references, imports components, and
   checks property legality without mutating anything. Fix what it rejects.
4. **Build on scratch.** `scratch: true` for new content, so a wrong result
   never lands on the user's page.
5. **Verify, then place.** Verification runs automatically after a real write.
   Move the finished root into the target page once it passes.

Skipping the dry run on anything with more than a few ops wastes more time than
it saves.

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
