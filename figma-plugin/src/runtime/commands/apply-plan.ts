/**
 * Typed write lane.
 *
 * A plan is a list of ops with explicit node references, applied in order under
 * a journal. Three properties matter more than the op vocabulary itself:
 *
 *   - Ops name their targets by id or by a `$ref` produced earlier in the same
 *     plan, so a plan is reproducible and reviewable before it runs.
 *   - Every mutation journals its inverse first, so a failure halfway through
 *     can be walked back instead of leaving a half-built screen.
 *   - Creating a raw primitive where a design-system component could serve is an
 *     off-ramp, and an off-ramp needs a written reason. Silence is rejected.
 *
 * `dryRun` runs the whole validation pass — reference resolution, component
 * imports, property legality — without mutating anything.
 */

import { applyProps } from '../shims';
import { summarizeNode, safe } from '../serialize';
import {
  Journal,
  JournalEntry,
  RecoveryResult,
  SCRATCH_PAGE,
  ensurePage,
  errorMessage,
  loadFontsFor,
  quarantine,
  rollback,
} from '../journal';

type AnyNode = BaseNode & { children?: readonly SceneNode[] };

export interface PlanOp {
  op: string;
  [key: string]: unknown;
}

export interface Plan {
  operationId?: string;
  description?: string;
  ops: PlanOp[];
  dryRun?: boolean;
  /** Build under the Figma Forge scratch page instead of the live target. */
  scratch?: boolean;
  /** Roll the journal back when an op throws. Default true. */
  rollbackOnError?: boolean;
  /** Skip the "raw primitives need a reason" gate. Default false. */
  allowRawPrimitives?: boolean;
  /** Fingerprint the caller expects the document to still have. */
  expectedRevision?: string;
}

export interface OpResult {
  index: number;
  op: string;
  status: 'applied' | 'validated' | 'failed' | 'skipped';
  nodeId?: string;
  ref?: string;
  detail?: unknown;
  error?: string;
}

export interface PlanResult {
  operationId: string;
  dryRun: boolean;
  ok: boolean;
  applied: number;
  results: OpResult[];
  created: string[];
  modified: string[];
  quarantined: string[];
  offRamps: { index: number; op: string; reason: string }[];
  journal: JournalEntry[];
  scratchPageId?: string;
  rolledBack?: RecoveryResult;
  error?: string;
}

/** Ops that make a primitive where a component might have done the job. */
const RAW_PRIMITIVE_OPS = new Set(['create_frame', 'create_text', 'create_rectangle', 'create_ellipse', 'create_from_svg']);

class PlanScope {
  private readonly refs = new Map<string, AnyNode>();
  private readonly scratch: PageNode | null;

  constructor(scratch: PageNode | null) {
    this.scratch = scratch;
  }

  bind(ref: string | undefined, node: AnyNode): void {
    if (ref) this.refs.set(ref.replace(/^\$/, ''), node);
  }

  /**
   * `$ref` names an earlier op's output; `@selection` and `@page` name live
   * editor state; anything else is a node id.
   */
  async resolve(reference: unknown, what: string): Promise<AnyNode> {
    if (typeof reference !== 'string' || !reference) {
      throw new Error(`${what} is required and must be a node id, "$ref", "@selection" or "@page".`);
    }
    if (reference.charAt(0) === '$') {
      const node = this.refs.get(reference.slice(1));
      if (!node) throw new Error(`${what} refers to "${reference}", which no earlier op defined.`);
      return node;
    }
    if (reference === '@page') return figma.currentPage as unknown as AnyNode;
    if (reference === '@scratch') {
      if (!this.scratch) throw new Error('"@scratch" needs the plan to set `scratch: true`.');
      return this.scratch as unknown as AnyNode;
    }
    if (reference === '@selection') {
      const selection = figma.currentPage.selection;
      if (selection.length !== 1) {
        throw new Error(`"@selection" needs exactly one selected node; ${selection.length} are selected.`);
      }
      return selection[0] as AnyNode;
    }
    const node = (await figma.getNodeByIdAsync(reference)) as AnyNode | null;
    if (!node) throw new Error(`${what} refers to node ${reference}, which does not exist.`);
    return node;
  }

