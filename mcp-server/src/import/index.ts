/**
 * Entry point for code-to-Figma imports.
 *
 * Resolves a user-supplied path against the project directory and dispatches to
 * the right parser. Kept separate from the MCP tool so the parsers stay testable
 * without a Figma connection.
 */

import { access } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { parseCss, CssImportOptions } from './css.js';
import { parseTailwind, TailwindImportOptions } from './tailwind.js';
import { parseStorybook, StorybookIR } from './storybook.js';
import { TokenIR } from './ir.js';
import { readFile } from 'node:fs/promises';

export type ImportSource = 'css' | 'tailwind' | 'storybook';

export { parseCss, parseTailwind, parseStorybook };
export type { TokenIR, StorybookIR };

function projectRoot(): string {
  const configured = process.env.FIGMA_FORGE_PROJECT_DIR;
  if (configured && configured.trim() && !configured.includes('${')) return resolve(configured);
  return process.cwd();
}

/**
 * Paths come from the user, and an import that silently read something outside
 * the project would be a surprise. Resolve, then say plainly where we went.
 */
export async function resolveSourcePath(path: string): Promise<{ absolute: string; display: string; outsideProject: boolean }> {
  const root = projectRoot();
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  try {
    await access(absolute);
  } catch {
    throw new Error(`No file at ${absolute}. Paths are resolved against ${root}.`);
  }
  const rel = relative(root, absolute);
  return {
    absolute,
    display: rel && !rel.startsWith('..') ? rel : absolute,
    outsideProject: !rel || rel.startsWith('..'),
  };
}

export interface ImportOptions extends CssImportOptions, TailwindImportOptions {}

export async function importTokenSource(
  source: ImportSource,
  absolutePath: string,
  options: ImportOptions = {}
): Promise<TokenIR> {
  if (source === 'tailwind') return await parseTailwind(absolutePath, options);
  if (source === 'css') return parseCss(await readFile(absolutePath, 'utf8'), absolutePath, options);
  throw new Error(`"${source}" does not produce tokens — use action "map" for Storybook.`);
}

/** A preview that fits in a reply: counts, modes, and a representative sample. */
export function summarizeIR(ir: TokenIR, sampleSize = 12): Record<string, unknown> {
  return {
    source: ir.source,
    collections: ir.collections.map((collection) => ({
      name: collection.name,
      modes: collection.modes,
      variableCount: collection.variables.length,
      byType: collection.variables.reduce<Record<string, number>>((counts, variable) => {
        counts[variable.type] = (counts[variable.type] ?? 0) + 1;
        return counts;
      }, {}),
      sample: collection.variables.slice(0, sampleSize).map((variable) => ({
        name: variable.name,
        type: variable.type,
        values: variable.rawByMode,
        aliases: Object.values(variable.valuesByMode)
          .filter((value) => value && typeof value === 'object' && 'alias' in (value as object))
          .map((value) => (value as { alias: string }).alias),
      })),
      truncated: Math.max(0, collection.variables.length - sampleSize),
    })),
    unsupported: ir.unsupported,
    warnings: ir.warnings,
  };
}
