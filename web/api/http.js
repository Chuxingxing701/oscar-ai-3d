// HTTP wrapper for the OSCAR Runtime API (/api/v1), same-origin only.
//
// Authentication model (docs/API_CONTRACT.md §2): the browser holds the
// HttpOnly `oscar_session` cookie. fetch() with credentials 'same-origin'
// attaches it automatically; POST/PUT/DELETE from the browser always carry a
// same-origin Origin header so cookie-authenticated writes are accepted.
// No token is ever read or stored by JavaScript (no localStorage, no headers
// we set ourselves).
//
// `readOnly` mode (replay of archived experiments): every mutating call throws
// BEFORE any fetch is issued. The guard lives here so panels cannot bypass it.

export class ApiError extends Error {
  constructor(info, status = 0) {
    super(info?.message || `HTTP ${status}`);
    this.name = 'ApiError';
    this.code = info?.code || 'http_error';
    this.message = info?.message || `HTTP ${status}`;
    this.retryable = Boolean(info?.retryable ?? status >= 500);
    this.status = status;
    this.details = info?.details ?? null;
  }
  toJSON() { return {code: this.code, message: this.message, retryable: this.retryable, status: this.status}; }
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Create an API client bound to one experiment (or null before selection). */
export function createApi({fetchImpl = null, onUnauthorized = null, origin = ''} = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  let readOnly = false;
  let unauthHandler = onUnauthorized;

  async function request(method, path, {body, headers, signal} = {}) {
    if (readOnly && WRITE_METHODS.has(method)) {
      throw new ApiError({code: 'read_only', message: '只读回放模式：不会发出任何写请求', retryable: false}, 0);
    }
    const init = {method, credentials: 'same-origin', signal, headers: {}};
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    Object.assign(init.headers, headers || {});
    let response;
    try {
      response = await doFetch(origin + path, init);
    } catch (cause) {
      // Network layer failure (server down, DNS, …): retryable by caller.
      throw new ApiError({code: 'network_error', message: `网络错误：${cause?.message || cause}`, retryable: true}, 0);
    }
    if (response.status === 401) {
      const err = new ApiError({code: 'unauthenticated', message: '未认证或会话已过期', retryable: false}, 401);
      if (unauthHandler) {
        try { unauthHandler(err); } catch { /* handler must not break the caller */ }
        unauthHandler = null; // one redirect per client lifetime
      }
      throw err;
    }
    if (!response.ok) {
      let info = null;
      try { info = await response.json(); } catch { /* non-JSON error body */ }
      const payload = info && (info.error || info);
      throw new ApiError({
        code: payload?.code || `http_${response.status}`,
        message: payload?.message || response.statusText || `HTTP ${response.status}`,
        retryable: Boolean(payload?.retryable ?? response.status >= 500),
        details: payload?.details ?? null,
      }, response.status);
    }
    if (response.status === 204) return null;
    const type = response.headers?.get?.('content-type') || '';
    if (type.includes('application/json')) return response.json();
    return response; // PNG bytes etc. — caller reads as needed
  }

  return {
    request,
    get readOnlyMode() { return readOnly; },
    /** Enter/leave read-only replay mode; throws-since-fetch guard above. */
    setReadOnly(value) { readOnly = Boolean(value); },
    onUnauthorized(handler) { unauthHandler = handler; },

    // ---- session ----
    session() { return request('GET', '/api/v1/session'); },
    // ---- experiments ----
    experiments() { return request('GET', '/api/v1/experiments'); },
    state(experimentId) { return request('GET', `/api/v1/experiments/${experimentId}/state`); },
    chamber(experimentId, chamberId = 'chamber-01') {
      return request('GET', `/api/v1/experiments/${experimentId}/chambers/${chamberId}`);
    },
    eventsPage(experimentId, {afterSeq = 0, limit = 2000} = {}) {
      return request('GET', `/api/v1/experiments/${experimentId}/events?format=json&after_seq=${afterSeq}&limit=${limit}`);
    },
    // ---- actions ----
    submitAction(experimentId, capability, args, {idempotencyKey, evidenceRefs, reason, expectedRevisions} = {}) {
      const body = {capability, arguments: args};
      if (evidenceRefs?.length) body.evidence_refs = evidenceRefs;
      if (reason) body.reason = reason;
      if (expectedRevisions) body.expected_revisions = expectedRevisions;
      const headers = {};
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
      return request('POST', `/api/v1/experiments/${experimentId}/actions`, {body, headers});
    },
    cancelAction(experimentId, actionId) {
      return request('POST', `/api/v1/experiments/${experimentId}/actions/${encodeURIComponent(actionId)}/cancel`, {body: {}});
    },
    action(experimentId, actionId) {
      return request('GET', `/api/v1/experiments/${experimentId}/actions/${encodeURIComponent(actionId)}`);
    },
    actions(experimentId) { return request('GET', `/api/v1/experiments/${experimentId}/actions`); },
    // ---- observations ----
    observations(experimentId) { return request('GET', `/api/v1/experiments/${experimentId}/observations`); },
    observation(experimentId, observationId) {
      return request('GET', `/api/v1/experiments/${experimentId}/observations/${encodeURIComponent(observationId)}`);
    },
    assetUrl(experimentId, assetId) {
      return `${origin}/api/v1/experiments/${experimentId}/assets/${encodeURIComponent(assetId)}`;
    },
    // ---- control ----
    control(experimentId, body) {
      return request('POST', `/api/v1/experiments/${experimentId}/control`, {body});
    },
    // ---- agent gateway (same origin, operator session cookie) ----
    startAgentRun(body) { return request('POST', '/api/v1/agent/runs', {body}); },
    agentRunControl(runId, action) { return request('POST', `/api/v1/agent/runs/${encodeURIComponent(runId)}/control`, {body: {action}}); },
    agentRun(runId) { return request('GET', `/api/v1/agent/runs/${encodeURIComponent(runId)}`); },
    agentEventsUrl(runId) { return `${origin}/api/v1/agent/runs/${encodeURIComponent(runId)}/events`; },
    // ---- long-lived culture sessions (same gateway, operator session) ----
    agentSessions() { return request('GET', '/api/v1/agent/sessions'); },
    agentCreateSession(body) { return request('POST', '/api/v1/agent/sessions', {body}); },
    agentSession(sessionId) { return request('GET', `/api/v1/agent/sessions/${encodeURIComponent(sessionId)}`); },
    agentSessionStatus(sessionId) {
      return request('GET', `/api/v1/agent/sessions/${encodeURIComponent(sessionId)}/status`);
    },
    agentSessionMessage(sessionId, content, requestId) {
      return request('POST', `/api/v1/agent/sessions/${encodeURIComponent(sessionId)}/messages`,
        {body: {content, request_id: requestId}});
    },
    agentSessionTask(sessionId, body) {
      return request('POST', `/api/v1/agent/sessions/${encodeURIComponent(sessionId)}/tasks`, {body});
    },
    agentTask(taskId) { return request('GET', `/api/v1/agent/tasks/${encodeURIComponent(taskId)}`); },
    agentTaskControl(taskId, action) {
      return request('POST', `/api/v1/agent/tasks/${encodeURIComponent(taskId)}/control`, {body: {action}});
    },
    agentSessionControl(sessionId, action) {
      return request('POST', `/api/v1/agent/sessions/${encodeURIComponent(sessionId)}/control`, {body: {action}});
    },
    agentSessionEventsUrl(sessionId, afterSeq = 0) {
      return `${origin}/api/v1/agent/sessions/${encodeURIComponent(sessionId)}/events?after_seq=${afterSeq}`;
    },
    agentSessionEvents(sessionId, afterSeq, limit = 1000) {
      return request('GET', `/api/v1/agent/sessions/${encodeURIComponent(sessionId)}/events`
        + `?after_seq=${afterSeq}&limit=${limit}&format=json`);
    },
  };
}
