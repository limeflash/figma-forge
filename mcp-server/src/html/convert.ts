/**
 * Measured DOM → Figma layers.
 *
 * The browser has already laid everything out, so every decision here can be
 * checked against the real geometry: an auto layout is only emitted when its
 * padding, spacing and alignment reproduce the positions the page actually
 * has. Where they cannot — overlapping items, floats — that one container
 * falls back to absolute positions, and the rest of the tree keeps its auto
 * layout.
 *
 * CSS intent (flex-grow, align-items, justify-content) decides *how* a layer
 * resizes; measured boxes decide *where* it is. The result behaves like the
 * code when a designer edits it, instead of being a screenshot made of frames.
 */

import type {
  AutoLayoutIR,
  Box,
  EffectIR,
  FrameIR,
  ImageIR,
  LayerIR,
  PaintIR,
  RawCollection,
  RawElement,
  RawNode,
  RawRun,
  RawText,
  ScaleMode,
  Sizing,
  StrokeIR,
  StyleMap,
  TextIR,
  TextStyleIR,
  VectorIR,
} from '../../../shared/html-import.js';
import { color, fontFamilies, gradient, px, Shadow, shadows, solid, splitTopLevel, urls } from './css.js';
import type { AssetData } from './render.js';

const EPS = 0.75;
const near = (a: number, b: number, tolerance = EPS) => Math.abs(a - b) <= tolerance;
const round2 = (value: number) => Math.round(value * 100) / 100;

export interface ConvertStats {
  frames: number;
  texts: number;
  vectors: number;
  images: number;
  rasters: number;
  autoLayout: number;
  absoluteContainers: number;
  wrappers: number;
  groups: number;
}

export interface ConvertResult {
  root: FrameIR;
  warnings: string[];
  stats: ConvertStats;
}

interface Context {
  styles: StyleMap[];
  assets: Map<string, AssetData>;
  assetSources: Map<string, string>;
  warnings: string[];
  stats: ConvertStats;
  /** SVG backgrounds waiting to be added to their frame as vector children. */
  backgrounds: Map<FrameIR, { svg: string; rect: Box }[]>;
}

/** A converted child, with what its parent needs to place it. */
interface Item {
  layer: LayerIR;
  /** Document box of what the layer shows. */
  box: Box;
  /** The element's own style, for flex, grid and position properties. */
  style: StyleMap;
  inline: boolean;
  /** Hug sizing reproduces the measured width / height. */
  hugW: boolean;
  hugH: boolean;
  /** Absolutely or fixed positioned: outside the parent's flow. */
  positioned: boolean;
  zIndex: number;
  /** Fixed-width text that may follow its container's width. */
  flexibleText?: boolean;
}

/** Relative and sticky boxes stay in flow but paint like positioned ones. */
const paintsPositioned = (item: Item) => !item.positioned && (item.style.position === 'relative' || item.style.position === 'sticky');

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

