// Regression for R05 (reports/review/long-lived-reacceptance.md §2 R05):
// compaction must keep user constraints and stable facts independent of
// wording, length and count, carry them across checkpoint generations, and
// render them fully in the system prompt. op: lines are regenerated each
// generation and must not accumulate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PiAgentBackend, buildSystemPrompt} from '../src/backend.ts';
import type {TurnInput} from '../src/backend.ts';
import {makeSnapshot} from './helpers.ts';

const backend = new PiAgentBackend({});
const compact = backend.compact.bind(backend);

test('non-marker wordings survive compaction (Chinese and English)', () => {
  const zh = '储液限定为 media-01，作用范围限定为 B 排。';
  const en = 'Reservoir usage is limited to media-01; the working scope stays within row B.';
  const result = compact({history: [{role: 'user', content: zh}, {role: 'user', content: en},
    {role: 'assistant', content: 'understood'}], task: null, facts: [], evidenceRefs: []});
  assert.ok(result.facts.some(f => f === `user: ${zh}`), JSON.stringify(result.facts));
  assert.ok(result.facts.some(f => f === `user: ${en}`), JSON.stringify(result.facts));
  assert.ok(result.summary.includes(zh) && result.summary.includes(en));
  // a marker-free legacy fact from the previous checkpoint survives too
  const carried = compact({history: [], task: null, facts: [], evidenceRefs: [],
    previous: {summary: '', facts: [zh], open_questions: []}});
  assert.ok(carried.facts.some(f => f === `fact: ${zh}`));
});

test('more than 24 constraints are all kept (no count cap)', () => {
  const lines = Array.from({length: 40}, (_, i) => `任何时候第 ${i} 号限制：只准使用 media-0${i % 10}。`);
  const result = compact({history: lines.map(content => ({role: 'user' as const, content})),
    task: null, facts: [], evidenceRefs: []});
  for (const line of lines) {
    assert.ok(result.facts.includes(`constraint: ${line}`), line);
  }
  assert.equal(result.facts.length, 40);
  // and they survive one more generation
  const next = compact({history: [{role: 'user', content: '继续监测'}], task: null,
    facts: ['imaging.scan act-1 [1]'], evidenceRefs: [],
    previous: {summary: result.summary, facts: result.facts, open_questions: []}});
  for (const line of lines) {
    assert.ok(next.facts.some(f => f.includes(line)), line);
  }
});

test('a constraint longer than 300 chars is not truncated', () => {
  const head = '储液与作用范围约束：';
  const filler = 'x'.repeat(400);
  const long = head + filler;
  assert.ok(long.length > 300);
  const result = compact({history: [{role: 'user', content: long}], task: null, facts: [], evidenceRefs: []});
  const fact = result.facts.find(f => f.includes(head));
  assert.ok(fact, JSON.stringify(result.facts));
  assert.equal(fact, `user: ${long}`);
  assert.ok(result.summary.includes(filler));
  const next = compact({history: [], task: null, facts: [], evidenceRefs: [],
    previous: {summary: result.summary, facts: result.facts, open_questions: []}});
  assert.ok(next.facts.includes(`user: ${long}`));
});

test('five successive generations keep the first generation facts', () => {
  const firstConstraint = '任何时候不要使用 media-02，只准 media-01。';
  let checkpoint = compact({history: [{role: 'user', content: firstConstraint}],
    task: null, facts: ['imaging.scan act-001 [1]'], evidenceRefs: []});
  for (let generation = 2; generation <= 5; generation++) {
    checkpoint = compact({
      history: [{role: 'user', content: `第 ${generation} 段对话：继续监测。`},
        {role: 'assistant', content: `第 ${generation} 段完成`}],
      task: null,
      facts: [`imaging.scan act-00${generation} [1]`, `step 0 scan_and_assess done act-00${generation}`],
      evidenceRefs: [`act-00${generation}`],
      previous: {summary: checkpoint.summary, facts: checkpoint.facts, open_questions: checkpoint.open_questions},
      wakes: [{kind: 'sim_time', target_sim_s: 100 * generation, predicate: null}],
    });
  }
  assert.ok(checkpoint.facts.some(f => f === `constraint: ${firstConstraint}`), JSON.stringify(checkpoint.facts));
  assert.ok(checkpoint.facts.some(f => f === 'user: 第 2 段对话：继续监测。'));
  assert.ok(checkpoint.summary.includes(firstConstraint));
  // operational lines reflect only the LAST generation (regenerated, not accumulated)
  const opFacts = checkpoint.facts.filter(f => f.startsWith('op: '));
  assert.deepEqual(opFacts, ['op: imaging.scan act-005 [1]', 'op: step 0 scan_and_assess done act-005']);
  assert.ok(!checkpoint.facts.some(f => f.includes('act-001')));
});

