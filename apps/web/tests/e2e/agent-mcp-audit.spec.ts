import { expect, test, type Page } from '@playwright/test';

import { installAgentProjectionFixture } from './agent-projection-fixture';

test.describe('MCP consumer projection', () => {
  test.skip(
    !process.env.E2E_STORAGE_STATE,
    'Set E2E_STORAGE_STATE to an authenticated Playwright state file.',
  );

  test('shows bounded audit facts and redacts transport diagnostics', async ({ page }) => {
    const fixture = installAgentProjectionFixture(page, 'mcp-matrix');
    await page.goto('/');
    await clearConversationSelection(page);
    await page.reload();
    await openAgentWorkbench(page);

    fixture.complete();
    await expect(page.locator('.message-markdown').last()).toContainText('MCP 失败矩阵已完成');
    const panel = page.getByRole('complementary', { name: 'Agent 工作台' });
    const process = panel.locator('.run-process-details').first();
    await expect(process).toBeVisible();
    await process.locator('.run-process-heading').click();
    await expect(process.locator('.run-process-items')).toBeVisible();
    await expect(process).toContainText('搜索资料');
    await expect(panel.locator('.activity-part')).toContainText('导入素材');
    await expect(panel.locator('.notice-part')).toContainText('工具结果暂时无法确认');

    const audit = process.locator('.tool-audit-details').first();
    await expect(audit).not.toHaveAttribute('open', '');
    await audit.locator('summary').click();
    await expect(audit).toContainText(
      'web_research_server_with_a_deliberately_long_but_bounded_identifier',
    );
    await expect(audit).toContainText('search_sources_with_a_deliberately_long_but_bounded_name');
    await expect(audit).toContainText('任务尝试');
    await expect(audit).toContainText('3');
    await expect(audit).toContainText('主要资料来源');
    await expect(audit).toContainText('2 次重试，1 次重连');

    for (const secret of [
      'credential-secret-query',
      'browser-secret',
      'browser-private-thinking',
      'rate-limit-secret',
      '/private/mcp-provider.ts',
      'tools/call',
      'oversized-provider-output',
      'connection_lost_after_dispatch',
    ]) {
      await expect(panel).not.toContainText(secret);
    }
    expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    expect(await audit.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  });
});

async function clearConversationSelection(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith('agentpress:conversation-selection:'))
        window.localStorage.removeItem(key);
    }
  });
}

async function openAgentWorkbench(page: Page): Promise<void> {
  const panel = page.getByRole('complementary', { name: 'Agent 工作台' });
  if (await panel.isVisible()) return;
  const openButton = page.getByRole('button', { name: /写作助手/u });
  await expect(openButton).toBeVisible();
  await openButton.click();
  await expect(panel).toBeVisible();
}
