/**
 * Bridge lifecycle and request/response client.
 *
 * The bridge is a shared local service, not a child of this process. Claude Code
 * restarts often; if the socket died with the MCP server, the user would have to
 * re-open the Figma plugin every single time. So we spawn it detached, and any
 * later session that finds the port already answering simply joins it.
 *
 * Ownership is therefore "whoever got there first" — which is why the bridge
 * exits quietly on EADDRINUSE instead of treating it as an error.
 */

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';

export interface BridgeHealth {
  ok: boolean;
  port: number;
  channels: Record<string, { agents: number; figma: number }>;
}

export interface BridgeOptions {
  port: number;
  host?: string;
  channel: string;
  /** Absolute path to the bundled bridge entry point. */
  bridgeScript: string;
  requestTimeoutMs?: number;
}

export class BridgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'BridgeError';
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  command: string;
}

export class Bridge {
  private readonly options: Required<BridgeOptions>;
  /**
   * Whether the caller pinned a host. We connect and health-check over IPv4, but
   * forwarding that as the bridge's bind address would collapse it to a single
   * stack — and the plugin UI has to reach it as `localhost`, which may resolve
   * to ::1 first. So the default stays unset and the bridge binds both.
   */
  private readonly hostWasSpecified: boolean;
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  private joined = false;
  private figmaPeers = 0;
  private lastError: string | null = null;
  private closedIntentionally = false;

  constructor(options: BridgeOptions) {
    this.hostWasSpecified = options.host !== undefined;
    this.options = {
      host: '127.0.0.1',
      requestTimeoutMs: 60_000,
      ...options,
    };
  }

  get channel(): string {
    return this.options.channel;
  }

  get port(): number {
    return this.options.port;
  }

  setChannel(channel: string): void {
    if (channel === this.options.channel) return;
    this.options.channel = channel;
    this.joined = false;
    // Re-join rather than reconnect: the socket is fine, the membership is not.
    if (this.socket && this.socket.readyState === WebSocket.OPEN) this.join();
  }

  async health(): Promise<BridgeHealth | null> {
    try {
      const response = await fetch(`http://${this.options.host}:${this.options.port}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) return null;
      return (await response.json()) as BridgeHealth;
    } catch {
      return null;
    }
  }

  /** Starts the bridge if nothing is answering on the port yet. */
  async ensureRunning(): Promise<{ running: boolean; started: boolean; health: BridgeHealth | null }> {
    const existing = await this.health();
    if (existing) return { running: true, started: false, health: existing };

    const child = spawn(process.execPath, [this.options.bridgeScript], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        FIGMA_FORGE_BRIDGE_PORT: String(this.options.port),
        ...(this.hostWasSpecified ? { FIGMA_FORGE_BRIDGE_HOST: this.options.host } : {}),
      },
    });
    child.unref();

    for (let attempt = 0; attempt < 40; attempt++) {
      await delay(125);
      const health = await this.health();
      if (health) return { running: true, started: true, health };
    }

    return { running: false, started: false, health: null };
  }

  async connect(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN && this.joined) return;
    if (this.connecting) return this.connecting;

    this.closedIntentionally = false;
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://${this.options.host}:${this.options.port}`);
      this.socket = socket;

      const settleTimer = setTimeout(() => {
        reject(new BridgeError('BRIDGE_TIMEOUT', `The bridge on port ${this.options.port} did not accept a connection.`));
        socket.terminate();
      }, 5000);

      socket.on('open', () => {
        this.join();
      });

      socket.on('message', (raw) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          return;
        }

        if (message.type === 'system') {
          if (message.event === 'joined') {
            this.joined = true;
            const peers = message.peers as { figma?: number } | undefined;
            this.figmaPeers = peers?.figma ?? 0;
            clearTimeout(settleTimer);
            resolve();
          } else if (message.event === 'peer-joined' || message.event === 'peer-left') {
            const peers = message.peers as { figma?: number } | undefined;
            this.figmaPeers = peers?.figma ?? 0;
          } else if (message.event === 'error') {
            this.lastError = String(message.message ?? 'bridge error');
          }
          return;
        }

        if (message.type === 'response') {
          const pending = this.pending.get(String(message.id));
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(String(message.id));
          if (message.ok) {
            pending.resolve(message.result);
          } else {
            const error = (message.error ?? {}) as { code?: string; message?: string; stack?: string };
            const failure = new BridgeError(error.code ?? 'COMMAND_FAILED', error.message ?? 'The Figma plugin returned an error.');
            if (error.stack) failure.stack = error.stack;
            pending.reject(failure);
          }
        }
      });

      socket.on('error', (error: Error) => {
        this.lastError = error.message;
        clearTimeout(settleTimer);
        reject(new BridgeError('BRIDGE_UNREACHABLE', `Could not reach the bridge on port ${this.options.port}: ${error.message}`));
      });

      socket.on('close', () => {
        this.joined = false;
        this.socket = null;
        this.figmaPeers = 0;
        // Fail every in-flight call rather than letting them hit their timeout:
        // a dropped socket is information the caller should get immediately.
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new BridgeError('BRIDGE_CLOSED', `The bridge connection dropped during "${pending.command}".`));
          this.pending.delete(id);
        }
      });
    }).finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  private join(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: 'join', channel: this.options.channel, role: 'agent' }));
  }

  /** Brings the bridge up, connects and joins — the entry point for every tool. */
  async ready(): Promise<void> {
    const state = await this.ensureRunning();
    if (!state.running) {
      throw new BridgeError(
        'BRIDGE_START_FAILED',
        `Could not start the Figma Forge bridge on port ${this.options.port}. ` +
          'Another process may own the port without being a bridge — set a different port in the plugin settings.'
      );
    }
    if (!this.closedIntentionally) await this.connect();
  }

  async request<T = unknown>(command: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    await this.ready();
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new BridgeError('BRIDGE_CLOSED', 'The bridge connection is not open.');
    }

    const id = `a${this.nextId++}`;
    const limit = timeoutMs ?? this.options.requestTimeoutMs;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BridgeError(
            'COMMAND_TIMEOUT',
            `"${command}" did not answer within ${limit}ms. The Figma plugin may be busy on a large file, ` +
              'or the tab may have been closed.'
          )
        );
      }, limit);

      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, command });
      this.socket!.send(JSON.stringify({ type: 'request', channel: this.options.channel, id, command, params }));
    });
  }

  async status(): Promise<{
    port: number;
    channel: string;
    bridgeRunning: boolean;
    agentConnected: boolean;
    figmaAttached: boolean;
    figmaClients: number;
    channels: Record<string, { agents: number; figma: number }>;
    lastError: string | null;
  }> {
    const health = await this.health();
    const channelState = health?.channels?.[this.options.channel];
    return {
      port: this.options.port,
      channel: this.options.channel,
      bridgeRunning: !!health,
      agentConnected: this.joined,
      figmaAttached: (channelState?.figma ?? this.figmaPeers) > 0,
      figmaClients: channelState?.figma ?? this.figmaPeers,
      channels: health?.channels ?? {},
      lastError: this.lastError,
    };
  }

  close(): void {
    this.closedIntentionally = true;
    this.socket?.close();
    this.socket = null;
  }
}
