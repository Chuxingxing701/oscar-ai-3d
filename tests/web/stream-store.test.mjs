// Stream manager + store reducer tests (node:test). Fake EventSource and
// fake fetchSnapshot drive the same code paths the browser uses.
import test from 'node:test';
import assert from 'node:assert/strict';

import {createEventFeed, decideSeq, loadAllEvents} from '../../web/api/stream.js';
import {initialState, applySnapshot, applyEvent, applyClockFrame, replayAt} from '../../web/api/store.js';

// --------------------------------------------------------------------------
// decideSeq: dedupe by seq + gap detection
// --------------------------------------------------------------------------

test('decideSeq drops duplicates, applies the next seq, and flags gaps', () => {
  assert.deepEqual(decideSeq(5, {seq: 5}), {action: 'drop', reason: 'duplicate'});
  assert.deepEqual(decideSeq(5, {seq: 4}), {action: 'drop', reason: 'duplicate'});
  assert.deepEqual(decideSeq(5, {seq: 6}), {action: 'apply', reason: 'next'});
  const gap = decideSeq(5, {seq: 9});
  assert.equal(gap.action, 'resync');
  assert.equal(gap.reason, 'gap');
  assert.equal(gap.gap, 3);
  assert.deepEqual(decideSeq(5, {}), {action: 'drop', reason: 'no-seq'});
});

// --------------------------------------------------------------------------
// Store reducer
// --------------------------------------------------------------------------

function snapshotFixture({eventSeq = 3, simTime = 100, volume = 500} = {}) {
  return {
    experiment: {experiment_id: 'exp-01', scenario_id: 'demo-maintenance', sim_time_s: simTime, paused: false,
      speed: 1, clock_mode: 'lockstep', status: 'active'},
    event_seq: eventSeq,
    device: {device_id: 'oscar-01', mode: 'simulation', manifest_version: '0.1.0', health: 'ok'},
    chamber: {chamber_id: 'chamber-01', target_revision: 1,
      temperature_c: {target: 37, observed: 36.5, error: .5, quality: 'ok', sampled_at_sim_s: simTime},
      co2_pct: {target: 5, observed: 4.8, error: .2, quality: 'ok', sampled_at_sim_s: simTime},
      humidity_pct: {target: 60, observed: 59, error: 1, quality: 'ok', sampled_at_sim_s: simTime}, stable: false},
    plates: [{plate_id: 'plate-01', station_id: 's', format: '24', rows: ['A'], columns: 6, revision: 2,
      shake: {active: false, started_at_sim_s: 0, duration_sim_s: 0},
      wells: Array.from({length: 6}, (_, i) => ({well_id: `A${i + 1}`, volume_ul: volume, capacity_ul: 2000, medium_id: 'demo'}))}],
    reservoirs: [{id: 'media-01', station_id: 's', medium_id: 'demo-medium', remaining_ul: 90000, capacity_ul: 100000}],
    wastes: [{id: 'waste-01', station_id: 's', used_ul: 1000, capacity_ul: 100000}],
    tips: [{id: 'tips-01', station_id: 's', remaining: 90, capacity: 96}],
    busy_resources: {}, active_actions: [], head: null, lease: null, run: null, revisions: {plate: 2},
  };
}

test('snapshot timeline history never reapplies effects or includes events ahead of the snapshot', () => {
  const snapshot = snapshotFixture({eventSeq: 3, volume: 500});
  snapshot.timeline_events = [
    {experiment_id: 'exp-01', seq: 2, type: 'action.effect_committed', payload: {
      plate_id: 'plate-01', effect: {wells: [{well_id: 'A1', volume_ul: 900}]},
    }},
    {experiment_id: 'exp-01', seq: 4, type: 'environment.sampled', payload: {}},
    {experiment_id: 'another-experiment', seq: 1, type: 'environment.sampled', payload: {}},
  ];
  const state = applySnapshot(initialState(), snapshot);
  assert.deepEqual(state.events.map(e => e.seq), [2]);
  assert.equal(state.eventSeq, 3);
  assert.equal(state.plates[0].wells[0].volume_ul, 500);
});

