---
description: Design a screen as a reviewable preview first, then transfer it into Figma
argument-hint: "<what to design>"
---

Design: $ARGUMENTS

Design happens against a preview, not against Figma. Iterating directly in the
file is slow and blind — every change costs a write and a screenshot — and a
wrong result lands in the user's document. So draft, render, agree, then apply.

**The plan is the only source of truth.** The preview renders it, and
`figma_forge_apply_plan` applies the same plan unchanged. Never build an HTML
mockup and try to convert it: that produces detached rectangles where component
instances belong, which defeats the entire point of this plugin.

## 1. Find the precedent

Nothing here is designed from nothing. Find how this product already solves
adjacent problems:

- `figma_forge_graph { action: "search" }` for screens of the same kind.
- `figma_forge_inspect { scope: "node", detail: "full" }` on the closest one, to
  read its real structure: spacing rhythm, corner radii, which variables its
  colours are bound to, which components it is assembled from.

Report what you found before drafting. If the pattern already exists, say so —
the right answer is often "clone this and change three things".

## 2. Resolve

Every element in the brief maps to a component key and legal variant values via
`figma_forge_design_system { action: "resolve" }`. Do not draft against
remembered component names.

## 3. Draft the plan

Prefer, in order:

1. `create_instance` of a resolved component.
2. `clone` of an existing, correctly built node — this inherits variable
   bindings and typography exactly, which recreating by hand does not.
3. `create_frame` for structure only, with a `reason`.

## 4. Write the copy

Every text on the screen. This is the step that decides whether the result is a
design or an arrangement of borrowed parts.

Cloning gives you correct typography and variable bindings — it does not give
you correct words. A cloned title still says what the screen you copied it from
said, and a component instance still says "Button". Left alone, the result looks
finished and means nothing, and no verification rule will tell you.

Check every borrowed element for whether it *belongs* here, not just whether it
renders: an illustration lifted from another screen usually depicts that screen's
subject.

## 5. Preview on the canvas

`figma_forge_preview { title, ops }` builds the plan on the Figma Forge scratch
page and returns a screenshot.

There is no approximation to allow for: it is made of the same instances, auto
layout and bound variables the final screen will have. The user can zoom and
inspect it in Figma directly.

Iterate with another `build` — the previous preview is rolled back first, so
nothing accumulates.

## 6. Transfer

Only after the user agrees, `figma_forge_preview { action: "commit" }` moves the
reviewed nodes to where the plan aimed. Nothing is rebuilt and the ids are the
ones already reviewed.

`{ action: "discard" }` rolls the preview back instead.

## Finishing the job

Set the text on every instance you create. A component's default label
("Button", "Label") shipping into the file is not a design — verification will
not catch it, because it is not a system violation, just unfinished work.
