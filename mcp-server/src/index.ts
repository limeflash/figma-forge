/**
 * Figma Forge MCP server.
 *
 * Eight tools, split into two lanes. The typed lane (inspect / design_system /
 * apply_plan / verify / recover) is what the bundled skills use: it validates,
 * journals, and verifies. The compatibility lane (execute) exists for the
 * operations no typed vocabulary will ever cover, and defaults to read-only.
 *
 * This process owns durable state — the design-system cache and the write
 * journals — while the Figma plugin owns the document. Neither can lose the
 * other's data by crashing.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { Bridge, BridgeError } from './bridge.js';
import { overview, search, RawIndex, ResultKind } from './search.js';
import { importTokenSource, parseStorybook, resolveSourcePath, summarizeIR } from './import/index.js';
import * as ollama from './graph/ollama.js';
import { clearGraph, loadGraph, loadVectors, saveGraph, saveVectors, StoredGraph } from './graph/store.js';
import { buildLexicalIndex, fuse, lexicalSearch, screenDocument, vectorSearch } from './graph/search.js';
import { GraphChunk } from './graph/types.js';
import { renderPlan, PlanOp, ThumbnailAsset, VariableValue } from './preview/render.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join as joinPath } from 'node:path';
import { dataDirectory as ffDataDirectory } from './store.js';
import {
  clearIndex,
  dataDirectory,
  latestRecoverable,
  listJournals,
  markDirty,
  readIndex,
  readJournal,
  readSession,
  updateJournalStatus,
  writeIndex,
  writeJournal,
  writeSession,
} from './store.js';

const PLUGIN_VERSION = '0.1.0';
const here = dirname(fileURLToPath(import.meta.url));

/** userConfig placeholders arrive unsubstituted when the user left them blank. */
function envValue(name: string): string | undefined {
  const value = process.env[name];
  if (!value || !value.trim() || value.includes('${')) return undefined;
  return value.trim();
}

function defaultChannel(): string {
  const explicit = envValue('FIGMA_FORGE_CHANNEL');
  if (explicit) return explicit;
  const projectDir = envValue('FIGMA_FORGE_PROJECT_DIR') ?? process.cwd();
  const name = basename(projectDir).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  return name || 'figma-forge';
}

const port = Number(envValue('FIGMA_FORGE_BRIDGE_PORT') ?? 3055) || 3055;

const bridge = new Bridge({
  port,
  channel: defaultChannel(),
  bridgeScript: join(here, 'bridge.js'),
});

/* ------------------------------------------------------------------ *
 * Response helpers
 * ------------------------------------------------------------------ */

type ToolResult = {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  isError?: boolean;
};

function text(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

/**
 * Bridge failures are the ones users actually hit, and the raw message rarely
 * says what to do. Translate the two common ones into instructions.
 */
function failure(error: unknown): ToolResult {
  if (error instanceof BridgeError) {
    if (error.code === 'NO_FIGMA_CLIENT') {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              `No Figma plugin is attached to channel "${bridge.channel}".\n\n` +
              'In Figma: Plugins → Development → Figma Forge, then enter\n' +
              `  port: ${bridge.port}\n  channel: ${bridge.channel}\n` +
              'and press Connect.',
          },
        ],
      };
    }
    if (error.code === 'COMMAND_TIMEOUT') {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              `${error.message}\n\nIf the file is very large, narrow the scope ` +
              '(a page or node id instead of the whole document) and try again.',
          },
        ],
      };
    }
    return { isError: true, content: [{ type: 'text', text: `${error.code}: ${error.message}` }] };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: 'text', text: message }] };
}

async function call<T = unknown>(command: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
  return await bridge.request<T>(command, params, timeoutMs);
}

interface SessionInfo {
  fileKey: string | null;
  /** Derived per-file identity, present when fileKey is not available. */
  fileId?: string;
  documentName: string;
  sessionId?: string;
  currentPage?: { id: string; name: string };
}

async function sessionInfo(): Promise<SessionInfo> {
  return await call<SessionInfo>('session_info', {});
}

/** Every cache and journal lookup goes through here, so they cannot disagree. */
function fileIdentity(info: Pick<SessionInfo, 'fileKey' | 'fileId'> | null | undefined): string {
  return info?.fileKey ?? info?.fileId ?? 'local';
}

/* ------------------------------------------------------------------ *
 * Server
 * ------------------------------------------------------------------ */

const server = new McpServer({ name: 'figma-forge', version: PLUGIN_VERSION });

