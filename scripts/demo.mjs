import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = resolve(fileURLToPath(new URL('../packages/demo/public', import.meta.url)));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json'
};

/** Serves the demo playground on loopback only. Resolves with `{ url, port, close }`. */
export function startDemoServer({ port = Number(process.env.SWARM_DEMO_PORT) || 5173, host = '127.0.0.1' } = {}) {
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
    const file = resolve(join(PUBLIC_DIR, normalize(pathname === '/' ? '/index.html' : pathname)));
    const inside = file === PUBLIC_DIR || file.startsWith(PUBLIC_DIR + sep);
    if (!inside || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"Not found"}');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject).listen(port, host, () => {
      const bound = server.address().port;
      resolvePromise({ port: bound, url: `http://${host}:${bound}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const portArg = process.argv.indexOf('--port');
  const demo = await startDemoServer(portArg !== -1 ? { port: Number(process.argv[portArg + 1]) } : {});
  process.stdout.write(`Swarm QA demo → ${demo.url}  (añade ?tour=1 para iniciar el tour)\n`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => demo.close().then(() => process.exit(0)));
}
