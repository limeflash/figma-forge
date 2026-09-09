/**
 * Tailwind importer.
 *
 * The two Tailwind generations need completely different treatment:
 *
 *   v4  the theme *is* CSS — an `@theme { --color-blue-500: … }` layer. Nothing
 *       to interpret; hand it to the CSS importer.
 *   v3  the theme is a JavaScript object, often built from `require()`d presets
 *       and functions. The only faithful way to read it is to execute it.
 *
 * We import the config with Node's own loader, which resolves its dependencies
 * against the target project's `node_modules` — so a config importing
 * `tailwindcss/colors` works, provided Tailwind is installed there.
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCss, CssImportOptions } from './css.js';
import { deduplicate, hash, inferValue, TokenIR, TokenVariable } from './ir.js';

export interface TailwindImportOptions extends CssImportOptions {
  /** Theme groups to import. Defaults to the ones that map onto Figma variables. */
  groups?: string[];
}

/** Groups whose values become Figma variables; the rest have no equivalent. */
const DEFAULT_GROUPS = [
  'colors',
  'spacing',
  'borderRadius',
  'borderWidth',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'opacity',
  'zIndex',
  'screens',
  'maxWidth',
  'minWidth',
];

/** Tailwind nests scales arbitrarily deep; flatten to dotted paths. */
function flatten(value: unknown, prefix: string[], out: Map<string, string>): void {
  if (value == null) return;

  if (typeof value === 'string' || typeof value === 'number') {
    out.set(prefix.join('.'), String(value));
    return;
  }
  // `fontSize: ['1rem', { lineHeight: '1.5' }]` — the size is the token.
  if (Array.isArray(value)) {
    if (typeof value[0] === 'string' || typeof value[0] === 'number') {
      out.set(prefix.join('.'), String(value[0]));
    }
    return;
  }
  if (typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    // Tailwind's own convention: `DEFAULT` is the unsuffixed value.
    flatten(child, key === 'DEFAULT' ? prefix : [...prefix, key], out);
  }
}

function isV4Css(path: string, source: string): boolean {
  return /\.css$/i.test(path) || /@theme\b/.test(source) || /@import\s+["']tailwindcss["']/.test(source);
}

export async function parseTailwind(path: string, options: TailwindImportOptions = {}): Promise<TokenIR> {
  const source = await readFile(path, 'utf8').catch(() => '');

  if (isV4Css(path, source)) {
    const ir = parseCss(source, path, {
      collectionName: options.collectionName ?? 'Imported / Tailwind',
      ...options,
    });
    ir.source.kind = 'tailwind';
    if (!ir.collections[0]?.variables.length) {
      ir.warnings.push(
        'This looks like a Tailwind v4 stylesheet but no `@theme` tokens were found. ' +
          'Point at the file that declares `@theme`, or at a v3 `tailwind.config.js`.'
      );
    }
    return ir;
  }

  const warnings: string[] = [];
  const unsupported: TokenIR['unsupported'] = [];

  let config: Record<string, unknown>;
  try {
    // Cache-bust so a re-import after editing the config reads the new file.
    const module = await import(`${pathToFileURL(path).href}?t=${Date.now()}`);
    config = (module.default ?? module) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Could not load ${path}: ${error instanceof Error ? error.message : String(error)}\n` +
        'A v3 config is executed to read its theme, so it must import cleanly from its own directory. ' +
        'If it depends on a build-time loader, export the resolved theme to CSS and import that instead.'
    );
  }

  const theme = (config.theme ?? {}) as Record<string, unknown>;
  const extend = (theme.extend ?? {}) as Record<string, unknown>;
  const groups = options.groups ?? DEFAULT_GROUPS;

  const flat = new Map<string, string>();
  for (const group of groups) {
    // `extend` is merged over the base theme, which is what Tailwind does too.
    for (const layer of [theme[group], extend[group]]) {
      if (layer === undefined) continue;
      if (typeof layer === 'function') {
        warnings.push(`theme.${group} is a function and was skipped — its value depends on Tailwind's own resolver.`);
        continue;
      }
      flatten(layer, [group], flat);
    }
  }

  if (flat.size === 0) {
    warnings.push(
      `No theme values found in ${basename(path)} for groups: ${groups.join(', ')}. ` +
        'A config that only sets `content` inherits the default theme, which lives inside Tailwind rather than the file.'
    );
  }

  const variables: TokenVariable[] = [];
  const mode = 'Value';

  for (const [dotted, raw] of flat) {
    const inferred = inferValue(raw, { remBase: options.remBase });
    if ('unsupported' in inferred) {
      unsupported.push({ name: dotted, value: raw, reason: inferred.unsupported });
      continue;
    }
    const name = dotted.replace(/\./g, '/');
    variables.push({
      name,
      type: inferred.type,
      valuesByMode: { [mode]: inferred.value },
      sourceId: `tailwind:${dotted}`,
      sourceHash: hash(raw),
      rawByMode: { [mode]: raw },
      codeSyntax: { WEB: tailwindClassHint(dotted) },
    });
  }

  return {
    source: { kind: 'tailwind', path, hash: hash(JSON.stringify([...flat])), importedAt: Date.now() },
    collections: [
      {
        name: options.collectionName ?? 'Imported / Tailwind',
        modes: [mode],
        variables: deduplicate(variables, warnings),
      },
    ],
    warnings,
    unsupported,
  };
}

/** A hint at the utility this token backs, so a designer can find it in code. */
function tailwindClassHint(dotted: string): string {
  const [group, ...rest] = dotted.split('.');
  const suffix = rest.join('-');
  const prefixes: Record<string, string> = {
    colors: 'bg|text|border',
    spacing: 'p|m|gap',
    borderRadius: 'rounded',
    fontSize: 'text',
    fontWeight: 'font',
    opacity: 'opacity',
    zIndex: 'z',
    maxWidth: 'max-w',
    minWidth: 'min-w',
  };
  const prefix = prefixes[group];
  return prefix ? `${prefix}-${suffix}` : `${group}.${suffix}`;
}
