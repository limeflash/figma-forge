/**
 * Design-system index.
 *
 * Identity here is always a Figma key or id — never a name. Names collide, get
 * renamed, and differ between a library and the file consuming it; a key is the
 * only thing that survives a publish. Every row we emit therefore carries the
 * key, and search on the MCP side scores names only as a hint on top of it.
 *
 * A known hard limit: the Plugin API cannot enumerate a team library's
 * components. `getAvailableLibraryVariableCollectionsAsync` covers variables,
 * but for components the only honest source is what the file already uses — so
 * we aggregate remote main components from live instances and say so.
 */

import { safe, rgbToHex, resetNameCaches } from '../serialize';
import { errorMessage } from '../journal';

export const INDEX_SCHEMA_VERSION = 1;

/** Guard rails so a 50k-node file cannot turn one index build into a hang. */
const LIMITS = {
  components: 4000,
  instances: 6000,
  variables: 8000,
  libraryCollections: 40,
};

export interface DesignSystemParams {
  action?: 'index' | 'resolve' | 'variables' | 'import';
  /** `page` restricts the component scan; variables and styles are always file-wide. */
  scope?: 'file' | 'page';
  pageId?: string;
  includeRemoteInUse?: boolean;
  includeLibraryVariables?: boolean;
  key?: string;
  nodeId?: string;
  componentKey?: string;
  variableKey?: string;
  styleKey?: string;
}

interface PropertyDefinitionRow {
  type: string;
  defaultValue?: unknown;
  variantOptions?: string[];
  preferredValues?: unknown;
}

function propertyDefinitions(node: ComponentNode | ComponentSetNode): Record<string, PropertyDefinitionRow> | undefined {
  const defs = safe(() => node.componentPropertyDefinitions);
  if (!defs || typeof defs !== 'object') return undefined;
  const out: Record<string, PropertyDefinitionRow> = {};
  for (const name of Object.keys(defs)) {
    const def = (defs as Record<string, ComponentPropertyDefinitions[string]>)[name];
    out[name] = {
      type: def.type,
      defaultValue: def.defaultValue,
      variantOptions: def.variantOptions ? [...def.variantOptions] : undefined,
      preferredValues: def.preferredValues,
    };
  }
  return out;
}

function summarizeVariableValue(value: VariableValue): unknown {
  if (value && typeof value === 'object') {
    if ((value as VariableAlias).type === 'VARIABLE_ALIAS') {
      return { alias: (value as VariableAlias).id };
    }
    if ('r' in (value as RGB)) return rgbToHex(value as RGB);
  }
  return value;
}

async function pagesInScope(params: DesignSystemParams): Promise<PageNode[]> {
  if (params.scope === 'page') {
    const page = params.pageId ? ((await figma.getNodeByIdAsync(params.pageId)) as PageNode | null) : figma.currentPage;
    if (!page || page.type !== 'PAGE') throw new Error(`${params.pageId} is not a page.`);
    await page.loadAsync();
    return [page];
  }
  await figma.loadAllPagesAsync();
  return [...figma.root.children];
}

export interface ComponentRow {
  id: string;
  key: string | null;
  name: string;
  type: 'COMPONENT' | 'COMPONENT_SET';
  remote: boolean;
  description?: string;
  documentationLinks?: string[];
  pageId?: string;
  pageName?: string;
  setId?: string;
  setName?: string;
  variantProperties?: Record<string, string> | null;
  propertyDefinitions?: Record<string, PropertyDefinitionRow>;
  variantCount?: number;
}

export interface StyleRow {
  id: string;
  key: string;
  name: string;
  remote: boolean;
  description?: string;
  preview?: unknown;
}

export interface VariableRow {
  id: string;
  key: string;
  name: string;
  collectionId: string;
  resolvedType: string;
  scopes?: string[];
  codeSyntax?: Record<string, string>;
  remote: boolean;
  valuesByMode: Record<string, unknown>;
}

