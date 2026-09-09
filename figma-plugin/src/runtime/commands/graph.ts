/**
 * Screen graph extraction.
 *
 * A big design file is not searchable by node name. Measured on a real one: a
 * single page held 21 screens named "other profile" seven times over, plus
 * "other" and "Header". The signal is not in the names — it is in the text a
 * screen contains and the components it is built from. So the graph unit is the
 * *screen* (a frame sitting directly on a page or in a section), carrying its
 * text and its component usage, rather than every node in the document.
 *
 * That also keeps it tractable: hundreds of screens per file instead of hundreds
 * of thousands of nodes.
 *
 * Extraction is per page and resumable. A 65-page file cannot be walked inside
 * one bridge request without risking a timeout, so the caller pages through it.
 */

import { safe } from '../serialize';

type AnyNode = BaseNode & { children?: readonly SceneNode[] };

export interface GraphParams {
  scope?: 'file' | 'page';
  pageId?: string;
  /** Resume point: index into figma.root.children. */
  startPage?: number;
  maxPages?: number;
  maxScreensPerPage?: number;
  maxTextChars?: number;
  /** Cap on main-component lookups per page. */
  maxInstanceLookups?: number;
}

export interface ScreenRecord {
  id: string;
  name: string;
  type: string;
  pageId: string;
  pageName: string;
  sectionName?: string;
  path: string;
  width: number;
  height: number;
  /** Concatenated visible text, deduplicated and capped. */
  text: string;
  textNodes: number;
  instanceCount: number;
  componentKeys: string[];
  componentNames: string[];
}

export interface GraphChunk {
  pages: { id: string; name: string; index: number; screens: number }[];
  screens: ScreenRecord[];
  /** Component usage rolled up across the pages in this chunk. */
  components: { key: string; name: string; instances: number; screens: number }[];
  nextPage: number | null;
  totalPages: number;
  stats: Record<string, number>;
}

const SCREEN_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET']);

/** A screen is a frame that sits on a page, or in a section on a page. */
function isScreen(node: SceneNode): boolean {
  if (!SCREEN_TYPES.has(node.type)) return false;
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === 'PAGE') return true;
  // Sections nest, so walk up through them but not through frames.
  let current: BaseNode | null = parent;
  while (current && current.type === 'SECTION') current = current.parent;
  return !!current && current.type === 'PAGE';
}

function sectionOf(node: SceneNode): SectionNode | null {
  let current: BaseNode | null = node.parent;
  while (current && current.type !== 'PAGE') {
    if (current.type === 'SECTION') return current as SectionNode;
    current = (current as SceneNode).parent;
  }
  return null;
}

