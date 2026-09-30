// Smooth only between server-confirmed times. Never predict another effect,
// stage, liquid volume or future simulation tick. Replay/seek stays exact.
export class PresentationClock {
  constructor() {
    this.experiment = null; this.from = this.to = this.at = this.duration = 0;
    this.stages = [];
  }
  sample(now) {
    const fraction = this.duration ? Math.max(0, Math.min(1, (now - this.at) / this.duration)) : 1;
    return this.from + (this.to - this.from) * fraction;
  }
  update(state, now, {interpolate = false, speed = 1} = {}) {
    const time = state.sim_time_s;
    const stage = state.actions[0];
    const last = this.stages.at(-1);
    const changedAction = last?.action_id !== stage?.action_id;
    // If intermediate stages were missed (fast-forward/reconnect), snap to
    // known state rather than inventing a trajectory through the gap.
    const gap = last && stage && stage.stage_started_at_sim_s >
      last.stage_started_at_sim_s + last.stage_duration_sim_s;
    const immediate = !interpolate || state.paused || this.experiment !== state.experiment_id ||
      time < this.to || changedAction || gap || (last && !stage);
    if (immediate) this.stages = stage ? [stage] : [];
    else if (stage) {
      if (last?.stage_started_at_sim_s === stage.stage_started_at_sim_s && last?.stage === stage.stage) {
        this.stages[this.stages.length - 1] = stage;
      } else this.stages.push(stage);
      this.stages = this.stages.slice(-64);
    }
    if (!immediate && time === this.to) return;
    const from = immediate ? time : Math.min(time, this.sample(now));
    this.experiment = state.experiment_id;
    this.from = from; this.to = time; this.at = now;
    const stepMs = 1000 / Math.max(.01, speed);
    this.duration = immediate ? 0 : Math.min(1, time - from) * stepMs;
  }
  frame(snapshot, now) {
    const time = this.sample(now);
    const stage = this.stages.findLast(stage => stage.stage_started_at_sim_s <= time) ?? this.stages[0];
    return {...snapshot, sim_time_s: time, actions: snapshot.actions.length && stage ? [stage] : snapshot.actions};
  }
}
