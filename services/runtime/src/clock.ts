// Clock loop (§5.3 + contract §6): fixed 1 s sim steps, realtime/lockstep
// pacing by `speed`. Lockstep never advances while an active lease exists and
// re-checks the lease inside every step transaction. Without a run, lockstep
// only advances via synchronous control.step (handled in runtime.control).
import type {Runtime} from './runtime.ts';

const TICK_MS = 10;
const MAX_STEPS_PER_TICK = 2000;

export class Clock {
  private timer: NodeJS.Timeout | null = null;
  private sweeper: NodeJS.Timeout | null = null;
  private lastWall = 0;
  private readonly runtime: Runtime;

  constructor(runtime: Runtime) {
    this.runtime = runtime;
  }

  start(): void {
    if (this.timer) return;
    this.lastWall = 0;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.sweeper = setInterval(() => this.runtime.sweepExpiredLeases(), 250);
    this.timer.unref?.();
    this.sweeper.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.sweeper) clearInterval(this.sweeper);
    this.timer = null;
    this.sweeper = null;
  }

  shouldAdvance(experimentId: string): boolean {
    const exp = this.runtime.loadExp(experimentId);
    if (!exp || exp.status !== 'active' || exp.paused === 1) return false;
    if (exp.clock_mode === 'lockstep') {
      if (this.runtime.activeLease(experimentId)) return false;
      const run = this.runtime.nonEndedRun(experimentId);
      if (!run) return false;
      if (run.status === 'active') return true;
      if (run.status === 'paused') return this.runtime.nonTerminalActions(experimentId).length > 0;
      return false; // on_hold
    }
    return true; // realtime
  }

  private tick(): void {
    const exp = this.runtime.currentExperiment();
    if (!exp || exp.status !== 'active') return;
    if (!this.shouldAdvance(exp.id)) {
      this.lastWall = 0;
      return;
    }
    const now = performance.now();
    if (!this.lastWall) {
      this.lastWall = now;
      return;
    }
    const elapsedS = (now - this.lastWall) / 1000;
    const due = Math.floor(elapsedS * exp.speed);
    if (due <= 0) return;
    this.lastWall += (due / exp.speed) * 1000;
    let executed = 0;
    for (let i = 0; i < Math.min(due, MAX_STEPS_PER_TICK); i++) {
      if (!this.runtime.stepOnce(exp.id)) {
        this.lastWall = 0;
        break;
      }
      executed++;
    }
    void executed;
  }
}
