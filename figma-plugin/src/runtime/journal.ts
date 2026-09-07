/**
 * Write journal and simulated rollback.
 *
 * Figma has no transaction primitive. `figma.commitUndo()` gives us one undo
 * boundary per commit, but undo is a user-facing stack we do not own: a thrown
 * script, a later manual edit, or a second plugin can all make it ambiguous. So
 * the journal is authoritative — every mutation records the inverse operation
 * needed to walk it back, and recovery replays those inverses newest-first.
 *
 * The journal is produced here and handed to the MCP server, which persists it
 * under CLAUDE_PLUGIN_DATA. Keeping durable state out of the plugin means a
 * closed Figma tab does not destroy the only record of a half-applied write.
 */

import { safe } from './serialize';

type AnyNode = BaseNode & { children?: readonly SceneNode[] };

export const DATA_KEYS = {
  operation: 'ff.operation',
  createdBy: 'ff.createdBy',
  quarantinedFrom: 'ff.quarantinedFrom',
  module: 'ff.module.',
} as const;

export const SCRATCH_PAGE = '⚙︎ Figma Forge scratch';
export const QUARANTINE_PAGE = '⚠︎ Figma Forge quarantine';

export type InverseOp =
  | { kind: 'remove'; nodeId: string }
  | { kind: 'restore_props'; nodeId: string; props: Record<string, unknown> }
  | { kind: 'reparent'; nodeId: string; parentId: string; index: number }
  | { kind: 'restore_text'; nodeId: string; characters: string }
  | { kind: 'restore_component_properties'; nodeId: string; properties: Record<string, unknown> }
  | { kind: 'restore_bindings'; nodeId: string; field: string; variableId: string | null }
  | { kind: 'restore_style'; nodeId: string; field: string; styleId: string | null }
  | { kind: 'none'; note: string };

export interface JournalEntry {
  seq: number;
  op: string;
  nodeId?: string;
  ref?: string;
  inverse: InverseOp;
}

/** Properties worth capturing before a `set` so the inverse can restore them. */
const RESTORABLE = new Set([
  'x', 'y', 'rotation', 'opacity', 'visible', 'locked', 'name', 'blendMode',
  'fills', 'strokes', 'strokeWeight', 'strokeAlign', 'effects', 'cornerRadius',
  'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius',
  'layoutMode', 'layoutWrap', 'primaryAxisSizingMode', 'counterAxisSizingMode',
  'primaryAxisAlignItems', 'counterAxisAlignItems', 'itemSpacing', 'counterAxisSpacing',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'layoutSizingHorizontal', 'layoutSizingVertical', 'layoutAlign', 'layoutGrow',
  'layoutPositioning', 'clipsContent', 'constraints', 'characters', 'fontSize',
  'fontName', 'textAlignHorizontal', 'textAlignVertical', 'textAutoResize',
  'letterSpacing', 'lineHeight', 'textCase', 'textDecoration', 'width', 'height',
]);

export class Journal {
  readonly operationId: string;
  private readonly entries: JournalEntry[] = [];
  private seq = 0;

  constructor(operationId: string) {
    this.operationId = operationId;
  }

  get length(): number {
    return this.entries.length;
  }

  toArray(): JournalEntry[] {
    return [...this.entries];
  }

  record(op: string, inverse: InverseOp, nodeId?: string, ref?: string): void {
    this.entries.push({ seq: this.seq++, op, nodeId, ref, inverse });
  }

  /** Marks a node as ours so recovery and verification can find it later. */
  tag(node: AnyNode): void {
    try {
      node.setPluginData(DATA_KEYS.operation, this.operationId);
    } catch {
      /* some node types reject plugin data; the journal entry still stands */
    }
  }

  recordCreate(op: string, node: AnyNode, ref?: string): void {
    this.tag(node);
    try {
      node.setPluginData(DATA_KEYS.createdBy, this.operationId);
    } catch {
      /* non-fatal */
    }
    this.record(op, { kind: 'remove', nodeId: node.id }, node.id, ref);
  }

  /** Snapshots only the fields a write is about to touch. */
  recordSet(op: string, node: AnyNode, fields: Iterable<string>): void {
    const props: Record<string, unknown> = {};
    for (const field of fields) {
      if (!RESTORABLE.has(field)) continue;
      const value = safe(() => (node as unknown as Record<string, unknown>)[field]);
      if (value === undefined) continue;
      props[field] = cloneValue(value);
    }
    this.tag(node);
    if (Object.keys(props).length === 0) {
      this.record(op, { kind: 'none', note: `no restorable fields on ${node.id}` }, node.id);
      return;
    }
    this.record(op, { kind: 'restore_props', nodeId: node.id, props }, node.id);
  }

  recordPosition(op: string, node: AnyNode): void {
    const parent = (node as SceneNode).parent as (BaseNode & ChildrenMixin) | null;
    if (!parent || !('children' in parent)) {
      this.record(op, { kind: 'none', note: `${node.id} has no reparentable parent` }, node.id);
      return;
    }
    const index = parent.children.findIndex((child) => child.id === node.id);
    this.tag(node);
    this.record(op, { kind: 'reparent', nodeId: node.id, parentId: parent.id, index }, node.id);
  }
}

