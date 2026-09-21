/**
 * Runs inside the rendered page.
 *
 * Everything here reads what the browser already decided — boxes, computed
 * styles, line breaks — and reports it as data. Deciding what that means in
 * Figma happens in the server, where it can be tested without a browser.
 *
 * This file is bundled to a standalone script and evaluated in the page, so it
 * must not import anything at runtime. It exposes one global, `__ff`.
 */

import type {
  Box,
  RawAsset,
  RawAttrs,
  RawCollection,
  RawElement,
  RawNode,
  RawParagraph,
  RawRun,
  RawSurvey,
  RawText,
  StyleMap,
  SurveyClickable,
  SurveyRow,
  SurveyScreen,
  SurveySection,
} from '../../../../shared/html-import';

/* ------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------ */

const round = (value: number) => Math.round(value * 100) / 100;
const num = (value: string | null | undefined) => parseFloat(value ?? '') || 0;

/**
 * Where the document being walked sits in the top document. Boxes inside a
 * same-origin iframe are relative to that iframe's viewport; adding this
 * offset puts every box in one coordinate space. Null means the top document.
 */
interface FrameOffset {
  x: number;
  y: number;
}
let frameOffset: FrameOffset | null = null;
const offsetX = () => (frameOffset ? frameOffset.x : window.scrollX);
const offsetY = () => (frameOffset ? frameOffset.y : window.scrollY);

/** Computed style from the element's own window, which matters inside iframes. */
function css(el: Element, pseudo?: string): CSSStyleDeclaration {
  return (el.ownerDocument.defaultView ?? window).getComputedStyle(el, pseudo);
}

function docRect(el: Element): Box {
  const r = el.getBoundingClientRect();
  return [round(r.left + offsetX()), round(r.top + offsetY()), round(r.width), round(r.height)];
}

function innerDocument(el: Element): Document | null {
  if (el.tagName.toLowerCase() !== 'iframe') return null;
  try {
    return (el as HTMLIFrameElement).contentDocument;
  } catch {
    return null;
  }
}

/** Top-document position of an iframe's content box. */
function frameOrigin(iframe: Element): FrameOffset {
  const r = iframe.getBoundingClientRect();
  const cs = css(iframe);
  return {
    x: r.left + offsetX() + num(cs.borderLeftWidth) + num(cs.paddingLeft),
    y: r.top + offsetY() + num(cs.borderTopWidth) + num(cs.paddingTop),
  };
}

/** Every document reachable from the top one without crossing an origin. */
function allDocuments(): Document[] {
  const out: Document[] = [document];
  for (let index = 0; index < out.length; index++) {
    out[index].querySelectorAll('iframe').forEach((frame) => {
      const inner = innerDocument(frame);
      if (inner && !out.includes(inner)) out.push(inner);
    });
  }
  return out;
}

/**
 * `a >>> b` finds `a` (an iframe), then `b` inside its document — the same
 * idea as Playwright's frame piercing.
 */
function resolveTarget(selector: string | undefined): { el: Element; offset: FrameOffset | null } | null {
  const parts = (selector && selector.trim() ? selector : 'body').split('>>>').map((part) => part.trim());
  let doc: Document = document;
  let offset: FrameOffset | null = null;
  for (let index = 0; index < parts.length; index++) {
    const el = doc.querySelector(parts[index]);
    if (!el) return null;
    if (index === parts.length - 1) return { el, offset };
    const inner = innerDocument(el);
    if (!inner) return null;
    const saved = frameOffset;
    frameOffset = offset;
    offset = frameOrigin(el);
    frameOffset = saved;
    doc = inner;
  }
  return null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Chrome keeps modern colour syntaxes in computed values; force them to sRGB. */
const colorCache = new Map<string, string>();
let colorProbe: HTMLElement | null = null;

function srgb(value: string): string {
  if (!value || value.startsWith('rgb') || value === 'transparent' || value === 'currentcolor') return value;
  const cached = colorCache.get(value);
  if (cached !== undefined) return cached;
  if (!colorProbe) {
    colorProbe = document.createElement('span');
    colorProbe.style.display = 'none';
    document.documentElement.appendChild(colorProbe);
  }
  colorProbe.style.color = '';
  colorProbe.style.color = `color(from ${value} srgb r g b / alpha)`;
  const out = css(colorProbe).color || value;
  colorCache.set(value, out);
  return out;
}

function isTransparent(color: string): boolean {
  if (!color || color === 'transparent') return true;
  const alpha = /rgba\([^)]*,\s*([\d.]+)\)$/.exec(color) ?? /\/\s*([\d.]+)\)$/.exec(color);
  return !!alpha && parseFloat(alpha[1]) < 0.02;
}

/** An nth-child path from <body>: stable across reloads of a deterministic page. */
function cssPath(el: Element): string {
  const label = el.getAttribute('data-screen-label');
  if (label && document.querySelectorAll(`[data-screen-label="${CSS.escape(label)}"]`).length === 1) {
    return `[data-screen-label="${CSS.escape(label)}"]`;
  }
  if (el.id && !/\d{3,}|^:/.test(el.id) && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) {
    return `#${CSS.escape(el.id)}`;
  }
  const parts: string[] = [];
  let current: Element | null = el;
  while (current && current !== document.body && current !== document.documentElement) {
    const parent: Element | null = current.parentElement;
    if (!parent) break;
    const index = Array.prototype.indexOf.call(parent.children, current) + 1;
    parts.unshift(`${current.tagName.toLowerCase()}:nth-child(${index})`);
    current = parent;
  }
  return parts.length ? `body > ${parts.join(' > ')}` : 'body';
}

/* ------------------------------------------------------------------ *
 * Page readiness
 * ------------------------------------------------------------------ */

function busyMarkers(): boolean {
  return !!(document.getElementById('__bundler_loading') || document.getElementById('__bundler_thumbnail'));
}

async function waitStable(quietMs = 500, maxMs = 15000): Promise<boolean> {
  let last = performance.now();
  const observers: MutationObserver[] = [];
  const watched = new Set<Document>();
  const watch = () => {
    for (const doc of allDocuments()) {
      if (watched.has(doc)) continue;
      watched.add(doc);
      last = performance.now();
      const observer = new MutationObserver(() => {
        last = performance.now();
      });
      observer.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });
      observers.push(observer);
    }
  };
  const started = performance.now();
  try {
    while (performance.now() - started < maxMs) {
      await sleep(100);
      watch();
      if (busyMarkers()) continue;
      const docs = allDocuments();
      if (docs.some((doc) => doc.readyState !== 'complete')) continue;
      if (docs.some((doc) => Array.prototype.some.call(doc.images, (img: HTMLImageElement) => !img.complete))) continue;
      if (docs.some((doc) => doc.fonts && doc.fonts.status !== 'loaded')) continue;
      if (performance.now() - last >= quietMs) return true;
    }
    return false;
  } finally {
    observers.forEach((observer) => observer.disconnect());
  }
}

/**
 * Runs every finite animation and transition to its end. Disabling them with
 * CSS instead would leave `animation-fill-mode: forwards` content stuck at its
 * starting style — usually invisible.
 */
function finishAnimations(): void {
  const animations = allDocuments().flatMap((doc) => (typeof doc.getAnimations === 'function' ? doc.getAnimations() : []));
  for (const animation of animations) {
    try {
      animation.finish();
    } catch {
      try {
        animation.pause();
        animation.currentTime = 0;
      } catch {
        /* nothing more to do */
      }
    }
  }
}

async function prepare(): Promise<{ stable: boolean; errors: string[] }> {
  for (const img of Array.from(document.images)) {
    if (img.loading === 'lazy') img.loading = 'eager';
  }
  const stable = await waitStable(600, 20000);
  for (const doc of allDocuments()) {
    for (const img of Array.from(doc.images)) if (img.loading === 'lazy') img.loading = 'eager';
    if (doc.fonts) await doc.fonts.ready;
  }
  finishAnimations();
  window.scrollTo(0, 0);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const errors: string[] = [];
  const sink = document.getElementById('__bundler_err');
  if (sink && sink.textContent) errors.push(sink.textContent.slice(0, 500));
  return { stable, errors };
}

