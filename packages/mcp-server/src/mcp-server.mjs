import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBus } from './bus-client.mjs';
import { SWARM_TOOLS } from './tool-schemas.mjs';
import { buildToolHandlers } from './tools.mjs';

const SERVER_INFO = { name: 'swarm-qa-browser', version: '0.3.0' };
const DEFAULT_PROTOCOL = '2024-11-05';
const LF = 0x0a;
const CR = 0x0d;

/**
 * Splits a stdio byte stream into JSON-RPC messages. Supports both newline-delimited JSON (the MCP
 * stdio transport) and `Content-Length` framed messages (LSP-style clients).
 */
function createMessageReader(onMessage, onParseError) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (buffer.length > 0) {
      while (buffer.length && (buffer[0] === LF || buffer[0] === CR)) buffer = buffer.subarray(1);
      if (!buffer.length) break;
      const newline = buffer.indexOf(LF);
      const firstLine = buffer.subarray(0, newline !== -1 ? newline : buffer.length).toString('utf8');
      if (/^[a-z0-9-]+:/i.test(firstLine)) {
        const crlf = buffer.indexOf('\r\n\r\n');
        const lf = buffer.indexOf('\n\n');
        const headerEnd = crlf !== -1 && (lf === -1 || crlf < lf) ? crlf : lf;
        if (headerEnd === -1) break;
        const separator = buffer[headerEnd] === CR ? 4 : 2;
        const length = /^content-length:\s*(\d+)/im.exec(buffer.subarray(0, headerEnd).toString('utf8'));
        if (!length) {
          buffer = buffer.subarray(headerEnd + separator);
          onParseError(true);
          continue;
        }
        const end = headerEnd + separator + Number(length[1]);
        if (buffer.length < end) break;
        onMessage(buffer.subarray(headerEnd + separator, end).toString('utf8'), true);
        buffer = buffer.subarray(end);
      } else {
        if (newline === -1) break;
        const line = buffer.subarray(0, newline).toString('utf8').trim();
        buffer = buffer.subarray(newline + 1);
        if (line) onMessage(line, false);
      }
    }
  };
}

/** Creates a stdio JSON-RPC 2.0 MCP server wired to the local Swarm QA bus. */
export function createMcpServer({ registryPath, busClient, desktopDriver, stdin = process.stdin, stdout = process.stdout } = {}) {
  let busState = null;
  let busPromise = null;
  const inflight = new Set();

  const ensureBus = () => (busPromise ??= resolveBus(registryPath, busClient).then((state) => (busState = state).client));
  const handlers = buildToolHandlers(async (action, params) => (await ensureBus()).rpc(action, params), { desktopDriver });

  function send(message, framed) {
    const json = JSON.stringify(message);
    stdout.write(framed ? `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}` : `${json}\n`);
  }
  const sendParseError = (framed) => send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, framed);

  async function handleMessage(msg, framed = false) {
    if (!msg || typeof msg !== 'object' || msg.id === undefined) return; // notifications need no reply
    const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result }, framed);
    const fail = (code, message) => send({ jsonrpc: '2.0', id: msg.id, error: { code, message } }, framed);

    if (msg.method === 'initialize') {
      return reply({
        protocolVersion: msg.params?.protocolVersion || DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO
      });
    }
    if (msg.method === 'ping') return reply({});
    if (msg.method === 'tools/list') return reply({ tools: SWARM_TOOLS });
    if (msg.method !== 'tools/call') return fail(-32601, `Method not found: ${msg.method}`);

    const name = msg.params?.name;
    if (typeof name !== 'string' || !Object.hasOwn(handlers, name)) return fail(-32602, `Unknown tool: ${name}`);
    try {
      const result = await handlers[name](msg.params?.arguments || {});
      // Tools that return images hand back ready-made MCP content.
      return reply({ content: result?.__mcpContent ?? [{ type: 'text', text: JSON.stringify(result) }] });
    } catch (err) {
      const payload = { ok: false, error: err?.message ?? String(err), code: err?.code ?? 'TOOL_ERROR' };
      return reply({ isError: true, content: [{ type: 'text', text: JSON.stringify(payload) }] });
    }
  }

  const onData = createMessageReader((raw, framed) => {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return sendParseError(framed);
    }
    const task = handleMessage(parsed, framed);
    inflight.add(task);
    task.finally(() => inflight.delete(task));
  }, sendParseError);
  stdin.on('data', onData);

  async function close() {
    stdin.off('data', onData);
    await Promise.allSettled([...inflight]);
    if (busPromise) await busPromise.catch(() => {});
    if (busState?.ownedBus) await busState.ownedBus.close();
  }

  return { start: () => ensureBus(), close, ensureBus, handleMessage };
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const server = createMcpServer();
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  void server.start().catch((err) => {
    process.stderr.write(`${err?.message ?? err}\n`);
    process.exit(1);
  });
  process.stdin.once('end', shutdown);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.once(signal, shutdown);
}