/** Paints/effects come back as frozen arrays; deep-clone so restore can assign. */
function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === 'object') {
    if ((value as unknown) === figma.mixed) return undefined;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object)) {
      out[key] = cloneValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export interface RecoveryResult {
  applied: number;
  skipped: { seq: number; reason: string }[];
  failed: { seq: number; error: string }[];
}

/**
 * Replays inverse operations newest-first. Failures are collected rather than
 * thrown: a partially recoverable operation is still worth partially recovering,
 * and the caller needs the exact list of nodes it could not touch.
 */
export async function rollback(entries: JournalEntry[]): Promise<RecoveryResult> {
  const result: RecoveryResult = { applied: 0, skipped: [], failed: [] };
  const ordered = [...entries].sort((a, b) => b.seq - a.seq);

  for (const entry of ordered) {
    const inverse = entry.inverse;
    try {
      if (inverse.kind === 'none') {
        result.skipped.push({ seq: entry.seq, reason: inverse.note });
        continue;
      }

      const node = (await figma.getNodeByIdAsync(inverse.nodeId)) as AnyNode | null;
      if (!node) {
        result.skipped.push({ seq: entry.seq, reason: `node ${inverse.nodeId} no longer exists` });
        continue;
      }

      switch (inverse.kind) {
        case 'remove':
          (node as unknown as { remove: () => void }).remove();
          break;
        case 'restore_props':
          await restoreProps(node, inverse.props);
          break;
        case 'reparent': {
          const parent = (await figma.getNodeByIdAsync(inverse.parentId)) as (BaseNode & ChildrenMixin) | null;
          if (!parent || !('insertChild' in parent)) {
            result.skipped.push({ seq: entry.seq, reason: `parent ${inverse.parentId} is gone` });
            continue;
          }
          const index = Math.min(inverse.index, parent.children.length);
          parent.insertChild(index, node as SceneNode);
          break;
        }
        case 'restore_text': {
          const text = node as unknown as TextNode;
          await loadFontsFor(text);
          text.characters = inverse.characters;
          break;
        }
        case 'restore_component_properties':
          (node as unknown as InstanceNode).setProperties(
            inverse.properties as { [key: string]: string | boolean | VariableAlias }
          );
          break;
        case 'restore_bindings': {
          const variable = inverse.variableId ? await figma.variables.getVariableByIdAsync(inverse.variableId) : null;
          (node as unknown as SceneNode & { setBoundVariable: (f: string, v: Variable | null) => void }).setBoundVariable(
            inverse.field,
            variable
          );
          break;
        }
        case 'restore_style': {
          const setter = `set${inverse.field[0].toUpperCase()}${inverse.field.slice(1)}Async`;
          const target = node as unknown as Record<string, unknown>;
          if (typeof target[setter] === 'function') {
            await (target[setter] as (id: string) => Promise<void>)(inverse.styleId ?? '');
          } else {
            target[`${inverse.field}Id`] = inverse.styleId ?? '';
          }
          break;
        }
      }
      result.applied++;
    } catch (error) {
      result.failed.push({ seq: entry.seq, error: errorMessage(error) });
    }
  }

  return result;
}

async function restoreProps(node: AnyNode, props: Record<string, unknown>): Promise<void> {
  const target = node as unknown as Record<string, unknown>;
  let width: number | undefined;
  let height: number | undefined;

  if ('characters' in props) await loadFontsFor(node as unknown as TextNode);

  for (const key of Object.keys(props)) {
    const value = props[key];
    if (key === 'width') { width = value as number; continue; }
    if (key === 'height') { height = value as number; continue; }
    try {
      target[key] = value;
    } catch {
      /* the property may have become read-only for this node's new context */
    }
  }

  if (width !== undefined || height !== undefined) {
    const resizable = node as unknown as { resize?: (w: number, h: number) => void; width: number; height: number };
    if (typeof resizable.resize === 'function') {
      resizable.resize(width ?? resizable.width, height ?? resizable.height);
    }
  }
}

/** Every text mutation needs its fonts loaded first, including for rollback. */
export async function loadFontsFor(node: TextNode): Promise<void> {
  if (!node || node.type !== 'TEXT') return;
  const fonts = node.getRangeAllFontNames(0, Math.max(node.characters.length, 1));
  await Promise.all(fonts.map((font) => figma.loadFontAsync(font)));
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Finds or creates one of our housekeeping pages, without stealing focus. */
export async function ensurePage(name: string): Promise<PageNode> {
  for (const page of figma.root.children) {
    if (page.name === name) {
      await page.loadAsync();
      return page;
    }
  }
  const page = figma.createPage();
  page.name = name;
  return page;
}

/**
 * Deletes are quarantine moves: the node is parked on a dedicated page with a
 * breadcrumb back to where it came from, so a failed verification can put it
 * back and a successful one can be swept later.
 */
export async function quarantine(node: SceneNode, journal: Journal): Promise<{ nodeId: string; from: string }> {
  const parent = node.parent as (BaseNode & ChildrenMixin) | null;
  const from = parent ? parent.id : '';
  const index = parent && 'children' in parent ? parent.children.findIndex((child) => child.id === node.id) : 0;

  const page = await ensurePage(QUARANTINE_PAGE);
  try {
    node.setPluginData(DATA_KEYS.quarantinedFrom, JSON.stringify({ parentId: from, index, at: Date.now() }));
  } catch {
    /* non-fatal */
  }
  journal.record('remove', { kind: 'reparent', nodeId: node.id, parentId: from, index }, node.id);
  page.appendChild(node);
  return { nodeId: node.id, from };
}
