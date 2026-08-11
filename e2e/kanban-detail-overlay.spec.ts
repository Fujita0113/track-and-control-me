import { test, expect } from './fixtures.js';

/**
 * 独立カンバンタブの detail オーバーレイ e2e（kanban-detail-overlay / issue #92）。
 * カードを開くとオーバーレイが画面の大部分を占有して表示され、余白クリックで閉じて
 * ボード操作に戻ることを確認する。
 */

async function seedTask(request: import('@playwright/test').APIRequestContext, title: string) {
  const created = await request.post('/api/tasks', { data: { title, status: 'TODO' } });
  const { id } = await created.json();
  return id;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
  await page.locator('#tabs button[data-target="kanban"]').click();
  await expect(page.locator('.kb')).toBeVisible();
});

test('カードを開く→オーバーレイが画面の大部分を占有して表示される→余白クリックで閉じてボード操作に戻る', async ({ page }) => {
  const title = `オーバーレイe2eタスク${Date.now()}`;
  await seedTask(page.request, title);
  await page.reload();
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 2000 }).catch(() => {});
  await page.locator('#tabs button[data-target="kanban"]').click();

  await page.locator('.kb-card', { hasText: title }).click();
  const overlay = page.locator('.kb-detail-overlay');
  await expect(overlay).toBeVisible();

  // 画面の大部分（過半）を占有していることを確認する。
  const panelBox = await page.locator('.kb-detail-overlay .kb-detail').boundingBox();
  const viewport = page.viewportSize();
  expect(panelBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(panelBox!.width / viewport!.width).toBeGreaterThan(0.5);

  // パネル内クリックでは閉じない。
  await page.locator('.kb-detail-title').click();
  await expect(overlay).toBeVisible();

  // 余白（スクリム）クリックで閉じ、ボード操作に戻る。
  await overlay.click({ position: { x: 5, y: 5 } });
  await expect(overlay).toHaveCount(0);
  await expect(page.locator('.kb-card', { hasText: title })).toBeVisible();
});
