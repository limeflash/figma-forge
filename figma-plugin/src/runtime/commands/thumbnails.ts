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
import { safe } from '../serialize';

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
/** componentKey/componentId -> an instance of it that is actually placed. */
let instanceIndex: Map<string, string> | null = null;

/**
 * A main component is a poor likeness of itself. Measured on the real file:
 * `Buttons / Big Main` is authored at 160×56 with placeholder content and
 * exports to 1.3 KB, while the instance on the screen is 384×56 with the real
 * label and exports to 21 KB. The preview exists to show how a screen reads, so
 * it wants the instance.
 *
 * Scanning every instance in the document would be far too slow, so this looks
 * at the current page — where, by definition, the components being designed
 * with are usually already in use — and gives up quietly otherwise.
 */
async function findPlacedInstance(component: ComponentNode | ComponentSetNode): Promise<AnyNode | null> {
  if (!instanceIndex) {
    instanceIndex = new Map();
    const instances = figma.currentPage.findAllWithCriteria({ types: ['INSTANCE'] });
    const budget = instances.slice(0, 3000);
    const resolved = await Promise.all(
      budget.map((instance) =>
        (instance as InstanceNode)
          .getMainComponentAsync()
          .then((main) => ({ instance, main }))
          .catch(() => ({ instance, main: null as ComponentNode | null }))
      )
    );
    for (const { instance, main } of resolved) {
      if (!main) continue;
      const set = main.parent && main.parent.type === 'COMPONENT_SET' ? main.parent : null;
      for (const owner of [main, set]) {
        if (!owner) continue;
        const key = safe(() => (owner as ComponentNode).key);
        // Widest wins: a stretched instance shows the component at the size a
        // screen actually uses it.
        for (const handle of [key, owner.id]) {
          if (!handle) continue;
          const existing = instanceIndex.get(handle);
          if (!existing) {
            instanceIndex.set(handle, instance.id);
            continue;
          }
          const previous = figma.currentPage.findOne((node) => node.id === existing);
          if (previous && instance.width > previous.width) instanceIndex.set(handle, instance.id);
        }
      }
    }
  }

  const key = safe(() => (component as ComponentNode).key);
  const id = instanceIndex.get(key ?? '') ?? instanceIndex.get(component.id);
  return id ? ((await figma.getNodeByIdAsync(id)) as AnyNode | null) : null;
}

async function resolveOne(requested: string): Promise<AnyNode | null> {
  // Ids contain a colon; anything else is a component key.
  if (requested.indexOf(':') >= 0 || /^\d+$/.test(requested)) {
    const node = await figma.getNodeByIdAsync(requested).catch(() => null);
    if (node) return node as AnyNode;
  }

  try {
    return (await figma.importComponentByKeyAsync(requested)) as unknown as AnyNode;
  } catch {
    /* not importable; try a set, then look locally, then give up */
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
      if (!node) {
        throw new Error(
          'could not be resolved — not a node id in this file, and not importable as a published component'
        );
      }

      if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
        const placed = await findPlacedInstance(node as unknown as ComponentNode | ComponentSetNode);
        if (placed) {
          node = placed;
        } else if (node.type === 'COMPONENT_SET') {
          // A component set has no geometry of its own; fall back to a variant.
          const set = node as unknown as ComponentSetNode;
          node = (set.defaultVariant ?? set.children[0]) as unknown as AnyNode;
          if (!node) throw new Error('component set has no variants and no instance is placed on this page');
        }
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