interface Edges {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const NO_EDGES: Edges = { top: 0, right: 0, bottom: 0, left: 0 };

function borders(s: StyleMap, z: number): Edges {
  const side = (name: string) => (s[`border-${name}-style`] && s[`border-${name}-style`] !== 'none' ? px(s[`border-${name}-width`]) * z : 0);
  return { top: side('top'), right: side('right'), bottom: side('bottom'), left: side('left') };
}

/** Border plus padding: from the border box in to the content box. */
function insets(s: StyleMap, z: number): Edges {
  const b = borders(s, z);
  return {
    top: b.top + px(s['padding-top']) * z,
    right: b.right + px(s['padding-right']) * z,
    bottom: b.bottom + px(s['padding-bottom']) * z,
    left: b.left + px(s['padding-left']) * z,
  };
}

const edgeSum = (edges: Edges) => edges.top + edges.right + edges.bottom + edges.left;

function contentBox(box: Box, inset: Edges): Box {
  return [box[0] + inset.left, box[1] + inset.top, Math.max(0, box[2] - inset.left - inset.right), Math.max(0, box[3] - inset.top - inset.bottom)];
}

function union(boxes: Box[]): Box {
  const left = Math.min(...boxes.map((b) => b[0]));
  const top = Math.min(...boxes.map((b) => b[1]));
  const right = Math.max(...boxes.map((b) => b[0] + b[2]));
  const bottom = Math.max(...boxes.map((b) => b[1] + b[3]));
  return [left, top, right - left, bottom - top];
}

const isPositioned = (s: StyleMap) => s.position === 'absolute' || s.position === 'fixed';

type Axis = 'x' | 'y';
const start = (box: Box, axis: Axis) => (axis === 'x' ? box[0] : box[1]);
const size = (box: Box, axis: Axis) => (axis === 'x' ? box[2] : box[3]);
const end = (box: Box, axis: Axis) => start(box, axis) + size(box, axis);
const other = (axis: Axis): Axis => (axis === 'x' ? 'y' : 'x');

/* ------------------------------------------------------------------ *
 * Names
 * ------------------------------------------------------------------ */

const TAG_NAMES: Record<string, string> = {
  header: 'Header',
  nav: 'Nav',
  footer: 'Footer',
  main: 'Main',
  aside: 'Aside',
  section: 'Section',
  article: 'Article',
  form: 'Form',
  button: 'Button',
  label: 'Label',
  ul: 'List',
  ol: 'List',
  input: 'Input',
  textarea: 'Textarea',
  select: 'Select',
  img: 'Image',
  picture: 'Image',
  table: 'Table',
  tr: 'Row',
  hr: 'Divider',
  dialog: 'Dialog',
  canvas: 'Canvas',
  video: 'Video',
  iframe: 'Embed',
};

const MACHINE_NAME = /^(css|sc|jsx|svelte|emotion|tw)-|^[a-z]{1,2}\d|^_|^[a-z0-9]{7,}$|\d{3,}/i;

function nameFor(el: RawElement): string {
  const a = el.a;
  if (a?.label) return a.label;
  if (a?.ariaLabel) return a.ariaLabel;
  if (el.pseudo) return `::${el.pseudo}`;
  if (TAG_NAMES[el.tag]) return TAG_NAMES[el.tag];
  const human = [a?.id, ...(a?.className?.split(/\s+/) ?? [])].find(
    (token): token is string => !!token && /^[a-zA-Z][\w-]{2,40}$/.test(token) && !MACHINE_NAME.test(token)
  );
  if (human) return human;
  if (el.tag === 'a') return 'Link';
  if (el.tag === 'li') return 'List item';
  if (el.s.cursor === 'pointer') return 'Button';
  return 'Frame';
}

/* ------------------------------------------------------------------ *
 * Paint, stroke, effects
 * ------------------------------------------------------------------ */

/** Intrinsic size of an SVG, from its width/height or its viewBox. */
function svgSize(markup: string): [number, number] | null {
  const width = /<svg[^>]*\bwidth="([\d.]+)(?:px)?"/i.exec(markup);
  const height = /<svg[^>]*\bheight="([\d.]+)(?:px)?"/i.exec(markup);
  if (width && height) return [parseFloat(width[1]), parseFloat(height[1])];
  const viewBox = /<svg[^>]*\bviewBox="([-\d.\s]+)"/i.exec(markup);
  if (viewBox) {
    const parts = viewBox[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) return [parts[2], parts[3]];
  }
  return null;
}

/** Where CSS paints a background image inside the element's box. */
function backgroundRect(intrinsic: [number, number], s: StyleMap, box: Box, index: number, z: number): Box {
  const sizeValue = (splitTopLevel(s['background-size'] ?? 'auto', ',')[index] ?? 'auto').trim();
  const [boxWidth, boxHeight] = [box[2], box[3]];
  let width: number;
  let height: number;
  if (sizeValue === 'cover' || sizeValue === 'contain') {
    const ratios = [boxWidth / intrinsic[0], boxHeight / intrinsic[1]];
    const scale = sizeValue === 'cover' ? Math.max(...ratios) : Math.min(...ratios);
    width = intrinsic[0] * scale;
    height = intrinsic[1] * scale;
  } else {
    const parts = sizeValue.split(/\s+/);
    const resolve = (token: string | undefined, extent: number, fallback: number) =>
      !token || token === 'auto' ? fallback : token.endsWith('%') ? (parseFloat(token) / 100) * extent : parseFloat(token) * z;
    width = resolve(parts[0], boxWidth, intrinsic[0] * z);
    height = resolve(parts[1], boxHeight, (width / intrinsic[0]) * intrinsic[1]);
  }
  const position = (splitTopLevel(s['background-position'] ?? '50% 50%', ',')[index] ?? '50% 50%').trim().split(/\s+/);
  const offset = (token: string | undefined, extent: number, drawn: number) => {
    if (!token || token === 'center') return (extent - drawn) / 2;
    if (token === 'left' || token === 'top') return 0;
    if (token === 'right' || token === 'bottom') return extent - drawn;
    if (token.endsWith('%')) return (parseFloat(token) / 100) * (extent - drawn);
    return parseFloat(token) * z;
  };
  return [round2(offset(position[0], boxWidth, width)), round2(offset(position[1], boxHeight, height)), round2(width), round2(height)];
}

interface Background {
  fills: PaintIR[];
  /** SVG backgrounds, kept as vectors instead of being flattened to pixels. */
  vectors: { svg: string; rect: Box }[];
}

function backgroundFills(ctx: Context, s: StyleMap, box: Box, label: string, z: number): Background {
  const fills: PaintIR[] = [];
  const vectors: Background['vectors'] = [];
  const base = solid(s['background-color']);
  if (base) fills.push(base);

  const image = s['background-image'];
  if (!image || image === 'none') return { fills, vectors };

  // CSS lists the top layer first; Figma paints the last fill on top.
  const layers = splitTopLevel(image, ',');
  const sizes = splitTopLevel(s['background-size'] ?? 'auto', ',');
  layers.forEach((layer, index) => {
    if (layer.startsWith('url(')) {
      const src = urls(layer)[0];
      const asset = src ? ctx.assetSources.get(src) : undefined;
      const data = asset ? ctx.assets.get(asset) : undefined;
      if (!asset || !data || data.kind === 'missing') {
        ctx.warnings.push(`${label}: background image ${src?.slice(0, 60) ?? ''} is missing.`);
        return;
      }
      if (data.kind === 'svg') {
        const intrinsic = svgSize(data.text);
        if (!intrinsic) {
          ctx.warnings.push(`${label}: background SVG has no size and was dropped.`);
          return;
        }
        vectors.push({ svg: data.text, rect: backgroundRect(intrinsic, s, box, index, z) });
        return;
      }
      const sizeValue = sizes[index] ?? 'auto';
      const repeats = !/no-repeat/.test(s['background-repeat'] ?? 'repeat');
      const scaleMode: ScaleMode = sizeValue === 'contain' ? 'FIT' : sizeValue === 'cover' || /100%/.test(sizeValue) || !repeats ? 'FILL' : 'TILE';
      fills.push({ type: 'IMAGE', asset, scaleMode });
      return;
    }
    const paint = gradient(layer, box[2], box[3]);
    if (paint) fills.push(paint);
    else ctx.warnings.push(`${label}: background ${layer.slice(0, 50)} is not supported and was dropped.`);
  });
  // CSS paints the first layer on top; Figma paints the last fill on top.
  fills.reverse();
  if (base) {
    fills.splice(fills.indexOf(base), 1);
    fills.unshift(base);
  }
  return { fills, vectors };
}

/**
 * `box-shadow: inset 0 0 0 1px …` is how a hairline border is written when it
 * must not change the size of the box. Figma paints an inner shadow only
 * inside a fill, so on a transparent element it would disappear entirely —
 * and even where it shows, a stroke is what a designer would have drawn.
 */
function isRing(shadow: Shadow): boolean {
  return shadow.inset && !shadow.x && !shadow.y && !shadow.blur && shadow.spread > 0;
}

function ring(s: StyleMap): Shadow | undefined {
  const b = borders(s, 1);
  if ([b.top, b.right, b.bottom, b.left].some((width) => width > 0)) return undefined;
  return shadows(s['box-shadow']).find(isRing);
}

function strokeOf(s: StyleMap, z: number): StrokeIR | undefined {
  const b = borders(s, z);
  const widths = [b.top, b.right, b.bottom, b.left];
  if (widths.every((width) => width <= 0)) {
    const inset = ring(s);
    return inset ? { paints: [{ type: 'SOLID', color: inset.color }], weight: round2(inset.spread * z) } : undefined;
  }
  const sides = ['top', 'right', 'bottom', 'left'] as const;
  // Figma has one stroke colour per layer; take the thickest side's.
  const main = sides[widths.indexOf(Math.max(...widths))];
  const paint = solid(s[`border-${main}-color`]);
  if (!paint) return undefined;
  const uniform = widths.every((width) => near(width, widths[0], 0.01));
  const stroke: StrokeIR = { paints: [paint], weight: uniform ? widths[0] : (widths as [number, number, number, number]) };
  const weight = Math.max(...widths, 1);
  const style = s[`border-${main}-style`];
  if (style === 'dashed') stroke.dash = [weight * 3, weight * 2];
  else if (style === 'dotted') stroke.dash = [weight, weight];
  return stroke;
}

function radiusOf(s: StyleMap, box: Box, z: number): number | [number, number, number, number] | undefined {
  const corner = (name: string) => {
    const value = s[`border-${name}-radius`];
    if (!value) return 0;
    const [horizontal, vertical = horizontal] = value.split(/\s+/);
    const resolve = (token: string, extent: number) => (token.endsWith('%') ? (parseFloat(token) / 100) * extent : parseFloat(token) * z);
    return Math.min(resolve(horizontal, box[2]), resolve(vertical, box[3]));
  };
  const limit = Math.min(box[2], box[3]) / 2;
  const radii = [corner('top-left'), corner('top-right'), corner('bottom-right'), corner('bottom-left')].map((r) =>
    round2(Math.max(0, Math.min(r || 0, limit)))
  ) as [number, number, number, number];
  if (radii.every((r) => r <= 0)) return undefined;
  return radii.every((r) => r === radii[0]) ? radii[0] : radii;
}

function effectsOf(s: StyleMap, z: number): EffectIR[] | undefined {
  const effects: EffectIR[] = [];
  let asStroke = ring(s) !== undefined;
  for (const shadow of shadows(s['box-shadow'])) {
    // The one that became the stroke is not also an effect.
    if (asStroke && isRing(shadow)) {
      asStroke = false;
      continue;
    }
    effects.push({
      type: shadow.inset ? 'INNER_SHADOW' : 'DROP_SHADOW',
      color: shadow.color,
      x: shadow.x * z,
      y: shadow.y * z,
      blur: shadow.blur * z,
      spread: shadow.spread * z,
    });
  }
  // Figma's blur radius is twice the CSS standard deviation.
  const blur = /blur\(([\d.]+)px\)/.exec(s.filter ?? '');
  if (blur) effects.push({ type: 'LAYER_BLUR', radius: parseFloat(blur[1]) * 2 * z });
  const backdrop = /blur\(([\d.]+)px\)/.exec(s['backdrop-filter'] ?? '');
  if (backdrop) effects.push({ type: 'BACKGROUND_BLUR', radius: parseFloat(backdrop[1]) * 2 * z });
  return effects.length ? effects : undefined;
}

const BLEND_MODES: Record<string, string> = {
  multiply: 'MULTIPLY',
  screen: 'SCREEN',
  overlay: 'OVERLAY',
  darken: 'DARKEN',
  lighten: 'LIGHTEN',
  'color-dodge': 'COLOR_DODGE',
  'color-burn': 'COLOR_BURN',
  'hard-light': 'HARD_LIGHT',
  'soft-light': 'SOFT_LIGHT',
  difference: 'DIFFERENCE',
  exclusion: 'EXCLUSION',
  hue: 'HUE',
  saturation: 'SATURATION',
  color: 'COLOR',
  luminosity: 'LUMINOSITY',
};

function hasVisuals(frame: FrameIR): boolean {
  return !!(frame.fills?.length || frame.stroke || frame.effects?.length || frame.opacity !== undefined || frame.blendMode);
}

/* ------------------------------------------------------------------ *
 * Text
 * ------------------------------------------------------------------ */

function textStyle(ctx: Context, index: number, z: number, lineHeightFallback?: number): TextStyleIR {
  const s = ctx.styles[index] ?? {};
  const fillSource = s['-webkit-text-fill-color'] && (color(s['-webkit-text-fill-color'])?.a ?? 0) > 0 ? s['-webkit-text-fill-color'] : s.color;
  const style: TextStyleIR = {
    family: fontFamilies(s['font-family']),
    weight: parseInt(s['font-weight'] ?? '400', 10) || 400,
    size: round2(px(s['font-size'], 16) * z),
    fills: [solid(fillSource ?? 'rgb(0, 0, 0)') ?? { type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 0 } }],
  };
  if (/italic|oblique/.test(s['font-style'] ?? '')) style.italic = true;
  const lineHeight = s['line-height'];
  if (lineHeight && lineHeight !== 'normal') style.lineHeight = round2(px(lineHeight) * z);
  else if (lineHeightFallback) style.lineHeight = round2(lineHeightFallback);
  const spacing = px(s['letter-spacing']) * z;
  if (spacing) style.letterSpacing = round2(spacing);
  const decoration = s['text-decoration-line'] ?? '';
  if (decoration.includes('underline')) style.decoration = 'UNDERLINE';
  else if (decoration.includes('line-through')) style.decoration = 'STRIKETHROUGH';
  const transform = s['text-transform'];
  if (transform === 'uppercase') style.textCase = 'UPPER';
  else if (transform === 'lowercase') style.textCase = 'LOWER';
  else if (transform === 'capitalize') style.textCase = 'TITLE';
  return style;
}