test('op: lines are replaced by each generation instead of accumulating', () => {
  const previous = compact({history: [], task: null,
    facts: ['imaging.scan act-old [1]', 'step 0 scan_and_assess running'], evidenceRefs: []});
  assert.equal(previous.facts.filter(f => f.startsWith('op: ')).length, 2);
  const next = compact({history: [{role: 'user', content: '继续'}], task: null,
    facts: ['imaging.scan act-new [2]'], evidenceRefs: [],
    previous: {summary: previous.summary, facts: previous.facts, open_questions: []}});
  const opFacts = next.facts.filter(f => f.startsWith('op: '));
  assert.deepEqual(opFacts, ['op: imaging.scan act-new [2]']);
  assert.ok(!next.facts.some(f => f.includes('act-old')));
  assert.ok(!next.facts.some(f => f.includes('scan_and_assess')));
});

test('legacy unprefixed previous facts are carried as stable facts', () => {
  const retainedControl = 'media-02 是本实验的保留对照液。';
  const result = compact({history: [{role: 'user', content: '继续监测'}], task: null,
    facts: [], evidenceRefs: [],
    previous: {summary: retainedControl, facts: [retainedControl, 'imaging.scan act-9 [1]'],
      open_questions: ['下一步？']}});
  assert.ok(result.facts.includes(`fact: ${retainedControl}`), JSON.stringify(result.facts));
  assert.ok(result.facts.includes('fact: imaging.scan act-9 [1]'));
  assert.ok(result.summary.includes(retainedControl));
  // open questions carried forward, not truncated away
  assert.ok(result.open_questions.includes('下一步？'));
});

test('open questions carry across generations and dedupe', () => {
  let checkpoint = compact({history: [{role: 'user', content: '温度阈值定多少？'}],
    task: null, facts: [], evidenceRefs: []});
  assert.ok(checkpoint.open_questions.includes('温度阈值定多少？'));
  checkpoint = compact({history: [{role: 'user', content: '温度阈值定多少？'}], task: null, facts: [],
    evidenceRefs: [], previous: {summary: '', facts: checkpoint.facts, open_questions: checkpoint.open_questions}});
  assert.equal(checkpoint.open_questions.filter(q => q === '温度阈值定多少？').length, 1);
});

test('compaction is deterministic (pure, no provider call)', () => {
  const input = {history: [{role: 'user' as const, content: '任何时候不要使用 media-02。'},
    {role: 'assistant' as const, content: 'ok'}], task: null,
    facts: ['imaging.scan act-1 [1]'], evidenceRefs: ['act-1'],
    previous: {summary: 's', facts: ['fact: legacy'], open_questions: ['q?']}};
  assert.deepEqual(compact(input), compact(input));
});

test('buildSystemPrompt renders every carried fact and question in full', () => {
  const constraints = Array.from({length: 30}, (_, i) => `constraint: 任何时候第 ${i} 条：只准 media-0${i}。`);
  const longTail = 'y'.repeat(400);
  const facts = [...constraints, `user: 储液限定为 media-01，作用范围限定为 B 排。`,
    `fact: media-02 是本实验的保留对照液。`, `user: 长约束尾部${longTail}`, 'op: imaging.scan act-7 [1]'];
  const prompt = buildSystemPrompt({
    session: {session_id: 's', experiment_id: 'exp-001'} as TurnInput['session'],
    task: null, spec: null, wake: null, state: makeSnapshot('routine_maintenance', 1, [400, 400, 400, 400, 400, 400]),
    history: [], checkpointSummary: 'compressed summary', checkpointFacts: facts,
    checkpointQuestions: ['下一步？'], plan: [], deviceResults: [],
    budget: {actions_used: 0, max_actions: 1, model_turns_used: 0, max_model_turns: 1},
  }, 'stub');
  for (const fact of facts) {
    assert.ok(prompt.includes(fact), `missing in prompt: ${fact.slice(0, 40)}…`);
  }
  assert.ok(prompt.includes('下一步？'));
});

test('full chain: compacted facts reach buildSystemPrompt through checkpoint fields', () => {
  const constraint = '储液限定为 media-01，作用范围限定为 B 排。';
  const checkpoint = compact({history: [{role: 'user', content: constraint}], task: null,
    facts: ['step 0 scan_and_assess done act-1'], evidenceRefs: []});
  const prompt = buildSystemPrompt({
    session: {session_id: 's', experiment_id: 'exp-001'} as TurnInput['session'],
    task: null, spec: null, wake: null, state: makeSnapshot('routine_maintenance', 1, [400, 400, 400, 400, 400, 400]),
    history: [], checkpointSummary: checkpoint.summary, checkpointFacts: checkpoint.facts,
    checkpointQuestions: checkpoint.open_questions, plan: [], deviceResults: [],
    budget: {actions_used: 0, max_actions: 1, model_turns_used: 0, max_model_turns: 1},
  }, 'stub');
  assert.ok(prompt.includes(constraint));
  assert.ok(prompt.includes('op: step 0 scan_and_assess done act-1'));
});
