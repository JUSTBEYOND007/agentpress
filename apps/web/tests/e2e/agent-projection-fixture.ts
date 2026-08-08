import type { Page, Route } from '@playwright/test';

import { mcpProjectionParts } from './mcp-projection-parts';

export const fixtureConversationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const fixtureBranchId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const fixtureSiblingBranchId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const fixtureRunId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const fixtureUserMessageId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
export const fixtureSiblingUserMessageId = '11111111-1111-4111-8111-111111111111';
export const fixtureArtifactId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

type FixtureState = 'idle' | 'running' | 'completed';
export type ProjectionFixtureScenario = 'streaming' | 'degraded' | 'mcp-matrix';

export function installAgentProjectionFixture(
  page: Page,
  scenario: ProjectionFixtureScenario = 'streaming',
): {
  complete: () => void;
  getState: () => FixtureState;
} {
  let state: FixtureState = 'running';
  let completeStream = (): void => undefined;
  const streamCompletion = new Promise<void>((resolve) => {
    completeStream = resolve;
  });

  void page.route('**/v1/health/agent-runtime', async (route) => {
    await json(route, { provider: 'ark', ready: true, missing: [] });
  });

  void page.route('**/v1/articles/*/conversations', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await json(route, [
      {
        id: fixtureConversationId,
        branchId: fixtureBranchId,
        title: 'InkOS 浏览器流式验收',
        isDefault: true,
        branchCreatedAt: '2026-08-01T00:00:00.000Z',
        status: state === 'running' ? 'running' : 'ready',
      },
      {
        id: fixtureConversationId,
        branchId: fixtureSiblingBranchId,
        title: 'InkOS 浏览器流式验收',
        isDefault: false,
        parentBranchId: fixtureBranchId,
        forkedFromMessageId: fixtureUserMessageId,
        branchCreatedAt: '2026-08-02T00:00:00.000Z',
        status: 'ready',
      },
    ]);
  });

  void page.route(
    `**/v1/conversations/${fixtureConversationId}/branches/${fixtureBranchId}/messages`,
    async (route) => {
      if (state === 'idle') {
        await json(route, []);
        return;
      }
      await json(route, [
        { id: fixtureUserMessageId, role: 'user', content: '请生成一段流式 Markdown。' },
      ]);
    },
  );

  void page.route(
    `**/v1/conversations/${fixtureConversationId}/branches/${fixtureBranchId}/runs`,
    async (route) => {
      await json(
        route,
        state === 'idle'
          ? []
          : [
              projection(
                state === 'completed' ? scenarioStatus(scenario) : 'running',
                fixtureUserMessageId,
                scenario,
              ),
            ],
      );
    },
  );

  void page.route(
    `**/v1/conversations/${fixtureConversationId}/branches/${fixtureSiblingBranchId}/messages`,
    async (route) => {
      await json(route, [
        {
          id: fixtureSiblingUserMessageId,
          role: 'user',
          content: '请在分支中重新生成一段 Markdown。',
        },
      ]);
    },
  );

  void page.route(
    `**/v1/conversations/${fixtureConversationId}/branches/${fixtureSiblingBranchId}/runs`,
    async (route) => {
      await json(route, [projection('completed', fixtureSiblingUserMessageId, scenario)]);
    },
  );

  void page.route(`**/v1/conversations/${fixtureConversationId}/runs`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    state = 'running';
    await json(route, { runId: fixtureRunId, messageId: fixtureUserMessageId });
  });

  void page.route(`**/v1/runs/${fixtureRunId}/projection`, async (route) => {
    await json(
      route,
      projection(
        state === 'completed' ? scenarioStatus(scenario) : 'running',
        fixtureUserMessageId,
        scenario,
      ),
    );
  });

  void page.route(`**/v1/runs/${fixtureRunId}/events`, async (route) => {
    await streamCompletion;
    state = 'completed';
    const firstDelta =
      scenario === 'mcp-matrix'
        ? '# MCP 失败矩阵已完成\\n\\n'
        : scenario === 'degraded'
          ? '# 部分完成\\n\\n已保留成功来源，'
          : '# 流式标题\\n\\n这是第一段。';
    const secondDelta =
      scenario === 'mcp-matrix'
        ? '已保留可确认的资料结果。'
        : scenario === 'degraded'
          ? '失败查询待恢复。'
          : '\\n\\n- 增量项目\\n- 第二个项目';
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: [
        'event: message.started',
        'data: {"sequence":1}',
        '',
        'event: content.delta',
        `data: {"sequence":2,"delta":"${firstDelta}"}`,
        '',
        'event: content.delta',
        `data: {"sequence":3,"delta":"${secondDelta}"}`,
        '',
        'event: run.completed',
        'data: {"sequence":4}',
        '',
      ].join('\n'),
    });
  });

  void page.route(`**/v1/runs/${fixtureRunId}/artifacts/${fixtureArtifactId}*`, async (route) => {
    await json(route, {
      id: fixtureArtifactId,
      title: '流式验收产物',
      type: 'markdown',
      version: 1,
      summary: '由固定事实投影生成的产物',
      content: '# 产物正文',
      evidence: [
        { evidenceId: 'source-1', title: '来源说明', source: 'https://example.com/source' },
      ],
    });
  });

  return { complete: completeStream, getState: () => state };
}