export async function buildGraph(params: GraphParams): Promise<GraphChunk> {
  const maxScreens = params.maxScreensPerPage ?? 400;
  const maxTextChars = params.maxTextChars ?? 1200;
  const maxLookups = params.maxInstanceLookups ?? 1500;

  let pages: PageNode[];
  let startIndex = 0;
  let totalPages: number;

  if (params.scope === 'page') {
    const page = params.pageId ? ((await figma.getNodeByIdAsync(params.pageId)) as PageNode | null) : figma.currentPage;
    if (!page || page.type !== 'PAGE') throw new Error(`${params.pageId} is not a page.`);
    pages = [page];
    totalPages = 1;
  } else {
    const all = figma.root.children;
    totalPages = all.length;
    startIndex = params.startPage ?? 0;
    const count = params.maxPages ?? 8;
    pages = all.slice(startIndex, startIndex + count) as PageNode[];
  }

  const pageRows: GraphChunk['pages'] = [];
  const screens: ScreenRecord[] = [];
  const componentUsage = new Map<string, { name: string; instances: number; screens: Set<string> }>();
  const stats: Record<string, number> = { textNodes: 0, instances: 0, lookupsSkipped: 0 };

  for (const [offset, page] of pages.entries()) {
    await page.loadAsync();

    const found = page.findAllWithCriteria({
      types: ['FRAME', 'COMPONENT', 'COMPONENT_SET', 'TEXT', 'INSTANCE'],
    });

    const pageScreens = found.filter((node) => SCREEN_TYPES.has(node.type) && isScreen(node)).slice(0, maxScreens);
    const screenIds = new Set(pageScreens.map((screen) => screen.id));

    // One pass up the tree per text/instance is cheap; one pass down per screen
    // would re-walk shared subtrees many times over.
    const owner = (node: SceneNode): string | null => {
      let current: BaseNode | null = node;
      while (current) {
        if (screenIds.has(current.id)) return current.id;
        current = (current as SceneNode).parent;
      }
      return null;
    };

    const textByScreen = new Map<string, { parts: string[]; chars: number; count: number }>();
    const instancesByScreen = new Map<string, SceneNode[]>();

    for (const node of found) {
      if (node.type === 'TEXT') {
        stats.textNodes++;
        const screenId = owner(node);
        if (!screenId) continue;
        if (safe(() => node.visible) === false) continue;
        const characters = safe(() => (node as TextNode).characters);
        if (typeof characters !== 'string' || !characters.trim()) continue;

        const bucket = textByScreen.get(screenId) ?? { parts: [], chars: 0, count: 0 };
        bucket.count++;
        if (bucket.chars < maxTextChars) {
          const trimmed = characters.trim().replace(/\s+/g, ' ');
          bucket.parts.push(trimmed);
          bucket.chars += trimmed.length + 1;
        }
        textByScreen.set(screenId, bucket);
        continue;
      }

      if (node.type === 'INSTANCE') {
        stats.instances++;
        const screenId = owner(node);
        if (!screenId) continue;
        const list = instancesByScreen.get(screenId) ?? [];
        list.push(node);
        instancesByScreen.set(screenId, list);
      }
    }

    // Resolve main components in one batch for the page. Measured at ~6ms per 30
    // instances, so this is affordable; the cap is a guard for outlier pages.
    const flatInstances: { screenId: string; node: SceneNode }[] = [];
    for (const [screenId, list] of instancesByScreen) {
      for (const node of list) flatInstances.push({ screenId, node });
    }
    const budgeted = flatInstances.slice(0, maxLookups);
    stats.lookupsSkipped += flatInstances.length - budgeted.length;

    const resolved = await Promise.all(
      budgeted.map(({ screenId, node }) =>
        (node as InstanceNode)
          .getMainComponentAsync()
          .then((main) => ({ screenId, main }))
          .catch(() => ({ screenId, main: null as ComponentNode | null }))
      )
    );

    const keysByScreen = new Map<string, Map<string, string>>();
    for (const { screenId, main } of resolved) {
      if (!main) continue;
      const set = main.parent && main.parent.type === 'COMPONENT_SET' ? (main.parent as ComponentSetNode) : null;
      const key = safe(() => (set ?? main).key);
      if (!key) continue;
      const name = (set ?? main).name;

      const perScreen = keysByScreen.get(screenId) ?? new Map<string, string>();
      perScreen.set(key, name);
      keysByScreen.set(screenId, perScreen);

      const usage = componentUsage.get(key) ?? { name, instances: 0, screens: new Set<string>() };
      usage.instances++;
      usage.screens.add(screenId);
      componentUsage.set(key, usage);
    }

    for (const screen of pageScreens) {
      const section = sectionOf(screen);
      const text = textByScreen.get(screen.id);
      const keys = keysByScreen.get(screen.id) ?? new Map<string, string>();

      screens.push({
        id: screen.id,
        name: screen.name,
        type: screen.type,
        pageId: page.id,
        pageName: page.name,
        sectionName: section ? section.name : undefined,
        path: [page.name, section ? section.name : null, screen.name].filter(Boolean).join(' / '),
        width: Math.round(safe(() => (screen as FrameNode).width) ?? 0),
        height: Math.round(safe(() => (screen as FrameNode).height) ?? 0),
        text: text ? text.parts.join(' · ').slice(0, maxTextChars) : '',
        textNodes: text ? text.count : 0,
        instanceCount: (instancesByScreen.get(screen.id) ?? []).length,
        componentKeys: [...keys.keys()],
        componentNames: [...keys.values()],
      });
    }

    pageRows.push({
      id: page.id,
      name: page.name,
      index: params.scope === 'page' ? 0 : startIndex + offset,
      screens: pageScreens.length,
    });
  }

  const components = [...componentUsage].map(([key, usage]) => ({
    key,
    name: usage.name,
    instances: usage.instances,
    screens: usage.screens.size,
  }));
  components.sort((a, b) => b.instances - a.instances);

  const consumed = startIndex + pages.length;
  return {
    pages: pageRows,
    screens,
    components,
    nextPage: params.scope === 'page' || consumed >= totalPages ? null : consumed,
    totalPages,
    stats: { ...stats, screens: screens.length, pagesInChunk: pages.length },
  };
}
