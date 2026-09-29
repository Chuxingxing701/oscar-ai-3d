// Copy the locked three@0.180.0 (root package-lock) into web/vendor, or verify
// with --check that web/vendor is byte-identical to the locked package.
import {readFile, mkdir, copyFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const check = process.argv.includes('--check');
const pkg = resolve(root, 'node_modules/three');
const version = JSON.parse(await readFile(resolve(pkg, 'package.json'), 'utf8')).version;
if (version !== '0.180.0') throw new Error(`Expected three 0.180.0, got ${version}`);
const out = resolve(root, 'web/vendor');
const pairs = [];
for (const name of ['three.module.js', 'three.core.js']) pairs.push([resolve(pkg, 'build', name), resolve(out, name)]);
pairs.push([resolve(pkg, 'LICENSE'), resolve(out, 'THREE-LICENSE.txt')]);
const seen = new Set();
async function addon(name) {
  if (seen.has(name)) return;
  seen.add(name);
  const src = resolve(pkg, 'examples/jsm', name);
  pairs.push([src, resolve(out, 'addons', name)]);
  const code = await readFile(src, 'utf8');
  for (const m of code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    if (m[1].startsWith('.')) await addon(resolve(dirname(src), m[1]).slice(resolve(pkg, 'examples/jsm').length + 1));
  }
}
for (const name of ['controls/OrbitControls.js', 'loaders/GLTFLoader.js', 'environments/RoomEnvironment.js',
  'utils/BufferGeometryUtils.js']) await addon(name);
const sha = async p => createHash('sha256').update(await readFile(p)).digest('hex');
let mismatches = 0;
for (const [src, dst] of pairs) {
  if (check) {
    let ok = false;
    try { ok = (await sha(src)) === (await sha(dst)); } catch { ok = false; }
    if (!ok) { mismatches++; console.error(`vendor mismatch: ${dst}`); }
  } else {
    await mkdir(dirname(dst), {recursive: true});
    await copyFile(src, dst);
  }
}
if (mismatches) process.exit(1);
console.log(`${check ? 'Verified' : 'Vendored'} three ${version}: ${pairs.length} files (MIT).`);