server.registerTool(
  'figma_forge_connect',
  {
    title: 'Connect to Figma',
    description:
      'Starts the local bridge if needed and pairs this project with an open Figma Forge plugin session. ' +
      'Run this once per session before any other Figma tool; it reports the channel name to type into the plugin.',
    inputSchema: {
      channel: z.string().optional().describe('Channel name to pair on. Defaults to the project directory name.'),
    },
  },
  async ({ channel }): Promise<ToolResult> => {
    try {
      if (channel) bridge.setChannel(channel);
      await bridge.ready();
      const status = await bridge.status();

      if (!status.figmaAttached) {
        return text({
          bridge: { running: status.bridgeRunning, port: status.port },
          channel: status.channel,
          figmaAttached: false,
          next: [
            'Open the target file in Figma.',
            'Plugins → Development → Figma Forge.',
            `Enter port ${status.port} and channel "${status.channel}", then press Connect.`,
            'Re-run figma_forge_connect to confirm.',
          ],
        });
      }

      const info = await sessionInfo();
      await writeSession({
        channel: status.channel,
        fileKey: info.fileKey,
        fileId: info.fileId,
        documentName: info.documentName,
        sessionId: info.sessionId,
        port: status.port,
        updatedAt: Date.now(),
      });

      const cached = await readIndex<RawIndex>(fileIdentity(info), 'file', PLUGIN_VERSION);

      return text({
        connected: true,
        channel: status.channel,
        port: status.port,
        file: { key: info.fileKey, name: info.documentName, currentPage: info.currentPage },
        designSystemIndex: cached
          ? { cached: true, builtAt: new Date(cached.builtAt).toISOString(), dirtyNodes: cached.dirtyNodeIds.length }
          : { cached: false, hint: 'Run figma_forge_design_system { action: "refresh" } before building anything.' },
      });
    } catch (error) {
      return failure(error);
    }
  }
);

server.registerTool(
  'figma_forge_status',
  {
    title: 'Figma Forge status',
    description: 'Reports bridge, plugin, file, index freshness and recent write operations. Use this when something is not responding.',
    inputSchema: {},
  },
  async (): Promise<ToolResult> => {
    const status = await bridge.status();
    const session = await readSession(status.channel);
    const journals = await listJournals(5);

    let info: SessionInfo | null = null;
    if (status.figmaAttached) {
      try {
        info = await sessionInfo();
      } catch {
        info = null;
      }
    }

    const cached = info || session ? await readIndex<RawIndex>(fileIdentity(info ?? session), 'file', PLUGIN_VERSION) : null;

    return text({
      bridge: { running: status.bridgeRunning, port: status.port, channels: status.channels, lastError: status.lastError },
      agentConnected: status.agentConnected,
      figmaAttached: status.figmaAttached,
      channel: status.channel,
      file: info ? { key: info.fileKey, name: info.documentName, currentPage: info.currentPage } : session ?? null,
      index: cached
        ? { cached: true, builtAt: new Date(cached.builtAt).toISOString(), dirtyNodes: cached.dirtyNodeIds.length }
        : { cached: false },
      dataDirectory: dataDirectory(),
      recentOperations: journals.map((journal) => ({
        operationId: journal.operationId,
        status: journal.status,
        at: new Date(journal.createdAt).toISOString(),
        description: journal.description,
        created: journal.created.length,
        modified: journal.modified.length,
        error: journal.error,
      })),
    });
  }
);

server.registerTool(
  'figma_forge_inspect',
  {
    title: 'Inspect Figma',
    description:
      'Reads the document, a page, the selection, one node, or a CSS-like selector query. ' +
      'Selector syntax: type (FRAME, TEXT, INSTANCE), [name=Card], [name*=btn], combinators (> + ~), :not(), :nth-child(n). ' +
      'Prefer a narrow scope: whole-page reads at depth are expensive.',
    inputSchema: {
      scope: z.enum(['document', 'page', 'selection', 'node', 'query', 'ancestors', 'screenshot']).default('selection'),
      nodeId: z.string().optional(),
      pageId: z.string().optional(),
      selector: z.string().optional().describe('Required for scope "query".'),
      depth: z.number().int().min(0).max(8).optional().describe('Levels of children to include.'),
      detail: z.enum(['compact', 'full']).optional().describe('"full" adds paints, layout and variable bindings.'),
      limit: z.number().int().min(1).max(500).optional(),
      scale: z.number().min(0.1).max(4).optional().describe('Screenshot scale; defaults to a 1024px cap.'),
    },
  },
  async (params): Promise<ToolResult> => {
    try {
      const result = await call<Record<string, unknown>>('inspect', params as Record<string, unknown>);
      if (params.scope === 'screenshot' && result && result.type === 'image') {
        return {
          content: [
            { type: 'text', text: `${result.name} — ${result.width}×${result.height} @${result.scale}x (node ${result.nodeId})` },
            { type: 'image', data: String(result.bytes), mimeType: 'image/png' },
          ],
        };
      }
      return text(result);
    } catch (error) {
      return failure(error);
    }
  }
);