const sameStyle = (a: TextStyleIR, b: TextStyleIR) => JSON.stringify(a) === JSON.stringify(b);

/**
 * CSS white-space processing across runs, the way the browser did it before
 * drawing: collapsible spaces merge, and vanish at line starts and ends.
 */
export function assembleText(runs: RawRun[]): { characters: string; pieces: { start: number; end: number; run: RawRun }[] } {
  const chars: { ch: string; run: number; collapsible: boolean }[] = [];
  runs.forEach((run, index) => {
    const preserve = run.ws === 'pre' || run.ws === 'pre-wrap' || run.ws === 'break-spaces';
    let text: string;
    if (run.br) text = '\n';
    else if (preserve) text = run.text.replace(/\t/g, '    ');
    else if (run.ws === 'pre-line') text = run.text.replace(/[ \t]+/g, ' ');
    else text = run.text.replace(/[\t\n\r\f ]+/g, ' ');
    text = text.replace(/​/g, '');
    for (const ch of text) {
      const collapsible = !preserve && ch === ' ';
      const previous = chars[chars.length - 1];
      if (collapsible && (!previous || (previous.ch === ' ' && previous.collapsible) || previous.ch === '\n')) continue;
      chars.push({ ch, run: index, collapsible });
    }
  });
  for (let index = chars.length - 1; index >= 0; index--) {
    if (chars[index].collapsible && (index === chars.length - 1 || chars[index + 1].ch === '\n')) chars.splice(index, 1);
  }

  let characters = '';
  const pieces: { start: number; end: number; runIndex: number }[] = [];
  for (const entry of chars) {
    const last = pieces[pieces.length - 1];
    if (last && last.runIndex === entry.run) last.end += entry.ch.length;
    else pieces.push({ start: characters.length, end: characters.length + entry.ch.length, runIndex: entry.run });
    characters += entry.ch;
  }
  return { characters, pieces: pieces.map((piece) => ({ start: piece.start, end: piece.end, run: runs[piece.runIndex] })) };
}

function alignOf(value: string | undefined, direction?: string): TextIR['align'] {
  switch (value) {
    case 'center':
    case '-webkit-center':
      return 'CENTER';
    case 'right':
    case '-webkit-right':
      return 'RIGHT';
    case 'end':
      return direction === 'rtl' ? 'LEFT' : 'RIGHT';
    case 'justify':
      return 'JUSTIFIED';
    default:
      return 'LEFT';
  }
}

interface TextSource {
  runs: RawRun[];
  base: number;
  /** Line boxes as rendered; empty when the page could not measure them. */
  lines: Box[];
}

interface MadeText {
  layer: TextIR;
  /** Where the words are. */
  box: Box;
  /** Whether the layer should hug its words rather than keep a width. */
  hug: boolean;
}

/**
 * `available` is the box the text was laid out in. A single line that fills
 * it hugs its words, so a font that runs slightly wider in Figma grows the
 * layer instead of wrapping onto a second line.
 */
function makeText(ctx: Context, source: TextSource, available: Box, z: number, width: 'auto' | 'fixed' | 'content' = 'auto'): MadeText | null {
  const { characters, pieces } = assembleText(source.runs);
  if (!characters.replace(/\n/g, '').trim() && !characters.includes('\n')) return null;

  const lines = source.lines.length ? source.lines : [available];
  const words = union(lines);
  const baseMap = ctx.styles[source.base] ?? {};
  const measuredLine = words[3] / lines.length;
  const base = textStyle(ctx, source.base, z, baseMap['line-height'] === 'normal' ? measuredLine : undefined);

  const runs: NonNullable<TextIR['runs']> = [];
  for (const piece of pieces) {
    const style = textStyle(ctx, piece.run.style, z, base.lineHeight);
    if (piece.run.href) style.href = piece.run.href;
    if (sameStyle(style, base)) continue;
    const last = runs[runs.length - 1];
    if (last && last.end === piece.start && sameStyle(last.style, style)) last.end = piece.end;
    else runs.push({ start: piece.start, end: piece.end, style });
  }
  if (runs.length === 1 && runs[0].start === 0 && runs[0].end === characters.length) {
    Object.assign(base, runs[0].style);
    runs.length = 0;
  }

  const truncate = baseMap['text-overflow'] === 'ellipsis' && !!baseMap['overflow-x'] && baseMap['overflow-x'] !== 'visible';
  const clamp = parseInt(baseMap['-webkit-line-clamp'] ?? '', 10);
  const singleLine = lines.length <= 1 && !characters.includes('\n');
  const hug = width !== 'fixed' && !truncate && singleLine && (width === 'content' || available[2] - words[2] <= 8);
  const box: Box = hug ? words : [available[0], words[1], available[2], words[3]];

  const layer: TextIR = {
    type: 'TEXT',
    name: characters.slice(0, 40),
    x: 0,
    y: 0,
    width: box[2],
    height: box[3],
    characters,
    style: base,
    resize: hug ? 'WIDTH_AND_HEIGHT' : 'HEIGHT',
    align: alignOf(baseMap['text-align'], baseMap.direction),
  };
  if (truncate) layer.maxLines = 1;
  else if (clamp > 0) layer.maxLines = clamp;
  if (runs.length) layer.runs = runs;
  const textShadows = shadows(baseMap['text-shadow']);
  if (textShadows.length) {
    layer.effects = textShadows.map((shadow) => ({
      type: 'DROP_SHADOW' as const,
      color: shadow.color,
      x: shadow.x * z,
      y: shadow.y * z,
      blur: shadow.blur * z,
      spread: 0,
    }));
  }
  ctx.stats.texts++;
  return { layer, box, hug };
}

/* ------------------------------------------------------------------ *
 * Layout
 * ------------------------------------------------------------------ */

interface Plan {
  layout: AutoLayoutIR;
  children: LayerIR[];
  hugMain: boolean;
  hugCross: boolean;
}

function transparentFrame(name: string, box: Box, children: LayerIR[]): FrameIR {
  return { type: 'FRAME', name, x: 0, y: 0, width: box[2], height: box[3], children };
}

function setSizing(layer: LayerIR, axis: Axis, main: Sizing, cross: Sizing): void {
  layer.sizing = axis === 'x' ? { h: main, v: cross } : { h: cross, v: main };
}

const hugsOn = (item: Item, axis: Axis) => (axis === 'x' ? item.hugW : item.hugH);

