/**
 * Token intermediate representation.
 *
 * Parsing happens here on the Node side, because the Figma sandbox has no file
 * system and no way to read a repository. What crosses the bridge is this IR:
 * already-resolved collections, modes and variables, with colours converted to
 * the 0-1 RGB Figma expects and `var()` references preserved as aliases.
 *
 * Every variable carries a `sourceId` — a stable identifier derived from where
 * it came from, not from its name. That is what makes a re-import an update
 * rather than a duplicate, and what lets the plugin refuse to overwrite a
 * variable a human authored.
 */

export type TokenType = 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN';

export interface TokenAlias {
  /** The source name being referenced, e.g. `--color-brand`. Resolved plugin-side. */
  alias: string;
}

export type TokenValue = { r: number; g: number; b: number; a?: number } | number | string | boolean | TokenAlias;

export interface TokenVariable {
  name: string;
  type: TokenType;
  valuesByMode: Record<string, TokenValue>;
  /** Stable identity: `css:--color-blue-500`, `tailwind:colors.blue.500`. */
  sourceId: string;
  sourceHash: string;
  /** The literal text this came from, per mode. Kept for review and diffing. */
  rawByMode: Record<string, string>;
  codeSyntax?: Record<string, string>;
  scopes?: string[];
}

export interface TokenCollection {
  name: string;
  modes: string[];
  variables: TokenVariable[];
}

export interface TokenIR {
  source: { kind: 'css' | 'tailwind' | 'storybook'; path: string; hash: string; importedAt: number };
  collections: TokenCollection[];
  warnings: string[];
  /** Values we could parse but not represent as a Figma variable. */
  unsupported: { name: string; value: string; reason: string }[];
}

/* ------------------------------------------------------------------ *
 * Hashing
 * ------------------------------------------------------------------ */

/** FNV-1a. Identity and change detection, not security. */
export function hash(input: string): string {
  let value = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    value ^= input.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, '0');
}

/* ------------------------------------------------------------------ *
 * Colour
 * ------------------------------------------------------------------ */

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** sRGB transfer function. Linear light in, display-referred out. */
function encodeGamma(channel: number): number {
  return channel <= 0.0031308 ? 12.92 * channel : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
}

