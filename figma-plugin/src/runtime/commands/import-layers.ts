/**
 * Creates imported HTML screens in the document.
 *
 * The server has already decided every layer, size and auto layout setting;
 * this file only turns that description into nodes. Four commands, run in
 * order by one import:
 *
 *   import_images   bytes → Figma image hashes, once per unique image
 *   import_canvas   the page, its sections, and caption cards
 *   import_screen   one screen's layer tree
 *   import_arrange  lays sections, captions and screens out by their real size
 *
 * Every top-level node an import creates is journalled and tagged with the
 * operation id, so a failed or unwanted import rolls back like any other write,
 * and `import_cleanup` can still find its nodes if a response was lost.
 */

import type {
  CanvasIR,
  EffectIR,
  FrameIR,
  ImageIR,
  LayerIR,
  PaintIR,
  ScreenIR,
  StrokeIR,
  TextIR,
  TextStyleIR,
  VectorIR,
} from '../../../../shared/html-import';
import { DATA_KEYS, errorMessage, Journal, JournalEntry } from '../journal';
import { safe } from '../serialize';

type Container = BaseNode & ChildrenMixin;
type Sized = SceneNode & LayoutMixin;

const IMPORT_KEY = 'ff.import';

/* ------------------------------------------------------------------ *
 * Images
 * ------------------------------------------------------------------ */

export interface ImportImagesParams {
  images: { id: string; data: string }[];
}

export function importImages(params: ImportImagesParams): { hashes: Record<string, string>; failed: { id: string; error: string }[] } {
  const hashes: Record<string, string> = {};
  const failed: { id: string; error: string }[] = [];
  for (const image of params.images ?? []) {
    try {
      hashes[image.id] = figma.createImage(figma.base64Decode(image.data)).hash;
    } catch (error) {
      failed.push({ id: image.id, error: errorMessage(error) });
    }
  }
  return { hashes, failed };
}

/* ------------------------------------------------------------------ *
 * Fonts
 * ------------------------------------------------------------------ */

let fontIndex: Map<string, FontName[]> | null = null;
const loadedFonts = new Map<string, Promise<void>>();

async function fonts(): Promise<Map<string, FontName[]>> {
  if (!fontIndex) {
    fontIndex = new Map();
    for (const font of await figma.listAvailableFontsAsync()) {
      const key = font.fontName.family.toLowerCase();
      const list = fontIndex.get(key) ?? [];
      list.push(font.fontName);
      fontIndex.set(key, list);
    }
  }
  return fontIndex;
}

/** What a CSS generic family means on the machine Figma runs on. */
const GENERIC: Record<string, string[]> = {
  'sans-serif': ['Inter', 'Helvetica Neue', 'Arial'],
  'system-ui': ['SF Pro Text', 'SF Pro', 'Segoe UI', 'Roboto', 'Inter'],
  '-apple-system': ['SF Pro Text', 'SF Pro', 'Inter'],
  blinkmacsystemfont: ['SF Pro Text', 'SF Pro', 'Inter'],
  'ui-sans-serif': ['SF Pro Text', 'Inter'],
  serif: ['Georgia', 'Times New Roman', 'Noto Serif'],
  'ui-serif': ['New York', 'Georgia', 'Times New Roman'],
  monospace: ['SF Mono', 'Menlo', 'Roboto Mono', 'Courier New'],
  'ui-monospace': ['SF Mono', 'Menlo', 'Roboto Mono'],
  cursive: ['Comic Sans MS'],
};

const WEIGHT_WORDS: [RegExp, number][] = [
  [/(thin|hairline)/, 100],
  [/(extra|ultra)[\s-]?light/, 200],
  [/light/, 300],
  [/(semi|demi)[\s-]?bold/, 600],
  [/(extra|ultra)[\s-]?bold/, 800],
  [/(black|heavy)/, 900],
  [/bold/, 700],
  [/medium/, 500],
];

function styleWeight(style: string): number {
  const lower = style.toLowerCase();
  for (const [pattern, weight] of WEIGHT_WORDS) if (pattern.test(lower)) return weight;
  return 400;
}

function pickStyle(styles: FontName[], weight: number, italic: boolean): FontName {
  let best = styles[0];
  let bestScore = Infinity;
  for (const font of styles) {
    const style = font.style.toLowerCase();
    const isItalic = /italic|oblique/.test(style);
    let score = Math.abs(styleWeight(font.style) - weight);
    if (isItalic !== italic) score += 1000;
    if (/condensed|narrow|compressed|expanded|wide|display|caption|small/.test(style)) score += 60;
    if (score < bestScore) {
      best = font;
      bestScore = score;
    }
  }
  return best;
}

interface FontChoice {
  font: FontName;
  /** The family asked for, when Figma had nothing like it. */
  missing?: string;
}

let familyUsage: { operationId: string; counts: Map<string, number> } | null = null;