/**
 * Text sized to its words must keep hugging. Figma's copy of a font is rarely
 * glyph-for-glyph the browser's, so a line that just fits at its measured
 * width would wrap onto a second line the moment it is asked to fill.
 */
const hugsItsWords = (item: Item) => item.layer.type === 'TEXT' && item.layer.resize === 'WIDTH_AND_HEIGHT';

interface LinearOptions {
  justify: string;
  alignItems: string;
  /** `align-items: normal` stretches in flex and grid, and for blocks. */
  stretchByDefault: boolean;
  allowBaseline: boolean;
}

/**
 * One row or column: the workhorse behind flex, single-track grids, block flow
 * and lines of inline boxes. Returns null when spacing cannot reproduce the
 * measured positions.
 */
/** Spacing differences below this are rounding, not design. */
const GAP_TOLERANCE = 1.5;

/**
 * Splits items where the spacing is widest, so each group holds the items that
 * belong together and the wide gap becomes the spacing between groups. This is
 * how a designer builds it: spacing between blocks, not padding inside them.
 */
function groupByGap(ctx: Context, axis: Axis, sorted: Item[], gaps: number[], options: LinearOptions, depth: number): Item[] | null {
  const widest = Math.max(...gaps);
  const groups: Item[][] = [[sorted[0]]];
  gaps.forEach((gap, index) => {
    if (gap >= widest - GAP_TOLERANCE) groups.push([sorted[index + 1]]);
    else groups[groups.length - 1].push(sorted[index + 1]);
  });
  if (groups.length < 2 || !groups.some((group) => group.length > 1)) return null;

  const out: Item[] = [];
  for (const group of groups) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    const groupBox = union(group.map((item) => item.box));
    const plan = linear(ctx, axis, groupBox, groupBox, NO_EDGES, group, { ...options, justify: 'normal' }, depth + 1);
    if (!plan) return null;
    const frame = transparentFrame(axis === 'x' ? 'Row' : 'Stack', groupBox, plan.children);
    frame.layout = plan.layout;
    ctx.stats.frames++;
    ctx.stats.autoLayout++;
    ctx.stats.groups++;
    out.push({
      layer: frame,
      box: groupBox,
      style: {},
      inline: false,
      hugW: axis === 'x' ? plan.hugMain : plan.hugCross,
      hugH: axis === 'x' ? plan.hugCross : plan.hugMain,
      positioned: false,
      zIndex: 0,
    });
  }
  return out;
}

function linear(ctx: Context, axis: Axis, box: Box, content: Box, inset: Edges, items: Item[], options: LinearOptions, depth = 0): Plan | null {
  const cross = other(axis);
  const sorted = [...items].sort((a, b) => start(a.box, axis) - start(b.box, axis));

  const gaps = sorted.slice(1).map((item, index) => start(item.box, axis) - end(sorted[index].box, axis));
  if (gaps.some((gap) => gap < -EPS) && !gaps.every((gap) => near(gap, gaps[0], 0.5))) return null;

  const contentStart = start(content, axis);
  const contentEnd = end(content, axis);
  const leading = start(sorted[0].box, axis) - contentStart;
  const trailing = contentEnd - end(sorted[sorted.length - 1].box, axis);

  const spread = gaps.length ? Math.max(...gaps) - Math.min(...gaps) : 0;
  const even = spread <= GAP_TOLERANCE;
  const base = !gaps.length ? 0 : even ? gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length : Math.min(...gaps);
  const extras = even ? gaps.map(() => 0) : gaps.map((gap) => gap - base);
  let primary: AutoLayoutIR['primary'] = 'MIN';
  const spacerBefore = new Map<number, number>();
  const padBefore = new Map<number, number>();

  const distributed = /^space-(between|around|evenly)$/.test(options.justify);
  if (sorted.length > 1 && distributed && even && near(leading, 0, 1) && near(trailing, 0, 1)) {
    primary = 'SPACE_BETWEEN';
  } else {
    const large = extras.map((extra, index) => ({ extra, index })).filter(({ extra }) => extra > GAP_TOLERANCE);
    const pushed = large.length === 1 && large[0].extra > 8 && near(leading, 0, 1) && near(trailing, 0, 1);
    if (pushed) {
      // One jump in an otherwise even row is an item pushed away (margin:
      // auto, or a spacer): a filling spacer keeps it pushed on resize.
      spacerBefore.set(large[0].index + 1, large[0].extra);
    } else if (large.length && depth < 3) {
      const grouped = groupByGap(ctx, axis, sorted, gaps, options, depth);
      if (grouped) return linear(ctx, axis, box, content, inset, grouped, options, depth + 1);
      for (const { extra, index } of large) padBefore.set(index + 1, extra);
    } else {
      for (const { extra, index } of large) padBefore.set(index + 1, extra);
    }
    if (!spacerBefore.size) {
      if (near(leading, trailing, 1) && leading > EPS) primary = 'CENTER';
      else if (near(trailing, 0) && leading > EPS) primary = 'MAX';
    }
  }
  const leadPadding = primary === 'MIN' && leading > EPS ? leading : 0;

  const crossStart = start(content, cross);
  const crossSize = size(content, cross);
  const alignItems = options.alignItems;
  let counter: AutoLayoutIR['counter'] = 'MIN';
  if (alignItems === 'center') counter = 'CENTER';
  else if (/^(flex-end|end|self-end)$/.test(alignItems)) counter = 'MAX';
  else if (/baseline/.test(alignItems) && options.allowBaseline && axis === 'x') counter = 'BASELINE';

  // If most items agree on an alignment the container's setting does not
  // explain, use theirs: centred rows are common and cost no wrappers then.
  if (counter === 'MIN' && sorted.length > 0) {
    const centred = sorted.filter((item) => near(start(item.box, cross) - crossStart, (crossSize - size(item.box, cross)) / 2, 1) && !near(size(item.box, cross), crossSize));
    if (centred.length && centred.length === sorted.filter((item) => !near(size(item.box, cross), crossSize)).length && !alignItems.startsWith('flex-start') && alignItems !== 'start') {
      counter = 'CENTER';
    }
  }

  const children: LayerIR[] = [];
  let mainTotal = 0;
  let crossMax = 0;
  let anyFillMain = false;
  let anyFillCross = false;
  let flowCount = 0;

  sorted.forEach((item, index) => {
    const offset = start(item.box, cross) - crossStart;
    const extent = size(item.box, cross);
    const selfAlign = item.style['align-self'] && item.style['align-self'] !== 'auto' ? item.style['align-self'] : alignItems;
    const stretches = selfAlign === 'stretch' || (selfAlign === 'normal' && options.stretchByDefault);

    const wordSized = hugsItsWords(item);
    let crossSizing: Sizing = hugsOn(item, cross) ? 'HUG' : 'FIXED';
    let fits: boolean;
    if (!wordSized && (stretches || item.flexibleText) && near(extent, crossSize) && near(offset, 0)) {
      crossSizing = 'FILL';
      fits = true;
    } else if (counter === 'BASELINE') {
      fits = true;
    } else if (counter === 'CENTER') {
      fits = near(offset, (crossSize - extent) / 2, 1);
    } else if (counter === 'MAX') {
      fits = near(offset, crossSize - extent, 1);
    } else {
      fits = near(offset, 0);
    }

    let mainSizing: Sizing = hugsOn(item, axis) ? 'HUG' : 'FIXED';
    if (px(item.style['flex-grow']) > 0 && !wordSized) mainSizing = 'FILL';

    const spacer = spacerBefore.get(index);
    if (spacer !== undefined) {
      const spacerLayer = transparentFrame('Spacer', axis === 'x' ? [0, 0, spacer, 0.01] : [0, 0, 0.01, spacer], []);
      setSizing(spacerLayer, axis, 'FILL', 'FIXED');
      children.push(spacerLayer);
      mainTotal += spacer;
      flowCount++;
      anyFillMain = true;
    }

    const lead = padBefore.get(index) ?? 0;
    let layer = item.layer;
    setSizing(layer, axis, mainSizing, crossSizing);
    let mainExtent = size(item.box, axis);
    let crossExtent = extent;

    if (!fits && offset < -EPS && offset >= -4) {
      // A nudge of a pixel or two is optical alignment, not structure.
      fits = true;
    }
    if (lead > 0 || !fits) {
      if (!fits && offset < -EPS) {
        // Pulled well outside the content box (negative margin): auto layout
        // cannot place it, so it floats where it was and a spacer holds its
        // place in the row.
        item.layer.absolute = true;
        item.layer.x = round2(item.box[0] - box[0]);
        item.layer.y = round2(item.box[1] - box[1]);
        item.layer.sizing = { h: 'FIXED', v: 'FIXED' };
        const holder = transparentFrame('Spacer', axis === 'x' ? [0, 0, size(item.box, axis), 0.01] : [0, 0, 0.01, size(item.box, axis)], []);
        setSizing(holder, axis, 'FIXED', 'FIXED');
        children.push(holder, item.layer);
        mainTotal += size(item.box, axis) + lead;
        flowCount++;
        return;
      }
      // Margins that spacing cannot express become a transparent wrapper's
      // padding, so the item stays exactly where it was.
      const crossLead = fits ? 0 : offset;
      const padding: [number, number, number, number] = axis === 'x' ? [crossLead, 0, 0, lead] : [lead, 0, 0, crossLead];
      const wrapperBox: Box = axis === 'x' ? [0, 0, lead + mainExtent, crossLead + extent] : [0, 0, crossLead + extent, lead + mainExtent];
      const wrapper = transparentFrame('Offset', wrapperBox, [layer]);
      wrapper.layout = { mode: axis === 'x' ? 'HORIZONTAL' : 'VERTICAL', gap: 0, padding, primary: 'MIN', counter: 'MIN' };
      setSizing(wrapper, axis, mainSizing === 'FILL' ? 'FILL' : 'HUG', crossSizing === 'FILL' ? 'FILL' : 'HUG');
      ctx.stats.wrappers++;
      layer = wrapper;
      mainExtent += lead;
      crossExtent += crossLead;
    }

    children.push(layer);
    mainTotal += mainExtent;
    crossMax = Math.max(crossMax, crossExtent);
    anyFillMain ||= mainSizing === 'FILL';
    anyFillCross ||= crossSizing === 'FILL';
    flowCount++;
  });

  const gap = primary === 'SPACE_BETWEEN' ? Math.max(0, base) : base;
  const padding: [number, number, number, number] = [inset.top, inset.right, inset.bottom, inset.left];
  if (leadPadding) padding[axis === 'x' ? 3 : 0] += leadPadding;

  const mainPadding = axis === 'x' ? padding[1] + padding[3] : padding[0] + padding[2];
  const crossPadding = axis === 'x' ? padding[0] + padding[2] : padding[1] + padding[3];
  const hugMainSize = mainPadding + mainTotal + gap * Math.max(0, flowCount - 1);
  const hugCrossSize = crossPadding + crossMax;

  return {
    layout: {
      mode: axis === 'x' ? 'HORIZONTAL' : 'VERTICAL',
      gap: round2(gap),
      padding: padding.map(round2) as [number, number, number, number],
      primary,
      counter,
    },
    children,
    hugMain: !anyFillMain && primary !== 'SPACE_BETWEEN' && near(hugMainSize, size(box, axis), 1),
    hugCross: !anyFillCross && near(hugCrossSize, size(box, cross), 1),
  };
}

