'use client';

import { cjk } from '@streamdown/cjk';
import { code } from '@streamdown/code';
import { math } from '@streamdown/math';
import { mermaid } from '@streamdown/mermaid';
import { Streamdown } from 'streamdown';

const plugins = { cjk, code, math, mermaid };

export function AgentMarkdown({
  children,
  streaming = false,
}: {
  readonly children: string;
  readonly streaming?: boolean;
}): React.JSX.Element {
  return (
    <Streamdown
      className="message-text message-markdown"
      isAnimating={streaming}
      linkSafety={{ enabled: true }}
      mode={streaming ? 'streaming' : 'static'}
      plugins={plugins}
    >
      {children}
    </Streamdown>
  );
}
