'use client';

import {
  MessagePartPrimitive,
  useAuiState,
  useSmooth,
  type MessagePartState,
  type ReasoningMessagePart,
  type TextMessagePart,
} from '@assistant-ui/react';
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

export const AssistantMarkdownPart = memo(
  function AssistantMarkdownPart(): React.JSX.Element | null {
    const messageId = useAuiState((state) => state.message.id);
    const part = useAuiState((state) =>
      state.part.type === 'text' || state.part.type === 'reasoning' ? state.part : null,
    );
    if (!part) return null;
    return <SmoothMarkdownPart key={messageId} part={part} />;
  },
);

function SmoothMarkdownPart({
  part: source,
}: {
  readonly part: MessagePartState & (TextMessagePart | ReasoningMessagePart);
}): React.JSX.Element {
  const part = useSmooth(source, true);
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
}

export function markdownModeForStatus(status: string): 'streaming' | 'static' {
  return status === 'running' ? 'streaming' : 'static';
}
