// Model adapters (design §7.3): the control loop talks to a ModelAdapter, not
// to the policy directly. ScriptedAdapter is the deterministic demo policy;
// LlmAdapter is the placeholder that reports UNAVAILABLE unless OSCAR_LLM_*
// credentials/config exist — mode 'llm' then pauses the run with reason
// model_unavailable. It never silently falls back to the scripted policy.
import {scriptedDecide} from './policy.ts';
import type {PolicyContext, PolicyDecision} from './types.ts';

export interface ModelAdapter {
  id: string;
  available(): Promise<boolean>;
  decide(ctx: PolicyContext): Promise<PolicyDecision>;
}

export class ScriptedAdapter implements ModelAdapter {
  readonly id = 'scripted';
  private readonly policy: (ctx: PolicyContext) => PolicyDecision;
  constructor(policy: (ctx: PolicyContext) => PolicyDecision = scriptedDecide) {
    this.policy = policy;
  }
  async available(): Promise<boolean> { return true; }
  async decide(ctx: PolicyContext): Promise<PolicyDecision> { return this.policy(ctx); }
}

/** Required LLM env config: provider + key + model (all three, non-empty). */
export function hasLlmConfig(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.OSCAR_LLM_PROVIDER && env.OSCAR_LLM_API_KEY && env.OSCAR_LLM_MODEL);
}

export class LlmAdapter implements ModelAdapter {
  readonly id = 'llm';
  private readonly env: NodeJS.ProcessEnv;
  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }
  async available(): Promise<boolean> { return hasLlmConfig(this.env); }
  /**
   * Placeholder: the demo ships no model integration. When credentials exist
   * but no implementation is wired this throws instead of guessing; the loop
   * surfaces it as model_unavailable (never a silent scripted fallback).
   */
  async decide(_ctx: PolicyContext): Promise<PolicyDecision> {
    throw new Error('llm_adapter_not_implemented: OSCAR_LLM_* is configured but no LLM backend is wired in this demo version');
  }
}

export function adapterForRun(mode: 'scripted' | 'llm', env: NodeJS.ProcessEnv = process.env): ModelAdapter {
  return mode === 'llm' ? new LlmAdapter(env) : new ScriptedAdapter();
}
