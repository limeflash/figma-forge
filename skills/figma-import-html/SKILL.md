---
name: figma-import-html
description: Import finished HTML mockups into Figma as editable, auto-layout screens grouped into sections with captions — Claude Design exports, .dc.html sources, handoff folders and .zip project archives, or any HTML page. Use when the user hands over HTML, a Claude Design archive or handoff, or asks to move ready mockups, flows or states into Figma.
---

# Importing HTML mockups

`figma_forge_import_html` renders pages in a local headless Chromium and turns
what the browser shows into Figma layers: frames with auto layout, text with
real fonts and styled runs, vectors, images. It is for mockups that are already
designed. A new design still goes through `/figma-forge:design`, where the plan
is the source of truth.

Nothing is guessed from markup. Offline Claude Design exports unpack themselves
at runtime and `.dc.html` sources are rendered by React, so the browser is the
only faithful reader. States reached by clicking through a prototype are
imported too.

## What the user can hand over

| Input | What it is | Notes |
|---|---|---|
| `X (офлайн).html` | Claude Design offline export | Self-contained. Best source. |
| `X.dc.html` | Claude Design source | Needs its folder (`support.js`, `components/`) and network for React. |
| `*-src.dc.html`, `bake-*`, `export-*` | Build inputs for an export | Listed with role `source`; prefer the exported file. |
| Small `.dc.html` with `$preview` | One component | Role `component`. |
| Folder / `.zip` | Project archive or handoff | Unpacked and listed; `tokens.css` and a README are reported. |

If a handoff has `tokens.css`, import it first with `figma_forge_import_code`.
Imported colours then bind to those variables instead of landing as hex.

## 1. Survey

```
figma_forge_import_html { action: "survey", source: "~/Downloads/handoff.zip" }
```

For a folder or zip, the first call lists every page with a kind and a role.
Pick pages with the user; survey each one you mean to import with `page`.

A survey returns:

- **screens**: every artboard found (`s1`, `s2`, …) with a selector, its label
  ("Мобайл · 390"), its row, and its first words. The annotated screenshots show
  the same ids as red boxes. Check them — a board sometimes splits one state
  into two cards, or merges two.
- **rows / sections**: captions and headings around the screens. On Claude
  Design boards these are the state codes and explanations ("1b · Промокод: нет
  такого — инлайн под полем…").
- **clickables**: what a prototype can be driven by, with `css:` targets.
  `fixed: true` marks page chrome such as a desktop/mobile switcher.
- **inner / innerPage**: the page inside a device mock. See below.
- **proposal**: a complete `sections` array for `build`. Start from it.

## 2. Agree on the structure

The proposal's grouping comes from the page. The names are what the user will
live with, so review them with the user before building:

- **Sections** are flows or groups of states: "Корзина", "Шаг 1 — Оформление
  заказа", "Шаг 2 — Оплата", "Ошибки". Several source pages can feed one
  section, and one board can be split into several sections.
- **Rows** are one state each, with a caption card: `title` is the short
  code and name, `note` says when it happens. Keep the designer's wording.
- **Screens** are named `<state> / <variant>`, e.g.
  `1b · Промокод: нет такого / Мобайл`.

Drop duplicates, such as the same screen from an export and from its `-src`
file.

## 3. States behind interactions

A prototype shows one state at a time. Each screen can carry `steps`, replayed
from a fresh load:

```json
{ "name": "Корзина / Промокод введён", "page": "…флоу….html",
  "steps": [{ "type": "SUMMER25", "into": "Введите промокод" }, { "click": "Применить" }] }
```

Steps: `click`, `hover`, `type` (+ `into`), `press`, `wait`, `eval`, `reload`,
`viewport`, `scroll`. A target is visible text, which is case-insensitive and
also looks inside iframes, or `css:<selector>`. Survey with the same `steps` to
check that a state looks right before building it.

Every capture starts from a blank slate: the source's local storage is cleared
before each load, so a prototype that remembers its last step does not leak it
into the next screen.

Two things are worth checking before clicking through a long flow:

- **URL parameters.** Prototypes often accept them — `?step=pay`, `?embed=1`,
  `?auth=1`. Read the page's own script (`figma_forge_import_html` survey
  reports the page, then `eval` in a step or a quick look at the source) and
  prefer a URL over five clicks: it is faster and cannot half-fail.
- **A dead end.** If a button does nothing, the prototype may simply not wire
  it. Reaching the state through the app's own stored state and a `reload` step
  works where clicking does not:

  ```json
  [{ "eval": "const s=JSON.parse(localStorage.getItem('tlFlow')||'{}'); s.step='done'; localStorage.setItem('tlFlow', JSON.stringify(s));" },
   { "reload": true }, { "wait": 1200 }]
  ```

