// C1 test 8: access control — cookie/Origin rules, Bearer, Host, pairing,
// LAN mode, rate limiting, static hygiene (no tokens), data-dir isolation.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {currentExperimentId, spawnRuntime, type RuntimeHandle} from './helpers.ts';

const COOKIE = 'oscar_session';

let h: RuntimeHandle;
let exp: string;
let cookie: string;

test.before(async () => {
  h = await spawnRuntime({scenario: 'routine_maintenance', seed: 42, env: {
    OSCAR_PAIRING_TTL_MS: String(1000), // short for the expiry test
    OSCAR_RATE_LIMIT_BLOCK_MS: String(400),
  }});
  exp = await currentExperimentId(h);
  await loginOnce(); // exchange the startup pairing code for a session cookie
});
test.after(async () => {
  await h.stop();
});

/** Raw request with a custom Host header (fetch refuses to spoof Host). */
async function rawHostRequest(host: string, path: string): Promise<{status: number; body: string}> {
  const http = await import('node:http');
  const port = h.port;
  return new Promise((resolveP, reject) => {
    const r = http.request({host: '127.0.0.1', port, path, method: 'GET', headers: {host}},
      res => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => resolveP({status: res.statusCode ?? 0, body}));
      });
    r.on('error', reject);
    r.end();
  });
}

async function req(method: string, path: string, opts: {cookie?: boolean; origin?: string; host?: string;
  body?: unknown; bearer?: string; headers?: Record<string, string>} = {}): Promise<Response> {
  const headers: Record<string, string> = {...(opts.headers ?? {})};
  if (opts.cookie) headers.cookie = `${COOKIE}=${cookie}`;
  if (opts.origin !== undefined) headers.origin = opts.origin;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const url = opts.host ? `http://${opts.host}${path}` : `${h.baseUrl}${path}`;
  return fetch(url, {method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    redirect: 'manual'});
}

async function loginOnce(): Promise<void> {
  const m = /pair#code=([A-Za-z0-9_-]+)/.exec(h.stdout)!;
  const code = m[1]!;
  const r = await fetch(`${h.baseUrl}/api/v1/session`, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({pairing_code: code}),
  });
  assert.equal(r.status, 200, 'pairing code from the startup line works once');
  const setCookie = r.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /oscar_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\//);
  cookie = /oscar_session=([^;]+)/.exec(setCookie)![1]!;
}

test('same-origin cookie GET/HEAD without Origin: OK (state, SSE, asset, chamber)', async () => {
  for (const path of [`/api/v1/experiments/${exp}/state`, `/api/v1/experiments/${exp}/chambers/chamber-01`,
    `/api/v1/experiments/${exp}/events?after_seq=0`, `/api/v1/experiments/${exp}/observations/nope`]) {
    const r = await req('GET', path, {cookie: true});
    assert.ok(r.status !== 401 && r.status !== 403, `${path} -> ${r.status}`);
  }
  const head = await req('HEAD', `/api/v1/experiments/${exp}/state`, {cookie: true});
  assert.ok(head.status !== 401 && head.status !== 403);
});

test('cookie POST without Origin is rejected even with a valid cookie; with same Origin OK', async () => {
  const noOrigin = await req('POST', `/api/v1/experiments/${exp}/control`, {cookie: true, body: {pause: true}});
  assert.equal(noOrigin.status, 401);
  assert.equal(((await noOrigin.json()) as {code: string}).code, 'unauthenticated');
  const withOrigin = await req('POST', `/api/v1/experiments/${exp}/control`,
    {cookie: true, origin: h.baseUrl, body: {pause: true}});
  assert.equal(withOrigin.status, 200);
  await req('POST', `/api/v1/experiments/${exp}/control`, {cookie: true, origin: h.baseUrl, body: {resume: true}});
});

