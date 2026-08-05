import { test, expect } from './fixtures.js';
import type { APIRequestContext } from '@playwright/test';
import { thirtyDayEnd } from './goal-input.js';

/**
 * issue #86: 振り返りタブの目標コーナーで「ルール」ブロックが既定で折りたたまれていること、
 * 開くと中身が見えること、対象日を切り替えると再び閉じることを確認する。
 */

const GOAL_NAME = '折りたたみ確認用目標';
const CHECK_LABEL = '毎日の素振り';

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

test('目標コーナーのルール一覧は既定で閉じていて、開くと中身が見え、対象日を切り替えると再び閉じる', async ({ page, request }) => {
  const { dayKey } = await (await request.get('/api/summary')).json();
  await seedGoal(request, dayKey);

  await page.goto('/');
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
  await page.locator('#tabs button[data-target="reflection"]').click();

  const journal = page.locator('.rf-journal').filter({ has: page.locator('.rf-journal-title', { hasText: GOAL_NAME }) });
  await expect(journal).toBeVisible();

  const details = journal.locator('details.pc-rules-collapse');
  const summary = details.locator('summary.pc-rules-summary');
  const block = details.locator('.pc-block');

  // 開いた直後は閉じていて、件数が見出しに出る。
  await expect(details).not.toHaveJSProperty('open', true);
  await expect(summary).toContainText('1件');
  await expect(block).toBeHidden();

  // 開くと中身が見える。
  await summary.click();
  await expect(details).toHaveJSProperty('open', true);
  await expect(block).toBeVisible();
  await expect(block).toContainText(CHECK_LABEL);

  // 対象日を切り替える（ルールブロックは今日のときだけ出るので、翌日へ→今日へ戻る）と、
  // 再描画された目標コーナーのルールブロックは既定（閉）に戻る。
  await page.locator('.rf-strip-arrow').nth(1).click(); // ›（翌日へ）
  await expect(journal.locator('details.pc-rules-collapse')).toHaveCount(0);

  await page.locator('.rf-strip-today').click(); // 今日へ戻る
  const journalAfter = page.locator('.rf-journal').filter({ has: page.locator('.rf-journal-title', { hasText: GOAL_NAME }) });
  await expect(journalAfter).toBeVisible();
  const detailsAfter = journalAfter.locator('details.pc-rules-collapse');
  await expect(detailsAfter).not.toHaveJSProperty('open', true);
  await expect(detailsAfter.locator('.pc-block')).toBeHidden();
});
