import type { OpenAICompatibleBackend } from './openai-compatible-provider.js';
import { createOpenAICompatibleBackend } from './openai-compatible-provider.js';

export type ArkRuntimeConfig = {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly modelId: string;
  readonly modelName?: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly inputCostPerMillion?: number;
  readonly outputCostPerMillion?: number;
};

export type ArkBackend = OpenAICompatibleBackend;

export function createArkBackend(config: ArkRuntimeConfig): ArkBackend {
  return createOpenAICompatibleBackend({
    providerId: 'volcengine-ark',
    providerName: 'Volcengine Ark',
    apiKeyEnvironmentVariable: 'ARK_API_KEY',
    baseUrl: config.baseUrl ?? 'https://ark.cn-beijing.volces.com/api/v3',
    modelId: config.modelId,
    acceptsStrictTools: true,
    enforcesStrictTools: true,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.modelName ? { modelName: config.modelName } : {}),
    ...(config.contextWindow ? { contextWindow: config.contextWindow } : {}),
    ...(config.maxTokens ? { maxTokens: config.maxTokens } : {}),
    ...(config.inputCostPerMillion ? { inputCostPerMillion: config.inputCostPerMillion } : {}),
    ...(config.outputCostPerMillion ? { outputCostPerMillion: config.outputCostPerMillion } : {}),
  });
}
