/**
 * Read lane: everything the agent needs to know before it writes anything.
 *
 * Inspection is deliberately scoped and depth-capped. The failure mode we are
 * designing against is not "too little detail" — it is a whole-document dump
 * that costs a fortune in tokens and still buries the one node that mattered.
 */

import { select } from '../selector';
import { screenshot } from '../shims';
import { NodeSummary, nodePath, summarizeNode, resetNameCaches } from '../serialize';

type AnyNode = BaseNode & { children?: readonly SceneNode[] };

export type InspectScope =
  | 'document'
  | 'page'
  | 'selection'
  | 'node'
  | 'query'
  | 'ancestors'
  | 'screenshot';

export interface InspectParams {
  scope?: InspectScope;
  nodeId?: string;
  pageId?: string;
  selector?: string;
  depth?: number;
  /** `compact` is ids/names/geometry; `full` adds paints, layout and bindings. */
  detail?: 'compact' | 'full';
  limit?: number;
  scale?: number;
}

const DETAIL_FULL = { paints: true, layout: true, bindings: true, componentInfo: true } as const;

function detailOptions(detail: InspectParams['detail']) {
  return detail === 'full' ? { ...DETAIL_FULL } : {};
}

async function resolvePage(pageId?: string): Promise<PageNode> {
  if (!pageId) return figma.currentPage;
  const page = (await figma.getNodeByIdAsync(pageId)) as PageNode | null;
  if (!page || page.type !== 'PAGE') throw new Error(`${pageId} is not a page.`);
  await page.loadAsync();
  return page;
}

async function resolveNode(nodeId?: string): Promise<AnyNode> {
  if (!nodeId) {
    const selection = figma.currentPage.selection;
    if (selection.length !== 1) {
      throw new Error(
        selection.length === 0
          ? 'No nodeId given and nothing is selected in Figma.'
          : `No nodeId given and ${selection.length} nodes are selected — name one explicitly.`
      );
    }
    return selection[0] as AnyNode;
  }
  const node = (await figma.getNodeByIdAsync(nodeId)) as AnyNode | null;
  if (!node) throw new Error(`Node ${nodeId} was not found. It may have been deleted or live on an unloaded page.`);
  return node;
}

export async function inspect(params: InspectParams): Promise<unknown> {
  resetNameCaches();
  const scope = params.scope ?? 'selection';
  const limit = params.limit ?? 100;

  switch (scope) {
    case 'document': {
      const pages = figma.root.children.map((page) => ({
        id: page.id,
        name: page.name,
        current: page.id === figma.currentPage.id,
      }));
      return {
        name: figma.root.name,
        fileKey: figma.fileKey ?? null,
        editorType: figma.editorType,
        currentPageId: figma.currentPage.id,
        pages,
        selection: figma.currentPage.selection.map((node) => ({ id: node.id, name: node.name, type: node.type })),
      };
    }

    case 'page': {
      const page = await resolvePage(params.pageId);
      const children: NodeSummary[] = [];
      for (const child of page.children.slice(0, limit)) {
        children.push(await summarizeNode(child as AnyNode, { depth: params.depth ?? 0, ...detailOptions(params.detail) }));
      }
      return {
        id: page.id,
        name: page.name,
        childCount: page.children.length,
        truncated: Math.max(0, page.children.length - children.length),
        children,
      };
    }

    case 'selection': {
      const selection = figma.currentPage.selection;
      const nodes: NodeSummary[] = [];
      for (const node of selection.slice(0, limit)) {
        nodes.push(await summarizeNode(node as AnyNode, { depth: params.depth ?? 0, ...detailOptions(params.detail) }));
      }
      return { pageId: figma.currentPage.id, pageName: figma.currentPage.name, count: selection.length, nodes };
    }

    case 'node': {
      const node = await resolveNode(params.nodeId);
      const summary = await summarizeNode(node, {
        depth: params.depth ?? 1,
        ...detailOptions(params.detail ?? 'full'),
        maxChildren: limit,
      });
      return { ...summary, path: nodePath(node) };
    }

    case 'query': {
      if (!params.selector) throw new Error('scope "query" needs a `selector`.');
      const root: AnyNode = params.nodeId
        ? await resolveNode(params.nodeId)
        : (await resolvePage(params.pageId)) as unknown as AnyNode;
      const found = select(root, params.selector);
      const nodes: NodeSummary[] = [];
      for (const node of found.slice(0, limit)) {
        nodes.push(await summarizeNode(node, { depth: params.depth ?? 0, ...detailOptions(params.detail) }));
      }
      return {
        rootId: root.id,
        selector: params.selector,
        matched: found.length,
        truncated: Math.max(0, found.length - nodes.length),
        nodes,
      };
    }

    case 'ancestors': {
      const node = await resolveNode(params.nodeId);
      const chain: { id: string; name: string; type: string }[] = [];
      let current: BaseNode | null = node;
      while (current) {
        chain.unshift({ id: current.id, name: current.name, type: current.type });
        current = (current as SceneNode).parent as BaseNode | null;
      }
      return { nodeId: node.id, ancestors: chain };
    }

    case 'screenshot': {
      const node = await resolveNode(params.nodeId);
      return await screenshot(node, { scale: params.scale });
    }

    default:
      throw new Error(`Unknown inspect scope "${scope}".`);
  }
}
