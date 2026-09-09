#!/usr/bin/env node
/**
 * SessionStart hook.
 *
 * Reports whether a Figma session is already paired, so the agent does not have
 * to discover mid-task that nothing is connected. It deliberately does NOT start
 * the bridge: a session that never touches Figma should not leave a daemon
 * behind, and `figma_forge_connect` starts it lazily when it is actually needed.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const port = Number(process.env.FIGMA_FORGE_BRIDGE_PORT || 3055) || 3055;

function channelName() {
  const explicit = process.env.FIGMA_FORGE_CHANNEL;
  if (explicit && explicit.trim() && !explicit.includes('${')) return explicit.trim();
  const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return basename(dir).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-') || 'figma-forge';
}

function dataRoot() {
  const configured = process.env.FIGMA_FORGE_DATA_DIR;
  if (configured && configured.trim() && !configured.includes('${')) return configured;
  return join(homedir(), '.figma-forge');
}

const channel = channelName();

async function health() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1200) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

const state = await health();
const attached = state?.channels?.[channel]?.figma > 0;

let session = null;
try {
  session = JSON.parse(await readFile(join(dataRoot(), 'sessions', `${channel.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`), 'utf8'));
} catch {
  /* first run in this project */
}

async function ollamaState() {
  const base = process.env.FIGMA_FORGE_OLLAMA_HOST || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
  const url = /^https?:\/\//.test(base) ? base : `http://${base}`;
  try {
    const response = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) return null;
    const body = await response.json();
    const model = process.env.FIGMA_FORGE_EMBED_MODEL || 'embeddinggemma';
    const has = (body.models || []).some((m) => (m.name || '').split(':')[0] === model.split(':')[0]);
    return { running: true, hasModel: has, model };
  } catch {
    return null;
  }
}

const ollama = await ollamaState();

const lines = [];
if (attached) {
  lines.push(`Figma Forge: connected on channel "${channel}" (port ${port}).`);
  if (session?.documentName) lines.push(`Paired file: ${session.documentName}${session.fileKey ? ` (${session.fileKey})` : ''}.`);
  lines.push('Run figma_forge_design_system { action: "overview" } before building anything.');
} else if (state) {
  lines.push(`Figma Forge: bridge is up on port ${port}, but no Figma plugin has joined channel "${channel}".`);
  lines.push('Open the Figma Forge plugin in the target file and connect, then run figma_forge_connect.');
} else {
  lines.push(`Figma Forge: not connected. Run figma_forge_connect (channel "${channel}") when you need Figma.`);
}

if (!ollama) {
  lines.push('Semantic screen search is off (Ollama not running). Word search still works; /figma-forge:setup explains.');
} else if (!ollama.hasModel) {
  lines.push(`Semantic screen search is off (no ${ollama.model} model). /figma-forge:setup can pull it.`);
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: lines.join('\n'),
    },
  })
);