async function settle(): Promise<void> {
  await waitStable(300, 5000);
  finishAnimations();
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function scrollExtra(root: Element): number {
  let extra = 0;
  const scan = (el: Element) => {
    const cs = css(el);
    if (/(auto|scroll)/.test(cs.overflowY) && el.clientHeight > 0) extra = Math.max(extra, el.scrollHeight - el.clientHeight);
  };
  scan(root);
  root.querySelectorAll('*').forEach(scan);
  return extra;
}

/** How much content scroll containers around and inside `selector` are hiding. */
/**
 * A modal backdrop is fixed to the viewport, so growing the viewport moves the
 * dialog with it and leaves the page stretched out underneath. A screen in
 * that state is exactly what the viewport shows.
 */
function coveredByOverlay(): boolean {
  const width = document.documentElement.clientWidth;
  const height = document.documentElement.clientHeight;
  // A dimmed backdrop: see-through enough to read the page behind it, solid
  // enough to be a scrim rather than a tint.
  const scrim = (colour: string): boolean => {
    const parts = /rgba?\(([^)]+)\)/.exec(colour);
    if (!parts) return false;
    const values = parts[1].split(',').map((value) => parseFloat(value));
    const alpha = values.length > 3 ? values[3] : 1;
    return alpha > 0.15 && alpha < 0.98;
  };
  for (const el of document.querySelectorAll('body *')) {
    const cs = css(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const dialog = cs.position === 'fixed' || (cs.position === 'absolute' && scrim(cs.backgroundColor));
    if (!dialog) continue;
    const box = el.getBoundingClientRect();
    if (box.width >= width * 0.6 && box.height >= height * 0.6) return true;
  }
  return false;
}

function hiddenOverflow(selector: string): number {
  // Content inside iframes grows by resizing the frames instead.
  if (selector.includes('>>>')) return 0;
  if (coveredByOverlay()) return 0;
  const root = document.querySelector(selector) ?? document.body;
  let extra = scrollExtra(root);
  for (let el = root.parentElement; el; el = el.parentElement) {
    const cs = css(el);
    if (/(auto|scroll)/.test(cs.overflowY) && el.clientHeight > 0) extra = Math.max(extra, el.scrollHeight - el.clientHeight);
  }
  // The page itself scrolls without saying so: `overflow` stays `visible` on
  // the document, so a screen built on `100vh` keeps the viewport's height
  // while its content runs past it. That is the difference between a screen
  // that ends where its content ends and one whose content hangs out of it.
  const doc = document.documentElement;
  extra = Math.max(extra, doc.scrollHeight - doc.clientHeight, document.body.scrollHeight - doc.clientHeight);
  return Math.max(0, Math.ceil(extra));
}

/**
 * Makes every iframe on the way to `selector` as tall as its content, so a
 * phone-sized prototype comes out as a full-length screen. Returns the growth.
 */
function expandFrames(selector: string, width?: number): number {
  const parts = selector.split('>>>').map((part) => part.trim());
  let doc: Document = document;
  let grown = 0;
  for (let index = 0; index < parts.length - 1; index++) {
    const frame = doc.querySelector(parts[index]) as HTMLIFrameElement | null;
    const inner = frame ? innerDocument(frame) : null;
    if (!frame || !inner) return grown;
    if (width && index === parts.length - 2 && Math.abs(frame.clientWidth - width) > 0.5) {
      // The device width the design is meant for, not the mock's inner size.
      frame.style.setProperty('width', `${width}px`, 'important');
      frame.style.setProperty('max-width', 'none', 'important');
      grown += 2;
      continue;
    }
    const extra = Math.max(inner.documentElement.scrollHeight - frame.clientHeight, scrollExtra(inner.documentElement));
    if (extra > 1) {
      frame.style.setProperty('height', `${frame.clientHeight + Math.ceil(extra)}px`, 'important');
      frame.style.setProperty('max-height', 'none', 'important');
      grown += extra;
    }
    doc = inner;
  }
  return Math.ceil(grown);
}

/* ------------------------------------------------------------------ *
 * Styles
 * ------------------------------------------------------------------ */

/** [property, value that means "nothing to report"]. */
const BOX_PROPS: [string, string][] = [
  ['display', ''],
  ['position', 'static'],
  ['top', 'auto'],
  ['right', 'auto'],
  ['bottom', 'auto'],
  ['left', 'auto'],
  ['z-index', 'auto'],
  ['float', 'none'],
  ['min-width', 'auto'],
  ['max-width', 'none'],
  ['min-height', 'auto'],
  ['max-height', 'none'],
  ['padding-top', '0px'],
  ['padding-right', '0px'],
  ['padding-bottom', '0px'],
  ['padding-left', '0px'],
  ['margin-top', '0px'],
  ['margin-right', '0px'],
  ['margin-bottom', '0px'],
  ['margin-left', '0px'],
  ['border-top-width', '0px'],
  ['border-right-width', '0px'],
  ['border-bottom-width', '0px'],
  ['border-left-width', '0px'],
  ['border-top-style', 'none'],
  ['border-right-style', 'none'],
  ['border-bottom-style', 'none'],
  ['border-left-style', 'none'],
  ['border-top-color', ''],
  ['border-right-color', ''],
  ['border-bottom-color', ''],
  ['border-left-color', ''],
  ['border-top-left-radius', '0px'],
  ['border-top-right-radius', '0px'],
  ['border-bottom-right-radius', '0px'],
  ['border-bottom-left-radius', '0px'],
  ['background-color', 'rgba(0, 0, 0, 0)'],
  ['background-image', 'none'],
  ['background-size', 'auto'],
  ['background-position', '0% 0%'],
  ['background-repeat', 'repeat'],
  ['box-shadow', 'none'],
  ['opacity', '1'],
  ['overflow-x', 'visible'],
  ['overflow-y', 'visible'],
  ['mix-blend-mode', 'normal'],
  ['filter', 'none'],
  ['backdrop-filter', 'none'],
  ['transform', 'none'],
  ['flex-direction', 'row'],
  ['flex-wrap', 'nowrap'],
  ['justify-content', 'normal'],
  ['align-items', 'normal'],
  ['align-content', 'normal'],
  ['align-self', 'auto'],
  ['flex-grow', '0'],
  ['flex-shrink', '1'],
  ['flex-basis', 'auto'],
  ['order', '0'],
  ['row-gap', 'normal'],
  ['column-gap', 'normal'],
  ['grid-template-columns', 'none'],
  ['grid-template-rows', 'none'],
  ['grid-column-start', 'auto'],
  ['grid-column-end', 'auto'],
  ['grid-row-start', 'auto'],
  ['grid-row-end', 'auto'],
  ['object-fit', 'fill'],
  ['object-position', '50% 50%'],
  ['vertical-align', 'baseline'],
  ['cursor', 'auto'],
  ['text-align', 'start'],
  ['white-space', 'normal'],
  ['box-sizing', 'content-box'],
];

const COLOR_PROPS = new Set(['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'background-color']);

const TEXT_PROPS: [string, string][] = [
  ['font-family', ''],
  ['font-size', ''],
  ['font-weight', ''],
  ['font-style', 'normal'],
  ['line-height', ''],
  ['letter-spacing', 'normal'],
  ['text-transform', 'none'],
  ['text-decoration-line', 'none'],
  ['color', ''],
  ['-webkit-text-fill-color', ''],
  ['text-shadow', 'none'],
  ['text-align', 'start'],
  ['white-space', 'normal'],
  ['text-overflow', 'clip'],
  ['-webkit-line-clamp', 'none'],
  ['overflow-x', 'visible'],
  ['font-variant-caps', 'normal'],
  ['vertical-align', 'baseline'],
  ['direction', 'ltr'],
];

function readBoxStyle(cs: CSSStyleDeclaration): StyleMap {
  const out: StyleMap = {};
  for (const [prop, initial] of BOX_PROPS) {
    let value = cs.getPropertyValue(prop);
    if (!value || value === initial) continue;
    if ((prop === 'min-width' || prop === 'min-height') && value === '0px') continue;
    if (COLOR_PROPS.has(prop)) value = srgb(value);
    out[prop] = value;
  }
  // A colour on a border nobody can see is noise.
  for (const side of ['top', 'right', 'bottom', 'left']) {
    if (!out[`border-${side}-width`] || out[`border-${side}-style`] === undefined) {
      delete out[`border-${side}-color`];
    }
  }
  const mask = cs.getPropertyValue('mask-image') || cs.getPropertyValue('-webkit-mask-image');
  if (mask && mask !== 'none') out['mask-image'] = mask;
  const clip = cs.getPropertyValue('clip-path');
  if (clip && clip !== 'none') out['clip-path'] = clip;
  return out;
}

function readTextStyle(cs: CSSStyleDeclaration): StyleMap {
  const out: StyleMap = {};
  for (const [prop, initial] of TEXT_PROPS) {
    let value = cs.getPropertyValue(prop);
    if (!value || value === initial) continue;
    if (prop === 'color' || prop === '-webkit-text-fill-color') value = srgb(value);
    out[prop] = value;
  }
  if (out['-webkit-text-fill-color'] === out.color) delete out['-webkit-text-fill-color'];
  return out;
}

/* ------------------------------------------------------------------ *
 * Collection context
 * ------------------------------------------------------------------ */

interface CollectOptions {
  root?: string;
  exclude?: string[];
  rasterize?: string[];
  maxElements?: number;
}

interface Context {
  nextId: number;
  styles: StyleMap[];
  styleKeys: Map<string, number>;
  assets: RawAsset[];
  assetBySrc: Map<string, string>;
  warnings: string[];
  stats: Record<string, number>;
  exclude: string | null;
  rasterize: string | null;
  max: number;
  truncated: boolean;
}

function textStyleIndex(ctx: Context, el: Element): number {
  const style = readTextStyle(css(el));
  const key = JSON.stringify(style);
  let index = ctx.styleKeys.get(key);
  if (index === undefined) {
    index = ctx.styles.length;
    ctx.styles.push(style);
    ctx.styleKeys.set(key, index);
  }
  return index;
}

/**
 * Registers an image once per URL. The box kept is the largest one it is shown
 * at, which decides how much resolution is worth sending to Figma.
 */
function addAsset(ctx: Context, kind: RawAsset['kind'], src: string, box: Box, element?: number): string {
  if (kind !== 'raster') {
    const known = ctx.assetBySrc.get(src);
    if (known) {
      const asset = ctx.assets.find((candidate) => candidate.id === known);
      if (asset?.box && box[2] * box[3] > asset.box[2] * asset.box[3]) asset.box = box;
      return known;
    }
  }
  const id = `a${ctx.assets.length}`;
  ctx.assets.push({ id, kind, src, box, ...(element !== undefined ? { element } : {}) });
  if (kind !== 'raster') ctx.assetBySrc.set(src, id);
  return id;
}

const SKIP_TAGS = new Set([
  'script', 'style', 'link', 'meta', 'head', 'title', 'template', 'noscript', 'base', 'helmet', 'source', 'track', 'param', 'map', 'area', 'datalist',
]);
const REPLACED = new Set(['img', 'svg', 'video', 'canvas', 'iframe', 'object', 'embed', 'input', 'textarea', 'select', 'button', 'picture', 'audio', 'meter', 'progress']);
const FIELD_TAGS = new Set(['input', 'textarea', 'select']);
const ICON_FONT = /material[\s-]?(icons|symbols)|font\s?awesome|fontawesome|icomoon|glyphicons|ionicons|feather|remixicon|bootstrap-icons|phosphor|tabler-icons|lucide/i;
const PRIVATE_USE = /[\uE000-\uF8FF]/;

/* ------------------------------------------------------------------ *
 * Transforms
 * ------------------------------------------------------------------ */

interface TransformInfo {
  kind: 'none' | 'translate' | 'scale' | 'rotate' | 'complex';
  scale: number;
  matrix: number[];
}

function parseTransform(value: string): TransformInfo {
  if (!value || value === 'none') return { kind: 'none', scale: 1, matrix: [1, 0, 0, 1, 0, 0] };
  const match = /^matrix\(([^)]+)\)$/.exec(value);
  if (!match) return { kind: 'complex', scale: 1, matrix: [] };
  const [a, b, c, d, e, f] = match[1].split(',').map((part) => parseFloat(part));
  const near = (x: number, y: number) => Math.abs(x - y) < 1e-4;
  if (near(b, 0) && near(c, 0)) {
    if (near(a, 1) && near(d, 1)) return { kind: 'translate', scale: 1, matrix: [a, b, c, d, e, f] };
    if (near(a, d) && a > 0) return { kind: 'scale', scale: a, matrix: [a, b, c, d, e, f] };
    return { kind: 'complex', scale: 1, matrix: [a, b, c, d, e, f] };
  }
  const scaleX = Math.hypot(a, b);
  const scaleY = Math.hypot(c, d);
  if (near(scaleX, 1) && near(scaleY, 1) && near(a, d) && near(b, -c)) {
    return { kind: 'rotate', scale: 1, matrix: [a, b, c, d, e, f] };
  }
  return { kind: 'complex', scale: 1, matrix: [a, b, c, d, e, f] };
}

/* ------------------------------------------------------------------ *
 * SVG
 * ------------------------------------------------------------------ */

const SVG_PROPS = [
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
  'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit', 'opacity', 'stop-color',
  'stop-opacity', 'clip-rule', 'font-family', 'font-size', 'font-weight', 'text-anchor', 'visibility',
];
const SVG_DEFAULTS: Record<string, string> = {
  'fill-opacity': '1', 'fill-rule': 'nonzero', 'stroke': 'none', 'stroke-opacity': '1', 'stroke-linecap': 'butt',
  'stroke-linejoin': 'miter', 'stroke-dasharray': 'none', 'stroke-dashoffset': '0px', 'stroke-miterlimit': '4',
  'opacity': '1', 'stop-opacity': '1', 'clip-rule': 'nonzero', 'text-anchor': 'start', 'visibility': 'visible',
};

function serializeSvg(svg: SVGSVGElement, box: Box, transform: TransformInfo): string | null {
  if (svg.querySelector('foreignObject')) return null;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const originals = [svg, ...Array.from(svg.querySelectorAll('*'))];
  const copies = [clone, ...Array.from(clone.querySelectorAll('*'))];

  for (let index = 0; index < originals.length; index++) {
    const original = originals[index];
    const copy = copies[index];
    if (!copy) continue;
    const cs = css(original);
    if (cs.display === 'none') {
      copy.setAttribute('display', 'none');
      continue;
    }
    for (const prop of SVG_PROPS) {
      let value = cs.getPropertyValue(prop);
      if (!value || SVG_DEFAULTS[prop] === value) continue;
      if (prop === 'fill' || prop === 'stroke' || prop === 'stop-color') {
        if (value.startsWith('url(')) {
          // Keep the local reference form; computed values are absolute URLs.
          const id = /#([^")]+)/.exec(value)?.[1];
          if (id) value = `url(#${id})`;
        } else if (value !== 'none') {
          value = srgb(value);
        }
      }
      copy.setAttribute(prop, value);
    }
    copy.removeAttribute('class');
    copy.removeAttribute('style');
  }

  // `<use>` pointing at a sprite elsewhere in the document: carry the target.
  const defs: Element[] = [];
  for (const use of Array.from(clone.querySelectorAll('use'))) {
    const ref = use.getAttribute('href') ?? use.getAttribute('xlink:href') ?? '';
    const id = ref.startsWith('#') ? ref.slice(1) : '';
    if (!id || clone.querySelector(`#${CSS.escape(id)}`)) continue;
    const target = svg.ownerDocument.getElementById(id);
    if (target) defs.push(target.cloneNode(true) as Element);
  }
  if (defs.length) {
    const container = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.forEach((def) => container.appendChild(def));
    clone.insertBefore(container, clone.firstChild);
  }

  const width = svg.clientWidth || box[2];
  const height = svg.clientHeight || box[3];
  if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const color = css(svg).color;
  let markup = new XMLSerializer().serializeToString(clone).replace(/currentColor/gi, srgb(color));

  if (transform.kind === 'rotate' || transform.kind === 'scale' || transform.kind === 'complex') {
    // Wrap so the box Figma receives is the transformed one the page shows.
    const [a, b, c, d] = transform.matrix.length ? transform.matrix : [1, 0, 0, 1];
    const [, , outerWidth, outerHeight] = box;
    markup =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${outerWidth}" height="${outerHeight}" viewBox="0 0 ${outerWidth} ${outerHeight}">` +
      `<g transform="translate(${outerWidth / 2} ${outerHeight / 2}) matrix(${a} ${b} ${c} ${d} 0 0) translate(${-width / 2} ${-height / 2})">` +
      markup.replace(/^<svg/, `<svg x="0" y="0"`) +
      `</g></svg>`;
  }
  return markup;
}

/* ------------------------------------------------------------------ *
 * Text
 * ------------------------------------------------------------------ */

/** Merges per-fragment client rects into one box per visual line. */
function lineBoxes(rects: DOMRectList | DOMRect[]): Box[] {
  const sorted = Array.from(rects)
    .filter((r) => r.width > 0.1 && r.height > 0.1)
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const lines: { top: number; bottom: number; left: number; right: number }[] = [];
  for (const r of sorted) {
    const line = lines.find((candidate) => {
      const overlap = Math.min(candidate.bottom, r.bottom) - Math.max(candidate.top, r.top);
      return overlap >= Math.min(candidate.bottom - candidate.top, r.height) * 0.5;
    });
    if (line) {
      line.top = Math.min(line.top, r.top);
      line.bottom = Math.max(line.bottom, r.bottom);
      line.left = Math.min(line.left, r.left);
      line.right = Math.max(line.right, r.right);
    } else {
      lines.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
    }
  }
  return lines.map((line) => [
    round(line.left + offsetX()),
    round(line.top + offsetY()),
    round(line.right - line.left),
    round(line.bottom - line.top),
  ]);
}

function preservesSpace(ws: string): boolean {
  return ws === 'pre' || ws === 'pre-wrap' || ws === 'break-spaces' || ws === 'pre-line';
}

function hasText(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = (node as Text).data;
    if (/\S/.test(text)) return true;
    const parent = node.parentElement;
    return !!parent && preservesSpace(css(parent).whiteSpace) && text.length > 0 && /[^\n\r]/.test(text);
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as Element;
  if (el.tagName.toLowerCase() === 'br') return true;
  for (const child of Array.from(el.childNodes)) if (hasText(child)) return true;
  return false;
}

function hasOwnBox(cs: CSSStyleDeclaration): boolean {
  if (!isTransparent(cs.backgroundColor) || cs.backgroundImage !== 'none') return true;
  if (cs.boxShadow !== 'none') return true;
  for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
    if (parseFloat(cs[`border${side}Width`]) > 0 && cs[`border${side}Style`] !== 'none') return true;
  }
  if (parseFloat(cs.paddingLeft) > 0 || parseFloat(cs.paddingRight) > 0) return true;
  if (parseFloat(cs.paddingTop) > 0 || parseFloat(cs.paddingBottom) > 0) return true;
  return false;
}

/**
 * Whether an element's content is a single run of inline text: exactly what a
 * Figma text layer can hold. Flex and grid containers blockify their children,
 * so there only bare text qualifies.
 */
function isInlineOnly(el: Element, blockified: boolean): boolean {
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.COMMENT_NODE) continue;
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const child = node as Element;
    const tag = child.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) continue;
    const cs = css(child);
    if (cs.display === 'none') continue;
    if (blockified) return false;
    if (tag === 'br') continue;
    if (REPLACED.has(tag)) return false;
    if (cs.display !== 'inline' && cs.display !== 'contents') return false;
    if (cs.position === 'absolute' || cs.position === 'fixed') return false;
    if (hasOwnBox(cs)) return false;
    if (parseTransform(cs.transform).kind !== 'none') return false;
    if (!isInlineOnly(child, false)) return false;
  }
  return true;
}