/**
 * How often each family is already used in this file. An import should look
 * like the rest of the document: when several installed families can serve a
 * weight, the one the designers already work in wins.
 */
async function familiesInUse(operationId: string): Promise<Map<string, number>> {
  if (familyUsage && familyUsage.operationId === operationId) return familyUsage.counts;
  const counts = new Map<string, number>();
  const pages = [figma.currentPage, ...figma.root.children.filter((page) => page.id !== figma.currentPage.id)];
  let sampled = 0;
  for (const page of pages.slice(0, 4)) {
    if (sampled >= 600) break;
    try {
      await page.loadAsync();
      for (const node of page.findAllWithCriteria({ types: ['TEXT'] }).slice(0, 300)) {
        const font = safe(() => (node as TextNode).fontName) as FontName | undefined;
        if (!font || typeof font === 'string' || !font.family) continue;
        const key = font.family.toLowerCase();
        counts.set(key, (counts.get(key) ?? 0) + 1);
        sampled++;
      }
    } catch {
      /* a page that will not load tells us nothing; move on */
    }
  }
  familyUsage = { operationId, counts };
  return counts;
}

/** "Golos Text VF" and "Golos Text" are the same typeface as "Golos". */
function familyKey(family: string): string {
  return family.toLowerCase().replace(/[\s_-]+/g, '').replace(/(vf|variable)$/, '');
}

/**
 * Picks the family and style closest to what the CSS asked for.
 *
 * Exact name is not enough: a machine can have "Golos Text" with two weights
 * installed and "Golos" with five. Matching the name alone then gives every
 * text the same weight, so families that share a name are compared by how
 * well they cover the weight that was asked for.
 */
async function chooseFont(style: TextStyleIR, usage: Map<string, number>): Promise<FontChoice> {
  const index = await fonts();
  const wanted = style.family.length ? style.family : ['Inter'];
  for (const family of wanted) {
    for (const candidate of GENERIC[family.toLowerCase()] ?? [family]) {
      const target = familyKey(candidate);
      let best: { font: FontName; score: number } | null = null;
      for (const [name, styles] of index) {
        const key = familyKey(name);
        const exact = key === target;
        if (!exact && !key.startsWith(target) && !target.startsWith(key)) continue;
        const font = pickStyle(styles, style.weight, !!style.italic);
        const score =
          Math.abs(styleWeight(font.style) - style.weight) * 10 +
          (exact ? 0 : 40) +
          (styles.length < 3 ? 90 : 0) +
          (/vf|variable/i.test(name) ? 25 : 0) -
          Math.min(usage.get(name) ?? 0, 50);
        if (!best || score < best.score) best = { font, score };
      }
      if (best) return { font: best.font };
    }
  }
  const inter = index.get('inter') ?? [{ family: 'Inter', style: 'Regular' }];
  return { font: pickStyle(inter, style.weight, !!style.italic), missing: wanted[0] };
}

async function loadFont(font: FontName): Promise<void> {
  const key = `${font.family}::${font.style}`;
  let pending = loadedFonts.get(key);
  if (!pending) {
    pending = figma.loadFontAsync(font);
    loadedFonts.set(key, pending);
  }
  await pending;
}

/* ------------------------------------------------------------------ *
 * Colour tokens
 * ------------------------------------------------------------------ */

type Usage = 'FRAME_FILL' | 'SHAPE_FILL' | 'TEXT_FILL' | 'STROKE_COLOR';

interface TokenIndex {
  byColor: Map<string, Variable[]>;
}

let tokenIndex: { operationId: string; index: TokenIndex } | null = null;

const channel = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 255);
const colorKey = (color: { r: number; g: number; b: number }, alpha: number) =>
  `${channel(color.r)},${channel(color.g)},${channel(color.b)},${Math.round(alpha * 100)}`;

const collections = new Map<string, VariableCollection | null>();

async function collectionOf(variable: Variable): Promise<VariableCollection | null> {
  if (!collections.has(variable.variableCollectionId)) {
    collections.set(variable.variableCollectionId, await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId));
  }
  return collections.get(variable.variableCollectionId) ?? null;
}

async function resolveColor(variable: Variable, depth = 0): Promise<RGBA | null> {
  if (depth > 6) return null;
  const collection = await collectionOf(variable);
  if (!collection) return null;
  const value = variable.valuesByMode[collection.defaultModeId];
  if (value && typeof value === 'object' && (value as VariableAlias).type === 'VARIABLE_ALIAS') {
    const target = await figma.variables.getVariableByIdAsync((value as VariableAlias).id);
    return target ? resolveColor(target, depth + 1) : null;
  }
  if (value && typeof value === 'object' && 'r' in (value as RGBA)) {
    const color = value as RGBA;
    return { r: color.r, g: color.g, b: color.b, a: color.a ?? 1 };
  }
  return null;
}