function scenarioStatus(
  scenario: ProjectionFixtureScenario,
): 'completed' | 'completed_with_degradation' {
  return scenario === 'streaming' ? 'completed' : 'completed_with_degradation';
}

function projection(
  status: 'running' | 'completed' | 'completed_with_degradation',
  rootMessageId = fixtureUserMessageId,
  scenario: ProjectionFixtureScenario = 'streaming',
) {
  const terminal = status !== 'running';
  const degraded = scenario === 'degraded';
  const mcpMatrix = scenario === 'mcp-matrix';
  const projected = {
    runId: fixtureRunId,
    rootMessageId,
    status,
    terminal,
    mode: 'direct',
    parts: [
      {
        id: `${fixtureRunId}-activity-1`,
        runId: fixtureRunId,
        sequence: 5,
        type: 'activity',
        status:
          degraded && terminal ? 'tool.failed' : terminal ? 'tool.succeeded' : 'tool.executing',
        payload:
          degraded && terminal
            ? {
                toolId: 'web.search',
                toolCallId: 'fixture-search',
                failure: { message: 'Provider request failed (credentials redacted)' },
                server: 'web-research-provider-with-an-intentionally-long-server-name',
                revision: 'provider-revision-with-an-intentionally-long-value',
              }
            : { toolId: 'web.search', toolCallId: 'fixture-search', durationMs: 1200 },
      },
      {
        id: `${fixtureRunId}-activity-2`,
        runId: fixtureRunId,
        sequence: 6,
        type: 'activity',
        status: terminal ? 'task.succeeded' : 'task.started',
        payload: {
          taskId: 'fixture-write',
          owner: 'editor_with_a_deliberately_long_role_name',
          objective: '生成 Markdown 内容并保留部分成功结果',
          summary: '内部任务摘要不应作为展示协议',
        },
      },
      {
        id: `${fixtureRunId}-context`,
        runId: fixtureRunId,
        sequence: 7,
        type: 'context',
        status: 'context.ready',
        payload: {
          provider: 'ark',
          model: 'gpt-5.6-sol',
          manifest: {
            included: [
              { id: 'article:fixture', kind: 'article', revision: 'revision-1' },
              { id: 'skill:writing@1', kind: 'skill', revision: '1.0.0' },
            ],
            dropped: [],
            tokenCount: 220,
            maxInputTokens: 1000,
          },
        },
      },
      {
        id: `${fixtureRunId}-recovery`,
        runId: fixtureRunId,
        sequence: 8,
        type: 'recovery',
        status: degraded ? 'recovery.pending' : 'recovering',
        payload: degraded
          ? {
              reason: 'provider_timeout',
              nextAction: '等待恢复后重试',
              privateError: 'api_key=secret',
            }
          : {},
      },
      ...(degraded
        ? [
            {
              id: `${fixtureRunId}-warning`,
              runId: fixtureRunId,
              sequence: 8.5,
              type: 'warning' as const,
              status: 'run.completed_with_degradation',
              payload: {
                error: {
                  code: 'provider_error',
                  message: 'api_key=secret should never render',
                },
              },
            },
          ]
        : []),
      {
        id: `${fixtureRunId}-artifact`,
        runId: fixtureRunId,
        sequence: 9,
        type: 'artifact',
        status: 'artifact.available',
        payload: {
          artifacts: [
            {
              id: fixtureArtifactId,
              title: '流式验收产物',
              type: 'markdown',
              version: 1,
              summary: '打开查看完整内容',
            },
          ],
        },
      },
      ...(terminal
        ? [
            {
              id: `${fixtureRunId}-text`,
              runId: fixtureRunId,
              sequence: 10,
              type: 'text',
              status: 'text.completed',
              payload: {
                message: {
                  content: degraded
                    ? '# 部分完成\\n\\n已保留成功来源，失败查询待恢复。'
                    : '# 流式标题\\n\\n这是第一段。\\n\\n- 增量项目\\n- 第二个项目',
                },
              },
            },
          ]
        : []),
    ],
    artifacts: [],
    pendingDirectives: [],
    lastEventId: terminal ? 10 : 0,
    createdAt: '2026-08-04T00:00:00.000Z',
    completedAt: terminal ? '2026-08-04T00:00:03.000Z' : undefined,
  };
  return mcpMatrix ? { ...projected, parts: mcpProjectionParts(terminal) } : projected;
}

async function json(route: Route, value: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
}
