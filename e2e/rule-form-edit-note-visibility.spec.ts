import { test, expect } from './fixtures.js';
import { thirtyDayEnd } from './goal-input.js';

/**
 * issue #84: ルールを追加モーダルで新規作成時に文字列 "null" や編集専用注記
 * 「（作成後は変更不可）」が誤って表示されないこと。編集時はその注記が正しく表示されること。
 */

const GOAL_NAME = 'ルール表示確認用目標';
const QUESTION = '調子はどうだった？';
const QUESTION_REASON = '毎日の調子を記録するため';

test('ルール追加フォームで新規作成時はnullも編集専用注記も出ず、編集時は注記が出る', async ({ page, request }) => {
  const { dayKey } = await (await request.get('/api/summary')).json();
  const goalRes = await request.post('/api/goals', {
    data: {
      name: GOAL_NAME,
      purpose: 'テスト',
      startReason: 'テストのため',
      start: 'today',
      endDay: thirtyDayEnd(dayKey),
      rules: [{ target: 'MANUAL_CHECK', label: 'ダミー', startDay: dayKey, endDay: null, reason: 'テスト' }],
    },
  });
  expect(goalRes.ok()).toBeTruthy();

  await page.goto('/');
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
  await page.locator('#tabs button[data-target="reflection"]').click();
  const journal = page.locator('.rf-journal').filter({ has: page.locator('.rf-journal-title', { hasText: GOAL_NAME }) });
  const block = journal.locator('.pc-block');
  await expect(block).toBeVisible();

  // 1. 新規作成フォーム: 質問ルール・写真ルールのどちらを選んでも null や編集専用注記は出ない。
  await block.getByRole('button', { name: '＋ 追加' }).click();
  let form = page.locator('.modal-panel .pc-checkform');
  await expect(form).toBeVisible();

  await form.locator('select').first().selectOption('QUESTION');
  await expect(form).not.toContainText('null');
  await expect(form).not.toContainText('作成後は変更不可');

  await form.locator('select').first().selectOption('PHOTO');
  await expect(form).not.toContainText('null');
  await expect(form).not.toContainText('作成後は変更不可');

  // 質問ルールを実際に作成する。
  await form.locator('select').first().selectOption('QUESTION');
  await form.locator('.pc-input[type="text"]').fill(QUESTION);
  await form.locator('.pc-textarea').fill(QUESTION_REASON);
  await page.locator('.modal-panel').getByRole('button', { name: 'ルールを追加' }).click();
  await expect(block.locator('.pc-plan', { hasText: QUESTION })).toBeVisible();

  // 2. 編集フォーム: 同じ質問ルールを開くと編集専用注記が表示される（null は出ない）。
  const row = block.locator('.pc-plan', { hasText: QUESTION });
  await row.getByRole('button', { name: '✎' }).click();
  form = page.locator('.modal-panel .pc-checkform');
  await expect(form).toBeVisible();
  await expect(form).toContainText('作成後は変更不可');
  await expect(form).not.toContainText('null');
});
