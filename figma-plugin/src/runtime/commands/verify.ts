/**
 * Invariant checks.
 *
 * These run after every write and on demand. The rules encode what "using the
 * design system properly" actually means in a Figma file, because that is the
 * thing a language model gets wrong quietly: the screen looks right, and every
 * colour is a hardcoded hex that will not follow the next theme change.
 *
 * Severity is a policy decision, not a fact about the file, so each rule declares
 * its default and callers can raise or lower the gate.
 */

import { nodePath, safe, summarizePaints } from '../serialize';
import { DATA_KEYS } from '../journal';

type AnyNode = BaseNode & { children?: readonly SceneNode[] };

export type Severity = 'error' | 'warning' | 'info';

export interface Violation {
  rule: string;
  severity: Severity;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  path?: string;
  message: string;
  hint?: string;
}

export interface VerifyParams {
  scope?: 'node' | 'page' | 'selection' | 'operation';
  nodeId?: string;
  pageId?: string;
  /** Only report these rules. */
  rules?: string[];
  ignore?: string[];
  /** Lowest severity to report. Default "warning". */
  minSeverity?: Severity;
  maxNodes?: number;
  limit?: number;
  /** For scope "operation": only nodes tagged with this operation id. */
  operationId?: string;
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 3, warning: 2, info: 1 };

const RULES = [
  'hardcoded-fill',
  'hardcoded-stroke',
  'hardcoded-text-style',
  'unbound-spacing',
  'detached-instance',
  'missing-autolayout',
  'zero-size',
  'missing-font',
  'broken-style',
  'broken-variable',
  'invalid-component-property',
  'sibling-overlap',
  'off-canvas',
] as const;

async function collect(params: VerifyParams): Promise<{ nodes: AnyNode[]; root: AnyNode; truncated: number }> {
  const maxNodes = params.maxNodes ?? 3000;
  let root: AnyNode;

  switch (params.scope ?? 'selection') {
    case 'node': {
      if (!params.nodeId) throw new Error('scope "node" needs a `nodeId`.');
      const node = (await figma.getNodeByIdAsync(params.nodeId)) as AnyNode | null;
      if (!node) throw new Error(`Node ${params.nodeId} was not found.`);
      root = node;
      break;
    }
    case 'page': {
      const page = params.pageId ? ((await figma.getNodeByIdAsync(params.pageId)) as PageNode | null) : figma.currentPage;
      if (!page || page.type !== 'PAGE') throw new Error(`${params.pageId} is not a page.`);
      await page.loadAsync();
      root = page as unknown as AnyNode;
      break;
    }
    case 'operation': {
      await figma.loadAllPagesAsync();
      const tagged = figma.root.findAll((node) => {
        const value = safe(() => node.getPluginData(DATA_KEYS.operation));
        return !!value && (!params.operationId || value === params.operationId);
      }) as unknown as AnyNode[];
      return { nodes: tagged.slice(0, maxNodes), root: figma.root as unknown as AnyNode, truncated: Math.max(0, tagged.length - maxNodes) };
    }
    default: {
      const selection = figma.currentPage.selection;
      if (!selection.length) throw new Error('Nothing is selected — pass a `nodeId` or use scope "page".');
      const nodes: AnyNode[] = [];
      for (const node of selection) {
        nodes.push(node as AnyNode);
        if ('findAll' in node) nodes.push(...((node as FrameNode).findAll(() => true) as unknown as AnyNode[]));
      }
      return { nodes: nodes.slice(0, maxNodes), root: selection[0] as AnyNode, truncated: Math.max(0, nodes.length - maxNodes) };
    }
  }

  const all: AnyNode[] = [root];
  if ('findAll' in root) all.push(...((root as unknown as ChildrenMixin & { findAll: (fn: () => boolean) => SceneNode[] }).findAll(() => true) as unknown as AnyNode[]));
  return { nodes: all.slice(0, maxNodes), root, truncated: Math.max(0, all.length - maxNodes) };
}

/** True when the node has any variable bound to the given field family. */
function hasBinding(node: AnyNode, ...fields: string[]): boolean {
  const bound = safe(() => (node as unknown as { boundVariables?: Record<string, unknown> }).boundVariables);
  if (!bound) return false;
  return fields.some((field) => {
    const value = (bound as Record<string, unknown>)[field];
    return Array.isArray(value) ? value.length > 0 : !!value;
  });
}

function paintsAreBound(node: AnyNode, field: 'fills' | 'strokes'): boolean {
  const paints = safe(() => (node as unknown as Record<string, unknown>)[field]) as readonly Paint[] | undefined;
  if (!Array.isArray(paints)) return true;
  const visible = paints.filter((paint) => paint.visible !== false);
  if (!visible.length) return true;
  return visible.every((paint) => {
    if (paint.type !== 'SOLID') return true;
    const bound = (paint as { boundVariables?: { color?: VariableAlias } }).boundVariables;
    return !!(bound && bound.color);
  });
}