/** Groups items into lines along `axis`, by overlap on the other axis. */
function clusterLines(items: Item[], axis: Axis): Item[][] {
  const cross = other(axis);
  const sorted = [...items].sort((a, b) => start(a.box, cross) - start(b.box, cross));
  const lines: { from: number; to: number; items: Item[] }[] = [];
  for (const item of sorted) {
    const from = start(item.box, cross);
    const to = end(item.box, cross);
    const line = lines.find((candidate) => Math.min(candidate.to, to) - Math.max(candidate.from, from) > Math.min(candidate.to - candidate.from, to - from) * 0.5);
    if (line) {
      line.from = Math.min(line.from, from);
      line.to = Math.max(line.to, to);
      line.items.push(item);
    } else {
      lines.push({ from, to, items: [item] });
    }
  }
  return lines.sort((a, b) => a.from - b.from).map((line) => line.items);
}

/** Horizontal wrap — only when Figma's own line breaking gives the page's lines. */
function wrapped(box: Box, content: Box, inset: Edges, lines: Item[][], justify: string): Plan | null {
  const rows = lines.map((line) => [...line].sort((a, b) => a.box[0] - b.box[0]));
  const gaps = rows.flatMap((row) => row.slice(1).map((item, index) => item.box[0] - (row[index].box[0] + row[index].box[2])));
  const gap = gaps.length ? Math.min(...gaps) : 0;
  if (gap < -EPS || gaps.some((value) => value - gap > 1)) return null;

  const tops = rows.map((row) => Math.min(...row.map((item) => item.box[1])));
  const bottoms = rows.map((row) => Math.max(...row.map((item) => item.box[1] + item.box[3])));
  const rowGaps = tops.slice(1).map((top, index) => top - bottoms[index]);
  const crossGap = rowGaps.length ? Math.min(...rowGaps) : 0;
  if (crossGap < -EPS || rowGaps.some((value) => value - crossGap > 1)) return null;

  // Figma breaks greedily, so every line but the last must be full enough
  // that its successor's first item would not have fitted.
  const width = content[2];
  for (let index = 0; index < rows.length; index++) {
    const used = rows[index].reduce((sum, item) => sum + item.box[2], 0) + gap * (rows[index].length - 1);
    if (used > width + 1) return null;
    const next = rows[index + 1]?.[0];
    if (next && used + gap + next.box[2] <= width - 1) return null;
  }

  const primary: AutoLayoutIR['primary'] = justify === 'center' ? 'CENTER' : /^(flex-end|end|right)$/.test(justify) ? 'MAX' : 'MIN';
  if (primary === 'MIN' && rows.some((row) => !near(row[0].box[0], content[0], 1))) return null;

  const children: LayerIR[] = [];
  for (const row of rows) {
    for (const item of row) {
      setSizing(item.layer, 'x', item.hugW || hugsItsWords(item) ? 'HUG' : 'FIXED', item.hugH ? 'HUG' : 'FIXED');
      children.push(item.layer);
    }
  }
  return {
    layout: {
      mode: 'HORIZONTAL',
      wrap: true,
      gap: round2(gap),
      crossGap: round2(crossGap),
      padding: [inset.top, inset.right, inset.bottom, inset.left].map(round2) as [number, number, number, number],
      primary,
      counter: 'MIN',
    },
    children,
    hugMain: false,
    hugCross: near(inset.top + inset.bottom + (bottoms[bottoms.length - 1] - tops[0]), box[3], 1),
  };
}

/** A synthetic container (grid row, anonymous line) around a group of items. */
function group(ctx: Context, name: string, box: Box, items: Item[], build: (groupBox: Box) => Plan | null): Item {
  const plan = build(box);
  const frame = transparentFrame(name, box, []);
  if (plan) {
    frame.layout = plan.layout;
    frame.children = plan.children;
    ctx.stats.autoLayout++;
  } else {
    ctx.stats.absoluteContainers++;
    frame.children = items.map((item) => place(item, box));
  }
  ctx.stats.frames++;
  return {
    layer: frame,
    box,
    style: {},
    inline: false,
    hugW: false,
    hugH: !!plan && plan.layout.mode === 'HORIZONTAL' ? plan.hugCross : false,
    positioned: false,
    zIndex: 0,
  };
}

function contains(layer: LayerIR, target: LayerIR): boolean {
  return layer.type === 'FRAME' && layer.children.some((child) => child === target || contains(child, target));
}

function place(item: Item, parent: Box): LayerIR {
  item.layer.x = round2(item.box[0] - parent[0]);
  item.layer.y = round2(item.box[1] - parent[1]);
  item.layer.sizing = undefined;
  return item.layer;
}

