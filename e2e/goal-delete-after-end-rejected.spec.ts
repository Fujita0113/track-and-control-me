import { test, expect } from './fixtures.js';
import type { APIRequestContext } from '@playwright/test';
import { thirtyDayEnd } from './goal-input.js';

/**
 * issue #86 の調査で見つかったギャップ: 作成当日中に「終える」で終了した目標は、
 * 削除可能ウィンドウ（作成当日）内であっても削除を拒否しなければならない
 * （spec: goal-challenge「削除は作成当日のみ、かつ終了済みは対象外」）。
 * UI の削除ボタンは status='ended' で既に非表示になる（goals.js:264）ため、
 * ここではサーバー側のガードを直接 API 経由で確認する。
 */

const GOAL_NAME = '当日終了後の削除拒否確認用目標';

async function seedGoal(request: APIRequestContext, dayKey: string): Promise<number> {
  const res = await request.post('/api/goals', {
    data: {
      name: GOAL_NAME,
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

test('作成当日に目標を終える→同日中に削除しようとすると拒否され、目標が残る', async ({ page, request }) => {
  const { dayKey } = await (await request.get('/api/summary')).json();
  const goalId = await seedGoal(request, dayKey);

  await page.goto('/');
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
  await page.locator('#tabs button[data-target="goals"]').click();

  const card = page.locator('.gr-goal-card', { hasText: GOAL_NAME });
  await expect(card).toBeVisible();

  // UI から「終える」（作成当日中）。
  await card.getByRole('button', { name: '終える' }).click();
  await expect(page.locator('#modal-root')).toHaveClass(/open/);
  await page.locator('#modal-root textarea.gr-end-reason-input').fill('e2e: 同日中に終了させる');
  await page.locator('#modal-root').getByRole('button', { name: 'この目標を終える' }).click();
  await expect(page.locator('.toast-ok')).toContainText('目標を終えました');

  // ステータスが「終了」になり、UI の削除ボタンは既に出ない（goals.js:264 の既存ガード）。
  const endedCard = page.locator('.gr-goal-card', { hasText: GOAL_NAME });
  await expect(endedCard.locator('.badge', { hasText: '終了' })).toBeVisible();
  await expect(endedCard.getByRole('button', { name: '削除' })).toHaveCount(0);

  // サーバー側も、作成当日の削除可能ウィンドウ内であっても終了済みは拒否する。
  const delRes = await request.delete(`/api/goals/${goalId}`);
  expect(delRes.status()).toBe(409);
  const body = await delRes.json();
  expect(body.error).toBe('終了した目標は削除できません');

  // 目標は残っている。
  await page.reload();
  await page.locator('#tabs button[data-target="goals"]').click();
  await expect(page.locator('.gr-goal-card', { hasText: GOAL_NAME })).toBeVisible();
});
