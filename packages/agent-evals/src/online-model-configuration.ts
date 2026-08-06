import { PiRuntimeAdapter } from '@agentpress/agent-runtime';

export type OnlineModelConfiguration = {
  readonly kind: 'openai-compatible' | 'volcengine-ark';
  readonly proModel: string;
  readonly turboModel?: string;
  readonly create: (modelId: string) => PiRuntimeAdapter;
};

export function loadOnlineModelConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): OnlineModelConfiguration {
  const customApiKey = environment.AGENT_MODEL_API_KEY?.trim();
  const customBaseUrl = environment.AGENT_MODEL_BASE_URL?.trim();
  const customProModel = environment.AGENT_MODEL_PRO?.trim();
  const customTurboModel = environment.AGENT_MODEL_TURBO?.trim();
  const customValues = [customApiKey, customBaseUrl, customProModel];
  if (customValues.some(Boolean) && !customValues.every(Boolean)) {
    throw new Error(
      'AGENT_MODEL_API_KEY, AGENT_MODEL_BASE_URL and AGENT_MODEL_PRO must be configured together',
    );
  }
  if (customApiKey && customBaseUrl && customProModel) {
    return {
      kind: 'openai-compatible',
      proModel: customProModel,
      ...(customTurboModel ? { turboModel: customTurboModel } : {}),
      create: (modelId) =>
        PiRuntimeAdapter.forOpenAICompatible({
          providerId: 'agentpress-eval',
          providerName: 'AgentPress eval provider',
          apiKey: customApiKey,
          baseUrl: customBaseUrl,
          modelId,
          acceptsStrictTools: true,
          enforcesStrictTools: false,
        }),
    };
  }

  const arkApiKey = required(environment, 'ARK_API_KEY');
  const arkBaseUrl = environment.ARK_BASE_URL?.trim();
  return {
    kind: 'volcengine-ark',
    proModel: required(environment, 'ARK_MODEL_PRO'),
    ...(environment.ARK_MODEL_TURBO?.trim()
      ? { turboModel: environment.ARK_MODEL_TURBO.trim() }
      : {}),
    create: (modelId) =>
      PiRuntimeAdapter.forArk({
        apiKey: arkApiKey,
        modelId,
        ...(arkBaseUrl ? { baseUrl: arkBaseUrl } : {}),
      }),
  };
}

function required(environment: NodeJS.ProcessEnv, name: 'ARK_API_KEY' | 'ARK_MODEL_PRO'): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required for online model evaluation`);
  return value;
}
