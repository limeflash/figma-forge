/**
 * Figma Forge bridge.
 *
 * A channel-based WebSocket relay sitting between the MCP server (spoken to by
 * Claude Code) and the Figma plugin's UI iframe. It deliberately owns no domain
 * logic: it routes envelopes and tracks who is in which channel.
 *
 * It runs as its own detached process rather than inside the MCP server so that
 * restarting Claude Code does not drop the Figma plugin's socket — the user
 * should never have to re-open the plugin just because a session restarted.
 *
 * Envelope shapes on the wire:
 *   -> { type: "join",     channel, role: "agent" | "figma", id? }
 *   -> { type: "request",  channel, id, command, params }
 *   -> { type: "response", channel, id, ok, result?, error? }
 *   -> { type: "progress", channel, id, ...payload }
 *   <- { type: "system",   channel?, event, ...payload }
 */

import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';

const PORT = Number(process.env.FIGMA_FORGE_BRIDGE_PORT || 3055);
const HOST = process.env.FIGMA_FORGE_BRIDGE_HOST || '127.0.0.1';

/** @type {Map<string, { agents: Set<import('ws').WebSocket>, figma: Set<import('ws').WebSocket> }>} */
const channels = new Map();

function getChannel(name) {
  let channel = channels.get(name);
  if (!channel) {
    channel = { agents: new Set(), figma: new Set() };
    channels.set(name, channel);
  }
  return channel;
}

function send(socket, payload) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}

function broadcast(sockets, payload, except) {
  for (const socket of sockets) {
    if (socket !== except) send(socket, payload);
  }
}

function describe(channel) {
  return { agents: channel.agents.size, figma: channel.figma.size };
}

const http = createServer((req, res) => {
  // A plain GET is how the MCP server checks whether a bridge is already up,
  // and how it learns which channels currently have Figma attached.
  if (req.url === '/health') {
    const body = JSON.stringify({
      ok: true,
      port: PORT,
      channels: Object.fromEntries(
        [...channels].map(([name, channel]) => [name, describe(channel)])
      ),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('figma-forge bridge');
});

const wss = new WebSocketServer({ server: http });

wss.on('connection', (socket) => {
  /** @type {{ channel: string, role: 'agent' | 'figma' } | null} */
  let membership = null;

  send(socket, { type: 'system', event: 'hello', port: PORT });

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(socket, { type: 'system', event: 'error', message: 'Malformed JSON' });
      return;
    }

    if (msg.type === 'join') {
      const { channel: name, role } = msg;
      if (typeof name !== 'string' || !name) {
        send(socket, { type: 'system', event: 'error', message: 'channel is required' });
        return;
      }
      if (role !== 'agent' && role !== 'figma') {
        send(socket, { type: 'system', event: 'error', message: 'role must be "agent" or "figma"' });
        return;
      }

      // A socket belongs to exactly one channel; re-joining moves it.
      if (membership) {
        const previous = getChannel(membership.channel);
        previous[membership.role === 'agent' ? 'agents' : 'figma'].delete(socket);
      }

      const channel = getChannel(name);
      channel[role === 'agent' ? 'agents' : 'figma'].add(socket);
      membership = { channel: name, role };

      send(socket, {
        type: 'system',
        event: 'joined',
        channel: name,
        role,
        id: msg.id,
        peers: describe(channel),
      });

      // Tell the other side someone arrived, so the MCP server can flush any
      // queued work and the plugin UI can show a connected state.
      const others = role === 'agent' ? channel.figma : channel.agents;
      broadcast(others, { type: 'system', event: 'peer-joined', channel: name, role, peers: describe(channel) });
      return;
    }

    if (!membership) {
      send(socket, { type: 'system', event: 'error', message: 'join a channel first', id: msg.id });
      return;
    }

    const channel = getChannel(membership.channel);

    // Requests flow agent -> figma; responses and progress flow figma -> agent.
    if (msg.type === 'request') {
      if (channel.figma.size === 0) {
        send(socket, {
          type: 'response',
          channel: membership.channel,
          id: msg.id,
          ok: false,
          error: {
            code: 'NO_FIGMA_CLIENT',
            message:
              `No Figma plugin is attached to channel "${membership.channel}". ` +
              'Open the Figma Forge plugin in the target file and join this channel.',
          },
        });
        return;
      }
      broadcast(channel.figma, { ...msg, channel: membership.channel });
      return;
    }

    if (msg.type === 'response' || msg.type === 'progress') {
      broadcast(channel.agents, { ...msg, channel: membership.channel });
      return;
    }

    send(socket, { type: 'system', event: 'error', message: `Unknown type "${msg.type}"`, id: msg.id });
  });

  socket.on('close', () => {
    if (!membership) return;
    const channel = getChannel(membership.channel);
    channel[membership.role === 'agent' ? 'agents' : 'figma'].delete(socket);

    const others = membership.role === 'agent' ? channel.figma : channel.agents;
    broadcast(others, {
      type: 'system',
      event: 'peer-left',
      channel: membership.channel,
      role: membership.role,
      peers: describe(channel),
    });

    if (channel.agents.size === 0 && channel.figma.size === 0) {
      channels.delete(membership.channel);
    }
  });
});

http.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Another bridge already owns the port — that is the healthy case when a
    // second Claude Code session starts. Exit quietly so the caller falls back
    // to the running instance.
    process.stderr.write(`figma-forge bridge: port ${PORT} already in use, deferring to the running instance\n`);
    process.exit(3);
  }
  process.stderr.write(`figma-forge bridge: ${err.stack || err.message}\n`);
  process.exit(1);
});

http.listen(PORT, HOST, () => {
  process.stdout.write(`figma-forge bridge listening on ws://${HOST}:${PORT}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    wss.close();
    http.close(() => process.exit(0));
  });
}
