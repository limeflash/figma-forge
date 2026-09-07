/**
 * Design-system retrieval.
 *
 * Search runs here, not in the plugin, because the index is already cached on
 * disk and a query should not cost a round trip to Figma. The ranking is
 * deliberately conservative: an exact key beats everything, a name is only ever
 * a hint, and the result carries the key the write layer will actually use.
 *
 * The output is a *recipe candidate*, not prose — the agent should be able to
 * paste `componentKey` straight into a plan.
 */

export interface RawIndex {
  fileKey: string | null;
  documentName: string;
  builtAt: number;
  components: {
    id: string;
    key: string | null;
    name: string;
    type: 'COMPONENT' | 'COMPONENT_SET';
    remote: boolean;
    description?: string;
    pageName?: string;
    setId?: string;
    setName?: string;
    variantProperties?: Record<string, string> | null;
    propertyDefinitions?: Record<string, { type: string; defaultValue?: unknown; variantOptions?: string[] }>;
    variantCount?: number;
  }[];
  styles: Record<string, { id: string; key: string; name: string; remote: boolean; preview?: unknown }[]>;
  variables: {
    id: string;
    key: string;
    name: string;
    collectionId: string;
    resolvedType: string;
    scopes?: string[];
    codeSyntax?: Record<string, string>;
    valuesByMode: Record<string, unknown>;
  }[];
  collections: { id: string; key: string; name: string; modes: { modeId: string; name: string }[] }[];
  libraryCollections: { key: string; name: string; libraryName: string; variables: { key: string; name: string; resolvedType: string }[] }[];
  remoteComponentsInUse: { key: string; name: string; setKey?: string; setName?: string; instanceCount: number }[];
  stats?: Record<string, number>;
  warnings?: string[];
}

export type ResultKind = 'component' | 'style' | 'variable' | 'library-variable';

export interface SearchHit {
  kind: ResultKind;
  score: number;
  name: string;
  key: string | null;
  id?: string;
  type?: string;
  detail: Record<string, unknown>;
  why: string;
}

