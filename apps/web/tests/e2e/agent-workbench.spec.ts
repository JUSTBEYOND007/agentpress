import { expect, test, type Locator, type Page } from '@playwright/test';

import { fixtureArtifactId, installAgentProjectionFixture } from './agent-projection-fixture';

const hasAuthenticatedState = Boolean(process.env.E2E_STORAGE_STATE);

test.describe('Agent workbench browser contracts', () => {
  test.skip(
    !hasAuthenticatedState,
    'Set E2E_STORAGE_STATE to an authenticated Playwright state file.',
  );

  test.beforeEach(async ({ page }, testInfo) => {
    if (testInfo.title.includes('fixture renders')) return;
    await page.goto('/');
    await openAgentWorkbench(page);
  });

  test('fixture renders streamed Markdown, consumer steps, recovery and artifact facts', async ({
    page,
  }) => {
    // The fixture is installed before navigation in this test so the browser still exercises
    // the production assistant-ui/SSE projection path without depending on personal history.
    const fixture = installAgentProjectionFixture(page);
    await page.goto('/');
    await page.evaluate(() => {
      for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
        const key = window.localStorage.key(index);
        if (key?.startsWith('agentpress:conversation-selection:')) {
          window.localStorage.removeItem(key);
        }
      }
    });
    await page.reload();
    await openAgentWorkbench(page);
    const process = page.locator('.run-process-details').first();
    await expect(process).toBeVisible();
    await expect(process).toHaveAttribute('open', '');
    await expect(process.locator('.run-process-items')).toBeVisible();
    await expect(process).toContainText('进行中');
    fixture.complete();
    await expect(page.locator('.message-markdown').last()).toContainText('流式标题');
    await expect(process).not.toHaveAttribute('open', '');
    await process.locator('summary').click();
    await expect(process.locator('.run-process-items')).toBeVisible();
    await expect(process).toContainText('搜索资料');
    await expect(process).not.toContainText('已开始');
    await expect(process).not.toContainText('结果已生成');
    await expect(page.getByRole('complementary', { name: 'Agent 工作台' })).not.toContainText(
      'gpt-5.6-sol',
    );
    await expect(page.getByRole('complementary', { name: 'Agent 工作台' })).not.toContainText(
      'revision-1',
    );
    await expect(page.getByRole('complementary', { name: 'Agent 工作台' })).not.toContainText(
      '220 token',
    );
    await expect(page.locator('.notice-part')).toContainText('正在恢复当前工作');
    const artifact = page.locator('.artifact-card').first();
    await artifact.click();
    await expect(page.getByRole('dialog', { name: '产物详情' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: '产物详情' })).toContainText('流式验收产物');
    await page.getByRole('button', { name: '关闭产物详情' }).click();
    const branchNavigator = page.getByRole('navigation', { name: '对话分支' });
    await expect(branchNavigator).toContainText('1/2');
    await branchNavigator.getByRole('button', { name: '下一个分支' }).press('ArrowRight');
    await expect(branchNavigator).toContainText('2/2');
    await expect(page.locator('.aui-user-message')).toHaveCount(1);
    await expect(page.locator('.aui-assistant-message')).toHaveCount(1);
    await page.reload();
    await openAgentWorkbench(page);
    await expect(page.getByRole('navigation', { name: '对话分支' })).toContainText('2/2');
    await expect(page.locator('.aui-user-message')).toHaveCount(1);
    await expect(page.locator('.aui-assistant-message')).toHaveCount(1);
    expect(fixture.getState()).toBe('completed');
    expect(fixtureArtifactId).toMatch(/[a-f0-9-]{36}/u);
  });

  test('fixture renders degraded completion with sanitized failure and recovery facts', async ({
    page,
  }) => {
    const fixture = installAgentProjectionFixture(page, 'degraded');
    await page.goto('/');
    await page.evaluate(() => {
      for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
        const key = window.localStorage.key(index);
        if (key?.startsWith('agentpress:conversation-selection:')) {
          window.localStorage.removeItem(key);
        }
      }
    });
    await page.reload();
    await openAgentWorkbench(page);
    fixture.complete();
    await expect(page.locator('.message-markdown').last()).toContainText('部分完成');
    await expect(
      page.locator('.notice-part').filter({ hasText: '已完成，但部分步骤出现警告' }),
    ).toBeVisible();
    await expect(page.locator('.run-part.activity-part')).toContainText('搜索资料');
    await expect(page.locator('.agent-panel')).not.toContainText('api_key=secret');
    await expect(page.locator('.agent-panel')).not.toContainText('credentials redacted');
    await expect(page.locator('.message-markdown').last()).toContainText('失败查询待恢复');
    expect(fixture.getState()).toBe('completed');
  });

  test('keeps conversation drafts isolated while switching', async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'Conversation behavior only needs one browser profile.',
    );

    const picker = page.locator('.conversation-picker > button');
    await picker.click();
    const choices = page.locator('.conversation-list > button');
    expect(await choices.count()).toBeGreaterThan(1);

    const firstTitle = (
      await choices.nth(0).locator('.conversation-item-title > span').innerText()
    ).trim();
    const secondTitle = (
      await choices.nth(1).locator('.conversation-item-title > span').innerText()
    ).trim();
    expect(firstTitle).not.toBe(secondTitle);
    await choices.nth(0).click();

    const composer = page.getByRole('textbox', { name: '发送消息给写作助手' });
    const firstDraft = `e2e-first-${Date.now()}`;
    const secondDraft = `e2e-second-${Date.now()}`;
    await composer.fill('');
    await composer.fill(firstDraft);

    await picker.click();
    await page.locator('.conversation-list > button').filter({ hasText: secondTitle }).click();
    await composer.fill('');
    await composer.fill(secondDraft);

    await picker.click();
    await page.locator('.conversation-list > button').filter({ hasText: firstTitle }).click();
    await expect(composer).toHaveValue(firstDraft);

    await picker.click();
    await page.locator('.conversation-list > button').filter({ hasText: secondTitle }).click();
    await expect(composer).toHaveValue(secondDraft);
    await composer.fill('');
    await picker.click();
    await page.locator('.conversation-list > button').filter({ hasText: firstTitle }).click();
    await composer.fill('');
  });

  test('preserves reading position when completed process expands', async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'Scrolling behavior only needs one browser profile.',
    );

    const timeline = page.locator('.run-process-details').first();
    test.skip(
      (await timeline.count()) === 0,
      'The authenticated fixture has no persisted process details.',
    );
    const viewport = page.locator('.agent-thread');
    await timeline.scrollIntoViewIfNeeded();
    await viewport.evaluate((node) => {
      node.scrollTop = Math.max(0, node.scrollTop - 80);
    });
    const before = await viewport.evaluate((node) => node.scrollTop);
    await timeline.locator('summary').click();
    const after = await viewport.evaluate((node) => node.scrollTop);
    expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
    await expect(timeline.locator('.run-process-items')).toBeVisible();

    await viewport.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect(page.getByRole('button', { name: '滚动到底部' })).toBeHidden();
    await timeline.locator('summary').click();
    const pinned = await viewport.evaluate(
      (node) => Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop) <= 2,
    );
    expect(pinned).toBe(true);
  });

  test('contains Markdown, consumer process, and workbench layout at desktop and mobile widths', async ({
    page,
  }, testInfo) => {
    const panel = page.getByRole('complementary', { name: 'Agent 工作台' });
    await expect(panel).toBeVisible();
    const geometry = await page.evaluate(() => {
      const body = document.body;
      const panelElement = document.querySelector<HTMLElement>('.agent-panel');
      const thread = document.querySelector<HTMLElement>('.agent-thread');
      const composer = document.querySelector<HTMLElement>('.composer-shell');
      return {
        bodyClientWidth: body.clientWidth,
        bodyScrollWidth: body.scrollWidth,
        panelWidth: panelElement?.getBoundingClientRect().width ?? 0,
        panelScrollWidth: panelElement?.scrollWidth ?? 0,
        threadWidth: thread?.getBoundingClientRect().width ?? 0,
        threadScrollWidth: thread?.scrollWidth ?? 0,
        composerWidth: composer?.getBoundingClientRect().width ?? 0,
      };
    });
    expect(geometry.bodyScrollWidth).toBeLessThanOrEqual(geometry.bodyClientWidth);
    expect(geometry.panelScrollWidth).toBeLessThanOrEqual(Math.ceil(geometry.panelWidth));
    expect(geometry.threadScrollWidth).toBeLessThanOrEqual(Math.ceil(geometry.threadWidth));
    expect(geometry.composerWidth).toBeLessThanOrEqual(Math.ceil(geometry.panelWidth));

    const markdown = page.locator('.message-markdown').first();
    if ((await markdown.count()) > 0) {
      await expect(markdown).toBeVisible();
      await assertContained(markdown, panel);
    }

    const process = page.locator('.run-process-details').first();
    if ((await process.count()) > 0) {
      await process.locator('summary').click();
      await expect(process).toHaveAttribute('open', '');
      await assertContained(process, panel);
    }

    const screenshotName =
      testInfo.project.name === 'mobile' ? 'agent-mobile-e2e.png' : 'agent-desktop-e2e.png';
    await page.screenshot({ path: testInfo.outputPath(screenshotName), fullPage: true });
  });

  test('supports keyboard branch navigation when persisted sibling branches exist', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'Branch behavior only needs one browser profile.',
    );
    const navigator = page.getByRole('navigation', { name: '对话分支' });
    test.skip((await navigator.count()) === 0, 'The authenticated fixture has no sibling branch.');
    const before = (await navigator.textContent())?.trim();
    await navigator.focus();
    const next = navigator.getByRole('button', { name: '下一个分支' });
    const previous = navigator.getByRole('button', { name: '上一个分支' });
    if (await next.isEnabled()) await navigator.press('ArrowRight');
    else await navigator.press('ArrowLeft');
    await expect(navigator).not.toHaveText(before ?? '');
    await expect(next.or(previous)).toBeVisible();
  });
});

async function openAgentWorkbench(page: Page): Promise<void> {
  const panel = page.getByRole('complementary', { name: 'Agent 工作台' });
  if (await panel.isVisible()) return;
  const openButton = page.getByRole('button', { name: /写作助手/u });
  await expect(openButton).toBeVisible();
  await openButton.click();
  await expect(panel).toBeVisible();
}

async function assertContained(child: Locator, parent: Locator): Promise<void> {
  const [childBox, parentBox] = await Promise.all([child.boundingBox(), parent.boundingBox()]);
  expect(childBox).not.toBeNull();
  expect(parentBox).not.toBeNull();
  if (!childBox || !parentBox) return;
  expect(childBox.x).toBeGreaterThanOrEqual(parentBox.x - 1);
  expect(childBox.x + childBox.width).toBeLessThanOrEqual(parentBox.x + parentBox.width + 1);
}
