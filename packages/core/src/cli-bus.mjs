import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSwarmBus } from './swarm-bus.mjs';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' && argv[i + 1] !== undefined) opts.port = Number(argv[++i]);
    else if (arg === '--registry' && argv[i + 1] !== undefined) opts.registryPath = argv[++i];
    else if (arg === '--extension-id' && argv[i + 1] !== undefined) opts.extensionId = argv[++i];
    else if (arg === '--host' && argv[i + 1] !== undefined) opts.host = argv[++i];
  }
  return opts;
}

/**
 * Starts the standalone local swarm bus and exits cleanly on termination signals.
 */
export async function runCliBus(argv = process.argv.slice(2)) {
  const envExt = process.env.SWARM_EXTENSION_ID?.trim();
  const parsed = parseArgs(argv);
  const bus = await startSwarmBus({
    ...parsed,
    ...(parsed.extensionId || envExt ? { extensionId: parsed.extensionId || envExt } : {})
  });

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      url: bus.url,
      port: bus.port,
      host: bus.host,
      extensionId: bus.extensionId,
      registryPath: bus.registryPath
    })}\n`
  );
  // Human-facing hint on stderr so stdout stays machine-readable JSON.
  process.stderr.write(
    `Swarm QA bus listo en ${bus.url}\nLa extensión se conecta sola. (Modo estricto: SWARM_REQUIRE_PAIR_CODE=1, código ${bus.pairingCode})\n`
  );

  const shutdown = async () => {
    try {
      await bus.close();
    } finally {
      process.exit(0);
    }
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    process.once(sig, shutdown);
  }
  return bus;
}

const entry = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : '';
if (entry === fileURLToPath(import.meta.url).toLowerCase()) {
  runCliBus().catch((err) => {
    process.stderr.write(`${err?.message ?? err}\n`);
    process.exit(1);
  });
}