function collectRuns(ctx: Context, el: Element, runs: RawRun[], href?: string): void {
  const ws = css(el).whiteSpace;
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node as Text).data;
      if (text) runs.push({ text, style: textStyleIndex(ctx, el), ws, href });
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const child = node as Element;
    const tag = child.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag) || css(child).display === 'none') continue;
    if (tag === 'br') {
      runs.push({ text: '', br: true, style: textStyleIndex(ctx, el), ws });
      continue;
    }
    const link = tag === 'a' ? (child as HTMLAnchorElement).href || href : href;
    collectRuns(ctx, child, runs, link);
  }
}

function paragraph(ctx: Context, el: Element): RawParagraph {
  const runs: RawRun[] = [];
  collectRuns(ctx, el, runs, el.tagName.toLowerCase() === 'a' ? (el as HTMLAnchorElement).href : undefined);
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  return { base: textStyleIndex(ctx, el), runs, lines: lineBoxes(range.getClientRects()) };
}

/** Inline content that belongs in the same text layer as its neighbours. */
function isPhrasing(el: Element, cs: CSSStyleDeclaration): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === 'br') return true;
  if (cs.display !== 'inline' || REPLACED.has(tag)) return false;
  if (cs.position === 'absolute' || cs.position === 'fixed') return false;
  if (hasOwnBox(cs) || parseTransform(cs.transform).kind !== 'none') return false;
  return isInlineOnly(el, false);
}