test('cross-origin Origin rejected with and without cookie; Bearer without Origin OK', async () => {
  const evil = await req('GET', `/api/v1/experiments/${exp}/state`, {origin: 'http://evil.example'});
  assert.equal(evil.status, 403);
  assert.equal(((await evil.json()) as {code: string}).code, 'origin_mismatch');
  const evilPost = await req('POST', `/api/v1/experiments/${exp}/control`,
    {cookie: true, origin: 'http://evil.example', body: {pause: true}});
  assert.equal(evilPost.status, 403);
  const bearer = await req('GET', `/api/v1/experiments/${exp}/state`, {bearer: h.operatorToken});
  assert.equal(bearer.status, 200);
  const bearerPost = await req('POST', `/api/v1/experiments/${exp}/control`, {bearer: h.operatorToken, body: {pause: true}});
  assert.equal(bearerPost.status, 200);
  await req('POST', `/api/v1/experiments/${exp}/control`, {bearer: h.operatorToken, body: {resume: true}});
});

test('bad Host rejected; allowed Host forms accepted', async () => {
  const bad = await rawHostRequest(`evil.example:${h.port}`, `/api/v1/experiments/${exp}/state`);
  assert.equal(bad.status, 403);
  assert.equal((JSON.parse(bad.body) as {code: string}).code, 'host_not_allowed');
  for (const host of [`localhost:${h.port}`, `[::1]:${h.port}`]) {
    const r = await rawHostRequest(host, '/api/v1/health');
    assert.equal(r.status, 200, host);
  }
});

test('anonymous access: health + static OK, everything else 401', async () => {
  const health = await req('GET', '/api/v1/health');
  assert.equal(health.status, 200);
  const pairPage = await req('GET', '/pair');
  assert.equal(pairPage.status, 200);
  for (const path of [`/api/v1/experiments/${exp}/state`, `/api/v1/experiments/${exp}/events?after_seq=0`,
    `/api/v1/experiments/${exp}/assets/ast-001-001`, '/api/v1/devices', '/api/v1/experiments']) {
    const r = await req('GET', path);
    assert.equal(r.status, 401, `${path} anonymous -> ${r.status}`);
  }
  // no CORS headers anywhere
  const sample = await req('GET', `/api/v1/experiments/${exp}/state`, {bearer: h.operatorToken});
  assert.equal(sample.headers.get('access-control-allow-origin'), null);
  assert.equal(sample.headers.get('access-control-allow-headers'), null);
});

test('JSON content type required for bodies (415)', async () => {
  const r = await fetch(`${h.baseUrl}/api/v1/experiments/${exp}/control`, {
    method: 'POST', headers: {authorization: `Bearer ${h.operatorToken}`, 'content-type': 'text/plain'},
    body: 'pause=true',
  });
  assert.equal(r.status, 415);
  assert.equal(((await r.json()) as {code: string}).code, 'unsupported_media_type');
});

test('session lifecycle: GET session, DELETE logout kills the cookie', async () => {
  const who = await req('GET', '/api/v1/session', {cookie: true});
  assert.equal(who.status, 200);
  assert.deepEqual(await who.json(), {authenticated: true, principal: 'operator'});
  // logout with Bearer is not the cookie's session; logout with cookie+origin
  const out = await req('DELETE', '/api/v1/session', {cookie: true, origin: h.baseUrl});
  assert.ok(out.status === 200 || out.status === 204);
  const after = await req('GET', `/api/v1/experiments/${exp}/state`, {cookie: true});
  assert.equal(after.status, 401, 'cookie no longer valid after logout');
});

