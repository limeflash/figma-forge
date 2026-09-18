/**
 * Rendering sessions: open a page, bring it to the state that should be
 * imported, and read it.
 *
 * Every capture starts from a fresh load. Steps are replayed from scratch each
 * time, which costs a second per screen and buys determinism — a state reached
 * by clicking through a prototype should not depend on what the previous
 * capture happened to leave behind.
 */

import collectorSource from 'page-script:collect';
import type { RawCollection, RawSurvey } from '../../../shared/html-import.js';
import { acquireBrowser, Page, releaseBrowser } from './browser.js';
import { HtmlSource } from './source.js';
import { serveDirectory, StaticServer } from './serve.js';

export interface Viewport {
  width: number;
  height?: number;
}

export type Step =
  | { click: string }
  | { hover: string }
  | { type: string; into?: string }
  | { press: string }
  | { wait: number }
  | { eval: string }
  | { reload: true }
  | { viewport: Viewport }
  | { scroll: number };

export interface CaptureRequest {
  page: string;
  selector?: string;
  viewport?: Viewport;
  steps?: Step[];
  /** Grow the viewport until no scroll container hides content. Default true. */
  fullHeight?: boolean;
  exclude?: string[];
  rasterize?: string[];
  /** Also return a picture of the captured element, as the page shows it. */
  screenshot?: boolean;
  /** For `>>>` selectors: the width to give the innermost iframe (the device). */
  frameWidth?: number;
}

export type AssetData =
  | { kind: 'bitmap'; mime: string; bytes: Buffer; width: number; height: number }
  | { kind: 'svg'; text: string }
  | { kind: 'missing'; reason: string };

export interface Capture {
  collection: RawCollection;
  assets: Map<string, AssetData>;
  viewport: { width: number; height: number };
  errors: string[];
  warnings: string[];
  /** PNG of the captured element at 1x, when requested. */
  shot?: Buffer;
  ms: number;
}

export interface SurveyResult {
  survey: RawSurvey;
  shots: Buffer[];
  errors: string[];
  unstable: boolean;
  ms: number;
}

export const DEFAULT_VIEWPORT = { width: 1600, height: 1000 };
const MAX_VIEWPORT_HEIGHT = 20_000;
const RASTER_SCALE = 2;

export class RenderSession {
  /** The collector is re-injected on every navigation, reloads included. */
  private injected = false;

  /**
   * The page state a capture can reuse: loaded for this key and not touched
   * since by steps. Boards hold dozens of screens, and reloading an offline
   * export for each one is most of an import's time.
   */
  private reusable: { key: string; errors: string[]; unstable: boolean } | null = null;

  private constructor(
    readonly source: HtmlSource,
    private readonly server: StaticServer,
    private page: Page
  ) {}

  /**
   * A browser that dies mid-import — a crashed tab, an out-of-memory kill —
   * should cost one screen's retry, not the whole build.
   */
  private static crashed(error: unknown): boolean {
    return /browser closed|connection is closed|Target closed|Session with given id not found|did not reload/i.test(
      error instanceof Error ? error.message : String(error)
    );
  }

  private async revive(viewport: Viewport): Promise<void> {
    const browser = await acquireBrowser();
    this.page = await browser.newPage(viewport.width, viewport.height ?? DEFAULT_VIEWPORT.height);
    this.injected = false;
    this.reusable = null;
  }

