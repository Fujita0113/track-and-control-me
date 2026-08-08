import { test, expect } from './fixtures.js';
import type { APIRequestContext } from '@playwright/test';
import { thirtyDayEnd } from './goal-input.js';

/**
 * 終了の翌日発効と、発効前の取消（spec: goal-lifecycle-fork MODIFIED / ADDED・goal-history MODIFIED）。
 *
 * 「終える」から当日破壊の力を取り上げるのがこの変更の核心で、今夜ノルマを外す正当な事情は
 * `goal-freeze` の当日凍結（月1枠）が担う。ここで踏むのはその核心が実ブラウザで成立する筋:
 *
 *   進行中の目標を終える → **今日タブのゲートは何も変わらない** → カードは「終了予約中」で削除も出ない
 *   → 「終了を取り消す」で進行中に戻り、大きい沿革の「−終える」の行も消える
 *
 * 「翌日にはゲートから外れる」ことは日付を跨ぐので `goal-end-anytime.test.ts` が固める。
 */

const GOAL_NAME = '翌日発効で終える目標';
const CHECK_LABEL = '翌日発効の素振り';
const END_REASON = '試験勉強はもう大丈夫。設計に切り替えたい';

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

test('目標を終えても今日のゲートは変わらず「終了予約中」になり、取り消すと進行中に戻る', async ({ page, request }) => {
  const { dayKey } = await (await request.get('/api/summary')).json();
  const goalId = await seedGoal(request, dayKey);

  // 未達成のルールは今日タブの解錠ゲート（アプリ全体で1つの共有状態）を塞ぐので必ず後始末する。
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});

    // --- 1. 今日タブ: 終える前はルールがゲートに現れる（前提の確認）---------------------
    await page.locator('#tabs button[data-target="today"]').click();
    await expect(page.locator('.cond', { hasText: CHECK_LABEL }).first()).toBeVisible();

    // --- 2. 目標タブ: 理由つきで終える ------------------------------------------------
    await page.locator('#tabs button[data-target="goals"]').click();
    const card = page.locator('.gr-goal-card', { hasText: GOAL_NAME });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: '終える', exact: true }).click();

    const endModal = page.locator('.modal-panel');
    await expect(endModal).toBeVisible();
    await endModal.locator('.gr-end-reason-input').fill(END_REASON);
    await endModal.getByRole('button', { name: 'この目標を終える' }).click();
    await expect(page.locator('.toast-ok')).toContainText('明日からこの目標を終えます');

    // --- 3. 今夜のノルマは今夜のノルマとして残る（当日発効の禁止そのもの）-----------------
    await page.locator('#tabs button[data-target="today"]').click();
    await expect(page.locator('.cond', { hasText: CHECK_LABEL }).first()).toBeVisible();

    // --- 4. カードは進行中のまま「終了予約中」。削除も「終える」も出ない -------------------
    await page.locator('#tabs button[data-target="goals"]').click();
    const pendingCard = page.locator('.gr-goal-card', { hasText: GOAL_NAME });
    await expect(pendingCard.locator('.badge', { hasText: '終了予約中' })).toBeVisible();
    await expect(pendingCard.locator('.badge', { hasText: 'Day 1/' })).toBeVisible();
    // 削除の表示条件はサーバの削除ガードと一致（`ended_day_key != null` なら出さない・design D11）。
    await expect(pendingCard.getByRole('button', { name: '削除' })).toHaveCount(0);
    await expect(pendingCard.getByRole('button', { name: '終える', exact: true })).toHaveCount(0);

    // 大きい沿革の「−終える」の行は発効前から「予約中」の印つきで並ぶ（spec: goal-history）。
    const history = page.locator('.gr-history');
    const endedRow = history.locator('.gr-hist-row', { hasText: `${GOAL_NAME} を終えた` });
    await expect(endedRow).toBeVisible();
    await expect(endedRow.locator('.gr-hist-pending')).toContainText('予約中');

    // --- 5. 発効前なら取り消せる。取消で沿革の行も消える ---------------------------------
    page.once('dialog', (d) => d.accept());
    await pendingCard.getByRole('button', { name: '終了を取り消す' }).click();
    await expect(page.locator('.toast-ok')).toContainText('終了を取り消しました');

    const backCard = page.locator('.gr-goal-card', { hasText: GOAL_NAME });
    await expect(backCard.locator('.badge', { hasText: '終了予約中' })).toHaveCount(0);
    await expect(backCard.getByRole('button', { name: '終える', exact: true })).toBeVisible();
    // 発効しなかった終了は起きなかった終了なので、行ごと消える。
    await expect(history.locator('.gr-hist-row', { hasText: `${GOAL_NAME} を終えた` })).toHaveCount(0);
    await expect(history.locator('.gr-hist-row', { hasText: `${GOAL_NAME} をはじめた` })).toBeVisible();
  } finally {
    // 取消済みなら削除できる。失敗して終了予約中のまま残った場合に備えて先に取消を試す。
    await request.post(`/api/goals/${goalId}/end/cancel`).catch(() => {});
    await request.delete(`/api/goals/${goalId}`);
  }
});
