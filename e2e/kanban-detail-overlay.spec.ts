import { test, expect } from './fixtures.js';

/**
 * 独立カンバンタブの detail オーバーレイ e2e（kanban-detail-overlay / issue #92）。
 * カードを開くとオーバーレイが画面の大部分を占有して表示され、余白クリックで閉じて
 * ボード操作に戻ることを確認する。
 */

async function seedTask(
  request: import('@playwright/test').APIRequestContext,
  title: string,
  extra: Record<string, unknown> = {},
) {
  const created = await request.post('/api/tasks', { data: { title, status: 'TODO', ...extra } });
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

test('ノートが長いとき、スクロールするとタイトル・優先度・期限もノートと一緒に動く（issue #92 2巡目コメント）', async ({ page }) => {
  const title = `スクロール一体e2eタスク${Date.now()}`;
  const notes = Array.from({ length: 80 }, (_, i) => `本文行${i + 1}`).join('\n');
  await seedTask(page.request, title, { notes });
  await page.reload();
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 2000 }).catch(() => {});
  await page.locator('#tabs button[data-target="kanban"]').click();

  await page.locator('.kb-card', { hasText: title }).click();
  const panel = page.locator('.kb-detail-overlay .kb-detail');
  await expect(panel).toBeVisible();

  const titleField = page.locator('.kb-detail-title');
  const before = await titleField.boundingBox();
  expect(before).not.toBeNull();

  await panel.evaluate((el) => { el.scrollTop = 600; });
  await expect.poll(async () => {
    const box = await titleField.boundingBox();
    return box ? box.y : null;
  }).toBeLessThan(before!.y);
});

test('未入力のノート欄はフォーカスした時点でプレースホルダーが隠れ、離れると戻る（issue #92 2巡目コメント）', async ({ page }) => {
  const title = `プレースホルダーe2eタスク${Date.now()}`;
  await seedTask(page.request, title);
  await page.reload();
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 2000 }).catch(() => {});
  await page.locator('#tabs button[data-target="kanban"]').click();

  await page.locator('.kb-card', { hasText: title }).click();
  const ph = page.locator('.kb-detail-overlay .kb-detail-body .rf-ph');

  // 未入力タスクを開くと既存挙動でノート欄が自動フォーカスされる（issue #85）ため、
  // まずタイトル欄をクリックしてフォーカスを外し「未フォーカス・未入力」の基準状態を作る。
  await page.locator('.kb-detail-title').click();
  await expect(ph).toBeVisible();

  await page.locator('.kb-detail-overlay .kb-detail-body .rf-ed').click();
  await expect(ph).toBeHidden();

  await page.locator('.kb-detail-title').click();
  await expect(ph).toBeVisible();
});
