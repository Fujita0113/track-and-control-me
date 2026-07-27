import { test, expect } from '@playwright/test';

/**
 * 明日の計画ビューへの埋め込みカンバン盤面（tomorrow-plan-board / issue #67）。
 * 保留列に積んだタスクを埋め込み盤面で未着手列へドラッグ引き取りすると、明日トグル既定 ON の下で
 * 期日が翌日になることを実ブラウザで確認する（design D6: computeDue は既存エンジンをそのまま使う）。
 * 実際のマウスジェスチャによる HTML5 D&D はヘッドレス環境で不安定なため、kanban.js の実イベント
 * リスナーへ合成 DragEvent を直接ディスパッチして検証する（kanban-vertical-autoscroll.spec.ts と同じ手法）。
 */

/** 'YYYY-MM-DD' に n 日加算（UTC 計算・util.js の addDays と同じ規則）。 */
function addDays(dayKey: string, n: number): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
});

test('保留に積んだタスクを埋め込み盤面で未着手へ引き取ると、期日が明日になる（issue #67）', async ({ page, request }) => {
  const runId = Math.random().toString(36).slice(2, 8);
  const title = `面接対策${runId}`;
  const created = await (await request.post('/api/tasks', { data: { title, status: 'HOLD' } })).json();

  const { dayKey } = await (await request.get('/api/summary')).json();
  const tomorrow = addDays(dayKey, 1);

  await page.locator('#tabs button[data-target="reflection"]').click();
  await page.locator('.rf-viewtab', { hasText: '明日の計画' }).click();
  await expect(page.locator('.rf-plan')).toBeVisible();

  const holdCard = page.locator('#screen-reflection .kb-col[data-col="HOLD"] .kb-card', { hasText: title });
  await expect(holdCard).toBeVisible();
  const todoCol = page.locator('#screen-reflection .kb-col[data-col="TODO"]');

  const cardHandle = await holdCard.elementHandle();
  const todoHandle = await todoCol.elementHandle();
  if (!cardHandle || !todoHandle) throw new Error('drag handles not found');

  await page.evaluate(([card, col]) => {
    const dt = new DataTransfer();
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const rect = col.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, clientX: rect.left + 10, clientY: rect.top + 40, dataTransfer: dt };
    col.dispatchEvent(new DragEvent('dragover', opts));
    col.dispatchEvent(new DragEvent('drop', opts));
  }, [cardHandle, todoHandle]);

  await expect(page.locator('#screen-reflection .kb-col[data-col="TODO"] .kb-card', { hasText: title })).toBeVisible();
  await expect(page.locator('#screen-reflection .kb-col[data-col="HOLD"] .kb-card', { hasText: title })).toHaveCount(0);

  const tasks = await (await request.get('/api/tasks')).json();
  const updated = tasks.find((t: { id: number }) => t.id === created.id);
  expect(updated).toBeTruthy();
  expect(updated.status).toBe('TODO');
  expect(updated.due).toBe(tomorrow);

  // カンバンタブでも同じ状態になっている（本物のカンバンで裏取り・design D6）。
  await page.locator('#tabs button[data-target="kanban"]').click();
  await expect(page.locator('.kb-col[data-col="TODO"] .kb-card', { hasText: title })).toBeVisible();
});
