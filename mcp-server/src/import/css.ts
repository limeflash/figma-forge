/**
 * CSS custom property importer.
 *
 * Handles the shape token files actually take: a base block (`:root`, `html`,
 * or Tailwind v4's `@theme`), plus one or more dark-mode blocks written as a
 * class, a data attribute, or a `prefers-color-scheme` media query. Each becomes
 * a Figma mode, which is the whole point — a colour that exists once per theme
 * is what makes a variable worth having.
 *
 * This is a scanner, not a CSS parser. It looks for declarations beginning with
 * `--` inside brace blocks and ignores everything else, which is both enough for
 * token files and immune to the parts of CSS syntax that would otherwise need a
 * real grammar.
 */

import { basename } from 'node:path';
import { deduplicate, hash, inferValue, resolveAliasTypes, tokenName, TokenIR, TokenVariable } from './ir.js';

export interface CssImportOptions {
  remBase?: number;
  nameStyle?: 'slash' | 'flat';
  collectionName?: string;
  /** Name for the base (non-dark) mode. */
  baseMode?: string;
  darkMode?: string;
  /** Read custom properties from every selector, not just root/theme blocks. */
  includeAllSelectors?: boolean;
}

interface Block {
  prelude: string;
  body: string;
  ancestors: string[];
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Walks brace depth, emitting every block along with the at-rules enclosing it. */
function scanBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const stack: { prelude: string; start: number }[] = [];
  let preludeStart = 0;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '{') {
      const prelude = source.slice(preludeStart, i).trim();
      stack.push({ prelude, start: i + 1 });
      preludeStart = i + 1;
    } else if (char === '}') {
      const open = stack.pop();
      if (!open) continue;
      blocks.push({
        prelude: open.prelude,
        body: source.slice(open.start, i),
        ancestors: stack.map((entry) => entry.prelude),
      });
      preludeStart = i + 1;
    }
  }
  return blocks;
}

function declarations(body: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  let depth = 0;
  let current = '';

  const flush = () => {
    const text = current.trim();
    current = '';
    if (!text.startsWith('--')) return;
    const colon = text.indexOf(':');
    if (colon < 0) return;
    const name = text.slice(0, colon).trim();
    const value = text.slice(colon + 1).trim();
    if (/^--[\w-]+$/.test(name) && value) out.push({ name, value });
  };

  for (const char of body) {
    if (char === '(') depth++;
    else if (char === ')') depth--;
    // A nested block's contents are scanned separately; only top-level
    // declarations of this block belong to it.
    else if (char === '{') depth += 100;
    else if (char === '}') depth -= 100;
    if (char === ';' && depth === 0) {
      flush();
      continue;
    }
    current += char;
  }
  flush();
  return out;
}

const DARK = /(^|[\s,>+~])(\.dark\b|\.theme-dark\b|\[data-theme[~|^$*]?=["']?dark|\[data-mode[~|^$*]?=["']?dark|\[data-color-scheme[~|^$*]?=["']?dark)/i;
const LIGHT = /(^|[\s,>+~])(\.light\b|\.theme-light\b|\[data-theme[~|^$*]?=["']?light|\[data-mode[~|^$*]?=["']?light)/i;
const ROOT = /^(:root|html|body|:host|\*)?$|^(:root|html|body|:host)\b/;

/** Which Figma mode a block's declarations belong to, or null to skip it. */
function modeFor(block: Block, options: CssImportOptions): string | null {
  const base = options.baseMode ?? 'Light';
  const dark = options.darkMode ?? 'Dark';
  const chain = [...block.ancestors, block.prelude].join(' ');

  if (/@media[^{]*prefers-color-scheme\s*:\s*dark/i.test(chain)) return dark;
  if (DARK.test(block.prelude)) return dark;
  if (LIGHT.test(block.prelude)) return base;

  // Tailwind v4 puts the whole token layer in `@theme`.
  if (/^@theme\b/.test(block.prelude)) return base;
  if (/^@layer\b/.test(block.prelude)) return null;
  if (ROOT.test(block.prelude)) return base;

  return options.includeAllSelectors ? base : null;
}

export function parseCss(source: string, path: string, options: CssImportOptions = {}): TokenIR {
  const warnings: string[] = [];
  const unsupported: TokenIR['unsupported'] = [];
  const cleaned = stripComments(source);
  const blocks = scanBlocks(cleaned);

  // name -> mode -> raw value. Later declarations win, matching the cascade for
  // the flat, single-file case these token sheets are written in.
  const byName = new Map<string, { order: number; modes: Map<string, string> }>();
  const modesSeen: string[] = [];
  let order = 0;

  for (const block of blocks) {
    const mode = modeFor(block, options);
    if (!mode) continue;
    if (!modesSeen.includes(mode)) modesSeen.push(mode);

    for (const declaration of declarations(block.body)) {
      let record = byName.get(declaration.name);
      if (!record) {
        record = { order: order++, modes: new Map() };
        byName.set(declaration.name, record);
      }
      record.modes.set(mode, declaration.value);
    }
  }

  if (byName.size === 0) {
    warnings.push(
      'No custom properties found. Tokens are read from `:root`, `html`, `@theme`, and dark-mode ' +
        'blocks; pass `includeAllSelectors` to read component-scoped ones too.'
    );
  }

  const baseMode = options.baseMode ?? 'Light';
  // A single-mode collection should not be called "Light" — there is no dark to
  // contrast it with, and the name would be a lie.
  const modes = modesSeen.length > 1 ? modesSeen : ['Value'];
  const soleMode = modes.length === 1 ? modes[0] : null;

  const variables: TokenVariable[] = [];
  for (const [cssName, record] of [...byName].sort((a, b) => a[1].order - b[1].order)) {
    const valuesByMode: TokenVariable['valuesByMode'] = {};
    const rawByMode: Record<string, string> = {};
    let type: TokenVariable['type'] | null = null;
    let skipped: string | null = null;

    for (const mode of modes) {
      const raw = record.modes.get(soleMode ? baseMode : mode) ?? record.modes.get(baseMode) ?? [...record.modes.values()][0];
      if (raw === undefined) continue;
      const inferred = inferValue(raw, { remBase: options.remBase });
      if ('unsupported' in inferred) {
        skipped = inferred.unsupported;
        break;
      }
      // An alias is typed by whatever it points at; assume the concrete modes agree.
      if (type === null || (type === 'COLOR' && 'alias' in (inferred.value as object))) type = inferred.type;
      valuesByMode[mode] = inferred.value;
      rawByMode[mode] = raw;
    }

    if (skipped) {
      unsupported.push({ name: cssName, value: [...record.modes.values()][0] ?? '', reason: skipped });
      continue;
    }
    if (!type || Object.keys(valuesByMode).length === 0) continue;

    variables.push({
      name: tokenName(cssName, options.nameStyle),
      type,
      valuesByMode,
      sourceId: `css:${cssName}`,
      sourceHash: hash(JSON.stringify(rawByMode)),
      rawByMode,
      codeSyntax: { WEB: `var(${cssName})` },
    });
  }

  const collection = {
    name: options.collectionName ?? `Imported / ${basename(path).replace(/\.[^.]+$/, '')}`,
    modes,
    variables: deduplicate(variables, warnings),
  };
  resolveAliasTypes(collection, warnings);

  return {
    source: { kind: 'css', path, hash: hash(cleaned), importedAt: Date.now() },
    collections: [collection],
    warnings,
    unsupported,
  };
}
