/**
 * CSS-like selector engine for Figma nodes.
 *
 * This mirrors the `node.query()` selector syntax that Figma's own `use_figma`
 * sandbox provides. Reproducing it faithfully is what lets us reuse Figma's
 * published reference corpus verbatim instead of writing our own from scratch.
 *
 * Supported:
 *   Type          FRAME, TEXT, INSTANCE, …  (case-insensitive)
 *   Attribute     [name=Card] [visible=true] [name*=art] [name^=H] [name$=Nav]
 *   Dot paths     [fills.0.type=SOLID] [fills.*.type=SOLID]
 *   Instances     [mainComponent=id] [mainComponent.name=Button]
 *   Combinators   A > B (child), A B (descendant), A + B (adjacent), A ~ B (sibling)
 *   Pseudo        :first-child :last-child :nth-child(n) :not(…) :is(…) :where(…)
 *   Id            #1:23 or a bare GUID
 *   Union         A, B
 *   Wildcard      *
 */

type AnyNode = BaseNode & { children?: readonly SceneNode[] };

interface AttrTest {
  path: string[];
  op: '=' | '*=' | '^=' | '$=' | 'exists';
  value?: string;
}

interface Simple {
  type?: string;
  id?: string;
  attrs: AttrTest[];
  pseudos: Pseudo[];
}

interface Pseudo {
  name: string;
  args?: Compound[][];
  index?: number;
}

type Combinator = ' ' | '>' | '+' | '~';

/** One compound selector plus the combinator joining it to the previous one. */
interface Compound {
  combinator: Combinator;
  simple: Simple;
}

const TOKEN = /\s*(,|>|\+|~|\s(?=[^\s>+~]))\s*/;

function splitTop(input: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of input) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function parseSimple(raw: string): Simple {
  const simple: Simple = { attrs: [], pseudos: [] };
  let rest = raw.trim();

  // Attribute clauses first — they can contain almost any character.
  rest = rest.replace(/\[([^\]]*)\]/g, (_, body: string) => {
    const match = /^([^=*^$!]+?)\s*(\*=|\^=|\$=|=)\s*(.*)$/.exec(body);
    if (!match) {
      simple.attrs.push({ path: body.trim().split('.'), op: 'exists' });
      return '';
    }
    const [, key, op, value] = match;
    simple.attrs.push({
      path: key.trim().split('.'),
      op: op as AttrTest['op'],
      value: value.trim().replace(/^["']|["']$/g, ''),
    });
    return '';
  });

  // Then pseudo-classes, which may nest full selector lists.
  rest = rest.replace(/:([a-z-]+)(?:\(([^)]*)\))?/gi, (_, name: string, args?: string) => {
    const pseudo: Pseudo = { name: name.toLowerCase() };
    if (args != null) {
      if (pseudo.name === 'nth-child') pseudo.index = Number(args.trim());
      else pseudo.args = splitTop(args, ',').map(parseCompound);
    }
    simple.pseudos.push(pseudo);
    return '';
  });

  rest = rest.trim();
  if (rest.startsWith('#')) {
    simple.id = rest.slice(1);
  } else if (/^\d+:\d+$/.test(rest) || /^[0-9a-f]{8}-[0-9a-f-]+$/i.test(rest)) {
    simple.id = rest;
  } else if (rest && rest !== '*') {
    simple.type = rest.toUpperCase();
  }
  return simple;
}

function parseCompound(raw: string): Compound[] {
  const pieces = raw.trim().split(TOKEN).filter((p) => p != null && p !== '');
  const out: Compound[] = [];
  let combinator: Combinator = ' ';

  for (const piece of pieces) {
    const token = piece.trim();
    if (token === '>' || token === '+' || token === '~') {
      combinator = token;
      continue;
    }
    if (token === '') continue;
    out.push({ combinator: out.length === 0 ? ' ' : combinator, simple: parseSimple(token) });
    combinator = ' ';
  }
  return out;
}

function readPath(node: AnyNode, path: string[]): unknown[] {
  let current: unknown[] = [node];
  for (const segment of path) {
    const next: unknown[] = [];
    for (const value of current) {
      if (value == null) continue;
      if (segment === '*') {
        if (Array.isArray(value)) next.push(...value);
        continue;
      }
      try {
        const child = (value as Record<string, unknown>)[segment];
        if (child !== undefined) next.push(child);
      } catch {
        // Figma throws on some getters depending on node type — treat as absent.
      }
    }
    current = next;
    if (current.length === 0) return [];
  }
  return current;
}

