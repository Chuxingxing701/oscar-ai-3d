// Server-side model configuration for the session backend (design §8).
// Explicit only: OSCAR_MODEL_BASE_URL + OSCAR_MODEL_API_KEY(_FILE) +
// OSCAR_MODEL_NAME. Any OpenAI-compatible endpoint works (DeepSeek, a local
// stub). Missing config is a real, visible state (model_unavailable /
// needs_configuration) — never a silent scripted fallback.
import {readFileSync} from 'node:fs';

export interface ModelConfig {
  provider: string;        // display/telemetry id, never sent as a tool param
  baseUrl: string;         // OpenAI-compatible base URL (…/v1)
  apiKey: string;
  model: string;           // model name on the wire
  source: 'env' | 'env-file';
}

export interface ModelConfigStatus {
  configured: boolean;
  missing: string[];
  config: ModelConfig | null;
}

export function loadModelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfigStatus {
  const missing: string[] = [];
  const baseUrl = env.OSCAR_MODEL_BASE_URL?.trim();
  const modelName = env.OSCAR_MODEL_NAME?.trim();
  let apiKey = env.OSCAR_MODEL_API_KEY?.trim();
  let source: ModelConfig['source'] = 'env';
  const keyFile = env.OSCAR_MODEL_API_KEY_FILE?.trim();
  if (!apiKey && keyFile) {
    try {
      apiKey = readFileSync(keyFile, 'utf8').trim();
      source = 'env-file';
    } catch {
      missing.push(`OSCAR_MODEL_API_KEY_FILE (${keyFile}) could not be read`);
    }
  }
  if (!baseUrl) missing.push('OSCAR_MODEL_BASE_URL');
  if (!modelName) missing.push('OSCAR_MODEL_NAME');
  if (!apiKey) missing.push('OSCAR_MODEL_API_KEY or OSCAR_MODEL_API_KEY_FILE');
  if (missing.length) return {configured: false, missing, config: null};
  return {configured: true, missing: [],
    config: {provider: env.OSCAR_MODEL_PROVIDER?.trim() || 'custom-openai', baseUrl: baseUrl!,
      apiKey: apiKey!, model: modelName!, source}};
}
