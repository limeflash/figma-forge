/**
 * Renders a write plan as HTML.
 *
 * The plan is the single source of truth: it renders here for review and, once
 * approved, applies to Figma unchanged. The HTML is never parsed back. That is
 * the whole point — every HTML-to-Figma converter produces detached rectangles
 * where components should be, which is exactly what this plugin exists to stop.
 *
 * So the preview is deliberately part photograph, part diagram. Anything the
 * plan reuses (a component to instantiate, a node to clone) is drawn as its real
 * exported pixels. Only the containers Claude is inventing are drawn as CSS
 * boxes, because those are the only parts that do not exist yet.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface PlanOp {
  op: string;
  [key: string]: unknown;
}

export interface ThumbnailAsset {
  file: string;
  name: string;
  naturalWidth: number;
  naturalHeight: number;
}

export interface VariableValue {
  name: string;
  type: string;
  value: unknown;
  modeName?: string;
}

interface TreeNode {
  ref: string;
  op: PlanOp;
  children: TreeNode[];
  style: Record<string, unknown>;
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string
  );

function rgbaToCss(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const color = value as { r?: number; g?: number; b?: number; a?: number };
  if (typeof color.r !== 'number') return null;
  const channel = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 255);
  const alpha = color.a === undefined ? 1 : color.a;
  return `rgba(${channel(color.r)}, ${channel(color.g!)}, ${channel(color.b!)}, ${Math.round(alpha * 100) / 100})`;
}

const ALIGN: Record<string, string> = {
  MIN: 'flex-start',
  CENTER: 'center',
  MAX: 'flex-end',
  SPACE_BETWEEN: 'space-between',
  BASELINE: 'baseline',
};

/** Figma auto-layout maps almost one-to-one onto flexbox; this is that mapping. */
function cssFor(set: Record<string, unknown>, autoLayout?: string): string[] {
  const rules: string[] = [];
  const mode = (set.layoutMode as string) ?? autoLayout;

  if (mode === 'VERTICAL' || mode === 'HORIZONTAL') {
    rules.push('display: flex', `flex-direction: ${mode === 'VERTICAL' ? 'column' : 'row'}`);
    if (set.layoutWrap === 'WRAP') rules.push('flex-wrap: wrap');
    if (typeof set.itemSpacing === 'number') rules.push(`gap: ${set.itemSpacing}px`);
    if (typeof set.counterAxisSpacing === 'number' && set.layoutWrap === 'WRAP') {
      rules.push(`row-gap: ${set.counterAxisSpacing}px`);
    }
    if (typeof set.primaryAxisAlignItems === 'string') {
      rules.push(`justify-content: ${ALIGN[set.primaryAxisAlignItems] ?? 'flex-start'}`);
    }
    if (typeof set.counterAxisAlignItems === 'string') {
      rules.push(`align-items: ${ALIGN[set.counterAxisAlignItems] ?? 'stretch'}`);
    }
  }

  for (const [key, side] of [
    ['paddingTop', 'top'],
    ['paddingRight', 'right'],
    ['paddingBottom', 'bottom'],
    ['paddingLeft', 'left'],
  ] as const) {
    if (typeof set[key] === 'number') rules.push(`padding-${side}: ${set[key]}px`);
  }

  if (typeof set.width === 'number') rules.push(`width: ${set.width}px`);
  if (typeof set.height === 'number') rules.push(`height: ${set.height}px`);
  if (typeof set.cornerRadius === 'number') rules.push(`border-radius: ${set.cornerRadius}px`);
  if (set.clipsContent === true) rules.push('overflow: hidden');
  if (set.layoutSizingHorizontal === 'FILL') rules.push('align-self: stretch', 'width: auto');

  const fills = set.fills;
  if (Array.isArray(fills) && fills.length) {
    const solid = fills.find((paint) => (paint as { type?: string }).type === 'SOLID');
    const css = solid ? rgbaToCss((solid as { color?: unknown }).color) : null;
    if (css) rules.push(`background: ${css}`);
  } else if (Array.isArray(fills)) {
    rules.push('background: transparent');
  }

  return rules;
}

