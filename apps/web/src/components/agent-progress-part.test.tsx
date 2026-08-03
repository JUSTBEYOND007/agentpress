import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AgentProgressPart } from './agent-progress-part';

describe('Agent progress part', () => {
  it('shows public long-task progress and the latest safe recovery point', () => {
    const markup = renderToStaticMarkup(
      <AgentProgressPart
        part={{
          id: 'progress-1',
          runId: 'run-1',
          sequence: 4,
          type: 'progress',
          status: 'progress.waiting_for_user',
          payload: {
            phase: 'waiting_for_user',
            completedSteps: 1,
            totalSteps: 3,
            activeStep: { objective: '撰写正文', owner: 'writer' },
            outstandingInteraction: 'ask-user',
            recoveryPoint: { reason: 'task_settled' },
          },
        }}
      />,
    );

    expect(markup).toContain('等待补充信息');
    expect(markup).toContain('1/3 已完成');
    expect(markup).toContain('撰写正文');
    expect(markup).toContain('最近安全点：已保存的任务结果');
    expect(markup).not.toContain('task_settled');
  });
});
