// CLI: generate a fresh one-time pairing link using the operator token.
//   npm run pair [-- --url http://127.0.0.1:8780 --data-dir data]
import {readFileSync, existsSync} from 'node:fs';
import {join, resolve} from 'node:path';

const args = process.argv.slice(2);
const get = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const repoRoot = resolve(import.meta.dirname, '..');
const dataDir = resolve(repoRoot, get('data-dir') ?? process.env.OSCAR_DATA_DIR ?? 'data');
const baseUrl = (get('url') ?? `http://127.0.0.1:${process.env.OSCAR_RUNTIME_PORT ?? 8780}`).replace(/\/$/, '');
const tokenPath = join(dataDir, 'runtime', 'operator.token');
if (!existsSync(tokenPath)) {
  console.error(`operator token not found at ${tokenPath} — is the Runtime running with this data dir?`);
  process.exit(1);
}
const token = readFileSync(tokenPath, 'utf8').trim();

const r = await fetch(`${baseUrl}/api/v1/pairing-codes`, {
  method: 'POST',
  headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
  body: '{}',
});
if (!r.ok) {
  console.error(`pairing-codes failed: HTTP ${r.status} ${await r.text()}`);
  process.exit(1);
}
const body = await r.json() as {code: string; url: string; expires_at: string};
console.log(body.url);
console.log(`(single use, expires ${body.expires_at})`);