export interface DesignSystemIndex {
  schemaVersion: number;
  builtAt: number;
  fileKey: string | null;
  documentName: string;
  scope: 'file' | 'page';
  scopePageIds: string[];
  components: ComponentRow[];
  styles: { paint: StyleRow[]; text: StyleRow[]; effect: StyleRow[]; grid: StyleRow[] };
  collections: {
    id: string;
    key: string;
    name: string;
    remote: boolean;
    defaultModeId: string;
    modes: { modeId: string; name: string }[];
    variableIds: string[];
  }[];
  variables: VariableRow[];
  libraryCollections: {
    key: string;
    name: string;
    libraryName: string;
    variables: { key: string; name: string; resolvedType: string }[];
  }[];
  remoteComponentsInUse: {
    key: string;
    name: string;
    setKey?: string;
    setName?: string;
    instanceCount: number;
    sampleInstanceIds: string[];
  }[];
  stats: Record<string, number>;
  warnings: string[];
}

async function buildIndex(params: DesignSystemParams): Promise<DesignSystemIndex> {
  const warnings: string[] = [];
  const pages = await pagesInScope(params);
  const scope = params.scope === 'page' ? 'page' : 'file';

  /* ---- components -------------------------------------------------- */

  const components: ComponentRow[] = [];
  let componentTotal = 0;

  for (const page of pages) {
    const found = page.findAllWithCriteria({ types: ['COMPONENT', 'COMPONENT_SET'] });
    componentTotal += found.length;
    for (const node of found) {
      if (components.length >= LIMITS.components) break;
      const isSet = node.type === 'COMPONENT_SET';
      const parentSet = !isSet && node.parent && node.parent.type === 'COMPONENT_SET' ? (node.parent as ComponentSetNode) : null;
      components.push({
        id: node.id,
        key: safe(() => node.key) ?? null,
        name: node.name,
        type: node.type,
        remote: safe(() => node.remote) ?? false,
        description: safe(() => node.description) || undefined,
        documentationLinks: safe(() => node.documentationLinks?.map((link) => link.uri)),
        pageId: page.id,
        pageName: page.name,
        setId: parentSet ? parentSet.id : undefined,
        setName: parentSet ? parentSet.name : undefined,
        variantProperties: !isSet ? safe(() => (node as ComponentNode).variantProperties) ?? null : undefined,
        propertyDefinitions: propertyDefinitions(node as ComponentNode | ComponentSetNode),
        variantCount: isSet ? (node as ComponentSetNode).children.length : undefined,
      });
    }
  }
  if (componentTotal > components.length) {
    warnings.push(`Component scan truncated at ${components.length} of ${componentTotal}.`);
  }

  /* ---- styles ------------------------------------------------------- */

  const toStyleRow = (style: BaseStyle): StyleRow => ({
    id: style.id,
    key: style.key,
    name: style.name,
    remote: style.remote,
    description: safe(() => style.description) || undefined,
  });

  const styles = {
    paint: (await figma.getLocalPaintStylesAsync()).map((style) => ({
      ...toStyleRow(style),
      preview: summarizePaintStyle(style),
    })),
    text: (await figma.getLocalTextStylesAsync()).map((style) => ({
      ...toStyleRow(style),
      preview: {
        fontName: safe(() => style.fontName),
        fontSize: safe(() => style.fontSize),
        lineHeight: safe(() => style.lineHeight),
        letterSpacing: safe(() => style.letterSpacing),
      },
    })),
    effect: (await figma.getLocalEffectStylesAsync()).map(toStyleRow),
    grid: (await figma.getLocalGridStylesAsync()).map(toStyleRow),
  };

  /* ---- variables ---------------------------------------------------- */

  const localCollections = await figma.variables.getLocalVariableCollectionsAsync();
  const collections = localCollections.map((collection) => ({
    id: collection.id,
    key: collection.key,
    name: collection.name,
    remote: collection.remote,
    defaultModeId: collection.defaultModeId,
    modes: collection.modes.map((mode) => ({ modeId: mode.modeId, name: mode.name })),
    variableIds: [...collection.variableIds],
  }));

  const localVariables = await figma.variables.getLocalVariablesAsync();
  const variables: VariableRow[] = [];
  for (const variable of localVariables.slice(0, LIMITS.variables)) {
    const valuesByMode: Record<string, unknown> = {};
    for (const modeId of Object.keys(variable.valuesByMode)) {
      valuesByMode[modeId] = summarizeVariableValue(variable.valuesByMode[modeId]);
    }
    variables.push({
      id: variable.id,
      key: variable.key,
      name: variable.name,
      collectionId: variable.variableCollectionId,
      resolvedType: variable.resolvedType,
      scopes: variable.scopes ? [...variable.scopes] : undefined,
      codeSyntax: variable.codeSyntax as Record<string, string>,
      remote: variable.remote,
      valuesByMode,
    });
  }
  if (localVariables.length > variables.length) {
    warnings.push(`Variable scan truncated at ${variables.length} of ${localVariables.length}.`);
  }

  /* ---- library variables -------------------------------------------- */

  const libraryCollections: DesignSystemIndex['libraryCollections'] = [];
  if (params.includeLibraryVariables !== false) {
    try {
      const available = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
      for (const collection of available.slice(0, LIMITS.libraryCollections)) {
        let rows: { key: string; name: string; resolvedType: string }[] = [];
        try {
          const inCollection = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(collection.key);
          rows = inCollection.map((variable) => ({
            key: variable.key,
            name: variable.name,
            resolvedType: variable.resolvedType,
          }));
        } catch (error) {
          warnings.push(`Could not read library collection "${collection.name}": ${errorMessage(error)}`);
        }
        libraryCollections.push({
          key: collection.key,
          name: collection.name,
          libraryName: collection.libraryName,
          variables: rows,
        });
      }
    } catch (error) {
      // Enterprise/permission-gated in some workspaces; a missing library index
      // is a degraded index, not a failed one.
      warnings.push(`Team library variables unavailable: ${errorMessage(error)}`);
    }
  }

  /* ---- remote components actually in use ----------------------------- */

  const remoteComponentsInUse: DesignSystemIndex['remoteComponentsInUse'] = [];
  if (params.includeRemoteInUse !== false) {
    const byKey = new Map<string, { name: string; setKey?: string; setName?: string; count: number; samples: string[] }>();
    let scanned = 0;
    let instanceTotal = 0;

    for (const page of pages) {
      const instances = page.findAllWithCriteria({ types: ['INSTANCE'] });
      instanceTotal += instances.length;
      for (const instance of instances) {
        if (scanned >= LIMITS.instances) break;
        scanned++;
        let main: ComponentNode | null = null;
        try {
          main = await (instance as InstanceNode).getMainComponentAsync();
        } catch {
          continue;
        }
        if (!main || !main.remote) continue;
        const key = safe(() => main!.key);
        if (!key) continue;
        const set = main.parent && main.parent.type === 'COMPONENT_SET' ? (main.parent as ComponentSetNode) : null;
        const row = byKey.get(key) ?? {
          name: main.name,
          setKey: set ? safe(() => set.key) : undefined,
          setName: set ? set.name : undefined,
          count: 0,
          samples: [],
        };
        row.count++;
        if (row.samples.length < 5) row.samples.push(instance.id);
        byKey.set(key, row);
      }
    }

    if (instanceTotal > scanned) {
      warnings.push(
        `Instance scan truncated at ${scanned} of ${instanceTotal}; remote component usage counts are a lower bound.`
      );
    }
    for (const [key, row] of byKey) {
      remoteComponentsInUse.push({
        key,
        name: row.name,
        setKey: row.setKey,
        setName: row.setName,
        instanceCount: row.count,
        sampleInstanceIds: row.samples,
      });
    }
    remoteComponentsInUse.sort((a, b) => b.instanceCount - a.instanceCount);
  }

  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    builtAt: Date.now(),
    fileKey: figma.fileKey ?? null,
    documentName: figma.root.name,
    scope,
    scopePageIds: pages.map((page) => page.id),
    components,
    styles,
    collections,
    variables,
    libraryCollections,
    remoteComponentsInUse,
    stats: {
      components: components.length,
      paintStyles: styles.paint.length,
      textStyles: styles.text.length,
      effectStyles: styles.effect.length,
      gridStyles: styles.grid.length,
      collections: collections.length,
      variables: variables.length,
      libraryCollections: libraryCollections.length,
      remoteComponentsInUse: remoteComponentsInUse.length,
    },
    warnings,
  };
}