const AUTO_LAYOUT_SPACING = ['itemSpacing', 'counterAxisSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'];

const CONTAINER_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE']);

function overlapArea(a: SceneNode, b: SceneNode): number {
  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;
  const width = Math.min(ax2, bx2) - Math.max(a.x, b.x);
  const height = Math.min(ay2, by2) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

export interface VerifyResult {
  ok: boolean;
  scanned: number;
  truncated: number;
  violations: Violation[];
  summary: { byRule: Record<string, number>; bySeverity: Record<string, number> };
  rulesRun: string[];
}

export async function verify(params: VerifyParams): Promise<VerifyResult> {
  const { nodes, truncated } = await collect(params);
  const minSeverity = SEVERITY_ORDER[params.minSeverity ?? 'warning'];
  const only = params.rules && params.rules.length ? new Set(params.rules) : null;
  const ignore = new Set(params.ignore ?? []);
  const limit = params.limit ?? 300;
  const violations: Violation[] = [];

  const enabled = (rule: string) => (only ? only.has(rule) : true) && !ignore.has(rule);

  const push = (node: AnyNode, rule: string, severity: Severity, message: string, hint?: string) => {
    if (!enabled(rule)) return;
    if (SEVERITY_ORDER[severity] < minSeverity) return;
    if (violations.length >= limit) return;
    violations.push({
      rule,
      severity,
      nodeId: node.id,
      nodeName: node.name,
      nodeType: node.type,
      path: nodePath(node),
      message,
      hint,
    });
  };

  for (const node of nodes) {
    if (node.type === 'PAGE' || node.type === 'DOCUMENT') continue;
    const visible = safe(() => (node as SceneNode).visible);

    /* --- design-system binding ------------------------------------- */

    if (enabled('hardcoded-fill') && !safe(() => (node as unknown as Record<string, string>).fillStyleId)) {
      if (!paintsAreBound(node, 'fills') && !hasBinding(node, 'fills')) {
        const summary = summarizePaints(safe(() => (node as GeometryMixin).fills) as readonly Paint[]);
        const colors = Array.isArray(summary)
          ? summary.filter((paint) => paint.color).map((paint) => paint.color).join(', ')
          : '';
        if (colors) {
          push(
            node,
            'hardcoded-fill',
            'error',
            `Fill ${colors} is a raw colour with no variable or style behind it.`,
            'Bind a colour variable with `bind_paint_variable`, or apply a paint style with `apply_style`.'
          );
        }
      }
    }

    if (enabled('hardcoded-stroke') && !safe(() => (node as unknown as Record<string, string>).strokeStyleId)) {
      const strokes = safe(() => (node as GeometryMixin).strokes) as readonly Paint[] | undefined;
      if (Array.isArray(strokes) && strokes.length && !paintsAreBound(node, 'strokes')) {
        push(node, 'hardcoded-stroke', 'error', 'Stroke colour is not bound to a variable or style.');
      }
    }

    if (node.type === 'TEXT') {
      if (enabled('hardcoded-text-style') && !safe(() => (node as unknown as TextNode).textStyleId)) {
        push(
          node,
          'hardcoded-text-style',
          'warning',
          'Text has no text style applied; its type settings are local overrides.',
          'Apply a text style with `apply_style { kind: "text" }`.'
        );
      }
      if (enabled('missing-font') && safe(() => (node as unknown as TextNode).hasMissingFont)) {
        push(node, 'missing-font', 'error', 'Text uses a font that is not available in this file.');
      }
    }

    /* --- layout ----------------------------------------------------- */

    const layoutMode = safe(() => (node as unknown as BaseFrameMixin).layoutMode);
    if (layoutMode && layoutMode !== 'NONE') {
      if (enabled('unbound-spacing')) {
        const unbound = AUTO_LAYOUT_SPACING.filter((field) => {
          const value = safe(() => (node as unknown as Record<string, number>)[field]);
          return typeof value === 'number' && value > 0 && !hasBinding(node, field);
        });
        if (unbound.length) {
          push(
            node,
            'unbound-spacing',
            'warning',
            `Spacing is hardcoded: ${unbound.join(', ')}.`,
            'Bind a spacing variable with `bind_variable`.'
          );
        }
      }
    } else if (enabled('missing-autolayout') && CONTAINER_TYPES.has(node.type) && node.type !== 'INSTANCE') {
      const children = safe(() => (node as unknown as ChildrenMixin).children);
      if (Array.isArray(children) && children.filter((child) => child.visible !== false).length > 1) {
        push(
          node,
          'missing-autolayout',
          'warning',
          `${node.type} holds ${children.length} children but has no auto layout, so it will not reflow.`,
          'Set `layoutMode` to HORIZONTAL or VERTICAL.'
        );
      }
    }

    /* --- structure --------------------------------------------------- */

    if (node.type === 'INSTANCE' && enabled('detached-instance')) {
      try {
        const main = await (node as unknown as InstanceNode).getMainComponentAsync();
        if (!main) push(node, 'detached-instance', 'error', 'Instance has lost its main component.');
      } catch {
        push(node, 'detached-instance', 'warning', 'Instance main component could not be resolved.');
      }
    }

    if (node.type === 'INSTANCE' && enabled('invalid-component-property')) {
      const properties = safe(() => (node as unknown as InstanceNode).componentProperties);
      if (properties && typeof properties === 'object') {
        for (const name of Object.keys(properties as object)) {
          const entry = (properties as Record<string, { type: string; value: unknown; preferredValues?: unknown }>)[name];
          if (entry.type !== 'VARIANT') continue;
          if (entry.value === undefined || entry.value === null || entry.value === '') {
            push(node, 'invalid-component-property', 'error', `Variant property "${name}" has no value.`);
          }
        }
      }
    }

    if (enabled('zero-size')) {
      const width = safe(() => (node as unknown as { width: number }).width);
      const height = safe(() => (node as unknown as { height: number }).height);
      if (typeof width === 'number' && typeof height === 'number' && visible !== false && (width < 1 || height < 1)) {
        push(node, 'zero-size', 'error', `Node is ${Math.round(width)}×${Math.round(height)} and effectively invisible.`);
      }
    }

    if (enabled('broken-style')) {
      for (const field of ['fillStyleId', 'strokeStyleId', 'textStyleId', 'effectStyleId']) {
        const id = safe(() => (node as unknown as Record<string, string>)[field]);
        if (!id || typeof id !== 'string' || id === 'MIXED') continue;
        const style = await figma.getStyleByIdAsync(id).catch(() => null);
        if (!style) push(node, 'broken-style', 'error', `${field} points at a style that no longer resolves.`);
      }
    }

    if (enabled('broken-variable')) {
      const bound = safe(() => (node as unknown as { boundVariables?: Record<string, unknown> }).boundVariables);
      if (bound) {
        for (const field of Object.keys(bound)) {
          const value = (bound as Record<string, unknown>)[field];
          const aliases = Array.isArray(value) ? (value as VariableAlias[]) : [value as VariableAlias];
          for (const alias of aliases) {
            if (!alias || !alias.id) continue;
            const variable = await figma.variables.getVariableByIdAsync(alias.id).catch(() => null);
            if (!variable) {
              push(node, 'broken-variable', 'error', `Bound variable on "${field}" no longer resolves (${alias.id}).`);
            }
          }
        }
      }
    }

    /* --- geometry ----------------------------------------------------- */

    if (enabled('sibling-overlap') && (!layoutMode || layoutMode === 'NONE')) {
      const children = safe(() => (node as unknown as ChildrenMixin).children) as SceneNode[] | undefined;
      if (Array.isArray(children) && children.length > 1 && children.length < 60) {
        const laid = children.filter(
          (child) => child.visible !== false && safe(() => (child as unknown as { layoutPositioning?: string }).layoutPositioning) !== 'ABSOLUTE'
        );
        outer: for (let i = 0; i < laid.length; i++) {
          for (let j = i + 1; j < laid.length; j++) {
            const area = overlapArea(laid[i], laid[j]);
            const smallest = Math.min(laid[i].width * laid[i].height, laid[j].width * laid[j].height);
            if (smallest > 0 && area / smallest > 0.6) {
              push(
                node,
                'sibling-overlap',
                'warning',
                `"${laid[i].name}" and "${laid[j].name}" overlap by ${Math.round((area / smallest) * 100)}%.`,
                'If this is intentional (an overlay or badge), set `layoutPositioning: "ABSOLUTE"`.'
              );
              break outer;
            }
          }
        }
      }
    }

    if (enabled('off-canvas')) {
      const parent = (node as SceneNode).parent as (BaseNode & { width: number; height: number }) | null;
      if (parent && parent.type !== 'PAGE' && 'width' in parent) {
        const x = safe(() => (node as unknown as { x: number }).x);
        const y = safe(() => (node as unknown as { y: number }).y);
        const width = safe(() => (node as unknown as { width: number }).width) ?? 0;
        const height = safe(() => (node as unknown as { height: number }).height) ?? 0;
        if (typeof x === 'number' && typeof y === 'number') {
          const fullyOut = x + width < 0 || y + height < 0 || x > parent.width || y > parent.height;
          if (fullyOut) {
            push(node, 'off-canvas', 'warning', `Node sits entirely outside its parent "${parent.name}".`);
          }
        }
      }
    }
  }

  const byRule: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  for (const violation of violations) {
    byRule[violation.rule] = (byRule[violation.rule] ?? 0) + 1;
    bySeverity[violation.severity] = (bySeverity[violation.severity] ?? 0) + 1;
  }

  return {
    ok: (bySeverity.error ?? 0) === 0,
    scanned: nodes.length,
    truncated,
    violations,
    summary: { byRule, bySeverity },
    rulesRun: RULES.filter(enabled),
  };
}