/**
 * Local colour variables by resolved value. Semantic tokens usually alias a
 * primitive with the same colour; those win, because a designer re-theming
 * the file changes the semantic layer.
 */
async function tokens(operationId: string): Promise<TokenIndex> {
  if (tokenIndex && tokenIndex.operationId === operationId) return tokenIndex.index;
  collections.clear();
  const byColor = new Map<string, Variable[]>();
  let variables: Variable[] = [];
  try {
    variables = await figma.variables.getLocalVariablesAsync('COLOR');
  } catch {
    variables = [];
  }
  for (const variable of variables) {
    const resolved = await resolveColor(variable);
    if (!resolved) continue;
    const key = colorKey(resolved, resolved.a);
    const list = byColor.get(key) ?? [];
    list.push(variable);
    byColor.set(key, list);
  }
  const rank = (variable: Variable) => {
    const collectionValue = Object.values(variable.valuesByMode)[0];
    const alias = !!collectionValue && typeof collectionValue === 'object' && (collectionValue as VariableAlias).type === 'VARIABLE_ALIAS';
    return (alias ? 0 : 10) + variable.name.split('/').length;
  };
  for (const list of byColor.values()) list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const index = { byColor };
  tokenIndex = { operationId, index };
  return index;
}

function scoped(variable: Variable, usage: Usage): boolean {
  const scopes = variable.scopes ?? [];
  if (!scopes.length || scopes.includes('ALL_SCOPES')) return true;
  if (usage === 'FRAME_FILL' || usage === 'SHAPE_FILL') return scopes.includes(usage) || scopes.includes('ALL_FILLS');
  if (usage === 'TEXT_FILL') return scopes.includes('TEXT_FILL') || scopes.includes('ALL_FILLS');
  return scopes.includes('STROKE_COLOR');
}

/* ------------------------------------------------------------------ *
 * Paints and effects
 * ------------------------------------------------------------------ */

interface BuildContext {
  operationId: string;
  fontUsage: Map<string, number>;
  images: Record<string, string>;
  bindTokens: boolean;
  tokens: TokenIndex | null;
  warnings: string[];
  missingFonts: Set<string>;
  nodes: number;
  bound: number;
}

function paintOf(paint: PaintIR, ctx: BuildContext): Paint | null {
  if (paint.type === 'SOLID') {
    return { type: 'SOLID', color: { r: paint.color.r, g: paint.color.g, b: paint.color.b }, opacity: paint.color.a };
  }
  if (paint.type === 'IMAGE') {
    const hash = ctx.images[paint.asset];
    if (!hash) return null;
    return { type: 'IMAGE', imageHash: hash, scaleMode: paint.scaleMode, opacity: paint.opacity ?? 1 };
  }
  return {
    type: paint.type,
    gradientTransform: paint.transform as Transform,
    gradientStops: paint.stops.map((stop) => ({ position: stop.position, color: stop.color })),
  };
}

function paintsOf(paints: PaintIR[] | undefined, ctx: BuildContext, usage: Usage): Paint[] {
  const out: Paint[] = [];
  for (const source of paints ?? []) {
    let paint = paintOf(source, ctx);
    if (!paint) continue;
    if (ctx.tokens && paint.type === 'SOLID') {
      const solid = paint as SolidPaint;
      const alpha = solid.opacity ?? 1;
      // An exact match first; then the opaque colour, keeping the paint's own
      // opacity — `teal at 40%` is a legitimate use of the `teal` token.
      const exact = ctx.tokens.byColor.get(colorKey(solid.color, alpha))?.find((variable) => scoped(variable, usage));
      const opaque = alpha < 1 ? ctx.tokens.byColor.get(colorKey(solid.color, 1))?.find((variable) => scoped(variable, usage)) : undefined;
      const variable = exact ?? opaque;
      if (variable) {
        try {
          paint = figma.variables.setBoundVariableForPaint(solid, 'color', variable);
          if (!exact) paint = { ...(paint as SolidPaint), opacity: alpha };
          else paint = { ...(paint as SolidPaint), opacity: 1 };
          ctx.bound++;
        } catch {
          /* an unbindable variable leaves the literal colour in place */
        }
      }
    }
    out.push(paint);
  }
  return out;
}

function effectsOf(effects: EffectIR[] | undefined): Effect[] {
  return (effects ?? []).map((effect): Effect => {
    if ('radius' in effect) {
      return { type: effect.type, radius: effect.radius, visible: true } as Effect;
    }
    return {
      type: effect.type,
      color: effect.color,
      offset: { x: effect.x, y: effect.y },
      radius: effect.blur,
      spread: effect.spread,
      visible: true,
      blendMode: 'NORMAL',
      ...(effect.type === 'DROP_SHADOW' ? { showShadowBehindNode: false } : {}),
    } as Effect;
  });
}

