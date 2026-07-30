import { Controller, Get } from '@nestjs/common';

import type { HealthResponse } from '@agentpress/contracts';

@Controller('health')
export class HealthController {
  public constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

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
    const missing = ['ARK_API_KEY', 'ARK_MODEL_PRO'].filter(
      (name) => !this.environment[name]?.trim(),
    );
    return {
      provider: 'ark' as const,
      ready: missing.length === 0,
      missing,
    };
  }
}
