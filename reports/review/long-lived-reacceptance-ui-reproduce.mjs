// Same-session response ordering, using the real browser panel module.
// Exit 0 = latest revision remains visible after an older request returns.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync, writeFileSync} from 'node:fs';
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
const browser = await chromium.launch({headless: true});
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
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
  await page.evaluate(() => {window.reviewVersion = 1; window.reviewDelay = true; window.reviewSource.emit(1);});
  await page.waitForFunction(() => window.reviewResolvers.length === 2);
  await page.evaluate(() => {window.reviewVersion = 2; window.reviewDelay = false; window.reviewSource.emit(2);});
  await page.waitForFunction(() => document.querySelector('.chat-log').textContent.includes('VERSION_2'));
  await page.evaluate(() => window.reviewResolvers.splice(0).forEach(fn => fn()));
  await page.waitForTimeout(100);
  const actual = await page.evaluate(() => ({message: document.querySelector('.chat-log').textContent,
    status: document.querySelector('.agent-status').textContent}));
  const result = {name: 'same_session_older_response_cannot_overwrite_newer',
    pass: actual.message.includes('VERSION_2'), actual, expected: {visible_version: 2}};
  writeFileSync(resolve(root, 'reports/review/long-lived-reacceptance-ui-reproductions.json'),
    JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
  await page.evaluate(() => window.reviewPanel.dispose());
  assert.equal(result.pass, true, 'older same-session response replaced the latest data');
} finally {await browser.close(); await new Promise(r => server.close(r));}
