import type { AgentRuntimeFactory } from '@agentpress/agent-application';
import { PiRuntimeAdapter } from '@agentpress/agent-runtime';
import type { WorkerEnvironment } from '@agentpress/config';

import { createModelPolicies } from './worker-protocol.js';

export function createWorkerRuntimeFactory(environment: WorkerEnvironment): AgentRuntimeFactory {
  return {
    create: (task = 'direct') => {
      const proModel = environment.agentModelPro ?? environment.arkModelPro;
      if (!proModel) {
        throw new Error('AGENT_MODEL_PRO or ARK_MODEL_PRO is required to execute a real Agent Run');
      }
      const turboModel = environment.agentModelPro
        ? environment.agentModelTurbo
        : environment.arkModelTurbo;
      const selection = createModelPolicies(proModel, turboModel).select(task);
      if (
        environment.agentModelApiKey &&
        environment.agentModelBaseUrl &&
        environment.agentModelPro
      ) {
        return PiRuntimeAdapter.forOpenAICompatible({
          providerId: 'agent-model',
          providerName: 'Agent model',
          modelId: selection.model,
          baseUrl: environment.agentModelBaseUrl,
          apiKey: environment.agentModelApiKey,
          acceptsStrictTools: true,
          enforcesStrictTools: false,
        });
      }
      return PiRuntimeAdapter.forArk({
        modelId: selection.model,
        baseUrl: environment.arkBaseUrl,
        ...(environment.arkApiKey ? { apiKey: environment.arkApiKey } : {}),
      });
    },
  };
}