function flexPlan(ctx: Context, el: RawElement, content: Box, inset: Edges, flow: Item[]): Plan | null {
  const axis: Axis = (el.s['flex-direction'] ?? 'row').startsWith('row') ? 'x' : 'y';
  const justify = el.s['justify-content'] ?? 'normal';
  if ((el.s['flex-wrap'] ?? 'nowrap') !== 'nowrap') {
    const lines = clusterLines(flow, axis);
    if (lines.length > 1) return axis === 'x' ? wrapped(el.r, content, inset, lines, justify) : null;
  }
  return linear(ctx, axis, el.r, content, inset, flow, {
    justify,
    alignItems: el.s['align-items'] ?? 'normal',
    stretchByDefault: true,
    allowBaseline: true,
  });
}

function gridPlan(ctx: Context, el: RawElement, content: Box, inset: Edges, flow: Item[]): Plan | null {
  const rows = clusterLines(flow, 'x');
  const justify = el.s['justify-content'] ?? 'normal';
  const alignItems = el.s['align-items'] ?? 'normal';
  if (rows.length === 1) {
    return linear(ctx, 'x', el.r, content, inset, flow, { justify, alignItems, stretchByDefault: true, allowBaseline: false });
  }
  if (rows.every((row) => row.length === 1)) {
    return linear(ctx, 'y', el.r, content, inset, flow, {
      justify: el.s['align-content'] ?? 'normal',
      alignItems: el.s['justify-items'] ?? 'normal',
      stretchByDefault: true,
      allowBaseline: false,
    });
  }

  if (flow.every((item) => near(item.box[2], flow[0].box[2], 1))) {
    const plan = wrapped(el.r, content, inset, rows, justify);
    if (plan) return plan;
  }

  // Uneven tracks: a column of rows keeps every cell where it was.
  const rowBoxes = rows.map((row) => union(row.map((item) => item.box)));
  for (let index = 1; index < rowBoxes.length; index++) {
    if (rowBoxes[index][1] < rowBoxes[index - 1][1] + rowBoxes[index - 1][3] - EPS) return null;
  }
  const rowItems = rows.map((row, index) => {
    const rowBox: Box = [content[0], rowBoxes[index][1], content[2], rowBoxes[index][3]];
    return group(ctx, 'Row', rowBox, row, (groupBox) =>
      linear(ctx, 'x', groupBox, groupBox, NO_EDGES, row, { justify, alignItems, stretchByDefault: true, allowBaseline: false })
    );
  });
  for (const item of rowItems) item.flexibleText = true;
  return linear(ctx, 'y', el.r, content, inset, rowItems, { justify: 'normal', alignItems: 'stretch', stretchByDefault: true, allowBaseline: false });
}

function flowPlan(ctx: Context, el: RawElement, content: Box, inset: Edges, flow: Item[]): Plan | null {
  if (flow.some((item) => item.style.float && item.style.float !== 'none')) return null;
  const textAlign = el.s['text-align'];
  const inlineJustify = textAlign === 'center' ? 'center' : textAlign === 'right' || textAlign === 'end' ? 'flex-end' : 'normal';
  const inlineOptions: LinearOptions = { justify: inlineJustify, alignItems: 'baseline', stretchByDefault: false, allowBaseline: true };
  const blockOptions: LinearOptions = { justify: 'normal', alignItems: 'normal', stretchByDefault: true, allowBaseline: false };

  if (flow.every((item) => !item.inline)) return linear(ctx, 'y', el.r, content, inset, flow, blockOptions);
  if (flow.every((item) => item.inline)) {
    const lines = clusterLines(flow, 'x');
    return lines.length === 1 ? linear(ctx, 'x', el.r, content, inset, flow, inlineOptions) : wrapped(el.r, content, inset, lines, inlineJustify);
  }

  // Mixed: consecutive inline items form anonymous lines between the blocks.
  const groups: Item[] = [];
  let run: Item[] = [];
  const flush = () => {
    if (run.length === 1) groups.push({ ...run[0], inline: false });
    else if (run.length > 1) {
      const words = union(run.map((item) => item.box));
      const lineBox: Box = [content[0], words[1], content[2], words[3]];
      const members = run;
      groups.push(
        group(ctx, 'Line', lineBox, members, (groupBox) => {
          const lines = clusterLines(members, 'x');
          return lines.length === 1 ? linear(ctx, 'x', groupBox, groupBox, NO_EDGES, members, inlineOptions) : wrapped(groupBox, groupBox, NO_EDGES, lines, inlineJustify);
        })
      );
    }
    run = [];
  };
  for (const item of [...flow].sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0])) {
    if (item.inline) run.push(item);
    else {
      flush();
      groups.push(item);
    }
  }
  flush();
  return linear(ctx, 'y', el.r, content, inset, groups, blockOptions);
}

/* ------------------------------------------------------------------ *
 * Elements
 * ------------------------------------------------------------------ */

function itemOf(layer: LayerIR, el: RawElement, hugW: boolean, hugH: boolean, box: Box = el.r): Item {
  return {
    layer,
    box,
    style: el.s,
    inline: /^inline/.test(el.s.display ?? ''),
    hugW,
    hugH,
    positioned: isPositioned(el.s),
    zIndex: parseInt(el.s['z-index'] ?? '0', 10) || 0,
  };
}

function withSvgSize(svg: string, width: number, height: number): string {
  return svg.replace(/<svg\b([^>]*)>/i, (_, attrs: string) => {
    let next = attrs.replace(/\s(width|height)="[^"]*"/g, '');
    if (!/viewBox=/i.test(next)) next += ` viewBox="0 0 ${width} ${height}"`;
    if (!/xmlns=/.test(next)) next += ' xmlns="http://www.w3.org/2000/svg"';
    return `<svg${next} width="${width}" height="${height}">`;
  });
}

function imageLayer(ctx: Context, el: RawElement, z: number): LayerIR | null {
  const asset = el.img!.asset;
  const data = ctx.assets.get(asset);
  const [, , width, height] = el.r;
  const name = el.a?.alt || el.a?.label || (el.raster ? `${nameFor(el)} (raster)` : 'Image');
  if (!data || data.kind === 'missing') {
    ctx.warnings.push(`${name}: image unavailable (${data?.kind === 'missing' ? data.reason : 'not fetched'}); an empty frame stands in.`);
    return null;
  }
  if (data.kind === 'svg' && !el.raster) {
    ctx.stats.vectors++;
    const vector: VectorIR = { type: 'SVG', name: el.a?.alt || 'Vector', x: 0, y: 0, width, height, svg: withSvgSize(data.text, width, height) };
    return vector;
  }
  const fit = el.s['object-fit'];
  const scaleMode: ScaleMode = el.raster ? 'FILL' : fit === 'contain' || fit === 'scale-down' ? 'FIT' : 'FILL';
  const layer: ImageIR = { type: 'IMAGE', name, x: 0, y: 0, width, height, asset, scaleMode };
  // The radius belongs to the box, not to the picture in it: a rasterized
  // element is a square bitmap that still has to be clipped to its corners.
  const radius = radiusOf(el.s, el.r, z);
  if (radius !== undefined) layer.radius = radius;
  if (el.raster) {
    ctx.stats.rasters++;
    ctx.warnings.push(`${nameFor(el)}: rasterized (${el.raster}).`);
    return layer;
  }
  const stroke = strokeOf(el.s, z);
  if (stroke) layer.stroke = stroke;
  const effects = effectsOf(el.s, z);
  if (effects) layer.effects = effects;
  const background = solid(el.s['background-color']);
  if (background) layer.fills = [background];
  ctx.stats.images++;
  return layer;
}

function convertNode(ctx: Context, node: RawNode, z: number, content: Box): Item | null {
  if (node.k === 'tx') return anonymousText(ctx, node, z, content);
  return convertElement(ctx, node, z);
}

/**
 * Text without an element of its own. As an anonymous block it spans the
 * container, so text-align means something; inline, it is just its words.
 */
function anonymousText(ctx: Context, node: RawText, z: number, content: Box): Item | null {
  const words = union(node.para.lines);
  const available: Box = node.block ? [content[0], words[1], content[2], words[3]] : words;
  const made = makeText(ctx, node.para, available, z, node.block ? 'auto' : 'content');
  if (!made) return null;
  if (node.block && !made.hug) {
    return { layer: made.layer, box: available, style: {}, inline: false, hugW: false, hugH: true, positioned: false, zIndex: 0, flexibleText: true };
  }
  return { layer: made.layer, box: made.box, style: {}, inline: !node.block, hugW: true, hugH: true, positioned: false, zIndex: 0 };
}

