import type { ToolActivityAudit } from '../lib/agent-runtime-contracts';

export function AgentToolAudit({
  audit,
}: {
  readonly audit: ToolActivityAudit;
}): React.JSX.Element {
  const hiddenArgumentCount = Math.max(0, audit.argumentCount - audit.argumentNames.length);
  return (
    <details className="tool-audit-details">
      <summary>MCP 调用详情</summary>
      <dl>
        <div>
          <dt>服务</dt>
          <dd>{`${audit.serverId}@${audit.serverRevision}`}</dd>
        </div>
        <div>
          <dt>工具</dt>
          <dd>{`${audit.toolName}@${audit.toolRevision}`}</dd>
        </div>
        <div>
          <dt>适配器</dt>
          <dd>{audit.adapterRevision}</dd>
        </div>
        {audit.taskAttempt ? (
          <div>
            <dt>任务尝试</dt>
            <dd>{audit.taskAttempt}</dd>
          </div>
        ) : null}
        {audit.transportRetryCount ? (
          <div>
            <dt>连接恢复</dt>
            <dd>{`${String(audit.transportRetryCount)} 次重试，${String(audit.transportReconnectCount ?? 0)} 次重连`}</dd>
          </div>
        ) : null}
        {audit.argumentCount > 0 ? (
          <div>
            <dt>参数</dt>
            <dd>
              {audit.argumentSummary
                ? audit.argumentSummary.fields.map(argumentFieldLabel).join('、')
                : audit.argumentNames.join('、')}
              {hiddenArgumentCount > 0 ? ` 等 ${String(audit.argumentCount)} 项` : ''}
            </dd>
          </div>
        ) : null}
        {audit.outputReference ? (
          <div>
            <dt>输出</dt>
            <dd>{audit.outputReference.uri ?? audit.outputReference.artifactId}</dd>
          </div>
        ) : null}
        {audit.evidenceReferences?.length ? (
          <div>
            <dt>证据引用</dt>
            <dd>{audit.evidenceReferences.map(({ title }) => title).join('、')}</dd>
          </div>
        ) : null}
      </dl>
    </details>
  );
}

function argumentFieldLabel(
  field: NonNullable<ToolActivityAudit['argumentSummary']>['fields'][number],
): string {
  const size =
    field.stringLength !== undefined
      ? `长度 ${String(field.stringLength)}`
      : field.arrayLength !== undefined
        ? `${String(field.arrayLength)} 项`
        : field.objectKeyCount !== undefined
          ? `${String(field.objectKeyCount)} 个字段`
          : undefined;
  return `${field.name} (${field.valueType}${size ? `, ${size}` : ''})`;
}
