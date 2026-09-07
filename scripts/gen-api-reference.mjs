#!/usr/bin/env node
/**
 * Generates the Plugin API reference from `@figma/plugin-typings`.
 *
 * The typings package is MIT licensed (Copyright (c) 2021 Figma, Inc.), which is
 * what makes this approach available to us: we can derive, ship and modify it
 * freely. Figma's *documentation* corpus carries no licence at all, so this
 * reference is generated from the types instead of copied from prose — which
 * also means it cannot drift from the API, and a `npm update` regenerates it.
 *
 * Two questions cause most failed writes, and this file answers both:
 *   "does this node type even have that property?"  -> Node types section
 *   "what are the legal values?"                    -> Enums section
 *
 *   node scripts/gen-api-reference.mjs
 */

import ts from 'typescript';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const typingsDir = resolve(root, 'node_modules/@figma/plugin-typings');
const entry = resolve(typingsDir, 'plugin-api.d.ts');
const outFile = resolve(root, 'skills/figma-runtime/references/api-reference.md');

const version = JSON.parse(await readFile(resolve(typingsDir, 'package.json'), 'utf8')).version;
const source = await readFile(entry, 'utf8');
const sourceFile = ts.createSourceFile(entry, source, ts.ScriptTarget.Latest, true);

/** @type {Map<string, {extends: string[], props: Map<string, {type: string, readonly: boolean, optional: boolean}>, methods: Map<string, string>}>} */
const interfaces = new Map();
/** @type {Map<string, string[]>} */
const enums = new Map();

const oneLine = (node) => node.getText(sourceFile).replace(/\s+/g, ' ').trim();

function shorten(text, limit = 88) {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** Only unions made entirely of string literals are useful as "legal values". */
function stringUnion(typeNode) {
  if (!ts.isUnionTypeNode(typeNode)) return null;
  const values = [];
  for (const member of typeNode.types) {
    if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) return null;
    values.push(member.literal.text);
  }
  return values.length > 1 ? values : null;
}

for (const statement of sourceFile.statements) {
  if (ts.isInterfaceDeclaration(statement)) {
    const record = { extends: [], props: new Map(), methods: new Map() };
    for (const clause of statement.heritageClauses ?? []) {
      for (const parent of clause.types) record.extends.push(parent.expression.getText(sourceFile));
    }
    for (const member of statement.members) {
      const name = member.name ? member.name.getText(sourceFile) : null;
      if (!name) continue;
      if (ts.isPropertySignature(member)) {
        record.props.set(name, {
          type: member.type ? shorten(oneLine(member.type)) : 'unknown',
          readonly: !!member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword),
          optional: !!member.questionToken,
        });
      } else if (ts.isMethodSignature(member)) {
        const params = member.parameters.map((parameter) => oneLine(parameter)).join(', ');
        const returns = member.type ? oneLine(member.type) : 'void';
        record.methods.set(name, shorten(`${name}(${params}): ${returns}`, 130));
      }
    }
    interfaces.set(statement.name.text, record);
    continue;
  }

  if (ts.isTypeAliasDeclaration(statement)) {
    const values = stringUnion(statement.type);
    if (values) enums.set(statement.name.text, values);
  }
}

/** Node types inherit almost everything through mixins; flatten before printing. */
function resolve_(name, seen = new Set()) {
  if (seen.has(name)) return { props: new Map(), methods: new Map() };
  seen.add(name);
  const record = interfaces.get(name);
  if (!record) return { props: new Map(), methods: new Map() };

  const props = new Map();
  const methods = new Map();
  for (const parent of record.extends) {
    const inherited = resolve_(parent, seen);
    for (const [key, value] of inherited.props) props.set(key, value);
    for (const [key, value] of inherited.methods) methods.set(key, value);
  }
  // Own members win: a node narrowing an inherited property is the truth for it.
  for (const [key, value] of record.props) props.set(key, value);
  for (const [key, value] of record.methods) methods.set(key, value);
  return { props, methods };
}

/**
 * The manifest declares `editorType: ["figma"]`, so FigJam and Slides node types
 * can never appear in a document we touch. Dropping them is not just size — a
 * reference that lists `StickyNode` invites code that will never run.
 */
const OTHER_EDITORS = new Set([
  'CodeBlockNode', 'ConnectorNode', 'EmbedNode', 'HighlightNode', 'InteractiveSlideElementNode',
  'LinkUnfurlNode', 'MediaNode', 'ShapeWithTextNode', 'SlideGridNode', 'SlideNode', 'SlideRowNode',
  'SlotNode', 'StampNode', 'StickyNode', 'TableCellNode', 'TableNode', 'WashiTapeNode', 'WidgetNode',
]);