Time the last `wait` deliberately: a state that moves on by itself is missed
by a pause that is too long. A payment prototype that shows «Ждём ответа» for
two seconds and then replaces the whole page with a waiting screen gives one
state at `wait: 900` and a different one at `wait: 2000` — both real, worth
importing as two screens. When a capture comes out looking like a later step,
halve the wait and look again.

Leave prototype chrome out with `exclude`, e.g. the fixed
«ДЕСКТОП | МОБИЛЬНАЯ» switcher. **Anchor those selectors at `body`** — a
selector like `[data-screen-label] > div:nth-child(1)` matches every nested
component that carries the attribute and quietly removes page headers too. The
build reports what each exclusion dropped; read it.

## 4. Device mocks and mobile screens

A phone mock is usually an iframe. Importing the mock gives a phone picture.
The screen inside it is what the designer wants, at device width and full
length:

1. If the survey reports `innerPage`, use it as `page`, with
   `viewport: { width: 390 }` and no selector. This is the cleanest option.
2. Otherwise use the `inner` selector (`… iframe >>> body`), with
   `frameWidth: 390` if the mock's inner width is not the device width.

`fullHeight` (on by default) grows scroll containers and iframes, so a mobile
screen comes out full length instead of cut at the fold.

## 5. Build

Dry run first when there are many screens:

```
{ action: "build", source, sections, dryRun: true }
```

Each screen reports layers, auto layout frames, absolute frames, rasterized
parts and warnings. Then build for real:

```
{ action: "build", source, sections, target: { pageName: "Корзина — импорт" } }
```

- **Target.** By default a new page named after the source. Use
  `target.pageId` to add to an existing page; the new sections are placed to
  the right of what is already there.
- **Layout.** Screens are arranged left to right within their row and wrap
  onto new lines when a row gets long. Caption cards sit above each row, and
  sections sit side by side.
- **Colours** bind to local colour variables with the same value. A semantic
  alias wins over a primitive. Turn this off with `bindTokens: false`.
- **Components.** Buttons, chips, inputs and icons the file already has are
  placed as instances of those components, with the screen's own words filled
  into their text properties. The report lists which components were used and
  how often; `components: false` builds everything as frames. A layer that
  matched nothing keeps its layers, and so does an instance that fails to
  build, so an import never comes out empty.
- **Fonts.** Families are matched by how well they cover the weights the design
  uses, and by what the file already uses — a machine with "Golos Text"
  (two weights installed) and "Golos" (five) gets "Golos", not every text in
  SemiBold. Families Figma has nothing for fall back to Inter and are listed in
  `fontsMissingInFigma`; tell the user which fonts to install.

Figma sometimes loses its own connection to its servers mid-write, and every
plugin call then fails with "Unable to establish connection to Figma after 10
seconds" until it is back. A build retries such a write three times on its own;
the rendered screens are kept, so nothing is re-rendered. If it still fails,
run the same build again rather than hunting the screen — it is Figma, not the
layer tree.

The whole import is one journalled operation: `figma_forge_recover
{ operationId }` removes it. If a build was interrupted and the journal is
incomplete, `{ action: "cleanup", operationId }` removes everything tagged with
that operation.

## What to check afterwards

The build returns a screenshot of each section and links to every screen.
Look at them, and inspect one screen at `detail: "full"`.

- `absoluteFrames` means a container whose children could not be expressed as
  auto layout, usually because of overlapping items. It still looks right, but
  it will not reflow.
- `rasterized` parts are images: canvas, video, masks, gradient text, icon
  fonts. List them for the user. `rasterize: [selector]` forces one;
  `exclude` drops one.
- Text may wrap one word differently from the browser when Figma's font
  metrics differ, and long lines drift by a pixel or two. That is the font
  file, not the import.
- Compare a screen against its source when the user doubts the result: export
  the frame with `figma_forge_inspect { scope: "screenshot" }` and put it next
  to the page. Differences in block order or missing blocks mean an exclusion
  or a step went wrong; ghosting on text alone is normal.

## Limits

- Only parts the file already draws become instances; everything else is
  frames. A component is used when a layer agrees with it on size, on the
  words it shows, on its fill and on its radius — a near miss stays a frame,
  because a wrong instance looks right and behaves differently.
- Hover and pressed styles are imported only as states you capture with
  `hover` steps.
- Cross-origin iframes and cross-origin images without CORS become rasters.
- `.dc.html` sources need network access for React from unpkg.
