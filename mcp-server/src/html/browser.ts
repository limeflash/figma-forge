/**
 * A headless Chromium, driven over the DevTools protocol.
 *
 * Claude Design exports cannot be read as files: an offline export unpacks its
 * page from a manifest at runtime, and a `.dc.html` source is rendered by React.
 * The only faithful reading is the one a browser produces, so we ask a browser.
 *
 * Puppeteer and Playwright would each download a browser of their own and add
 * megabytes to a bundle that ships without an install step. The protocol itself
 * is small — a WebSocket and a dozen methods — so this talks to whichever
 * Chromium-family browser the machine already has.
 */

import { ChildProcess, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, platform, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { WebSocket } from 'ws';

export class BrowserUnavailable extends Error {
  readonly remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = 'BrowserUnavailable';
    this.remedy = remedy;
  }
}

function macCandidates(): string[] {
  const apps = [
    ['Google Chrome', 'Google Chrome'],
    ['Chromium', 'Chromium'],
    ['Microsoft Edge', 'Microsoft Edge'],
    ['Brave Browser', 'Brave Browser'],
    ['Google Chrome Canary', 'Google Chrome Canary'],
    ['Vivaldi', 'Vivaldi'],
  ];
  const roots = ['/Applications', join(homedir(), 'Applications')];
  return roots.flatMap((root) => apps.map(([app, binary]) => join(root, `${app}.app`, 'Contents', 'MacOS', binary)));
}

function windowsCandidates(): string[] {
  const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']].filter(
    (root): root is string => !!root
  );
  const relative = [
    'Google\\Chrome\\Application\\chrome.exe',
    'Chromium\\Application\\chrome.exe',
    'Microsoft\\Edge\\Application\\msedge.exe',
    'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  ];
  return roots.flatMap((root) => relative.map((path) => join(root, path)));
}

function pathCandidates(): string[] {
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'];
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  return dirs.flatMap((dir) => names.map((name) => join(dir, name)));
}

/** Browsers Playwright already downloaded, if the user has it. */
function playwrightCandidates(): string[] {
  const cache =
    platform() === 'darwin'
      ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
      : platform() === 'win32'
        ? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
        : join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(cache)) return [];
  const out: string[] = [];
  for (const dir of readdirSync(cache).filter((name) => name.startsWith('chromium')).sort().reverse()) {
    out.push(
      join(cache, dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      join(cache, dir, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      join(cache, dir, 'chrome-linux', 'chrome'),
      join(cache, dir, 'chrome-win', 'chrome.exe')
    );
  }
  return out;
}

export function findBrowser(): string | null {
  const explicit = process.env.FIGMA_FORGE_BROWSER;
  if (explicit && explicit.trim() && !explicit.includes('${')) return existsSync(explicit) ? explicit : null;

  const os = platform();
  const candidates = [
    ...(os === 'darwin' ? macCandidates() : os === 'win32' ? windowsCandidates() : []),
    ...pathCandidates(),
    ...playwrightCandidates(),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

type Listener = (params: Record<string, unknown>, sessionId?: string) => void;

class Connection {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; method: string }>();
  private readonly listeners = new Map<string, Set<Listener>>();
  closed = false;

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (raw) => {
      let message: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string }; sessionId?: string };
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result);
        return;
      }
      if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {}, message.sessionId);
      }
    });
    socket.on('close', () => {
      this.closed = true;
      for (const pending of this.pending.values()) pending.reject(new Error(`The browser closed during ${pending.method}.`));
      this.pending.clear();
    });
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The browser connection is closed.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  on(method: string, listener: Listener): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
  }

  close(): void {
    this.socket.close();
  }
}

export interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class Page {
  private readonly connection: Connection;
  readonly sessionId: string;
  readonly targetId: string;
  readonly errors: string[] = [];

  constructor(connection: Connection, targetId: string, sessionId: string) {
    this.connection = connection;
    this.targetId = targetId;
    this.sessionId = sessionId;
    connection.on('Runtime.exceptionThrown', (params, session) => {
      if (session !== sessionId) return;
      const details = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
      const text = details?.exception?.description ?? details?.text ?? 'exception';
      if (this.errors.length < 20) this.errors.push(text.split('\n')[0].slice(0, 300));
    });
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.connection.send<T>(method, params, this.sessionId);
  }

  private waitForEvent(method: string, timeoutMs: number, predicate: (params: Record<string, unknown>) => boolean = () => true): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve(false);
      }, timeoutMs);
      const off = this.connection.on(method, (params, session) => {
        if (session !== this.sessionId || !predicate(params)) return;
        clearTimeout(timer);
        off();
        resolve(true);
      });
    });
  }

  async init(): Promise<void> {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Page.setLifecycleEventsEnabled', { enabled: true });
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: Math.round(width),
      height: Math.round(height),
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  /** Navigates and waits for load plus a quiet network, whichever comes last. */
  async goto(url: string, timeoutMs = 30_000): Promise<void> {
    this.errors.length = 0;
    const loaded = this.waitForEvent('Page.loadEventFired', timeoutMs);
    const idle = this.waitForEvent('Page.lifecycleEvent', timeoutMs, (params) => params.name === 'networkAlmostIdle');
    const result = await this.send<{ errorText?: string }>('Page.navigate', { url });
    if (result.errorText) throw new Error(`Could not open ${url}: ${result.errorText}`);
    if (!(await loaded)) throw new Error(`The page did not finish loading within ${timeoutMs / 1000}s.`);
    await Promise.race([idle, new Promise((resolve) => setTimeout(resolve, 5000))]);
  }

  /** Reloads and waits for the new document, keeping injected scripts. */
  async reload(timeoutMs = 30_000): Promise<void> {
    const loaded = this.waitForEvent('Page.loadEventFired', timeoutMs);
    await this.send('Page.reload', {});
    if (!(await loaded)) throw new Error(`The page did not reload within ${timeoutMs / 1000}s.`);
  }

  async evaluate<T>(expression: string, timeoutMs = 60_000): Promise<T> {
    const result = await this.send<{
      result: { value?: T; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(`In page: ${details.exception?.description ?? details.text ?? 'script failed'}`);
    }
    return result.result.value as T;
  }

  /** Calls a global function the injected script defined, with JSON arguments. */
  async call<T>(name: string, ...args: unknown[]): Promise<T> {
    return await this.evaluate<T>(`${name}(...${JSON.stringify(args)})`);
  }

  async screenshot(clip: Clip, scale: number): Promise<Buffer> {
    const result = await this.send<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
      clip: { ...clip, scale },
      captureBeyondViewport: true,
      fromSurface: true,
    });
    return Buffer.from(result.data, 'base64');
  }

  async transparentBackground(on: boolean): Promise<void> {
    await this.send('Emulation.setDefaultBackgroundColorOverride', on ? { color: { r: 0, g: 0, b: 0, a: 0 } } : {});
  }

  async mouse(type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1,
    });
  }

  async click(x: number, y: number): Promise<void> {
    await this.mouse('mouseMoved', x, y);
    await this.mouse('mousePressed', x, y);
    await this.mouse('mouseReleased', x, y);
  }

  async insertText(text: string): Promise<void> {
    await this.send('Input.insertText', { text });
  }

  async close(): Promise<void> {
    await this.connection.send('Target.closeTarget', { targetId: this.targetId }).catch(() => undefined);
  }
}

export class Browser {
  readonly executable: string;
  private readonly child: ChildProcess;
  private readonly connection: Connection;
  private readonly profile: string;

  private constructor(executable: string, child: ChildProcess, connection: Connection, profile: string) {
    this.executable = executable;
    this.child = child;
    this.connection = connection;
    this.profile = profile;
  }

  get alive(): boolean {
    return !this.connection.closed && this.child.exitCode === null;
  }

  static async launch(): Promise<Browser> {
    const executable = findBrowser();
    if (!executable) {
      throw new BrowserUnavailable(
        'No Chromium-based browser was found to render the HTML.',
        'Install Google Chrome, Microsoft Edge, Brave or Chromium — or point FIGMA_FORGE_BROWSER at one.'
      );
    }

    const profile = await mkdtemp(join(tmpdir(), 'figma-forge-browser-'));
    const child = spawn(
      executable,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-scrollbars',
        '--mute-audio',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-translate',
        '--disable-features=Translate,MediaRouter',
        '--password-store=basic',
        '--use-mock-keychain',
        '--font-render-hinting=none',
        `--user-data-dir=${profile}`,
        '--remote-debugging-port=0',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );

    let stderr = '';
    const endpoint = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${executable} did not start: ${stderr.slice(-400)}`)), 20_000);
      child.stderr!.on('data', (chunk) => {
        stderr += chunk.toString();
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`${executable} exited with code ${code}: ${stderr.slice(-400)}`));
      });
    });
    // Keep draining so a chatty browser never blocks on a full pipe.
    child.stderr!.on('data', () => undefined);

    const socket = new WebSocket(endpoint, { maxPayload: 512 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });

    const browser = new Browser(executable, child, new Connection(socket), profile);
    const kill = () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };
    process.once('exit', kill);
    child.once('exit', () => process.removeListener('exit', kill));
    return browser;
  }

  async newPage(width: number, height: number): Promise<Page> {
    const { targetId } = await this.connection.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.connection.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this.connection, targetId, sessionId);
    await page.init();
    await page.setViewport(width, height);
    return page;
  }

  async close(): Promise<void> {
    await this.connection.send('Browser.close').catch(() => undefined);
    this.connection.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (this.child.exitCode === null) this.child.kill();
    await rm(this.profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * One browser per MCP process, kept warm between calls — a survey followed by
 * a build is the normal rhythm, and a cold start costs a second or two.
 */
let shared: Promise<Browser> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
const IDLE_MS = 3 * 60 * 1000;

export async function acquireBrowser(): Promise<Browser> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (shared) {
    const existing = await shared.catch(() => null);
    if (existing && existing.alive) return existing;
    shared = null;
  }
  shared = Browser.launch();
  return await shared;
}

export function releaseBrowser(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const current = shared;
    shared = null;
    idleTimer = null;
    const browser = await current?.catch(() => null);
    await browser?.close();
  }, IDLE_MS);
  idleTimer.unref();
}
