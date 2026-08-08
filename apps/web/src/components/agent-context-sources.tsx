'use client';

import { BookOpenText, Database, FileText, Paperclip, Sparkles } from 'lucide-react';

import {
  numberValue,
  recordValue,
  stringValue,
  type RunPart,
} from '../lib/agentpress-assistant-runtime';

type ContextSource = {
  readonly id: string;
  readonly kind: string;
  readonly revision?: string;
  readonly selectionOrigin?: 'explicit' | 'model';
};

export function ContextSourcesPart({
  part,
  embedded = false,
}: {
  readonly part: RunPart;
  readonly embedded?: boolean;
}): React.JSX.Element {
  const view = contextSourcesView(part.payload);
  if (embedded) {
    return (
      <section className="run-process-section run-context-sources is-embedded">
        <h4>
          <Database size={12} /> 上下文
          <small>
            {view.sources.length} 项 · {view.tokenCount.toLocaleString()} tokens
          </small>
        </h4>
        <ContextSourcesBody view={view} />
      </section>
    );
  }
  return (
    <details className="run-context-sources">
      <summary>
        <Database size={12} /> 上下文{' '}
        <span>
          {view.sources.length} 项 · {view.tokenCount.toLocaleString()} tokens
        </span>
      </summary>
      <ContextSourcesBody view={view} />
    </details>
  );
}

function ContextSourcesBody({
  view,
}: {
  readonly view: ReturnType<typeof contextSourcesView>;
}): React.JSX.Element {
  return (
    <>
      <div className="context-source-runtime">
        {view.model ? (
          <span>
            {view.provider ? `${view.provider} / ` : ''}
            {view.model}
          </span>
        ) : null}
        <span>
          {view.tokenCount.toLocaleString()} / {view.maxInputTokens.toLocaleString()} tokens
        </span>
      </div>
      <ul>
        {view.sources.map((source) => (
          <li key={`${source.kind}:${source.id}`}>
            <SourceIcon kind={source.kind} />
            <span>{sourceLabel(source)}</span>
            {source.selectionOrigin ? (
              <small>{selectionOriginLabel(source.selectionOrigin)}</small>
            ) : null}
            {source.revision ? <small>{shortRevision(source.revision)}</small> : null}
          </li>
        ))}
      </ul>
      {view.droppedCount > 0 ? <p>{view.droppedCount} 项因预算或权限状态未加入本次运行</p> : null}
      {view.selectionFailure ? <p>Agent Skill 自动选择失败，本轮仅保留用户显式选择。</p> : null}
    </>
  );
}

export function contextSourcesView(payload: Readonly<Record<string, unknown>>) {
  const manifest = recordValue(payload.manifest);
  const skillSelections = recordValue(payload.skillSelections);
  const explicitSkills = skillSelectionIds(skillSelections.explicit);
  const modelSkills = skillSelectionIds(skillSelections.model);
  const selectionFailure =
    recordValue(skillSelections.modelSelection).status === 'failed' ? 'failed' : undefined;
  const sources = Array.isArray(manifest.included)
    ? manifest.included
        .map(recordValue)
        .map((item) => {
          const id = stringValue(item.id);
          const selectionOrigin = skillSelectionOrigin(id, explicitSkills, modelSkills);
          return {
            id,
            kind: stringValue(item.kind),
            ...(stringValue(item.revision) ? { revision: stringValue(item.revision) } : {}),
            ...(selectionOrigin ? { selectionOrigin } : {}),
          };
        })
        .filter(({ id }) => id)
    : [];
  return {
    sources,
    tokenCount: numberValue(manifest.tokenCount),
    maxInputTokens: numberValue(manifest.maxInputTokens),
    droppedCount: Array.isArray(manifest.dropped) ? manifest.dropped.length : 0,
    ...(selectionFailure ? { selectionFailure } : {}),
    model: stringValue(payload.model),
    provider: stringValue(payload.provider),
  };
}

function skillSelectionIds(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value.flatMap((item) => {
      const skillId = stringValue(recordValue(item).skillId);
      return skillId ? [skillId] : [];
    }),
  );
}

function skillSelectionOrigin(
  sourceId: string,
  explicit: ReadonlySet<string>,
  model: ReadonlySet<string>,
): ContextSource['selectionOrigin'] {
  if (!sourceId.startsWith('skill:')) return undefined;
  const skillId = sourceId.slice(6);
  if (explicit.has(skillId)) return 'explicit';
  return model.has(skillId) ? 'model' : undefined;
}

function selectionOriginLabel(origin: NonNullable<ContextSource['selectionOrigin']>): string {
  return origin === 'explicit' ? '用户选择' : 'Agent 选择';
}

function SourceIcon({ kind }: { readonly kind: string }): React.JSX.Element {
  if (kind === 'attachment') return <Paperclip size={12} />;
  if (kind === 'policy') return <Sparkles size={12} />;
  if (kind === 'mention') return <FileText size={12} />;
  return <BookOpenText size={12} />;
}

function sourceLabel(source: ContextSource): string {
  if (source.id.startsWith('article-selection:')) return '正文选区';
  if (source.id.startsWith('article-revision:')) return `文章版本 ${source.id.slice(17)}`;
  if (source.id.startsWith('article:')) return `文章 ${source.id.slice(8)}`;
  if (source.id.startsWith('attachment:')) return `附件 ${source.id.slice(11)}`;
  if (source.id.startsWith('skill:')) return `技能 ${source.id.slice(6)}`;
  if (source.id.startsWith('evidence:')) return `证据 ${source.id.slice(9)}`;
  if (source.id.startsWith('prompt:')) return 'Agent 策略';
  return source.id;
}

function shortRevision(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}
