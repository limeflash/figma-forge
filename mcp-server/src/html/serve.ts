/**
 * Serves a source folder to the headless browser.
 *
 * `file://` is not enough: `.dc.html` sources load ES modules and fetch their
 * icon data, and Chrome blocks both from file URLs. So the folder is served on
 * loopback, under a random path prefix, for as long as one import runs.
 *
 * The prefix matters because a local port is reachable by any page open in the
 * user's browser; without it, a guessed port would expose the folder.
 */

import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, Server } from 'node:http';
import { AddressInfo, Socket } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
};

export interface StaticServer {
  readonly root: string;
  /** `http://127.0.0.1:<port>` — the origin whose storage a capture resets. */
  readonly origin: string;
  /** URL for a path relative to the root. */
  url(path: string): string;
  close(): Promise<void>;
}

export async function serveDirectory(root: string): Promise<StaticServer> {
  const base = normalize(root);
  const token = randomBytes(8).toString('hex');
  const prefix = `/${token}/`;
  const sockets = new Set<Socket>();

  const server: Server = createServer(async (req, res) => {
    const send = (status: number, body: string) => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    };

    const url = req.url ?? '/';
    if (!url.startsWith(prefix)) return send(404, 'not found');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'method not allowed');

    let relativePath: string;
    try {
      relativePath = decodeURIComponent(url.slice(prefix.length).split(/[?#]/)[0]);
    } catch {
      return send(400, 'bad path');
    }

    const target = normalize(join(base, relativePath));
    if (target !== base && !target.startsWith(base + sep)) return send(403, 'forbidden');

    try {
      let file = target;
      let info = await stat(file);
      if (info.isDirectory()) {
        file = join(file, 'index.html');
        info = await stat(file);
      }
      res.writeHead(200, {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': info.size,
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      if (req.method === 'HEAD') return res.end();
      createReadStream(file).on('error', () => res.destroy()).pipe(res);
    } catch {
      send(404, 'not found');
    }
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    root: base,
    origin: `http://127.0.0.1:${port}`,
    url(path: string) {
      const encoded = path
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      return `http://127.0.0.1:${port}${prefix}${encoded}`;
    },
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
