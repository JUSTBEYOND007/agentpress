import { Clock3, LoaderCircle } from 'lucide-react';

import type { RunPart } from '../lib/agentpress-assistant-runtime';
import { toolActivityAudit } from '../lib/agent-tool-audit-projection';
import { AgentToolAudit } from './agent-tool-audit';
import { activityLabel, statusLabel } from './agent-view-model';

export function ActivityPart({ part }: { readonly part: RunPart }): React.JSX.Element {
  const active = part.status.includes('started') || part.status.includes('executing');
  const audit = toolActivityAudit(part);
  return (
    <div className={`run-part activity-part${active ? ' is-active' : ''}`}>
      <div role="status">
        {active ? <LoaderCircle className="activity-spinner" size={13} /> : <Clock3 size={13} />}
        <span>{activityLabel(part)}</span>
        <small>{statusLabel(part.status)}</small>
      </div>
      {audit ? <AgentToolAudit audit={audit} /> : null}
    </div>
  );
}
