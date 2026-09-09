/**
 * Sandbox parity shims.
 *
 * Figma's hosted `use_figma` sandbox augments the Plugin API with helpers that
 * do NOT exist in a normal plugin: `node.query()`, `node.set()`,
 * `figma.createAutoLayout()`, `node.screenshot()` and `node.placeholder`.
 * Figma's own published reference corpus leans on them heavily, so we install
 * equivalents here. That parity is what lets us ship their documentation as-is
 * instead of maintaining a rival dialect.
 *
 * Measured against a real file: Figma gives every node type its own prototype
 * (FrameNode 189 own keys, TextNode 205, InstanceNode 198, SectionNode 98) with
 * no shared base, and individual nodes are not extensible — defining a property
 * on one throws `object is not extensible`. So there is no single place to
 * install, and no per-node fallback either.
 *
 * Instead we install lazily, once per prototype, the first time a node of that
 * type is seen. That costs a WeakSet lookup and covers exactly the types a
 * session actually touches, without creating a throwaway node of every type.
 */

import { select, matches } from './selector';

type AnyNode = BaseNode & { children?: readonly SceneNode[] };

/** Properties that must be applied before anything that depends on layout. */
const PRIORITY_KEYS = ['layoutMode', 'layoutWrap', 'primaryAxisSizingMode', 'counterAxisSizingMode'];

/** Applied last: sizing is rejected until the node sits in a layout context. */
const DEFERRED_KEYS = ['layoutSizingHorizontal', 'layoutSizingVertical', 'layoutAlign', 'layoutGrow'];

export class QueryResult {
  private readonly nodes: AnyNode[];

  constructor(nodes: AnyNode[]) {
    this.nodes = nodes;
    // Anything that came out of a query is about to be used as a node, so this
    // is the natural place to make sure its type has been shimmed.
    ensureShims(nodes);
  }

  get length(): number {
    return this.nodes.length;
  }

  first(): AnyNode | null {
    return this.nodes[0] ?? null;
  }

  last(): AnyNode | null {
    return this.nodes[this.nodes.length - 1] ?? null;
  }

  toArray(): AnyNode[] {
    return [...this.nodes];
  }

  each(fn: (node: AnyNode, index: number) => void): this {
    this.nodes.forEach(fn);
    return this;
  }

  map<T>(fn: (node: AnyNode, index: number) => T): T[] {
    return this.nodes.map(fn);
  }

  filter(fn: (node: AnyNode, index: number) => boolean): QueryResult {
    return new QueryResult(this.nodes.filter(fn));
  }

  /** Extracts a subset of properties from each match, skipping throwing getters. */
  values(keys: string[]): Record<string, unknown>[] {
    return this.nodes.map((node) => {
      const row: Record<string, unknown> = {};
      for (const key of keys) {
        try {
          row[key] = (node as unknown as Record<string, unknown>)[key];
        } catch {
          row[key] = undefined;
        }
      }
      return row;
    });
  }

  set(props: Record<string, unknown>): this {
    for (const node of this.nodes) applyProps(node, props);
    return this;
  }

  query(selector: string): QueryResult {
    const seen = new Set<string>();
    const out: AnyNode[] = [];
    for (const node of this.nodes) {
      for (const match of select(node, selector)) {
        if (seen.has(match.id)) continue;
        seen.add(match.id);
        out.push(match);
      }
    }
    return new QueryResult(out);
  }

  [Symbol.iterator](): Iterator<AnyNode> {
    return this.nodes[Symbol.iterator]();
  }
}

/**
 * Batch property assignment matching `node.set()` semantics: layout keys are
 * applied first, `width`/`height` route through `resize()`, and sizing keys are
 * applied last so they see their final structural context.
 */
