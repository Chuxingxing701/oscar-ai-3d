// Child-process line waiting shared by system tests and demo scripts.
import type {ChildProcess} from 'node:child_process';

// Each child's stdout is buffered once, so a line that arrived in an earlier
// chunk (e.g. LISTENING and READY together) is still found by later waits.
const stdoutBuffers = new WeakMap<ChildProcess, {text: string; listeners: Set<() => void>}>();
export function bufferOf(child: ChildProcess): {text: string; listeners: Set<() => void>} {
  let b = stdoutBuffers.get(child);
  if (!b) {
    const created = {text: '', listeners: new Set<() => void>()};
    child.stdout!.on('data', (d: Buffer) => { created.text += d.toString(); for (const l of created.listeners) l(); });
    child.stderr!.resume();
    stdoutBuffers.set(child, created);
    b = created;
  }
  return b;
}

export function waitLine(child: ChildProcess, prefix: string, timeoutMs = 60_000): Promise<string> {
  const buffer = bufferOf(child);
  return new Promise((resolvePromise, reject) => {
    const check = (): boolean => {
      const line = buffer.text.split('\n').find(l => l.startsWith(prefix));
      if (!line) return false;
      cleanup();
      resolvePromise(line);
      return true;
    };
    const onExit = (): void => { cleanup(); reject(new Error(`process exited before ${prefix}`)); };
    const t = setTimeout(() => { cleanup(); reject(new Error(`${prefix} not seen in ${timeoutMs} ms`)); }, timeoutMs);
    const cleanup = (): void => { clearTimeout(t); buffer.listeners.delete(listener); child.removeListener('exit', onExit); };
    const listener = (): void => { check(); };
    buffer.listeners.add(listener);
    child.on('exit', onExit);
    check();
  });
}
