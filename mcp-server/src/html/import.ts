/**
 * HTML import, end to end: look at a source, then build what was chosen.
 *
 * `survey` renders one page and reports what is on it — screens, the captions
 * around them, the controls a prototype needs clicked — plus a ready-to-run
 * proposal for how to group it. The proposal is a starting point for Claude
 * and the user, not a verdict: names and grouping are exactly the part a
 * heuristic gets almost right.
 *
 * `build` renders every requested screen, converts it, and writes it through
 * the plugin under one journalled operation.
 */

import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';

import type { CanvasIR, FrameIR, NoteIR, SectionIR } from '../../../shared/html-import.js';
import { convertCollection, ConvertStats } from './convert.js';
import { AssetData, CaptureRequest, DEFAULT_VIEWPORT, RenderSession, Step, Viewport } from './render.js';
import { findPage, HtmlSource, PageEntry, resolveHtmlSource } from './source.js';

/** A plugin journal entry; the server only re-sequences and stores them. */
export interface JournalEntryLike {
  seq: number;
  [key: string]: unknown;
}

export interface ScreenSpec {
  name: string;
  page?: string;
  selector?: string;
  viewport?: Viewport;
  steps?: Step[];
  fullHeight?: boolean;
  frameWidth?: number;
  exclude?: string[];
  rasterize?: string[];
}

export interface RowSpec {
  title?: string;
  note?: string;
  screens: ScreenSpec[];
}

export interface SectionSpec {
  name: string;
  note?: string;
  rows: RowSpec[];
}

/* ------------------------------------------------------------------ *
 * Survey
 * ------------------------------------------------------------------ */

export interface SurveyArgs {
  source: string;
  page?: string;
  viewport?: Viewport;
  steps?: Step[];
  screenshots?: boolean;
}

export interface SurveyReport {
  report: Record<string, unknown>;
  shots: Buffer[];
}

function prettyName(path: string): string {
  return basename(path, extname(path))
    .replace(/\.dc$/, '')
    .replace(/\s*\((офлайн|offline|standalone)[^)]*\)\s*/gi, ' ')
    .replace(/\s*\(\d+\)\s*$/, '')
    .trim();
}