export function applyProps(node: AnyNode, props: Record<string, unknown>): AnyNode {
  const target = node as unknown as Record<string, unknown>;
  const deferred: [string, unknown][] = [];
  let width: number | undefined;
  let height: number | undefined;

  const assign = (key: string, value: unknown) => {
    if (key === 'width') {
      width = value as number;
      return;
    }
    if (key === 'height') {
      height = value as number;
      return;
    }
    if (DEFERRED_KEYS.includes(key)) {
      deferred.push([key, value]);
      return;
    }
    target[key] = value;
  };

  for (const key of PRIORITY_KEYS) {
    if (key in props) assign(key, props[key]);
  }
  for (const [key, value] of Object.entries(props)) {
    if (PRIORITY_KEYS.includes(key)) continue;
    assign(key, value);
  }

  if (width !== undefined || height !== undefined) {
    const resizable = node as unknown as { resize?: (w: number, h: number) => void; width: number; height: number };
    if (typeof resizable.resize === 'function') {
      resizable.resize(width ?? resizable.width, height ?? resizable.height);
    }
  }

  // resize() resets sizing modes to FIXED, so these have to come afterwards.
  for (const [key, value] of deferred) target[key] = value;
  return node;
}

/** Prototypes we have already extended. Keyed by identity, never by node type. */
const shimmedPrototypes = new WeakSet<object>();
const installedNames = new Set<string>();

function definePrototypeMember(proto: object, name: string, descriptor: PropertyDescriptor): boolean {
  try {
    if (Object.getOwnPropertyDescriptor(proto, name)) return true;
    Object.defineProperty(proto, name, { configurable: true, ...descriptor });
    return true;
  } catch {
    return false;
  }
}

function installOnPrototype(proto: object): boolean {
  const ok: boolean[] = [];

  ok.push(
    definePrototypeMember(proto, 'query', {
      value: function (this: AnyNode, selector: string) {
        return new QueryResult(select(this, selector));
      },
      writable: true,
    })
  );

  ok.push(
    definePrototypeMember(proto, 'set', {
      value: function (this: AnyNode, props: Record<string, unknown>) {
        return applyProps(this, props);
      },
      writable: true,
    })
  );

  ok.push(
    definePrototypeMember(proto, 'matches', {
      value: function (this: AnyNode, selector: string) {
        return matches(this, selector);
      },
      writable: true,
    })
  );

  ok.push(
    definePrototypeMember(proto, 'screenshot', {
      value: function (this: AnyNode, opts?: { scale?: number; contentsOnly?: boolean }) {
        return screenshot(this, opts);
      },
      writable: true,
    })
  );

  // `placeholder` is a hosted-sandbox affordance with no Plugin API analogue.
  // Accept and remember it so corpus code that toggles it does not throw, and
  // surface it through node metadata rather than silently dropping it.
  ok.push(
    definePrototypeMember(proto, 'placeholder', {
      get(this: AnyNode) {
        return placeholderState.get(this.id) ?? false;
      },
      set(this: AnyNode, value: boolean) {
        if (value) placeholderState.set(this.id, true);
        else placeholderState.delete(this.id);
      },
    })
  );

  return ok.every(Boolean);
}

/**
 * Installs the shims for whatever node types these nodes are, once each.
 * Safe and cheap to call on every query result.
 */
export function ensureShims(nodes: AnyNode | readonly AnyNode[] | null | undefined): void {
  if (!nodes) return;
  const list = Array.isArray(nodes) ? nodes : [nodes as AnyNode];
  for (const node of list) {
    if (!node) continue;
    let proto: object | null;
    try {
      proto = Object.getPrototypeOf(node);
    } catch {
      continue;
    }
    if (!proto || proto === Object.prototype || shimmedPrototypes.has(proto)) continue;
    shimmedPrototypes.add(proto);
    if (installOnPrototype(proto)) {
      const name = (proto as { constructor?: { name?: string } }).constructor?.name;
      if (name) installedNames.add(name);
    }
  }
}

export interface ShimReport {
  prototypeShimmed: boolean;
  installed: string[];
  shimmedTypes: string[];
}

let report: ShimReport | null = null;

/**
 * Startup pass: extend `figma` itself, and shim the node types reachable
 * without creating anything. Everything else is picked up lazily.
 */