export interface RenderInput {
  title: string;
  ops: PlanOp[];
  thumbnails: Record<string, ThumbnailAsset>;
  variables: Record<string, VariableValue>;
  outDir: string;
  /** Notes shown alongside the preview: off-ramps, unresolved pieces. */
  notes?: string[];
}

/** Builds the parent/child tree the ops describe, plus applies non-creating ops. */
function buildTree(ops: PlanOp[]): { roots: TreeNode[]; unattached: PlanOp[] } {
  const byRef = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  const unattached: PlanOp[] = [];

  const CREATES = new Set(['create_frame', 'create_instance', 'create_text', 'create_from_svg', 'clone']);

  for (const op of ops) {
    if (CREATES.has(op.op)) {
      const ref = (op.ref as string) ?? `anon${byRef.size}`;
      const node: TreeNode = { ref, op, children: [], style: (op.set as Record<string, unknown>) ?? {} };
      byRef.set(ref, node);

      const parent = op.parent as string | undefined;
      const parentNode = parent && parent.startsWith('$') ? byRef.get(parent.slice(1)) : undefined;
      if (parentNode) parentNode.children.push(node);
      else roots.push(node);
      continue;
    }

    // Ops that decorate an existing node fold into its style.
    const target = op.node as string | undefined;
    const node = target && target.startsWith('$') ? byRef.get(target.slice(1)) : undefined;
    if (!node) {
      unattached.push(op);
      continue;
    }
    if (op.op === 'set' && op.props) Object.assign(node.style, op.props as Record<string, unknown>);
    else if (op.op === 'bind_paint_variable') node.style.__variableFill = op.variableId;
    else if (op.op === 'set_text') node.style.__pendingText = op.characters;
    else unattached.push(op);
  }

  return { roots, unattached };
}

function renderNode(node: TreeNode, input: RenderInput, depth: number): string {
  const pad = '  '.repeat(depth + 3);
  const op = node.op;
  const style = { ...node.style };

  // A variable-bound fill should show the colour it will actually get.
  const variableId = style.__variableFill as string | undefined;
  if (variableId) {
    const variable = input.variables[variableId];
    const css = variable ? rgbaToCss(variable.value) : null;
    if (css) style.fills = [{ type: 'SOLID', color: variable!.value }];
    delete style.__variableFill;
    if (css) style.__resolved = css;
  }

  const rules = cssFor(style, op.autoLayout as string | undefined);
  if (style.__resolved) rules.push(`background: ${style.__resolved as string}`);

  const label = (op.name as string) ?? node.ref;

  if (op.op === 'create_instance' || op.op === 'clone') {
    const requested = (op.componentKey ?? op.componentId ?? op.node) as string;
    const asset = input.thumbnails[requested];
    if (asset) {
      const width = style.layoutSizingHorizontal === 'FILL' ? 'width:100%;align-self:stretch' : `width:${asset.naturalWidth}px`;
      const image =
        `<img class="asset" src="${escapeHtml(asset.file)}" alt="${escapeHtml(asset.name)}" ` +
        `title="${escapeHtml(`${op.op}: ${asset.name}`)}" style="${width};height:auto" />`;

      // An exported image cannot show text the plan is about to change, so the
      // new copy is captioned rather than silently misrepresented.
      const pending = style.__pendingText as string | undefined;
      if (pending) {
        return (
          `${pad}<div class="pending" style="${width}">${image}` +
          `<span>→ «${escapeHtml(pending)}»</span></div>`
        );
      }
      return `${pad}${image}`;
    }
    return (
      `${pad}<div class="missing" title="no thumbnail for ${escapeHtml(String(requested))}">` +
      `${escapeHtml(label)}<small>${escapeHtml(String(requested))}</small></div>`
    );
  }

  if (op.op === 'create_text') {
    return `${pad}<div class="text" style="${rules.join(';')}">${escapeHtml(String(op.characters ?? ''))}</div>`;
  }

  const children = node.children.map((child) => renderNode(child, input, depth + 1)).join('\n');
  const invented = op.op === 'create_frame' ? ' invented' : '';
  const reason = op.reason ? ` data-reason="${escapeHtml(String(op.reason))}"` : '';
  return (
    `${pad}<div class="frame${invented}" style="${rules.join(';')}" data-name="${escapeHtml(label)}"${reason}>\n` +
    `${children}\n${pad}</div>`
  );
}