server.registerTool(
  'figma_forge_design_system',
  {
    title: 'Design system',
    description:
      'The design-system index: what components, styles and variables exist and how to use them. ' +
      'Always search here before creating anything — a plan that invents a raw rectangle when a component exists will be rejected. ' +
      'Actions: overview (orientation), search (find assets by intent), resolve (turn a component key into an exact recipe), ' +
      'refresh (rebuild the index), import (pull a library asset into this file), variables (list collections and modes).',
    inputSchema: {
      action: z.enum(['overview', 'search', 'resolve', 'refresh', 'import', 'variables']).default('overview'),
      query: z.string().optional().describe('For action "search": what you need, e.g. "primary button" or "surface background".'),
      kinds: z.array(z.enum(['component', 'style', 'variable', 'library-variable'])).optional(),
      variableType: z.enum(['COLOR', 'FLOAT', 'STRING', 'BOOLEAN']).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      key: z.string().optional().describe('For "resolve": a component or component-set key.'),
      nodeId: z.string().optional().describe('For "resolve": resolve the component behind this node.'),
      componentKey: z.string().optional(),
      variableKey: z.string().optional(),
      styleKey: z.string().optional(),
      scope: z.enum(['file', 'page']).optional().describe('For "refresh": limit the component scan to one page.'),
      pageId: z.string().optional(),
    },
  },
  async (params): Promise<ToolResult> => {
    try {
      const action = params.action ?? 'overview';

      if (action === 'resolve') {
        return text(await call('design_system', { action: 'resolve', key: params.key, nodeId: params.nodeId }));
      }
      if (action === 'import') {
        const result = await call('design_system', {
          action: 'import',
          componentKey: params.componentKey,
          variableKey: params.variableKey,
          styleKey: params.styleKey,
        });
        return text(result);
      }
      if (action === 'variables') {
        return text(await call('design_system', { action: 'variables', scope: params.scope, pageId: params.pageId }, 120_000));
      }

      const info = await sessionInfo();
      const fileKey = fileIdentity(info);
      const scope = params.scope ?? 'file';

      let cached = action === 'refresh' ? null : await readIndex<RawIndex>(fileKey, scope, PLUGIN_VERSION);
      if (!cached) {
        // A full scan is the expensive operation in this whole system, so it
        // happens on an explicit refresh or on the first use — never implicitly
        // on every search.
        const fresh = await call<RawIndex>(
          'design_system',
          { action: 'index', scope, pageId: params.pageId },
          180_000
        );
        cached = await writeIndex(fileKey, scope, PLUGIN_VERSION, fresh);
      }

      if (action === 'refresh') {
        return text({
          refreshed: true,
          builtAt: new Date(cached.builtAt).toISOString(),
          ...overview(cached.index),
        });
      }
      if (action === 'overview') {
        return text({
          cachedAt: new Date(cached.builtAt).toISOString(),
          dirtyNodes: cached.dirtyNodeIds.length,
          ...overview(cached.index),
        });
      }

      if (!params.query) return failure(new Error('action "search" needs a `query`.'));
      const hits = search(cached.index, params.query, {
        kinds: params.kinds as ResultKind[] | undefined,
        variableType: params.variableType,
        limit: params.limit,
      });

      return text({
        query: params.query,
        cachedAt: new Date(cached.builtAt).toISOString(),
        matches: hits.length,
        results: hits,
        next:
          hits.length === 0
            ? 'Nothing matched. Try a broader word, or `action: "overview"` to see what this design system actually contains.'
            : 'Use `action: "resolve"` on the best key to get exact property names and legal variant values before planning a write.',
      });
    } catch (error) {
      return failure(error);
    }
  }
);

server.registerTool(
  'figma_forge_apply_plan',
  {
    title: 'Apply a write plan',
    description:
      'The only sanctioned way to change a Figma file. Applies an ordered list of ops under a journal, so a failure ' +
      'rolls back instead of leaving a half-built screen. Ops reference nodes by id, by "$ref" defined earlier in the ' +
      'same plan, or by "@selection" / "@page" / "@scratch".\n\n' +
      'Ops: create_instance, create_frame, create_text, create_from_svg, clone, set, set_text, ' +
      'set_component_properties, swap_instance, bind_variable, bind_paint_variable, apply_style, move, reorder, ' +
      'rename, resize, remove (quarantines), set_selection, scroll_into_view.\n\n' +
      'Creating raw primitives (frame/text/svg) requires a `reason` on the op explaining why no design-system ' +
      'component fits. Run with dryRun first on anything non-trivial.',
    inputSchema: {
      ops: z.array(z.object({ op: z.string() }).passthrough()).describe('Ordered list of operations.'),
      description: z.string().optional().describe('What this plan is for; stored in the journal.'),
      dryRun: z.boolean().optional().describe('Validate references, components and properties without mutating.'),
      scratch: z.boolean().optional().describe('Build under the Figma Forge scratch page instead of the live target.'),
      rollbackOnError: z.boolean().optional().describe('Default true.'),
      allowRawPrimitives: z.boolean().optional().describe('Skip the "raw primitives need a reason" gate.'),
      verify: z.boolean().optional().describe('Run invariant checks on what changed. Default true for real writes.'),
    },
  },
  async (params): Promise<ToolResult> => {
    try {
      const result = await call<{
        operationId: string;
        ok: boolean;
        dryRun: boolean;
        created: string[];
        modified: string[];
        quarantined: string[];
        journal: unknown[];
        error?: string;
        rolledBack?: unknown;
        offRamps: unknown[];
      }>(
        'apply_plan',
        {
          ops: params.ops,
          description: params.description,
          dryRun: params.dryRun,
          scratch: params.scratch,
          rollbackOnError: params.rollbackOnError,
          allowRawPrimitives: params.allowRawPrimitives,
        },
        180_000
      );

      if (result.dryRun) return text(result);

      const info = await sessionInfo().catch(() => null);
      await writeJournal({
        operationId: result.operationId,
        channel: bridge.channel,
        fileKey: info?.fileKey ?? null,
        description: params.description,
        createdAt: Date.now(),
        status: result.ok ? 'applied' : result.rolledBack ? 'rolled_back' : 'failed',
        error: result.error,
        created: result.created,
        modified: result.modified,
        quarantined: result.quarantined,
        entries: result.journal,
      });

      if (info) {
        await markDirty(fileIdentity(info), 'file', [...result.created, ...result.modified]);
      }

      let verification: unknown;
      if (result.ok && params.verify !== false && (result.created.length || result.modified.length)) {
        try {
          verification = await call('verify', { scope: 'operation', operationId: result.operationId }, 120_000);
        } catch (error) {
          verification = { skipped: error instanceof Error ? error.message : String(error) };
        }
      }

      return text({
        ...result,
        // The full journal is on disk; echoing it back just burns context.
        journal: `${result.journal.length} entries stored (operationId ${result.operationId})`,
        verification,
      });
    } catch (error) {
      return failure(error);
    }
  }
);