function matchesAttr(node: AnyNode, test: AttrTest): boolean {
  const values = readPath(node, test.path);
  if (test.op === 'exists') return values.length > 0;
  return values.some((value) => {
    const text = String(value);
    switch (test.op) {
      case '=':
        return text === test.value || (typeof value === 'boolean' && String(value) === test.value);
      case '*=':
        return text.includes(test.value!);
      case '^=':
        return text.startsWith(test.value!);
      case '$=':
        return text.endsWith(test.value!);
      default:
        return false;
    }
  });
}

function siblings(node: AnyNode): readonly SceneNode[] {
  const parent = (node as SceneNode).parent as (BaseNode & ChildrenMixin) | null;
  return parent && 'children' in parent ? parent.children : [];
}

function matchesSimple(node: AnyNode, simple: Simple): boolean {
  if (simple.id && node.id !== simple.id) return false;
  if (simple.type && node.type !== simple.type) return false;
  for (const attr of simple.attrs) if (!matchesAttr(node, attr)) return false;

  for (const pseudo of simple.pseudos) {
    switch (pseudo.name) {
      case 'first-child':
        if (siblings(node)[0]?.id !== node.id) return false;
        break;
      case 'last-child': {
        const list = siblings(node);
        if (list[list.length - 1]?.id !== node.id) return false;
        break;
      }
      case 'nth-child':
        if (siblings(node)[(pseudo.index ?? 1) - 1]?.id !== node.id) return false;
        break;
      case 'not':
        if ((pseudo.args ?? []).some((compound) => matchesCompound(node, compound))) return false;
        break;
      case 'is':
      case 'where':
        if (!(pseudo.args ?? []).some((compound) => matchesCompound(node, compound))) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

/** Walks a compound right-to-left, honouring combinators. */
function matchesCompound(node: AnyNode, compound: Compound[]): boolean {
  if (compound.length === 0) return false;
  const last = compound[compound.length - 1];
  if (!matchesSimple(node, last.simple)) return false;
  if (compound.length === 1) return true;

  const rest = compound.slice(0, -1);
  const previous = rest[rest.length - 1];

  switch (last.combinator) {
    case '>': {
      const parent = (node as SceneNode).parent as AnyNode | null;
      return !!parent && matchesCompound(parent, rest);
    }
    case ' ': {
      let ancestor = (node as SceneNode).parent as AnyNode | null;
      while (ancestor) {
        if (matchesCompound(ancestor, rest)) return true;
        ancestor = (ancestor as SceneNode).parent as AnyNode | null;
      }
      return false;
    }
    case '+': {
      const list = siblings(node);
      const index = list.findIndex((sibling) => sibling.id === node.id);
      return index > 0 && matchesCompound(list[index - 1] as AnyNode, rest);
    }
    case '~': {
      const list = siblings(node);
      const index = list.findIndex((sibling) => sibling.id === node.id);
      return list.slice(0, Math.max(index, 0)).some((sibling) => matchesCompound(sibling as AnyNode, rest));
    }
    default:
      return !!previous && false;
  }
}

/** Every descendant of `root`, excluding `root` itself. */
function descendants(root: AnyNode): AnyNode[] {
  const out: AnyNode[] = [];
  const stack: AnyNode[] = [];
  if ('children' in root && root.children) stack.push(...(root.children as unknown as AnyNode[]));
  while (stack.length) {
    const node = stack.pop()!;
    out.push(node);
    if ('children' in node && node.children) stack.push(...(node.children as unknown as AnyNode[]));
  }
  return out;
}

/**
 * Returns every descendant of `root` matching `selector`, in document order.
 * Comma-separated selectors are unioned and de-duplicated by node id.
 */
export function select(root: AnyNode, selector: string): AnyNode[] {
  const compounds = splitTop(selector, ',').map(parseCompound).filter((c) => c.length > 0);
  if (compounds.length === 0) return [];

  const pool = descendants(root);
  const seen = new Set<string>();
  const out: AnyNode[] = [];
  for (const node of pool) {
    if (seen.has(node.id)) continue;
    if (compounds.some((compound) => matchesCompound(node, compound))) {
      seen.add(node.id);
      out.push(node);
    }
  }
  return out;
}

export function matches(node: AnyNode, selector: string): boolean {
  return splitTop(selector, ',')
    .map(parseCompound)
    .some((compound) => compound.length > 0 && matchesCompound(node, compound));
}
