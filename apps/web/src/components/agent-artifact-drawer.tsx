'use client';

import { Download, ExternalLink, FileText, X } from 'lucide-react';
import { useState } from 'react';

import { safeExternalUrl } from './agent-view-model';
import { ArtifactContentView } from './agent-artifact-content';
import {
  numberValue,
  recordValue,
  stringValue,
  type RunPart,
} from '../lib/agentpress-assistant-runtime';

export function ArtifactPart({ part }: { readonly part: RunPart }): React.JSX.Element {
  const values = Array.isArray(part.payload.artifacts)
    ? part.payload.artifacts.map(recordValue)
    : [part.payload];
  const [selected, setSelected] = useState<Readonly<Record<string, unknown>>>();
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
            key={id}
            onClick={() => {
              setSelected(artifact);
            }}
            type="button"
          >
            <strong>
              {stringValue(artifact.title) || artifactLabel(stringValue(artifact.type))}
            </strong>
            <span>{stringValue(artifact.summary) || '查看产物详情'}</span>
          </button>
        );
      })}
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
            <button onClick={() => downloadArtifact(artifact)} type="button">
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
  const blob = new Blob([JSON.stringify(artifact.content ?? {}, null, 2) ?? '{}'], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${(stringValue(artifact.title) || 'agent-artifact').replaceAll(/[\\/:*?"<>|]/gu, '-')}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
