import { test, expect } from './fixtures.js';
import type { APIRequestContext } from '@playwright/test';
import { addDaysKey, thirtyDayEnd } from './goal-input.js';

/**
 * 一時凍結の統合フロー（spec: goal-freeze MODIFIED・issue #103）。
 *
 * 「当日凍結」「期間凍結」の2種別と予約フェーズを廃止し、常に当日発効・終了日自由指定の
 * 単一凍結へ統合した。ここで踏むのは実ブラウザで成立する筋:
 *
 *   モーダルに種別選択が無い（理由→終了日→対象選択の3ステップ）
 *   → 予約したその場で当日のゲートから外れる（同日内で完結・日付を跨がない）
 *   → 月枠はアプリ全体で共有（別目標の凍結が409で拒否される）
 *   → 延長・解除ができ、解除した当日からゲートに戻る
 */

const GOAL_A_NAME = '統合凍結フローA';
const GOAL_B_NAME = '統合凍結フローB';
const CHECK_LABEL = '統合凍結の素振り';

async function seedGoal(request: APIRequestContext, dayKey: string, name: string): Promise<number> {
  const res = await request.post('/api/goals', {
    data: {
      name,
      purpose: 'テスト用',
      startReason: 'e2e のため',
      start: 'today',
      endDay: thirtyDayEnd(dayKey),
      rules: [{ target: 'MANUAL_CHECK', label: CHECK_LABEL, startDay: dayKey, endDay: null, reason: '毎日やる' }],
    },
  });
  expect(res.ok()).toBeTruthy();
  const { id } = (await res.json()) as { id: number };
  return id;
}

test('種別選択の無い一時凍結モーダルから当日発効・月枠共有・延長・解除の一連が成立する', async ({ page, request }) => {
  const { dayKey } = await (await request.get('/api/summary')).json();
  const goalAId = await seedGoal(request, dayKey, GOAL_A_NAME);
  const goalBId = await seedGoal(request, dayKey, GOAL_B_NAME);

  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});

    // --- 1. 今日タブ: 凍結前はルールがゲートに現れる（前提）------------------------------
    await page.locator('#tabs button[data-target="today"]').click();
    await expect(page.locator('.cond', { hasText: CHECK_LABEL }).first()).toBeVisible();

    // --- 2. 振り返りタブ: 一時凍結モーダルを開く。種別選択のステップが無いことを確認 --------
    await page.locator('#tabs button[data-target="reflection"]').click();
    const freezeBtn = page.getByRole('button', { name: '❄ 一時凍結する' });
    await expect(freezeBtn).toBeVisible();
    await freezeBtn.click();

    const freezeModal = page.locator('.modal-panel', { has: page.locator('h3', { hasText: '目標を一時凍結する' }) });
    await expect(freezeModal).toBeVisible();
    // 統合後は「理由 → 終了日 → 対象選択」の3ステップのみ（旧「凍結のしかたを選ぶ」ステップは無い）。
    await expect(freezeModal.getByText('1. 凍結する理由（必須）')).toBeVisible();
    await expect(freezeModal.getByText('2. 凍結終了日')).toBeVisible();
    await expect(freezeModal.getByText('3. 対象の目標を選択')).toBeVisible();
    await expect(freezeModal.getByText('凍結のしかたを選ぶ')).toHaveCount(0);
    await expect(freezeModal.getByText('今日1日だけ')).toHaveCount(0);
    await expect(freezeModal.getByText('期間を指定して翌日から')).toHaveCount(0);

    // --- 3. 理由＋終了日（数日先）を入力して決定 → 予約したその場で当日発効 ------------------
    await freezeModal.locator('textarea').fill('急な差し込み案件に集中する');
    await freezeModal.locator('input[type=date]').fill(addDaysKey(dayKey, 3));
    await freezeModal.getByRole('button', { name: '一時凍結する（当日発効）' }).click();
    await expect(page.locator('.toast-ok')).toContainText('一時凍結しました');

    // --- 4. 同日内でゲートから外れる（日付を跨がない・design D1 の核心）----------------------
    await page.locator('#tabs button[data-target="today"]').click();
    await expect(page.locator('.cond', { hasText: CHECK_LABEL })).toHaveCount(0);

    // --- 5. 月枠はアプリ全体で共有（別目標の凍結は 409 で拒否される）------------------------
    const secondFreeze = await request.post(`/api/goals/${goalBId}/freeze`, {
      data: { endDay: addDaysKey(dayKey, 1), reason: '別件' },
    });
    expect(secondFreeze.status()).toBe(409);

    // --- 6. 振り返りタブ: 延長できる ------------------------------------------------------
    await page.locator('#tabs button[data-target="reflection"]').click();
    const frozenBlock = page.locator('.gf-block.gf-frozen').first();
    await expect(frozenBlock).toBeVisible();
    await frozenBlock.getByRole('button', { name: '延長', exact: true }).click();
    const extendForm = frozenBlock.locator('.gf-form');
    await extendForm.locator('input[type=date]').fill(addDaysKey(dayKey, 5));
    await extendForm.locator('textarea').fill('まだ終わらない');
    await extendForm.getByRole('button', { name: '延長を確定' }).click();
    await expect(page.locator('.toast-ok')).toContainText('凍結を延長しました');

    // --- 7. 解除すると当日からゲートに戻る -------------------------------------------------
    page.once('dialog', (d) => d.accept());
    await page.locator('.gf-block.gf-frozen').first().getByRole('button', { name: '解除', exact: true }).click();
    await expect(page.locator('.toast-ok')).toContainText('凍結を解除しました');

    await page.locator('#tabs button[data-target="today"]').click();
    await expect(page.locator('.cond', { hasText: CHECK_LABEL }).first()).toBeVisible();
  } finally {
    await request.delete(`/api/goals/${goalAId}`).catch(() => {});
    await request.delete(`/api/goals/${goalBId}`).catch(() => {});
  }
});
