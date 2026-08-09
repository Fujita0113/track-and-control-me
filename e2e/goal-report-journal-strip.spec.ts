import { test, expect } from './fixtures.js';
import type { APIRequestContext } from '@playwright/test';
import { thirtyDayEnd } from './goal-input.js';

/**
 * ④ 日記ストリップの通し E2E（issue #91 / spec: goal-report / goal-report-day-detail）。
 * `openspec/changes/goal-report-journal-strip/tasks.md` §0 が挙げる3フローのうち、
 *
 *   1. レポートを開く → ①の記録のある日のマスをクリック → ④が該当日のカードへ寄って強調される
 *   3. 日別詳細モーダルから振り返りを保存 → 再描画後も④が同じ日のカードのままである
 *
 * を1本のシナリオで踏む（Day1 に記録→強調→記録の無い Day3 をクリックすると強調が消える→
 * Day3 をモーダルから記録→強調が Day3 へ移り、再描画後も Day3 のままである）。
 *
 * インメモリ DB（本番非干渉）。実時刻に依存せず1日で完結する筋だけを踏む。
 *
 * ★後始末: ここで作る TOTAL_WORK ルールはこの spec 内では満たさない（未達のまま）。
 * 「今日」タブの解錠判定は全目標のルールを横断する共有状態のため、削除せずに残すと
 * 同じ共有 DB で走る他 spec の解錠を永久に妨げてしまう。最終アサーション後に必ず目標を削除する。
 */

async function seedGoal(request: APIRequestContext, name: string): Promise<{ dayKey: string; goalId: number }> {
  const { dayKey } = await (await request.get('/api/summary')).json();
  const goal = await request.post('/api/goals', {
    data: {
      name,
      purpose: 'e2e のため',
      startReason: 'e2e のため',
      start: 'today',
      endDay: thirtyDayEnd(dayKey),
      rules: [{ target: 'TOTAL_WORK', thresholdSeconds: 60, startDay: dayKey, endDay: null, reason: 'e2e' }],
    },
  });
  expect(goal.ok()).toBeTruthy();
  const { id } = await goal.json();
  return { dayKey, goalId: id };
}

const DAY1_TEXT = 'strip検証: Day1の振り返り';
const DAY3_TEXT = 'strip検証: Day3の振り返り';

test('①クリックで④が該当カードへ寄って強調され、モーダル保存後の再描画でも同じ日のカードのままである', async ({ page, request }) => {
  const GOAL_NAME = 'goal-report-journal-strip e2e 強調';
  const { goalId } = await seedGoal(request, GOAL_NAME);
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
    await page.locator('#tabs button[data-target="goals"]').click();
    await page.locator('.gr-goal-card', { hasText: GOAL_NAME }).getByRole('button', { name: 'レポートプレビュー' }).click();
    await expect(page.locator('.gr-report')).toBeVisible();

    // まだ記録が無いので④はストリップではなく一文のみ。
    await expect(page.locator('.gr-strip-card')).toHaveCount(0);

    const cells = page.locator('.gr-cal .gr-cell');
    const day1Cell = cells.nth(0);
    const day3Cell = cells.nth(2);

    // --- 1. Day1 の記録の無いマスをクリック→モーダルへ記録を保存する ---------------------
    await day1Cell.click();
    let modal = page.locator('.modal-panel');
    await expect(modal).toBeVisible();
    await modal.locator('.gr-textarea').fill(DAY1_TEXT);
    await modal.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.toast')).toContainText('保存しました');
    await expect(page.locator('.gr-report')).toBeVisible();

    // --- 2. Day1 を再クリック: ④が Day1 のカードへ寄って強調される（フロー1） -------------
    await page.locator('.gr-cal .gr-cell').nth(0).click();
    await expect(page.locator('.modal-panel')).toBeVisible();
    await page.getByRole('button', { name: '閉じる', exact: true }).click();
    const day1Card = page.locator('.gr-strip-card', { hasText: DAY1_TEXT });
    await expect(day1Card).toHaveClass(/sel/);
    await expect(page.locator('.gr-strip-card.sel')).toHaveCount(1);

    // --- 3. 記録の無い Day3 をクリック: ④の強調はゼロになる（スクロールしない・spec MUST NOT） ---
    await page.locator('.gr-cal .gr-cell').nth(2).click();
    modal = page.locator('.modal-panel');
    await expect(modal).toBeVisible(); // 記録の無い日でもモーダルは開く（goal-report-day-detail）
    await expect(page.locator('.gr-strip-card.sel')).toHaveCount(0);

    // --- 4. Day3 をモーダルから記録して保存 → 再描画後も④は Day3 のカードのままである（フロー3） ---
    await modal.locator('.gr-textarea').fill(DAY3_TEXT);
    await modal.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.toast')).toContainText('保存しました');
    await expect(page.locator('.gr-report')).toBeVisible();

    const day3Card = page.locator('.gr-strip-card', { hasText: DAY3_TEXT });
    await expect(day3Card).toHaveClass(/sel/);
    await expect(page.locator('.gr-strip-card.sel')).toHaveCount(1);
    // 先頭（Day1）へ巻き戻っていないことも確認する（design D4）。
    await expect(page.locator('.gr-strip-card', { hasText: DAY1_TEXT })).not.toHaveClass(/sel/);
  } finally {
    await page.request.delete(`/api/goals/${goalId}`);
  }
});

test('③には日記の文面が出ておらず、写真だけが並ぶ', async ({ page, request }) => {
  const GOAL_NAME = 'goal-report-journal-strip e2e 写真専用';
  const { dayKey, goalId } = await seedGoal(request, GOAL_NAME);
  const MARKER_TEXT = 'strip検証: この文面は③には出ないはず';
  const ONE_PX_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  try {
    const journal = await request.put(`/api/goals/${goalId}/journal/${dayKey}`, { data: { content: MARKER_TEXT } });
    expect(journal.ok()).toBeTruthy();
    const image = await request.post(`/api/goals/${goalId}/journal/${dayKey}/images`, {
      data: { dataUrl: ONE_PX_PNG, caption: '体・正面' },
    });
    expect(image.ok()).toBeTruthy();

    await page.goto('/');
    await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
    await page.locator('#tabs button[data-target="goals"]').click();
    await page.locator('.gr-goal-card', { hasText: GOAL_NAME }).getByRole('button', { name: 'レポートプレビュー' }).click();
    await expect(page.locator('.gr-report')).toBeVisible();

    const photoBlock = page.locator('.gr-card', { has: page.locator('.gr-block-title', { hasText: '③ 写真の比較' }) });
    await expect(photoBlock).toBeVisible();
    await expect(photoBlock).not.toContainText(MARKER_TEXT);
    await expect(photoBlock.locator('img.gr-fig-img')).toHaveCount(1);

    // ④のカードには同じ日の文面が出る（出典の判別つき）。
    const strip = page.locator('.gr-strip-card', { hasText: MARKER_TEXT });
    await expect(strip).toBeVisible();
    await expect(strip).toContainText('日記');
  } finally {
    await page.request.delete(`/api/goals/${goalId}`);
  }
});
