import { test, expect } from './fixtures.js';
import type { APIRequestContext, Page } from '@playwright/test';

/**
 * 進捗グラフ（バーンアップ）の通し E2E（change goal-burnup-forecast・tasks.md §0 に挙げた8本）。
 * レポートは capability ごと廃止されたため、目標の唯一のビューである進捗グラフに対して書く。
 *
 *   1. 目標カード「進捗グラフ」→ バーンアップが出る → 「直近3日ペース」へ切り替える →
 *      完了予想日が手前の日付に変わり、選ばれていない側は控えめな表示で残る
 *   2. PUT /api/tasks/:id/estimate を叩く → 進捗グラフを開き直す →
 *      完了予想日は変わるが、グラフ上に段差や理由としては何も出ない
 *   3. 走行中の枝の葉を完了にする → 進捗グラフを開き直す →
 *      その日にタスク達成マーカー（黒丸）が増え、クリックで名前と完了日が読める
 *      （PUT /progress は「小数の進捗」用の別経路のため、完了は subtree-done で作る。
 *      PUT /progress 自体は同じ場面で別の葉に対して直接叩き、マーカーを作らないことを確かめる）
 *   4. 同じ日に2件の葉を完了させる → 進捗グラフを開く → マーカーが1つにまとまり、
 *      クリックでその日の2件が一覧で読める
 *   5. 期間を月の帯クリックで絞り込む → 日付が見える粒度になったら日付をクリックする →
 *      タブ遷移はせず、その日の作業時間バーと振り返り本文がモーダルで開く →
 *      本文を編集して保存すると、モーダルを開き直しても保存内容が反映されている（issue #106 の改訂）
 *   6. 計測対象を持たない目標の進捗グラフ → 空状態が出て、数値の欠損は出ない
 *   7. 大きい沿革の行を選ぶ → 進捗グラフが開く（レポートは存在しない）
 *   8. 完走した目標のカードに「続ける」と「終える」が並ぶ
 *
 * 1・3(マーカー確認)・4・7・8 はデモモード（固定 day_key・多日ぶんの実測・タスクツリーが
 * 既に揃っている）で踏む。新規ゴールを毎回作ると開始日は「今日」固定になり、直近3日ペースと
 * 全体平均ペースが同じ1日ぶんの窓に潰れて分岐しようがないため（進捗グラフの数値そのものの仕様）。
 * 2・3(PUT の経路そのもの)・6 は PUT /estimate・/progress を持たないデモ API では踏めないため、
 * 実 API で当日ぶんだけ実測を作って踏む。
 * 5 はモーダルからの編集・保存まで見るため実 API で踏む（デモは閲覧専用で保存動線を出さない）。
 * デモ側ではズーム→日付クリックでタブ遷移せずモーダルが開くところまでを確かめる。
 */

async function createGoal(
  request: APIRequestContext,
  name: string,
  rules: Record<string, unknown>[],
): Promise<{ id: number; name: string }> {
  const res = await request.post('/api/goals', {
    data: {
      name,
      purpose: 'e2e で確かめる状態',
      startReason: 'goal-burnup e2e のため',
      endDay: '2026-12-31',
      rules,
    },
  });
  return res.json();
}

/** 今日ぶんの実測（タイムライン手動記録・TIMELINE 対象の口）。正午〜指定時間ぶん。 */
async function recordToday(request: APIRequestContext, dayKey: string, category: string, hours: number): Promise<void> {
  const start = Date.parse(`${dayKey}T03:00:00.000Z`); // 正午 JST（既定境界 04:00 に確実に収まる）。
  await request.post(`/api/timeline/${dayKey}/manual`, {
    data: { startAt: start, endAt: start + hours * 3600_000, title: category, category },
  });
}

async function dismissOnboarding(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
}

async function startDemo(page: Page): Promise<void> {
  await page.locator('#tabs button[data-target="settings"]').click();
  await page.getByRole('button', { name: '🧪 デモを開始' }).click();
  await expect(page.locator('#demobar')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await dismissOnboarding(page);
});

