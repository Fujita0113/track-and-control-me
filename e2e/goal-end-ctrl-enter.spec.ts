import { test, expect, type APIRequestContext } from '@playwright/test';
import { thirtyDayEnd } from './goal-input.js';

/**
 * 「目標を終える」モーダルの Ctrl+Enter 送信 E2E（issue #78 / enter-submit-ime-guard）。
 */

async function seedGoal(request: APIRequestContext, name: string, dayKey: string): Promise<number> {
  const res = await request.post('/api/goals', {
    data: {
      name,
      purpose: 'テスト用',
      startReason: 'e2e のため',
      start: 'today',
      endDay: thirtyDayEnd(dayKey),
      rules: [{ target: 'MANUAL_CHECK', label: '素振り', startDay: dayKey, endDay: null, reason: '毎日やる' }],
    },
  });
  expect(res.ok()).toBeTruthy();
  const { id } = (await res.json()) as { id: number };
  return id;
}

test('「目標を終える」モーダルで理由入力後に Ctrl+Enter で送信できる', async ({ page, request }) => {
  const { dayKey } = await (await request.get('/api/summary')).json();
  const goalName = 'Ctrl+Enterで終える目標';
  await seedGoal(request, goalName, dayKey);

  await page.goto('/');
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});

  // 目標タブを開く
  await page.locator('#tabs button[data-target="goals"]').click();
  await expect(page.locator('#screen-goals')).toBeVisible();

  // 目標カード内の「終える」ボタンをクリック
  await page.getByRole('button', { name: '終える' }).first().click();
  await expect(page.locator('#modal-root')).toHaveClass(/open/);

  // 理由テキストエリアに入力
  const reasonInp = page.locator('#modal-root textarea.gr-end-reason-input');
  await expect(reasonInp).toBeVisible();
  await reasonInp.fill('他の目標に集中するため');

  // Ctrl+Enter を押す
  await reasonInp.press('Control+Enter');

  // モーダルが閉じて「目標を終えました」トーストが表示される
  await expect(page.locator('#modal-root')).not.toHaveClass(/open/);
  await expect(page.locator('.toast-ok')).toContainText('目標を終えました');
});