export function installShims(): ShimReport {
  if (report) return report;

  const installed: string[] = [];

  const reachable: AnyNode[] = [];
  try {
    reachable.push(figma.root as unknown as AnyNode, figma.currentPage as unknown as AnyNode);
    for (const child of figma.currentPage.children.slice(0, 50)) reachable.push(child as unknown as AnyNode);
  } catch {
    /* an empty or unloaded page is fine; lazy installation covers it */
  }
  ensureShims(reachable);
  if (installedNames.size) installed.push('query', 'set', 'matches', 'screenshot', 'placeholder');

  // `figma` itself is a plain host object; extending it is reliable.
  try {
    const host = figma as unknown as Record<string, unknown>;
    if (typeof host.createAutoLayout !== 'function') {
      host.createAutoLayout = createAutoLayout;
      installed.push('figma.createAutoLayout');
    }
  } catch {
    /* leave it out; exec still exposes createAutoLayout as a free function */
  }

  report = { prototypeShimmed: installedNames.size > 0, installed, shimmedTypes: [...installedNames] };
  return report;
}

/** Reflects lazily shimmed types too, so status is accurate mid-session. */
export function shimReport(): ShimReport {
  const base = installShims();
  return { ...base, shimmedTypes: [...installedNames] };
}

const placeholderState = new Map<string, boolean>();

export function placeholderIds(): string[] {
  return [...placeholderState.keys()];
}

/**
 * `figma.createAutoLayout(direction?, props?)` — an auto-layout frame that hugs
 * on both axes, matching the hosted sandbox's default.
 */
export function createAutoLayout(
  directionOrProps?: 'HORIZONTAL' | 'VERTICAL' | Record<string, unknown>,
  maybeProps?: Record<string, unknown>
): FrameNode {
  let direction: 'HORIZONTAL' | 'VERTICAL' = 'HORIZONTAL';
  let props: Record<string, unknown> | undefined;

  if (typeof directionOrProps === 'string') {
    direction = directionOrProps;
    props = maybeProps;
  } else {
    props = directionOrProps;
  }

  const frame = figma.createFrame();
  frame.layoutMode = direction;
  frame.primaryAxisSizingMode = 'AUTO';
  frame.counterAxisSizingMode = 'AUTO';
  if (props) applyProps(frame as unknown as AnyNode, props);
  return frame;
}

export interface Screenshot {
  type: 'image';
  format: 'PNG';
  nodeId: string;
  name: string;
  width: number;
  height: number;
  scale: number;
  bytes: string;
}

/**
 * Exports a node as base64 PNG. Mirrors the hosted `node.screenshot()` default
 * of 0.5x capped so the longest edge stays at or under 1024px.
 */
export async function screenshot(
  node: AnyNode,
  opts?: { scale?: number; contentsOnly?: boolean }
): Promise<Screenshot> {
  const exportable = node as unknown as SceneNode & {
    exportAsync: (settings: ExportSettings) => Promise<Uint8Array>;
    width: number;
    height: number;
  };
  if (typeof exportable.exportAsync !== 'function') {
    throw new Error(`Node ${node.id} (${node.type}) cannot be exported`);
  }

  let scale = opts?.scale;
  if (scale == null) {
    scale = 0.5;
    const longest = Math.max(exportable.width, exportable.height) * scale;
    if (longest > 1024) scale = 1024 / Math.max(exportable.width, exportable.height);
  }

  const bytes = await exportable.exportAsync({
    format: 'PNG',
    constraint: { type: 'SCALE', value: scale },
    contentsOnly: opts?.contentsOnly ?? true,
  } as ExportSettings);

  return {
    type: 'image',
    format: 'PNG',
    nodeId: node.id,
    name: `${node.name} (${Math.round(exportable.width)}x${Math.round(exportable.height)}).png`,
    width: Math.round(exportable.width * scale),
    height: Math.round(exportable.height * scale),
    scale,
    bytes: encodeBase64(bytes),
  };
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** The sandbox has no btoa and no Buffer, so encode by hand. */
export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += BASE64_ALPHABET[(triple >> 18) & 63];
    out += BASE64_ALPHABET[(triple >> 12) & 63];
    out += b === undefined ? '=' : BASE64_ALPHABET[(triple >> 6) & 63];
    out += c === undefined ? '=' : BASE64_ALPHABET[triple & 63];
  }
  return out;
}