test('applySnapshot is authoritative; applyEvent merges actions and effects', () => {
  let state = initialState();
  state = applySnapshot(state, snapshotFixture());
  assert.equal(state.experimentId, 'exp-01');
  assert.equal(state.eventSeq, 3);
  assert.equal(state.clock.sim_time_s, 100);

  state = applyEvent(state, {seq: 4, experiment_id: 'exp-01', sim_time_s: 101, type: 'action.accepted',
    action_id: 'act-1', payload: {capability: 'media.add', arguments: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', volume_ul_per_well: 200}, status: 'queued'}});
  assert.equal(state.actions.get('act-1').status, 'queued');

  state = applyEvent(state, {seq: 5, experiment_id: 'exp-01', sim_time_s: 102, type: 'action.started', action_id: 'act-1', payload: {}});
  assert.equal(state.actions.get('act-1').status, 'running');

  state = applyEvent(state, {seq: 6, experiment_id: 'exp-01', sim_time_s: 103, type: 'action.stage_changed', action_id: 'act-1',
    payload: {stage: 'dispensing', primitive: 'pipette.dispense', target: {plate_id: 'plate-01', row_id: 'A'},
      stage_started_at_sim_s: 103, stage_duration_sim_s: 3, step_index: 6}});
  assert.equal(state.head.stage.stage, 'dispensing');

  state = applyEvent(state, {seq: 7, experiment_id: 'exp-01', sim_time_s: 106, type: 'action.effect_committed', action_id: 'act-1',
    payload: {effect: {step_index: 6, stage: 'dispensing', committed_at_sim_s: 106,
      wells: [{well_id: 'A1', delta_ul: 200}], reservoir: {id: 'media-01', delta_ul: -1200}, tips: {id: 'tips-01', delta: -6}},
      plate_id: 'plate-01', wells: [{well_id: 'A1', volume_ul: 700}, {well_id: 'A2', volume_ul: 700}]}});
  const plate = state.plates[0];
  assert.equal(plate.wells.find(w => w.well_id === 'A1').volume_ul, 700, 'post-commit volume wins');
  assert.equal(plate.wells.find(w => w.well_id === 'A2').volume_ul, 700);
  assert.equal(plate.wells.find(w => w.well_id === 'A3').volume_ul, 500, 'untouched wells unchanged');
  assert.equal(state.reservoirs[0].remaining_ul, 88800);
  assert.equal(state.tips[0].remaining, 84);

  state = applyEvent(state, {seq: 8, experiment_id: 'exp-01', sim_time_s: 110, type: 'action.succeeded', action_id: 'act-1',
    payload: {summary: {wells: {A1: {removed_ul: 0, added_ul: 200}}, reservoir_delta_ul: -1200, waste_delta_ul: 0, tips_used: 6}}});
  assert.equal(state.actions.get('act-1').status, 'succeeded');
  assert.equal(state.head, null);
  assert.equal(state.eventSeq, 8);
  assert.ok(state.clock.sim_time_s >= 110);
});

test('delta-only effect payloads still update volumes', () => {
  let state = applySnapshot(initialState(), snapshotFixture());
  state = applyEvent(state, {seq: 4, experiment_id: 'exp-01', sim_time_s: 101, type: 'action.effect_committed', action_id: 'act-1',
    payload: {plate_id: 'plate-01', effect: {step_index: 3, stage: 'aspirating', committed_at_sim_s: 101,
      wells: [{well_id: 'A2', delta_ul: -120}], waste: {id: 'waste-01', delta_ul: 120}}}});
  assert.equal(state.plates[0].wells.find(w => w.well_id === 'A2').volume_ul, 380);
  assert.equal(state.wastes[0].used_ul, 1120, 'positive waste delta increases used volume');
});

test('shake, environment, run, lease and clock events update state', () => {
  let state = applySnapshot(initialState(), snapshotFixture());
  state = applyEvent(state, {seq: 4, experiment_id: 'exp-01', sim_time_s: 100, type: 'plate.shake_started',
    payload: {plate_id: 'plate-01', speed_rpm: 300, duration_sim_s: 60, started_at_sim_s: 100, action_id: 'act-s'}});
  assert.equal(state.plates[0].shake.active, true);
  assert.equal(state.plates[0].shake.speed_rpm, 300);

  state = applyEvent(state, {seq: 5, experiment_id: 'exp-01', sim_time_s: 160, type: 'plate.shake_stopped',
    payload: {plate_id: 'plate-01', ended_at_sim_s: 160}});
  assert.equal(state.plates[0].shake.active, false);

  state = applyEvent(state, {seq: 6, experiment_id: 'exp-01', sim_time_s: 160, type: 'environment.targets_set',
    payload: {chamber_targets: {temperature_c: 36}}});
  assert.equal(state.chamber.temperature_c.target, 36);

  state = applyEvent(state, {seq: 7, experiment_id: 'exp-01', sim_time_s: 161, type: 'environment.sampled',
    payload: {temperature_c: {target: 36, observed: 36.2, error: .2, quality: 'ok', sampled_at_sim_s: 161},
      co2_pct: {observed: 4.9}, humidity_pct: {observed: 58}}});
  assert.equal(state.chamber.temperature_c.observed, 36.2);
  assert.equal(state.envSamples.length, 1);

  state = applyEvent(state, {seq: 8, experiment_id: 'exp-01', sim_time_s: 161, type: 'run.created', run_id: 'run-1',
    payload: {run: {run_id: 'run-1', experiment_id: 'exp-01', mode: 'scripted', status: 'active', budget: {max_actions: 10, actions_used: 0}}}});
  assert.equal(state.run.status, 'active');

  state = applyEvent(state, {seq: 9, experiment_id: 'exp-01', sim_time_s: 162, type: 'decision.granted',
    payload: {lease: {lease_id: 1, run_id: 'run-1', state: 'active', triggers: [{kind: 'run_started'}]}}});
  assert.equal(state.lease.state, 'active');

  state = applyEvent(state, {seq: 10, experiment_id: 'exp-01', sim_time_s: 163, type: 'run.on_hold', run_id: 'run-1', payload: {}});
  assert.equal(state.run.status, 'on_hold');

  state = applyEvent(state, {seq: 11, experiment_id: 'exp-01', sim_time_s: 164, type: 'clock.paused', payload: {}});
  assert.equal(state.clock.paused, true);

  state = applyClockFrame(state, {experiment_id: 'exp-01', sim_time_s: 170, paused: false, speed: 600, clock_mode: 'realtime'});
  assert.equal(state.clock.sim_time_s, 170);
  assert.equal(state.clock.speed, 600);
  assert.equal(state.eventSeq, 11, 'clock frames are not persisted');
});

test('runtime payload shapes: scope-only accepted, record wells, sample/targets env, lease-lite granted', () => {
  let state = applySnapshot(initialState(), snapshotFixture());
  state = applyEvent(state, {seq: 4, experiment_id: 'exp-01', sim_time_s: 100, type: 'action.accepted', action_id: 'act-9',
    payload: {action_id: 'act-9', capability: 'media.add', principal: 'operator',
      scope: {plate_id: 'plate-01', row_id: 'A', wells: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'], label: 'plate-01 A1–A6'},
      resources: ['head', 'plate:plate-01', 'tips'], idempotency_key: null}});
  const action = state.actions.get('act-9');
  assert.equal(action.capability, 'media.add');
  assert.equal(action.arguments.plate_id, 'plate-01', 'arguments synthesized from the accepted scope');
  assert.equal(action.arguments.row_id, 'A');

  state = applyEvent(state, {seq: 5, experiment_id: 'exp-01', sim_time_s: 103, type: 'action.effect_committed', action_id: 'act-9',
    payload: {action_id: 'act-9', effect: {step_index: 6, stage: 'dispensing', committed_at_sim_s: 103,
      wells: [{well_id: 'A1', delta_ul: 200}, {well_id: 'A2', delta_ul: 200}],
      reservoir: {id: 'media-01', delta_ul: -1200}}, wells: {A1: 700, A2: 700}}});
  assert.equal(state.plates[0].wells.find(w => w.well_id === 'A1').volume_ul, 700, 'record-form wells parsed');
  assert.equal(state.plates[0].wells.find(w => w.well_id === 'A3').volume_ul, 500);

  state = applyEvent(state, {seq: 6, experiment_id: 'exp-01', sim_time_s: 105, type: 'environment.sampled',
    payload: {chamber_id: 'chamber-01', sample: {temperature_c: 36.6, co2_pct: 4.9, humidity_pct: 58.5, quality: 'ok', sampled_at_sim_s: 105},
      targets: {temperature_c: 37, co2_pct: 5, humidity_pct: 60}, quality: 'ok'}});
  assert.equal(state.chamber.temperature_c.observed, 36.6);
  assert.equal(state.chamber.co2_pct.target, 5, 'targets read from the targets field');
  assert.equal(state.envSamples.at(-1).channels.humidity_pct.observed, 58.5);

  state = applyEvent(state, {seq: 7, experiment_id: 'exp-01', sim_time_s: 106, type: 'decision.granted',
    payload: {lease_id: 3, run_id: 'run-2', triggers: [{kind: 'run_started'}]}});
  assert.equal(state.lease.lease_id, 3);
  assert.equal(state.lease.state, 'active');
  assert.deepEqual(state.lease.triggers, [{kind: 'run_started'}]);

  // Replay with the same runtime shapes resolves the plate via the accepted scope.
  const final = snapshotFixture({eventSeq: 7, simTime: 106, volume: 500});
  final.plates[0].wells.find(w => w.well_id === 'A1').volume_ul = 700;
  final.plates[0].wells.find(w => w.well_id === 'A2').volume_ul = 700;
  final.reservoirs[0].remaining_ul = 88800;
  const events = [
    {seq: 4, experiment_id: 'exp-01', sim_time_s: 100, type: 'action.accepted', action_id: 'act-9',
      payload: {capability: 'media.add', scope: {plate_id: 'plate-01', row_id: 'A', wells: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6']}}},
    {seq: 5, experiment_id: 'exp-01', sim_time_s: 103, type: 'action.effect_committed', action_id: 'act-9',
      payload: {effect: {step_index: 6, stage: 'dispensing', committed_at_sim_s: 103,
        wells: [{well_id: 'A1', delta_ul: 200}, {well_id: 'A2', delta_ul: 200}], reservoir: {id: 'media-01', delta_ul: -1200}},
        wells: {A1: 700, A2: 700}}},
    {seq: 6, experiment_id: 'exp-01', sim_time_s: 104, type: 'action.succeeded', action_id: 'act-9', payload: {summary: {wells: {}}}},
  ];
  const before = replayAt(final, events, 4);
  assert.equal(before.plates[0].wells.find(w => w.well_id === 'A1').volume_ul, 500, 'initial volume via scope plate attribution');
  const after = replayAt(final, events, 5);
  assert.equal(after.plates[0].wells.find(w => w.well_id === 'A1').volume_ul, 700);
  assert.equal(after.reservoirs[0].remaining_ul, 88800);
  assert.equal(after.head, null, 'terminal at seq 6 clears the head');
});

// --------------------------------------------------------------------------
// Event feed (snapshot → subscribe → dedupe → gap resync → archived)
// --------------------------------------------------------------------------

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  emit(type, data) { for (const fn of this.listeners.get(type) || []) fn({data: JSON.stringify(data)}); }
  open() { for (const fn of this.listeners.get('open') || []) fn({}); this.onopen?.(); }
  error() { for (const fn of this.listeners.get('error') || []) fn({}); this.onerror?.(); }
  close() { this.closed = true; }
}
FakeEventSource.instances = [];

function feedHarness() {
  FakeEventSource.instances = [];
  const snapshots = [];
  const states = [];
  const statuses = [];
  const archived = [];
  let snapshotCount = 0;
  const harness = {
    snapshots,
    pushSnapshot(snapshot) { snapshots.push(snapshot); },
    eventsUrl: null,
    feed: null,
    states, statuses, archived,
  };
  const feed = createEventFeed({
    reconnectDelayMs: 1,
    fetchSnapshot: async () => {
      snapshotCount += 1;
      const snapshot = snapshots.shift() || snapshotFixture({eventSeq: 5});
      return snapshot;
    },
    subscribe: afterSeq => {
      const source = new FakeEventSource(`/api/v1/experiments/exp-01/events?after_seq=${afterSeq}`);
      harness.eventsUrl = source.url;
      harness.source = source;
      return source;
    },
    onState: (state, meta) => states.push({state, meta}),
    onStatus: status => statuses.push(status),
    onArchived: info => archived.push(info),
  });
  harness.feed = feed;
  return harness;
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('feed applies snapshot then subscribes from event_seq, dedupes by seq', async () => {
  const h = feedHarness();
  h.pushSnapshot(snapshotFixture({eventSeq: 5}));
  h.feed.start();
  await tick();
  assert.equal(h.feed.status, 'connected');
  assert.match(h.eventsUrl, /after_seq=5$/);
  assert.equal(h.states.at(-1).state.eventSeq, 5);

  h.source.emit('device', {seq: 6, type: 'clock.resumed', payload: {}});
  h.source.emit('device', {seq: 6, type: 'clock.resumed', payload: {}}); // duplicate
  h.source.emit('device', {seq: 5, type: 'clock.resumed', payload: {}}); // stale replay
  assert.equal(h.feed.state.eventSeq, 6);

  h.source.emit('clock', {experiment_id: 'exp-01', sim_time_s: 130, paused: false, speed: 1, clock_mode: 'lockstep'});
  assert.equal(h.feed.state.clock.sim_time_s, 130);
  assert.equal(h.feed.state.eventSeq, 6, 'clock frame does not bump seq');
});

test('gap detection triggers a fresh snapshot and resubscription', async () => {
  const h = feedHarness();
  h.pushSnapshot(snapshotFixture({eventSeq: 5}));
  h.feed.start();
  await tick();
  const firstSource = h.source;

  h.pushSnapshot(snapshotFixture({eventSeq: 9, simTime: 200}));
  h.source.emit('device', {seq: 9, type: 'clock.stepped', payload: {sim_time_s: 200}}); // gap 6..8 missing
  await tick();
  assert.equal(h.feed.status, 'connected');
  assert.equal(h.feed.state.eventSeq, 9);
  assert.notEqual(h.source, firstSource, 'resubscribed from the fresh snapshot');
  assert.match(h.eventsUrl, /after_seq=9$/);
  assert.ok(firstSource.closed);

  // Active stage resumes from the fresh snapshot.
  const head = {action_id: 'act-9', stage: {index: 2, stage: 'aspirating', target: {resource_id: 'media-01'}, duration_sim_s: 3, started_at_sim_s: 198}};
  h.pushSnapshot({...snapshotFixture({eventSeq: 12, simTime: 201}), head, active_actions: [{action_id: 'act-9', capability: 'media.add', status: 'running', arguments: {plate_id: 'plate-01', row_id: 'A'}}]});
  h.source.error(); // connection lost → reconnect rebuilds from snapshot
  await tick();
  assert.equal(h.feed.state.head?.stage.stage, 'aspirating');
  assert.match(h.eventsUrl, /after_seq=12$/);
});

test('archived event notifies successor and closes the stream', async () => {
  const h = feedHarness();
  h.pushSnapshot(snapshotFixture({eventSeq: 5}));
  h.feed.start();
  await tick();
  h.source.emit('archived', {experiment_id: 'exp-01', successor_id: 'exp-02'});
  assert.deepEqual(h.archived, [{experiment_id: 'exp-01', successor_id: 'exp-02'}]);
  assert.equal(h.feed.status, 'offline');
  assert.ok(h.source.closed);
});

test('loadAllEvents pages through the JSON endpoint and sorts by seq', async () => {
  const calls = [];
  const events = after => Array.from({length: 3}, (_, k) => ({seq: after + k + 1, type: 'tick', payload: {}}));
  const fetchPage = async after => {
    calls.push(after);
    if (after < 3) return {events: events(after), next_after_seq: after + 3};
    return {events: events(after)}; // last short page
  };
  const all = await loadAllEvents(fetchPage);
  assert.deepEqual(all.map(e => e.seq), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(calls, [0, 3]);
});

// --------------------------------------------------------------------------
// Replay reconstruction
// --------------------------------------------------------------------------

function replayEvents() {
  return [
    {seq: 1, experiment_id: 'exp-old', sim_time_s: 0, type: 'experiment.created', payload: {scenario_id: 'demo'}},
    {seq: 2, experiment_id: 'exp-old', sim_time_s: 10, type: 'action.accepted', action_id: 'act-1',
      payload: {capability: 'media.add', arguments: {plate_id: 'plate-01', row_id: 'A', reservoir_id: 'media-01', volume_ul_per_well: 200}}},
    {seq: 3, experiment_id: 'exp-old', sim_time_s: 12, type: 'action.started', action_id: 'act-1', payload: {}},
    {seq: 4, experiment_id: 'exp-old', sim_time_s: 13, type: 'action.stage_changed', action_id: 'act-1',
      payload: {stage: 'moving', primitive: 'motion.move_to_station', target: {resource_id: 'tips-01'}, step_index: 0, stage_started_at_sim_s: 13, stage_duration_sim_s: 3}},
    {seq: 5, experiment_id: 'exp-old', sim_time_s: 20, type: 'action.stage_changed', action_id: 'act-1',
      payload: {stage: 'dispensing', primitive: 'pipette.dispense', target: {plate_id: 'plate-01', row_id: 'A'}, step_index: 6, stage_started_at_sim_s: 20, stage_duration_sim_s: 3}},
    {seq: 6, experiment_id: 'exp-old', sim_time_s: 23, type: 'action.effect_committed', action_id: 'act-1',
      payload: {plate_id: 'plate-01', effect: {step_index: 6, stage: 'dispensing', committed_at_sim_s: 23,
        wells: [{well_id: 'A1', delta_ul: 200}, {well_id: 'A2', delta_ul: 200}],
        reservoir: {id: 'media-01', delta_ul: -1200}, tips: {id: 'tips-01', delta: -6}},
        wells: [{well_id: 'A1', volume_ul: 700}, {well_id: 'A2', volume_ul: 700}]}},
    {seq: 7, experiment_id: 'exp-old', sim_time_s: 26, type: 'action.succeeded', action_id: 'act-1', payload: {partial: false}},
    {seq: 8, experiment_id: 'exp-old', sim_time_s: 30, type: 'plate.shake_started',
      payload: {plate_id: 'plate-01', speed_rpm: 300, duration_sim_s: 60, started_at_sim_s: 30, action_id: 'act-2'}},
    {seq: 9, experiment_id: 'exp-old', sim_time_s: 90, type: 'plate.shake_stopped', payload: {plate_id: 'plate-01'}},
    {seq: 10, experiment_id: 'exp-old', sim_time_s: 95, type: 'clock.paused', payload: {}},
  ];
}

test('replayAt reconstructs volumes, stage, shake and time at each seq', () => {
  const final = snapshotFixture({eventSeq: 10, simTime: 95, volume: 500});
  // Final snapshot: A1/A2 touched by the effect (700), other wells untouched at 500;
  // reservoir spent 1200, tips consumed 6.
  final.plates[0].wells.find(w => w.well_id === 'A1').volume_ul = 700;
  final.plates[0].wells.find(w => w.well_id === 'A2').volume_ul = 700;
  final.reservoirs[0].remaining_ul = 88800;
  final.tips[0].remaining = 84;
  const events = replayEvents();

  const before = replayAt(final, events, 5);
  assert.equal(before.head?.stage.stage, 'dispensing', 'stage from action.stage_changed while running');
  const wellsBefore = before.plates[0].wells;
  assert.equal(wellsBefore.find(w => w.well_id === 'A1').volume_ul, 500, 'pre-effect volume');
  assert.equal(before.reservoirs[0].remaining_ul, 90000);
  assert.equal(before.tips[0].remaining, 90);
  assert.equal(before.experiment.sim_time_s, 20);

  const after = replayAt(final, events, 6);
  assert.equal(after.plates[0].wells.find(w => w.well_id === 'A1').volume_ul, 700, 'post-commit volume from event');
  assert.equal(after.plates[0].wells.find(w => w.well_id === 'A6').volume_ul, 500, 'untouched well keeps initial volume');
  assert.equal(after.reservoirs[0].remaining_ul, 88800);
  assert.equal(after.tips[0].remaining, 84);

  const terminal = replayAt(final, events, 7);
  assert.equal(terminal.head, null, 'head cleared after terminal event');

  const shaking = replayAt(final, events, 8.5); // between shake_started (8) and shake_stopped (9)
  assert.equal(shaking.plates[0].shake.active, true);
  assert.equal(shaking.plates[0].shake.speed_rpm, 300);

  const stopped = replayAt(final, events, 9);
  assert.equal(stopped.plates[0].shake.active, false);
  assert.equal(stopped.experiment.paused, false, 'clock.paused only applies from its own seq');
  const paused = replayAt(final, events, 10);
  assert.equal(paused.experiment.paused, true);
  assert.equal(after.plates[0].wells.find(w => w.well_id === 'A2').volume_ul, 700);
});

test('a fresh snapshot never keeps a stale non-terminal action copy', () => {
  let state = initialState();
  state = applySnapshot(state, {...snapshotFixture(), active_actions: [{action_id: 'act-1', capability: 'imaging.scan', status: 'queued'}]});
  assert.equal(state.actions.get('act-1').status, 'queued');
  // The action finished while no stream was attached: the new snapshot lists no actives.
  const later = applySnapshot(state, {...snapshotFixture({eventSeq: 9}), active_actions: []});
  assert.equal(later.actions.has('act-1'), false, 'non-terminal copy dropped');
  const withList = applySnapshot(state, {...snapshotFixture({eventSeq: 9}), active_actions: [],
    all_actions: [{action_id: 'act-1', capability: 'imaging.scan', status: 'succeeded'}]});
  assert.equal(withList.actions.get('act-1').status, 'succeeded', 'authoritative list wins');
});

test('overlapping resyncs: only the newest snapshot applies and subscribes', async () => {
  FakeEventSource.instances = [];
  const pending = [];
  let source = null;
  const feed = createEventFeed({
    reconnectDelayMs: 1,
    fetchSnapshot: () => new Promise(resolve => pending.push(resolve)),
    subscribe: afterSeq => (source = new FakeEventSource(`/events?after_seq=${afterSeq}`)),
    onState: () => {}, onStatus: () => {}, onArchived: () => {},
  });
  feed.start();              // resync #1 (in flight)
  const second = feed.refresh(); // resync #2 (in flight)
  pending[1](snapshotFixture({eventSeq: 20}));
  await second;
  pending[0](snapshotFixture({eventSeq: 7})); // older response lands last
  await tick();
  assert.equal(feed.state.eventSeq, 20);
  assert.match(source.url, /after_seq=20$/);
});

test('shake audit effects preserve motion parameters and do not double count revision', () => {
  let s = applySnapshot(initialState('exp-01'), snapshotFixture());
  const ev = (seq, type, payload) => ({experiment_id:'exp-01', seq, sim_time_s:100, action_id:'shake-1', type, payload});
  s = applyEvent(s, ev(4, 'action.accepted', {action_id:'shake-1', capability:'plate.shake', arguments:{plate_id:'plate-01'}, scope:{plate_id:'plate-01'}}));
  s = applyEvent(s, ev(5, 'plate.shake_started', {plate_id:'plate-01', action_id:'shake-1', speed_rpm:300, duration_sim_s:60, revision:3}));
  s = applyEvent(s, ev(6, 'action.effect_committed', {effect:{shake:'started', stage:'shaking', step_index:0}}));
  assert.equal(s.plates[0].shake.duration_sim_s,60);
  assert.equal(s.plates[0].shake.speed_rpm,300);
  assert.equal(s.plates[0].revision,3);
  s = applyEvent(s, ev(7, 'plate.shake_stopped', {plate_id:'plate-01', ended_at_sim_s:160, revision:4}));
  s = applyEvent(s, ev(8, 'action.effect_committed', {effect:{shake:'stopped', stage:'shaking', step_index:0}}));
  assert.equal(s.plates[0].shake.active,false);
  assert.equal(s.plates[0].revision,4);
});