export async function renderPlan(input: RenderInput): Promise<{ file: string; roots: number; missing: string[] }> {
  await mkdir(input.outDir, { recursive: true });
  const { roots, unattached } = buildTree(input.ops);

  const missing: string[] = [];
  for (const op of input.ops) {
    if (op.op !== 'create_instance' && op.op !== 'clone') continue;
    const requested = (op.componentKey ?? op.componentId ?? op.node) as string;
    if (requested && !input.thumbnails[requested]) missing.push(requested);
  }

  const body = roots.map((root) => renderNode(root, input, 0)).join('\n');
  const notes = [...(input.notes ?? [])];
  if (unattached.length) {
    notes.push(
      `${unattached.length} operation(s) are not shown: ${unattached.map((op) => op.op).join(', ')}. ` +
        'They target existing Figma nodes rather than anything this plan creates.'
    );
  }
  if (missing.length) notes.push(`No thumbnail for: ${[...new Set(missing)].join(', ')}.`);

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(input.title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px; background: #8b8b9e;
    font: 13px/1.5 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #1e1e1e;
  }
  header { max-width: 900px; margin: 0 auto 24px; color: #fff; }
  header h1 { font-size: 18px; margin: 0 0 4px; font-weight: 600; }
  header p { margin: 0; opacity: 0.75; font-size: 12px; }
  .stage { display: flex; gap: 40px; align-items: flex-start; justify-content: center; flex-wrap: wrap; }
  .frame { position: relative; }
  /* Dashed = invented by this plan; everything solid is a real exported node. */
  .frame.invented { outline: 1px dashed rgba(255,255,255,0.35); outline-offset: -1px; }
  .frame.invented:hover { outline-color: #0d99ff; }
  .asset { display: block; }
  .text { white-space: pre-wrap; }
  .missing {
    display: flex; flex-direction: column; gap: 2px; padding: 12px 16px; border-radius: 8px;
    background: repeating-linear-gradient(45deg, #ffd9d9, #ffd9d9 6px, #ffc9c9 6px, #ffc9c9 12px);
    color: #8a1f1f; font-weight: 600;
  }
  .missing small { font-weight: 400; opacity: 0.7; font-size: 10px; }
  .pending { position: relative; display: block; }
  .pending span {
    position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
    background: #0d99ff; color: #fff; font-size: 11px; font-weight: 600;
    padding: 3px 8px; border-radius: 6px; white-space: nowrap; pointer-events: none;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  }
  .notes {
    max-width: 900px; margin: 28px auto 0; padding: 14px 18px; border-radius: 10px;
    background: rgba(0,0,0,0.25); color: #fff; font-size: 12px;
  }
  .notes li { margin: 4px 0; }
  .legend { max-width: 900px; margin: 16px auto 0; color: #fff; opacity: 0.7; font-size: 11px; }
</style>
</head>
<body>
  <header>
    <h1>${escapeHtml(input.title)}</h1>
    <p>Превью плана. Сплошные блоки — реальные компоненты и клоны из файла; пунктир — контейнеры, которые план создаёт.</p>
  </header>
  <div class="stage">
${body}
  </div>
  ${notes.length ? `<div class="notes"><ul>${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul></div>` : ''}
  <div class="legend">Наведите на пунктирный блок — во всплывающей подсказке причина, по которой план создаёт примитив.</div>
</body>
</html>`;

  const file = join(input.outDir, 'preview.html');
  await writeFile(file, html, 'utf8');
  return { file, roots: roots.length, missing: [...new Set(missing)] };
}