  async resolveParent(reference: unknown, what: string): Promise<BaseNode & ChildrenMixin> {
    const node = await this.resolve(reference, what);
    if (!('appendChild' in node)) throw new Error(`${what} (${node.id}) is a ${node.type} and cannot hold children.`);
    return node as BaseNode & ChildrenMixin;
  }
}

async function importComponent(op: PlanOp): Promise<ComponentNode> {
  const key = op.componentKey as string | undefined;
  const id = op.componentId as string | undefined;

  let node: BaseNode | null = null;
  if (key) {
    try {
      node = await figma.importComponentByKeyAsync(key);
    } catch {
      const set = await figma.importComponentSetByKeyAsync(key);
      node = set.defaultVariant ?? set.children[0] ?? null;
    }
  } else if (id) {
    node = await figma.getNodeByIdAsync(id);
  } else {
    throw new Error('create_instance needs `componentKey` or `componentId`.');
  }

  if (!node) throw new Error(`Component ${key ?? id} was not found.`);
  if (node.type === 'COMPONENT_SET') {
    const set = node as ComponentSetNode;
    const variant = set.defaultVariant ?? (set.children[0] as ComponentNode | undefined);
    if (!variant) throw new Error(`Component set ${set.name} has no variants.`);
    return variant;
  }
  if (node.type !== 'COMPONENT') throw new Error(`${node.id} is a ${node.type}, not a component.`);
  return node as ComponentNode;
}

/** Validates against the live definitions so a bad variant fails before it writes. */
function checkProperties(instance: InstanceNode, properties: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const current = safe(() => instance.componentProperties) as Record<string, { type: string }> | undefined;
  if (!current) return problems;

  for (const name of Object.keys(properties)) {
    // Non-variant properties carry a `#id` suffix; accept either spelling.
    const exact = current[name];
    const suffixed = !exact ? Object.keys(current).find((key) => key.split('#')[0] === name) : undefined;
    if (!exact && !suffixed) {
      problems.push(`"${name}" is not a property of ${instance.name} (has: ${Object.keys(current).join(', ') || 'none'})`);
    }
  }
  return problems;
}

/** Rewrites bare property names to the `name#id` form Figma actually expects. */
function normalizeProperties(instance: InstanceNode, properties: Record<string, unknown>): Record<string, unknown> {
  const current = safe(() => instance.componentProperties) as Record<string, unknown> | undefined;
  if (!current) return properties;
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(properties)) {
    if (name in current) {
      out[name] = properties[name];
      continue;
    }
    const match = Object.keys(current).find((key) => key.split('#')[0] === name);
    out[match ?? name] = properties[name];
  }
  return out;
}

async function resolveVariable(op: PlanOp): Promise<Variable> {
  if (op.variableKey) return await figma.variables.importVariableByKeyAsync(op.variableKey as string);
  if (op.variableId) {
    const variable = await figma.variables.getVariableByIdAsync(op.variableId as string);
    if (!variable) throw new Error(`Variable ${op.variableId} was not found.`);
    return variable;
  }
  throw new Error('This op needs `variableKey` or `variableId`.');
}

const STYLE_SETTERS: Record<string, string> = {
  fill: 'setFillStyleIdAsync',
  stroke: 'setStrokeStyleIdAsync',
  text: 'setTextStyleIdAsync',
  effect: 'setEffectStyleIdAsync',
  grid: 'setGridStyleIdAsync',
};