function frameFor(ctx: Context, el: RawElement, z: number, name: string): FrameIR {
  const [, , width, height] = el.r;
  const frame: FrameIR = { type: 'FRAME', name, x: 0, y: 0, width, height, children: [], origin: `${el.tag}#${el.i}` };
  const background = backgroundFills(ctx, el.s, el.r, name, z);
  if (background.fills.length) frame.fills = background.fills;
  ctx.backgrounds.set(frame, background.vectors);
  const stroke = strokeOf(el.s, z);
  if (stroke) frame.stroke = stroke;
  const radius = radiusOf(el.s, el.r, z);
  if (radius !== undefined) frame.radius = radius;
  const effects = effectsOf(el.s, z);
  if (effects) frame.effects = effects;
  const opacity = el.s.opacity !== undefined ? parseFloat(el.s.opacity) : 1;
  if (opacity < 1) frame.opacity = round2(opacity);
  const blend = BLEND_MODES[el.s['mix-blend-mode'] ?? ''];
  if (blend) frame.blendMode = blend;
  if ((el.s['overflow-x'] ?? 'visible') !== 'visible' || (el.s['overflow-y'] ?? 'visible') !== 'visible' || el.s['clip-path']?.startsWith('inset')) {
    frame.clip = true;
  }
  // Limits matter to a layer that fills: Figma honours them like flexbox does.
  const maxWidth = el.s['max-width'];
  if (maxWidth?.endsWith('px')) frame.maxWidth = px(maxWidth) * z;
  const minWidth = el.s['min-width'];
  if (minWidth?.endsWith('px') && px(minWidth) > 0) frame.minWidth = px(minWidth) * z;
  ctx.stats.frames++;
  return frame;
}

/**
 * Adds SVG backgrounds as vector children under whatever the element holds, so
 * a background icon stays a vector. Returns the layer to use in place of the
 * frame when the element is nothing but that icon.
 */
function addBackgroundVectors(ctx: Context, frame: FrameIR, vectors: { svg: string; rect: Box }[], name: string): LayerIR {
  if (!vectors.length) return frame;
  const [only] = vectors;
  const covers =
    vectors.length === 1 &&
    !frame.children.length &&
    !frame.fills?.length &&
    !frame.stroke &&
    frame.radius === undefined &&
    !frame.effects?.length &&
    near(only.rect[0], 0, 1) &&
    near(only.rect[1], 0, 1) &&
    near(only.rect[2], frame.width, 1) &&
    near(only.rect[3], frame.height, 1);
  if (covers) {
    ctx.stats.frames--;
    ctx.stats.vectors++;
    return {
      type: 'SVG',
      name,
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height,
      svg: withSvgSize(only.svg, frame.width, frame.height),
      sizing: frame.sizing,
    };
  }
  const placed = frame.layout ? { absolute: true as const, sizing: { h: 'FIXED' as const, v: 'FIXED' as const } } : {};
  const children = vectors.map(({ svg, rect }): VectorIR => {
    ctx.stats.vectors++;
    const width = Math.max(rect[2], 0.01);
    const height = Math.max(rect[3], 0.01);
    return {
      type: 'SVG',
      name: 'Background',
      x: rect[0],
      y: rect[1],
      width,
      height,
      svg: withSvgSize(svg, width, height),
    };
  });
  // A rounded box clips its background in CSS; a vector layer in Figma keeps
  // its square corners over the radius unless something clips it. One frame
  // does that, and leaves the element's real children unclipped.
  if (frame.radius !== undefined) {
    ctx.stats.frames++;
    const clipped: FrameIR = {
      type: 'FRAME',
      name: 'Background',
      x: 0,
      y: 0,
      width: frame.width,
      height: frame.height,
      radius: frame.radius,
      clip: true,
      children,
      ...placed,
    };
    frame.children = [clipped, ...frame.children];
    return frame;
  }
  frame.children = [...children.map((child) => ({ ...child, ...placed })), ...frame.children];
  return frame;
}

/** An element whose content is text: a bare text layer, or a frame holding one. */
function textElement(ctx: Context, el: RawElement, z: number, frame: FrameIR, hasBackgrounds: boolean): Item | null {
  const inset = insets(el.s, z);
  const content = contentBox(el.r, inset);
  const [, , width, height] = el.r;

  let made: MadeText | null;
  if (el.field) {
    const fieldStyle = ctx.styles[el.field.style] ?? {};
    const lineHeight = fieldStyle['line-height'] && fieldStyle['line-height'] !== 'normal' ? px(fieldStyle['line-height']) * z : px(fieldStyle['font-size'], 16) * z * 1.25;
    const top = el.tag === 'textarea' ? content[1] : content[1] + Math.max(0, (content[3] - lineHeight) / 2);
    made = makeText(ctx, { runs: [{ text: el.field.text, style: el.field.style, ws: 'pre' }], base: el.field.style, lines: [[content[0], top, content[2], lineHeight]] }, content, z, 'fixed');
  } else {
    // In a flex container the text is an anonymous item: sized to its words and
    // placed by justify/align, not by text-align — unless a column stretches it.
    const display = el.s.display ?? 'block';
    const column = (el.s['flex-direction'] ?? 'row').startsWith('column');
    const alignItems = el.s['align-items'] ?? 'normal';
    const contentSized = /flex/.test(display) && (!column || !/^(normal|stretch)$/.test(alignItems));
    made = makeText(ctx, { runs: el.para!.runs, base: el.para!.base, lines: el.para!.lines }, content, z, contentSized ? 'content' : 'auto');
  }
  if (!made) return null;
  made.layer.origin = `${el.tag}#${el.i}`;

  const bare =
    !hasVisuals(frame) &&
    !frame.clip &&
    !hasBackgrounds &&
    edgeSum(inset) < 0.5 &&
    !el.field &&
    near(made.box[1], el.r[1], 1.5) &&
    near(made.box[3], height, 1.5);
  if (bare) {
    ctx.stats.frames--;
    const layer = made.layer;
    if (made.hug && px(el.s['flex-grow']) <= 0) {
      return itemOf(layer, el, true, true, [made.box[0], el.r[1], made.box[2], height]);
    }
    // Keep the element's width: alignment inside it still means something.
    layer.resize = 'HEIGHT';
    layer.width = width;
    return { ...itemOf(layer, el, false, true), flexibleText: true };
  }

  // A frame around the text: its padding and alignment place the words.
  const leading = made.box[0] - content[0];
  const trailing = content[0] + content[2] - (made.box[0] + made.box[2]);
  const above = made.box[1] - content[1];
  const below = content[1] + content[3] - (made.box[1] + made.box[3]);
  let primary: AutoLayoutIR['primary'] = 'MIN';
  if (made.hug && near(leading, trailing, 1.5) && leading > 1) primary = 'CENTER';
  else if (made.hug && near(trailing, 0, 1) && leading > 1) primary = 'MAX';
  let counter: AutoLayoutIR['counter'] = 'MIN';
  if (near(above, below, 1.5) && above > 0.5) counter = 'CENTER';
  else if (near(below, 0, 1) && above > 1) counter = 'MAX';

  const padding: [number, number, number, number] = [inset.top, inset.right, inset.bottom, inset.left];
  if (primary === 'MIN' && made.hug && leading > 0.5) padding[3] += leading;
  if (counter === 'MIN' && above > 0.5) padding[0] += above;

  const text = made.layer;
  text.sizing = made.hug ? { h: 'HUG', v: 'HUG' } : { h: 'FILL', v: 'HUG' };
  frame.layout = { mode: 'HORIZONTAL', gap: 0, padding: padding.map(round2) as [number, number, number, number], primary, counter };
  frame.children = [text];
  ctx.stats.autoLayout++;
  const hugW = made.hug && near(padding[1] + padding[3] + made.box[2], width, 1.5);
  const hugH = near(padding[0] + padding[2] + made.box[3], height, 1.5);
  return itemOf(frame, el, hugW, hugH);
}