server.registerTool(
  'figma_forge_verify',
  {
    title: 'Verify',
    description:
      'Runs design-system and structural invariants over a node, page, selection, or everything a past operation touched. ' +
      'Rules: hardcoded-fill, hardcoded-stroke, hardcoded-text-style, unbound-spacing, detached-instance, ' +
      'missing-autolayout, zero-size, missing-font, broken-style, broken-variable, invalid-component-property, ' +
      'sibling-overlap, off-canvas.',
    inputSchema: {
      scope: z.enum(['node', 'page', 'selection', 'operation']).default('selection'),
      nodeId: z.string().optional(),
      pageId: z.string().optional(),
      operationId: z.string().optional(),
      rules: z.array(z.string()).optional().describe('Only run these rules.'),
      ignore: z.array(z.string()).optional(),
      minSeverity: z.enum(['error', 'warning', 'info']).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
      maxNodes: z.number().int().min(1).max(20000).optional(),
    },
  },
  async (params): Promise<ToolResult> => {
    try {
      return text(await call('verify', params as Record<string, unknown>, 120_000));
    } catch (error) {
      return failure(error);
    }
  }
);

server.registerTool(
  'figma_forge_recover',
  {
    title: 'Recover',
    description:
      'Rolls back or inspects a journalled operation. With no operationId it targets the most recent failed write. ' +
      'Also restores or purges quarantined nodes (Figma Forge never hard-deletes during a plan).',
    inputSchema: {
      action: z.enum(['rollback', 'list', 'restore_quarantine', 'purge_quarantine', 'list_operation']).default('rollback'),
      operationId: z.string().optional(),
      nodeIds: z.array(z.string()).optional(),
    },
  },
  async (params): Promise<ToolResult> => {
    try {
      if (params.action === 'list') {
        return text({ operations: await listJournals(20), dataDirectory: dataDirectory() });
      }

      if (params.action === 'rollback') {
        const journal = params.operationId ? await readJournal(params.operationId) : await latestRecoverable();
        if (!journal) return text({ ok: false, message: 'No stored operation to roll back.' });

        const result = await call<{ ok: boolean; failed: unknown[] }>(
          'recover',
          { action: 'rollback', journal: journal.entries },
          120_000
        );
        await updateJournalStatus(journal.operationId, result.ok ? 'recovered' : 'failed');
        return text({ operationId: journal.operationId, description: journal.description, ...result });
      }

      return text(await call('recover', params as Record<string, unknown>, 120_000));
    } catch (error) {
      return failure(error);
    }
  }
);

server.registerTool(
  'figma_forge_execute',
  {
    title: 'Execute Figma Plugin API code',
    description:
      'The compatibility lane: runs JavaScript inside the Figma plugin sandbox for things the typed ops do not cover. ' +
      'Prefer figma_forge_apply_plan — this lane has no journal and cannot be rolled back.\n\n' +
      'Modes: "read" (default, mutation blocked), "scratch" (mutations confined to the scratch page), ' +
      '"unsafe_in_place" (no guard rails — only with the user\'s explicit go-ahead).\n\n' +
      'In scope: figma, target, scratch, params, select(node, selector), matches, set(node, props), ' +
      'createAutoLayout, screenshot, summarize, rgbToHex, loadFonts, bridge (persistent helper modules), console. ' +
      'The last expression is returned; nodes are serialised to summaries. No fetch, DOM or timers exist here.',
    inputSchema: {
      code: z.string().describe('JavaScript. Top-level await is allowed.'),
      mode: z.enum(['read', 'scratch', 'unsafe_in_place']).default('read'),
      targetId: z.string().optional().describe('Node exposed to the script as `target`.'),
      params: z.record(z.any()).optional().describe('Values exposed to the script as `params`.'),
      use: z.array(z.string()).optional().describe('Persistent helper modules to load, exposed as `modules`.'),
    },
  },
  async (params): Promise<ToolResult> => {
    try {
      const result = await call<{ violations: string[] }>('execute', params as Record<string, unknown>, 120_000);
      return text(result);
    } catch (error) {
      return failure(error);
    }
  }
);

