---
name: figma-session
description: Connect Claude Code to a Figma file through the Figma Forge bridge, diagnose a connection that is not working, and understand the channel/session model. Use when Figma tools report no plugin attached, when starting Figma work in a project for the first time, or when the user asks why Figma is not responding.
---

# Connecting to Figma

Figma Forge talks to Figma through three processes, and knowing which one is
broken saves most of the debugging time.

```
Claude Code ──stdio──> MCP server ──WebSocket──> bridge ──WebSocket──> Figma plugin UI ──postMessage──> Figma document
```

- **The bridge** is a shared local daemon on `127.0.0.1:3055`. The MCP server
  starts it lazily and detached, so it survives Claude Code restarts. Multiple
  projects share one bridge and stay separated by channel.
- **The Figma plugin** must be open in Figma. Nothing can reopen it remotely —
  if the user closes the plugin, the connection is gone until they reopen it.
- **The channel** pairs one project with one Figma plugin session. It defaults
  to the project directory name.

## Connecting

Run `figma_forge_connect`. If it reports `figmaAttached: false`, the user has to
act, so tell them exactly what to do and then stop:

> In Figma, open the target file → Plugins → Development → Figma Forge.
> Enter port `3055` and channel `<channel>`, then press Connect.

Do not poll `figma_forge_connect` in a loop waiting for them. Ask once, wait.

The plugin remembers the last port and channel, and reconnects on its own with
backoff, so this is usually a one-time step per file.

## Diagnosing

`figma_forge_status` distinguishes the failure modes:

| Symptom | Meaning | Fix |
|---|---|---|
| `bridgeRunning: false` | Nothing is listening on the port | `figma_forge_connect` starts it. If that fails, something else owns the port. |
| `bridgeRunning: true`, `figmaAttached: false` | Bridge is up, Figma is not in this channel | User opens the plugin and connects, or is connected on a *different* channel — check `channels` in the status output. |
| `figmaAttached: true`, commands time out | The file is large or the plugin is busy | Narrow the scope: a page or node id instead of the whole document. |
| `COMMAND_TIMEOUT` right after it was working | The Figma tab was closed | Ask the user to reopen the plugin. |

If `channels` shows Figma attached under a different name, the user typed a
different channel. Either ask them to correct it, or call `figma_forge_connect`
with that channel — it is a name, not a secret.

## What survives what

- Restarting Claude Code: connection survives. The bridge and plugin are untouched.
- Closing the Figma plugin: connection lost, must be reopened by hand.
- Switching Figma files: a new plugin session. Reconnect and refresh the index —
  component keys differ between files.
- Two Figma tabs on the same file: two separate sessions. Commands go to
  whichever one joined the channel.

## Before doing real work

A connected session is not a ready session. Check that a design-system index
exists for the file (`figma_forge_status` reports it), and build one with
`figma_forge_design_system { action: "refresh" }` if it does not. Building
without an index means guessing at component names, which is the single most
common way this goes wrong.
