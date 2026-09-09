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

## 4. Preview

`figma_forge_preview { title, ops }` writes an HTML file and returns its path.
Give the user the `file://` link.

Solid blocks are real exported pixels; dashed outlines are containers the plan
invents. Read the notes it returns — a missing thumbnail means a component did
not resolve, and that will fail on apply too.

Iterate here. Editing ops and re-rendering costs nothing and touches nothing.

## 5. Transfer

Only after the user agrees:

1. `figma_forge_apply_plan` with `dryRun: true`.
2. Then for real. Verification runs automatically; report violations honestly
   rather than declaring success.
3. Finish with the node ids and offer to focus the canvas.

## Finishing the job

Set the text on every instance you create. A component's default label
("Button", "Label") shipping into the file is not a design — verification will
not catch it, because it is not a system violation, just unfinished work.
