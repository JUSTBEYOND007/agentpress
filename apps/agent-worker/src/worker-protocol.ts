import { ModelPolicyCatalog } from '@agentpress/agent-context';

export type RunCommand = {
  readonly command: 'run.execute';
  readonly messageId: string;
  readonly runId: string;
};

export type SteeringCommand = {
  readonly runId: string;
  readonly directiveId: string;
  readonly content: string;
};

export type IndexCommand = {
  readonly command: 'article.index';
  readonly messageId: string;
  readonly revisionId: string;
};

export function parseRunCommand(payload: string | undefined): RunCommand | undefined {
  if (!payload) return undefined;
  try {
    const value: unknown = JSON.parse(payload);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('command' in value) ||
      value.command !== 'run.execute' ||
      !('messageId' in value) ||
      typeof value.messageId !== 'string' ||
      !('runId' in value) ||
      typeof value.runId !== 'string'
    )
      return undefined;
    return value as RunCommand;
  } catch {
    return undefined;
  }
}

export function parseSteeringCommand(payload: string | undefined): SteeringCommand | undefined {
  if (!payload) return undefined;
  try {
    const value: unknown = JSON.parse(payload);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('runId' in value) ||
      typeof value.runId !== 'string' ||
      !('directiveId' in value) ||
      typeof value.directiveId !== 'string' ||
      !('content' in value) ||
      typeof value.content !== 'string'
    )
      return undefined;
    return value as SteeringCommand;
  } catch {
    return undefined;
  }
}

export function parseIndexCommand(payload: string | undefined): IndexCommand | undefined {
  if (!payload) return undefined;
  try {
    const value: unknown = JSON.parse(payload);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('command' in value) ||
      value.command !== 'article.index' ||
      !('messageId' in value) ||
      typeof value.messageId !== 'string' ||
      !('revisionId' in value) ||
      typeof value.revisionId !== 'string'
    )
      return undefined;
    return value as IndexCommand;
  } catch {
    return undefined;
  }
}

export function createModelPolicies(proModel: string, turboModel?: string): ModelPolicyCatalog {
  const fastModel = turboModel ?? proModel;
  const policy = (task: string, primary: string, fallbacks: readonly string[]) => ({
    task,
    primary,
    fallbacks,
    embeddingModel: 'configured-by-rag-provider',
    rerankModel: 'configured-by-rag-provider',
    imageModel: 'configured-by-media-provider',
  });
  return new ModelPolicyCatalog([
    policy('main', proModel, fastModel === proModel ? [] : [fastModel]),
    policy('direct', proModel, fastModel === proModel ? [] : [fastModel]),
    policy('researcher', fastModel, fastModel === proModel ? [] : [proModel]),
    policy('fact_checker', fastModel, fastModel === proModel ? [] : [proModel]),
    policy('writer', proModel, fastModel === proModel ? [] : [fastModel]),
    policy('editor', proModel, fastModel === proModel ? [] : [fastModel]),
    policy('illustrator', proModel, fastModel === proModel ? [] : [fastModel]),
    policy('synthesis', proModel, fastModel === proModel ? [] : [fastModel]),
  ]);
}
