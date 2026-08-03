'use client';

import { AgentMarkdown } from './agent-markdown';
import { recordValue, stringValue } from '../lib/agentpress-assistant-runtime';

export function ArtifactContentView({
  artifact,
}: {
  readonly artifact: Readonly<Record<string, unknown>>;
}): React.JSX.Element {
  const content = artifact.content;
  const preview = artifactPreview(content);
  if (preview) return <AgentMarkdown>{preview}</AgentMarkdown>;
  if (stringValue(artifact.type) === 'EditProposal')
    return <p className="artifact-empty">文章修改请在正文的红删绿增审阅界面中查看。</p>;
  const fields = structuredArtifactFields(content);
  if (fields.length === 0) return <p className="artifact-empty">该产物没有可预览内容。</p>;
  return (
    <dl className="artifact-structured-content">
      {fields.map((field) => (
        <div key={field.label}>
          <dt>{field.label}</dt>
          <dd>
            {field.values.length === 1 ? (
              field.values[0]
            ) : (
              <ol>
                {field.values.map((value, index) => (
                  <li key={`${field.label}:${String(index)}`}>{value}</li>
                ))}
              </ol>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
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

export function structuredArtifactFields(value: unknown) {
  return Object.entries(recordValue(value)).flatMap(([label, field]) => {
    const values = Array.isArray(field)
      ? field.flatMap((item) => {
          if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')
            return [String(item)];
          const record = recordValue(item);
          const summary =
            stringValue(record.title) ||
            stringValue(record.heading) ||
            stringValue(record.claim) ||
            stringValue(record.description) ||
            stringValue(record.summary);
          return summary ? [summary] : [];
        })
      : typeof field === 'string' || typeof field === 'number' || typeof field === 'boolean'
        ? [String(field)]
        : [];
    return values.length > 0 ? [{ label: fieldLabel(label), values }] : [];
  });
}

function fieldLabel(value: string): string {
  const labels: Record<string, string> = {
    sections: '章节',
    claims: '核查结论',
    images: '配图',
    assets: '素材',
    notes: '说明',
    keywords: '关键词',
  };
  return labels[value] ?? value;
}