/** Names are written as `semantic/color/bg-default`, `Button/Primary`, `bgDefault`. */
function tokenize(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

interface Scored {
  score: number;
  why: string;
}

function scoreName(query: string, queryTokens: string[], candidate: string, aliases: string[] = []): Scored | null {
  const targets = [candidate, ...aliases];
  const normalizedQuery = normalize(query);

  for (const target of targets) {
    if (normalize(target) === normalizedQuery) return { score: 500, why: `exact name match on "${target}"` };
  }

  let best: Scored | null = null;
  for (const target of targets) {
    const targetTokens = tokenize(target);
    if (!targetTokens.length) continue;

    const matched = queryTokens.filter((token) =>
      targetTokens.some((candidateToken) => candidateToken === token || candidateToken.startsWith(token) || token.startsWith(candidateToken))
    );
    if (!matched.length) continue;

    const coverage = matched.length / queryTokens.length;
    // Prefer tighter names: "Button" should beat "Button Group Item" for "button".
    const precision = matched.length / targetTokens.length;
    const score = Math.round(coverage * 250 + precision * 80);
    const why =
      coverage === 1
        ? `every query word appears in "${target}"`
        : `${matched.length}/${queryTokens.length} query words appear in "${target}"`;
    if (!best || score > best.score) best = { score, why };
  }
  return best;
}

export interface SearchOptions {
  kinds?: ResultKind[];
  limit?: number;
  /** Only variables of this resolved type (COLOR, FLOAT, STRING, BOOLEAN). */
  variableType?: string;
  /** Include components that live in a library but are not used here yet. */
  includeUnused?: boolean;
}

export function search(index: RawIndex, query: string, options: SearchOptions = {}): SearchHit[] {
  const trimmed = (query ?? '').trim();
  if (!trimmed) return [];

  const kinds = new Set<ResultKind>(options.kinds ?? ['component', 'style', 'variable', 'library-variable']);
  const limit = options.limit ?? 12;
  const queryTokens = tokenize(trimmed);
  const hits: SearchHit[] = [];

  const usageByKey = new Map(index.remoteComponentsInUse.map((row) => [row.key, row.instanceCount]));

  if (kinds.has('component')) {
    for (const component of index.components) {
      // A variant inside a set is reachable through the set; listing both is noise.
      if (component.type === 'COMPONENT' && component.setId) continue;

      let scored: Scored | null =
        component.key && component.key === trimmed ? { score: 1000, why: 'exact component key' } : null;
      if (!scored) scored = scoreName(trimmed, queryTokens, component.name, component.description ? [component.description] : []);
      if (!scored) continue;

      const usage = component.key ? (usageByKey.get(component.key) ?? 0) : 0;
      // Something the file already uses is far likelier to be the right answer
      // than an identically named component nobody has ever placed.
      const usageBonus = Math.min(usage, 25) * 2;

      hits.push({
        kind: 'component',
        score: scored.score + usageBonus,
        name: component.name,
        key: component.key,
        id: component.id,
        type: component.type,
        why: usage ? `${scored.why}; used ${usage}× in this file` : scored.why,
        detail: {
          componentKey: component.key,
          nodeId: component.id,
          type: component.type,
          remote: component.remote,
          page: component.pageName,
          variantCount: component.variantCount,
          properties: component.propertyDefinitions
            ? Object.fromEntries(
                Object.entries(component.propertyDefinitions).map(([name, def]) => [
                  name,
                  def.variantOptions ? { type: def.type, options: def.variantOptions } : { type: def.type, default: def.defaultValue },
                ])
              )
            : undefined,
          instanceCount: usage || undefined,
          description: component.description,
        },
      });
    }
  }

  if (kinds.has('style')) {
    for (const group of Object.keys(index.styles ?? {})) {
      for (const style of index.styles[group] ?? []) {
        const scored =
          style.key === trimmed ? { score: 1000, why: 'exact style key' } : scoreName(trimmed, queryTokens, style.name);
        if (!scored) continue;
        hits.push({
          kind: 'style',
          score: scored.score,
          name: style.name,
          key: style.key,
          id: style.id,
          type: group,
          why: scored.why,
          detail: { styleKey: style.key, styleId: style.id, styleKind: group, remote: style.remote, preview: style.preview },
        });
      }
    }
  }

  if (kinds.has('variable')) {
    const collectionNames = new Map(index.collections.map((collection) => [collection.id, collection.name]));
    for (const variable of index.variables) {
      if (options.variableType && variable.resolvedType !== options.variableType) continue;
      const aliases = variable.codeSyntax ? Object.values(variable.codeSyntax) : [];
      const scored =
        variable.key === trimmed ? { score: 1000, why: 'exact variable key' } : scoreName(trimmed, queryTokens, variable.name, aliases);
      if (!scored) continue;
      hits.push({
        kind: 'variable',
        score: scored.score,
        name: variable.name,
        key: variable.key,
        id: variable.id,
        type: variable.resolvedType,
        why: scored.why,
        detail: {
          variableKey: variable.key,
          variableId: variable.id,
          resolvedType: variable.resolvedType,
          collection: collectionNames.get(variable.collectionId) ?? variable.collectionId,
          scopes: variable.scopes,
          codeSyntax: variable.codeSyntax,
          valuesByMode: variable.valuesByMode,
        },
      });
    }
  }

  if (kinds.has('library-variable')) {
    for (const collection of index.libraryCollections ?? []) {
      for (const variable of collection.variables) {
        if (options.variableType && variable.resolvedType !== options.variableType) continue;
        const scored =
          variable.key === trimmed ? { score: 1000, why: 'exact variable key' } : scoreName(trimmed, queryTokens, variable.name);
        if (!scored) continue;
        hits.push({
          // Slightly below local variables: importing costs a round trip, and a
          // local variable is usually the already-blessed one.
          kind: 'library-variable',
          score: scored.score - 20,
          name: variable.name,
          key: variable.key,
          type: variable.resolvedType,
          why: `${scored.why}; from library "${collection.libraryName}"`,
          detail: {
            variableKey: variable.key,
            resolvedType: variable.resolvedType,
            collection: collection.name,
            library: collection.libraryName,
            note: 'Not local yet — `design_system { action: "import", variableKey }` brings it into this file.',
          },
        });
      }
    }
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** A compact orientation blob: what this design system even contains. */
export function overview(index: RawIndex): Record<string, unknown> {
  const sets = index.components.filter((component) => component.type === 'COMPONENT_SET');
  const singles = index.components.filter((component) => component.type === 'COMPONENT' && !component.setId);
  const collections = index.collections.map((collection) => ({
    name: collection.name,
    modes: collection.modes.map((mode) => mode.name),
    variables: index.variables.filter((variable) => variable.collectionId === collection.id).length,
  }));

  return {
    document: index.documentName,
    fileKey: index.fileKey,
    builtAt: new Date(index.builtAt).toISOString(),
    components: {
      sets: sets.length,
      standalone: singles.length,
      mostUsedRemote: index.remoteComponentsInUse.slice(0, 15).map((row) => ({
        name: row.name,
        key: row.key,
        instances: row.instanceCount,
      })),
      topLevelNames: [...sets, ...singles].slice(0, 40).map((component) => component.name),
    },
    styles: Object.fromEntries(Object.keys(index.styles ?? {}).map((group) => [group, (index.styles[group] ?? []).length])),
    variableCollections: collections,
    libraries: (index.libraryCollections ?? []).map((collection) => ({
      name: collection.name,
      library: collection.libraryName,
      variables: collection.variables.length,
    })),
    warnings: index.warnings ?? [],
  };
}
