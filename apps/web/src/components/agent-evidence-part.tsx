import { ExternalLink, FileCheck2 } from 'lucide-react';

import { stringValue, type RunPart } from '../lib/agentpress-assistant-runtime';
import { safeExternalUrl } from './agent-view-model';

export function EvidencePart({ part }: { readonly part: RunPart }): React.JSX.Element {
  const href = safeExternalUrl(part.payload.url) ?? safeExternalUrl(part.payload.sourceUrl);
  return (
    <section className="run-part evidence-part">
      <FileCheck2 size={14} />
      {href ? (
        <a href={href} rel="noopener noreferrer" target="_blank">
          {stringValue(part.payload.title) || '查看引用来源'}
          <ExternalLink aria-hidden="true" size={11} />
        </a>
      ) : (
        <strong>{stringValue(part.payload.title) || '引用来源'}</strong>
      )}
      <span>{stringValue(part.payload.source)}</span>
    </section>
  );
}
