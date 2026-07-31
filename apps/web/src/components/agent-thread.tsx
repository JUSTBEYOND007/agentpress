'use client';

import { ThreadPrimitive } from '@assistant-ui/react';
import { ArrowDown } from 'lucide-react';

import { AssistantMessage, UserMessage } from './agent-run-parts';
import type { MemoryView } from './agent-view-model';

export function AgentThread({
  memories,
  onMemoryDecision,
}: {
  readonly memories: readonly MemoryView[];
  readonly onMemoryDecision: (id: string, decision: 'accepted' | 'rejected') => Promise<void>;
}): React.JSX.Element {
  return (
    <ThreadPrimitive.Viewport className="agent-thread">
      <ThreadPrimitive.Messages>
        {({ message }) => (message.role === 'user' ? <UserMessage /> : <AssistantMessage />)}
      </ThreadPrimitive.Messages>
      <MemoryCandidates memories={memories} onDecision={onMemoryDecision} />
      <ThreadPrimitive.ViewportFooter className="thread-footer">
        <ThreadPrimitive.ScrollToBottom asChild>
          <button className="scroll-button" aria-label="滚动到底部" type="button">
            <ArrowDown aria-hidden="true" size={15} />
          </button>
        </ThreadPrimitive.ScrollToBottom>
      </ThreadPrimitive.ViewportFooter>
    </ThreadPrimitive.Viewport>
  );
}

function MemoryCandidates({
  memories,
  onDecision,
}: {
  readonly memories: readonly MemoryView[];
  readonly onDecision: (id: string, decision: 'accepted' | 'rejected') => Promise<void>;
}): React.JSX.Element | null {
  const pending = memories.filter(({ status }) => status === 'pending');
  if (pending.length === 0) return null;
  return (
    <section className="memory-candidates">
      <strong>可保存的偏好</strong>
      {pending.map((memory) => (
        <div className="memory-candidate" key={memory.id}>
          <span>
            {memory.subject}：{memory.value}
          </span>
          <button onClick={() => void onDecision(memory.id, 'accepted')} type="button">
            保存
          </button>
          <button onClick={() => void onDecision(memory.id, 'rejected')} type="button">
            忽略
          </button>
        </div>
      ))}
    </section>
  );
}
