import { test, expect } from './fixtures.js';
import type { APIRequestContext, Page } from '@playwright/test';
import { thirtyDayEnd } from './goal-input.js';

/**
 * 終了→再開の往復フロー（spec: goal-lifecycle-fork ADDED・issue #103）。
 *
 * 「終える」に「再開する」を足した本変更の核心: 発効済みの終了を理由つきで再開でき、
 * 再開も終了と対称に翌日発効・発効前は取消できる。
 *
 * `resumeGoal` は `isEnded(goal, today)` が真のとき（＝終了が発効した後）にしか呼べないため、
 * 「再開する」ボタンが実ブラウザに現れ、再開の発効後にゲートへ戻ることまでを確かめるには
 * 実際に日付を2回跨ぐ必要がある。このアプリに時刻のモックは無く、`today` は
 * `app_config.day_boundary_minutes`（日の境界時刻）から都度導出される（design: goal-freeze D1
 * と同じ「保存せず導出する」方針）ので、実時刻を長時間待つ代わりに `day_boundary_minutes` を
 * 「23時間58分先」を指す値へ動かし、その場で `today` を1日進める（cron や日付偽装ではなく、
 * このアプリが実際に読む設定値を動かす・`day_boundary_minutes` はワーカー専用サーバーの
 * app_config なので他 spec に影響しない・使用後は元の値へ復元する）。
 */

const GOAL_NAME = '再開往復フロー目標';
const CHECK_LABEL = '再開往復の素振り';
const END_REASON = '体調を崩したので一旦休む';
const RESUME_REASON = '体調が戻ったので再開する';