function capitalize(text: string): string {
  const lower = text === text.toUpperCase() ? text.toLowerCase() : text;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** "1a" + "Пересчёт" + "после любого…" → title "1a · Пересчёт", note the rest. */
function splitCaption(pieces: string[]): { title?: string; note?: string } {
  const parts = pieces.map((piece) => piece.trim()).filter(Boolean);
  if (!parts.length) return {};
  let title = parts[0];
  let rest = parts.slice(1);
  if (title.length <= 4 && rest.length) {
    title = `${title} · ${rest[0]}`;
    rest = rest.slice(1);
  }
  if (title.length > 90) return { title: title.slice(0, 60).trim() + '…', note: parts.join(' ') };
  return { title, note: rest.length ? rest.join(' ') : undefined };
}

export async function survey(args: SurveyArgs): Promise<SurveyReport> {
  const source = await resolveHtmlSource(args.source);
  const page = findPage(source, args.page);
  const viewport = args.viewport ?? DEFAULT_VIEWPORT;
  const session = await RenderSession.open(source);
  try {
    const result = await session.survey(page.url, viewport, args.screenshots !== false, args.steps ?? []);
    const raw = result.survey;

    const screens = raw.screens.map((screen, index) => ({ id: `s${index + 1}`, ...screen }));
    const pageName = raw.heading[0] || raw.title || page.title || prettyName(page.path);

    // Proposal: sections from headings, rows from captions, names from labels.
    const sections = new Map<string, SectionSpec>();
    const rowSpecs = new Map<string, RowSpec>();
    for (const screen of screens) {
      const row = screen.row !== undefined ? raw.rows[screen.row] : undefined;
      const sectionIndex = row?.section;
      const heading = sectionIndex !== undefined ? raw.sections[sectionIndex]?.heading : undefined;
      const sectionName = heading?.[0] ?? pageName;
      let section = sections.get(sectionName);
      if (!section) {
        section = { name: sectionName, note: heading?.[1], rows: [] };
        sections.set(sectionName, section);
      }
      const rowKey = `${sectionName}|${screen.row ?? 'loose'}`;
      let rowSpec = rowSpecs.get(rowKey);
      if (!rowSpec) {
        const caption = row ? splitCaption(row.caption) : {};
        rowSpec = { title: caption.title, note: caption.note, screens: [] };
        rowSpecs.set(rowKey, rowSpec);
        section.rows.push(rowSpec);
      }
      const label = screen.label ? capitalize(screen.label) : undefined;
      const base = rowSpec.title ?? (screens.length === 1 ? pageName : undefined);
      const name = [base, label].filter(Boolean).join(' / ') || `Screen ${screen.id.slice(1)}`;
      const spec: ScreenSpec = { name, page: page.url, selector: screen.selector, viewport: { width: viewport.width } };
      if (args.steps?.length) spec.steps = args.steps;
      rowSpec.screens.push(spec);
    }

    const report: Record<string, unknown> = {
      source: {
        path: source.display,
        kind: source.kind,
        served: source.kind === 'file' ? undefined : source.root,
        pages: source.pages.slice(0, 60).map((entry: PageEntry) => ({
          path: entry.path,
          kind: entry.kind,
          role: entry.role,
          kb: Math.round(entry.bytes / 1024),
          title: entry.title,
          preview: entry.preview,
          note: entry.note,
        })),
        morePages: Math.max(0, source.pages.length - 60) || undefined,
        tokens: source.tokens.length ? source.tokens : undefined,
        readme: source.readme,
        skipped: source.extracted?.skipped.length ? source.extracted.skipped.slice(0, 10) : undefined,
      },
      page: {
        path: page.url,
        kind: page.kind,
        viewport,
        document: raw.document,
        background: raw.background,
        heading: raw.heading,
        fonts: raw.fonts,
        elements: raw.elements,
        loadMs: result.ms,
        unstable: result.unstable || undefined,
        errors: result.errors.length ? result.errors : undefined,
      },
      screens: screens.map((screen) => ({
        id: screen.id,
        selector: screen.selector,
        box: screen.box,
        label: screen.label,
        row: screen.row,
        inner: screen.inner,
        innerPage: screen.innerPage,
        background: screen.background,
        elements: screen.elements,
        text: screen.text,
      })),
      rows: raw.rows.map((row, index) => ({ index, section: row.section, caption: row.caption })),
      sections: raw.sections.map((section, index) => ({ index, heading: section.heading })),
      clickables: raw.clickables.slice(0, 80).map((item) => ({ text: item.text, target: `css:${item.selector}`, fixed: item.fixed || undefined })),
      proposal: { sections: [...sections.values()] },
    };
    return { report, shots: result.shots };
  } finally {
    await session.close();
  }
}

/* ------------------------------------------------------------------ *
 * Build: render and convert
 * ------------------------------------------------------------------ */

export interface PreparedScreen {
  key: string;
  section: number;
  row: number;
  spec: ScreenSpec;
  layer: FrameIR;
  assets: Map<string, AssetData>;
  nodes: number;
  stats: ConvertStats;
  warnings: string[];
  errors: string[];
  source: { page: string; selector: string; viewport: { width: number; height: number } };
}

export type Progress = (done: number, total: number, message: string) => void;

export async function prepare(sourcePath: string, sections: SectionSpec[], progress: Progress): Promise<{ source: HtmlSource; screens: PreparedScreen[] }> {
  const source = await resolveHtmlSource(sourcePath);
  const total = sections.reduce((sum, section) => sum + section.rows.reduce((rows, row) => rows + row.screens.length, 0), 0);
  if (!total) throw new Error('The build names no screens.');

  const session = await RenderSession.open(source);
  const screens: PreparedScreen[] = [];
  try {
    let done = 0;
    for (const [sectionIndex, section] of sections.entries()) {
      for (const [rowIndex, row] of section.rows.entries()) {
        for (const spec of row.screens) {
          const page = findPage(source, spec.page);
          progress(done, total, `Rendering ${spec.name}`);
          const request: CaptureRequest = {
            page: page.url,
            selector: spec.selector,
            viewport: spec.viewport,
            steps: spec.steps,
            fullHeight: spec.fullHeight,
            frameWidth: spec.frameWidth,
            exclude: spec.exclude,
            rasterize: spec.rasterize,
          };
          let capture;
          try {
            capture = await session.capture(request);
          } catch (error) {
            throw new Error(`"${spec.name}": ${error instanceof Error ? error.message : String(error)}`);
          }
          const converted = convertCollection(capture.collection, capture.assets, { name: spec.name });
          screens.push({
            key: `screen${screens.length}`,
            section: sectionIndex,
            row: rowIndex,
            spec,
            layer: converted.root,
            assets: capture.assets,
            nodes: converted.nodes,
            stats: converted.stats,
            warnings: [...capture.warnings, ...converted.warnings],
            errors: capture.errors,
            source: { page: page.url, selector: spec.selector ?? 'body', viewport: capture.viewport },
          });
          done++;
        }
      }
    }
  } finally {
    await session.close();
  }
  return { source, screens };
}

/* ------------------------------------------------------------------ *
 * Build: write through the plugin
 * ------------------------------------------------------------------ */

export type Call = <T>(command: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<T>;

export interface WriteOptions {
  operationId: string;
  target: { pageId?: string; pageName?: string };
  bindTokens: boolean;
  sections: SectionSpec[];
  call: Call;
  progress: Progress;
  /** Persists the journal so far; called after every step that created nodes. */
  saveJournal: (entries: JournalEntryLike[], created: string[], failure?: string) => Promise<void>;
}

export interface WriteResult {
  pageId: string;
  pageName: string;
  sections: { name: string; id: string; screens: { name: string; id: string; nodes: number; width: number; height: number }[] }[];
  images: { uploaded: number; failed: { id: string; error: string }[] };
  boundColors: number;
  missingFonts: string[];
  warnings: string[];
}

/**
 * Figma sometimes loses its own connection to its servers mid-write, and every
 * plugin call then fails with a connection error until it is back. Rendering
 * the screens again would cost minutes, so a write is retried on its own.
 */
const RETRY_WAITS = [3000, 8000, 20000];

function transient(error: unknown): boolean {
  return /connection|timed? ?out|network|disconnect/i.test(error instanceof Error ? error.message : String(error));
}

async function attempt<T>(run: () => Promise<T>, onRetry: (wait: number, why: string) => void): Promise<T> {
  for (let tries = 0; ; tries++) {
    try {
      return await run();
    } catch (error) {
      const wait = RETRY_WAITS[tries];
      if (wait === undefined || !transient(error)) throw error;
      onRetry(wait, error instanceof Error ? error.message : String(error));
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

const UPLOAD_BATCH_CHARS = 8 * 1024 * 1024;

const NOTE_WIDTH = 880;

export async function writeToFigma(screens: PreparedScreen[], options: WriteOptions): Promise<WriteResult> {
  const { call, operationId } = options;
  const entries: JournalEntryLike[] = [];
  const created: string[] = [];
  const record = async (batch: JournalEntryLike[] | undefined, ids: string[], failure?: string) => {
    for (const entry of batch ?? []) entries.push({ ...entry, seq: entries.length });
    created.push(...ids);
    await options.saveJournal(entries, created, failure);
  };

  // 1. Images, once per unique file across every screen.
  const byHash = new Map<string, { data: Buffer; refs: { screen: PreparedScreen; asset: string }[] }>();
  for (const screen of screens) {
    for (const [asset, data] of screen.assets) {
      if (data.kind !== 'bitmap') continue;
      const digest = createHash('sha1').update(data.bytes).digest('hex');
      const entry = byHash.get(digest) ?? { data: data.bytes, refs: [] };
      entry.refs.push({ screen, asset });
      byHash.set(digest, entry);
    }
  }
  const figmaHashes = new Map<string, string>();
  const failedImages: { id: string; error: string }[] = [];
  let batch: { id: string; data: string }[] = [];
  let batchChars = 0;
  const flush = async () => {
    if (!batch.length) return;
    options.progress(0, 1, `Uploading ${batch.length} image(s)`);
    const result = await attempt(
      () => call<{ hashes: Record<string, string>; failed: { id: string; error: string }[] }>('import_images', { images: batch }, 180_000),
      (wait) => options.progress(0, 1, `Retrying the upload in ${Math.round(wait / 1000)}s`)
    );
    for (const [id, hash] of Object.entries(result.hashes)) figmaHashes.set(id, hash);
    failedImages.push(...result.failed);
    batch = [];
    batchChars = 0;
  };
  for (const [digest, entry] of byHash) {
    const data = entry.data.toString('base64');
    if (batchChars + data.length > UPLOAD_BATCH_CHARS) await flush();
    batch.push({ id: digest, data });
    batchChars += data.length;
  }
  await flush();
  const imagesFor = (screen: PreparedScreen) => {
    const map: Record<string, string> = {};
    for (const [digest, entry] of byHash) {
      const hash = figmaHashes.get(digest);
      if (!hash) continue;
      for (const ref of entry.refs) if (ref.screen === screen) map[ref.asset] = hash;
    }
    return map;
  };

  // 2. Page, sections and caption cards. Positions are provisional; the final
  // arrangement happens once every screen exists and has its real size.
  const sectionIRs: SectionIR[] = options.sections.map((section, sectionIndex) => {
    const notes: NoteIR[] = [];
    if (section.note) notes.push({ key: `s${sectionIndex}`, x: 0, y: 0, width: NOTE_WIDTH, title: undefined, body: section.note });
    section.rows.forEach((row, rowIndex) => {
      if (row.title || row.note) {
        notes.push({ key: `s${sectionIndex}r${rowIndex}`, x: 0, y: 0, width: NOTE_WIDTH, title: row.title, body: row.note });
      }
    });
    return { key: `s${sectionIndex}`, name: section.name, x: sectionIndex * 200, y: -20_000, width: 400, height: 400, notes };
  });
  const canvasIR: CanvasIR = { operationId, page: { id: options.target.pageId, name: options.target.pageName }, sections: sectionIRs };
  const canvas = await attempt(
    () =>
      call<{
        pageId: string;
        pageName: string;
        sections: Record<string, string>;
        notes: Record<string, string>;
        journal: JournalEntryLike[];
      }>('import_canvas', canvasIR as unknown as Record<string, unknown>, 120_000),
    (wait) => options.progress(0, 1, `Retrying the page in ${Math.round(wait / 1000)}s`)
  );
  await record(canvas.journal, Object.values(canvas.sections));

  // 3. Screens.
  const result: WriteResult = {
    pageId: canvas.pageId,
    pageName: canvas.pageName,
    sections: options.sections.map((section, index) => ({ name: section.name, id: canvas.sections[`s${index}`], screens: [] })),
    images: { uploaded: figmaHashes.size, failed: failedImages },
    boundColors: 0,
    missingFonts: [],
    warnings: [],
  };
  const missingFonts = new Set<string>();
  for (const [index, screen] of screens.entries()) {
    options.progress(index, screens.length, `Building ${screen.spec.name}`);
    const parentId = canvas.sections[`s${screen.section}`];
    const buildScreen = () =>
      call<{
        nodeId: string;
        name: string;
        nodes: number;
        width: number;
        height: number;
        bound: number;
        missingFonts: string[];
        warnings: string[];
        journal: JournalEntryLike[];
      }>(
        'import_screen',
        {
          operationId,
          parentId,
          x: 0,
          y: 0,
          layer: screen.layer,
          images: imagesFor(screen),
          bindTokens: options.bindTokens,
          meta: { name: screen.spec.name, ...screen.source, importedAt: new Date().toISOString() },
        },
        180_000
      );

    let built;
    try {
      built = await attempt(buildScreen, (wait, why) => options.progress(index, screens.length, `Retrying ${screen.spec.name} in ${Math.round(wait / 1000)}s — ${why}`));
    } catch (error) {
      const message = `"${screen.spec.name}" failed in Figma: ${error instanceof Error ? error.message : String(error)}`;
      await record([], [], message);
      throw new Error(message);
    }
    await record(built.journal, [built.nodeId]);
    result.sections[screen.section].screens.push({ name: built.name, id: built.nodeId, nodes: built.nodes, width: Math.round(built.width), height: Math.round(built.height) });
    result.boundColors += built.bound;
    built.missingFonts.forEach((font) => missingFonts.add(font));
    for (const warning of built.warnings) result.warnings.push(`${screen.spec.name}: ${warning}`);
  }
  result.missingFonts = [...missingFonts];

  // 4. Arrange by real sizes.
  const screenIds = new Map<PreparedScreen, string>();
  screens.forEach((screen, index) => {
    const section = result.sections[screen.section];
    const position = screens.filter((other, otherIndex) => other.section === screen.section && otherIndex < index).length;
    screenIds.set(screen, section.screens[position].id);
  });
  await attempt(
    () =>
      call(
        'import_arrange',
        {
          pageId: canvas.pageId,
          sections: options.sections.map((section, sectionIndex) => ({
            id: canvas.sections[`s${sectionIndex}`],
            noteId: canvas.notes[`s${sectionIndex}`],
            rows: section.rows.map((_, rowIndex) => ({
              noteId: canvas.notes[`s${sectionIndex}r${rowIndex}`],
              screenIds: screens.filter((screen) => screen.section === sectionIndex && screen.row === rowIndex).map((screen) => screenIds.get(screen)!),
            })),
          })),
        },
        120_000
      ),
    (wait) => options.progress(screens.length, screens.length, `Retrying the arrangement in ${Math.round(wait / 1000)}s`)
  );
  return result;
}
