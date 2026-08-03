'use client';

import { MessagePartPrimitive, useMessagePartText, useSmooth } from '@assistant-ui/react';
import { cjk } from '@streamdown/cjk';
import { code } from '@streamdown/code';
import { math } from '@streamdown/math';
import { mermaid } from '@streamdown/mermaid';
import { memo } from 'react';
import { Streamdown } from 'streamdown';

const streamdownPlugins = { cjk, code, math, mermaid };

export function UserTextPart(): React.JSX.Element {
  return <MessagePartPrimitive.Text className="message-text user-message-text" smooth={false} />;
}

export const AssistantMarkdownPart = memo(function AssistantMarkdownPart(): React.JSX.Element {
  const part = useSmooth(useMessagePartText(), true);
  const streaming = part.status.type === 'running';
  return (
    <Streamdown
      className="message-text message-markdown"
      isAnimating={streaming}
      linkSafety={{ enabled: true }}
      mode={markdownModeForStatus(part.status.type)}
      plugins={streamdownPlugins}
    >
      {part.text}
    </Streamdown>
  );
});

export function markdownModeForStatus(status: string): 'streaming' | 'static' {
  return status === 'running' ? 'streaming' : 'static';
}
