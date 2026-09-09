# Figma Plugin API notes

Behaviours that cause most thrown scripts and silently wrong geometry, written
against the sandbox Figma Forge actually runs in (`documentAccess:
"dynamic-page"`, main thread, no browser APIs).

Every claim here is checked against `@figma/plugin-typings` (MIT), which is also
the source for the generated `api-reference.md` next to this file. When you need
"does this node type have this property" or "what are the legal values", look
there — it is exact and regenerated from the types, not remembered.

---

## The sandbox

The plugin main thread is a restricted JavaScript environment with no DOM, no
`localStorage` and no `btoa`.

Measured on Figma desktop, September 2026: `setTimeout` and `fetch` *do* exist
as functions on the main thread — older guidance saying otherwise is out of date.
`fetch` is still governed by the manifest's `networkAccess`, so it can only reach
domains the plugin declared, and anything genuinely network-shaped still belongs
on the Claude Code side of the bridge where it is inspectable.

Use `new Function` rather than `eval` for dynamic code. `eval` in this sandbox has
a history of behaving as an indirect eval — unable to see the calling scope, so
shipped code silently does nothing — while `new Function` bodies are ordinary
function scopes. `figma_forge_execute` uses the async `Function` constructor for
exactly this reason.

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

## Colour

`RGB` is `{ r, g, b }` and `RGBA` is `{ r, g, b, a }` — all channels are **0 to
1**, not 0–255. `{ r: 255, g: 0, b: 0 }` is not red; it is out of range.

`SolidPaint.color` is an `RGB` and **has no alpha channel.** Transparency lives
on the paint:

```js
node.fills = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: 0.5 }];
```

Putting `a` inside `color` is the single most common paint error. It is silently
ignored or throws, depending on where it lands.

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

`lineHeight` and `letterSpacing` are **objects, not numbers**:

```js
text.lineHeight    = { value: 24, unit: "PIXELS" };   // or "PERCENT", or { unit: "AUTO" }
text.letterSpacing = { value: -1, unit: "PIXELS" };   // or "PERCENT"
```

Assigning a bare number throws.

Font *style* names are file-dependent — a family may ship `"Semi Bold"` in one
file and `"SemiBold"` in another. Discover them with
`figma.listAvailableFontsAsync()` instead of guessing, and remember that
`loadFontAsync` needs the exact pair.

A new text node defaults to `textAutoResize: "WIDTH_AND_HEIGHT"`, which means it
sizes to its content and **ignores `layoutSizingHorizontal: "FILL"`** — the node
collapses to a thin thread instead of filling its parent. Set
`textAutoResize = "HEIGHT"` (or `"NONE"`) before asking it to fill.

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

### Two different sizing enums

They look interchangeable and are not:

| Property | Values | Applies to |
|---|---|---|
| `layoutSizingHorizontal` / `layoutSizingVertical` | `"FIXED"` `"HUG"` `"FILL"` | auto-layout frames, their children, text nodes |
| `primaryAxisSizingMode` / `counterAxisSizingMode` | `"FIXED"` `"AUTO"` | auto-layout frames only |

`layoutSizing*` is the shorthand that maps to the Figma UI's sizing dropdown; it
sets `layoutGrow`, `layoutAlign` and the axis sizing modes underneath. Prefer it.

`counterAxisAlignItems` accepts `"MIN"` `"MAX"` `"CENTER"` `"BASELINE"` — there
is **no `"STRETCH"`**. To stretch a child across the counter axis, set that
child's `layoutSizing*` to `"FILL"`.

### HUG parents collapse FILL children

A child cannot fill a parent that is sizing itself to its children — the
constraint is circular, and Figma resolves it by collapsing the child. If a
child should be `"FILL"` on an axis, the parent must be `"FIXED"` on that axis.
`layoutGrow` on a hugging parent compresses content the same way.

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

`setBoundVariableForPaint` returns a **copy** of the paint — it does not mutate
the one you pass in. Ignoring the return value is a no-op that looks like it
worked.

A new variable defaults to `ALL_SCOPES`, meaning it is offered everywhere in the
Figma UI. Set `scopes` explicitly so a corner-radius token does not show up in
the colour picker.

A new variable collection starts with exactly one mode, named `"Mode 1"`. Rename
it and add the others before creating variables, or every variable will carry a
meaningless mode name forever.

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

**New nodes land at (0, 0) of the page** and will sit on top of whatever is
already there. Either append them into an auto-layout parent, which positions
them for you, or set `x`/`y` explicitly. Reparenting does not reset position
either — a node moved into a plain frame keeps the coordinates it had.

`detachInstance()` returns a new `FrameNode` and consumes the instance: the
instance's id, and the ids of everything under it, stop being valid. Anything
holding those ids — including a plan you are midway through — is now stale.

`figma.combineAsVariants(nodes, parent)` requires every node to be a
`ComponentNode`; frames or instances throw. There is deliberately no
`createComponentSet()`, because an empty component set is not a thing Figma
supports.

`addComponentProperty()` returns the generated property key as a string (like
`"Label#12:0"`). Use the returned value — the suffix is assigned by Figma and
cannot be predicted.

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

## Node objects

Every node type has its **own prototype** — there is no shared base. Measured on
a real file: `FrameNode` has 189 own prototype keys, `TextNode` 205,
`InstanceNode` 198, `SectionNode` 98, and no two are the same object. Code that
extends "the node prototype" reaches exactly one type.

Individual nodes are **not extensible**: `Object.defineProperty(node, …)` throws
`object is not extensible`. Prototypes *are* writable, so the only way to add a
method across types is to install it on each type's prototype as you encounter
one. Figma Forge does this lazily, keyed by prototype identity.

`figma` itself is a plain host object and can be extended directly — but it has
non-configurable, non-writable own properties, so wrapping it in a `Proxy` that
substitutes a method breaks a Proxy invariant and fails with
`proxy: inconsistent get`. Forward through a plain object with getters instead.

## Reading the error message

Two thrown messages mean the same underlying thing — the property does not exist
on that node type:

- `"object is not extensible"` — you assigned a property the node does not have.
- `"no such property"` — you read or called a member the node does not have.

Neither is a sandbox quirk. Check `api-reference.md`: `itemSpacing` exists on
four node types, `characters` on three. A `RectangleNode` has no `layoutMode`,
and no amount of retrying will give it one.

## Cost

Async calls in the sandbox each cross into the host. That makes two habits worth
having:

- Batch independent awaits with `Promise.all` instead of a sequential loop.
  Resolving forty main components one at a time is forty round trips.
- Scope traversal to the smallest ancestor you know. `figma.root.findAll()`
  walks every node on every page; `frame.findAllWithCriteria({ types: [...] })`
  walks one subtree and filters in the host.

Figma Forge's own index build is capped and reports truncation rather than
running unbounded — a script that scans without limits will simply hit the
bridge's command timeout instead.