/**
 * Consecutive text and phrasing, as the browser groups them: one anonymous
 * paragraph, styled by run.
 */
function anonymousParagraph(ctx: Context, owner: Element, nodes: Node[], block: boolean): RawText | null {
  const ws = css(owner).whiteSpace;
  const base = textStyleIndex(ctx, owner);
  const runs: RawRun[] = [];
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node as Text).data;
      if (text) runs.push({ text, style: base, ws });
      continue;
    }
    const el = node as Element;
    if (el.tagName.toLowerCase() === 'br') {
      runs.push({ text: '', br: true, style: base, ws });
      continue;
    }
    collectRuns(ctx, el, runs, el.tagName.toLowerCase() === 'a' ? (el as HTMLAnchorElement).href || undefined : undefined);
  }
  if (!runs.some((run) => run.br || /\S/.test(run.text) || (preservesSpace(run.ws) && run.text.length > 0))) return null;
  const range = owner.ownerDocument.createRange();
  range.setStartBefore(nodes[0]);
  range.setEndAfter(nodes[nodes.length - 1]);
  const lines = lineBoxes(range.getClientRects());
  if (!lines.length) return null;
  ctx.stats.texts = (ctx.stats.texts ?? 0) + 1;
  const text: RawText = { k: 'tx', para: { base, runs, lines } };
  if (block) text.block = true;
  return text;
}

/* ------------------------------------------------------------------ *
 * Pseudo-elements
 * ------------------------------------------------------------------ */

const PSEUDO_HOST = 'data-ff-pseudo-host';

/**
 * `::before` and `::after` have no DOM node and no box we can measure, so they
 * are copied into real elements with the same computed style, and the
 * originals are switched off. Layout comes out identical.
 */
function materializePseudos(root: Element): number {
  const doc = root.ownerDocument;
  if (!doc.getElementById('ff-pseudo-style')) {
    const style = doc.createElement('style');
    style.id = 'ff-pseudo-style';
    style.textContent = `[${PSEUDO_HOST}]::before, [${PSEUDO_HOST}]::after { content: none !important; }`;
    (doc.head ?? doc.documentElement).appendChild(style);
  }
  let count = 0;
  const hosts = [root, ...Array.from(root.querySelectorAll('*'))];
  const planned: { host: Element; which: 'before' | 'after'; node: HTMLElement }[] = [];
  for (const host of hosts) {
    if (host.hasAttribute(PSEUDO_HOST) || host.namespaceURI === 'http://www.w3.org/2000/svg') continue;
    const tag = host.tagName.toLowerCase();
    if (REPLACED.has(tag) || SKIP_TAGS.has(tag)) continue;
    for (const which of ['before', 'after'] as const) {
      const cs = css(host, `::${which}`);
      const content = cs.content;
      if (!content || content === 'none' || content === 'normal') continue;
      if (cs.display === 'none') continue;
      const node = doc.createElement('ff-pseudo');
      for (let index = 0; index < cs.length; index++) {
        const prop = cs[index];
        if (prop === 'content') continue;
        node.style.setProperty(prop, cs.getPropertyValue(prop));
      }
      const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(content);
      if (quoted) {
        node.textContent = quoted[1].replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16))).replace(/\\(.)/g, '$1');
      } else if (/^url\(/.test(content)) {
        node.style.backgroundImage = content;
        node.style.backgroundSize = '100% 100%';
      }
      node.setAttribute('data-ff-pseudo', which);
      planned.push({ host, which, node });
    }
  }
  for (const { host, which, node } of planned) {
    host.setAttribute(PSEUDO_HOST, '');
    if (which === 'before') host.insertBefore(node, host.firstChild);
    else host.appendChild(node);
    count++;
  }
  return count;
}

