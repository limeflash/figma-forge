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
  /** Layers that matched nothing but looked like they should have. */
  considered: number;
}

const SIZE_TOLERANCE = 2;
const MAX_LAYERS = 80;
const MIN_SCORE = 90;

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

const fullName = (print: ComponentFingerprint) => (print.setName ? `${print.setName} / ${print.name}` : print.name);

function textsOf(layer: LayerIR, out: string[] = []): string[] {
  if (layer.type === 'TEXT') out.push(layer.characters);
  else if (layer.type === 'FRAME') for (const child of layer.children) textsOf(child, out);
  return out;
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

function tryMatch(layer: FrameIR, print: ComponentFingerprint, texts: string[]): Match | null {
  const dw = Math.abs(layer.width - print.width);
  const dh = Math.abs(layer.height - print.height);
  if (dw > SIZE_TOLERANCE || dh > SIZE_TOLERANCE) return null;
  if (texts.length !== print.texts.length) return null;

  const same = texts.every((text, index) => normalize(text) === normalize(print.texts[index].characters));
  // Different words are only allowed where the component offers a text
  // property or a named layer to put them in.
  const fillable = texts.every((text, index) => normalize(text) === normalize(print.texts[index].characters) || !!print.texts[index].property || !!print.texts[index].name);
  if (!same && !fillable) return null;

  const layerFill = fillKey(layer);
  const fillsAgree = layerFill === print.fill;
  if (layerFill && print.fill && !fillsAgree) return null;

  const layerRadius = radiusOf(layer);
  const radiusAgrees = layerRadius === null || print.radius === null || Math.abs(layerRadius - print.radius) <= 0.5;
  if (!radiusAgrees) return null;

  let score = 100 - dw * 4 - dh * 4;
  if (same) score += 40;
  if (fillsAgree && layerFill) score += 20;
  if (layerRadius !== null && print.radius !== null) score += 10;
  score += nameAffinity(layer, print);
  // A component with nothing in it says very little; a rich one says a lot.
  score += Math.min(print.texts.length * 6 + print.vectors * 4, 24);
  if (score < MIN_SCORE) return null;

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
export function matchComponents(root: FrameIR, catalogue: ComponentFingerprint[]): MatchStats {
  const stats: MatchStats = { instances: 0, used: {}, considered: 0 };
  if (!catalogue.length) return stats;

  // Components are looked up by rounded size, so a screen with a thousand
  // layers compares each one against a handful of candidates.
  const bySize = new Map<string, ComponentFingerprint[]>();
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
      const candidates = bySize.get(`${Math.round(frame.width)}x${Math.round(frame.height)}`) ?? [];
      if (candidates.length) {
        stats.considered++;
        const texts = textsOf(frame);
        let best: Match | null = null;
        for (const print of candidates) {
          const match = tryMatch(frame, print, texts);
          if (match && (!best || match.score > best.score)) best = match;
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
