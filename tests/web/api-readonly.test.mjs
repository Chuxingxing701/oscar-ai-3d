// Read-only replay guard: write attempts must throw BEFORE any fetch, and
// normal client behaviour (credentials, JSON, error shape) must hold.
import test from 'node:test';
import assert from 'node:assert/strict';

import {createApi, ApiError} from '../../web/api/http.js';

function recordingFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({url, init});
    return handler(url, init, calls.length);
  };
  fn.calls = calls;
  return fn;
}

const okJson = body => ({ok: true, status: 200, headers: new Map([['content-type', 'application/json']]), json: async () => body});

test('read-only mode blocks writes before fetch and still allows reads', async () => {
  const fetchImpl = recordingFetch(() => okJson({ok: true}));
  const api = createApi({fetchImpl});
  api.setReadOnly(true);

  await assert.doesNotReject(() => api.state('exp-01'), undefined, 'GET state still works in replay');
  await api.observations('exp-01');
  await assert.rejects(
    () => api.submitAction('exp-01', 'media.add', {plate_id: 'plate-01', row_id: 'A'}),
    err => err instanceof ApiError && err.code === 'read_only',
    'write throws read_only');
  await assert.rejects(
    () => api.cancelAction('exp-01', 'act-1'),
    err => err.code === 'read_only');
  await assert.rejects(
    () => api.control('exp-01', {pause: true}),
    err => err.code === 'read_only');
  await assert.rejects(
    () => api.startAgentRun({mode: 'scripted'}),
    err => err.code === 'read_only');

  assert.equal(fetchImpl.calls.length, 2, 'only the two GETs hit the network');
  assert.ok(fetchImpl.calls.every(c => c.init.method === 'GET'));

  api.setReadOnly(false);
  await api.submitAction('exp-01', 'media.add', {plate_id: 'plate-01', row_id: 'A'}, {idempotencyKey: 'k1'});
  assert.equal(fetchImpl.calls.length, 3, 'write goes through after leaving replay');
  const write = fetchImpl.calls[2];
  assert.equal(write.init.method, 'POST');
  assert.equal(write.init.credentials, 'same-origin');
  assert.equal(write.init.headers['Content-Type'], 'application/json');
  assert.equal(write.init.headers['Idempotency-Key'], 'k1');
  assert.deepEqual(JSON.parse(write.init.body), {capability: 'media.add', arguments: {plate_id: 'plate-01', row_id: 'A'}});
});

test('error responses become {code,message,retryable} objects', async () => {
  const fetchImpl = recordingFetch((url, init, n) => n === 1
    ? {ok: false, status: 409, headers: new Map([['content-type', 'application/json']]), json: async () => ({error: {code: 'resource_busy', message: '头被占用', retryable: true}})}
    : {ok: false, status: 503, statusText: 'Unavailable', headers: new Map(), json: async () => { throw new Error('no body'); }});
  const api = createApi({fetchImpl});
  await assert.rejects(
    () => api.submitAction('exp-01', 'plate.shake', {}),
    err => err instanceof ApiError && err.code === 'resource_busy' && err.message === '头被占用' && err.retryable === true && err.status === 409);
  await assert.rejects(
    () => api.submitAction('exp-01', 'plate.shake', {}),
    err => err.code === 'http_503' && err.retryable === true);
});

test('401 fires the unauthorized handler once and maps to unauthenticated', async () => {
  const fetchImpl = recordingFetch(() => ({ok: false, status: 401, headers: new Map(), json: async () => ({})}));
  let redirects = 0;
  const api = createApi({fetchImpl, onUnauthorized: () => { redirects += 1; }});
  await assert.rejects(() => api.session(), err => err.code === 'unauthenticated' && err.retryable === false);
  await assert.rejects(() => api.state('exp-01'), err => err.code === 'unauthenticated');
  assert.equal(redirects, 1, 'handler fired exactly once');
});

test('network failure is a retryable network_error', async () => {
  const fetchImpl = recordingFetch(async () => { throw new TypeError('fetch failed'); });
  const api = createApi({fetchImpl});
  await assert.rejects(
    () => api.state('exp-01'),
    err => err instanceof ApiError && err.code === 'network_error' && err.retryable === true);
});
