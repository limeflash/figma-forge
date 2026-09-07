# Figma Plugin API notes

Behaviours that cause most thrown scripts and silently wrong geometry, written
against the sandbox Figma Forge actually runs in (`documentAccess:
"dynamic-page"`, main thread, no browser APIs).

---

## The sandbox

The plugin main thread is a minimal JavaScript environment. It has **no**
`fetch`, `XMLHttpRequest`, DOM, `localStorage`, or `btoa`, and timers are not
something to build on. Anything network-shaped belongs on the Claude Code side
of the bridge.

`eval` is a *bound* function here, so every call is an indirect eval that cannot
see the calling scope — code shipped that way silently does nothing useful.
`new Function` works normally, which is what `figma_forge_execute` uses.

## Dynamic page loading

This plugin declares `documentAccess: "dynamic-page"`, which means pages are not
in memory until asked for. The synchronous accessors throw:

| Use | Not |
|---|---|
| `await figma.getNodeByIdAsync(id)` | `figma.getNodeById(id)` |
| `await instance.getMainComponentAsync()` | `instance.mainComponent` |
| `await figma.getStyleByIdAsync(id)` | `figma.getStyleById(id)` |
| `await page.loadAsync()` before reading `page.children` | reading it directly |
| `await figma.loadAllPagesAsync()` before `figma.root.findAll…` | scanning straight away |

`figma.on("documentchange")` also requires `loadAllPagesAsync()` first, and
throws otherwise.

## Text

**Load fonts before every text write.** Setting `characters`, `fontName`,
`fontSize`, or any range property on an unloaded font throws.

```js
await figma.loadFontAsync(text.fontName);            // single font
const fonts = text.getRangeAllFontNames(0, text.characters.length);
await Promise.all(fonts.map(figma.loadFontAsync));   // mixed fonts
```

A freshly created text node has Inter Regular — and still has to load it.

`fontName`, `fontSize` and friends return `figma.mixed` when the text has ranges
with different values. Compare against `figma.mixed` explicitly; it is a symbol,
not `undefined`.

Inside auto layout, prefer `layoutSizingHorizontal` / `layoutSizingVertical`
over `textAutoResize` — they are the properties the parent actually honours.

## Immutable arrays

`fills`, `strokes`, `effects`, `layoutGrids` and similar are read-only. Mutating
an element does nothing; you have to clone, change the copy, and reassign.

```js
const fills = [...node.fills];
fills[0] = { ...fills[0], opacity: 0.5 };
node.fills = fills;
```

## Auto layout, in order

1. `layoutMode` — `"HORIZONTAL"` or `"VERTICAL"`. Nothing below applies until
   this is set.
2. `primaryAxisSizingMode` / `counterAxisSizingMode` — `"AUTO"` hugs contents,
   `"FIXED"` holds the current size.
3. Padding, `itemSpacing`, `counterAxisSpacing`, alignment.
4. `layoutSizingHorizontal` / `layoutSizingVertical` on **children**. `"FILL"`
   throws unless the parent has auto layout.

**`resize()` resets sizing modes to `FIXED`.** Set sizing after resizing, never
before. Figma Forge's `set` op handles this ordering; hand-written scripts must
do it themselves.

Hidden children are excluded from the auto-layout flow. A `visible: false`
sibling does not hold space.

Groups size themselves to their children — setting a group's width or height
does not do what it looks like it does. Use a frame.

## Components, instances and properties

`instance.componentProperties` returns keys where non-variant properties carry a
`#id` suffix (`"Label#12:0"`). `setProperties` needs those exact keys. Figma
Forge's typed ops accept the bare name and normalise it; raw scripts do not get
that.

Variant values must match `variantOptions` exactly, including case. `"primary"`
and `"Primary"` are different values, and the wrong one throws.

Instance structure is not editable: you cannot append or remove an instance's
children. Override their properties, use component properties, or swap the
instance.

`swapComponent()` preserves overrides where the shapes line up and drops them
where they do not — it is lossy, and the loss is not recoverable by swapping
back.

## Library assets

A library asset must be imported before use:

```js
await figma.importComponentByKeyAsync(key);
await figma.importComponentSetByKeyAsync(key);
await figma.importStyleByKeyAsync(key);
await figma.variables.importVariableByKeyAsync(key);
```

`figma.variables.getLocalVariablesAsync()` does **not** see library variables.
They come from `figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()`
and `getVariablesInLibraryCollectionAsync(collectionKey)`, both of which can be
permission-gated and fail on some workspaces.

There is **no API to enumerate a team library's components.** The only reliable
sources are components already used in the file (via instances) and keys the
user supplies.

## Variables and styles

Scalar bindings:

```js
node.setBoundVariable("itemSpacing", variable);   // variable, or null to unbind
```

Paint colours are different — bind the paint, then reassign the array:

```js
const fills = [...node.fills];
fills[0] = figma.variables.setBoundVariableForPaint(fills[0], "color", variable);
node.fills = fills;
```

Style setters are async under dynamic-page: `setFillStyleIdAsync`,
`setStrokeStyleIdAsync`, `setTextStyleIdAsync`, `setEffectStyleIdAsync`,
`setGridStyleIdAsync`.

An instance with no local binding may be **inheriting** a token from its main
component. Absence of a binding is not evidence of a hardcoded value — check the
main component before "fixing" it.

## Geometry

`cornerRadius` and `strokeWeight` return `figma.mixed` when the corners or sides
differ. Set `topLeftRadius` and friends individually in that case.

`x` and `y` are relative to the parent. For document-space position use
`absoluteBoundingBox` or `absoluteTransform`.

A node inside auto layout ignores `x`/`y` unless `layoutPositioning` is
`"ABSOLUTE"`.

## Structure

`clone()` places the copy in the same parent as the original.

`figma.root.children` are pages; scene nodes cannot be appended to the root.
`appendChild` moves a node — it does not copy it.

`remove()` is permanent from the plugin's side. Figma Forge's `remove` op
quarantines instead, which is why it is recoverable.

## Selection and viewport

`figma.currentPage.selection` only accepts nodes on the current page. Switch
first with `await figma.setCurrentPageAsync(page)`.

`figma.viewport.scrollAndZoomIntoView(nodes)` moves the user's view — use it to
show a result, not routinely.

## Plugin data

`setPluginData(key, value)` stores strings only, per node, scoped to this
plugin. Entries are size-capped, so large payloads belong on the Claude Code
side. `getPluginDataKeys()` lists what this plugin has written.

Figma Forge uses `ff.operation`, `ff.createdBy`, `ff.quarantinedFrom` and
`ff.module.*` — do not overwrite them.

## Undo

`figma.commitUndo()` inserts an undo checkpoint. It is not a transaction: a
thrown script can leave partial mutations, and later user edits make the undo
stack ambiguous. The Figma Forge journal is the authoritative record of what a
write did.
