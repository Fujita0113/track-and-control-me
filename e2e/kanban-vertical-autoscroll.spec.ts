import { test, expect } from '@playwright/test';

/**
 * かんばんの縦自動スクロール(kanban-vertical-autoscroll / issue #34)。
 * 未着手に大量のタスクを積んでページを下へスクロールした状態(進行中列はビューポート
 * 上端より上へスクロールアウトしている)から、カードをドラッグしてビューポート上端
 * 近傍へポインタを寄せると、ページが自動的に上へスクロールして進行中列が現れ、
 * そこへドロップできることを実ブラウザで確認する。
 * 実際のマウスジェスチャによる HTML5 D&D はヘッドレス環境で不安定なため
 * (kanban-restore.spec.ts が完了操作の D&D を避けているのと同じ理由)、
 * kanban.js の実イベントリスナーへ合成 DragEvent を直接ディスパッチして検証する。
 */

async function seedTodoTask(request: import('@playwright/test').APIRequestContext, title: string) {
  const created = await request.post('/api/tasks', { data: { title, status: 'TODO' } });
  return created.json();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
});

test('未着手が積み上がりスクロールした状態でも上端近傍ドラッグで自動スクロールし進行中へドロップできる（issue #34）', async ({ page }) => {
  // タイトルにランダム接尾辞を付け、リトライで前回シードと重複しないようにする。
  const runId = Math.random().toString(36).slice(2, 8);
  for (let i = 0; i < 40; i++) {
    await seedTodoTask(page.request, `積み上げタスク${runId}-${i}`);
  }
  const target = await seedTodoTask(page.request, `深い位置のタスク${runId}`);

  await page.locator('#tabs button[data-target="kanban"]').click();
  await expect(page.locator('.kb')).toBeVisible();

  const targetCard = page.locator('.kb-card', { hasText: target.title });
  await targetCard.scrollIntoViewIfNeeded();

  const doingCol = page.locator('.kb-col[data-col="DOING"]');
  const doingBoxBefore = await doingCol.boundingBox();
  expect(doingBoxBefore).not.toBeNull();
  // 前提条件: 進行中列がビューポート上端より上へスクロールアウトしている。
  expect(doingBoxBefore!.y + doingBoxBefore!.height).toBeLessThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  const cardHandle = await targetCard.elementHandle();
  const doingHandle = await doingCol.elementHandle();
  if (!cardHandle || !doingHandle) throw new Error('drag handles not found');

  // dragstart → ビューポート上端近傍(clientY=10)で dragover。以降は kanban.js 内の
  // requestAnimationFrame ループが自走してページを上へスクロールし続ける。
  await page.evaluate(([card]) => {
    const dt = new DataTransfer();
    (window as any).__kbTestDT = dt;
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    document.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: 200, clientY: 10, dataTransfer: dt }));
  }, [cardHandle]);

  await page.waitForFunction(() => window.scrollY <= 0, undefined, { timeout: 5000 });

  const doingBoxAfter = await doingCol.boundingBox();
  expect(doingBoxAfter).not.toBeNull();
  expect(doingBoxAfter!.y).toBeGreaterThanOrEqual(0);

  // 現れた進行中列へドロップ。
  await page.evaluate(([doingColEl]) => {
    const dt = (window as any).__kbTestDT as DataTransfer;
    const rect = doingColEl.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, clientX: rect.left + 10, clientY: rect.top + 20, dataTransfer: dt };
    doingColEl.dispatchEvent(new DragEvent('dragover', opts));
    doingColEl.dispatchEvent(new DragEvent('drop', opts));
  }, [doingHandle]);

  await expect(page.locator('.kb-col[data-col="DOING"] .kb-card', { hasText: target.title })).toHaveCount(1);
  await expect(page.locator('.kb-col[data-col="TODO"] .kb-card', { hasText: target.title })).toHaveCount(0);
});
