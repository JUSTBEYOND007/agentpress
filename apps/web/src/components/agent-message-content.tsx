'use client';

import {
  MessagePartPrimitive,
  useAuiState,
  useSmooth,
  type MessagePartState,
  type ReasoningMessagePart,
  type TextMessagePart,
} from '@assistant-ui/react';
import { memo } from 'react';

import { AgentMarkdown } from './agent-markdown';

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
  return <AgentMarkdown streaming={streaming}>{part.text}</AgentMarkdown>;
}

export function markdownModeForStatus(status: string): 'streaming' | 'static' {
  return status === 'running' ? 'streaming' : 'static';
}