server.registerTool(
  'figma_forge_import_code',
  {
    title: 'Import tokens and components from code',
    description:
      'Brings a codebase\'s design tokens into Figma as variables, and maps Storybook components onto Figma ones.\n\n' +
      'Sources: "css" (custom properties — `:root`, dark-mode blocks, `@theme`), "tailwind" (a v4 CSS theme layer or ' +
      'a v3 tailwind.config.js, which is executed to read its theme), "storybook" (a generated index.json).\n\n' +
      'Actions: "preview" parses and shows what would be created, without touching Figma — always start here. ' +
      '"apply" writes the variables. "map" is Storybook-only and reports which components already exist in Figma ' +
      'and which do not.\n\n' +
      'Imports are source-owned: each variable is stamped with where it came from, so re-importing updates rather ' +
      'than duplicates, and a hand-authored variable is never overwritten without `takeOwnership`.',
    inputSchema: {
      source: z.enum(['css', 'tailwind', 'storybook']),
      path: z.string().describe('Path to the file, resolved against the project directory.'),
      action: z.enum(['preview', 'apply', 'map']).default('preview'),
      collectionName: z.string().optional().describe('Target Figma variable collection. Defaults to "Imported / <file>".'),
      baseMode: z.string().optional().describe('Name for the light/base mode. Default "Light".'),
      darkMode: z.string().optional().describe('Name for the dark mode. Default "Dark".'),
      nameStyle: z.enum(['slash', 'flat']).optional().describe('"slash" turns --color-blue-500 into color/blue/500.'),
      remBase: z.number().optional().describe('Pixels per rem when converting lengths. Default 16.'),
      includeAllSelectors: z.boolean().optional().describe('Read custom properties from every selector, not just root blocks.'),
      takeOwnership: z.boolean().optional().describe('Adopt existing variables that match by name but were authored by hand.'),
      dryRun: z.boolean().optional().describe('For "apply": report what would change without writing.'),
    },
  },
  async (params): Promise<ToolResult> => {
    try {
      const location = await resolveSourcePath(params.path);

      if (params.source === 'storybook') {
        if (params.action === 'apply') {
          return failure(
            new Error(
              'Storybook import does not write components. Figma Forge deliberately does not convert React to ' +
                'editable Figma components — the result is neither faithful nor maintainable. Use action "map" to ' +
                'see which Figma components correspond to your stories, then build or update those with apply_plan.'
            )
          );
        }

        const storybook = await parseStorybook(location.absolute);
        if (params.action === 'preview') {
          return text({
            source: { ...storybook.source, path: location.display },
            componentCount: storybook.components.length,
            components: storybook.components.slice(0, 40),
            truncated: Math.max(0, storybook.components.length - 40),
            warnings: storybook.warnings,
          });
        }

        // "map": score every Storybook component against the cached DS index.
        const info = await sessionInfo();
        const cached = await readIndex<RawIndex>(fileIdentity(info), 'file', PLUGIN_VERSION);
        if (!cached) {
          return failure(
            new Error('No design-system index is cached yet. Run figma_forge_design_system { action: "refresh" } first.')
          );
        }

        const matched: unknown[] = [];
        const missing: unknown[] = [];
        for (const component of storybook.components) {
          let hits: ReturnType<typeof search> = [];
          for (const candidate of component.nameCandidates) {
            const attempt = search(cached.index, candidate, { kinds: ['component'], limit: 3 });
            if (attempt[0] && (!hits[0] || attempt[0].score > hits[0].score)) hits = attempt;
          }
          const best = hits[0];
          // A weak name overlap is not a mapping; saying so is more useful than
          // pairing "Card" with "Discard button".
          if (best && best.score >= 250) {
            matched.push({
              storybook: component.title,
              stories: component.stories,
              figma: { name: best.name, componentKey: best.key, type: best.type },
              confidence: best.score >= 500 ? 'exact-name' : 'partial-name',
              alternatives: hits.slice(1).map((hit) => ({ name: hit.name, key: hit.key })),
            });
          } else {
            missing.push({ storybook: component.title, stories: component.stories, closest: best ? best.name : null });
          }
        }

        const figmaNames = new Set(matched.map((row) => (row as { figma: { name: string } }).figma.name));
        const unmatchedFigma = cached.index.components
          .filter((component) => component.type === 'COMPONENT_SET' || !component.setId)
          .filter((component) => !figmaNames.has(component.name))
          .slice(0, 40)
          .map((component) => component.name);

        return text({
          source: { ...storybook.source, path: location.display },
          matched,
          notInFigma: missing,
          notInStorybook: unmatchedFigma,
          note:
            'Story names are variant candidates, not proof of variants. Confirm against the Figma component with ' +
            'design_system { action: "resolve" } before treating them as legal property values.',
          warnings: storybook.warnings,
        });
      }

      const ir = await importTokenSource(params.source, location.absolute, {
        collectionName: params.collectionName,
        baseMode: params.baseMode,
        darkMode: params.darkMode,
        nameStyle: params.nameStyle,
        remBase: params.remBase,
        includeAllSelectors: params.includeAllSelectors,
      });
      ir.source.path = location.display;

      if (params.action === 'map') return failure(new Error('"map" applies to Storybook only.'));

      if (params.action === 'preview') {
        return text({
          ...summarizeIR(ir),
          outsideProject: location.outsideProject || undefined,
          next: 'Re-run with action "apply" to write these into Figma. Add dryRun to see the create/update split first.',
        });
      }

      const results = await call('import_tokens', { ir, dryRun: params.dryRun, takeOwnership: params.takeOwnership }, 180_000);
      return text({ source: ir.source, results, unsupported: ir.unsupported });
    } catch (error) {
      return failure(error);
    }
  }
);

