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
// Process-heavy acceptance suites (real Runtime + Agent + HTTP model stub
// children with accelerated sim clocks) run SERIALLY in a second phase so
// they never starve each other's wall-time budgets.
const serial = files.filter(f => /long-session|session-faults|supervisor-contract/.test(f));
files = files.filter(f => !serial.includes(f));

const steps = [];
if (!filter.length) {
  steps.push(['node', ['scripts/vendor-three.mjs', '--check']]);
  steps.push(['python3', ['source/prepare_scene_assets.py', '--check']]);
}
steps.push(['node', ['--test', '--test-concurrency=4', '--test-timeout=180000', ...files]]);
steps.push(['node', ['--test', '--test-concurrency=1', '--test-timeout=300000', ...serial]]);

for (const [cmd, args] of steps) {
  const isTestRun = args.includes('--test');
  if (isTestRun && args.length === 4) continue; // phase emptied by filters
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {cwd: root, stdio: 'inherit', env: {...process.env, OSCAR_TEST: '1'}});
  if (r.status !== 0) process.exit(r.status ?? 1);
}
