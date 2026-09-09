/**
 * Figma Forge — plugin main thread.
 *
 * The split is forced by Figma: only this thread can touch the document, and
 * only the UI iframe has a network stack. So the iframe owns the WebSocket and
 * this file owns the document, and the two talk over `figma.ui.postMessage`.
 * Everything here is dispatch, error shaping, and session bookkeeping — the
 * actual work lives in `runtime/`.
 */

import { installShims, shimReport } from './runtime/shims';
import { execute, ExecParams, listModules, defineModule, removeModule, hashSource } from './runtime/exec';
import { inspect, InspectParams } from './runtime/commands/inspect';
import { designSystem, DesignSystemParams, INDEX_SCHEMA_VERSION } from './runtime/commands/design-system';
import { applyPlan, Plan } from './runtime/commands/apply-plan';
import { verify, VerifyParams } from './runtime/commands/verify';
import { recover, RecoverParams } from './runtime/commands/recover';
import { importTokens, ImportTokensParams } from './runtime/commands/import-tokens';
import { errorMessage } from './runtime/journal';

const PLUGIN_VERSION = '0.1.0';

const STORAGE_KEYS = {
  port: 'figma-forge.port',
  channel: 'figma-forge.channel',
  autoConnect: 'figma-forge.autoConnect',
};

interface UiRequest {
  type: 'request';
  id: string;
  command: string;
  params?: Record<string, unknown>;
}

type UiMessage =
  | UiRequest
  | { type: 'ui-ready' }
  | { type: 'connected'; channel: string; port?: string }
  | { type: 'disconnected' }
  | { type: 'save-settings'; port?: string; channel?: string; autoConnect?: boolean };

let connectedChannel: string | null = null;

installShims();

figma.showUI(__html__, { width: 320, height: 440, themeColors: true });

/**
 * Session identity is the file key plus a per-open nonce: two tabs on the same
 * file are genuinely different sessions, and a command routed to the wrong one
 * would edit the wrong window.
 */
const sessionNonce = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/**
 * A stable identity for this file, used to key the design-system cache.
 *
 * `figma.fileKey` would be the obvious answer, but it is only exposed to private
 * organization plugins that set `enablePrivatePluginApi` — for a locally
 * imported plugin it is always undefined, which would collapse every file onto
 * one cache entry and serve file A's component keys while editing file B.
 *
 * So: hash the document name together with the first page's id. Node ids are
 * per-file sequences, so the pair is effectively unique. It is derived, not
 * stored, because writing plugin data just to identify a file would dirty a
 * document the user only opened to read. Renaming the file invalidates the
 * cache, which costs a rebuild — far cheaper than confidently returning the
 * wrong index.
 */
function fileIdentity(): string {
  const firstPage = figma.root.children[0];
  return `doc-${hashSource(`${figma.root.name}|${firstPage ? firstPage.id : ''}`)}`;
}

function sessionInfo() {
  return {
    plugin: 'figma-forge',
    pluginVersion: PLUGIN_VERSION,
    indexSchemaVersion: INDEX_SCHEMA_VERSION,
    sessionId: `${figma.fileKey ?? 'local'}:${sessionNonce}`,
    fileKey: figma.fileKey ?? null,
    fileId: fileIdentity(),
    documentName: figma.root.name,
    editorType: figma.editorType,
    currentPage: { id: figma.currentPage.id, name: figma.currentPage.name },
    pageCount: figma.root.children.length,
    selection: figma.currentPage.selection.map((node) => ({ id: node.id, name: node.name, type: node.type })),
    shims: shimReport(),
    channel: connectedChannel,
  };
}

type Handler = (params: Record<string, unknown>) => Promise<unknown> | unknown;

