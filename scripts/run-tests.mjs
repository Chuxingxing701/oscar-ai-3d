// Unified test entry: node:test over every package/service/system test plus
// A's scene contract tests and the asset/vendor checks.
import {spawnSync} from 'node:child_process';
import {readdirSync, statSync, existsSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function collect(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'e2e') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collect(p, out);
    else if (/\.test\.(ts|mjs)$/.test(name)) out.push(relative(root, p));
  }
  return out;
}
const filter = process.argv.slice(2);
let files = [...collect(join(root, 'packages')), ...collect(join(root, 'services')), ...collect(join(root, 'tests')),
  'web/scene/tests/scene.test.mjs'];
if (filter.length) files = files.filter(f => filter.some(x => f.includes(x)));
const steps = [
  ['node', ['scripts/vendor-three.mjs', '--check']],
  ['python3', ['source/prepare_scene_assets.py', '--check']],
  ['node', ['--test', '--test-concurrency=4', '--test-timeout=180000', ...files]],
];
for (const [cmd, args] of filter.length ? steps.slice(2) : steps) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {cwd: root, stdio: 'inherit', env: {...process.env, OSCAR_TEST: '1'}});
  if (r.status !== 0) process.exit(r.status ?? 1);
}
