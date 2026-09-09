---
name: figma-search
description: Find screens in a large Figma file by meaning or by word, using the screen graph — what a screen contains and what it is built from, rather than its name. Use when asked to find, locate or list screens, when a file is too large to browse, or when node names are uninformative.
---

# Finding things in a large file

Node names do not survive real files. Measured on one: a single page held 21
screens, seven of them named "other profile", plus "other" and "Header". Looking
for a screen by name is hopeless at that point.

The graph indexes each **screen** — a frame sitting on a page or in a section —
by three things that actually carry meaning:

- the text inside it
- the design-system components it is built from
- where it lives (page and section names, which humans did write carefully)

## Build once

```
figma_forge_graph { action: "build" }
```

It walks the file page by page. Measured on a 65-page file with 1473 screens:
about four minutes to walk, plus a minute to embed. Most of that is Figma
loading each page, not our traversal, so it does not get much faster. Say so
before starting rather than going quiet.

Rebuild after significant changes; the graph does not update itself.

If Ollama is available, build also embeds every screen, which is what makes
searching by meaning work. If it is not, the build still succeeds and search
falls back to words — the result says which happened, so pass that on rather
than implying full search is available.

## Search

```
figma_forge_graph { action: "search", query: "экран оплаты картой" }
```

Word search and semantic search run together and are fused by rank. Each result
says which half found it, under `why`:

- `word: #2` — matched literally. Trustworthy for exact names and component names.
- `meaning: #1 (0.712)` — matched semantically. This is what finds an English
  screen from a Russian query, or "checkout" from "оплата".

A result found by meaning alone with a low score is a guess. Say so rather than
presenting it as the answer.

## The other two actions

`{ action: "screen", nodeId }` — one screen plus the screens built from the most
of the same components. That is usually what "show me similar screens" means: a
variant, a state, or the same layout reused.

`{ action: "component", componentKey }` — every screen using a component. This is
the question to ask before changing a shared component, and it is exact, not
ranked.

## Honest limits

- The graph is a snapshot. A screen added after the build will not be found, and
  a deleted one still appears. `{ action: "status" }` reports when it was built.
- Only screens are indexed, not every node. A deeply nested element is
  represented by the screen containing it, not on its own.
- Text is capped per screen, so a very long screen is indexed by its beginning.
- Semantic search needs Ollama running locally with an embedding model. It is
  optional — see `/figma-forge:setup`.

## After finding something

Report the path, not just the name — `Page / Section / Screen` is what lets
someone actually locate it. Then offer to open it: `figma_forge_inspect
{ scope: "node", nodeId }` for detail, or focus it on the canvas.