/* ------------------------------------------------------------------ *
 * The walk
 * ------------------------------------------------------------------ */

function attrsOf(el: Element): RawAttrs | undefined {
  const a: RawAttrs = {};
  const get = (name: string) => {
    const value = el.getAttribute(name);
    return value && value.trim() ? value.trim().slice(0, 80) : undefined;
  };
  a.label = get('data-screen-label') ?? get('data-name') ?? get('data-label');
  a.ariaLabel = get('aria-label');
  a.id = get('id');
  const className = typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className : '';
  if (className) a.className = className.slice(0, 80);
  a.role = get('role');
  a.name = get('name');
  a.alt = get('alt');
  a.title = get('title');
  if (el.tagName.toLowerCase() === 'a') a.href = (el as HTMLAnchorElement).href || undefined;
  a.type = get('type');
  for (const key of Object.keys(a) as (keyof RawAttrs)[]) if (a[key] === undefined) delete a[key];
  return Object.keys(a).length ? a : undefined;
}

function rasterReason(ctx: Context, el: Element, tag: string, cs: CSSStyleDeclaration, transform: TransformInfo): string | null {
  if (ctx.rasterize && el.matches(ctx.rasterize)) return 'requested';
  if (tag === 'canvas' || tag === 'video' || tag === 'iframe' || tag === 'object' || tag === 'embed') return tag;
  if (tag === 'input') {
    const type = (el as HTMLInputElement).type;
    if (/^(checkbox|radio|range|color|file)$/.test(type) && cs.appearance !== 'none') return `native ${type}`;
  }
  if (tag === 'meter' || tag === 'progress') return tag;
  const mask = cs.getPropertyValue('mask-image') || cs.getPropertyValue('-webkit-mask-image');
  if (mask && mask !== 'none') return 'mask';
  const clip = cs.getPropertyValue('clip-path');
  if (clip && clip !== 'none' && !/^inset\(/.test(clip)) return 'clip-path';
  const backgroundClip = cs.getPropertyValue('background-clip') || cs.getPropertyValue('-webkit-background-clip');
  if (/text/.test(backgroundClip)) return 'gradient text';
  if (cs.filter !== 'none' && !/^(blur\([^)]*\)\s*)+$/.test(cs.filter)) return 'filter';
  if (/conic-gradient|repeating-|image-set|cross-fade|element\(/.test(cs.backgroundImage)) return 'background';
  if (tag !== 'svg' && (transform.kind === 'rotate' || transform.kind === 'complex')) return 'transform';
  if (parseFloat(cs.getPropertyValue('-webkit-text-stroke-width')) > 0) return 'text stroke';
  if (cs.writingMode && cs.writingMode !== 'horizontal-tb') return 'vertical text';
  const ownText = Array.from(el.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => (node as Text).data)
    .join('');
  if (ownText.trim() && (ICON_FONT.test(cs.fontFamily) || PRIVATE_USE.test(ownText))) return 'icon font';
  return null;
}

/** The one `<svg>` an element wraps, if that is all it contains. */
function onlySvgChild(el: Element): SVGSVGElement | null {
  let found: SVGSVGElement | null = null;
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (/\S/.test((node as Text).data)) return null;
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const child = node as Element;
    if (SKIP_TAGS.has(child.tagName.toLowerCase())) continue;
    if (css(child).display === 'none') continue;
    if (child.tagName.toLowerCase() !== 'svg' || found) return null;
    found = child as SVGSVGElement;
  }
  return found;
}

function backgroundUrls(value: string): string[] {
  const out: string[] = [];
  const pattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) out.push((match[1] ?? match[2] ?? match[3] ?? '').trim());
  return out.filter(Boolean);
}

function visitChildren(ctx: Context, parent: Element | ShadowRoot, owner: Element, out: RawNode[], scale: number): void {
  const blockified = /flex|grid/.test(css(owner).display);
  const elements = Array.from(parent.childNodes).filter((node): node is Element => node.nodeType === Node.ELEMENT_NODE);
  // An inline run next to block boxes becomes an anonymous block of its own.
  const hasBlocks =
    !blockified &&
    elements.some((el) => {
      const cs = css(el);
      return cs.display !== 'none' && !/^inline|^contents$/.test(cs.display) && cs.position !== 'absolute' && cs.position !== 'fixed';
    });

  let run: Node[] = [];
  const flush = () => {
    if (run.length) {
      const text = anonymousParagraph(ctx, owner, run, hasBlocks);
      if (text) out.push(text);
    }
    run = [];
  };

  for (const node of Array.from(parent.childNodes)) {
    if (ctx.truncated) return;
    if (node.nodeType === Node.TEXT_NODE) {
      run.push(node);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const child = node as Element;
    const tag = child.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) continue;
    const cs = css(child);
    if (cs.display === 'none') continue;
    // Flex and grid make every element its own item; only bare text merges.
    if (!blockified && isPhrasing(child, cs)) {
      run.push(child);
      continue;
    }
    flush();
    if (tag === 'slot') {
      for (const assigned of (child as HTMLSlotElement).assignedNodes({ flatten: true })) {
        if (assigned.nodeType === Node.ELEMENT_NODE) {
          const raw = visit(ctx, assigned as Element, scale);
          if (raw) out.push(raw);
        }
      }
      continue;
    }
    if (cs.display === 'contents') {
      visitChildren(ctx, child, child, out, scale);
      continue;
    }
    const raw = visit(ctx, child, scale);
    if (raw) out.push(raw);
  }
  flush();
}

