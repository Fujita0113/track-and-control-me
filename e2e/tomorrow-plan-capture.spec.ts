import { test, expect } from '@playwright/test';

/**
 * 明日の計画ビュー e2e（tomorrow-plan-capture / issue #61）。
 * 振り返り本文の「明日」段落から拾った候補チップのタップ、および大きな入力欄への
 * 直接入力の両方から、本物のカンバン（due=翌日・未着手/TODO・未完了）へタスクが
 * 登録されることを実ブラウザで確認する。振り返りタブ内で完結し、カンバンタブへの
 * 画面遷移は発生しない（旧「振り返りを終えて明日の計画へ →」動線の置き換え）。
 */

/** 'YYYY-MM-DD' に n 日加算（UTC 計算・util.js の addDays と同じ規則）。 */
function addDays(dayKey: string, n: number): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

test('候補チップのタップと直接入力の両方で、カンバンに due=翌日のタスクが登録される', async ({ page, request }) => {
  const { dayKey } = await (await request.get('/api/summary')).json();
  const tomorrow = addDays(dayKey, 1);
  const content = '今日は開発を進めた。\n明日の段取り：まず筋トレ。次にタスク確認する。';
  const put = await request.put(`/api/reflection/${dayKey}`, { data: { content, satisfaction: 4 } });
  expect(put.ok()).toBeTruthy();

  await page.goto('/');
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
  await page.locator('#tabs button[data-target="reflection"]').click();

  // 右サイドバーの本文エディタに保存済みの内容が読み込まれる。
  await expect(page.locator('.rf-ed')).toContainText('明日の段取り');

  // 左メインを「明日の計画」ビューへ切り替える（対象日は変わらない）。
  await page.locator('.rf-viewtab', { hasText: '明日の計画' }).click();
  await expect(page.locator('.rf-plan')).toBeVisible();

  // 本文から拾った候補チップをタップで登録（タイプ不要・書いた言葉がそのままタスク名）。
  const chip = page.locator('.rf-plan-chip', { hasText: '筋トレ' });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.locator('.rf-plan-item', { hasText: '筋トレ' })).toBeVisible();
  await expect(chip).toHaveClass(/done/); // 二重登録を避ける「登録済み」表示。

  // 大きな入力欄への直接入力 + Enter でも連続登録できる。
  const input = page.locator('.rf-plan-input');
  await input.fill('レビュー依頼を送る');
  await input.press('Enter');
  await expect(page.locator('.rf-plan-item', { hasText: 'レビュー依頼を送る' })).toBeVisible();
  await expect(input).toHaveValue('');

  // カンバンタブへ遷移することなく、振り返りタブ内で完結している。
  await expect(page.locator('#screen-reflection')).toHaveClass(/active/);

  // 登録先は本物のカンバンの未着手(TODO)列・due=翌日の未完了タスク（別ストアではない）。
  const tasks = await (await request.get('/api/tasks')).json();
  const chipTask = tasks.find((t: { title: string }) => t.title === '筋トレ');
  const typedTask = tasks.find((t: { title: string }) => t.title === 'レビュー依頼を送る');
  expect(chipTask).toBeTruthy();
  expect(chipTask.status).toBe('TODO');
  expect(chipTask.due).toBe(tomorrow);
  expect(typedTask).toBeTruthy();
  expect(typedTask.status).toBe('TODO');
  expect(typedTask.due).toBe(tomorrow);

  // カンバンタブを開くと同じタスクがそこにある（同じ集合であることの裏取り）。
  await page.locator('#tabs button[data-target="kanban"]').click();
  await expect(page.locator('.kb-card', { hasText: '筋トレ' })).toBeVisible();
  await expect(page.locator('.kb-card', { hasText: 'レビュー依頼を送る' })).toBeVisible();
});
