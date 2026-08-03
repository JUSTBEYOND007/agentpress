'use client';

import { Download, ExternalLink, FileText, X } from 'lucide-react';
import { useState } from 'react';
import { Streamdown } from 'streamdown';
import { cjk } from '@streamdown/cjk';
import { code } from '@streamdown/code';
import { math } from '@streamdown/math';
import { mermaid } from '@streamdown/mermaid';

import { safeExternalUrl } from './agent-view-model';
import {
  numberValue,
  recordValue,
  stringValue,
  type RunPart,
} from '../lib/agentpress-assistant-runtime';

const plugins = { cjk, code, math, mermaid };

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
  const content = artifactPreview(artifact.content);
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
        {content ? (
          <Streamdown mode="static" plugins={plugins} linkSafety={{ enabled: true }}>
            {content}
          </Streamdown>
        ) : (
          <p className="artifact-empty">该产物没有可预览内容。</p>
        )}
        {href ? (
          <footer>
            <a href={href} rel="noopener noreferrer" target="_blank">
              打开 <ExternalLink size={12} />
            </a>
            <a download href={href}>
              下载 <Download size={12} />
            </a>
          </footer>
        ) : null}
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

export function artifactPreview(value: unknown): string {
  if (typeof value === 'string') return value;
  const content = recordValue(value);
  return (
    stringValue(content.markdown) ||
    stringValue(content.content) ||
    stringValue(content.text) ||
    stringValue(content.body)
  );
}