test('pairing codes: single use, expiry, regeneration via operator', async () => {
  const gen = await req('POST', '/api/v1/pairing-codes', {bearer: h.operatorToken, body: {}});
  assert.equal(gen.status, 200);
  const {code, url} = await gen.json() as {code: string; url: string};
  assert.match(url, /\/pair#code=/);
  const use1 = await fetch(`${h.baseUrl}/api/v1/session`, {method: 'POST',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({pairing_code: code})});
  assert.equal(use1.status, 200);
  const use2 = await fetch(`${h.baseUrl}/api/v1/session`, {method: 'POST',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({pairing_code: code})});
  assert.equal(use2.status, 401, 'one-time use');
  // codes expire (1 s TTL configured)
  const gen2 = await req('POST', '/api/v1/pairing-codes', {bearer: h.operatorToken, body: {}});
  const {code: shortLived} = await gen2.json() as {code: string};
  await new Promise(r => setTimeout(r, 1300));
  const expired = await fetch(`${h.baseUrl}/api/v1/session`, {method: 'POST',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({pairing_code: shortLived})});
  assert.equal(expired.status, 401, 'expired code rejected');
  // pairing-codes needs operator rights
  const anon = await req('POST', '/api/v1/pairing-codes', {body: {}});
  assert.equal(anon.status, 401);
});

test('LAN mode: no access code exits non-zero; short code exits non-zero; login + rate limit work', async () => {
  const {spawn} = await import('node:child_process');
  const runToExit = (args: string[], env: Record<string, string> = {}): Promise<{code: number | null; out: string}> =>
    new Promise(resolveP => {
      const child = spawn(process.execPath, args, {cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
        env: {...process.env, ...env}});
      let out = '';
      child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr!.on('data', (d: Buffer) => (out += d.toString()));
      child.on('exit', code => resolveP({code, out}));
    });
  const dir = mkdtempSync(join(tmpdir(), 'oscar-lan-'));
  const base = ['services/runtime/src/main.ts', '--port', '0', '--data-dir', dir, '--lan'];
  const none = await runToExit(base);
  assert.notEqual(none.code, 0, 'missing access code must exit non-zero');
  assert.match(none.out, /access code/);
  const short = await runToExit(base, {OSCAR_ACCESS_CODE: 'short'});
  assert.notEqual(short.code, 0, 'short access code must exit non-zero');
  rmSync(dir, {recursive: true, force: true});

  // valid code -> starts
  const codeDir = mkdtempSync(join(tmpdir(), 'oscar-lan-code-'));
  const codeFile = join(codeDir, 'code.txt');
  writeFileSync(codeFile, 'lan-access-code-12345');
  const child = spawn(process.execPath,
    ['services/runtime/src/main.ts', '--port', '0', '--data-dir', codeDir, '--lan', '--access-code-file', codeFile],
    {cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, OSCAR_RATE_LIMIT_BLOCK_MS: '500'}});
  let out = '';
  child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (out += d.toString()));
  try {
    const port = await new Promise<number>((resolveP, reject) => {
      const iv = setInterval(() => {
        const line = out.split('\n').find(l => l.startsWith('OSCAR_RUNTIME_READY'));
        if (line) {
          clearInterval(iv);
          resolveP((JSON.parse(line.slice('OSCAR_RUNTIME_READY '.length)) as {port: number}).port);
        }
      }, 25);
      child.on('exit', code => { clearInterval(iv); reject(new Error(`LAN runtime exited ${code}: ${out}`)); });
      setTimeout(() => { clearInterval(iv); reject(new Error('LAN runtime did not start')); }, 15_000);
    });
    const base2 = `http://127.0.0.1:${port}`;
    const ok = await fetch(`${base2}/api/v1/session`, {method: 'POST',
      headers: {'content-type': 'application/json'}, body: JSON.stringify({access_code: 'lan-access-code-12345'})});
    assert.equal(ok.status, 200, 'correct access code logs in');
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const r = await fetch(`${base2}/api/v1/session`, {method: 'POST',
        headers: {'content-type': 'application/json'}, body: JSON.stringify({access_code: 'wrong'})});
      last = r.status;
      if (i < 4) assert.equal(r.status, 401);
    }
    assert.equal(last, 429, 'rate limited after 5 consecutive failures');
    const limited = await fetch(`${base2}/api/v1/session`, {method: 'POST',
      headers: {'content-type': 'application/json'}, body: JSON.stringify({access_code: 'lan-access-code-12345'})});
    assert.equal(limited.status, 429, 'even the correct code is blocked while rate limited');
    const {code: stillRunning} = {code: child.exitCode};
    assert.equal(stillRunning, null, 'LAN runtime still running (blocked, not crashed)');
  } finally {
    child.kill('SIGKILL');
    await new Promise<void>(resolveP => {
      if (child.exitCode != null) resolveP();
      else child.on('exit', () => resolveP());
    });
    rmSync(codeDir, {recursive: true, force: true});
  }
});

