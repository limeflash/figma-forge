/**
 * Computed CSS values, read the way Chrome serializes them.
 *
 * Computed styles are far more regular than authored ones — lengths are px,
 * shorthands are expanded, keywords are resolved — so these parsers only have
 * to cover what `getComputedStyle` actually returns, not what people write.
 */

import type { Matrix, PaintIR, RGBAValue } from '../../../shared/html-import.js';
import { oklchToRgb, parseColor } from '../import/ir.js';

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Splits on a separator that is not inside parentheses or quotes. */
export function splitTopLevel(value: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const char of value) {
    if (quote) {
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth++;
    else if (char === ')') depth--;
    if (depth === 0 && (separator === ' ' ? /\s/.test(char) : char === separator)) {
      if (current.trim()) out.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export function px(value: string | undefined, fallback = 0): number {
  if (!value) return fallback;
  const number = parseFloat(value);
  return Number.isFinite(number) ? number : fallback;
}

/* ------------------------------------------------------------------ *
 * Colour
 * ------------------------------------------------------------------ */

const encode = (linear: number) =>
  linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(Math.max(linear, 0), 1 / 2.4) - 0.055;
const decode = (channel: number) =>
  channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);

function numbers(body: string): { parts: number[]; alpha: number } | null {
  const [main, alphaPart] = body.split('/');
  const parts = main.trim().split(/[\s,]+/).filter(Boolean).map((token) => {
    if (token === 'none') return 0;
    const numeric = parseFloat(token);
    return token.endsWith('%') ? numeric / 100 : numeric;
  });
  if (parts.some((part) => !Number.isFinite(part))) return null;
  let alpha = 1;
  if (alphaPart !== undefined) {
    const token = alphaPart.trim();
    alpha = token.endsWith('%') ? parseFloat(token) / 100 : parseFloat(token);
    if (!Number.isFinite(alpha)) alpha = 1;
  }
  return { parts, alpha: clamp01(alpha) };
}

function labToRgb(l: number, a: number, b: number): [number, number, number] {
  // CIE Lab (D50) → XYZ → Bradford-adapted D65 → linear sRGB.
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const e = 216 / 24389;
  const k = 24389 / 27;
  const x = (fx ** 3 > e ? fx ** 3 : (116 * fx - 16) / k) * 0.96422;
  const y = l > k * e ? fy ** 3 : l / k;
  const z = (fz ** 3 > e ? fz ** 3 : (116 * fz - 16) / k) * 0.82521;
  const x65 = 0.9555766 * x - 0.0230393 * y + 0.0631636 * z;
  const y65 = -0.0282895 * x + 1.0099416 * y + 0.0210077 * z;
  const z65 = 0.0122982 * x - 0.020483 * y + 1.3299098 * z;
  return [
    3.2404542 * x65 - 1.5371385 * y65 - 0.4985314 * z65,
    -0.969266 * x65 + 1.8760108 * y65 + 0.041556 * z65,
    0.0556434 * x65 - 0.2040259 * y65 + 1.0572252 * z65,
  ];
}

function oklabToLinear(l: number, a: number, b: number): [number, number, number] {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const fromLinear = ([r, g, b]: [number, number, number], alpha: number): RGBAValue => ({
  r: clamp01(encode(r)),
  g: clamp01(encode(g)),
  b: clamp01(encode(b)),
  a: alpha,
});

export function color(value: string | undefined): RGBAValue | null {
  if (!value) return null;
  const text = value.trim().toLowerCase();
  if (!text || text === 'none' || text === 'currentcolor') return null;
  if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

  const call = /^([a-z-]+)\((.*)\)$/.exec(text);
  if (call) {
    const [, fn, body] = call;
    if (fn === 'color') {
      const [space, ...rest] = body.trim().split(/\s+/);
      const parsed = numbers(rest.join(' '));
      if (!parsed || parsed.parts.length < 3) return null;
      const [r, g, b] = parsed.parts;
      if (space === 'srgb') return { r: clamp01(r), g: clamp01(g), b: clamp01(b), a: parsed.alpha };
      if (space === 'srgb-linear') return fromLinear([r, g, b], parsed.alpha);
      if (space === 'display-p3') {
        const [lr, lg, lb] = [decode(r), decode(g), decode(b)];
        return fromLinear(
          [
            1.2249401 * lr - 0.2249404 * lg,
            -0.0420569 * lr + 1.0420571 * lg,
            -0.0196376 * lr - 0.0786361 * lg + 1.0982735 * lb,
          ],
          parsed.alpha
        );
      }
      return null;
    }
    if (fn === 'oklab' || fn === 'oklch' || fn === 'lab' || fn === 'lch') {
      const parsed = numbers(body);
      if (!parsed || parsed.parts.length < 3) return null;
      let [l, x, y] = parsed.parts;
      // Percent lightness was divided by 100 above; oklab wants 0..1, lab 0..100.
      if (fn === 'lab' || fn === 'lch') {
        if (body.trim().split(/\s+/)[0].endsWith('%')) l *= 100;
      }
      if (fn === 'oklch' || fn === 'lch') {
        const hue = (y * Math.PI) / 180;
        [x, y] = [x * Math.cos(hue), x * Math.sin(hue)];
      }
      if (fn === 'oklab' || fn === 'oklch') {
        if (fn === 'oklch') {
          const rgb = oklchToRgb(l, Math.hypot(x, y), (Math.atan2(y, x) * 180) / Math.PI);
          return { ...rgb, a: parsed.alpha };
        }
        return fromLinear(oklabToLinear(l, x, y), parsed.alpha);
      }
      return fromLinear(labToRgb(l, x, y), parsed.alpha);
    }
    if (fn === 'hwb') {
      const parsed = numbers(body);
      if (!parsed || parsed.parts.length < 3) return null;
      const [h, w, bl] = parsed.parts;
      const base = parseColor(`hsl(${h} 100% 50%)`);
      if (!base) return null;
      const scale = 1 - w - bl;
      const mix = (channel: number) => clamp01(channel * scale + w);
      return { r: mix(base.r), g: mix(base.g), b: mix(base.b), a: parsed.alpha };
    }
  }

  const parsed = parseColor(text);
  if (!parsed) return null;
  return { r: parsed.r, g: parsed.g, b: parsed.b, a: parsed.a ?? 1 };
}

export function solid(value: string | undefined, opacity = 1): PaintIR | null {
  const parsed = color(value);
  if (!parsed || parsed.a * opacity < 0.002) return null;
  return { type: 'SOLID', color: { ...parsed, a: parsed.a * opacity } };
}

/* ------------------------------------------------------------------ *
 * Shadows
 * ------------------------------------------------------------------ */

export interface Shadow {
  inset: boolean;
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: RGBAValue;
}

const COLOR_TOKEN = /^(#|rgb|hsl|hwb|lab|lch|oklab|oklch|color\(|[a-z]+$)/i;

export function shadows(value: string | undefined): Shadow[] {
  if (!value || value === 'none') return [];
  const out: Shadow[] = [];
  for (const layer of splitTopLevel(value, ',')) {
    const tokens = splitTopLevel(layer, ' ');
    let inset = false;
    let parsedColor: RGBAValue | null = null;
    const lengths: number[] = [];
    for (const token of tokens) {
      if (token === 'inset') inset = true;
      else if (/^-?[\d.]+(px)?$/.test(token)) lengths.push(parseFloat(token));
      else if (COLOR_TOKEN.test(token)) parsedColor = color(token) ?? parsedColor;
    }
    if (lengths.length < 2) continue;
    const shadow: Shadow = {
      inset,
      x: lengths[0],
      y: lengths[1],
      blur: lengths[2] ?? 0,
      spread: lengths[3] ?? 0,
      color: parsedColor ?? { r: 0, g: 0, b: 0, a: 1 },
    };
    if (shadow.color.a < 0.002) continue;
    out.push(shadow);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Gradients
 * ------------------------------------------------------------------ */

interface Stop {
  color: RGBAValue;
  position: number | null;
}

function parseStops(parts: string[], length: number): { position: number; color: RGBAValue }[] | null {
  const stops: Stop[] = [];
  for (const part of parts) {
    const tokens = splitTopLevel(part, ' ');
    const colorToken = tokens.find((token) => !/^-?[\d.]+(px|%)?$/.test(token));
    if (!colorToken) continue; // a colour hint; approximated by ignoring it
    const parsed = color(colorToken);
    if (!parsed) return null;
    const positions = tokens
      .filter((token) => token !== colorToken)
      .map((token) => (token.endsWith('%') ? parseFloat(token) / 100 : length > 0 ? parseFloat(token) / length : 0));
    if (!positions.length) stops.push({ color: parsed, position: null });
    for (const position of positions) stops.push({ color: parsed, position });
  }
  if (stops.length < 2) return null;

  // Unpositioned stops spread evenly between their positioned neighbours.
  if (stops[0].position === null) stops[0].position = 0;
  if (stops[stops.length - 1].position === null) stops[stops.length - 1].position = 1;
  for (let index = 1; index < stops.length; index++) {
    if (stops[index].position !== null) {
      stops[index].position = Math.max(stops[index].position!, stops[index - 1].position!);
      continue;
    }
    let next = index;
    while (stops[next].position === null) next++;
    const from = stops[index - 1].position!;
    const to = stops[next].position!;
    const count = next - index + 1;
    for (let fill = index; fill < next; fill++) {
      stops[fill].position = from + ((to - from) * (fill - index + 1)) / count;
    }
  }
  return stops.map((stop) => ({ color: stop.color, position: clamp01(stop.position!) }));
}

const CORNERS: Record<string, [number, number]> = {
  top: [0, -1],
  bottom: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

function linearAngle(prefix: string, width: number, height: number): number | null {
  const trimmed = prefix.trim();
  const angle = /^(-?[\d.]+)(deg|rad|turn|grad)$/.exec(trimmed);
  if (angle) {
    const value = parseFloat(angle[1]);
    return angle[2] === 'deg' ? value : angle[2] === 'rad' ? (value * 180) / Math.PI : angle[2] === 'turn' ? value * 360 : value * 0.9;
  }
  if (!trimmed.startsWith('to ')) return null;
  const words = trimmed.slice(3).split(/\s+/);
  let dx = 0;
  let dy = 0;
  for (const word of words) {
    const vector = CORNERS[word];
    if (!vector) return null;
    dx += vector[0];
    dy += vector[1];
  }
  if (dx !== 0 && dy !== 0) {
    // Corner keywords: the gradient line is perpendicular to the diagonal that
    // does not touch that corner.
    return (Math.atan2(dx * height, -dy * width) * 180) / Math.PI;
  }
  return (Math.atan2(dx, -dy) * 180) / Math.PI;
}

/**
 * Figma's `gradientTransform` maps the layer's unit square onto gradient
 * space, where a linear gradient runs from x=0 to x=1.
 */
function linearTransform(degrees: number, width: number, height: number): Matrix {
  const theta = (degrees * Math.PI) / 180;
  const sin = Math.sin(theta);
  const cos = Math.cos(theta);
  const length = Math.abs(width * sin) + Math.abs(height * cos) || 1;
  const a = (width * sin) / length;
  const b = (-height * cos) / length;
  const d = (width * cos) / length;
  const e = (height * sin) / length;
  return [
    [a, b, 0.5 - (a + b) / 2],
    [d, e, 0.5 - (d + e) / 2],
  ];
}

function position(token: string | undefined, size: number): number {
  if (!token) return size / 2;
  if (token === 'left' || token === 'top') return 0;
  if (token === 'right' || token === 'bottom') return size;
  if (token === 'center') return size / 2;
  if (token.endsWith('%')) return (parseFloat(token) / 100) * size;
  return parseFloat(token) || 0;
}

function radialGeometry(prefix: string, width: number, height: number): { cx: number; cy: number; rx: number; ry: number } {
  const [shapePart, atPart] = prefix.split(/\bat\b/).map((part) => part.trim());
  const at = (atPart ?? '').split(/\s+/).filter(Boolean);
  let cx = position(at[0], width);
  let cy = position(at[1] ?? (at[0] === 'top' || at[0] === 'bottom' ? undefined : 'center'), height);
  if (at[0] === 'top' || at[0] === 'bottom') {
    cy = position(at[0], height);
    cx = position(at[1], width);
  }

  const words = (shapePart ?? '').split(/\s+/).filter(Boolean);
  const circle = words.includes('circle');
  const lengths = words.filter((word) => /^[\d.]+(px|%)$/.test(word));
  const keyword = words.find((word) => /(closest|farthest)-(side|corner)/.test(word)) ?? 'farthest-corner';

  if (lengths.length) {
    const rx = lengths[0].endsWith('%') ? (parseFloat(lengths[0]) / 100) * width : parseFloat(lengths[0]);
    const ry = lengths[1] ? (lengths[1].endsWith('%') ? (parseFloat(lengths[1]) / 100) * height : parseFloat(lengths[1])) : rx;
    return { cx, cy, rx, ry: circle ? rx : ry };
  }

  const sideX = keyword.startsWith('closest') ? Math.min(cx, width - cx) : Math.max(cx, width - cx);
  const sideY = keyword.startsWith('closest') ? Math.min(cy, height - cy) : Math.max(cy, height - cy);
  if (circle) {
    const r = keyword.endsWith('corner') ? Math.hypot(sideX, sideY) : Math.min(sideX, sideY);
    return { cx, cy, rx: r, ry: r };
  }
  const factor = keyword.endsWith('corner') ? Math.SQRT2 : 1;
  return { cx, cy, rx: sideX * factor, ry: sideY * factor };
}

/** One `background-image` layer that is a gradient, as a Figma paint. */
export function gradient(layer: string, width: number, height: number): PaintIR | null {
  const call = /^(linear|radial)-gradient\((.*)\)$/s.exec(layer.trim());
  if (!call) return null;
  const [, kind, body] = call;
  const parts = splitTopLevel(body, ',');
  if (!parts.length) return null;

  if (kind === 'linear') {
    let degrees = linearAngle(parts[0], width, height);
    const stopParts = degrees === null ? parts : parts.slice(1);
    if (degrees === null) degrees = 180;
    const theta = (degrees * Math.PI) / 180;
    const length = Math.abs(width * Math.sin(theta)) + Math.abs(height * Math.cos(theta));
    const stops = parseStops(stopParts, length);
    if (!stops) return null;
    return { type: 'GRADIENT_LINEAR', transform: linearTransform(degrees, width, height), stops };
  }

  const first = parts[0];
  const hasPrefix = /\b(circle|ellipse|at|closest|farthest)\b/.test(first) || /^[\d.]+(px|%)(\s|$)/.test(first);
  const geometry = radialGeometry(hasPrefix ? first : '', width, height);
  const stops = parseStops(hasPrefix ? parts.slice(1) : parts, Math.max(geometry.rx, 1));
  if (!stops) return null;
  const rx = Math.max(geometry.rx / (width || 1), 1e-4);
  const ry = Math.max(geometry.ry / (height || 1), 1e-4);
  const cx = geometry.cx / (width || 1);
  const cy = geometry.cy / (height || 1);
  const a = 0.5 / rx;
  const e = 0.5 / ry;
  return {
    type: 'GRADIENT_RADIAL',
    transform: [
      [a, 0, 0.5 - cx * a],
      [0, e, 0.5 - cy * e],
    ],
    stops,
  };
}

/* ------------------------------------------------------------------ *
 * Fonts
 * ------------------------------------------------------------------ */

export function fontFamilies(value: string | undefined): string[] {
  if (!value) return [];
  return splitTopLevel(value, ',')
    .map((family) => family.replace(/^["']|["']$/g, '').trim())
    .filter(Boolean);
}

/** `url("…")` targets inside a background-image value, in layer order. */
export function urls(value: string): string[] {
  const out: string[] = [];
  const pattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) out.push((match[1] ?? match[2] ?? match[3] ?? '').trim());
  return out;
}