function applyStroke(node: GeometryMixin & IndividualStrokesMixin, stroke: StrokeIR | undefined, ctx: BuildContext): void {
  if (!stroke) return;
  node.strokes = paintsOf(stroke.paints, ctx, 'STROKE_COLOR');
  node.strokeAlign = 'INSIDE';
  if (Array.isArray(stroke.weight)) {
    const [top, right, bottom, left] = stroke.weight;
    node.strokeTopWeight = top;
    node.strokeRightWeight = right;
    node.strokeBottomWeight = bottom;
    node.strokeLeftWeight = left;
  } else {
    node.strokeWeight = stroke.weight;
  }
  if (stroke.dash) node.dashPattern = stroke.dash;
}

function applyRadius(node: CornerMixin & RectangleCornerMixin, radius: FrameIR['radius']): void {
  if (radius === undefined) return;
  if (Array.isArray(radius)) {
    [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius] = radius;
  } else {
    node.cornerRadius = radius;
  }
}

/* ------------------------------------------------------------------ *
 * Layers
 * ------------------------------------------------------------------ */

const isAutoLayout = (node: BaseNode | null): boolean =>
  !!node && 'layoutMode' in node && (node as FrameNode).layoutMode !== 'NONE';

/** Placement and sizing, once the node sits in its parent. */
function place(node: Sized, layer: LayerIR, parent: Container, ctx: BuildContext): void {
  const inAutoLayout = isAutoLayout(parent);
  if (inAutoLayout && layer.absolute) {
    (node as SceneNode & AutoLayoutChildrenMixin).layoutPositioning = 'ABSOLUTE';
  }
  if (!inAutoLayout || layer.absolute) {
    node.x = layer.x;
    node.y = layer.y;
  }
  if (layer.constraints && 'constraints' in node) {
    try {
      (node as ConstraintMixin).constraints = { horizontal: layer.constraints.h, vertical: layer.constraints.v };
    } catch {
      /* constraints are a nicety */
    }
  }

  // Sizing modes only exist for auto layout frames and their children; a
  // text layer elsewhere is already sized by its auto-resize mode.
  const selfLayout = isAutoLayout(node);
  if (!inAutoLayout && !selfLayout) return;
  const sizing = layer.sizing ?? { h: 'FIXED', v: 'FIXED' };
  // A text laid out to its own words keeps hugging whatever the parent asks:
  // filling would let a slightly wider font wrap it onto another line.
  if (layer.type === 'TEXT' && layer.resize === 'WIDTH_AND_HEIGHT') {
    node.layoutSizingHorizontal = 'HUG';
    node.layoutSizingVertical = 'HUG';
    return;
  }
  const legal = (value: string): 'FIXED' | 'HUG' | 'FILL' => {
    if (value === 'FILL') return inAutoLayout && !layer.absolute ? 'FILL' : 'FIXED';
    if (value === 'HUG') return selfLayout || node.type === 'TEXT' ? 'HUG' : 'FIXED';
    return 'FIXED';
  };
  try {
    node.layoutSizingHorizontal = legal(sizing.h);
    node.layoutSizingVertical = legal(sizing.v);
  } catch (error) {
    ctx.warnings.push(`${layer.name}: sizing ${sizing.h}/${sizing.v} not applied (${errorMessage(error)}).`);
  }
  if (layer.minWidth !== undefined || layer.maxWidth !== undefined) {
    try {
      if (layer.minWidth !== undefined) node.minWidth = layer.minWidth;
      if (layer.maxWidth !== undefined) node.maxWidth = layer.maxWidth;
    } catch {
      /* only auto layout participants take limits */
    }
  }
}

function common(node: SceneNode & BlendMixin, layer: LayerIR): void {
  node.name = layer.name;
  if (layer.opacity !== undefined) node.opacity = layer.opacity;
  if (layer.blendMode) {
    try {
      node.blendMode = layer.blendMode as BlendMode;
    } catch {
      /* unknown blend modes stay normal */
    }
  }
}

