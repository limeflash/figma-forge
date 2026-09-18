/**
 * What the user handed over: one HTML file, a folder, or a zip.
 *
 * Claude Design produces three different things that all end in `.html`, and
 * importing the wrong one gives a wrong or empty result:
 *
 *   bundle  an offline export. A loader script unpacks the real page from a
 *           manifest at runtime, so the file's own markup is not the design.
 *   dc      a `.dc.html` source. Rendered by `support.js`, which pulls React
 *           from a CDN; some are whole screens, some are one component with a
 *           `$preview` size, and `*-src` ones only exist to feed an export.
 *   html    anything else.
 *
 * None of them can be understood without a browser, so this module only finds
 * and labels pages; rendering decides what is in them.
 */

import { createHash } from 'node:crypto';
import { open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';

import { resolveSourcePath } from '../import/index.js';
import { dataDirectory } from '../store.js';
import { extractZip, ExtractResult } from './zip.js';

export type PageKind = 'bundle' | 'dc' | 'html';
export type PageRole = 'design' | 'source' | 'component' | 'empty';

export interface PageEntry {
  /** Relative to the source root, with forward slashes. */
  path: string;
  kind: PageKind;
  role: PageRole;
  bytes: number;
  title?: string;
  /** A `.dc.html` component's own preview size. */
  preview?: { width: number; height: number };
  note?: string;
}

export interface HtmlSource {
  /** What the user passed, resolved. */
  input: string;
  display: string;
  kind: 'file' | 'directory' | 'zip';
  /** The directory served to the browser. */
  root: string;
  pages: PageEntry[];
  /** The page to use when the caller does not name one. */
  defaultPage?: string;
  tokens: string[];
  readme?: string;
  extracted?: ExtractResult;
  truncated?: boolean;
}

const HTML_FILE = /\.html?$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '__MACOSX', 'uploads', 'screenshots', 'dist-cache']);
const MAX_PAGES = 400;
const HEAD_BYTES = 96 * 1024;

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

async function readHead(path: string, bytes = HEAD_BYTES): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Classifies a page from its first bytes; cheap enough to run on every file. */
export async function classifyPage(root: string, absolute: string): Promise<PageEntry> {
  const info = await stat(absolute);
  const head = await readHead(absolute);
  const path = relative(root, absolute).split(sep).join('/');
  const name = basename(absolute);

  const title = /<title>([^<]{1,200})<\/title>/i.exec(head)?.[1]?.trim();
  const entry: PageEntry = {
    path,
    kind: 'html',
    role: 'design',
    bytes: info.size,
    title: title && title !== 'Bundled Page' ? title : undefined,
  };

  if (head.includes('__bundler/manifest') || head.includes('__bundler/template')) {
    entry.kind = 'bundle';
    entry.note = 'offline export — unpacks itself in the browser';
  } else if (/<x-dc[\s>]/.test(head) || name.endsWith('.dc.html')) {
    entry.kind = 'dc';
    // The dc script sits at the end of the file, past the head we read.
    const full = info.size > HEAD_BYTES ? await readFile(absolute, 'utf8') : head;
    const props = /data-props="([^"]*)"/.exec(full)?.[1];
    if (props) {
      try {
        const parsed = JSON.parse(decodeEntities(props)) as { $preview?: { width?: number; height?: number } };
        if (parsed.$preview?.width && parsed.$preview.height) {
          entry.preview = { width: parsed.$preview.width, height: parsed.$preview.height };
        }
      } catch {
        /* a preview size is a hint; its absence changes nothing */
      }
    }
    const body = /<x-dc[^>]*>([\s\S]*?)<\/x-dc>/.exec(full)?.[1] ?? '';
    if (!body.replace(/<helmet>[\s\S]*?<\/helmet>/g, '').trim()) {
      entry.role = 'empty';
      entry.note = 'empty canvas';
    } else if (/(^|[-_ ])(src|source)([-_. ]|$)|standalone|^bake-|^export-/i.test(name)) {
      entry.role = 'source';
      entry.note = 'build input for an offline export — prefer the exported file';
    } else if (entry.preview && entry.preview.width <= 640 && entry.preview.height <= 640 && info.size < 24 * 1024) {
      entry.role = 'component';
      entry.note = `component preview ${entry.preview.width}×${entry.preview.height}`;
    } else {
      entry.note = 'Claude Design source — needs network for React';
    }
  }
  return entry;
}

async function walk(root: string, dir: string, depth: number, out: string[], extras: string[]): Promise<boolean> {
  if (out.length >= MAX_PAGES) return true;
  let truncated = false;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < 4 && !SKIP_DIRS.has(entry.name)) {
        truncated = (await walk(root, absolute, depth + 1, out, extras)) || truncated;
      }
    } else if (HTML_FILE.test(entry.name)) {
      if (out.length >= MAX_PAGES) return true;
      out.push(absolute);
    } else if (/\.(css|md)$/i.test(entry.name)) {
      extras.push(absolute);
    }
  }
  return truncated;
}