function visit(ctx: Context, el: Element, parentScale: number): RawElement | null {
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return null;
  const cs = css(el);
  if (cs.display === 'none') return null;
  if (ctx.exclude && el.matches(ctx.exclude)) {
    // Over-broad exclusions are a common mistake: say what was dropped.
    ctx.stats.excluded = (ctx.stats.excluded ?? 0) + 1;
    if (ctx.stats.excluded <= 5) {
      const box = el.getBoundingClientRect();
      const text = collapse((el as HTMLElement).innerText ?? '').slice(0, 40);
      ctx.warnings.push(`Excluded ${tag} ${Math.round(box.width)}×${Math.round(box.height)}${text ? ` "${text}"` : ''}.`);
    }
    return null;
  }
  if (ctx.nextId >= ctx.max) {
    if (!ctx.truncated) ctx.warnings.push(`Stopped after ${ctx.max} elements; the rest of this screen was not imported.`);
    ctx.truncated = true;
    return null;
  }

  const box = docRect(el);
  const raw: RawElement = { k: 'el', i: ctx.nextId++, tag, r: box, s: readBoxStyle(cs) };
  el.setAttribute('data-ff-i', String(raw.i));
  const attrs = attrsOf(el);
  if (attrs) raw.a = attrs;
  const pseudo = el.getAttribute('data-ff-pseudo');
  if (pseudo === 'before' || pseudo === 'after') raw.pseudo = pseudo;
  ctx.stats.elements = (ctx.stats.elements ?? 0) + 1;

  const transform = parseTransform(cs.transform);
  const scale = transform.kind === 'scale' ? parentScale * transform.scale : parentScale;
  if (Math.abs(scale - 1) > 1e-4) raw.z = round(scale * 10000) / 10000;

  if (cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) {
    raw.hidden = true;
    return raw;
  }

  if (tag === 'iframe') {
    const inner = innerDocument(el);
    if (inner && inner.body) {
      // A same-origin frame is just more page: walk into it.
      const saved = frameOffset;
      frameOffset = frameOrigin(el);
      materializePseudos(inner.body);
      const body = visit(ctx, inner.body, scale);
      frameOffset = saved;
      raw.s['overflow-x'] = 'hidden';
      raw.s['overflow-y'] = 'hidden';
      const htmlBackground = css(inner.documentElement).backgroundColor;
      const canvas = !isTransparent(htmlBackground) ? htmlBackground : css(inner.body).backgroundColor;
      if (!isTransparent(canvas)) raw.s['background-color'] = srgb(canvas);
      if (body) raw.c = [body];
      ctx.stats.frames = (ctx.stats.frames ?? 0) + 1;
      return raw;
    }
  }

  if (tag === 'svg') {
    const markup = serializeSvg(el as SVGSVGElement, box, transform);
    if (markup) {
      raw.svg = markup;
      ctx.stats.svgs = (ctx.stats.svgs ?? 0) + 1;
      return raw;
    }
  }

  // A rotated wrapper around one icon — a flipped chevron, usually. Rotating
  // the vector keeps it a vector instead of turning the button into a picture.
  if (transform.kind === 'rotate') {
    const child = onlySvgChild(el);
    if (child) {
      const markup = serializeSvg(child, box, transform);
      if (markup) {
        raw.svg = markup;
        ctx.stats.svgs = (ctx.stats.svgs ?? 0) + 1;
        return raw;
      }
    }
  }

  const reason = tag === 'svg' ? 'svg with foreignObject' : rasterReason(ctx, el, tag, cs, transform);
  if (reason) {
    raw.raster = reason;
    const id = addAsset(ctx, 'raster', '', box, raw.i);
    raw.img = { asset: id, natural: [box[2], box[3]] };
    ctx.stats.rasters = (ctx.stats.rasters ?? 0) + 1;
    return raw;
  }

  if (tag === 'img') {
    const img = el as HTMLImageElement;
    const src = img.currentSrc || img.src;
    if (src && img.naturalWidth > 0) {
      raw.img = { asset: addAsset(ctx, 'img', src, box), natural: [img.naturalWidth, img.naturalHeight] };
      ctx.stats.images = (ctx.stats.images ?? 0) + 1;
    } else {
      ctx.warnings.push(`Image ${src ? src.slice(0, 80) : '(no src)'} did not load; kept as an empty box.`);
    }
    return raw;
  }

  for (const url of backgroundUrls(cs.backgroundImage)) addAsset(ctx, 'background', url, box);

  if (FIELD_TAGS.has(tag)) {
    const field = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    let text = '';
    let placeholder = false;
    if (tag === 'select') {
      const select = field as HTMLSelectElement;
      text = select.selectedOptions[0]?.textContent ?? '';
    } else {
      text = (field as HTMLInputElement).value;
      if ((field as HTMLInputElement).type === 'password') text = '•'.repeat(text.length);
      if (!text) {
        text = (field as HTMLInputElement).placeholder ?? '';
        placeholder = true;
      }
    }
    if (text) {
      let style = textStyleIndex(ctx, el);
      if (placeholder) {
        const ph = readTextStyle(css(el, '::placeholder'));
        const merged = { ...ctx.styles[style], ...ph };
        const key = JSON.stringify(merged);
        style = ctx.styleKeys.get(key) ?? (ctx.styles.push(merged) - 1);
        ctx.styleKeys.set(key, style);
      }
      raw.field = { text, placeholder, style };
    }
    return raw;
  }

  const blockified = /flex|grid/.test(cs.display);
  if (hasText(el) && isInlineOnly(el, blockified) && !el.shadowRoot) {
    raw.para = paragraph(ctx, el);
    ctx.stats.paragraphs = (ctx.stats.paragraphs ?? 0) + 1;
    return raw;
  }

  const children: RawNode[] = [];
  visitChildren(ctx, el.shadowRoot ?? el, el, children, scale);
  if (children.length) raw.c = children;
  return raw;
}

function collect(options: CollectOptions = {}): RawCollection {
  const target = resolveTarget(options.root);
  if (!target) throw new Error(`Nothing matches "${options.root}" on this page.`);
  const root = target.el;

  for (const doc of allDocuments()) doc.querySelectorAll('[data-ff-i]').forEach((el) => el.removeAttribute('data-ff-i'));
  const pseudos = materializePseudos(root);
  finishAnimations();
  frameOffset = target.offset;

  const ctx: Context = {
    nextId: 0,
    styles: [],
    styleKeys: new Map(),
    assets: [],
    assetBySrc: new Map(),
    warnings: [],
    stats: { pseudos },
    exclude: options.exclude && options.exclude.length ? options.exclude.join(', ') : null,
    rasterize: options.rasterize && options.rasterize.length ? options.rasterize.join(', ') : null,
    max: options.maxElements ?? 12000,
    truncated: false,
  };

  const started = performance.now();
  let rootRaw: RawElement | null;
  try {
    rootRaw = visit(ctx, root, 1);
  } finally {
    frameOffset = null;
  }
  if (!rootRaw) throw new Error(`"${options.root ?? 'body'}" is not rendered (display: none?).`);
  ctx.stats.ms = Math.round(performance.now() - started);

  return {
    root: rootRaw,
    textStyles: ctx.styles,
    assets: ctx.assets,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    document: {
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    },
    stats: ctx.stats,
    warnings: ctx.warnings,
  };
}

/* ------------------------------------------------------------------ *
 * Assets
 * ------------------------------------------------------------------ */

type AssetResult =
  | { kind: 'svg'; text: string }
  | { kind: 'bitmap'; mime: string; data: string; width: number; height: number }
  | { kind: 'error'; error: string };

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(index, index + 0x8000)));
  }
  return btoa(binary);
}

/**
 * Reads an image the page already loaded. Figma accepts PNG, JPEG and GIF up to
 * 4096px, so anything else — WebP, AVIF, oversized photos — is re-encoded.
 */
async function asset(src: string, maxWidth: number, maxHeight: number): Promise<AssetResult> {
  try {
    const response = await fetch(src);
    if (!response.ok) return { kind: 'error', error: `HTTP ${response.status}` };
    const blob = await response.blob();
    const type = blob.type || '';
    if (type.includes('svg') || /^data:image\/svg/i.test(src) || /\.svg([?#]|$)/i.test(src)) {
      return { kind: 'svg', text: await blob.text() };
    }
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxWidth / bitmap.width, maxHeight / bitmap.height, 4096 / bitmap.width, 4096 / bitmap.height);
    const native = /^image\/(png|jpeg|gif)$/.test(type);
    if (scale >= 1 && native && blob.size < 24 * 1024 * 1024) {
      const result = { kind: 'bitmap' as const, mime: type, data: toBase64(await blob.arrayBuffer()), width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return result;
    }
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) return { kind: 'error', error: 'no 2d context' };
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const mime = type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const out = await canvas.convertToBlob({ type: mime, quality: 0.92 });
    return { kind: 'bitmap', mime, data: toBase64(await out.arrayBuffer()), width, height };
  } catch (error) {
    return { kind: 'error', error: String(error instanceof Error ? error.message : error) };
  }
}

/**
 * Hides everything but one element, so a screenshot captures only it. Inside
 * an iframe, the frames leading to it stay visible too.
 */
function isolate(index: number | null): Box | null {
  for (const doc of allDocuments()) {
    doc.getElementById('ff-isolate')?.remove();
    doc.querySelectorAll('[data-ff-raster]').forEach((el) => el.removeAttribute('data-ff-raster'));
  }
  if (index === null) return null;

  let found: Element | null = null;
  let owner: Document | null = null;
  for (const doc of allDocuments()) {
    found = doc.querySelector(`[data-ff-i="${index}"]`);
    if (found) {
      owner = doc;
      break;
    }
  }
  if (!found || !owner) return null;

  const hide = (doc: Document) => {
    const style = doc.createElement('style');
    style.id = 'ff-isolate';
    style.textContent =
      'html, body { background: transparent !important; } ' +
      '* { visibility: hidden !important; } ' +
      '[data-ff-raster], [data-ff-raster] * { visibility: visible !important; }';
    (doc.head ?? doc.documentElement).appendChild(style);
  };
  found.setAttribute('data-ff-raster', '');
  hide(owner);
  // Mark the chain of iframes from the top document down to the element.
  let chainOffset: FrameOffset | null = null;
  if (owner !== document) {
    const chain: Element[] = [];
    let doc: Document = owner;
    while (doc !== document) {
      const frame = doc.defaultView?.frameElement;
      if (!frame) break;
      chain.unshift(frame);
      doc = frame.ownerDocument;
    }
    for (const frame of chain) {
      frame.setAttribute('data-ff-raster', '');
      if (!frame.ownerDocument.getElementById('ff-isolate')) hide(frame.ownerDocument);
      const saved = frameOffset;
      frameOffset = chainOffset;
      chainOffset = frameOrigin(frame);
      frameOffset = saved;
    }
  }
  window.scrollTo(0, 0);
  const saved = frameOffset;
  frameOffset = chainOffset;
  const box = docRect(found);
  frameOffset = saved;
  return box;
}

/* ------------------------------------------------------------------ *
 * Survey
 * ------------------------------------------------------------------ */

const MIN_SCREEN_WIDTH = 160;
const MIN_SCREEN_HEIGHT = 100;

function isOpaque(el: Element, cs = css(el)): boolean {
  if (!isTransparent(cs.backgroundColor) || cs.backgroundImage !== 'none') return true;
  if (cs.boxShadow !== 'none') return true;
  const widths = ['Top', 'Right', 'Bottom', 'Left'].map((side) => parseFloat(cs.getPropertyValue(`border-${side.toLowerCase()}-width`)) || 0);
  return widths.every((width) => width > 0) && cs.borderTopStyle !== 'none';
}

function isVisible(el: Element): boolean {
  const cs = css(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function topMostOpaque(root: Element, minWidth: number, minHeight: number): Element[] {
  const out: Element[] = [];
  const walk = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag) || el.id === '__bundler_err') return;
    const cs = css(el);
    if (cs.display === 'none') return;
    if (cs.position === 'fixed') return;
    const r = el.getBoundingClientRect();
    if (el !== root && r.width >= minWidth && r.height >= minHeight && (isOpaque(el, cs) || tag === 'iframe' || tag === 'img' || tag === 'canvas')) {
      out.push(el);
      return;
    }
    for (const child of Array.from(el.children)) walk(child);
  };
  for (const child of Array.from(root.children)) walk(child);
  return out;
}