export async function applyPlan(plan: Plan): Promise<PlanResult> {
  if (!plan || !Array.isArray(plan.ops)) throw new Error('A plan needs an `ops` array.');

  const operationId = plan.operationId || `ff-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const dryRun = plan.dryRun === true;
  const journal = new Journal(operationId);
  const results: OpResult[] = [];
  const created: string[] = [];
  const modified: string[] = [];
  const quarantined: string[] = [];
  const offRamps: PlanResult['offRamps'] = [];

  const scratchPage = plan.scratch && !dryRun ? await ensurePage(SCRATCH_PAGE) : null;
  const scope = new PlanScope(scratchPage);

  // Off-ramp gate runs before anything mutates: a plan that quietly reaches for
  // rectangles should be rejected as a whole, not halfway through.
  if (!plan.allowRawPrimitives) {
    const unjustified = plan.ops
      .map((op, index) => ({ op, index }))
      .filter(({ op }) => RAW_PRIMITIVE_OPS.has(op.op) && !(typeof op.reason === 'string' && op.reason.trim().length > 3));
    if (unjustified.length) {
      const list = unjustified.map(({ op, index }) => `#${index} ${op.op}`).join(', ');
      throw new Error(
        `${unjustified.length} op(s) create raw primitives without a \`reason\`: ${list}. ` +
          'Either use a design-system component, or state why no component fits (set `allowRawPrimitives: true` to bypass entirely).'
      );
    }
  }
  for (let index = 0; index < plan.ops.length; index++) {
    const op = plan.ops[index];
    if (RAW_PRIMITIVE_OPS.has(op.op) && typeof op.reason === 'string') {
      offRamps.push({ index, op: op.op, reason: op.reason });
    }
  }

  if (!dryRun) {
    try {
      figma.commitUndo();
    } catch {
      /* older editors do not expose an explicit undo boundary */
    }
  }

  let failure: string | undefined;

  for (let index = 0; index < plan.ops.length; index++) {
    const op = plan.ops[index];
    const row: OpResult = { index, op: op.op, status: dryRun ? 'validated' : 'applied', ref: op.ref as string };

    try {
      switch (op.op) {
        case 'create_instance': {
          const parent = await scope.resolveParent(op.parent, `op #${index} \`parent\``);
          const component = await importComponent(op);
          if (dryRun) {
            row.detail = { component: component.name, componentId: component.id, parent: parent.id };
            break;
          }
          const instance = component.createInstance();
          insert(parent, instance, op.index as number | undefined);
          if (op.name) instance.name = op.name as string;
          if (op.properties) {
            const problems = checkProperties(instance, op.properties as Record<string, unknown>);
            if (problems.length) throw new Error(problems.join('; '));
            instance.setProperties(
              normalizeProperties(instance, op.properties as Record<string, unknown>) as {
                [key: string]: string | boolean | VariableAlias;
              }
            );
          }
          if (op.set) applyProps(instance as unknown as AnyNode, op.set as Record<string, unknown>);
          journal.recordCreate(op.op, instance as unknown as AnyNode, op.ref as string);
          scope.bind(op.ref as string, instance as unknown as AnyNode);
          created.push(instance.id);
          row.nodeId = instance.id;
          break;
        }

        case 'create_frame': {
          const parent = await scope.resolveParent(op.parent, `op #${index} \`parent\``);
          if (dryRun) {
            row.detail = { parent: parent.id };
            break;
          }
          const frame = figma.createFrame();
          insert(parent, frame, op.index as number | undefined);
          if (op.name) frame.name = op.name as string;
          if (op.autoLayout) {
            frame.layoutMode = op.autoLayout as 'HORIZONTAL' | 'VERTICAL';
            frame.primaryAxisSizingMode = 'AUTO';
            frame.counterAxisSizingMode = 'AUTO';
          }
          if (op.set) applyProps(frame as unknown as AnyNode, op.set as Record<string, unknown>);
          journal.recordCreate(op.op, frame as unknown as AnyNode, op.ref as string);
          scope.bind(op.ref as string, frame as unknown as AnyNode);
          created.push(frame.id);
          row.nodeId = frame.id;
          break;
        }

        case 'create_text': {
          const parent = await scope.resolveParent(op.parent, `op #${index} \`parent\``);
          if (dryRun) {
            row.detail = { parent: parent.id, characters: String(op.characters ?? '') };
            break;
          }
          const text = figma.createText();
          insert(parent, text, op.index as number | undefined);
          await figma.loadFontAsync(text.fontName as FontName);
          if (op.textStyleKey) {
            const style = await figma.importStyleByKeyAsync(op.textStyleKey as string);
            await text.setTextStyleIdAsync(style.id);
            await loadFontsFor(text);
          }
          if (typeof op.characters === 'string') text.characters = op.characters;
          if (op.name) text.name = op.name as string;
          if (op.set) applyProps(text as unknown as AnyNode, op.set as Record<string, unknown>);
          journal.recordCreate(op.op, text as unknown as AnyNode, op.ref as string);
          scope.bind(op.ref as string, text as unknown as AnyNode);
          created.push(text.id);
          row.nodeId = text.id;
          break;
        }

        case 'create_from_svg': {
          const parent = await scope.resolveParent(op.parent, `op #${index} \`parent\``);
          if (typeof op.svg !== 'string') throw new Error('create_from_svg needs an `svg` string.');
          if (dryRun) {
            row.detail = { parent: parent.id, bytes: (op.svg as string).length };
            break;
          }
          const node = figma.createNodeFromSvg(op.svg as string);
          insert(parent, node, op.index as number | undefined);
          if (op.name) node.name = op.name as string;
          if (op.set) applyProps(node as unknown as AnyNode, op.set as Record<string, unknown>);
          journal.recordCreate(op.op, node as unknown as AnyNode, op.ref as string);
          scope.bind(op.ref as string, node as unknown as AnyNode);
          created.push(node.id);
          row.nodeId = node.id;
          break;
        }

        case 'clone': {
          const source = await scope.resolve(op.node, `op #${index} \`node\``);
          if (dryRun) {
            row.detail = { source: source.id };
            break;
          }
          const clone = (source as unknown as SceneNode & { clone: () => SceneNode }).clone();
          const parent = op.parent
            ? await scope.resolveParent(op.parent, `op #${index} \`parent\``)
            : ((source as SceneNode).parent as BaseNode & ChildrenMixin);
          insert(parent, clone, op.index as number | undefined);
          journal.recordCreate(op.op, clone as unknown as AnyNode, op.ref as string);
          scope.bind(op.ref as string, clone as unknown as AnyNode);
          created.push(clone.id);
          row.nodeId = clone.id;
          break;
        }

        case 'set': {
          const node = await scope.resolve(op.node, `op #${index} \`node\``);
          const props = (op.props ?? {}) as Record<string, unknown>;
          row.nodeId = node.id;
          if (dryRun) {
            row.detail = { fields: Object.keys(props) };
            break;
          }
          if ('characters' in props || 'fontName' in props || 'fontSize' in props) {
            await loadFontsFor(node as unknown as TextNode);
            if (props.fontName) await figma.loadFontAsync(props.fontName as FontName);
          }
          journal.recordSet(op.op, node, Object.keys(props));
          applyProps(node, props);
          modified.push(node.id);
          break;
        }

        case 'set_text': {
          const node = await scope.resolve(op.node, `op #${index} \`node\``);
          if (node.type !== 'TEXT') throw new Error(`set_text needs a TEXT node; ${node.id} is a ${node.type}.`);
          row.nodeId = node.id;
          if (dryRun) break;
          const text = node as unknown as TextNode;
          await loadFontsFor(text);
          journal.record(op.op, { kind: 'restore_text', nodeId: text.id, characters: text.characters }, text.id);
          journal.tag(node);
          text.characters = String(op.characters ?? '');
          modified.push(node.id);
          break;
        }

        case 'set_component_properties': {
          const node = await scope.resolve(op.node, `op #${index} \`node\``);
          if (node.type !== 'INSTANCE') {
            throw new Error(`set_component_properties needs an INSTANCE; ${node.id} is a ${node.type}.`);
          }
          const instance = node as unknown as InstanceNode;
          const properties = (op.properties ?? {}) as Record<string, unknown>;
          const problems = checkProperties(instance, properties);
          if (problems.length) throw new Error(problems.join('; '));
          row.nodeId = node.id;
          if (dryRun) {
            row.detail = { properties: Object.keys(properties) };
            break;
          }
          const before = safe(() => instance.componentProperties) as Record<string, { value: unknown }> | undefined;
          if (before) {
            const restore: Record<string, unknown> = {};
            for (const key of Object.keys(normalizeProperties(instance, properties))) {
              if (before[key]) restore[key] = before[key].value;
            }
            journal.record(op.op, { kind: 'restore_component_properties', nodeId: instance.id, properties: restore }, instance.id);
          }
          journal.tag(node);
          instance.setProperties(
            normalizeProperties(instance, properties) as { [key: string]: string | boolean | VariableAlias }
          );
          modified.push(node.id);
          break;
        }

        case 'swap_instance': {
          const node = await scope.resolve(op.node, `op #${index} \`node\``);
          if (node.type !== 'INSTANCE') throw new Error(`swap_instance needs an INSTANCE; ${node.id} is a ${node.type}.`);
          const component = await importComponent(op);
          row.nodeId = node.id;
          if (dryRun) {
            row.detail = { to: component.name, componentId: component.id };
            break;
          }
          const instance = node as unknown as InstanceNode;
          const previous = await instance.getMainComponentAsync();
          journal.record(
            op.op,
            previous
              ? { kind: 'restore_props', nodeId: instance.id, props: {} }
              : { kind: 'none', note: `${instance.id} had no main component to restore` },
            instance.id
          );
          journal.tag(node);
          instance.swapComponent(component);
          modified.push(node.id);
          row.detail = { from: previous ? previous.name : null, to: component.name };
          break;
        }

        case 'bind_variable': {
          const node = await scope.resolve(op.node, `op #${index} \`node\``);
          const field = String(op.field ?? '');
          if (!field) throw new Error('bind_variable needs a `field`.');
          const variable = await resolveVariable(op);
          row.nodeId = node.id;
          if (dryRun) {
            row.detail = { field, variable: variable.name, resolvedType: variable.resolvedType };
            break;
          }
          const bound = safe(() => (node as unknown as { boundVariables?: Record<string, VariableAlias> }).boundVariables);
          const previous = bound && bound[field] ? bound[field].id : null;
          journal.record(op.op, { kind: 'restore_bindings', nodeId: node.id, field, variableId: previous }, node.id);
          journal.tag(node);
          (node as unknown as { setBoundVariable: (f: string, v: Variable | null) => void }).setBoundVariable(field, variable);
          modified.push(node.id);
          break;
        }

        case 'bind_paint_variable': {
          const node = await scope.resolve(op.node, `op #${index} \`node\``);
          const target = (op.target as 'fills' | 'strokes') ?? 'fills';
          const paintIndex = typeof op.paintIndex === 'number' ? op.paintIndex : 0;
          const variable = await resolveVariable(op);
          row.nodeId = node.id;
          if (dryRun) {
            row.detail = { target, paintIndex, variable: variable.name };
            break;
          }
          const paints = safe(() => (node as unknown as Record<string, unknown>)[target]) as readonly Paint[] | undefined;
          if (!Array.isArray(paints) || !paints[paintIndex]) {
            throw new Error(`${node.id} has no ${target}[${paintIndex}] to bind.`);
          }
          journal.recordSet(op.op, node, [target]);
          const next = paints.map((paint, i) =>
            i === paintIndex ? figma.variables.setBoundVariableForPaint(paint as SolidPaint, 'color', variable) : paint
          );
          (node as unknown as Record<string, unknown>)[target] = next;
          modified.push(node.id);
          break;
        }

        case 'apply_style': {
          const node = await scope.resolve(op.node, `op #${index} \`node\``);
          const kind = String(op.kind ?? 'fill');
          const setter = STYLE_SETTERS[kind];
          if (!setter) throw new Error(`apply_style kind must be one of ${Object.keys(STYLE_SETTERS).join(', ')}.`);
          const style = op.styleKey
            ? await figma.importStyleByKeyAsync(op.styleKey as string)
            : await figma.getStyleByIdAsync(String(op.styleId ?? ''));
          if (!style) throw new Error(`Style ${op.styleKey ?? op.styleId} was not found.`);
          row.nodeId = node.id;
          if (dryRun) {
            row.detail = { kind, style: style.name };
            break;
          }
          const field = `${kind}Style`;
          const previous = safe(() => (node as unknown as Record<string, string>)[`${field}Id`]) ?? null;
          journal.record(op.op, { kind: 'restore_style', nodeId: node.id, field, styleId: previous }, node.id);
          journal.tag(node);
          if (kind === 'text') await loadFontsFor(node as unknown as TextNode);
          await (node as unknown as Record<string, (id: string) => Promise<void>>)[setter](style.id);
          modified.push(node.id);
          break;
        }

        case 'move': {
          const node = await scope.resolve(op.node, `op #${index} \`node\``);
          const parent = await scope.resolveParent(op.parent, `op #${index} \`parent\``);
          row.nodeId = node.id;
          if (dryRun) {
            row.detail = { to: parent.id };
            break;
          }
          journal.recordPosition(op.op, node);
          insert(parent, node as unknown as SceneNode, op.index as number | undefined);
          modified.push(node.id);
          break;
        }

        case 'reorder': {
          const node = await scope.resolve(op.node, `op #${index} \`node\``);
          const parent = (node as SceneNode).parent as (BaseNode & ChildrenMixin) | null;
          if (!parent) throw new Error(`${node.id} has no parent to reorder within.`);
          row.nodeId = node.id;
          if (dryRun) break;
          journal.recordPosition(op.op, node);
          parent.insertChild(clampIndex(parent, op.index as number), node as unknown as SceneNode);
          modified.push(node.id);
          break;
        }

        case 'rename': {
          const node = await scope.resolve(op.node, `op #${index} \`node\``);
          row.nodeId = node.id;
          if (dryRun) break;
          journal.recordSet(op.op, node, ['name']);
          node.name = String(op.name ?? node.name);
          modified.push(node.id);
          break;
        }

        case 'resize': {
          const node = await scope.resolve(op.node, `op #${index} \`node\``);
          row.nodeId = node.id;
          if (dryRun) break;
          const target = node as unknown as { resize: (w: number, h: number) => void; width: number; height: number };
          if (typeof target.resize !== 'function') throw new Error(`${node.id} (${node.type}) cannot be resized.`);
          journal.recordSet(op.op, node, ['width', 'height']);
          target.resize(
            typeof op.width === 'number' ? op.width : target.width,
            typeof op.height === 'number' ? op.height : target.height
          );
          modified.push(node.id);
          break;
        }

        case 'remove': {
          const node = await scope.resolve(op.node, `op #${index} \`node\``);
          row.nodeId = node.id;
          if (dryRun) {
            row.detail = { willQuarantine: true };
            break;
          }
          // Deletes are quarantine moves until verification passes, so a wrong
          // call is recoverable instead of a silent, permanent loss.
          const parked = await quarantine(node as unknown as SceneNode, journal);
          quarantined.push(parked.nodeId);
          break;
        }

        case 'set_selection': {
          const ids = (op.nodes ?? []) as string[];
          if (dryRun) {
            row.detail = { count: ids.length };
            break;
          }
          const nodes: SceneNode[] = [];
          for (const id of ids) nodes.push((await scope.resolve(id, 'set_selection node')) as unknown as SceneNode);
          figma.currentPage.selection = nodes;
          row.detail = { count: nodes.length };
          break;
        }

        case 'scroll_into_view': {
          const node = await scope.resolve(op.node, `op #${index} \`node\``);
          row.nodeId = node.id;
          if (dryRun) break;
          figma.viewport.scrollAndZoomIntoView([node as unknown as SceneNode]);
          break;
        }

        default:
          throw new Error(`Unknown op "${op.op}".`);
      }
    } catch (error) {
      row.status = 'failed';
      row.error = errorMessage(error);
      results.push(row);
      failure = `op #${index} (${op.op}): ${row.error}`;
      for (let rest = index + 1; rest < plan.ops.length; rest++) {
        results.push({ index: rest, op: plan.ops[rest].op, status: 'skipped' });
      }
      break;
    }

    results.push(row);
  }

  const result: PlanResult = {
    operationId,
    dryRun,
    ok: !failure,
    applied: results.filter((row) => row.status === 'applied').length,
    results,
    created,
    modified: [...new Set(modified)],
    quarantined,
    offRamps,
    journal: journal.toArray(),
    scratchPageId: scratchPage ? scratchPage.id : undefined,
    error: failure,
  };

  if (failure && !dryRun && plan.rollbackOnError !== false) {
    result.rolledBack = await rollback(journal.toArray());
  }

  if (!dryRun) {
    try {
      figma.commitUndo();
    } catch {
      /* non-fatal */
    }
  }

  return result;
}

function insert(parent: BaseNode & ChildrenMixin, node: SceneNode, index?: number): void {
  if (typeof index === 'number') parent.insertChild(clampIndex(parent, index), node);
  else parent.appendChild(node);
}

function clampIndex(parent: BaseNode & ChildrenMixin, index: number): number {
  if (typeof index !== 'number' || Number.isNaN(index)) return parent.children.length;
  return Math.max(0, Math.min(index, parent.children.length));
}

/** Compact confirmation of what a plan produced, for the agent's next step. */
export async function summarizeCreated(ids: string[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const id of ids.slice(0, 50)) {
    const node = (await figma.getNodeByIdAsync(id)) as AnyNode | null;
    if (node) out.push(await summarizeNode(node, { depth: 0 }));
  }
  return out;
}