const nodeTypes = [...interfaces.keys()]
  .filter((name) => /Node$/.test(name) && !/^(Base|Scene|Default)/.test(name) && !OTHER_EDITORS.has(name))
  .sort();

/**
 * The reference is inverted on purpose: "which node types have `itemSpacing`?"
 * is the question that actually gets asked, and answering it per node type would
 * repeat every inherited property forty times over.
 */
const propertyOwners = new Map();
const methodOwners = new Map();
const ownProps = new Map();

for (const name of nodeTypes) {
  const { props, methods } = resolve_(name);
  const short = name.replace(/Node$/, '');
  ownProps.set(name, [...(interfaces.get(name)?.props.keys() ?? [])]);

  for (const [key, value] of props) {
    const row = propertyOwners.get(key) ?? { type: value.type, readonly: value.readonly, owners: [] };
    // A node narrowing an inherited type is worth surfacing rather than hiding.
    if (row.type !== value.type) row.type = row.type.includes(' | varies') ? row.type : `${row.type} | varies`;
    row.owners.push(short);
    propertyOwners.set(key, row);
  }
  for (const [key, signature] of methods) {
    const row = methodOwners.get(key) ?? { signature, owners: [] };
    row.owners.push(short);
    methodOwners.set(key, row);
  }
}

const ALL = nodeTypes.length;
const SHORT_NAMES = nodeTypes.map((name) => name.replace(/Node$/, ''));

/**
 * A property on 34 of 40 types tells you nothing as a list; naming the six
 * exceptions tells you everything.
 */
function owners(list) {
  if (list.length === ALL) return '_all node types_';
  if (list.length >= ALL * 0.8) {
    const present = new Set(list);
    const missing = SHORT_NAMES.filter((name) => !present.has(name));
    return `_all except_ ${missing.join(', ')}`;
  }
  return list.join(', ');
}

const lines = [];
lines.push('# Figma Plugin API reference');
lines.push('');
lines.push(
  `Generated from \`@figma/plugin-typings@${version}\` (MIT, Copyright (c) 2021 Figma, Inc.) ` +
    'by `scripts/gen-api-reference.mjs`. Regenerate after upgrading the package rather than editing by hand.'
);
lines.push('');
lines.push('Two failures this file prevents: setting a property a node type does not have');
lines.push('(Figma throws `object is not extensible`), and passing a value outside an enum.');
lines.push('');
lines.push('`ro` marks read-only — assigning to one throws or silently does nothing.');
lines.push('Use the matching method instead (`width`/`height` → `resize()`).');
lines.push('Node type names are listed without their `Node` suffix.');
lines.push('');

lines.push('## Enums');
lines.push('');
lines.push('Legal values for every string-union property. Values are case-sensitive.');
lines.push('');
for (const name of [...enums.keys()].sort()) {
  lines.push(`- **${name}** — ${enums.get(name).map((value) => `\`${value}\``).join(' · ')}`);
}
lines.push('');

lines.push('## Properties');
lines.push('');
lines.push('Alphabetical. The node types listed are the only ones that have the property.');
lines.push('');
for (const key of [...propertyOwners.keys()].sort()) {
  const row = propertyOwners.get(key);
  lines.push(`- **${key}**${row.readonly ? ' `ro`' : ''} — ${row.type} — ${owners(row.owners)}`);
}
lines.push('');

lines.push('## Methods');
lines.push('');
for (const key of [...methodOwners.keys()].sort()) {
  const row = methodOwners.get(key);
  lines.push(`- \`${row.signature}\` — ${owners(row.owners)}`);
}
lines.push('');

lines.push('## Node types');
lines.push('');
lines.push('What each type declares itself, on top of what it inherits.');
lines.push('');
for (const name of nodeTypes) {
  const own = ownProps.get(name) ?? [];
  const extendsList = interfaces.get(name)?.extends ?? [];
  const parts = [];
  if (extendsList.length) parts.push(`extends ${extendsList.join(', ')}`);
  if (own.length) parts.push(`own: ${own.join(', ')}`);
  lines.push(`- **${name}** — ${parts.join(' · ') || 'no own members'}`);
}
lines.push('');

const output = lines.join('\n');
await writeFile(outFile, output, 'utf8');
console.log(
  `wrote ${outFile}\n  ${nodeTypes.length} node types, ${enums.size} enums, ` +
    `${propertyOwners.size} properties, ${methodOwners.size} methods, ${Math.round(output.length / 1024)} KB`
);