/** Text pieces in reading order, one per element that owns text directly. */
function textPieces(el: Element, limit = 8): string[] {
  const out: string[] = [];
  const walk = (node: Element) => {
    if (out.length >= limit) return;
    const cs = css(node);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const own = Array.from(node.childNodes)
      .filter((child) => child.nodeType === Node.TEXT_NODE)
      .map((child) => (child as Text).data)
      .join(' ');
    if (collapse(own)) out.push(collapse(node.textContent ?? '').slice(0, 600));
    else for (const child of Array.from(node.children)) walk(child);
  };
  walk(el);
  return out;
}

function containsAny(el: Element, targets: Element[]): boolean {
  return targets.some((target) => el === target || el.contains(target));
}

function isCaptionLike(el: Element, screens: Element[]): boolean {
  if (containsAny(el, screens)) return false;
  if (!isVisible(el)) return false;
  const cs = css(el);
  if (!isTransparent(cs.backgroundColor)) return false;
  return collapse(el.textContent ?? '').length >= 1;
}

function largestFont(el: Element): number {
  let size = parseFloat(css(el).fontSize) || 0;
  el.querySelectorAll('*').forEach((child) => {
    if (Array.from(child.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && /\S/.test((node as Text).data))) {
      size = Math.max(size, parseFloat(css(child).fontSize) || 0);
    }
  });
  return size;
}

