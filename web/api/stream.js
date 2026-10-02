// SSE manager: snapshot-then-subscribe with seq dedupe, gap detection,
// clock frames and archived handling (docs/API_CONTRACT.md §9).
//
// Protocol: GET state (has event_seq) → EventSource(`/events?after_seq=N`).
// EventSource sends the session cookie same-origin and Last-Event-ID on
// automatic reconnect, but we do NOT trust silent reconnects for state
// consistency: every reconnect rebuilds from a fresh snapshot so active
// stages resume correctly. `decideSeq` is the pure decision core (unit
// tested); the class wires it to a real or injected EventSource.

import {applySnapshot, applyClockFrame, applyEvent, decideSeq} from './store.js';

export {decideSeq};

const RESYNC_DELAY_MS = 600;
const MAX_RESYNC_DELAY_MS = 8000;

/**
 * @param {object} options
 * @param {function():Promise<object>} options.fetchSnapshot  fresh StateSnapshot
 * @param {function(number): EventSourceLike} options.subscribe(afterSeq) → source
 * @param {function(state, meta): void} options.onState  called after snapshot/event application
 * @param {function(status: 'connected'|'reconnecting'|'offline', detail?): void} options.onStatus
 * @param {function(event): void} [options.onArchived]  successor notification
 */
export function createEventFeed({
  fetchSnapshot, subscribe, onState = () => {}, onStatus = () => {}, onArchived = () => {},
  EventSourceCtor = null, eventsUrl = null, reconnectDelayMs = RESYNC_DELAY_MS,
} = {}) {
  let state = null;
  let source = null;
  let stopped = true;
  let lastSeq = 0;
  let resyncTimer = 0;
  let resyncAttempts = 0;
  let status = 'offline';
  let currentExperimentId = null;

  const setStatus = next => { if (status !== next) { status = next; onStatus(status); } };
  const emit = meta => onState(state, meta || {});

  function closeSource() {
    if (source) { try { source.close(); } catch { /* already closed */ } source = null; }
  }

  let generation = 0;
  async function resync(reason) {
    if (stopped) return;
    // Overlapping resyncs (manual refresh + gap/error) must not let an older
    // snapshot land last: only the newest generation applies and subscribes.
    const mine = ++generation;
    clearTimeout(resyncTimer); resyncTimer = 0;
    setStatus('reconnecting');
    closeSource();
    try {
      const snapshot = await fetchSnapshot();
      if (stopped || mine !== generation) return;
      state = applySnapshot(state || {actions: new Map(), observations: new Map(), envSamples: [], envTargets: [], events: [], clock: {sim_time_s: 0, paused: false, speed: 1, clock_mode: 'lockstep'}}, snapshot);
      currentExperimentId = state.experimentId;
      lastSeq = snapshot.event_seq ?? lastSeq;
      resyncAttempts = 0;
      setStatus('connected');
      emit({kind: 'snapshot', reason});
      openStream();
    } catch (error) {
      if (stopped || mine !== generation) return;
      const delay = Math.min(reconnectDelayMs * 2 ** resyncAttempts, MAX_RESYNC_DELAY_MS);
      resyncAttempts += 1;
      resyncTimer = setTimeout(() => { resyncTimer = 0; resync('retry'); }, delay);
    }
  }

  function scheduleReconnect(reason) {
    if (stopped || resyncTimer) return;
    resyncTimer = setTimeout(() => { resyncTimer = 0; resync(reason); }, reconnectDelayMs);
  }

  function openStream() {
    if (stopped) return;
    closeSource();
    const url = typeof eventsUrl === 'function' ? eventsUrl(lastSeq) : null;
    source = subscribe ? subscribe(lastSeq) : (EventSourceCtor && url ? new EventSourceCtor(url) : null);
    if (!source) return;
    source.onopen = () => { setStatus('connected'); };
    source.onerror = () => {
      // EventSource retries by itself, but state correctness needs a fresh
      // snapshot (active stages resume from it), so we rebuild the stream.
      if (stopped) return;
      setStatus('reconnecting');
      scheduleReconnect('error');
    };
    source.addEventListener('device', event => {
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      const decision = decideSeq(lastSeq, frame);
      if (decision.action === 'drop') return;
      if (decision.action === 'resync') { resync(`gap:${decision.gap ?? '?'}`); return; }
      lastSeq = frame.seq;
      state = applyEvent(state, frame);
      emit({kind: 'event', event: frame});
    });
    source.addEventListener('clock', event => {
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      state = applyClockFrame(state, frame);
      emit({kind: 'clock'});
    });
    source.addEventListener('archived', event => {
      let info = {};
      try { info = JSON.parse(event.data); } catch { /* successor unknown */ }
      onArchived(info);
      closeSource();
      setStatus('offline');
    });
  }

  return {
    get status() { return status; },
    get state() { return state; },
    start() {
      stopped = false;
      resync('start');
    },
    stop() {
      stopped = true;
      clearTimeout(resyncTimer); resyncTimer = 0;
      closeSource();
      setStatus('offline');
    },
    /** Force a full snapshot + resubscribe (e.g. after a control action). */
    async refresh() { if (!stopped) await resync('manual'); },
  };
}

/**
 * Load every persisted event of an experiment via the JSON paging endpoint
 * (used by read-only replay; tolerant to {events:[...]} or bare array, and to
 * a `next_after_seq`/`next` cursor when the Runtime pages).
 */
export async function loadAllEvents(fetchPage, {maxPages = 50} = {}) {
  const out = [];
  let after = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const body = await fetchPage(after);
    const events = Array.isArray(body) ? body : (body?.events || body?.items || []);
    if (!Array.isArray(events) || events.length === 0) break;
    for (const ev of events) if (typeof ev?.seq === 'number' && ev.seq > after) out.push(ev);
    const last = events[events.length - 1].seq;
    const cursor = body?.next_after_seq ?? body?.next ?? null;
    if (events.length < 2 || last === after) break;
    if (cursor == null && events.length < 1000) break;
    after = typeof cursor === 'number' ? cursor : last;
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}
