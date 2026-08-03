import { test, expect } from './fixtures.js';
import type { APIRequestContext } from '@playwright/test';
import { thirtyDayEnd } from './goal-input.js';

/**
 * ①のホバープレビュー／クリックで開く日別詳細モーダルの通し E2E
 * （issue #76 / spec: goal-report-day-detail）。`ユーザーフロー.md` の背骨を1本で踏む:
 *
 *   ①のマスにホバー→まだ書いていない日は「未記入」のプレビューが出る
 *   → クリック→日別詳細モーダルが開く（この日にやったこと／時間の内訳／気分・振り返り）
 *   → 気分・本文を入力して保存 → レポートが再描画される
 *   → ①の同じマスのホバープレビューに、いま書いた文面が出る
 *
 * インメモリ DB（本番非干渉）。実時刻に依存せず1日で完結する筋だけを踏む。
 *
 * ★後始末: ここで作る TOTAL_WORK ルールはこの spec 内では満たさない（未達のまま）。
 * 「今日」タブの解錠判定は全目標のルールを横断する共有状態のため、削除せずに残すと
 * 同じ共有 DB で走る他 spec（goal-rule-gate-loop 等）の解錠を永久に妨げてしまう。
 * 最終アサーション後に必ず目標を削除してから終える。
 */

const GOAL_NAME = 'goal-report-day-detail e2e チャレンジ';
const REFLECTION_TEXT = 'スマホを見すぎて何も手につかなかった日。反省。';

async function seedGoal(request: APIRequestContext): Promise<{ dayKey: string; goalId: number }> {
  const { dayKey } = await (await request.get('/api/summary')).json();
  const goal = await request.post('/api/goals', {
    data: {
      name: GOAL_NAME,
      purpose: '落ち着いて日々を過ごせている',
      startReason: 'e2e のため',
      start: 'today',
      endDay: thirtyDayEnd(dayKey),
      rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 60, startDay: dayKey, endDay: null, reason: '毎日少しは作業する' }],
    },
  });
  expect(goal.ok()).toBeTruthy();
  const { id } = await goal.json();
  return { dayKey, goalId: id };
}

test('①へのホバー→クリックでモーダル→振り返りを保存→ホバープレビューに反映される', async ({ page }) => {
  const { goalId } = await seedGoal(page.request);
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});

    await page.locator('#tabs button[data-target="goals"]').click();
    await page.locator('.gr-goal-card', { hasText: GOAL_NAME }).getByRole('button', { name: 'レポートプレビュー' }).click();
    await expect(page.locator('.gr-report')).toBeVisible();

    const cell = page.locator('.gr-cal .gr-cell').first();

    // --- 1. ホバー: まだ書いていないので「未記入」のプレビューが出る。クリックはしていない ---
    await cell.hover();
    const tip = page.locator('.gr-daytip');
    await expect(tip).toHaveClass(/show/);
    await expect(tip).toContainText('未記入');
    await expect(page.locator('.modal-root.open')).toHaveCount(0);

    // --- 2. クリック: 既存の④選択・ハイライトに加えて、日別詳細モーダルが開く -------------
    await cell.click();
    const modal = page.locator('.modal-panel');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('この日にやったこと');
    await expect(modal).toContainText('時間の内訳');
    await expect(modal).toContainText('気分・振り返り');
    // ④の選択ハイライトは維持される（既存挙動・design D5）。
    await expect(cell).toHaveClass(/sel/);

    // --- 3. 気分・本文を入力して保存 -------------------------------------------------
    await modal.getByText('良い', { exact: true }).click();
    await modal.locator('.gr-textarea').fill(REFLECTION_TEXT);
    await modal.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.toast')).toContainText('保存しました');
    await expect(page.locator('.modal-root.open')).toHaveCount(0);

    // --- 4. レポートが再描画され、①の同じマスのホバープレビューに新しい文面が出る --------
    await expect(page.locator('.gr-report')).toBeVisible();
    const cellAfter = page.locator('.gr-cal .gr-cell').first();
    await cellAfter.hover();
    await expect(page.locator('.gr-daytip')).toContainText(REFLECTION_TEXT);
  } finally {
    // 未達の TOTAL_WORK ルールを共有 DB に残さない（同日中は削除可能・spec 冒頭の注記参照）。
    await page.request.delete(`/api/goals/${goalId}`);
  }
});
