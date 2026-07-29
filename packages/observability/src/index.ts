import pino, { type Logger } from 'pino';

import type { ServiceName } from '@agentpress/contracts';

export type ServiceLoggerOptions = {
  readonly level: string;
  readonly service: ServiceName;
};

export function createServiceLogger(options: ServiceLoggerOptions): Logger {
  return pino({
    base: {
      service: options.service,
    },
    level: options.level,
    messageKey: 'message',
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