test('デモ: ペーストグル・タスク達成マーカー（同日まとめ含む）・ズーム→日付クリックでモーダル・大きい沿革からの遷移', async ({ page }) => {
  await startDemo(page);
  const demobar = page.locator('#demobar');
  // 開始前(2026-06-10) → 2026-07-11（凍結明けの分岐が大きく見える進行中の Day）。
  await demobar.getByRole('button', { name: '＋30日' }).click();
  await demobar.getByRole('button', { name: '＋1日' }).click();
  await expect(demobar.locator('.demobar-status')).toContainText('2026-07-11');

  await page.locator('#tabs button[data-target="goals"]').click();
  const mainCard = page.locator('.gr-goal-card', { hasText: 'メンタルを安定させる' });
  await mainCard.getByRole('button', { name: '進捗グラフ', exact: true }).click();

  const card = page.locator('.bu-card');
  await expect(card).toBeVisible();

  // --- 1. ペーストグル: 直近3日へ切り替えると完了予想日が手前の日付に変わる -------------
  await expect(page.locator('.pace-toggle button.active')).toHaveText('全体平均ペース');
  await expect(page.locator('.fc-date-big')).toHaveText('8月6日');
  await page.locator('.pace-toggle button', { hasText: '直近3日ペース' }).click();
  await expect(page.locator('.pace-toggle button.active')).toHaveText('直近3日ペース');
  await expect(page.locator('.fc-date-big')).toHaveText('8月3日'); // 手前へ動く。
  // 選ばれていない側（全体平均）は控えめな表示（凡例外・小さいラベルのみ）で残り、太字の丸は出ない。
  await expect(page.locator('.bu-fc-dim-label')).toContainText('全体平均なら');
  await expect(page.locator('.bu-fc-target-dot')).toHaveCount(1); // 強調の丸は選ばれている側の1つだけ。

  // --- 3・4. タスク達成マーカー: 完了2枝＝黒丸、走行中1枝＝白丸、同日2件完了は1つにまとまる ---
  await expect(page.locator('.bu-ach-dot.branch.done')).toHaveCount(2);
  await expect(page.locator('.bu-ach-dot.branch.todo')).toHaveCount(1);
  await expect(page.locator('.bu-ach-dot.leaf.done')).toHaveCount(1); // 2件が1つの丸にまとまっている。

  await page.locator('.bu-ach-dot.branch.todo').click({ force: true });
  const branchModal = page.locator('.modal-panel');
  await expect(branchModal).toContainText('苦手な質問への回答を用意する（進行中）');
  await expect(branchModal).toContainText('質問をピックアップする');
  await expect(branchModal).toContainText('定番の質問リストを書き出す');
  await expect(branchModal).toContainText('完了'); // クリックで名前と完了日が読める。
  await page.keyboard.press('Escape');

  await page.locator('.bu-ach-dot.leaf.done').click({ force: true });
  const dayModal = page.locator('.modal-panel');
  await expect(dayModal.locator('.modal-header')).toContainText('に完了');
  await expect(dayModal).toContainText('質問をピックアップする');
  await expect(dayModal).toContainText('定番の質問リストを書き出す');
  await page.keyboard.press('Escape');

  // --- 5. 月の帯で絞り込む → 日付が見える粒度になったら日付クリックでモーダルが開く -----------
  await expect(page.locator('.bu-zoom-band').first()).toBeVisible(); // 全期間は40日超なので月表示。
  await expect(page.locator('.bu-viewbar')).toContainText('全期間');
  await page.locator('.bu-zoom-band').first().click({ force: true });
  await expect(page.locator('.bu-viewbar')).toContainText('表示:'); // 絞り込まれた。
  await expect(page.getByRole('button', { name: '← 全期間に戻す' })).toBeVisible();
  await expect(page.locator('.bu-zoom-band')).toHaveCount(0); // 40日以下になり日表示へ切り替わった。

  await page.locator('.bu-day-band').first().click({ force: true });
  const dayModal2 = page.locator('.modal-panel');
  await expect(dayModal2.locator('.modal-header')).toContainText('の振り返り');
  await expect(dayModal2.locator('.rf-alloc-card')).toBeVisible(); // 作業時間バーが読める。
  // タブ遷移はしない（進捗グラフの上にモーダルが載るだけ）。
  await expect(page).not.toHaveURL(/#timeline/);
  await expect(page.locator('#tabs button[data-target="goals"]')).toHaveClass(/active/);
  await expect(page.locator('#screen-goals')).toHaveClass(/active/);
  await page.keyboard.press('Escape');
  await expect(page.locator('.modal-panel')).toHaveCount(0);
  await expect(page.locator('.bu-card')).toBeVisible(); // 進捗グラフに留まっている。

  // --- 7. 大きい沿革の行を選ぶ → 進捗グラフが開く（レポートは存在しない） -------------------
  await page.locator('.bu-back').click(); // 進捗グラフに留まっているので、まず目標一覧へ戻る。
  const historyRow = page.locator('.gr-hist-row', { hasText: 'AtCoderのレーティングを上げる をはじめた' });
  await expect(historyRow).toBeVisible();
  await historyRow.click();
  await expect(page.locator('.bu-title')).toHaveText('AtCoderのレーティングを上げる');
  const reportProbe = await page.request.get('/api/demo/goals/3/report?now=2026-07-11');
  expect(reportProbe.status()).toBe(404);
});

test('デモ: 完走したカードに「続ける」と「終える」が並ぶ', async ({ page }) => {
  await startDemo(page);
  await page.locator('#tabs button[data-target="goals"]').click();

  // GOAL2・GOAL4 は主目標より前の期間のサンプルで、デモ開始直後の仮想日付（開始前）でも既に完走している。
  const card = page.locator('.gr-goal-card', { hasText: '朝の散歩を習慣にする' });
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: '続ける', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: '終える', exact: true })).toBeVisible();
  // 「レポートを開く」は消え、導線の数は変わらない（続ける／タスク一覧／終える／削除は出ない=デモ閲覧専用）。
  await expect(card.getByRole('button', { name: '進捗グラフ', exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'レポートを開く', exact: true })).toHaveCount(0);

  await card.getByRole('button', { name: '続ける', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('Day 1');
  // 続けた先の新しい目標は進捗グラフ（Day1）で開く。
  await expect(page.locator('.bu-title')).toHaveText('朝の散歩を習慣にする');
});