async function buildFrame(layer: FrameIR, parent: Container, ctx: BuildContext): Promise<FrameNode> {
  const frame = figma.createFrame();
  parent.appendChild(frame);
  common(frame, layer);
  frame.fills = paintsOf(layer.fills, ctx, 'FRAME_FILL');
  frame.clipsContent = !!layer.clip;
  frame.resize(Math.max(layer.width, 0.01), Math.max(layer.height, 0.01));
  applyStroke(frame, layer.stroke, ctx);
  applyRadius(frame, layer.radius);
  if (layer.effects) frame.effects = effectsOf(layer.effects);

  const layout = layer.layout;
  if (layout) {
    frame.layoutMode = layout.mode;
    // A border is already part of the padding the converter measured, so
    // counting the stroke again would take its width from the children twice —
    // and a border drawn as an inset shadow takes no width at all.
    frame.strokesIncludedInLayout = false;
    frame.primaryAxisSizingMode = 'FIXED';
    frame.counterAxisSizingMode = 'FIXED';
    if (layout.wrap) {
      frame.layoutWrap = 'WRAP';
      frame.counterAxisSpacing = layout.crossGap ?? 0;
    }
    [frame.paddingTop, frame.paddingRight, frame.paddingBottom, frame.paddingLeft] = layout.padding;
    frame.itemSpacing = layout.gap;
    frame.primaryAxisAlignItems = layout.primary;
    frame.counterAxisAlignItems = layout.counter === 'BASELINE' && layout.mode !== 'HORIZONTAL' ? 'MIN' : layout.counter;
  }

  for (const child of layer.children) await buildLayer(child, frame, ctx);
  place(frame, layer, parent, ctx);
  return frame;
}

async function applyTextStyle(text: TextNode, style: TextStyleIR, start: number, end: number, ctx: BuildContext, whole: boolean): Promise<void> {
  const choice = await chooseFont(style, ctx.fontUsage);
  if (choice.missing) ctx.missingFonts.add(choice.missing);
  await loadFont(choice.font);
  const lineHeight: LineHeight = style.lineHeight ? { unit: 'PIXELS', value: style.lineHeight } : { unit: 'AUTO' };
  const letterSpacing: LetterSpacing = { unit: 'PIXELS', value: style.letterSpacing ?? 0 };
  if (whole) {
    text.fontName = choice.font;
    text.fontSize = style.size;
    text.lineHeight = lineHeight;
    text.letterSpacing = letterSpacing;
    text.textCase = style.textCase ?? 'ORIGINAL';
    text.textDecoration = style.decoration ?? 'NONE';
    text.fills = paintsOf(style.fills, ctx, 'TEXT_FILL');
  } else {
    text.setRangeFontName(start, end, choice.font);
    text.setRangeFontSize(start, end, style.size);
    text.setRangeLineHeight(start, end, lineHeight);
    text.setRangeLetterSpacing(start, end, letterSpacing);
    text.setRangeTextCase(start, end, style.textCase ?? 'ORIGINAL');
    text.setRangeTextDecoration(start, end, style.decoration ?? 'NONE');
    text.setRangeFills(start, end, paintsOf(style.fills, ctx, 'TEXT_FILL'));
  }
  if (style.href && /^https?:/.test(style.href)) {
    try {
      text.setRangeHyperlink(start, end, { type: 'URL', value: style.href });
    } catch {
      /* links are optional */
    }
  }
}

async function buildText(layer: TextIR, parent: Container, ctx: BuildContext): Promise<TextNode> {
  const text = figma.createText();
  parent.appendChild(text);
  const base = await chooseFont(layer.style, ctx.fontUsage);
  await loadFont(base.font);
  text.fontName = base.font;
  text.characters = layer.characters;
  await applyTextStyle(text, layer.style, 0, layer.characters.length, ctx, true);
  for (const run of layer.runs ?? []) {
    if (run.end > run.start && run.end <= layer.characters.length) {
      await applyTextStyle(text, run.style, run.start, run.end, ctx, false);
    }
  }
  text.textAlignHorizontal = layer.align;
  if (layer.valign) text.textAlignVertical = layer.valign;
  if (layer.opacity !== undefined) text.opacity = layer.opacity;
  if (layer.effects) text.effects = effectsOf(layer.effects);

  if (layer.resize === 'WIDTH_AND_HEIGHT') {
    text.textAutoResize = 'WIDTH_AND_HEIGHT';
  } else {
    text.textAutoResize = 'NONE';
    text.resize(Math.max(layer.width, 1), Math.max(layer.height, 1));
    text.textAutoResize = 'HEIGHT';
  }
  if (layer.maxLines) {
    try {
      text.textTruncation = 'ENDING';
      text.maxLines = layer.maxLines;
    } catch {
      /* older editors: the text simply is not truncated */
    }
  }
  // Text layers keep Figma's automatic name, which follows their content.
  place(text, layer, parent, ctx);
  return text;
}

function buildVector(layer: VectorIR, parent: Container, ctx: BuildContext): SceneNode {
  let node: FrameNode;
  try {
    node = figma.createNodeFromSvg(layer.svg);
  } catch (error) {
    ctx.warnings.push(`${layer.name}: SVG could not be imported (${errorMessage(error)}); an empty frame stands in.`);
    node = figma.createFrame();
    node.fills = [];
  }
  parent.appendChild(node);
  node.name = layer.name;
  if (Math.abs(node.width - layer.width) > 0.5 || Math.abs(node.height - layer.height) > 0.5) {
    node.resize(Math.max(layer.width, 0.01), Math.max(layer.height, 0.01));
  }
  if (layer.opacity !== undefined) node.opacity = layer.opacity;
  place(node, layer, parent, ctx);
  return node;
}

