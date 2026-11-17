import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KEY_CACHE = resolve(ROOT, '.swarm', 'extension-public-key.json');

/**
 * Computes Chrome's 32-char a-p extension ID from a base64-encoded SPKI DER public key.
 */
export function computeExtensionId(base64Spki) {
  const der = Buffer.from(base64Spki, 'base64');
  const digest = createHash('sha256').update(der).digest();
  let id = '';
  for (let i = 0; i < 16; i += 1) {
    const byte = digest[i];
    id += String.fromCharCode(97 + (byte >> 4));
    id += String.fromCharCode(97 + (byte & 0x0f));
  }
  return id;
}

export function ensureExtensionPublicKey(cachePath = KEY_CACHE) {
  if (existsSync(cachePath)) {
    const existing = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (existing?.key) {
      return { key: existing.key, extensionId: computeExtensionId(existing.key) };
    }
  }
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' }
  });
  const key = Buffer.from(publicKey).toString('base64');
  const extensionId = computeExtensionId(key);
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify({ key, extensionId }, null, 2), 'utf8');
  return { key, extensionId };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = ensureExtensionPublicKey();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