test('本番: 想定時間の変更は完了予想日だけを動かし段差や理由は出さない。完了の記録でマーカーが増える', async ({ page, request }) => {
  const { dayKey } = await (await request.get('/api/summary')).json();
  const goal = await createGoal(request, `burnup-e2e-想定時間${Date.now()}`, [
    { target: 'TIMELINE', label: 'コーディングe2e', thresholdSeconds: 60, reason: 'e2e 用の下限' },
  ]);
  await recordToday(request, dayKey, 'コーディングe2e', 2);

  const bp = await request.post(`/api/goals/${goal.id}/blueprint/import`, {
    data: { text: '- 下準備をする\n  - 資料を集める\n  - 骨子を書く' },
  });
  const rootId = (await bp.json()).nodes[0].id as number;
  const leafIds = (await bp.json()).nodes[0].children.map((c: { id: number }) => c.id) as number[];

  const firstReason = '初回の見立て（e2e）';
  const est1 = await request.put(`/api/tasks/${rootId}/estimate`, {
    data: { estimatedSeconds: 20 * 3600, reason: firstReason, actor: 'agent' },
  });
  expect(est1.status()).toBe(200);

  await page.locator('#tabs button[data-target="goals"]').click();
  const card = page.locator('.gr-goal-card', { hasText: goal.name });
  await card.getByRole('button', { name: '進捗グラフ', exact: true }).click();
  const beforeDate = await page.locator('.fc-date-big').textContent();
  expect(beforeDate).toBeTruthy();
  await expect(page.locator('.bu-card')).not.toContainText(firstReason); // 段差・理由はグラフに出ない。

  const secondReason = '合議で軽いと見直した（e2e）';
  const est2 = await request.put(`/api/tasks/${rootId}/estimate`, {
    data: { estimatedSeconds: 4 * 3600, reason: secondReason, actor: 'human' },
  });
  expect(est2.status()).toBe(200);

  await page.locator('.bu-back').click(); // 既に「目標」タブ内なので、戻ってから開き直す。
  await card.getByRole('button', { name: '進捗グラフ', exact: true }).click();
  await expect(page.locator('.fc-date-big')).not.toHaveText(beforeDate!); // 完了予想日だけが動く。
  await expect(page.locator('.bu-card')).not.toContainText(firstReason);
  await expect(page.locator('.bu-card')).not.toContainText(secondReason);
  await expect(page.locator('.bu-ach-dot.leaf.done')).toHaveCount(0); // まだ何も完了していない。

  // PUT /progress は小数の進捗を置くだけで、マーカーは作らない（design: task-estimate D2）。
  const prog = await request.put(`/api/tasks/${leafIds[1]}/progress`, {
    data: { ratio: 0.5, reason: '半分くらい読めている（e2e）', actor: 'agent' },
  });
  expect(prog.status()).toBe(200);

  // 完了は subtree-done で作る（マーカーの対象は status=DONE）。
  const done = await request.post(`/api/tasks/${leafIds[0]}/subtree-done`, { data: { done: true } });
  expect(done.status()).toBe(200);

  await page.locator('.bu-back').click();
  await card.getByRole('button', { name: '進捗グラフ', exact: true }).click();
  await expect(page.locator('.bu-ach-dot.leaf.done')).toHaveCount(1); // その日にマーカーが増える。
  await page.locator('.bu-ach-dot.leaf.done').click({ force: true });
  await expect(page.locator('.modal-panel')).toContainText('資料を集める'); // クリックで名前と完了日が読める。
  const [, mm, dd] = dayKey.split('-').map(Number);
  await expect(page.locator('.modal-panel')).toContainText(`${mm}月${dd}日`);
});

