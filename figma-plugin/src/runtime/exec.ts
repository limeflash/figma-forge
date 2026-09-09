/**
 * The compatibility execution lane.
 *
 * Figma's sandbox binds `eval`, so every call to it is an *indirect* eval that
 * cannot see the caller's scope — code shipped that way silently does nothing
 * useful. `new Function` (here, its async sibling) has none of that problem: the
 * body becomes an ordinary function scope. Nothing in this file ever calls eval.
 *
 * Three modes, in descending order of how often they should be used:
 *
 *   read              inspection only; mutating `figma` factories are blocked
 *                     and any document change that slips through is reported.
 *   scratch           mutations confined to the scratch page; anything touched
 *                     outside it comes back as a violation.
 *   unsafe_in_place   no guard rails. Never used by the bundled skills; it
 *                     exists because some migrations genuinely cannot be
 *                     expressed any other way.
 *
 * The guards are honest rather than absolute: `read` blocks the obvious ways to
 * create nodes, but a determined script can still assign to a node property.
 * That is exactly why change tracking runs alongside — detection is the backstop
 * for what static blocking cannot cover, and the caller always learns the truth.
 */

import { select, matches } from './selector';
import { applyProps, createAutoLayout, ensureShims, screenshot, QueryResult } from './shims';
import { summarizeNode, toJson, rgbToHex, safe } from './serialize';
import { DATA_KEYS, SCRATCH_PAGE, ensurePage, errorMessage, loadFontsFor } from './journal';

type AnyNode = BaseNode & { children?: readonly SceneNode[] };

export type ExecMode = 'read' | 'scratch' | 'unsafe_in_place';

export interface ExecParams {
  code: string;
  mode?: ExecMode;
  /** Node the script should operate on, exposed as `target`. */
  targetId?: string;
  /** Free-form values exposed as `params`. */
  params?: Record<string, unknown>;
  /** Modules to `require` into scope before running. */
  use?: string[];
  timeoutMs?: number;
}

export interface ExecResult {
  mode: ExecMode;
  result: unknown;
  logs: string[];
  changedNodes: string[];
  violations: string[];
  scratchPageId?: string;
  durationMs: number;
}

/* ------------------------------------------------------------------ *
 * Change tracking
 * ------------------------------------------------------------------ */

let trackingReady = false;
let recording: Set<string> | null = null;

/**
 * `documentchange` is only available once every page is loaded, which is the
 * price of `documentAccess: "dynamic-page"`. We pay it lazily and once.
 */
async function ensureChangeTracking(): Promise<boolean> {
  if (trackingReady) return true;
  try {
    await figma.loadAllPagesAsync();
    figma.on('documentchange', (event) => {
      if (!recording) return;
      for (const change of event.documentChanges) {
        const id = (change as { id?: string }).id;
        if (id) recording.add(id);
      }
    });
    trackingReady = true;
  } catch {
    trackingReady = false;
  }
  return trackingReady;
}

/**
 * The sandbox has no timers we can rely on, so we yield by awaiting real async
 * Figma calls — each one hands control back to the host, which is when queued
 * `documentchange` events get delivered.
 */
