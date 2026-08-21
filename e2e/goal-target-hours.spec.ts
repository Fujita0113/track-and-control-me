import { test, expect } from './fixtures.js';
import { addDaysKey } from './goal-input.js';

/**
 * 目標時間・大きい沿革の通し E2E（issue #76 / spec: goal-target-hours・goal-history・
 * goal-lifecycle-fork ADDED）。`ユーザーフロー.md` の背骨を1本で踏む:
 *
 *   目標タブで「期限を日付指定・目標時間つき・証拠写真キャプションつき・初期写真つき」で作成
 *   → カードに「めざす状態」と「今日 あと …」が出る
 *   → めざした状態「できなかった」＋写真＋理由で終える
 *   → 大きい沿革の行に3つ（到達判定・答え・Before→After）が並ぶ
 *
 * 行から先の遷移（旧: レポート）は goal-report 廃止に伴い削除。進捗グラフへの遷移は apply が新規 e2e で覆う。
 *
 * インメモリ DB（本番非干渉）・実時刻に依存せず1日で完結する筋だけを踏む。
 */

const GOAL_NAME = 'goal-target-hours e2e チャレンジ';
const PURPOSE = 'アルゴリズムを一通り自力で実装できるようになっている';
const START_REASON = 'e2e のため集中して伸びを試したい';
const OUTCOME_CAPTION = 'e2e 証拠写真';
const END_REASON = '試験勉強はもう大丈夫。設計に切り替えたい';

/** 1x1 の最小 PNG（初期写真・証拠写真の提出用）。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('目標時間つきで作成 → カードにペース → 理由つきで終える → 大きい沿革に3つ並ぶ', async ({ page }) => {
  const { dayKey } = await (await page.request.get('/api/summary')).json();
  const endDay = addDaysKey(dayKey, 6); // 1週間チャレンジ。

  await page.goto('/');
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
  await page.locator('#tabs button[data-target="goals"]').click();

  // --- 1. 目標タブ: 期限を日付指定・目標時間つき・証拠写真キャプションつき・初期写真つきで作成 ---
  await page.getByRole('button', { name: '＋ 新しい目標' }).click();
  const modal = page.locator('.modal-panel');
  await expect(modal).toBeVisible();

  await modal.getByPlaceholder('目標名（例: メンタルを安定させる）').fill(GOAL_NAME);
  await modal.locator('.gr-purpose-input').fill(PURPOSE);
  await modal.locator('.gr-startreason-input').fill(START_REASON);

  // 期限は日付で自由指定する（30日固定の撤廃・spec: goal-challenge）。
  await modal.locator('.gr-end-day-input').fill(endDay);

  // 証拠写真（任意）: 「終わるときに証拠写真を出す」を決め、キャプションと初期写真(Before)を置く。
  await modal.locator('.gr-outcome-check').check();
  await modal.locator('.gr-outcome-caption-input').fill(OUTCOME_CAPTION);
  await modal.locator('.gr-outcome-body .rf-img-file').setInputFiles({ name: 'before.png', mimeType: 'image/png', buffer: PNG });
  await expect(modal.locator('.gr-outcome-body .rf-thumb-img')).toBeVisible();

  // 目標時間（任意）: 総作業時間 2h/日。パスワードの条件にはならない（下限ルールとは別物）。
  await modal.locator('.gr-th-check').check();
  await modal.locator('.gr-th-body select').selectOption('TOTAL_WORK');
  await modal.locator('.gr-th-minutes-input').fill('120');

  // 下限ルール（この目標で守ること）を1つ作る。
  const ruleForm = modal.locator('.gr-newcond-editor').first();
  await ruleForm.locator('select').first().selectOption('MANUAL_CHECK');
  await ruleForm.locator('.pc-input[type="text"]').fill('毎日1問解く');
  await ruleForm.locator('.pc-textarea').fill('崩さない下限');

  await modal.getByRole('button', { name: '作成', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('目標を作成しました');

  // --- 2. カードに「めざす状態」と「今日 あと …」が出る ---------------------------
  const card = page.locator('.gr-goal-card', { hasText: GOAL_NAME });
  await expect(card).toBeVisible();
  await expect(card.locator('.gr-purpose')).toContainText(`めざす状態: ${PURPOSE}`);
  await expect(card.locator('.gr-pace')).toBeVisible();
  await expect(card.locator('.gr-pace')).toContainText('パスワードの条件になりません');
  await expect(card.locator('.gr-pace-remain')).toContainText('今日 あと');

  // --- 3. めざした状態「できなかった」＋証拠写真＋理由で終える（進行中でもいつでも終えられる）---
  await card.getByRole('button', { name: '終える', exact: true }).click();
  const endModal = page.locator('.modal-panel');
  await expect(endModal).toBeVisible();
  await endModal.getByRole('button', { name: 'できなかった' }).click();
  await endModal.locator('.rf-img-file').setInputFiles({ name: 'after.png', mimeType: 'image/png', buffer: PNG });
  await expect(endModal.locator('.rf-thumb-img')).toBeVisible();
  await endModal.locator('.gr-end-reason-input').fill(END_REASON);
  await endModal.getByRole('button', { name: 'この目標を終える' }).click();
  await expect(page.locator('.toast')).toContainText('明日からこの目標を終えます');

  // 終了は翌日発効なので、当日は進行中のまま「終了予約中」バッジが付く（spec: goal-challenge MODIFIED）。
  const endedCard = page.locator('.gr-goal-card', { hasText: GOAL_NAME });
  await expect(endedCard.locator('.badge', { hasText: '終了予約中' })).toBeVisible();

  // --- 4. 大きい沿革の行に3つ（到達判定・答え・Before→After）が並ぶ -------------------
  const history = page.locator('.gr-history');
  await expect(history).toBeVisible();
  // 発効前でも「−終える」の行は並ぶ（`ended_day_key` 由来・予約中の印つき・spec: goal-history MODIFIED）。
  const endedRow = history.locator('.gr-hist-row', { hasText: `${GOAL_NAME} を終えた` });
  await expect(endedRow).toBeVisible();
  await expect(endedRow).toContainText('予約中');
  await expect(endedRow).toContainText(END_REASON);
  // ① 到達判定（目標2h/日に対し実測0なので未達＝×）。
  await expect(endedRow.locator('.gr-hist-tag.miss', { hasText: '平均' })).toBeVisible();
  // ② めざした状態の答え（できなかった＝×）。
  await expect(endedRow.locator('.gr-hist-tag.miss', { hasText: 'めざした状態: できなかった' })).toBeVisible();
  // ③ 証拠写真（Before→After）。
  await expect(endedRow.locator('.gr-fig-cap', { hasText: 'Before' })).toBeVisible();
  await expect(endedRow.locator('.gr-fig-cap', { hasText: 'After' })).toBeVisible();
});
