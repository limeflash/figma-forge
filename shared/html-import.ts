/**
 * The two contracts behind HTML import.
 *
 * Rendering happens in a real browser, conversion in the MCP server, and node
 * creation in the Figma plugin — three runtimes that share nothing but these
 * shapes. Types only: this file is imported by the page collector, the server
 * and the plugin, and none of them may pull runtime code from the others.
 *
 *   browser ──RawCollection──▶ server ──LayerIR──▶ plugin
 */

/* ------------------------------------------------------------------ *
 * Browser → server: the rendered DOM, measured
 * ------------------------------------------------------------------ */

/** [x, y, width, height] in document coordinates, border box. */
export type Box = [number, number, number, number];

/** Computed style, with values equal to the property's initial value omitted. */
export type StyleMap = Record<string, string>;

export interface RawAttrs {
  label?: string;
  ariaLabel?: string;
  id?: string;
  className?: string;
  role?: string;
  name?: string;
  alt?: string;
  title?: string;
  href?: string;
  type?: string;
}

export interface RawImage {
  /** Asset id in `RawCollection.assets`. */
  asset: string;
  natural: [number, number];
}

export interface RawRun {
  text: string;
  /** Index into `RawCollection.textStyles`. */
  style: number;
  /** `white-space` of the element the text came from. */
  ws: string;
  href?: string;
  /** A `<br>`; `text` is empty. */
  br?: true;
}

/**
 * An element whose whole content is inline text: collapsed to styled runs,
 * because that is what a single Figma text layer is.
 */
export interface RawParagraph {
  /** The element's own text style; runs that match it need no range override. */
  base: number;
  runs: RawRun[];
  /** Line boxes, merged per visual line. */
  lines: Box[];
}

export interface RawElement {
  k: 'el';
  /** Unique within one collection; mirrored as `data-ff-i` on the element. */
  i: number;
  tag: string;
  a?: RawAttrs;
  r: Box;
  s: StyleMap;
  c?: RawNode[];
  /** Serialized `<svg>` with computed presentation attributes inlined. */
  svg?: string;
  img?: RawImage;
  /** Why this subtree has no faithful vector equivalent; it becomes an image. */
  raster?: string;
  para?: RawParagraph;
  /** Rendered value or placeholder of a form control. */
  field?: { text: string; placeholder: boolean; style: number };
  /** `visibility: hidden` or `opacity: 0`: invisible, but still takes space. */
  hidden?: true;
  /**
   * Cumulative uniform `transform: scale()` of this subtree. Boxes are measured
   * after scaling, lengths in `s` before it, so the converter multiplies those.
   */
  z?: number;
  /** A `::before`/`::after` box, materialized as a real element to be measured. */
  pseudo?: 'before' | 'after';
}

/**
 * Text that has no element of its own: a run of text nodes and inline phrasing
 * inside a flex, grid or mixed container. The browser wraps it in an anonymous
 * box, and so does the importer.
 */
export interface RawText {
  k: 'tx';
  para: RawParagraph;
  /** The anonymous box is block-level: it spans its container's width. */
  block?: true;
}

export type RawNode = RawElement | RawText;

export interface RawAsset {
  id: string;
  kind: 'img' | 'background' | 'raster';
  /** Resolved URL for fetched assets; empty for rasters. */
  src: string;
  /** Element to screenshot, for rasters. */
  element?: number;
  box?: Box;
}

export interface RawCollection {
  root: RawElement;
  textStyles: StyleMap[];
  assets: RawAsset[];
  viewport: { width: number; height: number };
  document: { width: number; height: number };
  stats: Record<string, number>;
  warnings: string[];
}

/* ------------------------------------------------------------------ *
 * Browser → server: what a page looks like, for choosing what to import
 * ------------------------------------------------------------------ */

export interface SurveyScreen {
  /** CSS selector that finds this element again after a reload. */
  selector: string;
  box: Box;
  /** Small text right above the screen, e.g. "ДЕСКТОП · RAIL 424". */
  label?: string;
  /** Row this screen belongs to (index into `rows`). */
  row?: number;
  /**
   * The page inside a device mock: a selector that imports the iframe's own
   * document instead of the frame drawn around it.
   */
  inner?: string;
  /**
   * The same iframe's page, when it is served from the source folder: opening
   * it directly at the device width gives the cleanest mobile screen.
   */
  innerPage?: string;
  /** First words of the screen's own text, to recognise it by. */
  text: string;
  background: string;
  elements: number;
}

export interface SurveyRow {
  /** Caption pieces in reading order, e.g. ["1a", "Пересчёт", "после любого…"]. */
  caption: string[];
  box: Box;
  section?: number;
}

export interface SurveySection {
  heading: string[];
  box: Box;
}

export interface SurveyClickable {
  text: string;
  selector: string;
  box: Box;
  fixed: boolean;
}

export interface RawSurvey {
  title: string;
  viewport: { width: number; height: number };
  document: { width: number; height: number };
  background: string;
  screens: SurveyScreen[];
  rows: SurveyRow[];
  sections: SurveySection[];
  clickables: SurveyClickable[];
  /** Largest text near the top of the page. */
  heading: string[];
  fonts: string[];
  elements: number;
}

/* ------------------------------------------------------------------ *
 * Server → plugin: layers to create
 * ------------------------------------------------------------------ */

