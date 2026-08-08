import type { AgentPressDatabase } from '@agentpress/database';

import type {
  AgentRuntimeFactory,
  RunEventPublisher,
  RuntimeToolFactory,
  SkillPreselector,
} from './contracts.js';

export type DirectRunServiceOptions = {
  readonly database: AgentPressDatabase;
  readonly runtimeFactory: AgentRuntimeFactory;
  readonly publisher: RunEventPublisher;
  readonly systemPrompt: string;
  readonly runtimeToolFactory?: RuntimeToolFactory;
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly maxSpecialistConcurrency?: number;
  readonly taskTimeoutMs?: number;
  readonly detachedTaskWaitTimeoutMs?: number;
  readonly maxSpecialistTokens?: number;
  /** Disable outbox dispatch only for isolated evaluation harnesses. Production defaults to true. */
  readonly dispatchCommands?: boolean;
  /** Optional Pi-backed chooser. The host validates its result before pinning context. */
  readonly skillPreselector?: SkillPreselector;
};
