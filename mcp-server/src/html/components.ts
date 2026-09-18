/**
 * Builds screens out of the components the file already has.
 *
 * A converted screen is a tree of plain frames. Where one of those frames is
 * the same thing the design system already draws — a button, a chip, an input,
 * an icon — the import should place that component instead, so the screen is
 * made of the designer's parts rather than a copy of them.
 *
 * Matching is deliberately strict: a wrong instance is worse than a frame,
 * because it looks right and behaves differently. A frame has to agree with a
 * component on size, on the words it shows, and on its fill before it is
 * replaced; anything that only nearly agrees stays a frame.
 */

import type { FrameIR, InstanceIR, LayerIR } from '../../../shared/html-import.js';

/** What the plugin reports for every component in the file. */
export interface ComponentFingerprint {
  id: string;
  name: string;
  setName?: string;
  variant?: Record<string, string>;
  width: number;
  height: number;
  radius: number | null;
  fill: string | null;
  texts: { name: string; characters: string; property?: string }[];
  properties: { name: string; type: string; options?: string[] }[];
  layers: number;
  vectors: number;
}

export interface MatchStats {
  /** How many layers became instances. */
  instances: number;
  /** Component name → how often it was used. */
  used: Record<string, number>;
  /** Layers that had a candidate of the right shape. */
  considered: number;
  /** The closest thing to a match that was turned down, and why. */
  nearMisses: string[];
}

const SIZE_TOLERANCE = 2;
const MAX_LAYERS = 150;
const MIN_SCORE = 90;
/** Rounding and hand-drawn corners differ by a pixel; intent does not. */
const RADIUS_TOLERANCE = 2;
/** Two shades this close are the same colour with a different rounding. */
const COLOUR_TOLERANCE = 10;

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

const fullName = (print: ComponentFingerprint) => (print.setName ? `${print.setName} / ${print.name}` : print.name);

function textsOf(layer: LayerIR, out: string[] = []): string[] {
  if (layer.type === 'TEXT') out.push(layer.characters);
  else if (layer.type === 'FRAME') for (const child of layer.children) textsOf(child, out);
  return out;
}

/** Counts the pictures and the drawings inside a layer. */
function contentOf(layer: LayerIR, count = { images: 0, vectors: 0 }): { images: number; vectors: number } {
  if (layer.type === 'IMAGE') count.images++;
  else if (layer.type === 'SVG') count.vectors++;
  else if (layer.type === 'FRAME') {
    if (layer.fills?.some((paint) => paint.type === 'IMAGE')) count.images++;
    for (const child of layer.children) contentOf(child, count);
  }
  return count;
}

function sizeOf(layer: LayerIR): number {
  if (layer.type !== 'FRAME') return 1;
  let count = 1;
  for (const child of layer.children) count += sizeOf(child);
  return count;
}

function fillKey(layer: FrameIR): string | null {
  const paint = layer.fills?.find((candidate) => candidate.type === 'SOLID');
  if (!paint || paint.type !== 'SOLID') return null;
  const channel = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 255);
  return `${channel(paint.color.r)},${channel(paint.color.g)},${channel(paint.color.b)},${Math.round((paint.color.a ?? 1) * 100)}`;
}

/** How far apart two `r,g,b,a` keys are, on their widest channel. */
function colourDistance(left: string, right: string): number {
  const a = left.split(',').map(Number);
  const b = right.split(',').map(Number);
  if (a.length !== 4 || b.length !== 4) return 255;
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]), Math.abs(a[3] - b[3]) * 2.55);
}

/** A pill is a pill whether its radius is 15, 16 or 999. */
function radiiAgree(layer: number | null, component: number | null, width: number, height: number): boolean {
  if (layer === null || component === null) return true;
  const pill = Math.min(width, height) / 2 - 1;
  if (layer >= pill && component >= pill) return true;
  return Math.abs(layer - component) <= RADIUS_TOLERANCE;
}

function radiusOf(layer: FrameIR): number | null {
  if (layer.radius === undefined) return null;
  return typeof layer.radius === 'number' ? layer.radius : layer.radius[0];
}

/** How much the layer's name and the component's name have in common. */
function nameAffinity(layer: FrameIR, print: ComponentFingerprint): number {
  const left = normalize(layer.name).replace(/[^a-zа-я0-9]+/gi, '');
  if (!left || left === 'frame' || left === 'row' || left === 'stack') return 0;
  const right = normalize(fullName(print)).replace(/[^a-zа-я0-9]+/gi, '');
  if (!right) return 0;
  if (left === right) return 15;
  return right.includes(left) || left.includes(right) ? 8 : 0;
}