export interface RGBAValue {
  r: number;
  g: number;
  b: number;
  a: number;
}

export type Matrix = [[number, number, number], [number, number, number]];

export type ScaleMode = 'FILL' | 'FIT' | 'CROP' | 'TILE';

export type PaintIR =
  | { type: 'SOLID'; color: RGBAValue }
  | {
      type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR';
      transform: Matrix;
      stops: { position: number; color: RGBAValue }[];
    }
  | { type: 'IMAGE'; asset: string; scaleMode: ScaleMode; opacity?: number };

export type EffectIR =
  | {
      type: 'DROP_SHADOW' | 'INNER_SHADOW';
      color: RGBAValue;
      x: number;
      y: number;
      blur: number;
      spread: number;
    }
  | { type: 'LAYER_BLUR' | 'BACKGROUND_BLUR'; radius: number };

export type Sizing = 'FIXED' | 'HUG' | 'FILL';

export interface AutoLayoutIR {
  mode: 'HORIZONTAL' | 'VERTICAL';
  wrap?: boolean;
  gap: number;
  /** Spacing between wrapped lines. */
  crossGap?: number;
  /** top, right, bottom, left */
  padding: [number, number, number, number];
  primary: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
  counter: 'MIN' | 'CENTER' | 'MAX' | 'BASELINE';
}

export interface StrokeIR {
  paints: PaintIR[];
  /** One weight, or top/right/bottom/left. */
  weight: number | [number, number, number, number];
  dash?: number[];
}

export interface LayerBase {
  name: string;
  /** Relative to the parent layer's top-left corner. */
  x: number;
  y: number;
  width: number;
  height: number;
  opacity?: number;
  rotation?: number;
  blendMode?: string;
  /** Taken out of the parent's auto layout flow. */
  absolute?: boolean;
  constraints?: { h: 'MIN' | 'MAX' | 'CENTER' | 'STRETCH'; v: 'MIN' | 'MAX' | 'CENTER' | 'STRETCH' };
  sizing?: { h: Sizing; v: Sizing };
  minWidth?: number;
  maxWidth?: number;
  /** Where it came from, for warnings: `div#12`. */
  origin?: string;
}

/**
 * A component in the file that already draws this layer. The plugin builds an
 * instance of it instead of the frame; if that fails, the frame's own layers
 * are still there to fall back on.
 */
export interface InstanceIR {
  /** Node id of the component — a variant, never the set. */
  componentId: string;
  /** For the report: what it matched. */
  componentName: string;
  /** Component properties by name: variants, booleans, text. */
  properties?: Record<string, string | boolean>;
  /** Text by layer name, for components whose text is not a property. */
  text?: Record<string, string>;
}

export interface FrameIR extends LayerBase {
  type: 'FRAME';
  /** Build this as an instance of a component the file already has. */
  instance?: InstanceIR;
  fills?: PaintIR[];
  stroke?: StrokeIR;
  /** One radius, or top-left/top-right/bottom-right/bottom-left. */
  radius?: number | [number, number, number, number];
  effects?: EffectIR[];
  clip?: boolean;
  layout?: AutoLayoutIR;
  children: LayerIR[];
}

export interface TextStyleIR {
  /** CSS family stack; the plugin uses the first one Figma has. */
  family: string[];
  weight: number;
  italic?: boolean;
  size: number;
  /** Pixels; absent means the font's own line height. */
  lineHeight?: number;
  letterSpacing?: number;
  fills: PaintIR[];
  decoration?: 'UNDERLINE' | 'STRIKETHROUGH';
  textCase?: 'UPPER' | 'LOWER' | 'TITLE';
  href?: string;
}

export interface TextIR extends LayerBase {
  type: 'TEXT';
  characters: string;
  style: TextStyleIR;
  /** Ranges whose style differs from `style`. */
  runs?: { start: number; end: number; style: TextStyleIR }[];
  resize: 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'NONE';
  align: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  valign?: 'TOP' | 'CENTER' | 'BOTTOM';
  maxLines?: number;
  effects?: EffectIR[];
}

export interface VectorIR extends LayerBase {
  type: 'SVG';
  svg: string;
}

export interface ImageIR extends LayerBase {
  type: 'IMAGE';
  asset: string;
  scaleMode: ScaleMode;
  fills?: PaintIR[];
  stroke?: StrokeIR;
  radius?: number | [number, number, number, number];
  effects?: EffectIR[];
}

export type LayerIR = FrameIR | TextIR | VectorIR | ImageIR;

/* ------------------------------------------------------------------ *
 * Server → plugin: where things go on the canvas
 * ------------------------------------------------------------------ */

export interface NoteIR {
  key: string;
  x: number;
  y: number;
  width: number;
  title?: string;
  body?: string;
}

export interface SectionIR {
  key: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  notes: NoteIR[];
}

export interface CanvasIR {
  operationId: string;
  /** An existing page id, or a name to find or create. */
  page: { id?: string; name?: string };
  sections: SectionIR[];
}

export interface ScreenIR {
  operationId: string;
  parentId: string;
  x: number;
  y: number;
  layer: FrameIR;
  /** Asset id → Figma image hash. */
  images: Record<string, string>;
  bindTokens?: boolean;
  /** Stored on the screen frame so a later import can find what it replaced. */
  meta?: Record<string, unknown>;
}
