/**
 * Exports nodes as PNG for the design preview.
 *
 * The preview is only worth looking at if the parts that already exist look
 * like themselves. A box labelled "Buttons / Big Main" tells you nothing about
 * whether the screen reads well; the actual button does. So anything the plan
 * reuses — a component to instantiate, a node to clone — is exported once and
 * rendered as real pixels, and only the structure Claude is inventing is drawn
 * as CSS.
 */

import { screenshot } from '../shims';
import { errorMessage } from '../journal';

type AnyNode = BaseNode & { children?: readonly SceneNode[] };

export interface ThumbnailParams {
  /** Node ids, component ids, or component keys. */
  ids: string[];
  scale?: number;
  /** Longest edge in pixels; the scale is reduced to fit. */
  maxEdge?: number;
}

export interface Thumbnail {
  id: string;
  requested: string;
  name: string;
  type: string;
  width: number;
  height: number;
  /** Natural size, before the preview scale. */
  naturalWidth: number;
  naturalHeight: number;
  bytes: string;
}

export interface ThumbnailResult {
  thumbnails: Thumbnail[];
  failed: { requested: string; error: string }[];
}

let keyIndex: Map<string, string> | null = null;

async function resolveOne(requested: string): Promise<AnyNode | null> {
  // Ids contain a colon; anything else is a component key.
  if (requested.indexOf(':') >= 0 || /^\d+$/.test(requested)) {
    const node = await figma.getNodeByIdAsync(requested).catch(() => null);
    if (node) return node as AnyNode;
  }

  try {
    return (await figma.importComponentByKeyAsync(requested)) as unknown as AnyNode;
  } catch {
    /* not a published component; try a set, then look locally */
  }
  try {
    const set = await figma.importComponentSetByKeyAsync(requested);
    return (set.defaultVariant ?? set.children[0] ?? null) as unknown as AnyNode | null;
  } catch {
    /* fall through */
  }

  if (!keyIndex) {
    keyIndex = new Map();
    await figma.loadAllPagesAsync();
    for (const node of figma.root.findAllWithCriteria({ types: ['COMPONENT', 'COMPONENT_SET'] })) {
      try {
        const key = (node as ComponentNode).key;
        if (key && !keyIndex.has(key)) keyIndex.set(key, node.id);
      } catch {
        /* keyless nodes are not addressable this way anyway */
      }
    }
  }
  const id = keyIndex.get(requested);
  return id ? ((await figma.getNodeByIdAsync(id)) as AnyNode | null) : null;
}

export async function exportThumbnails(params: ThumbnailParams): Promise<ThumbnailResult> {
  const thumbnails: Thumbnail[] = [];
  const failed: ThumbnailResult['failed'] = [];
  const seen = new Set<string>();

  for (const requested of params.ids ?? []) {
    if (seen.has(requested)) continue;
    seen.add(requested);

    try {
      let node = await resolveOne(requested);
      if (!node) throw new Error('not found in this file');

      // A component set has no geometry of its own; preview its default variant.
      if (node.type === 'COMPONENT_SET') {
        const set = node as unknown as ComponentSetNode;
        node = (set.defaultVariant ?? set.children[0]) as unknown as AnyNode;
        if (!node) throw new Error('component set has no variants');
      }

      const sized = node as unknown as { width: number; height: number };
      const longest = Math.max(sized.width ?? 0, sized.height ?? 0);
      const maxEdge = params.maxEdge ?? 900;
      const scale = params.scale ?? (longest > maxEdge ? maxEdge / longest : 1);

      const shot = await screenshot(node, { scale, contentsOnly: false });
      thumbnails.push({
        id: node.id,
        requested,
        name: node.name,
        type: node.type,
        width: shot.width,
        height: shot.height,
        naturalWidth: Math.round(sized.width ?? shot.width),
        naturalHeight: Math.round(sized.height ?? shot.height),
        bytes: shot.bytes,
      });
    } catch (error) {
      failed.push({ requested, error: errorMessage(error) });
    }
  }

  return { thumbnails, failed };
}

/**
 * Resolves variable ids to their concrete values, so the preview can paint the
 * same colours the plan will bind in Figma rather than guessing a grey.
 */
export async function resolveVariables(params: { ids: string[]; modeId?: string }): Promise<
  Record<string, { name: string; type: string; value: unknown; modeName?: string }>
> {
  const out: Record<string, { name: string; type: string; value: unknown; modeName?: string }> = {};

  for (const id of params.ids ?? []) {
    try {
      const variable = await figma.variables.getVariableByIdAsync(id);
      if (!variable) continue;
      const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
      const modeId = params.modeId && variable.valuesByMode[params.modeId] !== undefined
        ? params.modeId
        : collection?.defaultModeId ?? Object.keys(variable.valuesByMode)[0];
      const raw = modeId ? variable.valuesByMode[modeId] : undefined;
      const mode = collection?.modes.filter((entry) => entry.modeId === modeId)[0];

      out[id] = {
        name: variable.name,
        type: variable.resolvedType,
        // An alias would need chasing; the preview treats it as unknown rather
        // than inventing a colour.
        value: raw && typeof raw === 'object' && 'type' in raw ? null : raw,
        modeName: mode?.name,
      };
    } catch {
      /* a variable that will not resolve simply has no preview colour */
    }
  }

  return out;
}
