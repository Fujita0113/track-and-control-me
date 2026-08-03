import { test, expect } from './fixtures.js';

/**
 * 明日の計画ビュー: 右サイドバーへ供給する詳細とアクティビティログ（tomorrow-plan-board / issue #67）。
 * カードを選ぶと右サイドバーが「詳細」タブへ自動で切り替わり、そこの既存カレンダー式ピッカーで
 * 期限を変えると盤面のカードへ反映されることを実ブラウザで確認する（design D5: 別ピッカーは新設しない）。
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
});

test('カードを選ぶと右サイドバーが詳細へ切り替わり、そこで期限を変えると盤面のカードへ反映される', async ({ page, request }) => {
  const runId = Math.random().toString(36).slice(2, 8);
  const title = `レビュー確認${runId}`;
  const created = await (await request.post('/api/tasks', { data: { title, status: 'TODO' } })).json();
  const { dayKey } = await (await request.get('/api/summary')).json();

  await page.locator('#tabs button[data-target="reflection"]').click();
  await page.locator('.rf-viewtab', { hasText: '明日の計画' }).click();

  // 未選択状態では詳細タブに「カードを選ぶと…」のプレースホルダが出ている。
  await page.locator('.rf-sb-tab', { hasText: '詳細' }).click();
  await expect(page.locator('.rf-sb-pane[data-pane="detail"] .kb-aside-empty')).toBeVisible();

  const card = page.locator('#screen-reflection .kb-col[data-col="TODO"] .kb-card', { hasText: title });
  await expect(card).toBeVisible();
  await card.click();

  // カード選択で右サイドバーが自動的に詳細タブへ切り替わる。
  await expect(page.locator('.rf-sb-tab.active')).toHaveText('詳細');
  const detailPane = page.locator('.rf-sb-pane[data-pane="detail"]');
  await expect(detailPane).toHaveClass(/active/);
  await expect(detailPane.locator('textarea.kb-detail-title')).toHaveValue(title);

  // 詳細タブの既存カレンダー式ピッカーで「今日」を選ぶ。
  await detailPane.locator('.kb-due-btn').click();
  await detailPane.locator('.kb-cal-quick', { hasText: '今日' }).click();

  // 盤面のカードへ反映される（手動指定はロックされ 🔒 が付く）。
  await expect(card.locator('.kb-due')).toHaveText('今日 🔒');

  const tasks = await (await request.get('/api/tasks')).json();
  const updated = tasks.find((t: { id: number }) => t.id === created.id);
  expect(updated.due).toBe(dayKey);

  // 本文タブへ戻って段取りを読み直せる（design: カード選択中も本文へ戻せる）。
  await page.locator('.rf-sb-tab', { hasText: '本文' }).click();
  await expect(page.locator('.rf-sb-pane[data-pane="journal"]')).toHaveClass(/active/);
});

test('アクティビティログの上に本日達成したタスクの件数が表示される（issue #67 フィードバック）', async ({ page, request }) => {
  const runId = Math.random().toString(36).slice(2, 8);
  const doneTitle = `完了済み${runId}`;
  const created = await (await request.post('/api/tasks', { data: { title: doneTitle, status: 'DOING' } })).json();
  await request.patch(`/api/tasks/${created.id}`, { data: { status: 'DONE' } });

  await page.locator('#tabs button[data-target="reflection"]').click();
  await page.locator('.rf-viewtab', { hasText: '明日の計画' }).click();
  await page.locator('.rf-sb-tab', { hasText: 'ログ' }).click();

  const logPane = page.locator('.rf-sb-pane[data-pane="log"]');
  await expect(logPane.locator('.kb-panel-title', { hasText: '本日の進捗' })).toBeVisible();
  await expect(logPane.locator('.kb-log-row', { hasText: doneTitle })).toBeVisible();
});