/** Zips are unpacked once per archive version and reused. */
async function unpack(archive: string): Promise<{ root: string; extracted: ExtractResult }> {
  const info = await stat(archive);
  const key = createHash('sha1').update(`${archive}|${info.size}|${info.mtimeMs}`).digest('hex').slice(0, 16);
  const root = join(dataDirectory(), 'html-sources', key);
  const marker = join(root, '.ff-extracted.json');
  try {
    return { root, extracted: JSON.parse(await readFile(marker, 'utf8')) as ExtractResult };
  } catch {
    const extracted = await extractZip(archive, root);
    await writeFile(marker, JSON.stringify(extracted));
    return { root, extracted };
  }
}

/** A zip with one top-level folder should be served from inside that folder. */
async function singleChild(root: string): Promise<string> {
  const entries = (await readdir(root, { withFileTypes: true })).filter((entry) => !entry.name.startsWith('.'));
  if (entries.length === 1 && entries[0].isDirectory()) return join(root, entries[0].name);
  return root;
}

function rank(entry: PageEntry): number {
  const roleScore = { design: 0, source: 2, component: 3, empty: 4 }[entry.role];
  return roleScore * 10 + (entry.kind === 'bundle' ? 0 : entry.kind === 'html' ? 1 : 2);
}

export async function resolveHtmlSource(input: string): Promise<HtmlSource> {
  const location = await resolveSourcePath(expandHome(input.trim()));
  const info = await stat(location.absolute);

  let kind: HtmlSource['kind'];
  let root: string;
  let files: string[] = [];
  const extras: string[] = [];
  let extracted: ExtractResult | undefined;
  let truncated = false;

  if (info.isDirectory()) {
    kind = 'directory';
    root = location.absolute;
    truncated = await walk(root, root, 0, files, extras);
  } else if (extname(location.absolute).toLowerCase() === '.zip') {
    kind = 'zip';
    const unpacked = await unpack(location.absolute);
    extracted = unpacked.extracted;
    root = await singleChild(unpacked.root);
    truncated = await walk(root, root, 0, files, extras);
  } else if (HTML_FILE.test(location.absolute)) {
    kind = 'file';
    // Serve the folder so relative assets and `support.js` resolve; the page
    // itself is the only one listed.
    root = dirname(location.absolute);
    files = [location.absolute];
  } else {
    throw new Error(`${location.display} is not an HTML file, a folder or a .zip.`);
  }

  const pages: PageEntry[] = [];
  for (const file of files) pages.push(await classifyPage(root, file));
  pages.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path, 'ru'));

  const tokens = extras
    .filter((file) => /token|variables|theme/i.test(basename(file)) && file.endsWith('.css'))
    .map((file) => relative(root, file).split(sep).join('/'));
  const readme = extras.find((file) => /^readme\.md$/i.test(basename(file)));

  return {
    input: location.absolute,
    display: location.display,
    kind,
    root,
    pages,
    defaultPage: kind === 'file' ? pages[0]?.path : pages.find((page) => page.role === 'design')?.path,
    tokens,
    readme: readme ? relative(root, readme).split(sep).join('/') : undefined,
    extracted,
    truncated: truncated || undefined,
  };
}

/** Finds a page by exact path, then by unique substring — people paste names, not paths. */
export function findPage(source: HtmlSource, wanted: string | undefined): PageEntry & { url: string } {
  const cut = wanted ? wanted.search(/[?#]/) : -1;
  const suffix = cut >= 0 ? wanted!.slice(cut) : '';
  const page = findPageFile(source, cut >= 0 ? wanted!.slice(0, cut) : wanted);
  return { ...page, url: page.path + suffix };
}

function findPageFile(source: HtmlSource, wanted: string | undefined): PageEntry {
  if (!wanted) {
    const fallback = source.pages.find((page) => page.path === source.defaultPage) ?? source.pages[0];
    if (!fallback) throw new Error(`${source.display} contains no HTML pages.`);
    return fallback;
  }
  const normalized = wanted.replace(/\\/g, '/').replace(/^\.\//, '');
  const exact = source.pages.find((page) => page.path === normalized);
  if (exact) return exact;
  const lower = normalized.toLowerCase();
  const partial = source.pages.filter((page) => page.path.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(`"${wanted}" matches ${partial.length} pages: ${partial.slice(0, 8).map((page) => page.path).join(', ')}.`);
  }
  throw new Error(`No page "${wanted}" in ${source.display}.`);
}

export function absolutePage(source: HtmlSource, page: PageEntry): string {
  return resolve(source.root, page.path);
}