interface Match {
  print: ComponentFingerprint;
  score: number;
  instance: InstanceIR;
}

function tryMatch(layer: FrameIR, print: ComponentFingerprint, texts: string[], why?: (note: string) => void): Match | null {
  if (texts.length !== print.texts.length) {
    why?.(`${fullName(print)}: ${texts.length} текстов против ${print.texts.length}`);
    return null;
  }

  const same = texts.length > 0 && texts.every((text, index) => normalize(text) === normalize(print.texts[index].characters));
  // The same words in a box of nearly the same size are the same part: a
  // design system component and the page built from it rarely agree on the
  // last pixel, and a button that grew with its label is still that button.
  const dw = Math.abs(layer.width - print.width);
  const dh = Math.abs(layer.height - print.height);
  // A block with several slots filled in — a ticket row, an order summary —
  // is recognisable by its shape even when every word in it differs, so it is
  // allowed to have grown or shrunk with its content.
  const structural = texts.length >= 3;
  const limitW = same || structural ? Math.max(SIZE_TOLERANCE, print.width * 0.12) : SIZE_TOLERANCE;
  const limitH = same ? Math.max(SIZE_TOLERANCE, print.height * 0.12) : structural ? 4 : SIZE_TOLERANCE;
  if (dw > limitW || dh > limitH) {
    if (same || structural) why?.(`${fullName(print)}: размер ${Math.round(layer.width)}×${Math.round(layer.height)} против ${Math.round(print.width)}×${Math.round(print.height)}`);
    return null;
  }
  // Two things of the same size can still be built very differently.
  const depth = sizeOf(layer);
  if (depth > print.layers * 3 + 6 || print.layers > depth * 3 + 6) {
    why?.(`${fullName(print)}: ${depth} слоёв против ${print.layers}`);
    return null;
  }
  // Different words are only allowed where the component offers a text
  // property or a named layer to put them in.
  const fillable = texts.every((text, index) => normalize(text) === normalize(print.texts[index].characters) || !!print.texts[index].property || !!print.texts[index].name);
  if (!same && !fillable) return null;

  const content = contentOf(layer);
  // A photo is content, not a part: an instance would bring the component's
  // own picture and quietly replace what the page showed.
  if (content.images > 0) {
    why?.(`${fullName(print)}: внутри картинка из макета`);
    return null;
  }
  // An icon-only component says almost nothing about itself — every round
  // 40×40 button looks like every other one — so it is only used when the
  // layer is named after it.
  if (print.texts.length === 0 && nameAffinity(layer, print) === 0) {
    why?.(`${fullName(print)}: только иконка, а имена не сходятся`);
    return null;
  }
  // A button with an icon and the same button without it are not the same.
  if (Math.abs(content.vectors - print.vectors) > 1) {
    why?.(`${fullName(print)}: ${content.vectors} иконок против ${print.vectors}`);
    return null;
  }

  const layerFill = fillKey(layer);
  // A filled box and an unfilled one are different things — that is what keeps
  // a round button from becoming an icon of the same size.
  if (!layerFill !== !print.fill) {
    why?.(`${fullName(print)}: ${layerFill ? 'залит, а компонент нет' : 'без заливки, а компонент залит'}`);
    return null;
  }
  const distance = layerFill && print.fill ? colourDistance(layerFill, print.fill) : 0;
  const fillsAgree = layerFill === print.fill;
  if (layerFill && print.fill && distance > COLOUR_TOLERANCE) {
    why?.(`${fullName(print)}: заливка ${layerFill} против ${print.fill}`);
    return null;
  }

  const layerRadius = radiusOf(layer);
  const radiusAgrees = radiiAgree(layerRadius, print.radius, layer.width, layer.height);
  if (!radiusAgrees) {
    why?.(`${fullName(print)}: радиус ${layerRadius} против ${print.radius}`);
    return null;
  }

  let score = 100 - dw * 4 - dh * 4 - distance;
  if (same) score += 40;
  if (fillsAgree && layerFill) score += 20;
  if (layerRadius !== null && print.radius !== null) score += 10;
  score += nameAffinity(layer, print);
  // A component with nothing in it says very little; a rich one says a lot.
  score += Math.min(print.texts.length * 6 + print.vectors * 4, 24);
  if (score < MIN_SCORE) {
    why?.(`${fullName(print)}: счёт ${Math.round(score)} ниже порога`);
    return null;
  }

  const properties: Record<string, string | boolean> = {};
  const text: Record<string, string> = {};
  if (!same) {
    texts.forEach((value, index) => {
      const slot = print.texts[index];
      if (normalize(value) === normalize(slot.characters)) return;
      if (slot.property) properties[slot.property] = value;
      else text[slot.name] = value;
    });
  }

  return {
    print,
    score,
    instance: {
      componentId: print.id,
      componentName: fullName(print),
      properties: Object.keys(properties).length ? properties : undefined,
      text: Object.keys(text).length ? text : undefined,
    },
  };
}

