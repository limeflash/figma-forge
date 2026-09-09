/**
 * Writes an imported token IR into Figma variables.
 *
 * The importer is *source-owned*: every variable it creates is stamped with the
 * `sourceId` it came from, so a re-import is an update rather than a second copy,
 * and a variable a human authored is never silently overwritten. Ownership lives
 * in plugin data on the variable itself — `Variable extends PluginDataMixin`,
 * which is what makes this possible without a side table.
 *
 * Two passes, because aliases can point forwards: concrete values first, then
 * references, once every target exists and has an id.
 */

import { safe } from '../serialize';
import { errorMessage } from '../journal';

export const IMPORT_KEYS = {
  source: 'ff.source',
  sourceHash: 'ff.sourceHash',
  importedFrom: 'ff.importedFrom',
} as const;

type TokenType = 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN';

interface TokenAlias {
  alias: string;
}
type TokenValue = { r: number; g: number; b: number; a?: number } | number | string | boolean | TokenAlias;

interface TokenVariable {
  name: string;
  type: TokenType;
  valuesByMode: Record<string, TokenValue>;
  sourceId: string;
  sourceHash: string;
  rawByMode?: Record<string, string>;
  codeSyntax?: Record<string, string>;
  scopes?: string[];
}

interface TokenCollection {
  name: string;
  modes: string[];
  variables: TokenVariable[];
}

interface TokenIR {
  source: { kind: string; path: string; hash: string; importedAt: number };
  collections: TokenCollection[];
  warnings?: string[];
}

export interface ImportTokensParams {
  ir: TokenIR;
  dryRun?: boolean;
  /** Adopt variables that match by name but were not created by this importer. */
  takeOwnership?: boolean;
  collectionName?: string;
}

export interface ImportTokensResult {
  dryRun: boolean;
  collection: { id?: string; name: string; created: boolean; modes: { modeId: string; name: string }[] };
  created: string[];
  updated: string[];
  unchanged: string[];
  conflicts: { name: string; reason: string }[];
  aliasFailures: { name: string; alias: string }[];
  warnings: string[];
}

const isAlias = (value: TokenValue): value is TokenAlias =>
  !!value && typeof value === 'object' && 'alias' in (value as object);

function toFigmaValue(value: TokenValue): VariableValue {
  if (value && typeof value === 'object' && 'r' in value) {
    const color = value as { r: number; g: number; b: number; a?: number };
    return { r: color.r, g: color.g, b: color.b, a: color.a === undefined ? 1 : color.a };
  }
  return value as VariableValue;
}

/**
 * A fresh collection always has exactly one mode called "Mode 1". Rename it
 * rather than adding alongside, or every import leaves a dead mode behind.
 */
function ensureModes(collection: VariableCollection, wanted: string[]): Record<string, string> {
  const byName: Record<string, string> = {};
  for (const mode of collection.modes) byName[mode.name] = mode.modeId;

  wanted.forEach((name, index) => {
    if (byName[name]) return;
    if (index === 0 && collection.modes.length === 1 && /^Mode 1$/i.test(collection.modes[0].name)) {
      collection.renameMode(collection.modes[0].modeId, name);
      byName[name] = collection.modes[0].modeId;
      return;
    }
    try {
      byName[name] = collection.addMode(name);
    } catch (error) {
      // Mode count is plan-dependent; a Starter file caps at one.
      throw new Error(
        `Could not add mode "${name}" to "${collection.name}": ${errorMessage(error)}. ` +
          'Additional modes require a paid Figma plan — re-run with a single-mode import.'
      );
    }
  });

  return byName;
}

export async function importTokens(params: ImportTokensParams): Promise<ImportTokensResult[]> {
  const ir = params.ir;
  if (!ir || !Array.isArray(ir.collections)) throw new Error('import_tokens needs an `ir` with a `collections` array.');

  const results: ImportTokensResult[] = [];
  for (const source of ir.collections) {
    results.push(await importCollection(source, ir, params));
  }
  return results;
}

