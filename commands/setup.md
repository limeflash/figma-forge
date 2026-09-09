---
description: Check and set up what Figma Forge needs, including Ollama for semantic search
allowed-tools: Bash, mcp__figma-forge__figma_forge_status, mcp__figma-forge__figma_forge_graph
---

Check what Figma Forge needs and offer to fix what is missing.

**1. Report the state first, fix nothing yet.**

- `figma_forge_status` — bridge, plugin, paired file.
- `figma_forge_graph { action: "status" }` — graph index and whether semantic
  search is available.

**2. Ollama, only if semantic search is unavailable.**

Semantic search is optional: word search over the graph works without it. So
lead with what the user gains, then the cost, then ask.

- **Ollama missing entirely** — `command -v ollama`. Installing is a ~1 GB
  download. On macOS `brew install ollama` if Homebrew is present, otherwise
  point at https://ollama.com/download. Ask before running either.
- **Ollama present but not running** — `ollama serve` (or the desktop app).
- **Model missing** — `ollama pull embeddinggemma` is a ~620 MB download. Say
  the size and ask. It is a 300M-parameter embedding model that runs locally;
  nothing from the Figma file leaves the machine.

Never start a multi-hundred-megabyte download without an explicit yes. The user
may be on a metered or slow connection, and this is not urgent — everything
except semantic ranking works without it.

**3. Confirm.**

After any install, re-run `figma_forge_graph { action: "status" }` and report
what changed. If a graph already exists without embeddings, say that rebuilding
adds them, and ask before doing it.
