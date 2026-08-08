import { test, expect } from './fixtures.js';
import type { APIRequestContext } from '@playwright/test';
import { thirtyDayEnd } from './goal-input.js';

/**
 * 当日凍結の通しフロー（spec: goal-freeze ADDED「当日発効の凍結は『今日1日だけ』」）。
 *
 * 「明日の面接に持っていく課題を今夜潰さないと間に合わない」——今夜ノルマを外す正当な事情のための
 * 手段が当日凍結で、翌日発効の期間凍結（`goal-freeze-reserve-flow.spec.ts`）と対になる:
 *
 *   期間凍結: 翌日から効く / 期限が凍結日数ぶん延びる / 期間を指定する
 *   当日凍結: **今日から効く** / 期限は延びない / 今日1日だけ
 *
 * ここで踏むのは1日で完結する筋だけ（実ブラウザでは日付を跨げない・既存 e2e と同じ方針）。
 * 「期限が延びない」「翌日には解ける」といった日を跨ぐ性質は `goal-same-day-freeze.test.ts` が固める。
 */

const GOAL_A = '当日凍結する目標';
const GOAL_B = '当日凍結しない目標';
const CHECK_A = '当日凍結の素振り';
const CHECK_B = '当日凍結しない腹筋';
const REASON = '明日の面接に持っていく課題を今夜潰す';

async function seedGoal(request: APIRequestContext, name: string, checkLabel: string, dayKey: string): Promise<number> {
  const res = await request.post('/api/goals', {
    data: {
      name,
      purpose: 'テスト用',
      startReason: 'e2e のため',
      start: 'today',
      endDay: thirtyDayEnd(dayKey),
      rules: [{ target: 'MANUAL_CHECK', label: checkLabel, startDay: dayKey, endDay: null, reason: '毎日やる' }],
    },
  });
  expect(res.ok()).toBeTruthy();
  const { id } = (await res.json()) as { id: number };
  return id;
}

test('当日凍結すると今日のゲートからその場で外れ、月枠は期間凍結と共有される', async ({ page, request }) => {
  const { dayKey } = await (await request.get('/api/summary')).json();

  const goalIdA = await seedGoal(request, GOAL_A, CHECK_A, dayKey);
  const goalIdB = await seedGoal(request, GOAL_B, CHECK_B, dayKey);
  // 未達成のルールは今日タブの解錠ゲート（アプリ全体で1つの共有状態）を塞ぐので、
  // 後始末で必ず目標ごと消す（goal_freeze は CASCADE で消えるため月枠も戻る・issue #75 と同じ配慮）。
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});

    // --- 1. 今日タブ: 凍結前は両方のルールがゲートに現れる（前提の確認）-----------------
    await page.locator('#tabs button[data-target="today"]').click();
    await expect(page.locator('.cond', { hasText: CHECK_A }).first()).toBeVisible();
    await expect(page.locator('.cond', { hasText: CHECK_B }).first()).toBeVisible();

    // --- 2. 振り返りタブ: モーダルで種別「今日1日だけ」を選ぶ ---------------------------
    await page.locator('#tabs button[data-target="reflection"]').click();
    const sharedFreeze = page.locator('#rf-freeze-shared');
    const triggerBtn = sharedFreeze.getByRole('button', { name: /一時凍結する/ }).first();
    await triggerBtn.scrollIntoViewIfNeeded();
    await triggerBtn.click();

    const modal = page.locator('.modal-root').filter({ hasText: '目標を一時凍結する' });
    // 既定は期間凍結（翌日発効）なので、初期状態では期限入力が出ている（design D10）。
    await expect(modal.locator('.gf-enddate-field')).toBeVisible();
    await expect(modal.getByRole('button', { name: /一時凍結を予約/ })).toBeVisible();

    await modal.locator('.gf-kind-btn[data-kind="same_day"]').click();
    // 当日凍結は期間を持たないので、期限の入力欄を出してはならない（spec: goal-freeze MODIFIED）。
    await expect(modal.locator('.gf-enddate-field')).toBeHidden();

    // 対象は目標Aだけ。理由は必須。
    await modal.locator('label', { hasText: GOAL_A }).locator('input[type="checkbox"]').check();
    await modal.locator('label', { hasText: GOAL_B }).locator('input[type="checkbox"]').uncheck();
    await modal.locator('textarea').fill(REASON);
    await modal.getByRole('button', { name: '今日1日だけ凍結する' }).click();
    await expect(page.locator('.toast')).toContainText('今日1日だけ凍結しました');

    // 目標Aのカードは当日凍結中として残り、解除だけができる（延長は出さない・design D3）。
    const cardA = page.locator('.rf-journal').filter({ has: page.locator('.rf-journal-title', { hasText: GOAL_A }) });
    await expect(cardA.locator('.gf-block').first()).toContainText('今日1日だけ凍結中');
    await expect(cardA.locator('.gf-block').first()).toContainText(REASON);
    await expect(cardA.locator('.gf-block').getByRole('button', { name: '解除' })).toBeVisible();
    await expect(cardA.locator('.gf-block').getByRole('button', { name: '延長' })).toHaveCount(0);

    // --- 3. その場で今日のゲートから外れる（当日凍結の目的そのもの）---------------------
    await page.locator('#tabs button[data-target="today"]').click();
    await expect(page.locator('.cond', { hasText: CHECK_B }).first()).toBeVisible();
    await expect(page.locator('.cond', { hasText: CHECK_A })).toHaveCount(0);

    // --- 4. 月枠は使用済みになり、期間凍結の枠も塞がる（同じ枠を奪い合う）----------------
    const quota = await (await request.get('/api/goals/freeze/quota')).json();
    expect(quota.sameDay.used).toBe(true);
    expect(quota.sameDay.goalId).toBe(goalIdA);

    // 2回目の当日凍結は月枠が理由で拒否される（409）。
    const again = await request.post(`/api/goals/${goalIdB}/freeze/same-day`, { data: { reason: 'もう一度' } });
    expect(again.status()).toBe(409);

    // 期間凍結が見るのは翌日の月。同じ月を見ている日（月の最終日以外）は同じ枠なので塞がっている。
    if (quota.month === quota.sameDay.month) {
      const period = await request.post('/api/goals/freeze/multi', {
        data: { goalIds: [goalIdB], endDay: thirtyDayEnd(dayKey), reason: '出張' },
      });
      expect(period.status()).toBe(409);
    }
  } finally {
    await request.delete(`/api/goals/${goalIdA}`);
    await request.delete(`/api/goals/${goalIdB}`);
  }
});