async function seedGoal(request: APIRequestContext, dayKey: string): Promise<number> {
  const res = await request.post('/api/goals', {
    data: {
      name: GOAL_NAME,
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

/**
 * `day_boundary_minutes` を「23時間50分 × n 先」を指す値へ動かし、`today` を実時刻の
 * 「今」から n 日ぶん進める（`dayKeyFor` は `(now, boundary)` の純関数なので、同じ値を
 * 2回設定しても進まない。跨いだ回数ぶん値を積み増す必要がある）。
 * 深夜0時をまたぐ極端なタイミングでの二重跨ぎを避けるため、1日ぶんを23時間50分（-1430分）とする。
 */
async function advanceDays(request: APIRequestContext, crossingCount: number): Promise<string> {
  const patchRes = await request.patch('/api/config', { data: { day_boundary_minutes: -1430 * crossingCount } });
  expect(patchRes.ok()).toBeTruthy();
  const { dayKey } = (await (await request.get('/api/summary')).json()) as { dayKey: string };
  return dayKey;
}

async function openGoalsTab(page: Page): Promise<void> {
  await page.locator('#tabs button[data-target="goals"]').click();
}

async function dismissOnboarding(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
}

test('終える→翌日発効で終了→再開する→翌日発効でゲートに戻る', async ({ page, request }) => {
  const { dayKey } = await (await request.get('/api/summary')).json();
  const goalId = await seedGoal(request, dayKey);
  // このワーカーの共有サーバーへ跨って影響が残らないよう、元の日境界を復元する（フェーズ末で必ず戻す）。
  const { day_boundary_minutes: originalBoundary } = (await (await request.get('/api/config')).json()) as {
    day_boundary_minutes: number;
  };

  try {
    await page.goto('/');
    await dismissOnboarding(page);

    // --- 1. 今日タブ: 終える前はルールがゲートに現れる（前提）--------------------------------
    await page.locator('#tabs button[data-target="today"]').click();
    await expect(page.locator('.cond', { hasText: CHECK_LABEL }).first()).toBeVisible();

    // --- 2. 目標タブ: 理由つきで終える（発効は翌日）------------------------------------------
    await openGoalsTab(page);
    const card = page.locator('.gr-goal-card', { hasText: GOAL_NAME });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: '終える', exact: true }).click();

    const endModal = page.locator('.modal-panel', { has: page.locator('h3', { hasText: '目標を終える' }) });
    await expect(endModal).toBeVisible();
    await endModal.locator('.gr-end-reason-input').fill(END_REASON);
    await endModal.getByRole('button', { name: 'この目標を終える' }).click();
    await expect(page.locator('.toast-ok')).toContainText('明日からこの目標を終えます');
    await expect(card.locator('.badge', { hasText: '終了予約中' })).toBeVisible();

    // 終えた当日はまだゲートも変わらない（当日破壊の禁止・design D5）。
    await page.locator('#tabs button[data-target="today"]').click();
    await expect(page.locator('.cond', { hasText: CHECK_LABEL }).first()).toBeVisible();

    // --- 3. 1日進める。終了が発効し、「終了予約中」は消え「再開する」が現れる ------------------
    await advanceDays(request, 1);
    await page.reload();
    await dismissOnboarding(page);
    await openGoalsTab(page);

    const endedCard = page.locator('.gr-goal-card', { hasText: GOAL_NAME });
    await expect(endedCard.locator('.badge', { hasText: '終了' })).toBeVisible();
    await expect(endedCard.locator('.badge', { hasText: '終了予約中' })).toHaveCount(0);
    await expect(endedCard.getByRole('button', { name: '終える', exact: true })).toHaveCount(0);
    const resumeBtn = endedCard.getByRole('button', { name: '再開する', exact: true });
    await expect(resumeBtn).toBeVisible();

    // 永続ルールは発効した終了でゲートから外れる。
    await page.locator('#tabs button[data-target="today"]').click();
    await expect(page.locator('.cond', { hasText: CHECK_LABEL })).toHaveCount(0);

    // 大きい沿革に「を終えた」の行が理由つきで並ぶ。
    await openGoalsTab(page);
    const history = page.locator('.gr-history');
    await expect(history.locator('.gr-hist-row', { hasText: `${GOAL_NAME} を終えた` })).toBeVisible();

    // --- 4. 「再開する」→ 理由必須 → 再開予約中（翌日発効） ---------------------------------
    await resumeBtn.click();
    const resumeModal = page.locator('.modal-panel', { has: page.locator('h3', { hasText: '目標を再開する' }) });
    await expect(resumeModal).toBeVisible();
    await resumeModal.getByRole('button', { name: 'この目標を再開する' }).click();
    await expect(page.locator('.toast-err')).toContainText('理由を入力してください');
    await resumeModal.locator('textarea').fill(RESUME_REASON);
    await resumeModal.getByRole('button', { name: 'この目標を再開する' }).click();
    await expect(page.locator('.toast-ok')).toContainText('明日からこの目標を再開します');

    const resumingCard = page.locator('.gr-goal-card', { hasText: GOAL_NAME });
    await expect(resumingCard.locator('.badge', { hasText: '再開予約中' })).toBeVisible();
    await expect(resumingCard.getByRole('button', { name: '再開する', exact: true })).toHaveCount(0);
    await expect(resumingCard.getByRole('button', { name: '再開を取り消す' })).toBeVisible();

    // 再開を要求した当日はまだ終了のまま、ゲートも変わらない。
    await page.locator('#tabs button[data-target="today"]').click();
    await expect(page.locator('.cond', { hasText: CHECK_LABEL })).toHaveCount(0);

    // --- 5. もう1日進める。再開が発効し、ゲートへ戻る ----------------------------------------
    await openGoalsTab(page);
    await advanceDays(request, 2);
    await page.reload();
    await dismissOnboarding(page);
    await openGoalsTab(page);

    const activeCard = page.locator('.gr-goal-card', { hasText: GOAL_NAME });
    await expect(activeCard.locator('.badge', { hasText: '再開予約中' })).toHaveCount(0);
    await expect(activeCard.locator('.badge', { hasText: 'Day' })).toBeVisible();
    await expect(activeCard.getByRole('button', { name: '終える', exact: true })).toBeVisible();

    await page.locator('#tabs button[data-target="today"]').click();
    await expect(page.locator('.cond', { hasText: CHECK_LABEL }).first()).toBeVisible();

    // 大きい沿革に「を再開した」の行が理由つきで並ぶ。
    await openGoalsTab(page);
    await expect(history.locator('.gr-hist-row', { hasText: `${GOAL_NAME} を再開した` })).toBeVisible();
  } finally {
    // 日境界を元に戻す（このワーカーサーバーを使い回す他 spec への影響を断つ）。
    await request.patch('/api/config', { data: { day_boundary_minutes: originalBoundary } }).catch(() => {});
  }
});