/**
 * Embedding text per screen. The path carries page and section names, which are
 * often the only human-written words on a screen whose own name is "other".
 */
function screenEmbeddingInput(screen: { name: string; path: string; text: string; componentNames: string[] }): string {
  const body = [screen.path, screen.componentNames.slice(0, 30).join(', '), screen.text]
    .filter(Boolean)
    .join('\n')
    .slice(0, 4000);
  return ollama.documentPrompt(screen.name, body);
}

server.registerTool(
  'figma_forge_graph',
  {
    title: 'Screen graph and semantic search',
    description:
      'Builds a searchable graph of every screen in the file — its text, the components it uses, and where it lives — ' +
      'then searches it by meaning as well as by word. Use this to find things in a large file, where node names are ' +
      'often useless ("other", "Frame 47") and the real signal is the screen\'s text and component usage.\n\n' +
      'Actions: "build" walks the file page by page and indexes it (run once, then after significant changes); ' +
      '"search" finds screens; "screen" shows one screen and what resembles it; "component" lists where a component ' +
      'is used; "status" reports index freshness and whether semantic search is available.\n\n' +
      'Word search always works. Semantic search additionally needs Ollama with an embedding model, and degrades to ' +
      'words alone when it is missing.',
    inputSchema: {
      action: z.enum(['build', 'search', 'screen', 'component', 'status', 'clear']).default('search'),
      query: z.string().optional().describe('For "search": what you are looking for, in any language.'),
      nodeId: z.string().optional().describe('For "screen": the screen id.'),
      componentKey: z.string().optional().describe('For "component": the component key.'),
      limit: z.number().int().min(1).max(50).optional(),
      scope: z.enum(['file', 'page']).optional().describe('For "build": index one page instead of the whole file.'),
      pageId: z.string().optional(),
      embed: z.boolean().optional().describe('For "build": compute embeddings. Default true when Ollama is available.'),
      rebuild: z.boolean().optional().describe('For "build": discard the existing graph first.'),
    },
  },
  async (params): Promise<ToolResult> => {
    try {
      const action = params.action ?? 'search';
      const limit = params.limit ?? 10;

      if (action === 'status') {
        const info = await sessionInfo().catch(() => null);
        const graph = info ? await loadGraph(fileIdentity(info)) : null;
        const embedding = await ollama.status();
        return text({
          graph: graph
            ? {
                built: new Date(graph.builtAt).toISOString(),
                screens: graph.screens.length,
                pagesIndexed: graph.pages.length,
                totalPages: graph.totalPages,
                complete: graph.complete,
                components: graph.components.length,
                embedded: graph.embedding
                  ? { model: graph.embedding.model, vectors: graph.embedding.order.length }
                  : false,
              }
            : null,
          semanticSearch: embedding,
          hint: !graph
            ? 'No graph yet. Run figma_forge_graph { action: "build" }.'
            : !graph.embedding && embedding.reachable && embedding.hasModel
              ? 'Graph exists but has no embeddings. Re-run build to add them.'
              : undefined,
        });
      }

      const info = await sessionInfo();
      const fileId = fileIdentity(info);

      if (action === 'clear') {
        await clearGraph(fileId);
        return text({ cleared: true, fileId });
      }

      if (action === 'build') {
        if (params.rebuild) await clearGraph(fileId);

        const pages: StoredGraph['pages'] = [];
        const screens: StoredGraph['screens'] = [];
        const componentTotals = new Map<string, { name: string; instances: number; screens: number }>();

        let cursor: number | null = 0;
        let totalPages = 0;
        const stats: Record<string, number> = {};
        const started = Date.now();

        // The plugin pages through the file so no single bridge request has to
        // walk 65 pages inside one timeout.
        while (cursor !== null) {
          const chunk: GraphChunk = await call<GraphChunk>(
            'build_graph',
            { scope: params.scope ?? 'file', pageId: params.pageId, startPage: cursor, maxPages: 8 },
            180_000
          );
          pages.push(...chunk.pages);
          screens.push(...chunk.screens);
          totalPages = chunk.totalPages;
          for (const key of Object.keys(chunk.stats)) stats[key] = (stats[key] ?? 0) + chunk.stats[key];
          for (const component of chunk.components) {
            const row = componentTotals.get(component.key) ?? { name: component.name, instances: 0, screens: 0 };
            row.instances += component.instances;
            row.screens += component.screens;
            componentTotals.set(component.key, row);
          }
          cursor = chunk.nextPage;
        }

        const graph: StoredGraph = {
          schemaVersion: 1,
          fileId,
          documentName: info.documentName,
          builtAt: Date.now(),
          pages,
          totalPages,
          complete: params.scope !== 'page',
          screens,
          components: [...componentTotals]
            .map(([key, row]) => ({ key, ...row }))
            .sort((a, b) => b.instances - a.instances),
        };

        const walkMs = Date.now() - started;
        let embedding: Record<string, unknown> = { enabled: false };

        if (params.embed !== false && screens.length) {
          const state = await ollama.status();
          if (!state.reachable || !state.hasModel) {
            embedding = { enabled: false, reason: state.remedy, host: state.host };
          } else {
            const embedStarted = Date.now();
            const vectors = await ollama.embed(screens.map(screenEmbeddingInput));
            graph.embedding = {
              model: state.model,
              dimensions: vectors[0]?.length ?? 0,
              order: screens.map((screen) => screen.id),
              builtAt: Date.now(),
            };
            await saveVectors(fileId, vectors);
            embedding = {
              enabled: true,
              model: state.model,
              vectors: vectors.length,
              dimensions: vectors[0]?.length ?? 0,
              ms: Date.now() - embedStarted,
            };
          }
        }

        await saveGraph(graph);

        return text({
          built: true,
          document: info.documentName,
          pagesIndexed: pages.length,
          totalPages,
          screens: screens.length,
          components: graph.components.length,
          walkMs,
          embedding,
          stats,
          topComponents: graph.components.slice(0, 10),
          next:
            embedding.enabled === false && embedding.reason
              ? 'Word search works now. For semantic search, follow the reason above and re-run build.'
              : 'Try figma_forge_graph { action: "search", query: "…" }.',
        });
      }

      const graph = await loadGraph(fileId);
      if (!graph) {
        return failure(new Error('No graph for this file yet. Run figma_forge_graph { action: "build" } first.'));
      }

      if (action === 'component') {
        if (!params.componentKey) return failure(new Error('action "component" needs a `componentKey`.'));
        const usage = graph.components.find((component) => component.key === params.componentKey);
        const using = graph.screens
          .filter((screen) => screen.componentKeys.includes(params.componentKey!))
          .slice(0, limit)
          .map((screen) => ({ id: screen.id, name: screen.name, path: screen.path }));
        return text({ component: usage ?? { key: params.componentKey, unknown: true }, usedOn: using, shown: using.length });
      }

      if (action === 'screen') {
        if (!params.nodeId) return failure(new Error('action "screen" needs a `nodeId`.'));
        const screen = graph.screens.find((row) => row.id === params.nodeId);
        if (!screen) return failure(new Error(`Screen ${params.nodeId} is not in the graph. Rebuild if the file changed.`));

        // "Similar" here means built from the same parts, which is what someone
        // asking about one screen usually wants to find.
        const keys = new Set(screen.componentKeys);
        const similar = graph.screens
          .filter((row) => row.id !== screen.id)
          .map((row) => ({
            row,
            shared: row.componentKeys.filter((key) => keys.has(key)).length,
          }))
          .filter((entry) => entry.shared > 0)
          .sort((a, b) => b.shared - a.shared)
          .slice(0, limit)
          .map((entry) => ({ id: entry.row.id, name: entry.row.name, path: entry.row.path, sharedComponents: entry.shared }));

        return text({ screen, similar });
      }

      if (!params.query) return failure(new Error('action "search" needs a `query`.'));

      const lexicalIndex = buildLexicalIndex(graph.screens);
      const lexical = lexicalSearch(lexicalIndex, params.query, limit * 3);

      let vector: { index: number; score: number }[] = [];
      let semantic: Record<string, unknown> = { used: false };

      if (graph.embedding) {
        const state = await ollama.status();
        if (state.reachable && state.hasModel) {
          const vectors = await loadVectors(fileId, graph.embedding.dimensions);
          if (vectors.length) {
            const [queryVector] = await ollama.embed([ollama.queryPrompt(params.query)]);
            const positions = new Map(graph.embedding.order.map((id, index) => [id, index]));
            const raw = vectorSearch(vectors, queryVector, limit * 3);
            // Vector rows are ordered by the embedding manifest, which may differ
            // from the current screen order if the graph was rebuilt partially.
            const byId = new Map(graph.screens.map((screen, index) => [screen.id, index]));
            vector = raw
              .map((hit) => {
                const id = graph.embedding!.order[hit.index];
                const screenIndex = byId.get(id);
                return screenIndex === undefined ? null : { index: screenIndex, score: hit.score };
              })
              .filter((hit): hit is { index: number; score: number } => hit !== null);
            semantic = { used: true, model: state.model, indexed: positions.size };
          }
        } else {
          semantic = { used: false, reason: state.remedy };
        }
      } else {
        semantic = { used: false, reason: 'This graph has no embeddings. Re-run build with Ollama available.' };
      }

      const fused = fuse(lexical, vector, limit);
      return text({
        query: params.query,
        semantic,
        matches: fused.length,
        results: fused.map((hit) => {
          const screen = graph.screens[hit.index];
          return {
            id: screen.id,
            name: screen.name,
            path: screen.path,
            size: `${screen.width}×${screen.height}`,
            textPreview: screen.text.slice(0, 160),
            components: screen.componentNames.slice(0, 6),
            why: {
              word: hit.lexicalRank ? `#${hit.lexicalRank}` : null,
              meaning: hit.vectorRank ? `#${hit.vectorRank} (${hit.vectorScore?.toFixed(3)})` : null,
            },
          };
        }),
        note: 'Open one with figma_forge_inspect { scope: "node", nodeId }, or focus it in Figma.',
      });
    } catch (error) {
      if (error instanceof ollama.OllamaUnavailable) {
        return { isError: true, content: [{ type: 'text', text: `${error.message}\n\n${error.remedy}` }] };
      }
      return failure(error);
    }
  }
);

