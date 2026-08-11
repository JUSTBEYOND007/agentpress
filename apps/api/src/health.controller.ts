import { Controller, Get } from '@nestjs/common';

import type { HealthResponse } from '@agentpress/contracts';
import { PublicRoute } from './auth/auth.guard.js';

@Controller('health')
@PublicRoute()
export class HealthController {
  @Get()
  getHealth(): HealthResponse {
    return {
      service: 'api',
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('agent-runtime')
  getAgentRuntime() {
    return getAgentRuntimeHealth();
  }
}

export function getAgentRuntimeHealth(environment: NodeJS.ProcessEnv = process.env) {
  const missing = ['ARK_API_KEY', 'ARK_MODEL_PRO', 'ARK_EMBEDDING_MODEL', 'ARK_IMAGE_MODEL'].filter(
    (name) => !environment[name]?.trim(),
  );
  return {
    provider: 'ark' as const,
    ready: missing.length === 0,
    missing,
  };
}
