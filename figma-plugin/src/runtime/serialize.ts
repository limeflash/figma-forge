/**
 * Node -> JSON summaries.
 *
 * Everything crossing the bridge has to be plain JSON, and Figma nodes are host
 * objects whose getters throw depending on node type (`.characters` on a frame,
 * `.mainComponent` on anything but an instance, and so on). Every read here goes
 * through `safe()` so one hostile getter cannot sink a whole inspection.
 *
 * Summaries are deliberately lossy and tunable: a page-level scan wants ids,
 * names and types, while a single-node inspection wants paints and bindings.
 */

type AnyNode = BaseNode & { children?: readonly SceneNode[] };

export interface SummaryOptions {
  /** Levels of children to include. 0 = the node alone. */
  depth?: number;
  geometry?: boolean;
  paints?: boolean;
  layout?: boolean;
  /** boundVariables + style ids, resolved to names where cheap. */
  bindings?: boolean;
  componentInfo?: boolean;
  text?: boolean;
  maxChildren?: number;
}

const DEFAULTS: Required<SummaryOptions> = {
  depth: 0,
  geometry: true,
  paints: false,
  layout: false,
  bindings: false,
  componentInfo: true,
  text: true,
  maxChildren: 200,
};

export const MIXED = 'MIXED';

/** Reads a property that may throw or be `figma.mixed`. */
export function safe<T>(read: () => T): T | undefined {
  try {
    const value = read();
    if (value === figma.mixed) return MIXED as unknown as T;
    return value === undefined ? undefined : value;
  } catch {
    return undefined;
  }
}

