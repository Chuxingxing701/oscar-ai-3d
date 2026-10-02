// Bootstrap the existing preview without changing B's workspace or lockfile.
// npm --prefix web install --ignore-scripts --no-package-lock
// node source/prepare_scene.mjs
import {readFile, mkdir, copyFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = resolve(root, 'web/node_modules/three');
const version = JSON.parse(await readFile(resolve(pkg, 'package.json'))).version;
if (version !== '0.180.0') throw new Error(`Expected Three.js 0.180.0, got ${version}`);
const out = resolve(root, 'web/vendor');
await mkdir(out, {recursive: true});
for (const name of ['three.module.js', 'three.core.js']) {
  await copyFile(resolve(pkg, 'build', name), resolve(out, name));
}
await copyFile(resolve(pkg, 'LICENSE'), resolve(out, 'THREE-LICENSE.txt'));
const seen = new Set();
async function addon(name) {
  if (seen.has(name)) return;
  seen.add(name);
  const src = resolve(pkg, 'examples/jsm', name);
  const dst = resolve(out, 'addons', name);
  await mkdir(dirname(dst), {recursive: true});
  await copyFile(src, dst);
  const code = await readFile(src, 'utf8');
  for (const match of code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    if (match[1].startsWith('.')) {
      await addon(resolve(dirname(src), match[1]).slice(resolve(pkg, 'examples/jsm').length + 1));
    }
  }
}
for (const name of ['controls/OrbitControls.js', 'loaders/GLTFLoader.js',
  'environments/RoomEnvironment.js', 'utils/BufferGeometryUtils.js']) await addon(name);
console.log(`Vendored Three.js ${version}, ${seen.size} addons (MIT).`);
