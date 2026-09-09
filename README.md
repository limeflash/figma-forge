# Figma Forge

Build and modify real Figma files from Claude Code, with the design system as
the source of truth.

Figma Forge ships its own Figma plugin and a local WebSocket bridge, so it talks
to Figma through the full Plugin API on your machine. Nothing goes to a remote
service, and it does not require a paid Figma seat.

## What makes it different

- **Design-system first.** Components, styles and variables are indexed by
  Figma *key*, not by name, and cached per file. Writes resolve against that
  index — a plan that reaches for a raw rectangle where a component exists is
  rejected unless it carries a written reason.
- **Journalled writes.** Every mutation records its inverse before it runs, so a
  failure rolls back instead of leaving half a screen behind. The journal lives
  on disk and outlives both the MCP process and the Figma tab.
- **Verification, not vibes.** After each write, invariants check for hardcoded
  colours, unbound spacing, detached instances, missing auto layout, broken
  references, overlap and off-canvas content.
- **Two lanes.** A typed, validated write API for normal work, and a raw
  Plugin API execution lane — read-only by default — for what the typed ops do
  not cover.

## Install

```
/plugin marketplace add limeflash/figma-forge
/plugin install figma-forge
```

Then load the Figma plugin once:

1. In Figma: **Plugins → Development → Import plugin from manifest…**
2. Choose `figma-plugin/manifest.json` from this repo.

## Use

In Claude Code:

```
/figma-forge:connect
```

It prints a port and a channel name. In Figma, open **Plugins → Development →
Figma Forge**, enter those two values, press **Connect**.

Then:

```
/figma-forge:index                     build the design-system index
/figma-forge:search primary button     find components, styles, variables
/figma-forge:build a settings page     plan and build
/figma-forge:modify all buttons to secondary
/figma-forge:import-code src/tokens.css   import code tokens as Figma variables
/figma-forge:setup                     check Ollama and the rest of the setup
/figma-forge:verify page
/figma-forge:recover                   roll back a failed write
/figma-forge:status                    what is connected, what changed
```

The plugin reconnects on its own with backoff, and the bridge survives Claude
Code restarts — you only reopen the Figma plugin if you closed it.

## Tools

| Tool | Purpose |
|---|---|
| `figma_forge_connect` | Start the bridge, pair a channel with an open Figma file |
| `figma_forge_status` | Bridge, plugin, file, index freshness, recent writes |
| `figma_forge_inspect` | Document, page, selection, node, or CSS-like selector query; screenshots |
| `figma_forge_design_system` | Index, search, resolve recipes, import library assets |
| `figma_forge_apply_plan` | The write lane: ordered ops under a journal, with dry run |
| `figma_forge_verify` | Design-system and structural invariants |
| `figma_forge_recover` | Roll back a journalled operation; manage quarantine |
| `figma_forge_graph` | Index every screen; find them by meaning or by word |
| `figma_forge_import_code` | Import CSS/Tailwind tokens as variables; map Storybook components |
| `figma_forge_execute` | Raw Plugin API JavaScript, read-only by default |
| `figma_forge_modules` | Persistent helper modules stored in the document |

## Finding things in a large file

Node names do not survive real files. On a page from one test file, 21 screens
included "other profile" seven times, plus "other" and "Header" — nothing to
search by.

```
figma_forge_graph { action: "build" }
figma_forge_graph { action: "search", query: "экран оплаты картой" }
```

The graph indexes each screen by what it actually contains: its text, the
components it is built from, and its page and section names. Search fuses BM25
over words with cosine over embeddings by reciprocal rank, and every result says
which half found it.

Word search needs nothing. Semantic search additionally needs
[Ollama](https://ollama.com) running locally with `embeddinggemma` (~620 MB) —
`/figma-forge:setup` checks and offers to install it. Embeddings run on your own
machine, so screen text never leaves it. Ollama Cloud is not an option here: it
hosts only generative models, with no embedding model in its catalogue.

## Importing from code

Tokens go one way — code to Figma — and components deliberately do not.

```
/figma-forge:import-code src/styles/tokens.css
/figma-forge:import-code tailwind.config.js
/figma-forge:import-code storybook-static/index.json
```

CSS custom properties and Tailwind theme values become Figma variables. Dark-mode
blocks (`.dark`, `[data-theme="dark"]`, `prefers-color-scheme`) become Figma
modes, and `var(--other)` references are preserved as variable aliases rather
than flattened. Tailwind v4's `oklch()` palette is gamut-mapped to sRGB the way a
browser renders it, not clipped per channel.

Imports are source-owned: each variable is stamped with where it came from, so
re-importing updates in place instead of duplicating, and a variable someone
authored by hand is never overwritten without `takeOwnership`.

Storybook is a **mapping**, not a conversion — it reports which stories already
have a Figma component and which do not. Figma Forge does not turn React into
Figma components, because the result is neither faithful nor editable.

## Architecture

```
Claude Code
   │ stdio
   ▼
MCP server ──────────────► design-system cache + write journals
   │ WebSocket             (CLAUDE_PLUGIN_DATA, never the project dir)
   ▼
bridge (detached, 127.0.0.1:3055, channel-based)
   │ WebSocket
   ▼
Figma plugin UI iframe
   │ postMessage
   ▼
Figma plugin main thread ──► the document
```

The split is forced by Figma: only the main thread can touch the document, and
only the UI iframe has a network stack. The bridge is a separate detached
process so restarting Claude Code does not drop the Figma connection.

Channels pair one project with one Figma plugin session; the default channel is
the project directory name, so several projects can share one bridge.

## Development

```
npm install
npm run build          # figma-plugin/dist, mcp-server/dist
npm run build:watch
npm run typecheck
npm run bridge         # run the bridge in the foreground
```

`dist/` is committed on purpose: Claude Code installs a plugin by cloning the
repo, with no build step.

## Known limits

- The Figma plugin must stay open. Nothing can reopen it remotely.
- Figma has no transaction primitive; rollback is simulated and cannot be
  perfect. `figma_forge_execute` in `unsafe_in_place` mode is not journalled.
- The Plugin API cannot enumerate a team library's components — the index covers
  local components plus remote ones the file already uses.
- Team library variable APIs are permission-gated and unavailable in some
  workspaces; the index degrades rather than failing.
- Large files need scoped scans. Whole-document indexing is capped and reports
  truncation instead of running forever.
- Code import is one-directional and token-only. Composite CSS values (shadows,
  gradients, font stacks) have no Figma variable equivalent and are reported as
  unsupported rather than approximated.
- A Tailwind v3 config is executed to read its theme, so it must import cleanly
  on its own. A config that only sets `content` inherits the default palette from
  Tailwind itself, and there is nothing in the file to import.
- The screen graph is a snapshot, not a live view. It indexes screens rather
  than every node, and caps text per screen, so rebuild it after real changes.
- Figma's manifest rejects raw IP addresses in `allowedDomains`, so the plugin
  connects to `ws://localhost`. Changing the bridge port away from 3055 means
  adding that port to `figma-plugin/manifest.json` and re-importing the plugin.

## License

MIT
