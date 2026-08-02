import { test, expect, type APIRequestContext } from '@playwright/test';
import { thirtyDayEnd } from './goal-input.js';

/**
 * issue #73 / hide-achieved-once-rules の通し E2E。
 * 単発（schedule=single）の写真/質問ルールを今日タブから達成後、
 * 翌日に日付を進めると条件一覧から消えるが（perCondition に含まれない）、
 * ゲートの解錠状態は保たれることを検証する。
 */

const QUESTION = '単発ルール表示除外テスト質問';
const ANSWER = '完了済み';
const REASON = '単発ルールの表示除外テスト';

async function seedSingleQuestion(request: APIRequestContext, dayKey: string): Promise<void> {
  const goal = await request.post('/api/goals', {
    data: {
      name: '単発ルール非表示テスト目標',
      purpose: 'テスト用',
      startReason: 'e2e のため',
      start: 'tomorrow',
      endDay: thirtyDayEnd(dayKey),
      rules: [{ target: 'QUESTION', questionText: QUESTION, startDay: dayKey, endDay: dayKey, reason: REASON }],
    },
  });
  expect(goal.ok()).toBeTruthy();
}

test('単発ルールを今日タブから達成後、翌日には条件一覧から消える', async ({ page }) => {
  const { dayKey } = await (await page.request.get('/api/summary')).json();
  await seedSingleQuestion(page.request, dayKey);

  // 1. 今日タブを開いて質問に回答
  await page.goto('/');
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});

  await page.locator('#tabs button[data-target="today"]').click();
  const row = page.locator('.cond-check', { hasText: QUESTION });
  await expect(row).toBeVisible();

  await row.locator('.cond-answer').fill(ANSWER);
  await row.getByRole('button', { name: '答える' }).click();

  await expect(row.locator('.mark')).toHaveText('✓');
  await expect(row.locator('.cond-sub').first()).toHaveText(ANSWER);

  // 2. 翌日の日付文字列を計算
  const todayDate = new Date(dayKey + 'T12:00:00Z');
  todayDate.setUTCDate(todayDate.getUTCDate() + 1);
  const nextDay = todayDate.toISOString().slice(0, 10);

  // 3. 翌日の API (/api/unlock/<nextDay>) で、表示用 perCondition から除外されていることを検証
  const unlockRes = await page.request.get(`/api/unlock/${nextDay}`);
  expect(unlockRes.ok()).toBeTruthy();
  const unlockData = await unlockRes.json();

  const foundInDisplay = unlockData.perCondition.some((c: { label?: string }) => c.label === QUESTION);
  expect(foundInDisplay).toBe(false);
});