export function rgbToHex(color: RGB | RGBA): string {
  const channel = (v: number) => {
    const n = Math.round(Math.max(0, Math.min(1, v)) * 255);
    return (n < 16 ? '0' : '') + n.toString(16);
  };
  const alpha = (color as RGBA).a;
  const base = `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
  return alpha === undefined || alpha >= 1 ? base : base + channel(alpha);
}

/** Name lookups are re-resolved constantly during a scan; keep them cheap. */
const variableNames = new Map<string, string | null>();
const styleNames = new Map<string, string | null>();

export function resetNameCaches(): void {
  variableNames.clear();
  styleNames.clear();
}

export async function variableName(id: string): Promise<string | null> {
  if (variableNames.has(id)) return variableNames.get(id)!;
  let name: string | null = null;
  try {
    const variable = await figma.variables.getVariableByIdAsync(id);
    name = variable ? variable.name : null;
  } catch {
    name = null;
  }
  variableNames.set(id, name);
  return name;
}

export async function styleName(id: string): Promise<string | null> {
  if (styleNames.has(id)) return styleNames.get(id)!;
  let name: string | null = null;
  try {
    const style = await figma.getStyleByIdAsync(id);
    name = style ? style.name : null;
  } catch {
    name = null;
  }
  styleNames.set(id, name);
  return name;
}

export interface PaintSummary {
  type: string;
  visible?: boolean;
  opacity?: number;
  color?: string;
  boundVariable?: string;
}

export function summarizePaints(paints: readonly Paint[] | typeof figma.mixed | undefined): PaintSummary[] | string | undefined {
  if (paints === undefined) return undefined;
  if (paints === figma.mixed || (paints as unknown) === MIXED) return MIXED;
  if (!Array.isArray(paints)) return undefined;
  return paints.map((paint) => {
    const row: PaintSummary = { type: paint.type };
    if (paint.visible === false) row.visible = false;
    if (paint.opacity !== undefined && paint.opacity < 1) row.opacity = paint.opacity;
    if (paint.type === 'SOLID') row.color = rgbToHex((paint as SolidPaint).color);
    const bound = (paint as { boundVariables?: { color?: VariableAlias } }).boundVariables;
    if (bound && bound.color) row.boundVariable = bound.color.id;
    return row;
  });
}

/** `boundVariables` flattened to `field -> variable id(s)`, with names attached. */
export async function summarizeBindings(node: AnyNode): Promise<Record<string, unknown> | undefined> {
  const bound = safe(() => (node as unknown as { boundVariables?: Record<string, unknown> }).boundVariables);
  if (!bound || typeof bound !== 'object') return undefined;

  const out: Record<string, unknown> = {};
  for (const field of Object.keys(bound)) {
    const value = (bound as Record<string, unknown>)[field];
    if (Array.isArray(value)) {
      const rows = [];
      for (const alias of value as VariableAlias[]) {
        if (!alias || !alias.id) continue;
        rows.push({ id: alias.id, name: await variableName(alias.id) });
      }
      if (rows.length) out[field] = rows;
    } else if (value && (value as VariableAlias).id) {
      const id = (value as VariableAlias).id;
      out[field] = { id, name: await variableName(id) };
    }
  }
  return Object.keys(out).length ? out : undefined;
}

async function summarizeStyles(node: AnyNode): Promise<Record<string, unknown> | undefined> {
  const fields: [string, string][] = [
    ['fillStyleId', 'fill'],
    ['strokeStyleId', 'stroke'],
    ['textStyleId', 'text'],
    ['effectStyleId', 'effect'],
    ['gridStyleId', 'grid'],
  ];
  const out: Record<string, unknown> = {};
  for (const [field, label] of fields) {
    const id = safe(() => (node as unknown as Record<string, unknown>)[field]) as string | undefined;
    if (!id || id === MIXED) {
      if (id === MIXED) out[label] = MIXED;
      continue;
    }
    out[label] = { id, name: await styleName(id) };
  }
  return Object.keys(out).length ? out : undefined;
}

export interface NodeSummary {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  locked?: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  opacity?: number;
  characters?: string;
  fontName?: unknown;
  fontSize?: unknown;
  hasMissingFont?: boolean;
  layout?: Record<string, unknown>;
  fills?: PaintSummary[] | string;
  strokes?: PaintSummary[] | string;
  cornerRadius?: unknown;
  effects?: { type: string; visible?: boolean }[];
  styles?: Record<string, unknown>;
  boundVariables?: Record<string, unknown>;
  component?: Record<string, unknown>;
  componentProperties?: Record<string, unknown>;
  childCount?: number;
  children?: NodeSummary[];
  truncatedChildren?: number;
  pluginData?: Record<string, string>;
}

const LAYOUT_FIELDS = [
  'layoutMode',
  'layoutWrap',
  'primaryAxisSizingMode',
  'counterAxisSizingMode',
  'primaryAxisAlignItems',
  'counterAxisAlignItems',
  'itemSpacing',
  'counterAxisSpacing',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'layoutSizingHorizontal',
  'layoutSizingVertical',
  'layoutAlign',
  'layoutGrow',
  'layoutPositioning',
  'clipsContent',
  'overflowDirection',
];

const round = (n: unknown): unknown => (typeof n === 'number' ? Math.round(n * 100) / 100 : n);

export async function summarizeNode(node: AnyNode, options?: SummaryOptions): Promise<NodeSummary> {
  const opts = { ...DEFAULTS, ...(options ?? {}) };
  const summary: NodeSummary = { id: node.id, name: node.name, type: node.type };

  const visible = safe(() => (node as SceneNode).visible);
  if (visible === false) summary.visible = false;
  const locked = safe(() => (node as SceneNode).locked);
  if (locked === true) summary.locked = true;

  if (opts.geometry) {
    summary.x = round(safe(() => (node as unknown as { x: number }).x)) as number;
    summary.y = round(safe(() => (node as unknown as { y: number }).y)) as number;
    summary.width = round(safe(() => (node as unknown as { width: number }).width)) as number;
    summary.height = round(safe(() => (node as unknown as { height: number }).height)) as number;
    const rotation = safe(() => (node as unknown as { rotation: number }).rotation);
    if (typeof rotation === 'number' && Math.abs(rotation) > 0.01) summary.rotation = round(rotation) as number;
    const opacity = safe(() => (node as unknown as { opacity: number }).opacity);
    if (typeof opacity === 'number' && opacity < 1) summary.opacity = round(opacity) as number;
  }

  if (opts.text && node.type === 'TEXT') {
    const characters = safe(() => (node as unknown as TextNode).characters);
    if (typeof characters === 'string') {
      summary.characters = characters.length > 400 ? characters.slice(0, 400) + '…' : characters;
    }
    summary.fontName = safe(() => (node as unknown as TextNode).fontName);
    summary.fontSize = safe(() => (node as unknown as TextNode).fontSize);
    const missing = safe(() => (node as unknown as TextNode).hasMissingFont);
    if (missing) summary.hasMissingFont = true;
  }

  if (opts.layout) {
    const layout: Record<string, unknown> = {};
    for (const field of LAYOUT_FIELDS) {
      const value = safe(() => (node as unknown as Record<string, unknown>)[field]);
      if (value === undefined || value === 'NONE' || value === null) continue;
      layout[field] = round(value);
    }
    if (Object.keys(layout).length) summary.layout = layout;
  }

  if (opts.paints) {
    const fills = summarizePaints(safe(() => (node as unknown as GeometryMixin).fills) as readonly Paint[]);
    if (fills) summary.fills = fills;
    const strokes = summarizePaints(safe(() => (node as unknown as GeometryMixin).strokes) as readonly Paint[]);
    if (strokes && (typeof strokes === 'string' || strokes.length)) summary.strokes = strokes;
    const radius = safe(() => (node as unknown as { cornerRadius: unknown }).cornerRadius);
    if (radius !== undefined && radius !== 0) summary.cornerRadius = round(radius);
    const effects = safe(() => (node as unknown as BlendMixin).effects);
    if (Array.isArray(effects) && effects.length) {
      summary.effects = effects.map((effect) => ({ type: effect.type, visible: effect.visible }));
    }
  }

  if (opts.bindings) {
    const styles = await summarizeStyles(node);
    if (styles) summary.styles = styles;
    const bindings = await summarizeBindings(node);
    if (bindings) summary.boundVariables = bindings;
  }

  if (opts.componentInfo) {
    if (node.type === 'INSTANCE') {
      const instance = node as InstanceNode;
      const component: Record<string, unknown> = {};
      try {
        const main = await instance.getMainComponentAsync();
        if (main) {
          component.mainComponentId = main.id;
          component.mainComponentName = main.name;
          component.key = main.key;
          component.remote = main.remote;
          const set = main.parent && main.parent.type === 'COMPONENT_SET' ? (main.parent as ComponentSetNode) : null;
          if (set) {
            component.componentSetId = set.id;
            component.componentSetName = set.name;
            component.componentSetKey = safe(() => set.key);
          }
        } else {
          component.detached = true;
        }
      } catch {
        component.mainComponentUnavailable = true;
      }
      summary.component = component;
      const properties = safe(() => instance.componentProperties);
      if (properties && properties !== (MIXED as unknown)) {
        const rows: Record<string, unknown> = {};
        for (const key of Object.keys(properties as object)) {
          const entry = (properties as Record<string, { type: string; value: unknown }>)[key];
          rows[key] = { type: entry.type, value: entry.value };
        }
        summary.componentProperties = rows;
      }
    } else if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
      summary.component = {
        key: safe(() => (node as ComponentNode).key),
        remote: safe(() => (node as ComponentNode).remote),
        description: safe(() => (node as ComponentNode).description),
      };
    }
  }

  const children = safe(() => (node as unknown as ChildrenMixin).children);
  if (Array.isArray(children)) {
    summary.childCount = children.length;
    if (opts.depth > 0) {
      const slice = children.slice(0, opts.maxChildren);
      summary.children = [];
      for (const child of slice) {
        summary.children.push(await summarizeNode(child as AnyNode, { ...opts, depth: opts.depth - 1 }));
      }
      if (children.length > slice.length) summary.truncatedChildren = children.length - slice.length;
    }
  }

  return summary;
}

/** Reads every Figma Forge key we have written on a node. */
export function readForgeData(node: AnyNode, keys: string[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = safe(() => node.getPluginData(key));
    if (value) out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Absolute path from the document root, useful for reporting node locations. */
export function nodePath(node: AnyNode): string {
  const parts: string[] = [];
  let current: BaseNode | null = node;
  while (current && current.type !== 'DOCUMENT') {
    parts.unshift(current.name);
    current = (current as SceneNode).parent as BaseNode | null;
  }
  return parts.join(' / ');
}

/**
 * Converts arbitrary `figma_forge_execute` return values into JSON. Nodes become
 * summaries, cycles are cut, and the whole thing is depth- and size-capped so a
 * stray `return figma.root` cannot wedge the bridge.
 */
export async function toJson(value: unknown, depth = 0, seen = new Set<unknown>()): Promise<unknown> {
  if (value === null || value === undefined) return value ?? null;
  const kind = typeof value;
  if (kind === 'string' || kind === 'number' || kind === 'boolean') return value;
  if (kind === 'function') return `[Function ${(value as { name?: string }).name || 'anonymous'}]`;
  if (kind === 'symbol' || kind === 'bigint') return String(value);
  if (value === figma.mixed) return MIXED;
  if (depth > 6) return '[max depth]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (value instanceof Uint8Array) return { type: 'bytes', length: value.length };
  if (Array.isArray(value)) {
    const slice = value.slice(0, 500);
    const out = [];
    for (const item of slice) out.push(await toJson(item, depth + 1, seen));
    if (value.length > slice.length) out.push(`[+${value.length - slice.length} more]`);
    return out;
  }

  const candidate = value as { id?: unknown; type?: unknown };
  if (typeof candidate.id === 'string' && typeof candidate.type === 'string' && 'name' in (value as object)) {
    return await summarizeNode(value as AnyNode, { depth: 0 });
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as object)) {
    out[key] = await toJson((value as Record<string, unknown>)[key], depth + 1, seen);
  }
  return out;
}
