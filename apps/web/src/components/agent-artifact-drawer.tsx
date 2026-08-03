'use client';

import { Download, ExternalLink, FileText, X } from 'lucide-react';
import { useState } from 'react';

import { safeExternalUrl } from './agent-view-model';
import { ArtifactContentView } from './agent-artifact-content';
import { authenticatedFetch } from '../lib/authenticated-fetch';
import {
  numberValue,
  recordValue,
  stringValue,
  type RunPart,
} from '../lib/agentpress-assistant-runtime';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';

export function ArtifactPart({ part }: { readonly part: RunPart }): React.JSX.Element {
  const values = Array.isArray(part.payload.artifacts)
    ? part.payload.artifacts.map(recordValue)
    : [part.payload];
  const [selected, setSelected] = useState<Readonly<Record<string, unknown>>>();
  const [openingId, setOpeningId] = useState<string>();
  const [error, setError] = useState<string>();
  return (
    <section className="run-part artifact-part" aria-label="Agent 产物">
      <h3>
        <FileText size={14} /> 产出
      </h3>
      {values.map((artifact, index) => {
        const id = stringValue(artifact.id) || stringValue(artifact.artifactId) || String(index);
        return (
          <button
            className="artifact-card"
            disabled={Boolean(openingId)}
            key={id}
            onClick={() => {
              const version = numberValue(artifact.version);
              setOpeningId(id);
              setError(undefined);
              void loadArtifact(part.runId, id, version)
                .then(setSelected)
                .catch((reason: unknown) => {
                  setError(reason instanceof Error ? reason.message : '产物加载失败，请重试。');
                })
                .finally(() => {
                  setOpeningId(undefined);
                });
            }}
            type="button"
          >
            <strong>
              {stringValue(artifact.title) || artifactLabel(stringValue(artifact.type))}
            </strong>
            <span>
              {openingId === id ? '正在加载' : stringValue(artifact.summary) || '查看产物详情'}
            </span>
          </button>
        );
      })}
      {error ? (
        <p className="interaction-error" role="alert">
          {error}
        </p>
      ) : null}
      {selected ? (
        <ArtifactDrawer
          artifact={selected}
          onClose={() => {
            setSelected(undefined);
          }}
        />
      ) : null}
    </section>
  );
}

export async function loadArtifact(
  runId: string,
  artifactId: string,
  version: number,
): Promise<Readonly<Record<string, unknown>>> {
  const query = version > 0 ? `?version=${encodeURIComponent(String(version))}` : '';
  const response = await authenticatedFetch(
    `${apiUrl}/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}${query}`,
  );
  if (response.status === 404) throw new Error('这个产物已经不存在。');
  if (response.status === 409) throw new Error('这个产物已有新版本，请刷新对话后查看。');
  if (!response.ok) throw new Error('产物加载失败，请重试。');
  const artifact = (await response.json()) as unknown;
  if (typeof artifact !== 'object' || artifact === null || Array.isArray(artifact)) {
    throw new Error('产物响应格式无效。');
  }
  return artifact as Readonly<Record<string, unknown>>;
}

function ArtifactDrawer({
  artifact,
  onClose,
}: {
  readonly artifact: Readonly<Record<string, unknown>>;
  readonly onClose: () => void;
}): React.JSX.Element {
  const href = safeExternalUrl(artifact.url) ?? safeExternalUrl(artifact.downloadUrl);
  const evidence = Array.isArray(artifact.evidence) ? artifact.evidence.map(recordValue) : [];
  return (
    <div className="artifact-drawer-backdrop" role="presentation" onMouseDown={onClose}>
      <aside
        className="artifact-drawer"
        aria-label="产物详情"
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
      >
        <header>
          <div>
            <strong>{stringValue(artifact.title) || '未命名产物'}</strong>
            <span>
              {stringValue(artifact.type) || 'artifact'} · v
              {String(numberValue(artifact.version) || 1)}
            </span>
          </div>
          <button aria-label="关闭产物详情" onClick={onClose} type="button">
            <X size={16} />
          </button>
        </header>
        {stringValue(artifact.summary) ? (
          <p className="artifact-summary">{stringValue(artifact.summary)}</p>
        ) : null}
        <ArtifactContentView artifact={artifact} />
        {evidence.length > 0 ? (
          <section className="artifact-provenance">
            <h3>来源</h3>
            <ul>
              {evidence.map((item, index) => {
                const source = safeExternalUrl(item.source);
                const title = stringValue(item.title) || stringValue(item.claim) || '引用来源';
                return (
                  <li key={stringValue(item.evidenceId) || String(index)}>
                    {source ? (
                      <a href={source} rel="noopener noreferrer" target="_blank">
                        {title} <ExternalLink size={11} />
                      </a>
                    ) : (
                      title
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
        {href ? (
          <footer>
            <a href={href} rel="noopener noreferrer" target="_blank">
              打开 <ExternalLink size={12} />
            </a>
            <a download href={href}>
              下载 <Download size={12} />
            </a>
          </footer>
        ) : (
          <footer>
            <button
              onClick={() => {
                downloadArtifact(artifact);
              }}
              type="button"
            >
              下载 <Download size={12} />
            </button>
          </footer>
        )}
      </aside>
    </div>
  );
}

function artifactLabel(type: string): string {
  const labels: Record<string, string> = {
    EditProposal: '文章修改',
    markdown: 'Markdown 文档',
    report: '报告',
  };
  return labels[type] ?? 'Agent 产物';
}

export function downloadArtifact(artifact: Readonly<Record<string, unknown>>): void {
  const blob = new Blob([JSON.stringify(artifact.content ?? {}, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${(stringValue(artifact.title) || 'agent-artifact').replaceAll(/[\\/:*?"<>|]/gu, '-')}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