test('本番: 計測対象を持たない目標の進捗グラフは空状態になり、数値の欠損を出さない', async ({ page, request }) => {
  const goal = await createGoal(request, `burnup-e2e-空状態${Date.now()}`, [
    { target: 'MANUAL_CHECK', label: '毎日チェックe2e', reason: 'e2e 用' },
  ]);

  await page.locator('#tabs button[data-target="goals"]').click();
  const card = page.locator('.gr-goal-card', { hasText: goal.name });
  await card.getByRole('button', { name: '進捗グラフ', exact: true }).click();

  await expect(page.locator('.bu-target')).toHaveText('計測対象: 未設定');
  await expect(page.locator('.bu-empty-box')).toContainText('まだ何で測るか決まっていません');
  await expect(page.locator('.bu-empty-cta')).toBeVisible();
  await expect(page.locator('.bu-svg')).toHaveCount(0); // グラフ本体は出さない。
  const bodyText = (await page.locator('.bu-card').innerText()) ?? '';
  expect(bodyText).not.toMatch(/NaN|undefined|null/);
});

test('本番: 日付クリックで振り返りがモーダルで開き、編集した本文が保存されて開き直しても残る', async ({ page, request }) => {
  const { dayKey } = await (await request.get('/api/summary')).json();
  const goal = await createGoal(request, `burnup-e2e-振り返りモーダル${Date.now()}`, [
    { target: 'TIMELINE', label: '執筆e2e', thresholdSeconds: 60, reason: 'e2e 用の下限' },
  ]);
  await recordToday(request, dayKey, '執筆e2e', 3);

  await page.locator('#tabs button[data-target="goals"]').click();
  const card = page.locator('.gr-goal-card', { hasText: goal.name });
  await card.getByRole('button', { name: '進捗グラフ', exact: true }).click();
  await expect(page.locator('.bu-card')).toBeVisible();

  // 期間が40日超なので月の帯 → クリックで日単位まで絞り込む（サーバへは問い合わせ直さない）。
  const burnupCalls: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/burnup')) burnupCalls.push(r.url()); });
  await expect(page.locator('.bu-zoom-band').first()).toBeVisible();
  await page.locator('.bu-zoom-band').first().click({ force: true });
  await expect(page.locator('.bu-zoom-band')).toHaveCount(0);
  await expect(page.locator('.bu-day-band').first()).toBeAttached();
  expect(burnupCalls).toHaveLength(0);

  // 日付クリック → タブ遷移せず、作業時間バーと本文エディタがモーダルで開く。
  await page.locator('.bu-day-band').first().click({ force: true });
  const modal = page.locator('.modal-panel');
  const [, mm, dd] = dayKey.split('-').map(Number);
  await expect(modal.locator('.modal-header')).toContainText(`${mm}月${dd}日 の振り返り`);
  await expect(modal.locator('.rf-alloc-card')).toContainText('一日の配分');
  await expect(modal.locator('.rf-bar-row', { hasText: '執筆e2e' })).toContainText('3h'); // 記録した3時間が読める。
  await expect(modal.locator('.rf-ed')).toBeVisible();
  await expect(page).not.toHaveURL(/#timeline/);
  await expect(page.locator('#screen-goals')).toHaveClass(/active/);

  // 本文を編集して保存する（既存の PUT /api/reflection/:date だけを使う）。
  const body = `進捗グラフのモーダルから書いた本文${Date.now()}`;
  const putUrls: string[] = [];
  page.on('request', (r) => { if (r.method() === 'PUT' && r.url().includes('/api/reflection/')) putUrls.push(r.url()); });
  await modal.locator('.rf-ed').click();
  await page.keyboard.type(body);
  await modal.getByRole('button', { name: '保存する' }).click();
  await expect(modal.locator('.rf-saved')).toHaveClass(/show/);
  await expect.poll(() => putUrls.length).toBeGreaterThan(0);
  expect(putUrls[0]).toContain(`/api/reflection/${dayKey}`);

  // 開き直しても保存内容が反映されている。
  await page.keyboard.press('Escape');
  await expect(page.locator('.modal-panel')).toHaveCount(0);
  await page.locator('.bu-day-band').first().click({ force: true });
  await expect(page.locator('.modal-panel .rf-ed')).toContainText(body);
});