async function flushEvents(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try {
      await figma.getNodeByIdAsync(figma.root.id);
    } catch {
      return;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Persistent helper modules
 * ------------------------------------------------------------------ */

const MODULE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
/** setPluginData entries are capped by Figma; stay well under it. */
const MODULE_MAX_BYTES = 80 * 1024;

export interface StoredModule {
  name: string;
  hash: string;
  source: string;
  savedAt: number;
}

/** FNV-1a. Not cryptographic — it exists so `require` can pin a known version. */
export function hashSource(source: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

const compiled = new Map<string, unknown>();

export function defineModule(name: string, source: string): StoredModule {
  if (!MODULE_NAME.test(name)) {
    throw new Error(`Invalid module name "${name}" — use letters, digits, dot, dash or underscore.`);
  }
  if (typeof source !== 'string' || !source.trim()) {
    throw new Error(`Module "${name}" needs a non-empty source string.`);
  }
  if (source.length > MODULE_MAX_BYTES) {
    throw new Error(`Module "${name}" is ${source.length} bytes; the limit is ${MODULE_MAX_BYTES}.`);
  }

  const record: StoredModule = { name, hash: hashSource(source), source, savedAt: Date.now() };
  figma.root.setPluginData(DATA_KEYS.module + name, JSON.stringify(record));
  compiled.delete(name);
  return record;
}

export function readModule(name: string): StoredModule | null {
  const raw = safe(() => figma.root.getPluginData(DATA_KEYS.module + name));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredModule;
  } catch {
    return null;
  }
}

export function listModules(): { name: string; hash: string; savedAt: number; bytes: number }[] {
  const keys = safe(() => figma.root.getPluginDataKeys()) ?? [];
  const out = [];
  for (const key of keys) {
    if (key.indexOf(DATA_KEYS.module) !== 0) continue;
    const record = readModule(key.slice(DATA_KEYS.module.length));
    if (record) out.push({ name: record.name, hash: record.hash, savedAt: record.savedAt, bytes: record.source.length });
  }
  return out;
}

export function removeModule(name: string): boolean {
  const existed = !!readModule(name);
  figma.root.setPluginData(DATA_KEYS.module + name, '');
  compiled.delete(name);
  return existed;
}

/**
 * Compiles and caches a stored module. `expectedHash` is the pin: a module whose
 * source changed underneath a caller fails loudly instead of running something
 * the caller never reviewed.
 */
export function requireModule(name: string, expectedHash?: string): unknown {
  const record = readModule(name);
  if (!record) throw new Error(`Module "${name}" is not defined in this document.`);
  if (expectedHash && record.hash !== expectedHash) {
    throw new Error(`Module "${name}" hash is ${record.hash}, expected ${expectedHash}.`);
  }
  if (compiled.has(name)) return compiled.get(name);

  const factory = new Function(
    'module',
    'exports',
    'require',
    'figma',
    '"use strict";\n' + record.source + '\n;return module.exports;'
  );
  const module = { exports: {} as Record<string, unknown> };
  const exported = factory(module, module.exports, (dep: string) => requireModule(dep), figma);
  compiled.set(name, exported);
  return exported;
}

export const moduleRegistry = {
  define: defineModule,
  require: requireModule,
  list: listModules,
  remove: removeModule,
  hash: hashSource,
};

/* ------------------------------------------------------------------ *
 * Read-mode guard
 * ------------------------------------------------------------------ */

const BLOCKED_IN_READ = [
  'createFrame', 'createRectangle', 'createEllipse', 'createLine', 'createPolygon',
  'createStar', 'createVector', 'createText', 'createComponent', 'createComponentFromNode',
  'createPage', 'createSlice', 'createNodeFromSvg', 'createImage', 'createImageAsync',
  'createGif', 'createLinkPreviewAsync', 'createVideoAsync', 'createBooleanOperation',
  'createSection', 'createSlide', 'createSlideRow', 'createAutoLayout',
  'combineAsVariants', 'group', 'flatten', 'union', 'subtract', 'intersect', 'exclude',
  'ungroup', 'createPaintStyle', 'createTextStyle', 'createEffectStyle', 'createGridStyle',
  'saveVersionHistoryAsync', 'commitUndo', 'triggerUndo',
];

/**
 * A read-mode stand-in for `figma`.
 *
 * The obvious implementation — a Proxy whose `get` trap swaps blocked methods —
 * does not work. `figma` exposes non-configurable, non-writable own properties,
 * and returning anything other than the original value for one violates a Proxy
 * invariant: real files fail with `proxy: inconsistent get` instead of the
 * helpful message the trap was written to produce.
 *
 * So this builds a plain object that forwards every property through a getter.
 * A plain object has no invariants to break, live getters like `currentPage`
 * still reflect the real editor state, and blocked methods can say why.
 */
function guardedNamespace(
  target: object,
  isBlocked: (key: string) => string | null
): Record<string, unknown> {
  const facade: Record<string, unknown> = {};
  const keys = new Set<string>();

  let current: object | null = target;
  while (current && current !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(current)) keys.add(key);
    current = Object.getPrototypeOf(current);
  }

  for (const key of keys) {
    if (key === 'constructor') continue;
    const reason = isBlocked(key);
    if (reason) {
      Object.defineProperty(facade, key, {
        enumerable: true,
        get: () => () => {
          throw new Error(reason);
        },
      });
      continue;
    }
    Object.defineProperty(facade, key, {
      enumerable: true,
      get() {
        const value = (target as Record<string, unknown>)[key];
        // Host methods need their real receiver, not the facade.
        return typeof value === 'function' ? (value as Function).bind(target) : value;
      },
    });
  }

  return facade;
}

function readOnlyFigma(): typeof figma {
  const blocked = new Set(BLOCKED_IN_READ);

  const facade = guardedNamespace(figma, (key) =>
    blocked.has(key)
      ? `${key}() is blocked in read mode. Re-run with mode "scratch" to build, ` +
        'or "unsafe_in_place" if this must mutate the live document.'
      : null
  );

  // `figma.variables` is where the other half of the mutation surface lives.
  try {
    const variables = guardedNamespace(figma.variables, (key) =>
      key.indexOf('create') === 0 || key === 'setBoundVariableForPaint'
        ? `figma.variables.${key}() is blocked in read mode.`
        : null
    );
    Object.defineProperty(facade, 'variables', { enumerable: true, get: () => variables });
  } catch {
    /* leave the forwarded property in place */
  }

  return facade as unknown as typeof figma;
}

/* ------------------------------------------------------------------ *
 * Execution
 * ------------------------------------------------------------------ */

const AsyncFunction = Object.getPrototypeOf(async function () {
  /* probe */
}).constructor as FunctionConstructor;

function isUnder(node: BaseNode | null, ancestorId: string): boolean {
  let current: BaseNode | null = node;
  while (current) {
    if (current.id === ancestorId) return true;
    current = (current as SceneNode).parent as BaseNode | null;
  }
  return false;
}

export async function execute(params: ExecParams): Promise<ExecResult> {
  const mode: ExecMode = params.mode ?? 'read';
  const started = Date.now();
  const logs: string[] = [];

  if (typeof params.code !== 'string' || !params.code.trim()) {
    throw new Error('execute requires a non-empty `code` string.');
  }

  let scratch: PageNode | null = null;
  if (mode === 'scratch') scratch = await ensurePage(SCRATCH_PAGE);

  let target: AnyNode | null = null;
  if (params.targetId) {
    target = (await figma.getNodeByIdAsync(params.targetId)) as AnyNode | null;
    if (!target) throw new Error(`Target node ${params.targetId} was not found.`);
    ensureShims(target);
  }

  const modules: Record<string, unknown> = {};
  for (const name of params.use ?? []) modules[name] = requireModule(name);

  const capture = (level: string) => (...args: unknown[]) => {
    const line = args
      .map((arg) => {
        if (typeof arg === 'string') return arg;
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(' ');
    logs.push(level === 'log' ? line : `[${level}] ${line}`);
    if (logs.length > 500) logs.shift();
  };

  const context: Record<string, unknown> = {
    figma: mode === 'read' ? readOnlyFigma() : figma,
    target,
    scratch,
    params: params.params ?? {},
    modules,
    bridge: moduleRegistry,
    select: (root: AnyNode, selector: string) => new QueryResult(select(root, selector)),
    matches,
    set: applyProps,
    createAutoLayout,
    screenshot,
    summarize: summarizeNode,
    rgbToHex,
    loadFonts: loadFontsFor,
    console: { log: capture('log'), warn: capture('warn'), error: capture('error'), info: capture('log') },
  };

  const trackable = await ensureChangeTracking();
  const changes = new Set<string>();
  if (trackable) recording = changes;

  let value: unknown;
  try {
    const keys = Object.keys(context);
    const values = keys.map((key) => context[key]);
    const fn = compileBody(params.code, keys);
    value = await fn.apply(undefined, values);
  } finally {
    if (trackable) {
      await flushEvents();
      recording = null;
    }
  }

  const violations: string[] = [];
  const changedNodes = [...changes];

  if (!trackable) {
    violations.push(
      'Document change tracking is unavailable in this file, so mutations outside the ' +
        'requested scope cannot be detected. Treat the result as unverified.'
    );
  } else if (mode === 'read' && changedNodes.length) {
    violations.push(`read mode mutated ${changedNodes.length} node(s): ${changedNodes.slice(0, 20).join(', ')}`);
  } else if (mode === 'scratch' && scratch) {
    const strays: string[] = [];
    for (const id of changedNodes) {
      if (id === scratch.id) continue;
      const node = await figma.getNodeByIdAsync(id).catch(() => null);
      // A node that is already gone was almost certainly created and removed
      // inside the script; that is legitimate scratch work.
      if (node && !isUnder(node, scratch.id)) strays.push(id);
    }
    if (strays.length) {
      violations.push(`scratch mode touched ${strays.length} node(s) outside the scratch page: ${strays.slice(0, 20).join(', ')}`);
    }
  }

  return {
    mode,
    result: await toJson(value),
    logs,
    changedNodes,
    violations,
    scratchPageId: scratch ? scratch.id : undefined,
    durationMs: Date.now() - started,
  };
}

/**
 * Accepts either an expression (`figma.currentPage.name`) or a statement body
 * (`const x = …; return x`). Expression form is tried first because it is what
 * short inspection snippets look like, and a SyntaxError there is cheap.
 */
function compileBody(code: string, keys: string[]): (...args: unknown[]) => Promise<unknown> {
  const body = code.trim();
  if (!/\breturn\b/.test(body)) {
    try {
      return new AsyncFunction(...keys, `"use strict"; return (\n${body}\n);`) as (...args: unknown[]) => Promise<unknown>;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  try {
    return new AsyncFunction(...keys, `"use strict";\n${body}\n`) as (...args: unknown[]) => Promise<unknown>;
  } catch (error) {
    throw new Error(`Could not compile the script: ${errorMessage(error)}`);
  }
}
