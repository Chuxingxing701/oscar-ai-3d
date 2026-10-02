// Regression for R06 (reports/review/long-lived-reacceptance.md §2 R06):
// the agent panel must never regress to an older server response — neither
// within one session (SSE + polling start overlapping refreshes; an older
// pair returning late used to overwrite the newer render) nor across
// sessions (selectionGen guard, F13). Runs the real panel module in
// Chromium like the review reproduce scripts, against fixture APIs whose
// response ordering is fully controlled.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {chromium} from '@playwright/test';

const root = resolve(import.meta.dirname, '../..');
const server = createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, {'content-type': 'text/html'});
    res.end('<html><body><main id="review"></main></body></html>'); return;
  }
  if (!req.url.startsWith('/web/')) {res.writeHead(404); res.end(); return;}
  try {res.writeHead(200, {'content-type': 'text/javascript'});
    res.end(readFileSync(resolve(root, '.' + req.url)));}
  catch {res.writeHead(404); res.end();}
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({headless: true});
after(async () => {
  await browser.close();
  await new Promise(r => server.close(r));
});

test('agent panel response ordering: same-session and cross-session', {timeout: 60_000}, async t => {
  await t.test('same session: an older refresh returning late cannot overwrite the newer render', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(baseUrl);
      await page.evaluate(async () => {
        const {mountAgent} = await import('/web/panels/agent.js');
        window.EventSource = class {
          constructor() {this.listeners = {}; window.reviewSource = this;}
          addEventListener(name, fn) {this.listeners[name] = fn;}
          close() {}
          emit(seq) {this.listeners.message({data: JSON.stringify({seq, type: 'message.appended'})});}
        };
        const session = {session_id: 'session-A', experiment_id: 'exp-A', lifecycle: 'active'};
        window.reviewVersion = 0; window.reviewDelay = false; window.reviewResolvers = [];
        const response = value => window.reviewDelay
          ? new Promise(r => window.reviewResolvers.push(() => r(value))) : Promise.resolve(value);
        window.reviewPanel = mountAgent(document.querySelector('#review'), {
          api: {
            agentSessions: async () => ({sessions: [session]}),
            agentSession: () => response({messages: Array.from({length: window.reviewVersion + 1},
              (_, i) => ({role: 'user', content: i === window.reviewVersion
                ? `VERSION_${window.reviewVersion}` : `earlier_${i}`})), checkpoint: null}),
            agentSessionStatus: () => response({session, loop: {state: 'idle', agent_paused: false},
              device: {reachable: true, sim_time_s: window.reviewVersion, clock_mode: 'realtime', in_flight_actions: 0},
              model: {configured: false}, watermarks: {last_message_seq: window.reviewVersion,
                last_event_seq: window.reviewVersion, inbox_cursor: 0}, task: null}),
            agentSessionEventsUrl: () => '/events/session-A',
          },
          getState: () => ({experimentId: 'exp-A', clock: {clock_mode: 'realtime'}}),
          isReplay: () => false, showError: () => {},
        });
      });
      await page.waitForFunction(() => document.querySelector('.chat-log').textContent.includes('VERSION_0'));

      // version 1 refresh hangs; version 2 refresh lands; THEN version 1 returns.
      await page.evaluate(() => {window.reviewVersion = 1; window.reviewDelay = true; window.reviewSource.emit(1);});
      await page.waitForFunction(() => window.reviewResolvers.length === 2);
      await page.evaluate(() => {window.reviewVersion = 2; window.reviewDelay = false; window.reviewSource.emit(2);});
      await page.waitForFunction(() => document.querySelector('.chat-log').textContent.includes('VERSION_2'));
      await page.evaluate(() => window.reviewResolvers.splice(0).forEach(fn => fn()));
      await page.waitForTimeout(100);
      const afterLateOld = await page.evaluate(() => ({message: document.querySelector('.chat-log').textContent,
        status: document.querySelector('.agent-status').textContent}));
      assert.ok(afterLateOld.message.includes('VERSION_2'), afterLateOld.message);
      assert.ok(afterLateOld.status.includes('消息 seq 2'), afterLateOld.status);
      assert.equal(afterLateOld.status.includes('消息 seq 1'), false, afterLateOld.status);

      // both refreshes hang and are released in ISSUE order: the older
      // applies first, the newer still lands afterwards — the guard must
      // order responses, not freeze the panel on the first one.
      await page.evaluate(() => {window.reviewDelay = true;});
      const start3 = await page.evaluate(() => window.reviewResolvers.length);
      await page.evaluate(() => {window.reviewVersion = 3; window.reviewSource.emit(3);});
      await page.waitForFunction(n => window.reviewResolvers.length === n + 2, start3);
      const start4 = await page.evaluate(() => window.reviewResolvers.length);
      await page.evaluate(() => {window.reviewVersion = 4; window.reviewSource.emit(4);});
      await page.waitForFunction(n => window.reviewResolvers.length === n + 2, start4);
      await page.evaluate(start => window.reviewResolvers.splice(start, 2).forEach(fn => fn()), start3);
      await page.waitForFunction(() => document.querySelector('.chat-log').textContent.includes('VERSION_3'));
      await page.evaluate(() => window.reviewResolvers.splice(0, 2).forEach(fn => fn()));
      await page.waitForFunction(() => document.querySelector('.chat-log').textContent.includes('VERSION_4'));
      const afterInOrder = await page.evaluate(() => document.querySelector('.chat-log').textContent);
      assert.equal(afterInOrder.includes('VERSION_3'), false, afterInOrder);
      await page.evaluate(() => window.reviewPanel.dispose());
    } finally {
      await page.close();
    }
  });

  await t.test('cross session: a late response for the previous session cannot overwrite the current one', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(baseUrl);
      await page.evaluate(async () => {
        const {mountAgent} = await import('/web/panels/agent.js');
        window.EventSource = class {addEventListener() {} close() {}};
        const a = {session_id: 'session-A', experiment_id: 'exp-A', lifecycle: 'archived'};
        const b = {session_id: 'session-B', experiment_id: 'exp-B', lifecycle: 'active'};
        const detail = id => ({messages: [{role: 'user', content: `MESSAGE FROM ${id}`}], checkpoint: null});
        const status = id => ({session: id === a.session_id ? a : b, loop: {state: 'idle', detail: null, agent_paused: false},
          device: id === a.session_id ? {reachable: false}
            : {reachable: true, sim_time_s: 0, clock_mode: 'realtime', in_flight_actions: 0},
          model: {configured: false}, watermarks: {last_message_seq: 1, last_event_seq: 1, inbox_cursor: 0}, task: null});
        window.reviewResolvers = [];
        const later = value => new Promise(r => window.reviewResolvers.push(() => r(value)));
        window.reviewPanel = mountAgent(document.querySelector('#review'), {
          api: {agentSessions: async () => ({sessions: [a, b]}),
            agentSession: async id => id === a.session_id ? later(detail(id)) : detail(id),
            agentSessionStatus: async id => id === a.session_id ? later(status(id)) : status(id),
            agentSessionEventsUrl: id => `/events/${id}`},
          getState: () => ({experimentId: 'exp-B', clock: {clock_mode: 'realtime'}}),
          isReplay: () => false, showError: () => {},
        });
      });
      await page.waitForFunction(() => document.querySelector('.chat-log').textContent.includes('MESSAGE FROM session-B'));
      await page.getByRole('button', {name: /exp-A/}).click();
      await page.waitForFunction(() => window.reviewResolvers.length >= 2);
      await page.getByRole('button', {name: /exp-B/}).click();
      await page.waitForFunction(() => document.querySelector('.chat-log').textContent.includes('MESSAGE FROM session-B'));
      await page.evaluate(() => window.reviewResolvers.splice(0).forEach(fn => fn()));
      await page.waitForTimeout(300);
      const actual = await page.evaluate(() => ({selected: document.querySelector('button.primary').textContent,
        message: document.querySelector('.chat-log').textContent, status: document.querySelector('.agent-status').textContent}));
      assert.ok(actual.selected.includes('exp-B'), actual.selected);
      assert.ok(actual.message.includes('MESSAGE FROM session-B'), actual.message);
      assert.equal(actual.message.includes('MESSAGE FROM session-A'), false, actual.message);
      assert.ok(actual.status.includes('设备在线'), actual.status);
      assert.equal(actual.status.includes('设备不可达'), false, actual.status);
      await page.evaluate(() => window.reviewPanel.dispose());
    } finally {
      await page.close();
    }
  });
});
