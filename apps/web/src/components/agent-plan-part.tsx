'use client';

import { ListChecks } from 'lucide-react';

import { recordValue, stringValue, type RunPart } from '../lib/agentpress-assistant-runtime';

export function PlanPart({
  part,
  embedded = false,
}: {
  readonly part: RunPart;
  readonly embedded?: boolean;
}): React.JSX.Element {
  const tasks = Array.isArray(part.payload.tasks) ? part.payload.tasks.map(recordValue) : [];
  const taskCount = tasks.length;
  const items = (
    <ol>
      {tasks.map((task, index) => (
        <li key={stringValue(task.id) || String(index)}>
          <span className="task-state" />
          <div>
            <strong>{stringValue(task.objective) || stringValue(task.label)}</strong>
          </div>
        </li>
      ))}
    </ol>
  );
  if (embedded) {
    return (
      <section className="run-process-section plan-part is-embedded">
        <h4>
          <ListChecks size={14} />
          {stringValue(part.payload.summary) || '执行计划'}
          <small>{taskCount > 0 ? `${String(taskCount)} 项任务` : ''}</small>
        </h4>
        {items}
      </section>
    );
  }
  return (
    <details className="run-part plan-part">
      <summary>
        <ListChecks size={14} />
        <span>{stringValue(part.payload.summary) || '执行计划'}</span>
        <small>{taskCount > 0 ? `${String(taskCount)} 项任务` : '查看计划'}</small>
      </summary>
      {items}
    </details>
  );
}
