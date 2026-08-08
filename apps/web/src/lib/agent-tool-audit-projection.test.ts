import { describe, expect, it } from 'vitest';

import type { RunPart } from './agent-runtime-contracts';
import { toolActivityAudit } from './agent-tool-audit-projection';

describe('MCP tool audit projection', () => {
  it('is idempotent for an already sanitized audit payload', () => {
    const audit = {
      kind: 'mcp' as const,
      serverId: 'web_research',
      serverRevision: '1.0.0',
      toolName: 'search',
      toolRevision: '1.0.0',
      adapterRevision: 'agentpress-mcp-adapter-v1',
      argumentNames: ['query'],
      argumentCount: 1,
      outputReference: {
        artifactId: 'artifact-1',
        uri: 'artifact://artifact-1/versions/1',
      },
    };
    expect(toolActivityAudit(activity({ toolAudit: audit }))).toEqual(audit);
  });

  it('rejects incomplete or unbounded transport provenance', () => {
    expect(
      toolActivityAudit(
        activity({
          transportProvenance: {
            kind: 'mcp',
            serverId: 'x'.repeat(241),
            serverRevision: '1.0.0',
            toolName: 'search',
            toolRevision: '1.0.0',
            adapterRevision: 'agentpress-mcp-adapter-v1',
          },
        }),
      ),
    ).toBeUndefined();
    expect(toolActivityAudit(activity({ transportProvenance: { kind: 'mcp' } }))).toBeUndefined();
  });

  it('keeps only bounded durable duration in the audit detail', () => {
    const base = {
      kind: 'mcp' as const,
      serverId: 'web_research',
      serverRevision: '1.0.0',
      toolName: 'search',
      toolRevision: '1.0.0',
      adapterRevision: 'agentpress-mcp-adapter-v1',
    };
    expect(
      toolActivityAudit(activity({ transportProvenance: base, durationMs: 12.6 })),
    ).toMatchObject({
      durationMs: 13,
    });
    expect(
      toolActivityAudit(activity({ transportProvenance: base, durationMs: -1 }))?.durationMs,
    ).toBeUndefined();
    expect(
      toolActivityAudit(activity({ transportProvenance: base, durationMs: 86_400_001 }))
        ?.durationMs,
    ).toBeUndefined();
  });

  it('keeps bounded schema-aware shape metadata without consuming raw argument values', () => {
    const base = {
      kind: 'mcp' as const,
      serverId: 'web_research',
      serverRevision: '1.0.0',
      toolName: 'search',
      toolRevision: '1.0.0',
      adapterRevision: 'agentpress-mcp-adapter-v1',
    };
    const projected = toolActivityAudit(
      activity({
        transportProvenance: base,
        arguments: { query: 'must-not-survive' },
        argumentSummary: {
          schemaVersion: 1,
          fieldCount: 1,
          additionalFieldCount: 0,
          fields: [
            {
              name: 'query',
              required: true,
              schemaTypes: ['string'],
              valueType: 'string',
              stringLength: 16,
            },
          ],
        },
      }),
    );

    expect(projected?.argumentSummary).toEqual({
      schemaVersion: 1,
      fieldCount: 1,
      additionalFieldCount: 0,
      fields: [
        {
          name: 'query',
          required: true,
          schemaTypes: ['string'],
          valueType: 'string',
          stringLength: 16,
        },
      ],
    });
    expect(JSON.stringify(projected)).not.toContain('must-not-survive');
  });
});

function activity(payload: Readonly<Record<string, unknown>>): RunPart {
  return {
    id: 'activity-1',
    runId: 'run-1',
    sequence: 1,
    type: 'activity',
    status: 'tool.succeeded',
    payload,
  };
}