/** OKLCH to *unclamped* linear-light sRGB, via OKLab (Björn Ottosson's matrices). */
function oklchToLinear(l: number, c: number, hDegrees: number): [number, number, number] {
  const hRad = (hDegrees * Math.PI) / 180;
  const a = c * Math.cos(hRad);
  const bb = c * Math.sin(hRad);

  const lCube = (l + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const mCube = (l - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const sCube = (l - 0.0894841775 * a - 1.291485548 * bb) ** 3;

  return [
    4.0767416621 * lCube - 3.3077115913 * mCube + 0.2309699292 * sCube,
    -1.2684380046 * lCube + 2.6097574011 * mCube - 0.3413193965 * sCube,
    -0.0041960863 * lCube - 0.7034186147 * mCube + 1.707614701 * sCube,
  ];
}

const IN_GAMUT_EPSILON = 1e-5;

function inGamut(linear: [number, number, number]): boolean {
  return linear.every((channel) => channel >= -IN_GAMUT_EPSILON && channel <= 1 + IN_GAMUT_EPSILON);
}

/**
 * OKLCH to sRGB, with gamut mapping.
 *
 * This is not optional polish: Tailwind v4 ships its entire default palette in
 * `oklch()`, and much of that palette sits outside sRGB. Clamping each channel
 * independently — the obvious implementation — shifts hue and oversaturates:
 * Tailwind's `blue-500` comes out `#2b7fff` instead of the `#3b82f6` a browser
 * renders. So we do what CSS Color 4 does and reduce chroma, holding lightness
 * and hue, until the colour fits.
 */
export function oklchToRgb(l: number, c: number, hDegrees: number): { r: number; g: number; b: number } {
  let linear = oklchToLinear(l, c, hDegrees);

  if (!inGamut(linear)) {
    let low = 0;
    let high = c;
    // 24 halvings takes chroma precision well below anything an 8-bit channel
    // can express, so the result is stable rather than merely close.
    for (let i = 0; i < 24; i++) {
      const mid = (low + high) / 2;
      if (inGamut(oklchToLinear(l, mid, hDegrees))) low = mid;
      else high = mid;
    }
    linear = oklchToLinear(l, low, hDegrees);
  }

  return {
    r: clamp01(encodeGamma(clamp01(linear[0]))),
    g: clamp01(encodeGamma(clamp01(linear[1]))),
    b: clamp01(encodeGamma(clamp01(linear[2]))),
  };
}

export function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const saturation = s / 100;
  const lightness = l / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const hPrime = (((h % 360) + 360) % 360) / 60;
  const x = chroma * (1 - Math.abs((hPrime % 2) - 1));
  const [r1, g1, b1] =
    hPrime < 1 ? [chroma, x, 0]
    : hPrime < 2 ? [x, chroma, 0]
    : hPrime < 3 ? [0, chroma, x]
    : hPrime < 4 ? [0, x, chroma]
    : hPrime < 5 ? [x, 0, chroma]
    : [chroma, 0, x];
  const m = lightness - chroma / 2;
  return { r: clamp01(r1 + m), g: clamp01(g1 + m), b: clamp01(b1 + m) };
}

/** The CSS keywords that actually show up in token files. */
const NAMED_COLORS: Record<string, string> = {
  transparent: '#00000000',
  white: '#ffffff',
  black: '#000000',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  yellow: '#ffff00',
  orange: '#ffa500',
  purple: '#800080',
  currentcolor: '',
};

/** Splits `oklch(0.7 0.15 250 / 0.5)` into numeric components plus alpha. */
function parseComponents(body: string): { parts: number[]; alpha?: number } | null {
  const [main, alphaPart] = body.split('/');
  const parts = main
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((token) => {
      const numeric = parseFloat(token);
      return Number.isNaN(numeric) ? NaN : token.endsWith('%') ? numeric : numeric;
    });
  if (parts.some(Number.isNaN)) return null;

  let alpha: number | undefined;
  if (alphaPart !== undefined) {
    const trimmed = alphaPart.trim();
    const numeric = parseFloat(trimmed);
    if (Number.isNaN(numeric)) return null;
    alpha = trimmed.endsWith('%') ? numeric / 100 : numeric;
  }
  return { parts, alpha };
}

export function parseColor(input: string): { r: number; g: number; b: number; a?: number } | null {
  const value = input.trim().toLowerCase();
  if (!value) return null;

  const named = NAMED_COLORS[value];
  if (named === '') return null;
  const text = named ?? value;

  if (text.startsWith('#')) {
    const hex = text.slice(1);
    const expand = (piece: string) => parseInt(piece.length === 1 ? piece + piece : piece, 16) / 255;
    if (hex.length === 3 || hex.length === 4) {
      return {
        r: expand(hex[0]), g: expand(hex[1]), b: expand(hex[2]),
        ...(hex.length === 4 ? { a: expand(hex[3]) } : {}),
      };
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: expand(hex.slice(0, 2)), g: expand(hex.slice(2, 4)), b: expand(hex.slice(4, 6)),
        ...(hex.length === 8 ? { a: expand(hex.slice(6, 8)) } : {}),
      };
    }
    return null;
  }

  const call = /^(rgba?|hsla?|oklch)\(([^)]*)\)$/.exec(text);
  if (!call) return null;
  const [, fn, body] = call;
  const parsed = parseComponents(body);
  if (!parsed) return null;
  const { parts, alpha } = parsed;

  if (fn === 'rgb' || fn === 'rgba') {
    if (parts.length < 3) return null;
    // Legacy `rgba(r, g, b, a)` puts alpha in the fourth slot instead of after a slash.
    const legacyAlpha = parts.length > 3 ? parts[3] : undefined;
    const channel = (raw: string, numeric: number) => (raw.includes('%') ? numeric / 100 : numeric / 255);
    const rawParts = body.split('/')[0].trim().split(/[\s,]+/).filter(Boolean);
    const result = {
      r: clamp01(channel(rawParts[0] ?? '', parts[0])),
      g: clamp01(channel(rawParts[1] ?? '', parts[1])),
      b: clamp01(channel(rawParts[2] ?? '', parts[2])),
    };
    const finalAlpha = alpha ?? legacyAlpha;
    return finalAlpha === undefined ? result : { ...result, a: clamp01(finalAlpha) };
  }

  if (fn === 'hsl' || fn === 'hsla') {
    if (parts.length < 3) return null;
    const result = hslToRgb(parts[0], parts[1], parts[2]);
    const finalAlpha = alpha ?? (parts.length > 3 ? parts[3] : undefined);
    return finalAlpha === undefined ? result : { ...result, a: clamp01(finalAlpha) };
  }

  if (fn === 'oklch') {
    if (parts.length < 3) return null;
    // Lightness is 0-1, but is often written as a percentage.
    const rawParts = body.split('/')[0].trim().split(/[\s,]+/).filter(Boolean);
    const lightness = rawParts[0]?.includes('%') ? parts[0] / 100 : parts[0];
    const result = oklchToRgb(lightness, parts[1], parts[2]);
    return alpha === undefined ? result : { ...result, a: clamp01(alpha) };
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * Value inference
 * ------------------------------------------------------------------ */

const VAR_REFERENCE = /^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/;
const LENGTH = /^(-?[\d.]+)(px|rem|em|%)?$/;

export interface InferOptions {
  /** Root font size for rem -> px. Figma variables are unitless numbers. */
  remBase?: number;
}

export interface InferredValue {
  type: TokenType;
  value: TokenValue;
}

/**
 * Decides what a raw CSS value becomes in Figma. A `var()` reference stays a
 * reference — flattening it would lose the semantic layer that makes a token
 * system worth importing in the first place.
 */
export function inferValue(raw: string, options: InferOptions = {}): InferredValue | { unsupported: string } {
  const value = raw.trim().replace(/\s*!important$/, '');
  if (!value) return { unsupported: 'empty value' };

  const reference = VAR_REFERENCE.exec(value);
  if (reference) return { type: 'COLOR', value: { alias: reference[1] } };

  const color = parseColor(value);
  if (color) return { type: 'COLOR', value: color };

  const length = LENGTH.exec(value);
  if (length) {
    const numeric = parseFloat(length[1]);
    const unit = length[2];
    if (unit === 'rem' || unit === 'em') return { type: 'FLOAT', value: numeric * (options.remBase ?? 16) };
    return { type: 'FLOAT', value: numeric };
  }

  if (value === 'true' || value === 'false') return { type: 'BOOLEAN', value: value === 'true' };

  // Multi-part values (shadows, font stacks, gradients) have no variable
  // equivalent in Figma. Keep them as strings so they are at least visible.
  if (/\s/.test(value) || value.includes(',')) {
    if (/\d+(px|rem)\s+\d/.test(value) || value.includes('gradient(')) {
      return { unsupported: 'composite value — Figma variables hold a single value' };
    }
    return { type: 'STRING', value };
  }

  return { type: 'STRING', value };
}

/**
 * `--color-blue-500` becomes `color/blue/500`, so Figma groups it the way the
 * naming already implies. `flat` keeps the original for systems whose dashes
 * are not hierarchical.
 */
export function tokenName(cssName: string, style: 'slash' | 'flat' = 'slash'): string {
  const bare = cssName.replace(/^--/, '');
  return style === 'flat' ? bare : bare.replace(/-/g, '/');
}

/** Figma rejects duplicate names in a collection; make later ones unique. */
export function deduplicate(variables: TokenVariable[], warnings: string[]): TokenVariable[] {
  const seen = new Map<string, number>();
  const out: TokenVariable[] = [];
  for (const variable of variables) {
    const count = seen.get(variable.name) ?? 0;
    seen.set(variable.name, count + 1);
    if (count === 0) {
      out.push(variable);
      continue;
    }
    warnings.push(`Duplicate token name "${variable.name}" (from ${variable.sourceId}) renamed to "${variable.name}-${count + 1}".`);
    out.push({ ...variable, name: `${variable.name}-${count + 1}` });
  }
  return out;
}

/**
 * A token defined only as `var(--other)` has no type of its own — `inferValue`
 * has to guess, and it guesses COLOR because that is the common case. Walk the
 * alias chain to whatever holds a concrete value and correct the guess, so a
 * `--radius-card: var(--radius-lg)` does not arrive in Figma as a colour.
 */
export function resolveAliasTypes(collection: TokenCollection, warnings: string[]): void {
  const byCssName = new Map<string, TokenVariable>();
  for (const variable of collection.variables) {
    const cssName = variable.sourceId.startsWith('css:') ? variable.sourceId.slice(4) : null;
    if (cssName) byCssName.set(cssName, variable);
  }

  const isAlias = (value: TokenValue): value is TokenAlias =>
    !!value && typeof value === 'object' && 'alias' in value;

  const concreteType = (variable: TokenVariable, seen: Set<string>): TokenType | null => {
    const values = Object.values(variable.valuesByMode);
    const direct = values.find((value) => !isAlias(value));
    if (direct !== undefined) return variable.type;

    for (const value of values) {
      if (!isAlias(value)) continue;
      if (seen.has(value.alias)) continue;
      seen.add(value.alias);
      const target = byCssName.get(value.alias);
      if (!target) continue;
      const resolved = concreteType(target, seen);
      if (resolved) return resolved;
    }
    return null;
  };

  for (const variable of collection.variables) {
    const values = Object.values(variable.valuesByMode);
    if (!values.length || values.some((value) => !isAlias(value))) continue;

    const resolved = concreteType(variable, new Set([variable.sourceId]));
    if (resolved) {
      variable.type = resolved;
    } else {
      warnings.push(
        `"${variable.name}" only ever references other tokens and none of them resolve here; ` +
          'it will be imported as a colour. Import the file that defines the target first.'
      );
    }
  }
}
