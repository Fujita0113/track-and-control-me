import { test, expect } from './fixtures.js';
import type { APIRequestContext } from '@playwright/test';
import { thirtyDayEnd } from './goal-input.js';

/**
 * issue #83 / fix-today-question-input-clear の通し E2E。
 * 今日タブの質問回答欄に未送信の入力がある状態で、ゲート領域の30秒自動更新
 * （`setInterval(refreshGate, 30000)`）が走っても、入力内容とフォーカスが保持される
 * （spec: goal-check-gate「今日タブから直接ルールに答える」の追加シナリオ）。
 *
 * `page.clock` で時計をモックし、実時間30秒を待たずにタイマーを進める。
 */

const QUESTION = '燃えないゴミの日いつ？';
const PARTIAL_ANSWER = '木曜日だ';

async function seedQuestionRule(request: APIRequestContext): Promise<string> {
  const { dayKey } = await (await request.get('/api/summary')).json();
  const goal = await request.post('/api/goals', {
    data: {
      name: 'ゴミ出しを忘れない（入力保持テスト）',
      purpose: '部屋をきれいにする',
      startReason: 'e2e のため',
      start: 'tomorrow', // upcoming 扱いにして振り返りタブの .pc-block を増やさない（他 e2e との共存）。
      endDay: thirtyDayEnd(dayKey),
      rules: [{ target: 'QUESTION', questionText: QUESTION, startDay: dayKey, endDay: dayKey, reason: 'e2e のため' }],
    },
  });
  expect(goal.ok()).toBeTruthy();
  return dayKey;
}

test('質問回答欄に入力中、ゲートの30秒自動更新が走っても入力が消えない', async ({ page }) => {
  // setInterval(refreshGate, 30000) をモック時計で進めるため、goto 前にインストールする。
  await page.clock.install();

  await seedQuestionRule(page.request);
  await page.goto('/');
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});

  await page.locator('#tabs button[data-target="today"]').click();
  const row = page.locator('.cond-check', { hasText: QUESTION });
  await expect(row).toBeVisible();

  const input = row.locator('.cond-answer');
  await input.fill(PARTIAL_ANSWER);
  await expect(input).toBeFocused();

  // 30秒経過させ、ゲート領域の自動更新（renderGate の再描画）を発火させる。
  await page.clock.runFor(30_000);

  await expect(input).toHaveValue(PARTIAL_ANSWER);
  await expect(input).toBeFocused();
});
