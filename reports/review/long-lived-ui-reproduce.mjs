// Browser reproduction against the real panel module, with delayed API fixtures.
import {createServer} from 'node:http';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
const root = resolve(import.meta.dirname, '../..');
const server = createServer((req, res) => {
  if (req.url === '/') {res.writeHead(200, {'content-type': 'text/html'});
    res.end('<html><body><main id="review"></main></body></html>'); return;}
  if (!req.url.startsWith('/web/')) {res.writeHead(404); res.end(); return;}
  try {res.writeHead(200, {'content-type': 'text/javascript'}); res.end(readFileSync(resolve(root, '.' + req.url)));}
  catch {res.writeHead(404); res.end();}
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({headless: true});
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
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
  // The late response for A must not paint over B. Give it a tick to lose the race.
  await page.waitForTimeout(300);
  const actual = await page.evaluate(() => ({selected: document.querySelector('button.primary').textContent,
    message: document.querySelector('.chat-log').textContent, status: document.querySelector('.agent-status').textContent}));
  assert.ok(actual.selected.includes('exp-B'), `selected ${actual.selected}`);
  assert.ok(actual.message.includes('MESSAGE FROM session-B'), actual.message);
  assert.equal(actual.message.includes('MESSAGE FROM session-A'), false, actual.message);
  assert.ok(actual.status.includes('设备在线'), actual.status);
  assert.equal(actual.status.includes('设备不可达'), false, actual.status);
  console.log(JSON.stringify({name: 'late_archived_session_response_does_not_overwrite_current_session', actual}));
  writeFileSync(resolve(root, 'reports/review/long-lived-ui-after-fix.json'), JSON.stringify(actual, null, 2) + '\n');
  await page.evaluate(() => window.reviewPanel.dispose());
} finally {await browser.close(); await new Promise(r => server.close(r));}