function convertElement(ctx: Context, el: RawElement, parentZ: number): Item | null {
  const z = el.z ?? parentZ;
  const [, , width, height] = el.r;
  const name = nameFor(el);

  if (el.hidden) {
    // Invisible and out of flow: nothing to see and no space to keep.
    if ((width < 0.5 && height < 0.5) || isPositioned(el.s)) return null;
    return itemOf(transparentFrame(`${name} (hidden)`, el.r, []), el, false, false);
  }
  if (el.svg) {
    ctx.stats.vectors++;
    const vector: VectorIR = { type: 'SVG', name: el.a?.ariaLabel ?? (width <= 48 && height <= 48 ? 'Icon' : 'Vector'), x: 0, y: 0, width, height, svg: el.svg };
    return itemOf(vector, el, false, false);
  }
  if (el.img) {
    const layer = imageLayer(ctx, el, z);
    return itemOf(layer ?? transparentFrame(name, el.r, []), el, false, false);
  }

  const frame = frameFor(ctx, el, z, name);
  const backgrounds = ctx.backgrounds.get(frame) ?? [];
  if (el.para || el.field) {
    const item = textElement(ctx, el, z, frame, backgrounds.length > 0);
    if (!item) return itemOf(frame, el, false, false);
    if (item.layer === frame) addBackgroundVectors(ctx, frame, backgrounds, name);
    return item;
  }

  const inset = insets(el.s, z);
  const content = contentBox(el.r, inset);
  const items: Item[] = [];
  for (const child of el.c ?? []) {
    const item = convertNode(ctx, child, z, content);
    if (item) items.push(item);
  }
  if (!items.length) {
    const layer = addBackgroundVectors(ctx, frame, backgrounds, name);
    if (layer !== frame) return itemOf(layer, el, false, false);
    if (!hasVisuals(frame) && !backgrounds.length && name === 'Frame') frame.name = 'Spacer';
    return itemOf(frame, el, false, false);
  }

  const flow = items.filter((item) => !item.positioned);
  const positioned = items.filter((item) => item.positioned);
  const display = el.s.display ?? 'block';

  let plan: Plan | null = null;
  if (flow.length) {
    if (/flex/.test(display)) plan = flexPlan(ctx, el, content, inset, flow);
    else if (/grid/.test(display)) plan = gridPlan(ctx, el, content, inset, flow);
    else plan = flowPlan(ctx, el, content, inset, flow);
  }

  let hugW = false;
  let hugH = false;
  if (plan) {
    frame.layout = plan.layout;
    frame.children = plan.children;
    const horizontal = plan.layout.mode === 'HORIZONTAL';
    hugW = horizontal ? plan.hugMain : plan.hugCross;
    hugH = horizontal ? plan.hugCross : plan.hugMain;
    ctx.stats.autoLayout++;
    // Name what the element turned out to be, rather than leaving "Frame".
    if (frame.name === 'Frame') {
      const card = !!frame.fills?.length && frame.radius !== undefined && edgeSum(inset) > 0;
      frame.name = card ? 'Card' : horizontal ? 'Row' : 'Stack';
    }
  } else if (flow.length) {
    ctx.stats.absoluteContainers++;
    frame.children = flow.map((item) => place(item, el.r));
  }

  // Positioned children keep their offsets whether or not the frame has auto
  // layout. Their place in the layer list follows CSS paint order: negative
  // z-index under everything, then the flow, then positioned boxes in
  // document order — which puts an absolute backdrop *under* relative
  // siblings that come after it — then positive z-index on top.
  const layerOf = (item: Item) => frame.children.find((child) => child === item.layer || contains(child, item.layer));
  for (const item of [...positioned].sort((a, b) => a.zIndex - b.zIndex)) {
    const layer = place(item, el.r);
    if (frame.layout) {
      layer.absolute = true;
      layer.sizing = { h: 'FIXED', v: 'FIXED' };
    }
    const s = item.style;
    layer.constraints = {
      h: s.right !== undefined && s.left === undefined ? 'MAX' : s.left !== undefined && s.right !== undefined ? 'STRETCH' : 'MIN',
      v: s.bottom !== undefined && s.top === undefined ? 'MAX' : s.top !== undefined && s.bottom !== undefined ? 'STRETCH' : 'MIN',
    };
    if (item.zIndex < 0) {
      frame.children.unshift(layer);
      continue;
    }
    const later = item.zIndex === 0 ? items.slice(items.indexOf(item) + 1).find((other) => paintsPositioned(other) && other.zIndex === 0) : undefined;
    const anchor = later ? layerOf(later) : undefined;
    const at = anchor ? frame.children.indexOf(anchor) : -1;
    if (at >= 0) frame.children.splice(at, 0, layer);
    else frame.children.push(layer);
  }

  addBackgroundVectors(ctx, frame, backgrounds, name);

  // A wrapper that adds nothing is noise in the layers panel.
  if (!hasVisuals(frame) && !frame.clip && !positioned.length && flow.length === 1 && frame.children.length === 1 && edgeSum(inset) < 0.5) {
    const only = flow[0];
    if (near(only.box[0], el.r[0]) && near(only.box[1], el.r[1]) && near(only.box[2], width) && near(only.box[3], height)) {
      ctx.stats.frames--;
      if (plan) ctx.stats.autoLayout--;
      if (name !== 'Frame' && only.layer.type === 'FRAME' && only.layer.name === 'Frame') only.layer.name = name;
      // The wrapper's flex behaviour passes to the child, and so do its limits.
      only.layer.maxWidth ??= frame.maxWidth;
      only.layer.minWidth ??= frame.minWidth;
      only.layer.absolute = undefined;
      only.layer.constraints = undefined;
      return { ...only, style: el.s, inline: /^inline/.test(display), positioned: isPositioned(el.s), zIndex: parseInt(el.s['z-index'] ?? '0', 10) || 0 };
    }
  }

  return itemOf(frame, el, hugW, hugH);
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

function finalize(layer: LayerIR): number {
  layer.x = round2(layer.x);
  layer.y = round2(layer.y);
  layer.width = round2(Math.max(layer.width, 0.01));
  layer.height = round2(Math.max(layer.height, 0.01));
  let count = 1;
  if (layer.type === 'FRAME') for (const child of layer.children) count += finalize(child);
  return count;
}

export function convertCollection(collection: RawCollection, assets: Map<string, AssetData>, options: { name: string }): ConvertResult & { nodes: number } {
  const ctx: Context = {
    styles: collection.textStyles,
    assets,
    assetSources: new Map(collection.assets.filter((asset) => asset.kind !== 'raster').map((asset) => [asset.src, asset.id])),
    warnings: [],
    stats: { frames: 0, texts: 0, vectors: 0, images: 0, rasters: 0, autoLayout: 0, absoluteContainers: 0, wrappers: 0, groups: 0 },
    backgrounds: new Map(),
  };

  const item = convertElement(ctx, collection.root, 1);
  let root: FrameIR;
  if (!item) {
    root = transparentFrame(options.name, collection.root.r, []);
  } else if (item.layer.type === 'FRAME') {
    root = item.layer;
  } else {
    root = transparentFrame(options.name, item.box, [item.layer]);
    root.layout = { mode: 'VERTICAL', gap: 0, padding: [0, 0, 0, 0], primary: 'MIN', counter: 'MIN' };
    item.layer.sizing = { h: 'FILL', v: 'HUG' };
    ctx.stats.frames++;
  }
  root.name = options.name;
  root.x = 0;
  root.y = 0;
  root.absolute = undefined;
  root.constraints = undefined;
  root.maxWidth = undefined;
  // A screen keeps its width; its height follows the content when it can.
  root.sizing = { h: 'FIXED', v: root.layout && item?.hugH ? 'HUG' : 'FIXED' };
  if (!root.fills?.length) {
    // A see-through artboard reads as broken on the canvas.
    root.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }];
  }

  const nodes = finalize(root);
  return { root, warnings: summarize(ctx.warnings), stats: ctx.stats, nodes };
}

function summarize(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([value, count]) => (count > 1 ? `${value} (×${count})` : value)).slice(0, 40);
}