function survey(): RawSurvey {
  const docWidth = document.documentElement.scrollWidth;
  const docHeight = document.documentElement.scrollHeight;

  let screens = topMostOpaque(document.body, MIN_SCREEN_WIDTH, MIN_SCREEN_HEIGHT);

  // One opaque block covering the page is either the page itself or a board
  // painted on a background. A board has captioned blocks inside it.
  if (screens.length === 1) {
    const only = screens[0].getBoundingClientRect();
    if (only.width * only.height >= docWidth * docHeight * 0.8) {
      const inner = topMostOpaque(screens[0], MIN_SCREEN_WIDTH, MIN_SCREEN_HEIGHT);
      const captioned = inner.filter((candidate) => {
        const parent = candidate.parentElement;
        if (!parent) return false;
        const index = Array.prototype.indexOf.call(parent.children, candidate);
        return index > 0 && isCaptionLike(parent.children[index - 1], inner);
      });
      if (inner.length >= 2 && captioned.length >= Math.max(2, inner.length / 2)) screens = inner;
    }
  }

  // A transparent column made only of opaque blocks is one state drawn as a
  // stack of cards: the column is the screen, not its first card.
  screens = screens.map((el) => {
    const parent = el.parentElement;
    if (!parent || parent === document.body || screens.includes(parent)) return el;
    const cs = css(parent);
    if (isOpaque(parent, cs) || (cs.display.startsWith('inline') && !/flex|grid/.test(cs.display))) return el;
    const blocks = Array.from(parent.children).filter((child) => isVisible(child));
    const ownText = Array.from(parent.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && /\S/.test((node as Text).data));
    if (blocks.length < 2 || ownText || !blocks.every((child) => isOpaque(child))) return el;
    if (blocks.some((child) => child !== el && screens.includes(child) && child.getBoundingClientRect().height >= MIN_SCREEN_HEIGHT * 2)) return el;
    return parent;
  }).filter((el, index, all) => all.indexOf(el) === index && !all.some((other) => other !== el && other.contains(el)));

  const rows: SurveyRow[] = [];
  const rowElements: Element[] = [];
  const sections: SurveySection[] = [];
  const sectionElements: Element[] = [];

  /**
   * Walks up from `from` looking for a caption-like sibling that precedes it.
   * Row captions must be the nearest thing above — a screen in between means
   * the caption belongs to some other row. Section headings may sit above any
   * number of rows, so for them screens are stepped over.
   */
  const findCaptioned = (
    from: Element,
    levels: number,
    options: { stepOverScreens: boolean; minFont?: number }
  ): { container: Element; caption: Element } | null => {
    let current: Element | null = from;
    for (let depth = 0; current && current !== document.body && depth < levels; depth++) {
      const parent: Element | null = current.parentElement;
      if (!parent) break;
      const index = Array.prototype.indexOf.call(parent.children, current);
      for (let i = index - 1; i >= 0; i--) {
        const sibling = parent.children[i];
        if (containsAny(sibling, screens)) {
          if (options.stepOverScreens) continue;
          break;
        }
        if (!isCaptionLike(sibling, screens)) continue;
        if (options.minFont && largestFont(sibling) < options.minFont) continue;
        return { container: parent, caption: sibling };
      }
      current = parent;
    }
    return null;
  };

  /**
   * A label is the element immediately above a screen and short. Screens are
   * often wrapped in boxes of exactly their own size, so the label may be the
   * previous sibling of a wrapper rather than of the screen itself.
   */
  const findLabel = (el: Element): { text: string; owner: Element } | null => {
    const own = el.getBoundingClientRect();
    let current: Element = el;
    for (let depth = 0; depth < 6 && current.parentElement && current !== document.body; depth++) {
      const previous = current.previousElementSibling;
      if (previous) {
        if (!isCaptionLike(previous, screens)) return null;
        const box = previous.getBoundingClientRect();
        const text = collapse(previous.textContent ?? '');
        if (box.height <= 40 && box.bottom <= own.top + 2 && own.top - box.bottom <= 48 && text.length <= 80) {
          return { text, owner: current.parentElement };
        }
        return null;
      }
      const parent: Element = current.parentElement;
      const outer = parent.getBoundingClientRect();
      if (Math.abs(outer.top - own.top) > 1 || Math.abs(outer.left - own.left) > 1) return null;
      current = parent;
    }
    return null;
  };

  const surveyed: SurveyScreen[] = screens.map((el) => {
    const cs = css(el);
    const label = findLabel(el);
    // A device mock around an iframe: offer the page inside it.
    const frames = (el.tagName.toLowerCase() === 'iframe' ? [el] : Array.from(el.querySelectorAll('iframe')))
      .filter((frame) => {
        const r = frame.getBoundingClientRect();
        return r.width >= 200 && r.height >= 200 && !!innerDocument(frame);
      })
      .sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return rb.width * rb.height - ra.width * ra.height;
      });
    const device = frames[0];
    const base = `${location.origin}/${location.pathname.split('/')[1] ?? ''}/`;
    const src = device ? (device as HTMLIFrameElement).src : '';
    const innerPage = src.startsWith(base) ? decodeURIComponent(src.slice(base.length)) : undefined;
    const row = findCaptioned(label ? label.owner : el, 6, { stepOverScreens: false });

    let rowIndex: number | undefined;
    if (row) {
      rowIndex = rowElements.indexOf(row.container);
      if (rowIndex < 0) {
        rowIndex = rowElements.push(row.container) - 1;
        rows.push({ caption: textPieces(row.caption), box: docRect(row.container) });
      }
    }

    return {
      selector: cssPath(el),
      box: docRect(el),
      label: label?.text,
      inner: device ? `${cssPath(device)} >>> body` : undefined,
      innerPage,
      row: rowIndex,
      text: collapse((el as HTMLElement).innerText ?? el.textContent ?? '').slice(0, 120),
      background: srgb(cs.backgroundColor),
      elements: el.querySelectorAll('*').length,
    };
  });

  rowElements.forEach((container, index) => {
    // A row inside a known section belongs to it; otherwise look for a heading.
    for (let ancestor = container.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
      const known = sectionElements.indexOf(ancestor);
      if (known >= 0) {
        rows[index].section = known;
        return;
      }
    }
    const section = findCaptioned(container, 4, { stepOverScreens: true, minFont: 20 });
    if (!section) return;
    let sectionIndex = sectionElements.indexOf(section.container);
    if (sectionIndex < 0) {
      sectionIndex = sectionElements.push(section.container) - 1;
      sections.push({ heading: textPieces(section.caption, 4), box: docRect(section.container) });
    }
    rows[index].section = sectionIndex;
  });

  // Clickables: the outermost element that shows a pointer, plus real controls.
  const clickables: SurveyClickable[] = [];
  const seen = new Set<string>();
  document.querySelectorAll('body *').forEach((el) => {
    if (clickables.length >= 150) return;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    const cs = css(el);
    const semantic = tag === 'button' || (tag === 'a' && el.hasAttribute('href')) || el.getAttribute('role') === 'button' || tag === 'select' || tag === 'summary';
    const pointer = cs.cursor === 'pointer' && (!el.parentElement || css(el.parentElement).cursor !== 'pointer');
    if (!semantic && !pointer) return;
    if (!isVisible(el)) return;
    const text = collapse((el as HTMLElement).innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').slice(0, 60);
    if (!text) return;
    const box = docRect(el);
    const key = `${text}|${Math.round(box[0] / 4)}|${Math.round(box[1] / 4)}`;
    if (seen.has(key)) return;
    seen.add(key);
    let fixed = false;
    for (let node: Element | null = el; node; node = node.parentElement) {
      const position = css(node).position;
      if (position === 'fixed' || position === 'sticky') {
        fixed = true;
        break;
      }
    }
    clickables.push({ text, selector: cssPath(el), box, fixed });
  });

  // Page heading: the biggest text in the top part of the document.
  let heading: string[] = [];
  let best = 0;
  document.querySelectorAll('body *').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.top + window.scrollY > 600 || !isVisible(el)) return;
    const own = Array.from(el.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && /\S/.test((node as Text).data));
    if (!own) return;
    const size = parseFloat(css(el).fontSize) || 0;
    if (size > best && !screens.some((screen) => screen.contains(el))) {
      best = size;
      heading = [collapse(el.textContent ?? '').slice(0, 160)];
      const next = el.nextElementSibling;
      if (next && collapse(next.textContent ?? '')) heading.push(collapse(next.textContent ?? '').slice(0, 300));
    }
  });

  const fonts = new Set<string>();
  if (document.fonts) document.fonts.forEach((face) => { if (face.status === 'loaded') fonts.add(face.family.replace(/["']/g, '')); });
  fonts.add(css(document.body).fontFamily.split(',')[0].replace(/["']/g, '').trim());

  return {
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    document: { width: docWidth, height: docHeight },
    background: srgb(css(document.body).backgroundColor),
    screens: surveyed,
    rows,
    sections,
    clickables,
    heading,
    fonts: [...fonts].filter(Boolean),
    elements: document.querySelectorAll('body *').length,
  };
}

/* ------------------------------------------------------------------ *
 * Interaction
 * ------------------------------------------------------------------ */

function norm(text: string): string {
  return collapse(text).toLowerCase().replace(/ё/g, 'е');
}

/** Where a document's viewport sits in the top viewport. */
function viewportOrigin(doc: Document): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let current: Document = doc;
  while (current !== document) {
    const frame = current.defaultView?.frameElement;
    if (!frame) break;
    const r = frame.getBoundingClientRect();
    const cs = css(frame);
    x += r.left + num(cs.borderLeftWidth) + num(cs.paddingLeft);
    y += r.top + num(cs.borderTopWidth) + num(cs.paddingTop);
    current = frame.ownerDocument;
  }
  return { x, y };
}

/**
 * Finds what a step names — `css:` selector (with `>>>` into iframes) or
 * visible text in any same-origin frame — scrolls it into view and returns a
 * top-viewport point that actually hits it.
 */
function locate(target: string): { x: number; y: number; text: string } | { error: string } {
  let el: Element | null = null;
  if (target.startsWith('css:')) {
    el = resolveTarget(target.slice(4))?.el ?? null;
    if (!el) return { error: `No element matches ${target.slice(4)}.` };
  } else {
    const wanted = norm(target.replace(/^text:/, ''));
    const candidates: { el: Element; area: number; rank: number }[] = [];
    for (const doc of allDocuments()) {
      doc.querySelectorAll('body *').forEach((node) => {
        if (SKIP_TAGS.has(node.tagName.toLowerCase()) || !isVisible(node)) return;
        const label = norm((node as HTMLElement).innerText || node.getAttribute('aria-label') || node.getAttribute('title') || '');
        if (!label) return;
        const rank = label === wanted ? 0 : label.startsWith(wanted) ? 1 : label.includes(wanted) ? 2 : -1;
        if (rank < 0) return;
        const cs = css(node);
        const interactive = cs.cursor === 'pointer' || /^(button|a|select|summary|label|input)$/i.test(node.tagName) || node.getAttribute('role') === 'button';
        const r = node.getBoundingClientRect();
        candidates.push({ el: node, area: r.width * r.height, rank: rank * 2 + (interactive ? 0 : 1) });
      });
    }
    candidates.sort((a, b) => a.rank - b.rank || a.area - b.area);
    el = candidates[0]?.el ?? null;
    if (!el) return { error: `Nothing on the page says "${target}".` };
  }
  const found: Element = el;
  found.scrollIntoView({ block: 'center', inline: 'center' });
  const r = found.getBoundingClientRect();
  const origin = viewportOrigin(found.ownerDocument);
  const text = collapse((found as HTMLElement).innerText ?? '').slice(0, 60);
  const points: [number, number][] = [
    [r.left + r.width / 2, r.top + r.height / 2],
    [r.left + Math.min(8, r.width / 2), r.top + r.height / 2],
    [r.right - Math.min(8, r.width / 2), r.top + r.height / 2],
  ];
  for (const [x, y] of points) {
    const hit: Element | null = found.ownerDocument.elementFromPoint(x, y);
    if (hit && (hit === found || found.contains(hit) || hit.contains(found))) return { x: x + origin.x, y: y + origin.y, text };
  }
  return { x: points[0][0] + origin.x, y: points[0][1] + origin.y, text };
}

function boxOf(selector: string): Box | null {
  const target = resolveTarget(selector);
  if (!target) return null;
  const saved = frameOffset;
  frameOffset = target.offset;
  try {
    return docRect(target.el);
  } finally {
    frameOffset = saved;
  }
}

/** Draws numbered outlines over surveyed screens for an overview screenshot. */
function annotate(boxes: Box[] | null): void {
  document.getElementById('ff-annotations')?.remove();
  if (!boxes) return;
  const layer = document.createElement('div');
  layer.id = 'ff-annotations';
  layer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
  // On <html>, absolute coordinates are document coordinates whatever <body> does.
  boxes.forEach(([x, y, w, h], index) => {
    const frame = document.createElement('div');
    frame.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;outline:4px solid #ff2d55;outline-offset:2px`;
    const tag = document.createElement('div');
    tag.textContent = `s${index + 1}`;
    tag.style.cssText = 'position:absolute;left:-6px;top:-6px;transform:translateY(-100%);background:#ff2d55;color:#fff;font:700 28px/1.2 -apple-system,Arial,sans-serif;padding:2px 10px;border-radius:6px';
    frame.appendChild(tag);
    layer.appendChild(frame);
  });
  document.documentElement.appendChild(layer);
}

(window as unknown as { __ff: unknown }).__ff = {
  prepare,
  settle,
  hiddenOverflow,
  expandFrames,
  collect,
  survey,
  asset,
  isolate,
  locate,
  boxOf,
  annotate,
};
