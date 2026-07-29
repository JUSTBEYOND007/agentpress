'use client';

import {
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { initialRunView, reduceRunEvent } from './run-event-reducer';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';
const conversationId = process.env.NEXT_PUBLIC_DEMO_CONVERSATION_ID;
const branchId = process.env.NEXT_PUBLIC_DEMO_BRANCH_ID;
const userId = process.env.NEXT_PUBLIC_DEMO_USER_ID;

export type AgentSendMode = 'steering' | 'follow-up';

type AgentMessage = {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly status?: 'running' | 'complete' | 'error';
};

const initialMessages: readonly AgentMessage[] = [
  {
    id: 'demo-user-1',
    role: 'user',
    text: '核对文章论据，并给开头提出更有力的改写。',
  },
  {
    id: 'demo-assistant-1',
    role: 'assistant',
    text: '我已完成来源核验，Writer 正在生成一项可逐条审批的修改提案。',
    status: 'complete',
  },
];

const eventTypes = [
  'run.queued',
  'run.planning',
  'run.started',
  'run.recovering',
  'run.recovered',
  'run.completed',
  'run.completed_with_degradation',
  'run.cancelled',
  'run.failed',
  'plan.revised',
  'task.started',
  'task.succeeded',
  'task.failed',
  'task.skipped',
  'task.cancelled',
  'tool.proposed',
  'tool.approval_requested',
  'tool.approved',
  'tool.denied',
  'tool.executing',
  'tool.succeeded',
  'tool.failed',
  'tool.expired',
  'message.started',
  'message.completed',
  'content.delta',
  'usage.updated',
] as const;

export function useAgentPressAssistantRuntime(sendMode: AgentSendMode) {
  const [messages, setMessages] = useState<readonly AgentMessage[]>(initialMessages);
  const [run, setRun] = useState(initialRunView);
  const [runId, setRunId] = useState<string>();
  const streamRef = useRef<EventSource | undefined>(undefined);

  const updateAssistant = useCallback((text: string, complete = false) => {
    setMessages((current) => {
      const last = current.at(-1);
      if (last?.role === 'assistant' && last.status === 'running') {
        return [
          ...current.slice(0, -1),
          {
            ...last,
            text: complete ? text : `${last.text}${text}`,
            status: complete ? 'complete' : 'running',
          },
        ];
      }
      return [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          text,
          status: complete ? 'complete' : 'running',
        },
      ];
    });
  }, []);

  useEffect(() => {
    if (!runId) return;
    const stream = new EventSource(`${apiUrl}/runs/${runId}/events`, { withCredentials: true });
    streamRef.current = stream;
    const receive = (event: MessageEvent<string>) => {
      const data = parseEventData(event.data);
      const type = event.type;
      const payload = recordValue(data.payload);
      setRun((current) =>
        reduceRunEvent(current, {
          type,
          runId: stringValue(data.runId) || runId,
          sequence: numberValue(data.sequence),
          payload,
        }),
      );
      if (type === 'content.delta') updateAssistant(stringValue(data.delta));
      if (type === 'message.completed') {
        const message = recordValue(payload.message ?? data.message);
        updateAssistant(stringValue(message.content), true);
      }
      if (isTerminalEvent(type)) stream.close();
    };
    for (const type of eventTypes) stream.addEventListener(type, receive as EventListener);
    stream.onerror = () => {
      setRun((current) => ({
        ...current,
        status: '正在重连',
        recovery: 'SSE 断开 · 等待事件重放',
      }));
    };
    return () => {
      stream.close();
      if (streamRef.current === stream) streamRef.current = undefined;
    };
  }, [runId, updateAssistant]);

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const prompt = messageText(message);
      if (!prompt) return;
      setMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), role: 'user', text: prompt },
      ]);
      if (!conversationId || !branchId) {
        setMessages((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            text: '当前工作区未连接真实运行会话，请先完成环境配置。',
            status: 'error',
          },
        ]);
        return;
      }
      if (runId && run.status === '运行中') {
        const endpoint = sendMode === 'steering' ? 'steering' : 'follow-ups';
        await request(`${apiUrl}/runs/${runId}/${endpoint}`, { content: prompt });
        return;
      }
      setRun((current) => ({ ...current, status: '排队中', tasks: [], tools: [] }));
      const created = await request(
        `${apiUrl}/conversations/${conversationId}/runs`,
        { branchId, prompt },
        true,
      );
      const nextRunId = stringValue(created.runId);
      if (!nextRunId) throw new Error('Run creation response omitted runId');
      setRunId(nextRunId);
      setRun((current) => ({ ...current, runId: nextRunId }));
    },
    [run.status, runId, sendMode],
  );

  const onCancel = useCallback(async () => {
    if (!runId) return;
    await request(`${apiUrl}/runs/${runId}/cancel`, {});
  }, [runId]);

  const decideTool = useCallback(async (toolCallId: string, decision: 'approved' | 'denied') => {
    if (toolCallId.startsWith('tool-demo-') || !userId) return;
    await request(`${apiUrl}/tool-calls/${toolCallId}/approval`, { decision, userId });
  }, []);

  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage,
    onNew,
    onCancel,
    isRunning: run.status === '运行中' || run.status === '规划中' || run.status === '排队中',
  });

  return { runtime, run, decideTool };
}

function convertMessage(message: AgentMessage): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    content: [{ type: 'text', text: message.text }],
    ...(message.role === 'assistant'
      ? {
          status:
            message.status === 'running'
              ? ({ type: 'running' } as const)
              : message.status === 'error'
                ? ({ type: 'incomplete', reason: 'error' } as const)
                : ({ type: 'complete', reason: 'stop' } as const),
        }
      : {}),
  };
}

function messageText(message: AppendMessage): string {
  return message.content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n')
    .trim();
}

async function request(
  url: string,
  body: unknown,
  idempotent = false,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(idempotent ? { 'idempotency-key': crypto.randomUUID() } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Agent API request failed with ${String(response.status)}`);
  return recordValue((await response.json()) as unknown);
}

function parseEventData(value: string): Record<string, unknown> {
  try {
    return recordValue(JSON.parse(value) as unknown);
  } catch {
    return {};
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function isTerminalEvent(type: string): boolean {
  return [
    'run.completed',
    'run.completed_with_degradation',
    'run.cancelled',
    'run.failed',
  ].includes(type);
}