function buildImage(layer: ImageIR, parent: Container, ctx: BuildContext): SceneNode {
  const rect = figma.createRectangle();
  parent.appendChild(rect);
  common(rect, layer);
  rect.resize(Math.max(layer.width, 0.01), Math.max(layer.height, 0.01));
  const fills = paintsOf(layer.fills, ctx, 'SHAPE_FILL');
  const hash = ctx.images[layer.asset];
  if (hash) fills.push({ type: 'IMAGE', imageHash: hash, scaleMode: layer.scaleMode });
  else ctx.warnings.push(`${layer.name}: image did not upload; the layer is empty.`);
  rect.fills = fills;
  applyStroke(rect, layer.stroke, ctx);
  applyRadius(rect, layer.radius);
  if (layer.effects) rect.effects = effectsOf(layer.effects);
  place(rect, layer, parent, ctx);
  return rect;
}

async function buildLayer(layer: LayerIR, parent: Container, ctx: BuildContext): Promise<SceneNode> {
  ctx.nodes++;
  const before = parent.children.length;
  try {
    switch (layer.type) {
      case 'FRAME':
        return await buildFrame(layer, parent, ctx);
      case 'TEXT':
        return await buildText(layer, parent, ctx);
      case 'SVG':
        return buildVector(layer, parent, ctx);
      case 'IMAGE':
        return buildImage(layer, parent, ctx);
    }
  } catch (error) {
    // One broken layer should not cost the screen: drop whatever half of it
    // was created and keep its place with an empty frame.
    ctx.warnings.push(`${layer.name}${layer.origin ? ` (${layer.origin})` : ''}: ${errorMessage(error)}`);
    while (parent.children.length > before) parent.children[parent.children.length - 1].remove();
    const stand = figma.createFrame();
    parent.appendChild(stand);
    stand.name = `${layer.name} (failed)`;
    stand.fills = [];
    stand.resize(Math.max(layer.width, 0.01), Math.max(layer.height, 0.01));
    if (!isAutoLayout(parent) || layer.absolute) {
      stand.x = layer.x;
      stand.y = layer.y;
    }
    return stand;
  }
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

function tag(node: BaseNode, operationId: string, meta?: Record<string, unknown>): void {
  try {
    node.setPluginData(DATA_KEYS.operation, operationId);
    if (meta) node.setPluginData(IMPORT_KEY, JSON.stringify(meta));
  } catch {
    /* tagging is for recovery only */
  }
}

async function resolvePage(page: CanvasIR['page'], journal: Journal): Promise<PageNode> {
  if (page.id) {
    const node = await figma.getNodeByIdAsync(page.id);
    if (!node || node.type !== 'PAGE') throw new Error(`${page.id} is not a page.`);
    await node.loadAsync();
    return node;
  }
  if (page.name) {
    const existing = figma.root.children.find((candidate) => candidate.name === page.name);
    if (existing) {
      await existing.loadAsync();
      return existing;
    }
    const created = figma.createPage();
    created.name = page.name;
    journal.recordCreate('import_html', created as unknown as BaseNode & { children?: readonly SceneNode[] });
    return created;
  }
  return figma.currentPage;
}

const NOTE = {
  width: 880,
  padding: 28,
  gap: 10,
  title: { size: 30, lineHeight: 38, color: { r: 0.1, g: 0.1, b: 0.12 } },
  body: { size: 18, lineHeight: 27, color: { r: 0.4, g: 0.42, b: 0.46 } },
};

/** A caption card: readable on both light and dark canvases. */
async function buildNote(parent: Container, note: CanvasIR['sections'][number]['notes'][number], operationId: string): Promise<FrameNode> {
  const regular = { family: 'Inter', style: 'Regular' };
  const bold = { family: 'Inter', style: 'Semi Bold' };
  await Promise.all([loadFont(regular), loadFont(bold)]);

  const card = figma.createFrame();
  parent.appendChild(card);
  card.name = note.title ? `Note · ${note.title.slice(0, 40)}` : 'Note';
  card.layoutMode = 'VERTICAL';
  card.itemSpacing = NOTE.gap;
  card.paddingTop = card.paddingBottom = NOTE.padding;
  card.paddingLeft = card.paddingRight = NOTE.padding + 4;
  card.cornerRadius = 20;
  card.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  card.strokes = [{ type: 'SOLID', color: { r: 0.88, g: 0.89, b: 0.91 } }];
  card.strokeWeight = 1;
  card.strokeAlign = 'INSIDE';
  card.resize(note.width || NOTE.width, 100);
  card.primaryAxisSizingMode = 'AUTO';
  card.counterAxisSizingMode = 'FIXED';
  card.x = note.x;
  card.y = note.y;

  const addText = (characters: string, font: FontName, spec: typeof NOTE.title) => {
    const text = figma.createText();
    card.appendChild(text);
    text.fontName = font;
    text.characters = characters;
    text.fontSize = spec.size;
    text.lineHeight = { unit: 'PIXELS', value: spec.lineHeight };
    text.fills = [{ type: 'SOLID', color: spec.color }];
    text.layoutSizingHorizontal = 'FILL';
    text.textAutoResize = 'HEIGHT';
  };
  if (note.title) addText(note.title, bold, NOTE.title);
  if (note.body) addText(note.body, regular, NOTE.body);
  tag(card, operationId);
  return card;
}

export interface ImportCanvasResult {
  pageId: string;
  pageName: string;
  sections: Record<string, string>;
  notes: Record<string, string>;
  journal: JournalEntry[];
}

export async function importCanvas(params: CanvasIR): Promise<ImportCanvasResult> {
  const journal = new Journal(params.operationId);
  const page = await resolvePage(params.page ?? {}, journal);
  const sections: Record<string, string> = {};
  const notes: Record<string, string> = {};

  for (const spec of params.sections) {
    const section = figma.createSection();
    page.appendChild(section);
    section.name = spec.name;
    section.x = spec.x;
    section.y = spec.y;
    section.resizeWithoutConstraints(Math.max(spec.width, 100), Math.max(spec.height, 100));
    journal.recordCreate('import_html', section as unknown as BaseNode & { children?: readonly SceneNode[] });
    tag(section, params.operationId);
    sections[spec.key] = section.id;
    for (const note of spec.notes) {
      const card = await buildNote(section, note, params.operationId);
      notes[note.key] = card.id;
    }
  }
  return { pageId: page.id, pageName: page.name, sections, notes, journal: journal.toArray() };
}

export interface ImportScreenResult {
  nodeId: string;
  name: string;
  nodes: number;
  width: number;
  height: number;
  bound: number;
  missingFonts: string[];
  warnings: string[];
  journal: JournalEntry[];
}

export async function importScreen(params: ScreenIR): Promise<ImportScreenResult> {
  const journal = new Journal(params.operationId);
  const parent = (await figma.getNodeByIdAsync(params.parentId)) as Container | null;
  if (!parent || !('appendChild' in parent)) throw new Error(`${params.parentId} cannot hold a screen.`);

  const ctx: BuildContext = {
    operationId: params.operationId,
    fontUsage: await familiesInUse(params.operationId),
    images: params.images ?? {},
    bindTokens: params.bindTokens !== false,
    tokens: params.bindTokens === false ? null : await tokens(params.operationId),
    warnings: [],
    missingFonts: new Set(),
    nodes: 0,
    bound: 0,
  };
  if (ctx.tokens && !ctx.tokens.byColor.size) ctx.tokens = null;

  const layer: FrameIR = { ...params.layer, x: params.x, y: params.y, absolute: undefined };
  const screen = (await buildLayer(layer, parent, ctx)) as FrameNode;
  // A top-level screen is positioned by the section, whatever the tree said.
  screen.x = params.x;
  screen.y = params.y;
  journal.recordCreate('import_html', screen as unknown as BaseNode & { children?: readonly SceneNode[] });
  tag(screen, params.operationId, params.meta);

  return {
    nodeId: screen.id,
    name: screen.name,
    nodes: ctx.nodes,
    width: screen.width,
    height: screen.height,
    bound: ctx.bound,
    missingFonts: [...ctx.missingFonts],
    warnings: ctx.warnings.slice(0, 40),
    journal: journal.toArray(),
  };
}

export interface ArrangeParams {
  pageId: string;
  sections: { id: string; noteId?: string; rows: { noteId?: string; screenIds: string[] }[] }[];
  /** Keep this much free space around everything already on the page. */
  focus?: boolean;
}

const GAP = {
  /** Between sections on the page. */
  section: 400,
  /** Inside a section, around everything. */
  padding: 120,
  /** Between a caption card and the screens it describes. */
  caption: 48,
  /** Between screens of one state. */
  screen: 120,
  /** Between states placed side by side, and between their lines. */
  block: 200,
  line: 220,
  /** Frame titles are drawn above frames; leave them room. */
  title: 36,
  /** How wide a section grows before its states wrap onto a new line. */
  width: 5200,
};

interface Block {
  caption: SceneNode | null;
  screens: SceneNode[];
  width: number;
  height: number;
  /** Screen positions relative to the block's top-left. */
  places: { node: SceneNode; x: number; y: number }[];
}

/** Lays one state out: its screens in a line, wrapping if there are many. */
function measureBlock(caption: SceneNode | null, screens: SceneNode[]): Block {
  const top = caption ? caption.height + GAP.caption : 0;
  const places: { node: SceneNode; x: number; y: number }[] = [];
  let x = 0;
  let y = top + GAP.title;
  let lineHeight = 0;
  let width = 0;
  for (const screen of screens) {
    if (x > 0 && x + screen.width > GAP.width) {
      y += lineHeight + GAP.line;
      x = 0;
      lineHeight = 0;
    }
    places.push({ node: screen, x, y });
    x += screen.width + GAP.screen;
    lineHeight = Math.max(lineHeight, screen.height);
    width = Math.max(width, x - GAP.screen);
  }
  return {
    caption,
    screens,
    width: Math.max(width, caption ? caption.width : 0),
    height: y + lineHeight,
    places,
  };
}

/**
 * Lays everything out from the nodes' real sizes, which can differ from the
 * page's by a few pixels once Figma sets the text. States flow left to right
 * and wrap, so a board of twenty screens reads as a board rather than as one
 * very long column.
 */
export async function importArrange(params: ArrangeParams): Promise<{ sections: { id: string; x: number; y: number; width: number; height: number }[] }> {
  const page = (await figma.getNodeByIdAsync(params.pageId)) as PageNode | null;
  if (!page || page.type !== 'PAGE') throw new Error(`${params.pageId} is not a page.`);
  await page.loadAsync();

  const ours = new Set(params.sections.map((section) => section.id));
  let originX = 0;
  let originY = 0;
  const others = page.children.filter((child) => !ours.has(child.id));
  if (others.length) {
    originX = Math.max(...others.map((child) => child.x + child.width)) + GAP.section;
    originY = Math.min(...others.map((child) => child.y));
  }

  const get = async (id: string | undefined) => (id ? ((await figma.getNodeByIdAsync(id)) as SceneNode | null) : null);
  const out: { id: string; x: number; y: number; width: number; height: number }[] = [];
  let cursor = originX;

  for (const spec of params.sections) {
    const section = (await get(spec.id)) as SectionNode | null;
    if (!section) continue;

    const blocks: Block[] = [];
    for (const row of spec.rows) {
      const caption = await get(row.noteId);
      const screens = (await Promise.all(row.screenIds.map(get))).filter((node): node is SceneNode => !!node);
      if (caption || screens.length) blocks.push(measureBlock(caption, screens));
    }

    let y = GAP.padding;
    let right = GAP.padding;
    const header = await get(spec.noteId);
    if (header) {
      header.x = GAP.padding;
      header.y = y;
      y += header.height + GAP.block;
      right = Math.max(right, header.x + header.width);
    }

    let x = GAP.padding;
    let lineHeight = 0;
    for (const block of blocks) {
      if (x > GAP.padding && x + block.width > GAP.padding + GAP.width) {
        y += lineHeight + GAP.line;
        x = GAP.padding;
        lineHeight = 0;
      }
      if (block.caption) {
        block.caption.x = x;
        block.caption.y = y;
      }
      for (const place of block.places) {
        place.node.x = x + place.x;
        place.node.y = y + place.y;
      }
      right = Math.max(right, x + block.width);
      x += block.width + GAP.block;
      lineHeight = Math.max(lineHeight, block.height);
    }
    y += lineHeight;

    const width = right + GAP.padding;
    const height = Math.max(y + GAP.padding, GAP.padding * 2);
    section.x = cursor;
    section.y = originY;
    section.resizeWithoutConstraints(width, height);
    out.push({ id: section.id, x: section.x, y: section.y, width, height });
    cursor += width + GAP.section;
  }

  if (params.focus !== false) {
    const nodes = (await Promise.all(out.map((section) => figma.getNodeByIdAsync(section.id)))).filter(Boolean) as SceneNode[];
    if (nodes.length) {
      if (figma.currentPage.id !== page.id) await figma.setCurrentPageAsync(page);
      figma.viewport.scrollAndZoomIntoView(nodes);
    }
  }
  return { sections: out };
}

/**
 * Removes everything an import created, found by its tag rather than by a
 * journal — for when the journal never made it back to the server.
 */
export async function importCleanup(params: { operationId: string }): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  await figma.loadAllPagesAsync();
  for (const page of [...figma.root.children]) {
    for (const child of [...page.children]) {
      if (child.getPluginData(DATA_KEYS.operation) === params.operationId) {
        removed.push(child.id);
        child.remove();
      } else if (child.type === 'SECTION') {
        for (const inner of [...child.children]) {
          if (inner.getPluginData(DATA_KEYS.operation) === params.operationId) {
            removed.push(inner.id);
            inner.remove();
          }
        }
      }
    }
    if (page.getPluginData(DATA_KEYS.operation) === params.operationId && page.children.length === 0 && figma.root.children.length > 1) {
      if (figma.currentPage.id === page.id) {
        const other = figma.root.children.find((candidate) => candidate.id !== page.id);
        if (other) await figma.setCurrentPageAsync(other);
      }
      removed.push(page.id);
      page.remove();
    }
  }
  return { removed };
}