const handlers: Record<string, Handler> = {
  ping: () => ({ pong: true, at: Date.now(), ...sessionInfo() }),

  session_info: () => sessionInfo(),

  inspect: (params) => inspect(params as InspectParams),

  design_system: (params) => designSystem(params as DesignSystemParams),

  apply_plan: (params) => applyPlan(params as unknown as Plan),

  verify: (params) => verify(params as VerifyParams),

  recover: (params) => recover(params as RecoverParams),

  import_tokens: (params) => importTokens(params as unknown as ImportTokensParams),

  execute: (params) => execute(params as unknown as ExecParams),

  modules: (params) => {
    const action = (params.action as string) ?? 'list';
    if (action === 'list') return { modules: listModules() };
    if (action === 'define') {
      return defineModule(String(params.name ?? ''), String(params.source ?? ''));
    }
    if (action === 'remove') return { removed: removeModule(String(params.name ?? '')) };
    throw new Error(`Unknown modules action "${action}".`);
  },

  /** Lets the agent point the user at what it just built. */
  focus: async (params) => {
    const ids = (params.nodeIds as string[]) ?? [];
    const nodes: SceneNode[] = [];
    for (const id of ids) {
      const node = await figma.getNodeByIdAsync(id);
      if (node && 'visible' in node) nodes.push(node as SceneNode);
    }
    if (!nodes.length) throw new Error('None of those node ids resolved to something focusable.');

    const page = pageOf(nodes[0]);
    if (page && page.id !== figma.currentPage.id) await figma.setCurrentPageAsync(page);
    figma.currentPage.selection = nodes;
    figma.viewport.scrollAndZoomIntoView(nodes);
    return { focused: nodes.map((node) => node.id), pageId: figma.currentPage.id };
  },

  notify: (params) => {
    figma.notify(String(params.message ?? ''), { error: params.error === true, timeout: 3000 });
    return { shown: true };
  },
};

function pageOf(node: BaseNode): PageNode | null {
  let current: BaseNode | null = node;
  while (current && current.type !== 'PAGE') current = (current as SceneNode).parent as BaseNode | null;
  return (current as PageNode) ?? null;
}

async function dispatch(request: UiRequest): Promise<void> {
  const handler = handlers[request.command];
  if (!handler) {
    figma.ui.postMessage({
      type: 'response',
      id: request.id,
      ok: false,
      error: {
        code: 'UNKNOWN_COMMAND',
        message: `Unknown command "${request.command}". Known: ${Object.keys(handlers).join(', ')}.`,
      },
    });
    return;
  }

  try {
    const result = await handler(request.params ?? {});
    figma.ui.postMessage({ type: 'response', id: request.id, ok: true, result });
  } catch (error) {
    figma.ui.postMessage({
      type: 'response',
      id: request.id,
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        message: errorMessage(error),
        // The stack is the difference between "it failed" and a fixable report,
        // and this only ever travels over loopback.
        stack: error instanceof Error ? error.stack : undefined,
      },
    });
  }
}

figma.ui.onmessage = async (message: UiMessage) => {
  if (!message || typeof message !== 'object') return;

  switch (message.type) {
    case 'ui-ready': {
      const [port, channel, autoConnect] = await Promise.all([
        figma.clientStorage.getAsync(STORAGE_KEYS.port),
        figma.clientStorage.getAsync(STORAGE_KEYS.channel),
        figma.clientStorage.getAsync(STORAGE_KEYS.autoConnect),
      ]);
      figma.ui.postMessage({
        type: 'restore',
        port: port ?? '3055',
        channel: channel ?? '',
        autoConnect: autoConnect !== false,
        session: sessionInfo(),
      });
      return;
    }

    case 'connected': {
      connectedChannel = message.channel;
      await figma.clientStorage.setAsync(STORAGE_KEYS.channel, message.channel);
      if (message.port) await figma.clientStorage.setAsync(STORAGE_KEYS.port, message.port);
      await figma.clientStorage.setAsync(STORAGE_KEYS.autoConnect, true);
      return;
    }

    case 'disconnected':
      connectedChannel = null;
      return;

    case 'save-settings':
      if (message.port !== undefined) await figma.clientStorage.setAsync(STORAGE_KEYS.port, message.port);
      if (message.channel !== undefined) await figma.clientStorage.setAsync(STORAGE_KEYS.channel, message.channel);
      if (message.autoConnect !== undefined) {
        await figma.clientStorage.setAsync(STORAGE_KEYS.autoConnect, message.autoConnect);
      }
      return;

    case 'request':
      await dispatch(message);
      return;
  }
};

// Closing the plugin drops the socket with it; the bridge treats that as the
// Figma side leaving the channel and tells the agent, rather than hanging.
figma.on('close', () => {
  connectedChannel = null;
});
