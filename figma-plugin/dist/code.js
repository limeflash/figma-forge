"use strict";
(() => {
  // figma-plugin/src/runtime/selector.ts
  var TOKEN = /\s*(,|>|\+|~|\s(?=[^\s>+~]))\s*/;
  function splitTop(input, separator) {
    const parts = [];
    let depth = 0;
    let current = "";
    for (const ch of input) {
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      if (ch === separator && depth === 0) {
        parts.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    parts.push(current);
    return parts.map((p) => p.trim()).filter(Boolean);
  }
  function parseSimple(raw) {
    const simple = { attrs: [], pseudos: [] };
    let rest = raw.trim();
    rest = rest.replace(/\[([^\]]*)\]/g, (_, body) => {
      const match = /^([^=*^$!]+?)\s*(\*=|\^=|\$=|=)\s*(.*)$/.exec(body);
      if (!match) {
        simple.attrs.push({ path: body.trim().split("."), op: "exists" });
        return "";
      }
      const [, key, op, value] = match;
      simple.attrs.push({
        path: key.trim().split("."),
        op,
        value: value.trim().replace(/^["']|["']$/g, "")
      });
      return "";
    });
    rest = rest.replace(/:([a-z-]+)(?:\(([^)]*)\))?/gi, (_, name, args) => {
      const pseudo = { name: name.toLowerCase() };
      if (args != null) {
        if (pseudo.name === "nth-child") pseudo.index = Number(args.trim());
        else pseudo.args = splitTop(args, ",").map(parseCompound);
      }
      simple.pseudos.push(pseudo);
      return "";
    });
    rest = rest.trim();
    if (rest.startsWith("#")) {
      simple.id = rest.slice(1);
    } else if (/^\d+:\d+$/.test(rest) || /^[0-9a-f]{8}-[0-9a-f-]+$/i.test(rest)) {
      simple.id = rest;
    } else if (rest && rest !== "*") {
      simple.type = rest.toUpperCase();
    }
    return simple;
  }
  function parseCompound(raw) {
    const pieces = raw.trim().split(TOKEN).filter((p) => p != null && p !== "");
    const out = [];
    let combinator = " ";
    for (const piece of pieces) {
      const token = piece.trim();
      if (token === ">" || token === "+" || token === "~") {
        combinator = token;
        continue;
      }
      if (token === "") continue;
      out.push({ combinator: out.length === 0 ? " " : combinator, simple: parseSimple(token) });
      combinator = " ";
    }
    return out;
  }
  function readPath(node, path) {
    let current = [node];
    for (const segment of path) {
      const next = [];
      for (const value of current) {
        if (value == null) continue;
        if (segment === "*") {
          if (Array.isArray(value)) next.push(...value);
          continue;
        }
        try {
          const child = value[segment];
          if (child !== void 0) next.push(child);
        } catch {
        }
      }
      current = next;
      if (current.length === 0) return [];
    }
    return current;
  }
  function matchesAttr(node, test) {
    const values = readPath(node, test.path);
    if (test.op === "exists") return values.length > 0;
    return values.some((value) => {
      const text = String(value);
      switch (test.op) {
        case "=":
          return text === test.value || typeof value === "boolean" && String(value) === test.value;
        case "*=":
          return text.includes(test.value);
        case "^=":
          return text.startsWith(test.value);
        case "$=":
          return text.endsWith(test.value);
        default:
          return false;
      }
    });
  }
  function siblings(node) {
    const parent = node.parent;
    return parent && "children" in parent ? parent.children : [];
  }
  function matchesSimple(node, simple) {
    if (simple.id && node.id !== simple.id) return false;
    if (simple.type && node.type !== simple.type) return false;
    for (const attr of simple.attrs) if (!matchesAttr(node, attr)) return false;
    for (const pseudo of simple.pseudos) {
      switch (pseudo.name) {
        case "first-child":
          if (siblings(node)[0]?.id !== node.id) return false;
          break;
        case "last-child": {
          const list = siblings(node);
          if (list[list.length - 1]?.id !== node.id) return false;
          break;
        }
        case "nth-child":
          if (siblings(node)[(pseudo.index ?? 1) - 1]?.id !== node.id) return false;
          break;
        case "not":
          if ((pseudo.args ?? []).some((compound) => matchesCompound(node, compound))) return false;
          break;
        case "is":
        case "where":
          if (!(pseudo.args ?? []).some((compound) => matchesCompound(node, compound))) return false;
          break;
        default:
          return false;
      }
    }
    return true;
  }
  function matchesCompound(node, compound) {
    if (compound.length === 0) return false;
    const last = compound[compound.length - 1];
    if (!matchesSimple(node, last.simple)) return false;
    if (compound.length === 1) return true;
    const rest = compound.slice(0, -1);
    const previous = rest[rest.length - 1];
    switch (last.combinator) {
      case ">": {
        const parent = node.parent;
        return !!parent && matchesCompound(parent, rest);
      }
      case " ": {
        let ancestor = node.parent;
        while (ancestor) {
          if (matchesCompound(ancestor, rest)) return true;
          ancestor = ancestor.parent;
        }
        return false;
      }
      case "+": {
        const list = siblings(node);
        const index = list.findIndex((sibling) => sibling.id === node.id);
        return index > 0 && matchesCompound(list[index - 1], rest);
      }
      case "~": {
        const list = siblings(node);
        const index = list.findIndex((sibling) => sibling.id === node.id);
        return list.slice(0, Math.max(index, 0)).some((sibling) => matchesCompound(sibling, rest));
      }
      default:
        return !!previous && false;
    }
  }
  function descendants(root) {
    const out = [];
    const stack = [];
    if ("children" in root && root.children) stack.push(...root.children);
    while (stack.length) {
      const node = stack.pop();
      out.push(node);
      if ("children" in node && node.children) stack.push(...node.children);
    }
    return out;
  }
  function select(root, selector) {
    const compounds = splitTop(selector, ",").map(parseCompound).filter((c) => c.length > 0);
    if (compounds.length === 0) return [];
    const pool = descendants(root);
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const node of pool) {
      if (seen.has(node.id)) continue;
      if (compounds.some((compound) => matchesCompound(node, compound))) {
        seen.add(node.id);
        out.push(node);
      }
    }
    return out;
  }
  function matches(node, selector) {
    return splitTop(selector, ",").map(parseCompound).some((compound) => compound.length > 0 && matchesCompound(node, compound));
  }

  // figma-plugin/src/runtime/shims.ts
  var PRIORITY_KEYS = ["layoutMode", "layoutWrap", "primaryAxisSizingMode", "counterAxisSizingMode"];
  var DEFERRED_KEYS = ["layoutSizingHorizontal", "layoutSizingVertical", "layoutAlign", "layoutGrow"];
  var QueryResult = class _QueryResult {
    constructor(nodes) {
      this.nodes = nodes;
      ensureShims(nodes);
    }
    get length() {
      return this.nodes.length;
    }
    first() {
      return this.nodes[0] ?? null;
    }
    last() {
      return this.nodes[this.nodes.length - 1] ?? null;
    }
    toArray() {
      return [...this.nodes];
    }
    each(fn) {
      this.nodes.forEach(fn);
      return this;
    }
    map(fn) {
      return this.nodes.map(fn);
    }
    filter(fn) {
      return new _QueryResult(this.nodes.filter(fn));
    }
    /** Extracts a subset of properties from each match, skipping throwing getters. */
    values(keys) {
      return this.nodes.map((node) => {
        const row = {};
        for (const key of keys) {
          try {
            row[key] = node[key];
          } catch {
            row[key] = void 0;
          }
        }
        return row;
      });
    }
    set(props) {
      for (const node of this.nodes) applyProps(node, props);
      return this;
    }
    query(selector) {
      const seen = /* @__PURE__ */ new Set();
      const out = [];
      for (const node of this.nodes) {
        for (const match of select(node, selector)) {
          if (seen.has(match.id)) continue;
          seen.add(match.id);
          out.push(match);
        }
      }
      return new _QueryResult(out);
    }
    [Symbol.iterator]() {
      return this.nodes[Symbol.iterator]();
    }
  };
  function applyProps(node, props) {
    const target = node;
    const deferred = [];
    let width;
    let height;
    const assign = (key, value) => {
      if (key === "width") {
        width = value;
        return;
      }
      if (key === "height") {
        height = value;
        return;
      }
      if (DEFERRED_KEYS.includes(key)) {
        deferred.push([key, value]);
        return;
      }
      target[key] = value;
    };
    for (const key of PRIORITY_KEYS) {
      if (key in props) assign(key, props[key]);
    }
    for (const [key, value] of Object.entries(props)) {
      if (PRIORITY_KEYS.includes(key)) continue;
      assign(key, value);
    }
    if (width !== void 0 || height !== void 0) {
      const resizable = node;
      if (typeof resizable.resize === "function") {
        resizable.resize(width ?? resizable.width, height ?? resizable.height);
      }
    }
    for (const [key, value] of deferred) target[key] = value;
    return node;
  }
  var shimmedPrototypes = /* @__PURE__ */ new WeakSet();
  var installedNames = /* @__PURE__ */ new Set();
  function definePrototypeMember(proto, name, descriptor) {
    try {
      if (Object.getOwnPropertyDescriptor(proto, name)) return true;
      Object.defineProperty(proto, name, { configurable: true, ...descriptor });
      return true;
    } catch {
      return false;
    }
  }
  function installOnPrototype(proto) {
    const ok = [];
    ok.push(
      definePrototypeMember(proto, "query", {
        value: function(selector) {
          return new QueryResult(select(this, selector));
        },
        writable: true
      })
    );
    ok.push(
      definePrototypeMember(proto, "set", {
        value: function(props) {
          return applyProps(this, props);
        },
        writable: true
      })
    );
    ok.push(
      definePrototypeMember(proto, "matches", {
        value: function(selector) {
          return matches(this, selector);
        },
        writable: true
      })
    );
    ok.push(
      definePrototypeMember(proto, "screenshot", {
        value: function(opts) {
          return screenshot(this, opts);
        },
        writable: true
      })
    );
    ok.push(
      definePrototypeMember(proto, "placeholder", {
        get() {
          return placeholderState.get(this.id) ?? false;
        },
        set(value) {
          if (value) placeholderState.set(this.id, true);
          else placeholderState.delete(this.id);
        }
      })
    );
    return ok.every(Boolean);
  }
  function ensureShims(nodes) {
    if (!nodes) return;
    const list = Array.isArray(nodes) ? nodes : [nodes];
    for (const node of list) {
      if (!node) continue;
      let proto;
      try {
        proto = Object.getPrototypeOf(node);
      } catch {
        continue;
      }
      if (!proto || proto === Object.prototype || shimmedPrototypes.has(proto)) continue;
      shimmedPrototypes.add(proto);
      if (installOnPrototype(proto)) {
        const name = proto.constructor?.name;
        if (name) installedNames.add(name);
      }
    }
  }
  var report = null;
  function installShims() {
    if (report) return report;
    const installed = [];
    const reachable = [];
    try {
      reachable.push(figma.root, figma.currentPage);
      for (const child of figma.currentPage.children.slice(0, 50)) reachable.push(child);
    } catch {
    }
    ensureShims(reachable);
    if (installedNames.size) installed.push("query", "set", "matches", "screenshot", "placeholder");
    try {
      const host = figma;
      if (typeof host.createAutoLayout !== "function") {
        host.createAutoLayout = createAutoLayout;
        installed.push("figma.createAutoLayout");
      }
    } catch {
    }
    report = { prototypeShimmed: installedNames.size > 0, installed, shimmedTypes: [...installedNames] };
    return report;
  }
  function shimReport() {
    const base = installShims();
    return { ...base, shimmedTypes: [...installedNames] };
  }
  var placeholderState = /* @__PURE__ */ new Map();
  function createAutoLayout(directionOrProps, maybeProps) {
    let direction = "HORIZONTAL";
    let props;
    if (typeof directionOrProps === "string") {
      direction = directionOrProps;
      props = maybeProps;
    } else {
      props = directionOrProps;
    }
    const frame = figma.createFrame();
    frame.layoutMode = direction;
    frame.primaryAxisSizingMode = "AUTO";
    frame.counterAxisSizingMode = "AUTO";
    if (props) applyProps(frame, props);
    return frame;
  }
  async function screenshot(node, opts) {
    const exportable = node;
    if (typeof exportable.exportAsync !== "function") {
      throw new Error(`Node ${node.id} (${node.type}) cannot be exported`);
    }
    let scale = opts?.scale;
    if (scale == null) {
      scale = 0.5;
      const longest = Math.max(exportable.width, exportable.height) * scale;
      if (longest > 1024) scale = 1024 / Math.max(exportable.width, exportable.height);
    }
    const bytes = await exportable.exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: scale },
      contentsOnly: opts?.contentsOnly ?? true
    });
    return {
      type: "image",
      format: "PNG",
      nodeId: node.id,
      name: `${node.name} (${Math.round(exportable.width)}x${Math.round(exportable.height)}).png`,
      width: Math.round(exportable.width * scale),
      height: Math.round(exportable.height * scale),
      scale,
      bytes: encodeBase64(bytes)
    };
  }
  var BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function encodeBase64(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i];
      const b = bytes[i + 1];
      const c = bytes[i + 2];
      const triple = a << 16 | (b ?? 0) << 8 | (c ?? 0);
      out += BASE64_ALPHABET[triple >> 18 & 63];
      out += BASE64_ALPHABET[triple >> 12 & 63];
      out += b === void 0 ? "=" : BASE64_ALPHABET[triple >> 6 & 63];
      out += c === void 0 ? "=" : BASE64_ALPHABET[triple & 63];
    }
    return out;
  }

  // figma-plugin/src/runtime/serialize.ts
  var DEFAULTS = {
    depth: 0,
    geometry: true,
    paints: false,
    layout: false,
    bindings: false,
    componentInfo: true,
    text: true,
    maxChildren: 200
  };
  var MIXED = "MIXED";
  function safe(read) {
    try {
      const value = read();
      if (value === figma.mixed) return MIXED;
      return value === void 0 ? void 0 : value;
    } catch {
      return void 0;
    }
  }
  function rgbToHex(color) {
    const channel = (v) => {
      const n = Math.round(Math.max(0, Math.min(1, v)) * 255);
      return (n < 16 ? "0" : "") + n.toString(16);
    };
    const alpha = color.a;
    const base = `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
    return alpha === void 0 || alpha >= 1 ? base : base + channel(alpha);
  }
  var variableNames = /* @__PURE__ */ new Map();
  var styleNames = /* @__PURE__ */ new Map();
  function resetNameCaches() {
    variableNames.clear();
    styleNames.clear();
  }
  async function variableName(id) {
    if (variableNames.has(id)) return variableNames.get(id);
    let name = null;
    try {
      const variable = await figma.variables.getVariableByIdAsync(id);
      name = variable ? variable.name : null;
    } catch {
      name = null;
    }
    variableNames.set(id, name);
    return name;
  }
  async function styleName(id) {
    if (styleNames.has(id)) return styleNames.get(id);
    let name = null;
    try {
      const style = await figma.getStyleByIdAsync(id);
      name = style ? style.name : null;
    } catch {
      name = null;
    }
    styleNames.set(id, name);
    return name;
  }
  function summarizePaints(paints) {
    if (paints === void 0) return void 0;
    if (paints === figma.mixed || paints === MIXED) return MIXED;
    if (!Array.isArray(paints)) return void 0;
    return paints.map((paint) => {
      const row = { type: paint.type };
      if (paint.visible === false) row.visible = false;
      if (paint.opacity !== void 0 && paint.opacity < 1) row.opacity = paint.opacity;
      if (paint.type === "SOLID") row.color = rgbToHex(paint.color);
      const bound = paint.boundVariables;
      if (bound && bound.color) row.boundVariable = bound.color.id;
      return row;
    });
  }
  async function summarizeBindings(node) {
    const bound = safe(() => node.boundVariables);
    if (!bound || typeof bound !== "object") return void 0;
    const out = {};
    for (const field of Object.keys(bound)) {
      const value = bound[field];
      if (Array.isArray(value)) {
        const rows = [];
        for (const alias of value) {
          if (!alias || !alias.id) continue;
          rows.push({ id: alias.id, name: await variableName(alias.id) });
        }
        if (rows.length) out[field] = rows;
      } else if (value && value.id) {
        const id = value.id;
        out[field] = { id, name: await variableName(id) };
      }
    }
    return Object.keys(out).length ? out : void 0;
  }
  async function summarizeStyles(node) {
    const fields = [
      ["fillStyleId", "fill"],
      ["strokeStyleId", "stroke"],
      ["textStyleId", "text"],
      ["effectStyleId", "effect"],
      ["gridStyleId", "grid"]
    ];
    const out = {};
    for (const [field, label] of fields) {
      const id = safe(() => node[field]);
      if (!id || id === MIXED) {
        if (id === MIXED) out[label] = MIXED;
        continue;
      }
      out[label] = { id, name: await styleName(id) };
    }
    return Object.keys(out).length ? out : void 0;
  }
  var LAYOUT_FIELDS = [
    "layoutMode",
    "layoutWrap",
    "primaryAxisSizingMode",
    "counterAxisSizingMode",
    "primaryAxisAlignItems",
    "counterAxisAlignItems",
    "itemSpacing",
    "counterAxisSpacing",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "layoutSizingHorizontal",
    "layoutSizingVertical",
    "layoutAlign",
    "layoutGrow",
    "layoutPositioning",
    "clipsContent",
    "overflowDirection"
  ];
  var round = (n) => typeof n === "number" ? Math.round(n * 100) / 100 : n;
  async function summarizeNode(node, options) {
    const opts = { ...DEFAULTS, ...options ?? {} };
    const summary = { id: node.id, name: node.name, type: node.type };
    const visible = safe(() => node.visible);
    if (visible === false) summary.visible = false;
    const locked = safe(() => node.locked);
    if (locked === true) summary.locked = true;
    if (opts.geometry) {
      summary.x = round(safe(() => node.x));
      summary.y = round(safe(() => node.y));
      summary.width = round(safe(() => node.width));
      summary.height = round(safe(() => node.height));
      const rotation = safe(() => node.rotation);
      if (typeof rotation === "number" && Math.abs(rotation) > 0.01) summary.rotation = round(rotation);
      const opacity = safe(() => node.opacity);
      if (typeof opacity === "number" && opacity < 1) summary.opacity = round(opacity);
    }
    if (opts.text && node.type === "TEXT") {
      const characters = safe(() => node.characters);
      if (typeof characters === "string") {
        summary.characters = characters.length > 400 ? characters.slice(0, 400) + "\u2026" : characters;
      }
      summary.fontName = safe(() => node.fontName);
      summary.fontSize = safe(() => node.fontSize);
      const missing = safe(() => node.hasMissingFont);
      if (missing) summary.hasMissingFont = true;
    }
    if (opts.layout) {
      const layout = {};
      for (const field of LAYOUT_FIELDS) {
        const value = safe(() => node[field]);
        if (value === void 0 || value === "NONE" || value === null) continue;
        layout[field] = round(value);
      }
      if (Object.keys(layout).length) summary.layout = layout;
    }
    if (opts.paints) {
      const fills = summarizePaints(safe(() => node.fills));
      if (fills) summary.fills = fills;
      const strokes = summarizePaints(safe(() => node.strokes));
      if (strokes && (typeof strokes === "string" || strokes.length)) summary.strokes = strokes;
      const radius = safe(() => node.cornerRadius);
      if (radius !== void 0 && radius !== 0) summary.cornerRadius = round(radius);
      const effects = safe(() => node.effects);
      if (Array.isArray(effects) && effects.length) {
        summary.effects = effects.map((effect) => ({ type: effect.type, visible: effect.visible }));
      }
    }
    if (opts.bindings) {
      const styles = await summarizeStyles(node);
      if (styles) summary.styles = styles;
      const bindings = await summarizeBindings(node);
      if (bindings) summary.boundVariables = bindings;
    }
    if (opts.componentInfo) {
      if (node.type === "INSTANCE") {
        const instance = node;
        const component = {};
        try {
          const main = await instance.getMainComponentAsync();
          if (main) {
            component.mainComponentId = main.id;
            component.mainComponentName = main.name;
            component.key = main.key;
            component.remote = main.remote;
            const set = main.parent && main.parent.type === "COMPONENT_SET" ? main.parent : null;
            if (set) {
              component.componentSetId = set.id;
              component.componentSetName = set.name;
              component.componentSetKey = safe(() => set.key);
            }
          } else {
            component.detached = true;
          }
        } catch {
          component.mainComponentUnavailable = true;
        }
        summary.component = component;
        const properties = safe(() => instance.componentProperties);
        if (properties && properties !== MIXED) {
          const rows = {};
          for (const key of Object.keys(properties)) {
            const entry = properties[key];
            rows[key] = { type: entry.type, value: entry.value };
          }
          summary.componentProperties = rows;
        }
      } else if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
        summary.component = {
          key: safe(() => node.key),
          remote: safe(() => node.remote),
          description: safe(() => node.description)
        };
      }
    }
    const children = safe(() => node.children);
    if (Array.isArray(children)) {
      summary.childCount = children.length;
      if (opts.depth > 0) {
        const slice = children.slice(0, opts.maxChildren);
        summary.children = [];
        for (const child of slice) {
          summary.children.push(await summarizeNode(child, { ...opts, depth: opts.depth - 1 }));
        }
        if (children.length > slice.length) summary.truncatedChildren = children.length - slice.length;
      }
    }
    return summary;
  }
  function nodePath(node) {
    const parts = [];
    let current = node;
    while (current && current.type !== "DOCUMENT") {
      parts.unshift(current.name);
      current = current.parent;
    }
    return parts.join(" / ");
  }
  async function toJson(value, depth = 0, seen = /* @__PURE__ */ new Set()) {
    if (value === null || value === void 0) return value ?? null;
    const kind = typeof value;
    if (kind === "string" || kind === "number" || kind === "boolean") return value;
    if (kind === "function") return `[Function ${value.name || "anonymous"}]`;
    if (kind === "symbol" || kind === "bigint") return String(value);
    if (value === figma.mixed) return MIXED;
    if (depth > 6) return "[max depth]";
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    if (value instanceof Uint8Array) return { type: "bytes", length: value.length };
    if (Array.isArray(value)) {
      const slice = value.slice(0, 500);
      const out2 = [];
      for (const item of slice) out2.push(await toJson(item, depth + 1, seen));
      if (value.length > slice.length) out2.push(`[+${value.length - slice.length} more]`);
      return out2;
    }
    const candidate = value;
    if (typeof candidate.id === "string" && typeof candidate.type === "string" && "name" in value) {
      return await summarizeNode(value, { depth: 0 });
    }
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = await toJson(value[key], depth + 1, seen);
    }
    return out;
  }

  // figma-plugin/src/runtime/journal.ts
  var DATA_KEYS = {
    operation: "ff.operation",
    createdBy: "ff.createdBy",
    quarantinedFrom: "ff.quarantinedFrom",
    module: "ff.module."
  };
  var SCRATCH_PAGE = "\u2699\uFE0E Figma Forge scratch";
  var QUARANTINE_PAGE = "\u26A0\uFE0E Figma Forge quarantine";
  var RESTORABLE = /* @__PURE__ */ new Set([
    "x",
    "y",
    "rotation",
    "opacity",
    "visible",
    "locked",
    "name",
    "blendMode",
    "fills",
    "strokes",
    "strokeWeight",
    "strokeAlign",
    "effects",
    "cornerRadius",
    "topLeftRadius",
    "topRightRadius",
    "bottomLeftRadius",
    "bottomRightRadius",
    "layoutMode",
    "layoutWrap",
    "primaryAxisSizingMode",
    "counterAxisSizingMode",
    "primaryAxisAlignItems",
    "counterAxisAlignItems",
    "itemSpacing",
    "counterAxisSpacing",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "layoutSizingHorizontal",
    "layoutSizingVertical",
    "layoutAlign",
    "layoutGrow",
    "layoutPositioning",
    "clipsContent",
    "constraints",
    "characters",
    "fontSize",
    "fontName",
    "textAlignHorizontal",
    "textAlignVertical",
    "textAutoResize",
    "letterSpacing",
    "lineHeight",
    "textCase",
    "textDecoration",
    "width",
    "height"
  ]);
  var Journal = class {
    constructor(operationId) {
      this.entries = [];
      this.seq = 0;
      this.operationId = operationId;
    }
    get length() {
      return this.entries.length;
    }
    toArray() {
      return [...this.entries];
    }
    record(op, inverse, nodeId, ref) {
      this.entries.push({ seq: this.seq++, op, nodeId, ref, inverse });
    }
    /** Marks a node as ours so recovery and verification can find it later. */
    tag(node) {
      try {
        node.setPluginData(DATA_KEYS.operation, this.operationId);
      } catch {
      }
    }
    recordCreate(op, node, ref) {
      this.tag(node);
      try {
        node.setPluginData(DATA_KEYS.createdBy, this.operationId);
      } catch {
      }
      this.record(op, { kind: "remove", nodeId: node.id }, node.id, ref);
    }
    /** Snapshots only the fields a write is about to touch. */
    recordSet(op, node, fields) {
      const props = {};
      for (const field of fields) {
        if (!RESTORABLE.has(field)) continue;
        const value = safe(() => node[field]);
        if (value === void 0) continue;
        props[field] = cloneValue(value);
      }
      this.tag(node);
      if (Object.keys(props).length === 0) {
        this.record(op, { kind: "none", note: `no restorable fields on ${node.id}` }, node.id);
        return;
      }
      this.record(op, { kind: "restore_props", nodeId: node.id, props }, node.id);
    }
    recordPosition(op, node) {
      const parent = node.parent;
      if (!parent || !("children" in parent)) {
        this.record(op, { kind: "none", note: `${node.id} has no reparentable parent` }, node.id);
        return;
      }
      const index = parent.children.findIndex((child) => child.id === node.id);
      this.tag(node);
      this.record(op, { kind: "reparent", nodeId: node.id, parentId: parent.id, index }, node.id);
    }
  };
  function cloneValue(value) {
    if (Array.isArray(value)) return value.map(cloneValue);
    if (value && typeof value === "object") {
      if (value === figma.mixed) return void 0;
      const out = {};
      for (const key of Object.keys(value)) {
        out[key] = cloneValue(value[key]);
      }
      return out;
    }
    return value;
  }
  async function rollback(entries) {
    const result = { applied: 0, skipped: [], failed: [] };
    const ordered = [...entries].sort((a, b) => b.seq - a.seq);
    for (const entry of ordered) {
      const inverse = entry.inverse;
      try {
        if (inverse.kind === "none") {
          result.skipped.push({ seq: entry.seq, reason: inverse.note });
          continue;
        }
        const node = await figma.getNodeByIdAsync(inverse.nodeId);
        if (!node) {
          result.skipped.push({ seq: entry.seq, reason: `node ${inverse.nodeId} no longer exists` });
          continue;
        }
        switch (inverse.kind) {
          case "remove":
            node.remove();
            break;
          case "restore_props":
            await restoreProps(node, inverse.props);
            break;
          case "reparent": {
            const parent = await figma.getNodeByIdAsync(inverse.parentId);
            if (!parent || !("insertChild" in parent)) {
              result.skipped.push({ seq: entry.seq, reason: `parent ${inverse.parentId} is gone` });
              continue;
            }
            const index = Math.min(inverse.index, parent.children.length);
            parent.insertChild(index, node);
            break;
          }
          case "restore_text": {
            const text = node;
            await loadFontsFor(text);
            text.characters = inverse.characters;
            break;
          }
          case "restore_component_properties":
            node.setProperties(
              inverse.properties
            );
            break;
          case "restore_bindings": {
            const variable = inverse.variableId ? await figma.variables.getVariableByIdAsync(inverse.variableId) : null;
            node.setBoundVariable(
              inverse.field,
              variable
            );
            break;
          }
          case "restore_style": {
            const setter = `set${inverse.field[0].toUpperCase()}${inverse.field.slice(1)}Async`;
            const target = node;
            if (typeof target[setter] === "function") {
              await target[setter](inverse.styleId ?? "");
            } else {
              target[`${inverse.field}Id`] = inverse.styleId ?? "";
            }
            break;
          }
        }
        result.applied++;
      } catch (error) {
        result.failed.push({ seq: entry.seq, error: errorMessage(error) });
      }
    }
    return result;
  }
  async function restoreProps(node, props) {
    const target = node;
    let width;
    let height;
    if ("characters" in props) await loadFontsFor(node);
    for (const key of Object.keys(props)) {
      const value = props[key];
      if (key === "width") {
        width = value;
        continue;
      }
      if (key === "height") {
        height = value;
        continue;
      }
      try {
        target[key] = value;
      } catch {
      }
    }
    if (width !== void 0 || height !== void 0) {
      const resizable = node;
      if (typeof resizable.resize === "function") {
        resizable.resize(width ?? resizable.width, height ?? resizable.height);
      }
    }
  }
  async function loadFontsFor(node) {
    if (!node || node.type !== "TEXT") return;
    const fonts = node.getRangeAllFontNames(0, Math.max(node.characters.length, 1));
    await Promise.all(fonts.map((font) => figma.loadFontAsync(font)));
  }
  function errorMessage(error) {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  async function ensurePage(name) {
    for (const page2 of figma.root.children) {
      if (page2.name === name) {
        await page2.loadAsync();
        return page2;
      }
    }
    const page = figma.createPage();
    page.name = name;
    return page;
  }
  async function quarantine(node, journal) {
    const parent = node.parent;
    const from = parent ? parent.id : "";
    const index = parent && "children" in parent ? parent.children.findIndex((child) => child.id === node.id) : 0;
    const page = await ensurePage(QUARANTINE_PAGE);
    try {
      node.setPluginData(DATA_KEYS.quarantinedFrom, JSON.stringify({ parentId: from, index, at: Date.now() }));
    } catch {
    }
    journal.record("remove", { kind: "reparent", nodeId: node.id, parentId: from, index }, node.id);
    page.appendChild(node);
    return { nodeId: node.id, from };
  }

  // figma-plugin/src/runtime/exec.ts
  var trackingReady = false;
  var recording = null;
  async function ensureChangeTracking() {
    if (trackingReady) return true;
    try {
      await figma.loadAllPagesAsync();
      figma.on("documentchange", (event) => {
        if (!recording) return;
        for (const change of event.documentChanges) {
          const id = change.id;
          if (id) recording.add(id);
        }
      });
      trackingReady = true;
    } catch {
      trackingReady = false;
    }
    return trackingReady;
  }
  async function flushEvents() {
    for (let i = 0; i < 3; i++) {
      try {
        await figma.getNodeByIdAsync(figma.root.id);
      } catch {
        return;
      }
    }
  }
  var MODULE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
  var MODULE_MAX_BYTES = 80 * 1024;
  function hashSource(source) {
    let hash = 2166136261;
    for (let i = 0; i < source.length; i++) {
      hash ^= source.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }
  var compiled = /* @__PURE__ */ new Map();
  function defineModule(name, source) {
    if (!MODULE_NAME.test(name)) {
      throw new Error(`Invalid module name "${name}" \u2014 use letters, digits, dot, dash or underscore.`);
    }
    if (typeof source !== "string" || !source.trim()) {
      throw new Error(`Module "${name}" needs a non-empty source string.`);
    }
    if (source.length > MODULE_MAX_BYTES) {
      throw new Error(`Module "${name}" is ${source.length} bytes; the limit is ${MODULE_MAX_BYTES}.`);
    }
    const record = { name, hash: hashSource(source), source, savedAt: Date.now() };
    figma.root.setPluginData(DATA_KEYS.module + name, JSON.stringify(record));
    compiled.delete(name);
    return record;
  }
  function readModule(name) {
    const raw = safe(() => figma.root.getPluginData(DATA_KEYS.module + name));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  function listModules() {
    const keys = safe(() => figma.root.getPluginDataKeys()) ?? [];
    const out = [];
    for (const key of keys) {
      if (key.indexOf(DATA_KEYS.module) !== 0) continue;
      const record = readModule(key.slice(DATA_KEYS.module.length));
      if (record) out.push({ name: record.name, hash: record.hash, savedAt: record.savedAt, bytes: record.source.length });
    }
    return out;
  }
  function removeModule(name) {
    const existed = !!readModule(name);
    figma.root.setPluginData(DATA_KEYS.module + name, "");
    compiled.delete(name);
    return existed;
  }
  function requireModule(name, expectedHash) {
    const record = readModule(name);
    if (!record) throw new Error(`Module "${name}" is not defined in this document.`);
    if (expectedHash && record.hash !== expectedHash) {
      throw new Error(`Module "${name}" hash is ${record.hash}, expected ${expectedHash}.`);
    }
    if (compiled.has(name)) return compiled.get(name);
    const factory = new Function(
      "module",
      "exports",
      "require",
      "figma",
      '"use strict";\n' + record.source + "\n;return module.exports;"
    );
    const module = { exports: {} };
    const exported = factory(module, module.exports, (dep) => requireModule(dep), figma);
    compiled.set(name, exported);
    return exported;
  }
  var moduleRegistry = {
    define: defineModule,
    require: requireModule,
    list: listModules,
    remove: removeModule,
    hash: hashSource
  };
  var BLOCKED_IN_READ = [
    "createFrame",
    "createRectangle",
    "createEllipse",
    "createLine",
    "createPolygon",
    "createStar",
    "createVector",
    "createText",
    "createComponent",
    "createComponentFromNode",
    "createPage",
    "createSlice",
    "createNodeFromSvg",
    "createImage",
    "createImageAsync",
    "createGif",
    "createLinkPreviewAsync",
    "createVideoAsync",
    "createBooleanOperation",
    "createSection",
    "createSlide",
    "createSlideRow",
    "createAutoLayout",
    "combineAsVariants",
    "group",
    "flatten",
    "union",
    "subtract",
    "intersect",
    "exclude",
    "ungroup",
    "createPaintStyle",
    "createTextStyle",
    "createEffectStyle",
    "createGridStyle",
    "saveVersionHistoryAsync",
    "commitUndo",
    "triggerUndo"
  ];
  function guardedNamespace(target, isBlocked) {
    const facade = {};
    const keys = /* @__PURE__ */ new Set();
    let current = target;
    while (current && current !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(current)) keys.add(key);
      current = Object.getPrototypeOf(current);
    }
    for (const key of keys) {
      if (key === "constructor") continue;
      const reason = isBlocked(key);
      if (reason) {
        Object.defineProperty(facade, key, {
          enumerable: true,
          get: () => () => {
            throw new Error(reason);
          }
        });
        continue;
      }
      Object.defineProperty(facade, key, {
        enumerable: true,
        get() {
          const value = target[key];
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    }
    return facade;
  }
  function readOnlyFigma() {
    const blocked = new Set(BLOCKED_IN_READ);
    const facade = guardedNamespace(
      figma,
      (key) => blocked.has(key) ? `${key}() is blocked in read mode. Re-run with mode "scratch" to build, or "unsafe_in_place" if this must mutate the live document.` : null
    );
    try {
      const variables = guardedNamespace(
        figma.variables,
        (key) => key.indexOf("create") === 0 || key === "setBoundVariableForPaint" ? `figma.variables.${key}() is blocked in read mode.` : null
      );
      Object.defineProperty(facade, "variables", { enumerable: true, get: () => variables });
    } catch {
    }
    return facade;
  }
  var AsyncFunction = Object.getPrototypeOf(async function() {
  }).constructor;
  function isUnder(node, ancestorId) {
    let current = node;
    while (current) {
      if (current.id === ancestorId) return true;
      current = current.parent;
    }
    return false;
  }
  async function execute(params) {
    const mode = params.mode ?? "read";
    const started = Date.now();
    const logs = [];
    if (typeof params.code !== "string" || !params.code.trim()) {
      throw new Error("execute requires a non-empty `code` string.");
    }
    let scratch = null;
    if (mode === "scratch") scratch = await ensurePage(SCRATCH_PAGE);
    let target = null;
    if (params.targetId) {
      target = await figma.getNodeByIdAsync(params.targetId);
      if (!target) throw new Error(`Target node ${params.targetId} was not found.`);
      ensureShims(target);
    }
    const modules = {};
    for (const name of params.use ?? []) modules[name] = requireModule(name);
    const capture = (level) => (...args) => {
      const line = args.map((arg) => {
        if (typeof arg === "string") return arg;
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      }).join(" ");
      logs.push(level === "log" ? line : `[${level}] ${line}`);
      if (logs.length > 500) logs.shift();
    };
    const context = {
      figma: mode === "read" ? readOnlyFigma() : figma,
      target,
      scratch,
      params: params.params ?? {},
      modules,
      bridge: moduleRegistry,
      select: (root, selector) => new QueryResult(select(root, selector)),
      matches,
      set: applyProps,
      createAutoLayout,
      screenshot,
      summarize: summarizeNode,
      rgbToHex,
      loadFonts: loadFontsFor,
      console: { log: capture("log"), warn: capture("warn"), error: capture("error"), info: capture("log") }
    };
    const trackable = await ensureChangeTracking();
    const changes = /* @__PURE__ */ new Set();
    if (trackable) recording = changes;
    let value;
    try {
      const keys = Object.keys(context);
      const values = keys.map((key) => context[key]);
      const fn = compileBody(params.code, keys);
      value = await fn.apply(void 0, values);
    } finally {
      if (trackable) {
        await flushEvents();
        recording = null;
      }
    }
    const violations = [];
    const changedNodes = [...changes];
    if (!trackable) {
      violations.push(
        "Document change tracking is unavailable in this file, so mutations outside the requested scope cannot be detected. Treat the result as unverified."
      );
    } else if (mode === "read" && changedNodes.length) {
      violations.push(`read mode mutated ${changedNodes.length} node(s): ${changedNodes.slice(0, 20).join(", ")}`);
    } else if (mode === "scratch" && scratch) {
      const strays = [];
      for (const id of changedNodes) {
        if (id === scratch.id) continue;
        const node = await figma.getNodeByIdAsync(id).catch(() => null);
        if (node && !isUnder(node, scratch.id)) strays.push(id);
      }
      if (strays.length) {
        violations.push(`scratch mode touched ${strays.length} node(s) outside the scratch page: ${strays.slice(0, 20).join(", ")}`);
      }
    }
    return {
      mode,
      result: await toJson(value),
      logs,
      changedNodes,
      violations,
      scratchPageId: scratch ? scratch.id : void 0,
      durationMs: Date.now() - started
    };
  }
  function compileBody(code, keys) {
    const body = code.trim();
    if (!/\breturn\b/.test(body)) {
      try {
        return new AsyncFunction(...keys, `"use strict"; return (
${body}
);`);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    try {
      return new AsyncFunction(...keys, `"use strict";
${body}
`);
    } catch (error) {
      throw new Error(`Could not compile the script: ${errorMessage(error)}`);
    }
  }

  // figma-plugin/src/runtime/commands/inspect.ts
  var DETAIL_FULL = { paints: true, layout: true, bindings: true, componentInfo: true };
  function detailOptions(detail) {
    return detail === "full" ? { ...DETAIL_FULL } : {};
  }
  async function resolvePage(pageId) {
    if (!pageId) return figma.currentPage;
    const page = await figma.getNodeByIdAsync(pageId);
    if (!page || page.type !== "PAGE") throw new Error(`${pageId} is not a page.`);
    await page.loadAsync();
    return page;
  }
  async function resolveNode(nodeId) {
    if (!nodeId) {
      const selection = figma.currentPage.selection;
      if (selection.length !== 1) {
        throw new Error(
          selection.length === 0 ? "No nodeId given and nothing is selected in Figma." : `No nodeId given and ${selection.length} nodes are selected \u2014 name one explicitly.`
        );
      }
      return selection[0];
    }
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) throw new Error(`Node ${nodeId} was not found. It may have been deleted or live on an unloaded page.`);
    return node;
  }
  async function inspect(params) {
    resetNameCaches();
    const scope = params.scope ?? "selection";
    const limit = params.limit ?? 100;
    switch (scope) {
      case "document": {
        const pages = figma.root.children.map((page) => ({
          id: page.id,
          name: page.name,
          current: page.id === figma.currentPage.id
        }));
        return {
          name: figma.root.name,
          fileKey: figma.fileKey ?? null,
          editorType: figma.editorType,
          currentPageId: figma.currentPage.id,
          pages,
          selection: figma.currentPage.selection.map((node) => ({ id: node.id, name: node.name, type: node.type }))
        };
      }
      case "page": {
        const page = await resolvePage(params.pageId);
        const children = [];
        for (const child of page.children.slice(0, limit)) {
          children.push(await summarizeNode(child, { depth: params.depth ?? 0, ...detailOptions(params.detail) }));
        }
        return {
          id: page.id,
          name: page.name,
          childCount: page.children.length,
          truncated: Math.max(0, page.children.length - children.length),
          children
        };
      }
      case "selection": {
        const selection = figma.currentPage.selection;
        const nodes = [];
        for (const node of selection.slice(0, limit)) {
          nodes.push(await summarizeNode(node, { depth: params.depth ?? 0, ...detailOptions(params.detail) }));
        }
        return { pageId: figma.currentPage.id, pageName: figma.currentPage.name, count: selection.length, nodes };
      }
      case "node": {
        const node = await resolveNode(params.nodeId);
        const summary = await summarizeNode(node, {
          depth: params.depth ?? 1,
          ...detailOptions(params.detail ?? "full"),
          maxChildren: limit
        });
        return { ...summary, path: nodePath(node) };
      }
      case "query": {
        if (!params.selector) throw new Error('scope "query" needs a `selector`.');
        const root = params.nodeId ? await resolveNode(params.nodeId) : await resolvePage(params.pageId);
        const found = select(root, params.selector);
        const nodes = [];
        for (const node of found.slice(0, limit)) {
          nodes.push(await summarizeNode(node, { depth: params.depth ?? 0, ...detailOptions(params.detail) }));
        }
        return {
          rootId: root.id,
          selector: params.selector,
          matched: found.length,
          truncated: Math.max(0, found.length - nodes.length),
          nodes
        };
      }
      case "ancestors": {
        const node = await resolveNode(params.nodeId);
        const chain = [];
        let current = node;
        while (current) {
          chain.unshift({ id: current.id, name: current.name, type: current.type });
          current = current.parent;
        }
        return { nodeId: node.id, ancestors: chain };
      }
      case "screenshot": {
        const node = await resolveNode(params.nodeId);
        return await screenshot(node, { scale: params.scale });
      }
      default:
        throw new Error(`Unknown inspect scope "${scope}".`);
    }
  }

  // figma-plugin/src/runtime/commands/design-system.ts
  var INDEX_SCHEMA_VERSION = 1;
  var LIMITS = {
    components: 4e3,
    instances: 6e3,
    variables: 8e3,
    libraryCollections: 40
  };
  function propertyDefinitions(node) {
    const defs = safe(() => node.componentPropertyDefinitions);
    if (!defs || typeof defs !== "object") return void 0;
    const out = {};
    for (const name of Object.keys(defs)) {
      const def = defs[name];
      out[name] = {
        type: def.type,
        defaultValue: def.defaultValue,
        variantOptions: def.variantOptions ? [...def.variantOptions] : void 0,
        preferredValues: def.preferredValues
      };
    }
    return out;
  }
  function summarizeVariableValue(value) {
    if (value && typeof value === "object") {
      if (value.type === "VARIABLE_ALIAS") {
        return { alias: value.id };
      }
      if ("r" in value) return rgbToHex(value);
    }
    return value;
  }
  async function pagesInScope(params) {
    if (params.scope === "page") {
      const page = params.pageId ? await figma.getNodeByIdAsync(params.pageId) : figma.currentPage;
      if (!page || page.type !== "PAGE") throw new Error(`${params.pageId} is not a page.`);
      await page.loadAsync();
      return [page];
    }
    await figma.loadAllPagesAsync();
    return [...figma.root.children];
  }
  async function buildIndex(params) {
    const warnings = [];
    const pages = await pagesInScope(params);
    const scope = params.scope === "page" ? "page" : "file";
    const components = [];
    let componentTotal = 0;
    for (const page of pages) {
      const found = page.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] });
      componentTotal += found.length;
      for (const node of found) {
        if (components.length >= LIMITS.components) break;
        const isSet = node.type === "COMPONENT_SET";
        const parentSet = !isSet && node.parent && node.parent.type === "COMPONENT_SET" ? node.parent : null;
        components.push({
          id: node.id,
          key: safe(() => node.key) ?? null,
          name: node.name,
          type: node.type,
          remote: safe(() => node.remote) ?? false,
          description: safe(() => node.description) || void 0,
          documentationLinks: safe(() => node.documentationLinks?.map((link) => link.uri)),
          pageId: page.id,
          pageName: page.name,
          setId: parentSet ? parentSet.id : void 0,
          setName: parentSet ? parentSet.name : void 0,
          variantProperties: !isSet ? safe(() => node.variantProperties) ?? null : void 0,
          propertyDefinitions: propertyDefinitions(node),
          variantCount: isSet ? node.children.length : void 0
        });
      }
    }
    if (componentTotal > components.length) {
      warnings.push(`Component scan truncated at ${components.length} of ${componentTotal}.`);
    }
    const toStyleRow = (style) => ({
      id: style.id,
      key: style.key,
      name: style.name,
      remote: style.remote,
      description: safe(() => style.description) || void 0
    });
    const styles = {
      paint: (await figma.getLocalPaintStylesAsync()).map((style) => ({
        ...toStyleRow(style),
        preview: summarizePaintStyle(style)
      })),
      text: (await figma.getLocalTextStylesAsync()).map((style) => ({
        ...toStyleRow(style),
        preview: {
          fontName: safe(() => style.fontName),
          fontSize: safe(() => style.fontSize),
          lineHeight: safe(() => style.lineHeight),
          letterSpacing: safe(() => style.letterSpacing)
        }
      })),
      effect: (await figma.getLocalEffectStylesAsync()).map(toStyleRow),
      grid: (await figma.getLocalGridStylesAsync()).map(toStyleRow)
    };
    const localCollections = await figma.variables.getLocalVariableCollectionsAsync();
    const collections = localCollections.map((collection) => ({
      id: collection.id,
      key: collection.key,
      name: collection.name,
      remote: collection.remote,
      defaultModeId: collection.defaultModeId,
      modes: collection.modes.map((mode) => ({ modeId: mode.modeId, name: mode.name })),
      variableIds: [...collection.variableIds]
    }));
    const localVariables = await figma.variables.getLocalVariablesAsync();
    const variables = [];
    for (const variable of localVariables.slice(0, LIMITS.variables)) {
      const valuesByMode = {};
      for (const modeId of Object.keys(variable.valuesByMode)) {
        valuesByMode[modeId] = summarizeVariableValue(variable.valuesByMode[modeId]);
      }
      variables.push({
        id: variable.id,
        key: variable.key,
        name: variable.name,
        collectionId: variable.variableCollectionId,
        resolvedType: variable.resolvedType,
        scopes: variable.scopes ? [...variable.scopes] : void 0,
        codeSyntax: variable.codeSyntax,
        remote: variable.remote,
        valuesByMode
      });
    }
    if (localVariables.length > variables.length) {
      warnings.push(`Variable scan truncated at ${variables.length} of ${localVariables.length}.`);
    }
    const libraryCollections = [];
    if (params.includeLibraryVariables !== false) {
      try {
        const available = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
        for (const collection of available.slice(0, LIMITS.libraryCollections)) {
          let rows = [];
          try {
            const inCollection = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(collection.key);
            rows = inCollection.map((variable) => ({
              key: variable.key,
              name: variable.name,
              resolvedType: variable.resolvedType
            }));
          } catch (error) {
            warnings.push(`Could not read library collection "${collection.name}": ${errorMessage(error)}`);
          }
          libraryCollections.push({
            key: collection.key,
            name: collection.name,
            libraryName: collection.libraryName,
            variables: rows
          });
        }
      } catch (error) {
        warnings.push(`Team library variables unavailable: ${errorMessage(error)}`);
      }
    }
    const remoteComponentsInUse = [];
    if (params.includeRemoteInUse !== false) {
      const byKey = /* @__PURE__ */ new Map();
      let scanned = 0;
      let instanceTotal = 0;
      for (const page of pages) {
        const instances = page.findAllWithCriteria({ types: ["INSTANCE"] });
        instanceTotal += instances.length;
        for (const instance of instances) {
          if (scanned >= LIMITS.instances) break;
          scanned++;
          let main = null;
          try {
            main = await instance.getMainComponentAsync();
          } catch {
            continue;
          }
          if (!main || !main.remote) continue;
          const key = safe(() => main.key);
          if (!key) continue;
          const set = main.parent && main.parent.type === "COMPONENT_SET" ? main.parent : null;
          const row = byKey.get(key) ?? {
            name: main.name,
            setKey: set ? safe(() => set.key) : void 0,
            setName: set ? set.name : void 0,
            count: 0,
            samples: []
          };
          row.count++;
          if (row.samples.length < 5) row.samples.push(instance.id);
          byKey.set(key, row);
        }
      }
      if (instanceTotal > scanned) {
        warnings.push(
          `Instance scan truncated at ${scanned} of ${instanceTotal}; remote component usage counts are a lower bound.`
        );
      }
      for (const [key, row] of byKey) {
        remoteComponentsInUse.push({
          key,
          name: row.name,
          setKey: row.setKey,
          setName: row.setName,
          instanceCount: row.count,
          sampleInstanceIds: row.samples
        });
      }
      remoteComponentsInUse.sort((a, b) => b.instanceCount - a.instanceCount);
    }
    return {
      schemaVersion: INDEX_SCHEMA_VERSION,
      builtAt: Date.now(),
      fileKey: figma.fileKey ?? null,
      documentName: figma.root.name,
      scope,
      scopePageIds: pages.map((page) => page.id),
      components,
      styles,
      collections,
      variables,
      libraryCollections,
      remoteComponentsInUse,
      stats: {
        components: components.length,
        paintStyles: styles.paint.length,
        textStyles: styles.text.length,
        effectStyles: styles.effect.length,
        gridStyles: styles.grid.length,
        collections: collections.length,
        variables: variables.length,
        libraryCollections: libraryCollections.length,
        remoteComponentsInUse: remoteComponentsInUse.length
      },
      warnings
    };
  }
  function summarizePaintStyle(style) {
    const paints = safe(() => style.paints);
    if (!Array.isArray(paints) || !paints.length) return void 0;
    const first = paints[0];
    if (first.type === "SOLID") {
      return { type: "SOLID", color: rgbToHex(first.color), opacity: first.opacity };
    }
    return { type: first.type };
  }
  async function resolveComponent(params) {
    let node = null;
    if (params.key) {
      try {
        node = await figma.importComponentByKeyAsync(params.key);
      } catch {
        try {
          node = await figma.importComponentSetByKeyAsync(params.key);
        } catch (error) {
          throw new Error(`Could not import component key "${params.key}": ${errorMessage(error)}`);
        }
      }
    } else if (params.nodeId) {
      node = await figma.getNodeByIdAsync(params.nodeId);
    } else {
      throw new Error("resolve needs either a component `key` or a `nodeId`.");
    }
    if (!node) throw new Error("Component not found.");
    if (node.type === "INSTANCE") {
      const main = await node.getMainComponentAsync();
      if (!main) throw new Error(`Instance ${node.id} is detached \u2014 it has no main component.`);
      node = main;
    }
    if (node.type !== "COMPONENT" && node.type !== "COMPONENT_SET") {
      throw new Error(`${node.id} is a ${node.type}, not a component.`);
    }
    const component = node;
    const set = component.type === "COMPONENT" && component.parent && component.parent.type === "COMPONENT_SET" ? component.parent : component.type === "COMPONENT_SET" ? component : null;
    const variants = set?.children.map((child) => ({
      id: child.id,
      key: safe(() => child.key),
      name: child.name,
      variantProperties: safe(() => child.variantProperties)
    })) ?? [];
    return {
      id: component.id,
      key: safe(() => component.key),
      name: component.name,
      type: component.type,
      remote: safe(() => component.remote) ?? false,
      description: safe(() => component.description) || void 0,
      setId: set ? set.id : void 0,
      setKey: set ? safe(() => set.key) : void 0,
      setName: set ? set.name : void 0,
      propertyDefinitions: propertyDefinitions(set ?? component),
      variants,
      // What a caller must send to `apply_plan.create_instance`.
      usage: {
        componentKey: safe(() => (set ?? component).key) ?? null,
        note: set && set.children.length > 1 ? "Pick a variant by passing every variant property in `properties`." : "No variants \u2014 `properties` only needs the non-variant component properties you want to override."
      }
    };
  }
  async function importAsset(params) {
    if (params.componentKey) {
      try {
        const component = await figma.importComponentByKeyAsync(params.componentKey);
        return { kind: "COMPONENT", id: component.id, name: component.name, key: component.key };
      } catch {
        const set = await figma.importComponentSetByKeyAsync(params.componentKey);
        return { kind: "COMPONENT_SET", id: set.id, name: set.name, key: set.key };
      }
    }
    if (params.variableKey) {
      const variable = await figma.variables.importVariableByKeyAsync(params.variableKey);
      return {
        kind: "VARIABLE",
        id: variable.id,
        name: variable.name,
        key: variable.key,
        resolvedType: variable.resolvedType,
        collectionId: variable.variableCollectionId
      };
    }
    if (params.styleKey) {
      const style = await figma.importStyleByKeyAsync(params.styleKey);
      return { kind: style.type, id: style.id, name: style.name, key: style.key };
    }
    throw new Error("import needs one of `componentKey`, `variableKey` or `styleKey`.");
  }
  async function designSystem(params) {
    resetNameCaches();
    switch (params.action ?? "index") {
      case "index":
        return await buildIndex(params);
      case "resolve":
        return await resolveComponent(params);
      case "variables": {
        const index = await buildIndex({ ...params, includeRemoteInUse: false });
        return {
          collections: index.collections,
          variables: index.variables,
          libraryCollections: index.libraryCollections,
          warnings: index.warnings
        };
      }
      case "import":
        return await importAsset(params);
      default:
        throw new Error(`Unknown design_system action "${params.action}".`);
    }
  }

  // figma-plugin/src/runtime/commands/apply-plan.ts
  var RAW_PRIMITIVE_OPS = /* @__PURE__ */ new Set(["create_frame", "create_text", "create_rectangle", "create_ellipse", "create_from_svg"]);
  var PlanScope = class {
    constructor(scratch) {
      this.refs = /* @__PURE__ */ new Map();
      this.scratch = scratch;
    }
    bind(ref, node) {
      if (ref) this.refs.set(ref.replace(/^\$/, ""), node);
    }
    /**
     * `$ref` names an earlier op's output; `@selection` and `@page` name live
     * editor state; anything else is a node id.
     */
    async resolve(reference, what) {
      if (typeof reference !== "string" || !reference) {
        throw new Error(`${what} is required and must be a node id, "$ref", "@selection" or "@page".`);
      }
      if (reference.charAt(0) === "$") {
        const node2 = this.refs.get(reference.slice(1));
        if (!node2) throw new Error(`${what} refers to "${reference}", which no earlier op defined.`);
        return node2;
      }
      if (reference === "@page") return figma.currentPage;
      if (reference === "@scratch") {
        if (!this.scratch) throw new Error('"@scratch" needs the plan to set `scratch: true`.');
        return this.scratch;
      }
      if (reference === "@selection") {
        const selection = figma.currentPage.selection;
        if (selection.length !== 1) {
          throw new Error(`"@selection" needs exactly one selected node; ${selection.length} are selected.`);
        }
        return selection[0];
      }
      const node = await figma.getNodeByIdAsync(reference);
      if (!node) throw new Error(`${what} refers to node ${reference}, which does not exist.`);
      return node;
    }
    async resolveParent(reference, what) {
      const node = await this.resolve(reference, what);
      if (!("appendChild" in node)) throw new Error(`${what} (${node.id}) is a ${node.type} and cannot hold children.`);
      return node;
    }
  };
  async function importComponent(op) {
    const key = op.componentKey;
    const id = op.componentId;
    let node = null;
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
      throw new Error("create_instance needs `componentKey` or `componentId`.");
    }
    if (!node) throw new Error(`Component ${key ?? id} was not found.`);
    if (node.type === "COMPONENT_SET") {
      const set = node;
      const variant = set.defaultVariant ?? set.children[0];
      if (!variant) throw new Error(`Component set ${set.name} has no variants.`);
      return variant;
    }
    if (node.type !== "COMPONENT") throw new Error(`${node.id} is a ${node.type}, not a component.`);
    return node;
  }
  function checkProperties(instance, properties) {
    const problems = [];
    const current = safe(() => instance.componentProperties);
    if (!current) return problems;
    for (const name of Object.keys(properties)) {
      const exact = current[name];
      const suffixed = !exact ? Object.keys(current).find((key) => key.split("#")[0] === name) : void 0;
      if (!exact && !suffixed) {
        problems.push(`"${name}" is not a property of ${instance.name} (has: ${Object.keys(current).join(", ") || "none"})`);
      }
    }
    return problems;
  }
  function normalizeProperties(instance, properties) {
    const current = safe(() => instance.componentProperties);
    if (!current) return properties;
    const out = {};
    for (const name of Object.keys(properties)) {
      if (name in current) {
        out[name] = properties[name];
        continue;
      }
      const match = Object.keys(current).find((key) => key.split("#")[0] === name);
      out[match ?? name] = properties[name];
    }
    return out;
  }
  async function resolveVariable(op) {
    if (op.variableKey) return await figma.variables.importVariableByKeyAsync(op.variableKey);
    if (op.variableId) {
      const variable = await figma.variables.getVariableByIdAsync(op.variableId);
      if (!variable) throw new Error(`Variable ${op.variableId} was not found.`);
      return variable;
    }
    throw new Error("This op needs `variableKey` or `variableId`.");
  }
  var STYLE_SETTERS = {
    fill: "setFillStyleIdAsync",
    stroke: "setStrokeStyleIdAsync",
    text: "setTextStyleIdAsync",
    effect: "setEffectStyleIdAsync",
    grid: "setGridStyleIdAsync"
  };
  async function applyPlan(plan) {
    if (!plan || !Array.isArray(plan.ops)) throw new Error("A plan needs an `ops` array.");
    const operationId = plan.operationId || `ff-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const dryRun = plan.dryRun === true;
    const journal = new Journal(operationId);
    const results = [];
    const created = [];
    const modified = [];
    const quarantined = [];
    const offRamps = [];
    const scratchPage = plan.scratch && !dryRun ? await ensurePage(SCRATCH_PAGE) : null;
    const scope = new PlanScope(scratchPage);
    if (!plan.allowRawPrimitives) {
      const unjustified = plan.ops.map((op, index) => ({ op, index })).filter(({ op }) => RAW_PRIMITIVE_OPS.has(op.op) && !(typeof op.reason === "string" && op.reason.trim().length > 3));
      if (unjustified.length) {
        const list = unjustified.map(({ op, index }) => `#${index} ${op.op}`).join(", ");
        throw new Error(
          `${unjustified.length} op(s) create raw primitives without a \`reason\`: ${list}. Either use a design-system component, or state why no component fits (set \`allowRawPrimitives: true\` to bypass entirely).`
        );
      }
    }
    for (let index = 0; index < plan.ops.length; index++) {
      const op = plan.ops[index];
      if (RAW_PRIMITIVE_OPS.has(op.op) && typeof op.reason === "string") {
        offRamps.push({ index, op: op.op, reason: op.reason });
      }
    }
    if (!dryRun) {
      try {
        figma.commitUndo();
      } catch {
      }
    }
    let failure;
    for (let index = 0; index < plan.ops.length; index++) {
      const op = plan.ops[index];
      const row = { index, op: op.op, status: dryRun ? "validated" : "applied", ref: op.ref };
      try {
        switch (op.op) {
          case "create_instance": {
            const parent = await scope.resolveParent(op.parent, `op #${index} \`parent\``);
            const component = await importComponent(op);
            if (dryRun) {
              row.detail = { component: component.name, componentId: component.id, parent: parent.id };
              break;
            }
            const instance = component.createInstance();
            insert(parent, instance, op.index);
            if (op.name) instance.name = op.name;
            if (op.properties) {
              const problems = checkProperties(instance, op.properties);
              if (problems.length) throw new Error(problems.join("; "));
              instance.setProperties(
                normalizeProperties(instance, op.properties)
              );
            }
            if (op.set) applyProps(instance, op.set);
            journal.recordCreate(op.op, instance, op.ref);
            scope.bind(op.ref, instance);
            created.push(instance.id);
            row.nodeId = instance.id;
            break;
          }
          case "create_frame": {
            const parent = await scope.resolveParent(op.parent, `op #${index} \`parent\``);
            if (dryRun) {
              row.detail = { parent: parent.id };
              break;
            }
            const frame = figma.createFrame();
            insert(parent, frame, op.index);
            if (op.name) frame.name = op.name;
            if (op.autoLayout) {
              frame.layoutMode = op.autoLayout;
              frame.primaryAxisSizingMode = "AUTO";
              frame.counterAxisSizingMode = "AUTO";
            }
            if (op.set) applyProps(frame, op.set);
            journal.recordCreate(op.op, frame, op.ref);
            scope.bind(op.ref, frame);
            created.push(frame.id);
            row.nodeId = frame.id;
            break;
          }
          case "create_text": {
            const parent = await scope.resolveParent(op.parent, `op #${index} \`parent\``);
            if (dryRun) {
              row.detail = { parent: parent.id, characters: String(op.characters ?? "") };
              break;
            }
            const text = figma.createText();
            insert(parent, text, op.index);
            await figma.loadFontAsync(text.fontName);
            if (op.textStyleKey) {
              const style = await figma.importStyleByKeyAsync(op.textStyleKey);
              await text.setTextStyleIdAsync(style.id);
              await loadFontsFor(text);
            }
            if (typeof op.characters === "string") text.characters = op.characters;
            if (op.name) text.name = op.name;
            if (op.set) applyProps(text, op.set);
            journal.recordCreate(op.op, text, op.ref);
            scope.bind(op.ref, text);
            created.push(text.id);
            row.nodeId = text.id;
            break;
          }
          case "create_from_svg": {
            const parent = await scope.resolveParent(op.parent, `op #${index} \`parent\``);
            if (typeof op.svg !== "string") throw new Error("create_from_svg needs an `svg` string.");
            if (dryRun) {
              row.detail = { parent: parent.id, bytes: op.svg.length };
              break;
            }
            const node = figma.createNodeFromSvg(op.svg);
            insert(parent, node, op.index);
            if (op.name) node.name = op.name;
            if (op.set) applyProps(node, op.set);
            journal.recordCreate(op.op, node, op.ref);
            scope.bind(op.ref, node);
            created.push(node.id);
            row.nodeId = node.id;
            break;
          }
          case "clone": {
            const source = await scope.resolve(op.node, `op #${index} \`node\``);
            if (dryRun) {
              row.detail = { source: source.id };
              break;
            }
            const clone = source.clone();
            const parent = op.parent ? await scope.resolveParent(op.parent, `op #${index} \`parent\``) : source.parent;
            insert(parent, clone, op.index);
            journal.recordCreate(op.op, clone, op.ref);
            scope.bind(op.ref, clone);
            created.push(clone.id);
            row.nodeId = clone.id;
            break;
          }
          case "set": {
            const node = await scope.resolve(op.node, `op #${index} \`node\``);
            const props = op.props ?? {};
            row.nodeId = node.id;
            if (dryRun) {
              row.detail = { fields: Object.keys(props) };
              break;
            }
            if ("characters" in props || "fontName" in props || "fontSize" in props) {
              await loadFontsFor(node);
              if (props.fontName) await figma.loadFontAsync(props.fontName);
            }
            journal.recordSet(op.op, node, Object.keys(props));
            applyProps(node, props);
            modified.push(node.id);
            break;
          }
          case "set_text": {
            const node = await scope.resolve(op.node, `op #${index} \`node\``);
            if (node.type !== "TEXT") throw new Error(`set_text needs a TEXT node; ${node.id} is a ${node.type}.`);
            row.nodeId = node.id;
            if (dryRun) break;
            const text = node;
            await loadFontsFor(text);
            journal.record(op.op, { kind: "restore_text", nodeId: text.id, characters: text.characters }, text.id);
            journal.tag(node);
            text.characters = String(op.characters ?? "");
            modified.push(node.id);
            break;
          }
          case "set_component_properties": {
            const node = await scope.resolve(op.node, `op #${index} \`node\``);
            if (node.type !== "INSTANCE") {
              throw new Error(`set_component_properties needs an INSTANCE; ${node.id} is a ${node.type}.`);
            }
            const instance = node;
            const properties = op.properties ?? {};
            const problems = checkProperties(instance, properties);
            if (problems.length) throw new Error(problems.join("; "));
            row.nodeId = node.id;
            if (dryRun) {
              row.detail = { properties: Object.keys(properties) };
              break;
            }
            const before = safe(() => instance.componentProperties);
            if (before) {
              const restore = {};
              for (const key of Object.keys(normalizeProperties(instance, properties))) {
                if (before[key]) restore[key] = before[key].value;
              }
              journal.record(op.op, { kind: "restore_component_properties", nodeId: instance.id, properties: restore }, instance.id);
            }
            journal.tag(node);
            instance.setProperties(
              normalizeProperties(instance, properties)
            );
            modified.push(node.id);
            break;
          }
          case "swap_instance": {
            const node = await scope.resolve(op.node, `op #${index} \`node\``);
            if (node.type !== "INSTANCE") throw new Error(`swap_instance needs an INSTANCE; ${node.id} is a ${node.type}.`);
            const component = await importComponent(op);
            row.nodeId = node.id;
            if (dryRun) {
              row.detail = { to: component.name, componentId: component.id };
              break;
            }
            const instance = node;
            const previous = await instance.getMainComponentAsync();
            journal.record(
              op.op,
              previous ? { kind: "restore_props", nodeId: instance.id, props: {} } : { kind: "none", note: `${instance.id} had no main component to restore` },
              instance.id
            );
            journal.tag(node);
            instance.swapComponent(component);
            modified.push(node.id);
            row.detail = { from: previous ? previous.name : null, to: component.name };
            break;
          }
          case "bind_variable": {
            const node = await scope.resolve(op.node, `op #${index} \`node\``);
            const field = String(op.field ?? "");
            if (!field) throw new Error("bind_variable needs a `field`.");
            const variable = await resolveVariable(op);
            row.nodeId = node.id;
            if (dryRun) {
              row.detail = { field, variable: variable.name, resolvedType: variable.resolvedType };
              break;
            }
            const bound = safe(() => node.boundVariables);
            const previous = bound && bound[field] ? bound[field].id : null;
            journal.record(op.op, { kind: "restore_bindings", nodeId: node.id, field, variableId: previous }, node.id);
            journal.tag(node);
            node.setBoundVariable(field, variable);
            modified.push(node.id);
            break;
          }
          case "bind_paint_variable": {
            const node = await scope.resolve(op.node, `op #${index} \`node\``);
            const target = op.target ?? "fills";
            const paintIndex = typeof op.paintIndex === "number" ? op.paintIndex : 0;
            const variable = await resolveVariable(op);
            row.nodeId = node.id;
            if (dryRun) {
              row.detail = { target, paintIndex, variable: variable.name };
              break;
            }
            const paints = safe(() => node[target]);
            if (!Array.isArray(paints) || !paints[paintIndex]) {
              throw new Error(`${node.id} has no ${target}[${paintIndex}] to bind.`);
            }
            journal.recordSet(op.op, node, [target]);
            const next = paints.map(
              (paint, i) => i === paintIndex ? figma.variables.setBoundVariableForPaint(paint, "color", variable) : paint
            );
            node[target] = next;
            modified.push(node.id);
            break;
          }
          case "apply_style": {
            const node = await scope.resolve(op.node, `op #${index} \`node\``);
            const kind = String(op.kind ?? "fill");
            const setter = STYLE_SETTERS[kind];
            if (!setter) throw new Error(`apply_style kind must be one of ${Object.keys(STYLE_SETTERS).join(", ")}.`);
            const style = op.styleKey ? await figma.importStyleByKeyAsync(op.styleKey) : await figma.getStyleByIdAsync(String(op.styleId ?? ""));
            if (!style) throw new Error(`Style ${op.styleKey ?? op.styleId} was not found.`);
            row.nodeId = node.id;
            if (dryRun) {
              row.detail = { kind, style: style.name };
              break;
            }
            const field = `${kind}Style`;
            const previous = safe(() => node[`${field}Id`]) ?? null;
            journal.record(op.op, { kind: "restore_style", nodeId: node.id, field, styleId: previous }, node.id);
            journal.tag(node);
            if (kind === "text") await loadFontsFor(node);
            await node[setter](style.id);
            modified.push(node.id);
            break;
          }
          case "move": {
            const node = await scope.resolve(op.node, `op #${index} \`node\``);
            const parent = await scope.resolveParent(op.parent, `op #${index} \`parent\``);
            row.nodeId = node.id;
            if (dryRun) {
              row.detail = { to: parent.id };
              break;
            }
            journal.recordPosition(op.op, node);
            insert(parent, node, op.index);
            modified.push(node.id);
            break;
          }
          case "reorder": {
            const node = await scope.resolve(op.node, `op #${index} \`node\``);
            const parent = node.parent;
            if (!parent) throw new Error(`${node.id} has no parent to reorder within.`);
            row.nodeId = node.id;
            if (dryRun) break;
            journal.recordPosition(op.op, node);
            parent.insertChild(clampIndex(parent, op.index), node);
            modified.push(node.id);
            break;
          }
          case "rename": {
            const node = await scope.resolve(op.node, `op #${index} \`node\``);
            row.nodeId = node.id;
            if (dryRun) break;
            journal.recordSet(op.op, node, ["name"]);
            node.name = String(op.name ?? node.name);
            modified.push(node.id);
            break;
          }
          case "resize": {
            const node = await scope.resolve(op.node, `op #${index} \`node\``);
            row.nodeId = node.id;
            if (dryRun) break;
            const target = node;
            if (typeof target.resize !== "function") throw new Error(`${node.id} (${node.type}) cannot be resized.`);
            journal.recordSet(op.op, node, ["width", "height"]);
            target.resize(
              typeof op.width === "number" ? op.width : target.width,
              typeof op.height === "number" ? op.height : target.height
            );
            modified.push(node.id);
            break;
          }
          case "remove": {
            const node = await scope.resolve(op.node, `op #${index} \`node\``);
            row.nodeId = node.id;
            if (dryRun) {
              row.detail = { willQuarantine: true };
              break;
            }
            const parked = await quarantine(node, journal);
            quarantined.push(parked.nodeId);
            break;
          }
          case "set_selection": {
            const ids = op.nodes ?? [];
            if (dryRun) {
              row.detail = { count: ids.length };
              break;
            }
            const nodes = [];
            for (const id of ids) nodes.push(await scope.resolve(id, "set_selection node"));
            figma.currentPage.selection = nodes;
            row.detail = { count: nodes.length };
            break;
          }
          case "scroll_into_view": {
            const node = await scope.resolve(op.node, `op #${index} \`node\``);
            row.nodeId = node.id;
            if (dryRun) break;
            figma.viewport.scrollAndZoomIntoView([node]);
            break;
          }
          default:
            throw new Error(`Unknown op "${op.op}".`);
        }
      } catch (error) {
        row.status = "failed";
        row.error = errorMessage(error);
        results.push(row);
        failure = `op #${index} (${op.op}): ${row.error}`;
        for (let rest = index + 1; rest < plan.ops.length; rest++) {
          results.push({ index: rest, op: plan.ops[rest].op, status: "skipped" });
        }
        break;
      }
      results.push(row);
    }
    const result = {
      operationId,
      dryRun,
      ok: !failure,
      applied: results.filter((row) => row.status === "applied").length,
      results,
      created,
      modified: [...new Set(modified)],
      quarantined,
      offRamps,
      journal: journal.toArray(),
      scratchPageId: scratchPage ? scratchPage.id : void 0,
      error: failure
    };
    if (failure && !dryRun && plan.rollbackOnError !== false) {
      result.rolledBack = await rollback(journal.toArray());
    }
    if (!dryRun) {
      try {
        figma.commitUndo();
      } catch {
      }
    }
    return result;
  }
  function insert(parent, node, index) {
    if (typeof index === "number") parent.insertChild(clampIndex(parent, index), node);
    else parent.appendChild(node);
  }
  function clampIndex(parent, index) {
    if (typeof index !== "number" || Number.isNaN(index)) return parent.children.length;
    return Math.max(0, Math.min(index, parent.children.length));
  }

  // figma-plugin/src/runtime/commands/verify.ts
  var SEVERITY_ORDER = { error: 3, warning: 2, info: 1 };
  var RULES = [
    "hardcoded-fill",
    "hardcoded-stroke",
    "hardcoded-text-style",
    "unbound-spacing",
    "detached-instance",
    "missing-autolayout",
    "zero-size",
    "missing-font",
    "broken-style",
    "broken-variable",
    "invalid-component-property",
    "sibling-overlap",
    "off-canvas"
  ];
  async function collect(params) {
    const maxNodes = params.maxNodes ?? 3e3;
    let root;
    switch (params.scope ?? "selection") {
      case "node": {
        if (!params.nodeId) throw new Error('scope "node" needs a `nodeId`.');
        const node = await figma.getNodeByIdAsync(params.nodeId);
        if (!node) throw new Error(`Node ${params.nodeId} was not found.`);
        root = node;
        break;
      }
      case "page": {
        const page = params.pageId ? await figma.getNodeByIdAsync(params.pageId) : figma.currentPage;
        if (!page || page.type !== "PAGE") throw new Error(`${params.pageId} is not a page.`);
        await page.loadAsync();
        root = page;
        break;
      }
      case "operation": {
        await figma.loadAllPagesAsync();
        const tagged = figma.root.findAll((node) => {
          const value = safe(() => node.getPluginData(DATA_KEYS.operation));
          return !!value && (!params.operationId || value === params.operationId);
        });
        return { nodes: tagged.slice(0, maxNodes), root: figma.root, truncated: Math.max(0, tagged.length - maxNodes) };
      }
      default: {
        const selection = figma.currentPage.selection;
        if (!selection.length) throw new Error('Nothing is selected \u2014 pass a `nodeId` or use scope "page".');
        const nodes = [];
        for (const node of selection) {
          nodes.push(node);
          if ("findAll" in node) nodes.push(...node.findAll(() => true));
        }
        return { nodes: nodes.slice(0, maxNodes), root: selection[0], truncated: Math.max(0, nodes.length - maxNodes) };
      }
    }
    const all = [root];
    if ("findAll" in root) all.push(...root.findAll(() => true));
    return { nodes: all.slice(0, maxNodes), root, truncated: Math.max(0, all.length - maxNodes) };
  }
  function hasBinding(node, ...fields) {
    const bound = safe(() => node.boundVariables);
    if (!bound) return false;
    return fields.some((field) => {
      const value = bound[field];
      return Array.isArray(value) ? value.length > 0 : !!value;
    });
  }
  function paintsAreBound(node, field) {
    const paints = safe(() => node[field]);
    if (!Array.isArray(paints)) return true;
    const visible = paints.filter((paint) => paint.visible !== false);
    if (!visible.length) return true;
    return visible.every((paint) => {
      if (paint.type !== "SOLID") return true;
      const bound = paint.boundVariables;
      return !!(bound && bound.color);
    });
  }
  var AUTO_LAYOUT_SPACING = ["itemSpacing", "counterAxisSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft"];
  var CONTAINER_TYPES = /* @__PURE__ */ new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE"]);
  function overlapArea(a, b) {
    const ax2 = a.x + a.width;
    const ay2 = a.y + a.height;
    const bx2 = b.x + b.width;
    const by2 = b.y + b.height;
    const width = Math.min(ax2, bx2) - Math.max(a.x, b.x);
    const height = Math.min(ay2, by2) - Math.max(a.y, b.y);
    return width > 0 && height > 0 ? width * height : 0;
  }
  async function verify(params) {
    const { nodes, truncated } = await collect(params);
    const minSeverity = SEVERITY_ORDER[params.minSeverity ?? "warning"];
    const only = params.rules && params.rules.length ? new Set(params.rules) : null;
    const ignore = new Set(params.ignore ?? []);
    const limit = params.limit ?? 300;
    const violations = [];
    const enabled = (rule) => (only ? only.has(rule) : true) && !ignore.has(rule);
    const push = (node, rule, severity, message, hint) => {
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
        hint
      });
    };
    for (const node of nodes) {
      if (node.type === "PAGE" || node.type === "DOCUMENT") continue;
      const visible = safe(() => node.visible);
      if (enabled("hardcoded-fill") && !safe(() => node.fillStyleId)) {
        if (!paintsAreBound(node, "fills") && !hasBinding(node, "fills")) {
          const summary = summarizePaints(safe(() => node.fills));
          const colors = Array.isArray(summary) ? summary.filter((paint) => paint.color).map((paint) => paint.color).join(", ") : "";
          if (colors) {
            push(
              node,
              "hardcoded-fill",
              "error",
              `Fill ${colors} is a raw colour with no variable or style behind it.`,
              "Bind a colour variable with `bind_paint_variable`, or apply a paint style with `apply_style`."
            );
          }
        }
      }
      if (enabled("hardcoded-stroke") && !safe(() => node.strokeStyleId)) {
        const strokes = safe(() => node.strokes);
        if (Array.isArray(strokes) && strokes.length && !paintsAreBound(node, "strokes")) {
          push(node, "hardcoded-stroke", "error", "Stroke colour is not bound to a variable or style.");
        }
      }
      if (node.type === "TEXT") {
        if (enabled("hardcoded-text-style") && !safe(() => node.textStyleId)) {
          push(
            node,
            "hardcoded-text-style",
            "warning",
            "Text has no text style applied; its type settings are local overrides.",
            'Apply a text style with `apply_style { kind: "text" }`.'
          );
        }
        if (enabled("missing-font") && safe(() => node.hasMissingFont)) {
          push(node, "missing-font", "error", "Text uses a font that is not available in this file.");
        }
      }
      const layoutMode = safe(() => node.layoutMode);
      if (layoutMode && layoutMode !== "NONE") {
        if (enabled("unbound-spacing")) {
          const unbound = AUTO_LAYOUT_SPACING.filter((field) => {
            const value = safe(() => node[field]);
            return typeof value === "number" && value > 0 && !hasBinding(node, field);
          });
          if (unbound.length) {
            push(
              node,
              "unbound-spacing",
              "warning",
              `Spacing is hardcoded: ${unbound.join(", ")}.`,
              "Bind a spacing variable with `bind_variable`."
            );
          }
        }
      } else if (enabled("missing-autolayout") && CONTAINER_TYPES.has(node.type) && node.type !== "INSTANCE") {
        const children = safe(() => node.children);
        if (Array.isArray(children) && children.filter((child) => child.visible !== false).length > 1) {
          push(
            node,
            "missing-autolayout",
            "warning",
            `${node.type} holds ${children.length} children but has no auto layout, so it will not reflow.`,
            "Set `layoutMode` to HORIZONTAL or VERTICAL."
          );
        }
      }
      if (node.type === "INSTANCE" && enabled("detached-instance")) {
        try {
          const main = await node.getMainComponentAsync();
          if (!main) push(node, "detached-instance", "error", "Instance has lost its main component.");
        } catch {
          push(node, "detached-instance", "warning", "Instance main component could not be resolved.");
        }
      }
      if (node.type === "INSTANCE" && enabled("invalid-component-property")) {
        const properties = safe(() => node.componentProperties);
        if (properties && typeof properties === "object") {
          for (const name of Object.keys(properties)) {
            const entry = properties[name];
            if (entry.type !== "VARIANT") continue;
            if (entry.value === void 0 || entry.value === null || entry.value === "") {
              push(node, "invalid-component-property", "error", `Variant property "${name}" has no value.`);
            }
          }
        }
      }
      if (enabled("zero-size")) {
        const width = safe(() => node.width);
        const height = safe(() => node.height);
        if (typeof width === "number" && typeof height === "number" && visible !== false && (width < 1 || height < 1)) {
          push(node, "zero-size", "error", `Node is ${Math.round(width)}\xD7${Math.round(height)} and effectively invisible.`);
        }
      }
      if (enabled("broken-style")) {
        for (const field of ["fillStyleId", "strokeStyleId", "textStyleId", "effectStyleId"]) {
          const id = safe(() => node[field]);
          if (!id || typeof id !== "string" || id === "MIXED") continue;
          const style = await figma.getStyleByIdAsync(id).catch(() => null);
          if (!style) push(node, "broken-style", "error", `${field} points at a style that no longer resolves.`);
        }
      }
      if (enabled("broken-variable")) {
        const bound = safe(() => node.boundVariables);
        if (bound) {
          for (const field of Object.keys(bound)) {
            const value = bound[field];
            const aliases = Array.isArray(value) ? value : [value];
            for (const alias of aliases) {
              if (!alias || !alias.id) continue;
              const variable = await figma.variables.getVariableByIdAsync(alias.id).catch(() => null);
              if (!variable) {
                push(node, "broken-variable", "error", `Bound variable on "${field}" no longer resolves (${alias.id}).`);
              }
            }
          }
        }
      }
      if (enabled("sibling-overlap") && (!layoutMode || layoutMode === "NONE")) {
        const children = safe(() => node.children);
        if (Array.isArray(children) && children.length > 1 && children.length < 60) {
          const laid = children.filter(
            (child) => child.visible !== false && safe(() => child.layoutPositioning) !== "ABSOLUTE"
          );
          outer: for (let i = 0; i < laid.length; i++) {
            for (let j = i + 1; j < laid.length; j++) {
              const area = overlapArea(laid[i], laid[j]);
              const smallest = Math.min(laid[i].width * laid[i].height, laid[j].width * laid[j].height);
              if (smallest > 0 && area / smallest > 0.6) {
                push(
                  node,
                  "sibling-overlap",
                  "warning",
                  `"${laid[i].name}" and "${laid[j].name}" overlap by ${Math.round(area / smallest * 100)}%.`,
                  'If this is intentional (an overlay or badge), set `layoutPositioning: "ABSOLUTE"`.'
                );
                break outer;
              }
            }
          }
        }
      }
      if (enabled("off-canvas")) {
        const parent = node.parent;
        if (parent && parent.type !== "PAGE" && "width" in parent) {
          const x = safe(() => node.x);
          const y = safe(() => node.y);
          const width = safe(() => node.width) ?? 0;
          const height = safe(() => node.height) ?? 0;
          if (typeof x === "number" && typeof y === "number") {
            const fullyOut = x + width < 0 || y + height < 0 || x > parent.width || y > parent.height;
            if (fullyOut) {
              push(node, "off-canvas", "warning", `Node sits entirely outside its parent "${parent.name}".`);
            }
          }
        }
      }
    }
    const byRule = {};
    const bySeverity = {};
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
      rulesRun: RULES.filter(enabled)
    };
  }

  // figma-plugin/src/runtime/commands/recover.ts
  async function quarantinePage() {
    for (const page of figma.root.children) {
      if (page.name === QUARANTINE_PAGE) {
        await page.loadAsync();
        return page;
      }
    }
    return null;
  }
  async function recover(params) {
    switch (params.action ?? "rollback") {
      case "rollback": {
        if (!Array.isArray(params.journal) || !params.journal.length) {
          throw new Error("rollback needs the `journal` array recorded by the failed operation.");
        }
        const result = await rollback(params.journal);
        return {
          ...result,
          ok: result.failed.length === 0,
          note: result.failed.length === 0 ? "All journalled changes were reversed." : "Some inverses failed; the listed nodes still hold the change and need a human look."
        };
      }
      case "restore_quarantine": {
        const page = await quarantinePage();
        if (!page) return { restored: [], note: "No quarantine page exists in this document." };
        const wanted = params.nodeIds ? new Set(params.nodeIds) : null;
        const restored = [];
        const failed = [];
        for (const node of [...page.children]) {
          if (wanted && !wanted.has(node.id)) continue;
          const raw = safe(() => node.getPluginData(DATA_KEYS.quarantinedFrom));
          if (!raw) continue;
          try {
            const origin = JSON.parse(raw);
            const parent = await figma.getNodeByIdAsync(origin.parentId);
            if (!parent || !("insertChild" in parent)) {
              failed.push({ nodeId: node.id, error: `original parent ${origin.parentId} is gone` });
              continue;
            }
            parent.insertChild(Math.min(origin.index, parent.children.length), node);
            node.setPluginData(DATA_KEYS.quarantinedFrom, "");
            restored.push(node.id);
          } catch (error) {
            failed.push({ nodeId: node.id, error: errorMessage(error) });
          }
        }
        return { restored, failed };
      }
      case "purge_quarantine": {
        const page = await quarantinePage();
        if (!page) return { purged: 0 };
        const wanted = params.nodeIds ? new Set(params.nodeIds) : null;
        let purged = 0;
        for (const node of [...page.children]) {
          if (wanted && !wanted.has(node.id)) continue;
          if (params.operationId) {
            const owner = safe(() => node.getPluginData(DATA_KEYS.operation));
            if (owner !== params.operationId) continue;
          }
          node.remove();
          purged++;
        }
        return { purged };
      }
      case "list_operation": {
        await figma.loadAllPagesAsync();
        const tagged = figma.root.findAll((node) => {
          const value = safe(() => node.getPluginData(DATA_KEYS.operation));
          return !!value && (!params.operationId || value === params.operationId);
        });
        const nodes = [];
        for (const node of tagged.slice(0, 200)) {
          nodes.push({
            ...await summarizeNode(node, { depth: 0 }),
            operationId: safe(() => node.getPluginData(DATA_KEYS.operation)),
            createdByOperation: safe(() => node.getPluginData(DATA_KEYS.createdBy)) || void 0
          });
        }
        return { count: tagged.length, nodes };
      }
      default:
        throw new Error(`Unknown recover action "${params.action}".`);
    }
  }

  // figma-plugin/src/runtime/commands/import-tokens.ts
  var IMPORT_KEYS = {
    source: "ff.source",
    sourceHash: "ff.sourceHash",
    importedFrom: "ff.importedFrom"
  };
  var isAlias = (value) => !!value && typeof value === "object" && "alias" in value;
  function toFigmaValue(value) {
    if (value && typeof value === "object" && "r" in value) {
      const color = value;
      return { r: color.r, g: color.g, b: color.b, a: color.a === void 0 ? 1 : color.a };
    }
    return value;
  }
  function ensureModes(collection, wanted) {
    const byName = {};
    for (const mode of collection.modes) byName[mode.name] = mode.modeId;
    wanted.forEach((name, index) => {
      if (byName[name]) return;
      if (index === 0 && collection.modes.length === 1 && /^Mode 1$/i.test(collection.modes[0].name)) {
        collection.renameMode(collection.modes[0].modeId, name);
        byName[name] = collection.modes[0].modeId;
        return;
      }
      try {
        byName[name] = collection.addMode(name);
      } catch (error) {
        throw new Error(
          `Could not add mode "${name}" to "${collection.name}": ${errorMessage(error)}. Additional modes require a paid Figma plan \u2014 re-run with a single-mode import.`
        );
      }
    });
    return byName;
  }
  async function importTokens(params) {
    const ir = params.ir;
    if (!ir || !Array.isArray(ir.collections)) throw new Error("import_tokens needs an `ir` with a `collections` array.");
    const results = [];
    for (const source of ir.collections) {
      results.push(await importCollection(source, ir, params));
    }
    return results;
  }
  async function importCollection(source, ir, params) {
    const dryRun = params.dryRun === true;
    const name = params.collectionName ?? source.name;
    const origin = `${ir.source.kind}:${ir.source.path}`;
    const result = {
      dryRun,
      collection: { name, created: false, modes: [] },
      created: [],
      updated: [],
      unchanged: [],
      conflicts: [],
      aliasFailures: [],
      warnings: [...ir.warnings ?? []]
    };
    const existingCollections = await figma.variables.getLocalVariableCollectionsAsync();
    let collection = existingCollections.filter((candidate) => candidate.name === name)[0] ?? null;
    if (collection && collection.remote) {
      result.conflicts.push({ name, reason: "A collection with this name comes from a library and cannot be written to." });
      return result;
    }
    if (!collection) {
      result.collection.created = true;
      if (dryRun) {
        result.collection.modes = source.modes.map((mode) => ({ modeId: `(new) ${mode}`, name: mode }));
      } else {
        collection = figma.variables.createVariableCollection(name);
        collection.setPluginData(IMPORT_KEYS.importedFrom, origin);
      }
    }
    const modeIds = collection && !dryRun ? ensureModes(collection, source.modes) : {};
    if (collection && !dryRun) {
      result.collection.id = collection.id;
      result.collection.modes = collection.modes.map((mode) => ({ modeId: mode.modeId, name: mode.name }));
    }
    const bySourceId = /* @__PURE__ */ new Map();
    const byName = /* @__PURE__ */ new Map();
    if (collection) {
      for (const id of collection.variableIds) {
        const variable = await figma.variables.getVariableByIdAsync(id);
        if (!variable) continue;
        byName.set(variable.name, variable);
        const owned = safe(() => variable.getPluginData(IMPORT_KEYS.source));
        if (owned) bySourceId.set(owned, variable);
      }
    }
    const written = /* @__PURE__ */ new Map();
    for (const token of source.variables) {
      let variable = bySourceId.get(token.sourceId) ?? null;
      let isNew = false;
      if (!variable) {
        const collision = byName.get(token.name);
        if (collision) {
          const owner = safe(() => collision.getPluginData(IMPORT_KEYS.source));
          if (owner && owner !== token.sourceId) {
            result.conflicts.push({
              name: token.name,
              reason: `already imported from a different source (${owner})`
            });
            continue;
          }
          if (!owner && !params.takeOwnership) {
            result.conflicts.push({
              name: token.name,
              reason: "a hand-authored variable already has this name \u2014 pass takeOwnership to adopt it"
            });
            continue;
          }
          variable = collision;
        } else {
          isNew = true;
        }
      }
      if (variable && variable.resolvedType !== token.type) {
        result.conflicts.push({
          name: token.name,
          reason: `existing variable is ${variable.resolvedType}, the token is ${token.type}; Figma cannot change a variable's type`
        });
        continue;
      }
      if (variable && safe(() => variable.getPluginData(IMPORT_KEYS.sourceHash)) === token.sourceHash) {
        result.unchanged.push(token.name);
        written.set(token.sourceId, variable);
        continue;
      }
      if (dryRun) {
        (isNew ? result.created : result.updated).push(token.name);
        continue;
      }
      if (!variable) {
        variable = figma.variables.createVariable(token.name, collection, token.type);
      } else if (variable.name !== token.name) {
        variable.name = token.name;
      }
      for (const modeName of source.modes) {
        const value = token.valuesByMode[modeName];
        if (value === void 0 || isAlias(value)) continue;
        const modeId = modeIds[modeName];
        if (!modeId) continue;
        variable.setValueForMode(modeId, toFigmaValue(value));
      }
      if (token.scopes) variable.scopes = token.scopes;
      if (token.codeSyntax) {
        for (const platform of Object.keys(token.codeSyntax)) {
          try {
            variable.setVariableCodeSyntax(platform, token.codeSyntax[platform]);
          } catch {
          }
        }
      }
      variable.setPluginData(IMPORT_KEYS.source, token.sourceId);
      variable.setPluginData(IMPORT_KEYS.sourceHash, token.sourceHash);
      variable.setPluginData(IMPORT_KEYS.importedFrom, origin);
      written.set(token.sourceId, variable);
      (isNew ? result.created : result.updated).push(token.name);
    }
    if (!dryRun) {
      const prefix = `${ir.source.kind === "tailwind" ? "css" : ir.source.kind}:`;
      for (const token of source.variables) {
        const variable = written.get(token.sourceId) ?? bySourceId.get(token.sourceId);
        if (!variable) continue;
        for (const modeName of source.modes) {
          const value = token.valuesByMode[modeName];
          if (value === void 0 || !isAlias(value)) continue;
          const modeId = modeIds[modeName];
          if (!modeId) continue;
          const targetSourceId = `${prefix}${value.alias}`;
          const target = written.get(targetSourceId) ?? bySourceId.get(targetSourceId);
          if (!target) {
            result.aliasFailures.push({ name: token.name, alias: value.alias });
            continue;
          }
          try {
            variable.setValueForMode(modeId, figma.variables.createVariableAlias(target));
          } catch (error) {
            result.aliasFailures.push({ name: token.name, alias: `${value.alias} (${errorMessage(error)})` });
          }
        }
      }
    }
    if (result.aliasFailures.length) {
      result.warnings.push(
        `${result.aliasFailures.length} alias(es) could not be resolved and kept their fallback value. The referenced tokens are usually defined in a file that was not part of this import.`
      );
    }
    return result;
  }

  // figma-plugin/src/runtime/commands/graph.ts
  var SCREEN_TYPES = /* @__PURE__ */ new Set(["FRAME", "COMPONENT", "COMPONENT_SET"]);
  function isScreen(node) {
    if (!SCREEN_TYPES.has(node.type)) return false;
    const parent = node.parent;
    if (!parent) return false;
    if (parent.type === "PAGE") return true;
    let current = parent;
    while (current && current.type === "SECTION") current = current.parent;
    return !!current && current.type === "PAGE";
  }
  function sectionOf(node) {
    let current = node.parent;
    while (current && current.type !== "PAGE") {
      if (current.type === "SECTION") return current;
      current = current.parent;
    }
    return null;
  }
  async function buildGraph(params) {
    const maxScreens = params.maxScreensPerPage ?? 400;
    const maxTextChars = params.maxTextChars ?? 1200;
    const maxLookups = params.maxInstanceLookups ?? 1500;
    let pages;
    let startIndex = 0;
    let totalPages;
    if (params.scope === "page") {
      const page = params.pageId ? await figma.getNodeByIdAsync(params.pageId) : figma.currentPage;
      if (!page || page.type !== "PAGE") throw new Error(`${params.pageId} is not a page.`);
      pages = [page];
      totalPages = 1;
    } else {
      const all = figma.root.children;
      totalPages = all.length;
      startIndex = params.startPage ?? 0;
      const count = params.maxPages ?? 8;
      pages = all.slice(startIndex, startIndex + count);
    }
    const pageRows = [];
    const screens = [];
    const componentUsage = /* @__PURE__ */ new Map();
    const stats = { textNodes: 0, instances: 0, lookupsSkipped: 0 };
    for (const [offset, page] of pages.entries()) {
      await page.loadAsync();
      const found = page.findAllWithCriteria({
        types: ["FRAME", "COMPONENT", "COMPONENT_SET", "TEXT", "INSTANCE"]
      });
      const pageScreens = found.filter((node) => SCREEN_TYPES.has(node.type) && isScreen(node)).slice(0, maxScreens);
      const screenIds = new Set(pageScreens.map((screen) => screen.id));
      const owner = (node) => {
        let current = node;
        while (current) {
          if (screenIds.has(current.id)) return current.id;
          current = current.parent;
        }
        return null;
      };
      const textByScreen = /* @__PURE__ */ new Map();
      const instancesByScreen = /* @__PURE__ */ new Map();
      for (const node of found) {
        if (node.type === "TEXT") {
          stats.textNodes++;
          const screenId = owner(node);
          if (!screenId) continue;
          if (safe(() => node.visible) === false) continue;
          const characters = safe(() => node.characters);
          if (typeof characters !== "string" || !characters.trim()) continue;
          const bucket = textByScreen.get(screenId) ?? { parts: [], chars: 0, count: 0 };
          bucket.count++;
          if (bucket.chars < maxTextChars) {
            const trimmed = characters.trim().replace(/\s+/g, " ");
            bucket.parts.push(trimmed);
            bucket.chars += trimmed.length + 1;
          }
          textByScreen.set(screenId, bucket);
          continue;
        }
        if (node.type === "INSTANCE") {
          stats.instances++;
          const screenId = owner(node);
          if (!screenId) continue;
          const list = instancesByScreen.get(screenId) ?? [];
          list.push(node);
          instancesByScreen.set(screenId, list);
        }
      }
      const flatInstances = [];
      for (const [screenId, list] of instancesByScreen) {
        for (const node of list) flatInstances.push({ screenId, node });
      }
      const budgeted = flatInstances.slice(0, maxLookups);
      stats.lookupsSkipped += flatInstances.length - budgeted.length;
      const resolved = await Promise.all(
        budgeted.map(
          ({ screenId, node }) => node.getMainComponentAsync().then((main) => ({ screenId, main })).catch(() => ({ screenId, main: null }))
        )
      );
      const keysByScreen = /* @__PURE__ */ new Map();
      for (const { screenId, main } of resolved) {
        if (!main) continue;
        const set = main.parent && main.parent.type === "COMPONENT_SET" ? main.parent : null;
        const key = safe(() => (set ?? main).key);
        if (!key) continue;
        const name = (set ?? main).name;
        const perScreen = keysByScreen.get(screenId) ?? /* @__PURE__ */ new Map();
        perScreen.set(key, name);
        keysByScreen.set(screenId, perScreen);
        const usage = componentUsage.get(key) ?? { name, instances: 0, screens: /* @__PURE__ */ new Set() };
        usage.instances++;
        usage.screens.add(screenId);
        componentUsage.set(key, usage);
      }
      for (const screen of pageScreens) {
        const section = sectionOf(screen);
        const text = textByScreen.get(screen.id);
        const keys = keysByScreen.get(screen.id) ?? /* @__PURE__ */ new Map();
        screens.push({
          id: screen.id,
          name: screen.name,
          type: screen.type,
          pageId: page.id,
          pageName: page.name,
          sectionName: section ? section.name : void 0,
          path: [page.name, section ? section.name : null, screen.name].filter(Boolean).join(" / "),
          width: Math.round(safe(() => screen.width) ?? 0),
          height: Math.round(safe(() => screen.height) ?? 0),
          text: text ? text.parts.join(" \xB7 ").slice(0, maxTextChars) : "",
          textNodes: text ? text.count : 0,
          instanceCount: (instancesByScreen.get(screen.id) ?? []).length,
          componentKeys: [...keys.keys()],
          componentNames: [...keys.values()]
        });
      }
      pageRows.push({
        id: page.id,
        name: page.name,
        index: params.scope === "page" ? 0 : startIndex + offset,
        screens: pageScreens.length
      });
    }
    const components = [...componentUsage].map(([key, usage]) => ({
      key,
      name: usage.name,
      instances: usage.instances,
      screens: usage.screens.size
    }));
    components.sort((a, b) => b.instances - a.instances);
    const consumed = startIndex + pages.length;
    return {
      pages: pageRows,
      screens,
      components,
      nextPage: params.scope === "page" || consumed >= totalPages ? null : consumed,
      totalPages,
      stats: { ...stats, screens: screens.length, pagesInChunk: pages.length }
    };
  }

  // figma-plugin/src/code.ts
  var PLUGIN_VERSION = "0.1.0";
  var STORAGE_KEYS = {
    port: "figma-forge.port",
    channel: "figma-forge.channel",
    autoConnect: "figma-forge.autoConnect"
  };
  var connectedChannel = null;
  installShims();
  figma.showUI(__html__, { width: 320, height: 440, themeColors: true });
  var sessionNonce = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  function fileIdentity() {
    const firstPage = figma.root.children[0];
    return `doc-${hashSource(`${figma.root.name}|${firstPage ? firstPage.id : ""}`)}`;
  }
  function sessionInfo() {
    return {
      plugin: "figma-forge",
      pluginVersion: PLUGIN_VERSION,
      indexSchemaVersion: INDEX_SCHEMA_VERSION,
      sessionId: `${figma.fileKey ?? "local"}:${sessionNonce}`,
      fileKey: figma.fileKey ?? null,
      fileId: fileIdentity(),
      documentName: figma.root.name,
      editorType: figma.editorType,
      currentPage: { id: figma.currentPage.id, name: figma.currentPage.name },
      pageCount: figma.root.children.length,
      selection: figma.currentPage.selection.map((node) => ({ id: node.id, name: node.name, type: node.type })),
      shims: shimReport(),
      channel: connectedChannel
    };
  }
  var handlers = {
    ping: () => ({ pong: true, at: Date.now(), ...sessionInfo() }),
    session_info: () => sessionInfo(),
    inspect: (params) => inspect(params),
    design_system: (params) => designSystem(params),
    apply_plan: (params) => applyPlan(params),
    verify: (params) => verify(params),
    recover: (params) => recover(params),
    import_tokens: (params) => importTokens(params),
    build_graph: (params) => buildGraph(params),
    execute: (params) => execute(params),
    modules: (params) => {
      const action = params.action ?? "list";
      if (action === "list") return { modules: listModules() };
      if (action === "define") {
        return defineModule(String(params.name ?? ""), String(params.source ?? ""));
      }
      if (action === "remove") return { removed: removeModule(String(params.name ?? "")) };
      throw new Error(`Unknown modules action "${action}".`);
    },
    /** Lets the agent point the user at what it just built. */
    focus: async (params) => {
      const ids = params.nodeIds ?? [];
      const nodes = [];
      for (const id of ids) {
        const node = await figma.getNodeByIdAsync(id);
        if (node && "visible" in node) nodes.push(node);
      }
      if (!nodes.length) throw new Error("None of those node ids resolved to something focusable.");
      const page = pageOf(nodes[0]);
      if (page && page.id !== figma.currentPage.id) await figma.setCurrentPageAsync(page);
      figma.currentPage.selection = nodes;
      figma.viewport.scrollAndZoomIntoView(nodes);
      return { focused: nodes.map((node) => node.id), pageId: figma.currentPage.id };
    },
    notify: (params) => {
      figma.notify(String(params.message ?? ""), { error: params.error === true, timeout: 3e3 });
      return { shown: true };
    }
  };
  function pageOf(node) {
    let current = node;
    while (current && current.type !== "PAGE") current = current.parent;
    return current ?? null;
  }
  async function dispatch(request) {
    const handler = handlers[request.command];
    if (!handler) {
      figma.ui.postMessage({
        type: "response",
        id: request.id,
        ok: false,
        error: {
          code: "UNKNOWN_COMMAND",
          message: `Unknown command "${request.command}". Known: ${Object.keys(handlers).join(", ")}.`
        }
      });
      return;
    }
    try {
      const result = await handler(request.params ?? {});
      figma.ui.postMessage({ type: "response", id: request.id, ok: true, result });
    } catch (error) {
      figma.ui.postMessage({
        type: "response",
        id: request.id,
        ok: false,
        error: {
          code: "COMMAND_FAILED",
          message: errorMessage(error),
          // The stack is the difference between "it failed" and a fixable report,
          // and this only ever travels over loopback.
          stack: error instanceof Error ? error.stack : void 0
        }
      });
    }
  }
  figma.ui.onmessage = async (message) => {
    if (!message || typeof message !== "object") return;
    switch (message.type) {
      case "ui-ready": {
        const [port, channel, autoConnect] = await Promise.all([
          figma.clientStorage.getAsync(STORAGE_KEYS.port),
          figma.clientStorage.getAsync(STORAGE_KEYS.channel),
          figma.clientStorage.getAsync(STORAGE_KEYS.autoConnect)
        ]);
        figma.ui.postMessage({
          type: "restore",
          port: port ?? "3055",
          channel: channel ?? "",
          autoConnect: autoConnect !== false,
          session: sessionInfo()
        });
        return;
      }
      case "connected": {
        connectedChannel = message.channel;
        await figma.clientStorage.setAsync(STORAGE_KEYS.channel, message.channel);
        if (message.port) await figma.clientStorage.setAsync(STORAGE_KEYS.port, message.port);
        await figma.clientStorage.setAsync(STORAGE_KEYS.autoConnect, true);
        return;
      }
      case "disconnected":
        connectedChannel = null;
        return;
      case "save-settings":
        if (message.port !== void 0) await figma.clientStorage.setAsync(STORAGE_KEYS.port, message.port);
        if (message.channel !== void 0) await figma.clientStorage.setAsync(STORAGE_KEYS.channel, message.channel);
        if (message.autoConnect !== void 0) {
          await figma.clientStorage.setAsync(STORAGE_KEYS.autoConnect, message.autoConnect);
        }
        return;
      case "request":
        await dispatch(message);
        return;
    }
  };
  figma.on("close", () => {
    connectedChannel = null;
  });
})();