function summarizePaintStyle(style: PaintStyle): unknown {
  const paints = safe(() => style.paints);
  if (!Array.isArray(paints) || !paints.length) return undefined;
  const first = paints[0];
  if (first.type === 'SOLID') {
    return { type: 'SOLID', color: rgbToHex((first as SolidPaint).color), opacity: first.opacity };
  }
  return { type: first.type };
}

/**
 * Turns a component into an actionable recipe: which properties exist, what the
 * legal values are, and what a caller must pass. This is what `apply_plan`
 * validates against, so it is the only place variant grammar is interpreted.
 */
async function resolveComponent(params: DesignSystemParams): Promise<unknown> {
  let node: BaseNode | null = null;

  if (params.key) {
    try {
      node = await figma.importComponentByKeyAsync(params.key);
    } catch {
      try {
        node = await figma.importComponentSetByKeyAsync(params.key);
      } catch (error) {
        throw new Error(`Could not import component key "${params.key}": ${errorMessage(error)}`);
      }
    }
  } else if (params.nodeId) {
    node = await figma.getNodeByIdAsync(params.nodeId);
  } else {
    throw new Error('resolve needs either a component `key` or a `nodeId`.');
  }

  if (!node) throw new Error('Component not found.');

  if (node.type === 'INSTANCE') {
    const main = await (node as InstanceNode).getMainComponentAsync();
    if (!main) throw new Error(`Instance ${node.id} is detached — it has no main component.`);
    node = main;
  }

  if (node.type !== 'COMPONENT' && node.type !== 'COMPONENT_SET') {
    throw new Error(`${node.id} is a ${node.type}, not a component.`);
  }

  const component = node as ComponentNode | ComponentSetNode;
  const set =
    component.type === 'COMPONENT' && component.parent && component.parent.type === 'COMPONENT_SET'
      ? (component.parent as ComponentSetNode)
      : component.type === 'COMPONENT_SET'
        ? (component as ComponentSetNode)
        : null;

  const variants =
    set?.children.map((child) => ({
      id: child.id,
      key: safe(() => (child as ComponentNode).key),
      name: child.name,
      variantProperties: safe(() => (child as ComponentNode).variantProperties),
    })) ?? [];

  return {
    id: component.id,
    key: safe(() => component.key),
    name: component.name,
    type: component.type,
    remote: safe(() => component.remote) ?? false,
    description: safe(() => component.description) || undefined,
    setId: set ? set.id : undefined,
    setKey: set ? safe(() => set.key) : undefined,
    setName: set ? set.name : undefined,
    propertyDefinitions: propertyDefinitions(set ?? component),
    variants,
    // What a caller must send to `apply_plan.create_instance`.
    usage: {
      componentKey: safe(() => (set ?? component).key) ?? null,
      note:
        set && set.children.length > 1
          ? 'Pick a variant by passing every variant property in `properties`.'
          : 'No variants — `properties` only needs the non-variant component properties you want to override.',
    },
  };
}