/** Everything a plan reuses and therefore needs a real picture of. */
function thumbnailRequests(ops: PlanOp[]): string[] {
  const out = new Set<string>();
  for (const op of ops) {
    if (op.op === 'create_instance') {
      const key = (op.componentKey ?? op.componentId) as string | undefined;
      if (key) out.add(key);
    } else if (op.op === 'clone') {
      const source = op.node as string | undefined;
      if (source && !source.startsWith('$') && !source.startsWith('@')) out.add(source);
    }
  }
  return [...out];
}

function variableRequests(ops: PlanOp[]): string[] {
  const out = new Set<string>();
  for (const op of ops) {
    if (op.op === 'bind_paint_variable' || op.op === 'bind_variable') {
      const id = op.variableId as string | undefined;
      if (id) out.add(id);
    }
  }
  return [...out];
}

server.registerTool(
  'figma_forge_preview',
  {
    title: 'Preview a plan as HTML',
    description:
      'Renders a write plan to a local HTML file so it can be reviewed and iterated on without touching Figma. ' +
      'The plan is the single source of truth: this renders it, and figma_forge_apply_plan applies the same plan ' +
      'unchanged. The HTML is never converted back into Figma — that is what would produce detached rectangles ' +
      'instead of component instances.\n\n' +
      'Components and cloned nodes are drawn as their real exported pixels; only the containers the plan invents ' +
      'are drawn as CSS boxes, marked with a dashed outline. Use this between drafting a plan and applying it.',
    inputSchema: {
      title: z.string().describe('What is being designed; shown as the preview heading.'),
      ops: z.array(z.object({ op: z.string() }).passthrough()).describe('The same ops array figma_forge_apply_plan takes.'),
      refreshThumbnails: z.boolean().optional().describe('Re-export component images instead of reusing cached ones.'),
      notes: z.array(z.string()).optional().describe('Extra notes to show under the preview.'),
    },
  },
  async (params): Promise<ToolResult> => {
    try {
      const info = await sessionInfo();
      const fileId = fileIdentity(info);
      const outDir = joinPath(ffDataDirectory(), 'preview', fileId.replace(/[^a-zA-Z0-9._-]/g, '_'));
      const thumbDir = joinPath(outDir, 'thumbs');
      await mkdir(thumbDir, { recursive: true });

      const ops = params.ops as unknown as PlanOp[];

      const thumbnails: Record<string, ThumbnailAsset> = {};
      const requests = thumbnailRequests(ops);
      const failures: { requested: string; error: string }[] = [];

      if (requests.length) {
        const result = await call<{
          thumbnails: { id: string; requested: string; name: string; naturalWidth: number; naturalHeight: number; bytes: string }[];
          failed: { requested: string; error: string }[];
        }>('thumbnails', { ids: requests, maxEdge: 900 }, 180_000);

        for (const thumb of result.thumbnails) {
          const name = `${thumb.requested.replace(/[^a-zA-Z0-9._-]/g, '_')}.png`;
          await writeFile(joinPath(thumbDir, name), Buffer.from(thumb.bytes, 'base64'));
          thumbnails[thumb.requested] = {
            file: `thumbs/${name}`,
            name: thumb.name,
            naturalWidth: thumb.naturalWidth,
            naturalHeight: thumb.naturalHeight,
          };
        }
        failures.push(...result.failed);
      }

      const variables: Record<string, VariableValue> = {};
      const variableIds = variableRequests(ops);
      if (variableIds.length) {
        const resolved = await call<Record<string, VariableValue>>('resolve_variables', { ids: variableIds }, 60_000);
        Object.assign(variables, resolved);
      }

      const notes = [...(params.notes ?? [])];
      for (const failure of failures) notes.push(`Could not export ${failure.requested}: ${failure.error}`);

      const rendered = await renderPlan({
        title: params.title,
        ops,
        thumbnails,
        variables,
        outDir,
        notes,
      });

      return text({
        preview: rendered.file,
        open: `file://${rendered.file}`,
        rootFrames: rendered.roots,
        thumbnails: Object.keys(thumbnails).length,
        missingThumbnails: rendered.missing,
        variablesResolved: Object.keys(variables).length,
        next:
          'Open the file to review. Iterate by editing the ops and re-rendering — nothing has touched Figma yet. ' +
          'When it is right, pass the same ops to figma_forge_apply_plan.',
      });
    } catch (error) {
      return failure(error);
    }
  }
);

server.registerTool(
  'figma_forge_modules',
  {
    title: 'Helper modules',
    description:
      'Persistent JavaScript helpers stored inside the Figma document, so a utility survives restarts. ' +
      'Modules are hash-pinned; `figma_forge_execute { use: ["name"] }` loads them.',
    inputSchema: {
      action: z.enum(['list', 'define', 'remove']).default('list'),
      name: z.string().optional(),
      source: z.string().optional().describe('CommonJS-style body assigning to `module.exports`.'),
    },
  },
  async (params): Promise<ToolResult> => {
    try {
      return text(await call('modules', params as Record<string, unknown>));
    } catch (error) {
      return failure(error);
    }
  }
);

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

process.on('SIGINT', () => {
  bridge.close();
  process.exit(0);
});
process.on('SIGTERM', () => {
  bridge.close();
  process.exit(0);
});

// The bridge deliberately outlives this process, so shutdown only drops our own
// socket. Killing it here would disconnect every other Claude Code session.
await server.connect(new StdioServerTransport());
