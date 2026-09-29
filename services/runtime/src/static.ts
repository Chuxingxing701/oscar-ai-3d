// Static whitelist (contract §8). Served from the repo root:
//   /web/**        (excluding web/node_modules, web/scene/tests, *.md, package.json)
//   /models/*.glb
//   /pair -> web/pair.html, /login -> web/login.html, / -> 302 /web/workbench.html
// Traversal-safe; the data dir and everything else 404. Anonymous access.
import {createReadStream} from 'node:fs';
import {statSync} from 'node:fs';
import {join, normalize, resolve, sep} from 'node:path';
import type {RuntimeConfig} from './config.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.ktx2': 'application/octet-stream',
  '.hdr': 'application/octet-stream',
};

export interface StaticResult {status: number; path?: string; mime?: string; stream?: NodeJS.ReadableStream}

/** Resolve a request path against the whitelist. Never throws for user input. */
export function resolveStatic(config: RuntimeConfig, rawPath: string): StaticResult {
  let pathname: string;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    return {status: 404};
  }
  if (pathname.includes('\0') || pathname.includes('\\')) return {status: 404};
  const segments = pathname.split('/').filter(s => s.length > 0);
  if (segments.includes('..') || segments.includes('.')) return {status: 404};

  if (segments.length === 0) return {status: 302, path: '/web/workbench.html'};
  if (segments.length === 1 && segments[0] === 'pair') segments.splice(0, 1, 'web', 'pair.html');
  else if (segments.length === 1 && segments[0] === 'login') segments.splice(0, 1, 'web', 'login.html');
  else if (segments[0] === 'favicon.ico') return {status: 404};

  const root = resolve(config.repoRoot);
  let rel: string;
  if (segments[0] === 'web') {
    const rest = segments.slice(1);
    if (rest.some(s => s === 'node_modules')) return {status: 404};
    if (rest.length >= 2 && rest[0] === 'scene' && rest[1] === 'tests') return {status: 404};
    const last = rest[rest.length - 1] ?? '';
    if (rest.length === 0 || last.endsWith('.md') || last === 'package.json' || last === 'package-lock.json') return {status: 404};
    rel = join('web', ...rest);
  } else if (segments[0] === 'models') {
    if (segments.length !== 2 || !segments[1].endsWith('.glb')) return {status: 404};
    rel = join('models', segments[1]);
  } else {
    return {status: 404};
  }

  const abs = normalize(resolve(root, rel));
  if (abs !== root && !abs.startsWith(root + sep)) return {status: 404}; // outside the repo (paranoia)
  // Never serve the data directory or anything runtime-private.
  const dataAbs = resolve(config.dataDir);
  if (abs === dataAbs || abs.startsWith(dataAbs + sep)) return {status: 404};
  let st;
  try {
    st = statSync(abs);
  } catch {
    return {status: 404};
  }
  if (!st.isFile()) return {status: 404};
  const ext = abs.slice(abs.lastIndexOf('.'));
  return {status: 200, path: abs, mime: MIME[ext] ?? 'application/octet-stream', stream: createReadStream(abs)};
}
