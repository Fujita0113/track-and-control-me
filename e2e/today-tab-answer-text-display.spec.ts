import { test, expect, type APIRequestContext } from '@playwright/test';
import { thirtyDayEnd } from './goal-input.js';

/**
 * issue #70 / today-tab-answer-text-display の通し E2E。
 * 今日タブで質問ルールに回答して達成すると、行には「回答済み」ではなく
 * 実際に入力した回答テキストが表示される（spec: goal-check-gate「今日タブから
 * 直接ルールに答える」の追加シナリオ）。
 *
 * インメモリ DB（本番非干渉）。goal-rule-gate-loop.spec.ts と同じ webServer・DB を共有した
 * まま並列実行されるため、目標自体は `start: 'tomorrow'`（=today時点で status='upcoming'・
 * 振り返りタブの目標コーナーには出ない）にして `.pc-block` の重複を避ける。ルールの評価は
 * 目標のステータスに依存しない（`listActiveRules` は `rule` テーブルを直接見る）ため、
 * ルール自体の startDay/endDay を今日に固定すれば、今日タブのゲートには通常どおり出る。
 */

const QUESTION = '燃えないゴミの日いつ？';
const ANSWER = '木曜日';
const REASON = 'ゴミ出しを忘れないようにしたい';

async function seedQuestionRule(request: APIRequestContext): Promise<string> {
  const { dayKey } = await (await request.get('/api/summary')).json();
  const goal = await request.post('/api/goals', {
    data: {
      name: 'ゴミ出しを忘れない',
      purpose: '部屋をきれいにする',
      startReason: 'e2e のため',
      start: 'tomorrow', // upcoming 扱いにして振り返りタブの .pc-block を増やさない（他 e2e との共存）。
      endDay: thirtyDayEnd(dayKey),
      rules: [{ target: 'QUESTION', questionText: QUESTION, startDay: dayKey, endDay: dayKey, reason: REASON }],
    },
  });
  expect(goal.ok()).toBeTruthy();
  return dayKey;
}

test('今日タブで質問に答えると、回答済みではなく回答テキストが表示される', async ({ page }) => {
  await seedQuestionRule(page.request);
  await page.goto('/');
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});

  await page.locator('#tabs button[data-target="today"]').click();
  const row = page.locator('.cond-check', { hasText: QUESTION });
  await expect(row).toBeVisible();
  await expect(row.locator('.cond-sub').first()).toContainText('未回答');

  await row.locator('.cond-answer').fill(ANSWER);
  await row.getByRole('button', { name: '答える' }).click();

  await expect(row.locator('.mark')).toHaveText('✓');
  // 「回答済み」ではなく、実際に入力した回答テキストが1行目(タイトル)の下に出る（issue #70）。
  await expect(row.locator('.cond-sub').first()).toHaveText(ANSWER);
  await expect(row.locator('.cond-sub').first()).not.toContainText('回答済み');
});
