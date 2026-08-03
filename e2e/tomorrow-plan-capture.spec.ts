import { test, expect } from './fixtures.js';

/**
 * 明日の計画ビュー e2e（tomorrow-plan-capture / issue #61・#67）。
 * 振り返り本文の「明日」段落から拾った候補チップのタップから、本物のカンバン
 * （due=翌日・未着手/TODO・未完了）へタスクが登録されることを実ブラウザで確認する。
 * 振り返りタブ内で完結し、カンバンタブへの画面遷移は発生しない
 * （旧「振り返りを終えて明日の計画へ →」動線の置き換え）。
 *
 * issue #67 で登録済みの表示が縦リスト（.rf-plan-item）から埋め込みカンバン盤面の
 * カード（.kb-card）へ変わったため、登録結果の確認先を差し替えている。盤面そのものの
 * 操作（列間ドラッグ・期限調整・サイドバータブ）は別 spec が扱う。
 * また issue #67 の最新フィードバックにより、直接入力欄（Enter で連続登録）は撤去された
 * （新規タスクは盤面自身の「＋ 新規タスク」で作る）。
 */

/** 'YYYY-MM-DD' に n 日加算（UTC 計算・util.js の addDays と同じ規則）。 */
function addDays(dayKey: string, n: number): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

test('候補チップのタップで、カンバンに due=翌日のタスクが登録される', async ({ page, request }) => {
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
  // 登録済みは埋め込みカンバン盤面のカードとして現れる（issue #67 で縦リストから置換）。
  await expect(page.locator('#screen-reflection .kb-card', { hasText: '筋トレ' })).toBeVisible();
  await expect(chip).toHaveClass(/done/); // 二重登録を避ける「登録済み」表示。

  // 直接入力欄は撤去済み（issue #67 フィードバック）。新規タスクは盤面自身の「＋ 新規タスク」で作る。
  await expect(page.locator('.rf-plan-input')).toHaveCount(0);

  // カンバンタブへ遷移することなく、振り返りタブ内で完結している。
  await expect(page.locator('#screen-reflection')).toHaveClass(/active/);

  // 登録先は本物のカンバンの未着手(TODO)列・due=翌日の未完了タスク（別ストアではない）。
  const tasks = await (await request.get('/api/tasks')).json();
  const chipTask = tasks.find((t: { title: string }) => t.title === '筋トレ');
  expect(chipTask).toBeTruthy();
  expect(chipTask.status).toBe('TODO');
  expect(chipTask.due).toBe(tomorrow);

  // カンバンタブを開くと同じタスクがそこにある（同じ集合であることの裏取り）。
  await page.locator('#tabs button[data-target="kanban"]').click();
  await expect(page.locator('.kb-card', { hasText: '筋トレ' })).toBeVisible();
});