  static async open(source: HtmlSource): Promise<RenderSession> {
    const server = await serveDirectory(source.root);
    try {
      const browser = await acquireBrowser();
      const page = await browser.newPage(DEFAULT_VIEWPORT.width, DEFAULT_VIEWPORT.height);
      return new RenderSession(source, server, page);
    } catch (error) {
      await server.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.page.close();
    await this.server.close();
    releaseBrowser();
  }

  private async load(pagePath: string, viewport: Viewport): Promise<{ errors: string[]; unstable: boolean }> {
    const width = viewport.width;
    const height = viewport.height ?? DEFAULT_VIEWPORT.height;
    await this.page.setViewport(width, height);
    await this.page.transparentBackground(false);
    // Prototypes remember which step they were on. Without this, a capture
    // inherits whatever the previous one left behind.
    await this.page
      .send('Storage.clearDataForOrigin', {
        origin: this.server.origin,
        storageTypes: 'local_storage,session_storage,indexeddb,cache_storage,websql',
      })
      .catch(() => undefined);
    // `page.html?embed=1#step` keeps its query and hash; only the path is a file.
    const cut = pagePath.search(/[?#]/);
    const url = cut < 0 ? this.server.url(pagePath) : this.server.url(pagePath.slice(0, cut)) + pagePath.slice(cut);
    if (!this.injected) {
      await this.page.send('Page.addScriptToEvaluateOnNewDocument', { source: collectorSource });
      this.injected = true;
    }
    await this.page.goto(url);
    // Bundles replace the document after load; the injected copy survives that,
    // but a page that never navigated needs one now.
    const hasCollector = await this.page.evaluate<boolean>('typeof __ff === "object"').catch(() => false);
    if (!hasCollector) await this.page.evaluate(collectorSource);
    const ready = await this.page.call<{ stable: boolean; errors: string[] }>('__ff.prepare');
    return { errors: [...ready.errors, ...this.page.errors], unstable: !ready.stable };
  }

  async survey(pagePath: string, viewport: Viewport, screenshots: boolean, steps: Step[] = []): Promise<SurveyResult> {
    const started = Date.now();
    this.reusable = null;
    const loaded = await this.load(pagePath, viewport);
    const warnings: string[] = [];
    await this.runSteps(steps, warnings);
    const survey = await this.page.call<RawSurvey>('__ff.survey');
    const shots: Buffer[] = [];

    if (screenshots) {
      await this.page.call('__ff.annotate', survey.screens.map((screen) => screen.box));
      const { width, height } = survey.document;
      const tiles = Math.max(1, Math.min(6, Math.ceil(height / (width * 1.25))));
      const tileHeight = Math.ceil(height / tiles);
      const scale = Math.min(1, 1000 / width, 1400 / tileHeight);
      for (let index = 0; index < tiles; index++) {
        const y = index * tileHeight;
        shots.push(
          await this.page.screenshot({ x: 0, y, width, height: Math.min(tileHeight, height - y) }, scale)
        );
      }
      await this.page.call('__ff.annotate', null);
    }

    return { survey, shots, errors: [...loaded.errors, ...warnings], unstable: loaded.unstable, ms: Date.now() - started };
  }

  private async runSteps(steps: Step[], warnings: string[]): Promise<void> {
    for (const [index, step] of steps.entries()) {
      try {
        await this.runStep(step, warnings);
      } catch (error) {
        throw new Error(`Step ${index + 1} (${JSON.stringify(step)}) failed: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  private async runStep(step: Step, warnings: string[]): Promise<void> {
    const locate = async (target: string) => {
      const found = await this.page.call<{ x: number; y: number; text: string } | { error: string }>('__ff.locate', target);
      if ('error' in found) throw new Error(found.error);
      return found;
    };

    if ('click' in step) {
      const point = await locate(step.click);
      await this.page.click(point.x, point.y);
    } else if ('hover' in step) {
      const point = await locate(step.hover);
      await this.page.mouse('mouseMoved', point.x, point.y);
    } else if ('type' in step) {
      if (step.into) {
        const point = await locate(step.into);
        await this.page.click(point.x, point.y);
      }
      await this.page.insertText(step.type);
    } else if ('press' in step) {
      await this.page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: step.press });
      await this.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: step.press });
    } else if ('wait' in step) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, Math.max(0, step.wait))));
    } else if ('eval' in step) {
      // A script that navigates kills its own execution context; that is a
      // successful step, not a failure.
      await this.page.evaluate(step.eval).catch((error) => {
        if (!/context was destroyed|Execution context/i.test(String(error))) throw error;
      });
    } else if ('reload' in step) {
      await this.page.reload();
      await this.page.call('__ff.prepare');
      return;
    } else if ('viewport' in step) {
      await this.page.setViewport(step.viewport.width, step.viewport.height ?? DEFAULT_VIEWPORT.height);
    } else if ('scroll' in step) {
      await this.page.evaluate(`window.scrollTo(0, ${Number(step.scroll) || 0})`);
    } else {
      warnings.push(`Unknown step ${JSON.stringify(step)} was skipped.`);
      return;
    }
    await this.page.call('__ff.settle');
  }

  async capture(request: CaptureRequest): Promise<Capture> {
    try {
      return await this.captureOnce(request);
    } catch (error) {
      if (!RenderSession.crashed(error)) throw error;
      await this.revive(request.viewport ?? DEFAULT_VIEWPORT);
      return await this.captureOnce(request);
    }
  }

  private async captureOnce(request: CaptureRequest): Promise<Capture> {
    const started = Date.now();
    const viewport = { width: request.viewport?.width ?? DEFAULT_VIEWPORT.width, height: request.viewport?.height ?? DEFAULT_VIEWPORT.height };
    const key = JSON.stringify([request.page, viewport.width, viewport.height]);
    const steps = request.steps ?? [];
    let loaded: { errors: string[]; unstable: boolean };
    if (!steps.length && !request.frameWidth && this.reusable?.key === key) {
      loaded = this.reusable;
    } else {
      loaded = await this.load(request.page, viewport);
      this.reusable = { key, ...loaded };
    }
    const warnings: string[] = [];
    if (loaded.unstable) warnings.push('The page kept changing; it was captured after 20 seconds anyway.');

    if (steps.length || request.frameWidth) this.reusable = null;
    await this.runSteps(steps, warnings);

    const selector = request.selector && request.selector !== 'auto' ? request.selector : 'body';
    let height = viewport.height;
    if (selector.includes('>>>') && (request.fullHeight !== false || request.frameWidth)) {
      for (let pass = 0; pass < 4; pass++) {
        const grown = await this.page.call<number>('__ff.expandFrames', selector, request.frameWidth);
        if (grown <= 1) break;
        await this.page.call('__ff.settle');
      }
    }
    if (request.fullHeight !== false) {
      for (let pass = 0; pass < 4; pass++) {
        const hidden = await this.page.call<number>('__ff.hiddenOverflow', selector);
        if (hidden <= 1 || height >= MAX_VIEWPORT_HEIGHT) break;
        height = Math.min(MAX_VIEWPORT_HEIGHT, height + hidden);
        await this.page.setViewport(viewport.width, height);
        await this.page.call('__ff.settle');
      }
    }
    await this.page.evaluate('window.scrollTo(0, 0)');
    // Park the pointer where it cannot leave a hover state behind.
    const hovering = request.steps?.some((step) => 'hover' in step);
    if (!hovering) await this.page.mouse('mouseMoved', 0, 0);

    let shot: Buffer | undefined;
    if (request.screenshot) {
      const box = await this.page.call<[number, number, number, number] | null>('__ff.boxOf', selector);
      if (box && box[2] >= 1 && box[3] >= 1) {
        const scale = Math.min(1, 4096 / box[3]);
        shot = await this.page.screenshot({ x: box[0], y: box[1], width: box[2], height: box[3] }, scale);
      }
    }

    const collection = await this.page.call<RawCollection>('__ff.collect', {
      root: selector,
      exclude: request.exclude,
      rasterize: request.rasterize,
    });
    warnings.push(...collection.warnings);

    const assets = new Map<string, AssetData>();
    const fetched = collection.assets.filter((asset) => asset.kind !== 'raster');
    for (const asset of fetched) {
      const [, , boxWidth, boxHeight] = asset.box ?? [0, 0, 1024, 1024];
      const maxWidth = Math.min(4096, Math.max(64, Math.ceil(boxWidth * RASTER_SCALE)));
      const maxHeight = Math.min(4096, Math.max(64, Math.ceil(boxHeight * RASTER_SCALE)));
      const result = await this.page.call<
        | { kind: 'svg'; text: string }
        | { kind: 'bitmap'; mime: string; data: string; width: number; height: number }
        | { kind: 'error'; error: string }
      >('__ff.asset', asset.src, maxWidth, maxHeight);
      if (result.kind === 'bitmap') {
        assets.set(asset.id, { kind: 'bitmap', mime: result.mime, bytes: Buffer.from(result.data, 'base64'), width: result.width, height: result.height });
      } else if (result.kind === 'svg') {
        assets.set(asset.id, result);
      } else {
        assets.set(asset.id, { kind: 'missing', reason: result.error });
        warnings.push(`Image ${asset.src.slice(0, 80)} could not be read (${result.error}).`);
      }
    }

    const rasters = collection.assets.filter((asset) => asset.kind === 'raster');
    if (rasters.length) {
      await this.page.transparentBackground(true);
      try {
        for (const asset of rasters) {
          const box = await this.page.call<[number, number, number, number] | null>('__ff.isolate', asset.element ?? -1);
          if (!box || box[2] < 1 || box[3] < 1) {
            assets.set(asset.id, { kind: 'missing', reason: 'element vanished before it could be captured' });
            continue;
          }
          const scale = Math.min(RASTER_SCALE, 4096 / box[2], 4096 / box[3]);
          const bytes = await this.page.screenshot({ x: box[0], y: box[1], width: box[2], height: box[3] }, scale);
          assets.set(asset.id, { kind: 'bitmap', mime: 'image/png', bytes, width: Math.round(box[2] * scale), height: Math.round(box[3] * scale) });
        }
      } finally {
        await this.page.call('__ff.isolate', null);
        await this.page.transparentBackground(false);
      }
    }

    return {
      collection,
      assets,
      viewport: { width: viewport.width, height },
      errors: [...loaded.errors, ...this.page.errors].filter((value, index, all) => all.indexOf(value) === index),
      warnings,
      shot,
      ms: Date.now() - started,
    };
  }
}
