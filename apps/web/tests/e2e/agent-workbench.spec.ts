import { expect, test, type Locator, type Page } from '@playwright/test';

const hasAuthenticatedState = Boolean(process.env.E2E_STORAGE_STATE);

test.describe('Agent workbench browser contracts', () => {
  test.skip(
    !hasAuthenticatedState,
    'Set E2E_STORAGE_STATE to an authenticated Playwright state file.',
  );

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await openAgentWorkbench(page);
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

  test('preserves reading position when a completed execution timeline expands', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'Scrolling behavior only needs one browser profile.',
    );

    const timeline = page.locator('.execution-timeline').first();
    test.skip(
      (await timeline.count()) === 0,
      'The authenticated fixture has no persisted tool timeline.',
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
    await expect(timeline.locator('ol')).toBeVisible();

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

  test('contains Markdown, context, and workbench layout at desktop and mobile widths', async ({
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

    const context = page.locator('.run-context-sources').first();
    if ((await context.count()) > 0) {
      await context.locator('summary').click();
      await expect(context).toHaveAttribute('open', '');
      await assertContained(context, panel);
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