/**
 * Marks every layer that a component can stand for. The search runs top down
 * and stops at the first layer that matches: a card built from chips should
 * come in as the card, not as its pieces.
 */
export function matchComponents(root: FrameIR, catalogue: ComponentFingerprint[], debug?: (line: string) => void): MatchStats {
  const seenMiss = new Set<string>();
  const stats: MatchStats = { instances: 0, used: {}, considered: 0, nearMisses: [] };
  if (!catalogue.length) return stats;

  // Components are looked up by rounded size, so a screen with a thousand
  // layers compares each one against a handful of candidates.
  const bySize = new Map<string, ComponentFingerprint[]>();
  // Words are the surer signal — a size can drift, a label rarely does.
  const byText = new Map<string, ComponentFingerprint[]>();
  const textKey = (values: string[]) => values.map(normalize).join('|');
  // A block keeps its shape even when every word in it changes: as many text
  // slots, about as wide.
  const byShape = new Map<string, ComponentFingerprint[]>();
  const shapeKeys = (slots: number, width: number) => {
    const bucket = Math.round(width / 50);
    return [`${slots}:${bucket - 1}`, `${slots}:${bucket}`, `${slots}:${bucket + 1}`];
  };
  for (const print of catalogue) {
    const key = textKey(print.texts.map((text) => text.characters));
    if (key.replace(/\|/g, '').length >= 6) {
      const list = byText.get(key) ?? [];
      list.push(print);
      byText.set(key, list);
    }
    if (print.texts.length >= 3) {
      for (const shape of shapeKeys(print.texts.length, print.width)) {
        const list = byShape.get(shape) ?? [];
        list.push(print);
        byShape.set(shape, list);
      }
    }
  }
  for (const print of catalogue) {
    for (let dx = -SIZE_TOLERANCE; dx <= SIZE_TOLERANCE; dx++) {
      for (let dy = -SIZE_TOLERANCE; dy <= SIZE_TOLERANCE; dy++) {
        const key = `${Math.round(print.width + dx)}x${Math.round(print.height + dy)}`;
        const list = bySize.get(key) ?? [];
        if (!list.includes(print)) list.push(print);
        bySize.set(key, list);
      }
    }
  }

  const visit = (layer: LayerIR, depth: number): void => {
    if (layer.type !== 'FRAME') return;
    const frame = layer as FrameIR;
    // The screen itself is not a component, and neither is a page-sized block.
    if (depth > 0 && sizeOf(frame) <= MAX_LAYERS) {
      const texts = textsOf(frame);
      const candidates = [
        ...new Set([
          ...(bySize.get(`${Math.round(frame.width)}x${Math.round(frame.height)}`) ?? []),
          ...(byText.get(textKey(texts)) ?? []),
          ...(texts.length >= 3 ? byShape.get(`${texts.length}:${Math.round(frame.width / 50)}`) ?? [] : []),
        ]),
      ];
      if (candidates.length) {
        stats.considered++;
        let best: Match | null = null;
        const notes: string[] = [];
        for (const print of candidates) {
          const match = tryMatch(frame, print, texts, (note) => notes.push(note));
          if (match && (!best || match.score > best.score)) best = match;
        }
        if (!best && notes.length) {
          const line = `${frame.name} ${Math.round(frame.width)}×${Math.round(frame.height)}${texts.length ? ` «${texts[0].slice(0, 28)}»` : ''} → ${notes[0]}`;
          debug?.(`${frame.name} ${Math.round(frame.width)}×${Math.round(frame.height)} «${texts.slice(0, 2).join(' / ').slice(0, 40)}» → ${notes.slice(0, 3).join('; ')}`);
          if (!seenMiss.has(notes[0]) && stats.nearMisses.length < 12) {
            seenMiss.add(notes[0]);
            stats.nearMisses.push(line);
          }
        }
        if (best) {
          frame.instance = best.instance;
          stats.instances++;
          stats.used[best.instance.componentName] = (stats.used[best.instance.componentName] ?? 0) + 1;
          // Its children stay in the IR as a fallback, but nothing inside it
          // is matched again.
          return;
        }
      }
    }
    for (const child of frame.children) visit(child, depth + 1);
  };

  visit(root, 0);
  return stats;
}