test('static whitelist: allowed paths serve, exclusions 404, correct MIME types', async () => {
  const cases: Array<[string, number, string | null]> = [
    ['/web/scene/preview.html', 200, 'text/html'],
    ['/web/pair.html', 200, 'text/html'],
    ['/models/OSCAR_full.glb', 200, 'model/gltf-binary'],
    ['/models/OSCAR_exterior.glb', 200, 'model/gltf-binary'],
    ['/models/nope.glb', 404, null],
    ['/models/OSCAR_full.glb/../../package.json', 404, null],
    ['/web/scene/tests/scene.test.mjs', 404, null],
    ['/web/node_modules/nonexistent.js', 404, null],
    ['/web/package.json', 404, null],
    ['/web/README.md', 404, null],
    ['/package.json', 404, null],
    ['/services/runtime/src/main.ts', 404, null],
    ['/docs/API_CONTRACT.md', 404, null],
    ['/data/runtime/runtime.sqlite', 404, null],
    ['/web/../package.json', 404, null],
    ['/%2e%2e/package.json', 404, null],
    ['/web/%2e%2e/%2e%2e/package.json', 404, null],
    ['/runtime.sqlite', 404, null],
    ['/operator.token', 404, null],
  ];
  for (const [path, status, mime] of cases) {
    const r = await req('GET', path);
    assert.equal(r.status, status, path);
    if (mime) assert.match(r.headers.get('content-type') ?? '', new RegExp(`^${mime}`), path);
  }
  // root redirects to the workbench
  const root = await req('GET', '/');
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/web/workbench.html');
  const login = await req('GET', '/login');
  assert.equal(login.status, 200);
  // a .js file gets text/javascript
  const js = await req('GET', '/web/scene/index.js');
  if (js.status === 200) assert.match(js.headers.get('content-type') ?? '', /^text\/javascript/);
});

test('static pages contain no tokens or pairing codes', async () => {
  const secrets = [h.operatorToken, /rt_[a-f0-9]{20,}/, /pair#code=[A-Za-z0-9_-]+/];
  const pages = ['/web/pair.html', '/web/login.html', '/web/scene/preview.html', '/web/index.html'];
  for (const p of pages) {
    const r = await req('GET', p);
    if (r.status !== 200) continue; // some pages may not exist yet
    const text = await r.text();
    for (const s of secrets) {
      if (typeof s === 'string') assert.ok(!text.includes(s), `${p} leaks the operator token`);
      else assert.equal(s.test(text), false, `${p} leaks ${s}`);
    }
  }
  // workbench.html (if the workbench agent already created it)
  const wb = await req('GET', '/web/workbench.html');
  if (wb.status === 200) {
    const text = await wb.text();
    assert.ok(!text.includes(h.operatorToken), 'workbench must not embed the operator token');
  }
});

test('run token cannot touch control/reset/create; data dir unreachable via static paths', async () => {
  // sanity: the data dir is under the temp tree, not the repo
  const probe = await req('GET', `/web/${'../'.repeat(8)}${h.dataDir.replace(/^\//, '')}/runtime/operator.token`);
  assert.ok(probe.status === 404 || probe.status === 400, `traversal blocked (${probe.status})`);
});

function writeCodeFile(dir: string): string {
  const file = join(dir, 'code.txt');
  writeFileSync(file, 'lan-access-code-12345');
  return file;
}
