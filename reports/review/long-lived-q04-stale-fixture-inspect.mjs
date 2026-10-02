// Run the unchanged OLD-observation test while retaining only citation/brief
// diagnostics from the model stub. No product/test assertions are modified.
import {after} from 'node:test';
import {writeFileSync} from 'node:fs';
import {parseBriefs} from '../../services/culture-agent/test/model-stub.ts';

after(() => {
  const dumps = globalThis.__stubDumps ?? [];
  const calls = new Map(), briefs = new Map();
  for (const request of dumps) {
    for (const message of request.messages ?? []) {
      for (const call of message.tool_calls ?? []) {
        if (call.function?.name !== 'record_step_result') continue;
        const args = JSON.parse(call.function.arguments);
        calls.set(call.id, {id: call.id, args});
      }
    }
    for (const brief of parseBriefs(request.messages ?? [])) {
      const key = JSON.stringify([brief.simTime, brief.scans, brief.observation?.observation_id]);
      briefs.set(key, {sim_time_s: brief.simTime, scans: brief.scans,
        observation_id: brief.observation?.observation_id ?? null,
        observation_action_id: brief.observation?.action_id ?? null});
    }
  }
  writeFileSync(new URL('./long-lived-q04-stale-fixture-citations.json', import.meta.url),
    JSON.stringify({model_requests: dumps.length, record_step_calls: [...calls.values()],
      briefs: [...briefs.values()]}, null, 2) + '\n');
});
await import('../../services/culture-agent/test/skills-e2e.test.ts');