async function importAsset(params: DesignSystemParams): Promise<unknown> {
  if (params.componentKey) {
    try {
      const component = await figma.importComponentByKeyAsync(params.componentKey);
      return { kind: 'COMPONENT', id: component.id, name: component.name, key: component.key };
    } catch {
      const set = await figma.importComponentSetByKeyAsync(params.componentKey);
      return { kind: 'COMPONENT_SET', id: set.id, name: set.name, key: set.key };
    }
  }
  if (params.variableKey) {
    const variable = await figma.variables.importVariableByKeyAsync(params.variableKey);
    return {
      kind: 'VARIABLE',
      id: variable.id,
      name: variable.name,
      key: variable.key,
      resolvedType: variable.resolvedType,
      collectionId: variable.variableCollectionId,
    };
  }
  if (params.styleKey) {
    const style = await figma.importStyleByKeyAsync(params.styleKey);
    return { kind: style.type, id: style.id, name: style.name, key: style.key };
  }
  throw new Error('import needs one of `componentKey`, `variableKey` or `styleKey`.');
}

export async function designSystem(params: DesignSystemParams): Promise<unknown> {
  resetNameCaches();
  switch (params.action ?? 'index') {
    case 'index':
      return await buildIndex(params);
    case 'resolve':
      return await resolveComponent(params);
    case 'variables': {
      const index = await buildIndex({ ...params, includeRemoteInUse: false });
      return {
        collections: index.collections,
        variables: index.variables,
        libraryCollections: index.libraryCollections,
        warnings: index.warnings,
      };
    }
    case 'import':
      return await importAsset(params);
    default:
      throw new Error(`Unknown design_system action "${params.action}".`);
  }
}