async function importCollection(
  source: TokenCollection,
  ir: TokenIR,
  params: ImportTokensParams
): Promise<ImportTokensResult> {
  const dryRun = params.dryRun === true;
  const name = params.collectionName ?? source.name;
  const origin = `${ir.source.kind}:${ir.source.path}`;

  const result: ImportTokensResult = {
    dryRun,
    collection: { name, created: false, modes: [] },
    created: [],
    updated: [],
    unchanged: [],
    conflicts: [],
    aliasFailures: [],
    warnings: [...(ir.warnings ?? [])],
  };

  const existingCollections = await figma.variables.getLocalVariableCollectionsAsync();
  let collection = existingCollections.filter((candidate) => candidate.name === name)[0] ?? null;

  if (collection && collection.remote) {
    result.conflicts.push({ name, reason: 'A collection with this name comes from a library and cannot be written to.' });
    return result;
  }

  if (!collection) {
    result.collection.created = true;
    if (dryRun) {
      result.collection.modes = source.modes.map((mode) => ({ modeId: `(new) ${mode}`, name: mode }));
    } else {
      collection = figma.variables.createVariableCollection(name);
      collection.setPluginData(IMPORT_KEYS.importedFrom, origin);
    }
  }

  const modeIds = collection && !dryRun ? ensureModes(collection, source.modes) : {};
  if (collection && !dryRun) {
    result.collection.id = collection.id;
    result.collection.modes = collection.modes.map((mode) => ({ modeId: mode.modeId, name: mode.name }));
  }

  /* --- index what is already there ---------------------------------- */

  const bySourceId = new Map<string, Variable>();
  const byName = new Map<string, Variable>();

  if (collection) {
    for (const id of collection.variableIds) {
      const variable = await figma.variables.getVariableByIdAsync(id);
      if (!variable) continue;
      byName.set(variable.name, variable);
      const owned = safe(() => variable.getPluginData(IMPORT_KEYS.source));
      if (owned) bySourceId.set(owned, variable);
    }
  }

  /* --- pass 1: concrete values --------------------------------------- */

  const written = new Map<string, Variable>();

  for (const token of source.variables) {
    let variable = bySourceId.get(token.sourceId) ?? null;
    let isNew = false;

    if (!variable) {
      const collision = byName.get(token.name);
      if (collision) {
        const owner = safe(() => collision.getPluginData(IMPORT_KEYS.source));
        if (owner && owner !== token.sourceId) {
          result.conflicts.push({
            name: token.name,
            reason: `already imported from a different source (${owner})`,
          });
          continue;
        }
        if (!owner && !params.takeOwnership) {
          // Someone made this by hand. Adopting it silently would put an
          // importer in charge of a decision a person made.
          result.conflicts.push({
            name: token.name,
            reason: 'a hand-authored variable already has this name — pass takeOwnership to adopt it',
          });
          continue;
        }
        variable = collision;
      } else {
        isNew = true;
      }
    }

    if (variable && variable.resolvedType !== token.type) {
      result.conflicts.push({
        name: token.name,
        reason: `existing variable is ${variable.resolvedType}, the token is ${token.type}; Figma cannot change a variable's type`,
      });
      continue;
    }

    if (variable && safe(() => variable!.getPluginData(IMPORT_KEYS.sourceHash)) === token.sourceHash) {
      result.unchanged.push(token.name);
      written.set(token.sourceId, variable);
      continue;
    }

    if (dryRun) {
      (isNew ? result.created : result.updated).push(token.name);
      continue;
    }

    if (!variable) {
      variable = figma.variables.createVariable(token.name, collection!, token.type as VariableResolvedDataType);
    } else if (variable.name !== token.name) {
      variable.name = token.name;
    }

    for (const modeName of source.modes) {
      const value = token.valuesByMode[modeName];
      if (value === undefined || isAlias(value)) continue;
      const modeId = modeIds[modeName];
      if (!modeId) continue;
      variable.setValueForMode(modeId, toFigmaValue(value));
    }

    if (token.scopes) variable.scopes = token.scopes as VariableScope[];
    if (token.codeSyntax) {
      for (const platform of Object.keys(token.codeSyntax)) {
        try {
          variable.setVariableCodeSyntax(platform as CodeSyntaxPlatform, token.codeSyntax[platform]);
        } catch {
          /* unknown platform names are not worth failing an import over */
        }
      }
    }

    variable.setPluginData(IMPORT_KEYS.source, token.sourceId);
    variable.setPluginData(IMPORT_KEYS.sourceHash, token.sourceHash);
    variable.setPluginData(IMPORT_KEYS.importedFrom, origin);

    written.set(token.sourceId, variable);
    (isNew ? result.created : result.updated).push(token.name);
  }

  /* --- pass 2: aliases ------------------------------------------------ */

  if (!dryRun) {
    // Aliases are named by their source token (`--color-white`), not by their
    // Figma name, so a rename on either side cannot break the link.
    const prefix = `${ir.source.kind === 'tailwind' ? 'css' : ir.source.kind}:`;

    for (const token of source.variables) {
      const variable = written.get(token.sourceId) ?? bySourceId.get(token.sourceId);
      if (!variable) continue;

      for (const modeName of source.modes) {
        const value = token.valuesByMode[modeName];
        if (value === undefined || !isAlias(value)) continue;
        const modeId = modeIds[modeName];
        if (!modeId) continue;

        const targetSourceId = `${prefix}${value.alias}`;
        const target = written.get(targetSourceId) ?? bySourceId.get(targetSourceId);
        if (!target) {
          result.aliasFailures.push({ name: token.name, alias: value.alias });
          continue;
        }
        try {
          variable.setValueForMode(modeId, figma.variables.createVariableAlias(target));
        } catch (error) {
          result.aliasFailures.push({ name: token.name, alias: `${value.alias} (${errorMessage(error)})` });
        }
      }
    }
  }

  if (result.aliasFailures.length) {
    result.warnings.push(
      `${result.aliasFailures.length} alias(es) could not be resolved and kept their fallback value. ` +
        'The referenced tokens are usually defined in a file that was not part of this import.'
    );
  }

  return result;
}
