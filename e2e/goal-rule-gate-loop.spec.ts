import { test, expect, type APIRequestContext } from '@playwright/test';
import { thirtyDayEnd } from './goal-input.js';

/**
 * 目標ルールのループの通し E2E（goal-rule-lifecycle / issue #59 後の背骨）。
 * `ユーザーフロー.md` の背骨を1本で踏む:
 *   振り返りタブの目標コーナーでルール（📷単発・💬範囲）を足す
 *   → 今日タブで不足条件に出る＆パスワードが出ない
 *   → その場で写真・答えを出す → ゲートが開く → 目標タブでレポートプレビュー → ⑤沿革に載る
 *
 * ★日付を跨ぐ挙動（単発の繰り越し・範囲の非繰り越し・未到来）はここでは扱わない。
 * 実時刻に依存せず1日で完結する筋だけを踏む（日付が絡む挙動は
 * goals.test.ts / rule-registry.test.ts のユニット側で固めている）。
 *
 * インメモリ DB（本番非干渉）。ゲートを「他の条件は全部満たした」状態にしてから写真ルールを残し、
 * 写真だけがロックの原因である状況を作る。
 */

const CHECK_LABEL = '振り返りを書いた';
const CAPTION = '前髪・正面';
const QUESTION = '使用感はどうだった？';
const GOAL_NAME = '髪質を改善する';
const PHOTO_REASON = 'ボリュームアップシャンプーを使えば髪質が良くなるのではないだろうか';
const QUESTION_REASON = '使用感を毎日記録して効き目を確かめたい';

/** 1x1 の最小 PNG（写真提出用）。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * 手動チェック1つだけを持つ進行中の目標を作る（ルールは目標に直接ぶら下がる・採用モデルは撤去済み）。
 *
 * ここでは**まだチェックを付けない**。先に付けると解錠が latch し（一度 UNLOCKED になったら
 * relock しない）、後から写真ルールを足してもゲートが閉じず、この筋を踏めなくなる。
 * 「他の条件を満たす」のは写真/質問ルールを足した後に行う（ユーザーフローの順序どおり）。
 */
async function seedGoal(request: APIRequestContext): Promise<string> {
  const { dayKey } = await (await request.get('/api/summary')).json();

  const goal = await request.post('/api/goals', {
    data: {
      name: GOAL_NAME,
      purpose: '髪で悩まない',
      startReason: 'e2e のため',
      start: 'today',
      endDay: thirtyDayEnd(dayKey),
      rules: [{ target: 'MANUAL_CHECK', label: CHECK_LABEL, startDay: dayKey, endDay: null, reason: '毎日振り返る' }],
    },
  });
  expect(goal.ok()).toBeTruthy();
  return dayKey;
}

test('ルールを足す → 今日タブで詰まり → 写真で開き → 沿革に載る（ユーザーフローの背骨）', async ({ page }) => {
  const dayKey = await seedGoal(page.request);
  await page.goto('/');
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});

  // --- 1. 振り返りタブ: 目標コーナーで 📷×単発・💬×範囲 のルールを足す ---------
  await page.locator('#tabs button[data-target="reflection"]').click();
  // 他specが同じ共有DBに作ったgoalも同時に .pc-block を持つため、自分のgoalのカードへ絞る。
  const journal = page.locator('.rf-journal').filter({ has: page.locator('.rf-journal-title', { hasText: GOAL_NAME }) });
  const block = journal.locator('.pc-block');
  await expect(block).toBeVisible();

  // 1つ目: 📷×単発（今日）。当日ゲートへ効かせる。
  await block.getByRole('button', { name: '＋ 追加' }).click();
  const form = page.locator('.modal-panel .pc-checkform');
  await expect(form).toBeVisible();

  await form.locator('select').first().selectOption('PHOTO');
  await form.locator('.pc-input[type="text"]').fill(CAPTION);
  await form.getByRole('button', { name: '単発' }).click();
  await form.locator('.pc-input-date').first().fill(dayKey); // 開始日（終了日は「単発」では隠れている）。
  await form.locator('.pc-textarea').fill(PHOTO_REASON);
  await page.locator('.modal-panel').getByRole('button', { name: 'ルールを追加' }).click();

  // ルール一覧に並ぶ（沿革の「最近の変更」にも載る）。
  await expect(block.locator('.pc-plan', { hasText: CAPTION })).toBeVisible();

  // 2つ目: 💬×範囲。★種類を切り替えても「いつ」の選択は影響を受けない（2軸が独立）。
  await block.getByRole('button', { name: '＋ 追加' }).click();
  const form2 = page.locator('.modal-panel .pc-checkform');
  await expect(form2).toBeVisible();

  await form2.getByRole('button', { name: '範囲' }).click(); // 先に「いつ」を範囲にする。
  const endField = form2.locator('.pc-field', { hasText: '終了' });
  await expect(endField).toBeVisible();
  await form2.locator('select').first().selectOption('QUESTION'); // 後から種類を切り替える。
  // 種類を変えても「範囲」の選択と終了日の入力欄はそのまま残っている。
  await expect(form2.getByRole('button', { name: '範囲' })).toHaveClass(/on/);
  await expect(endField).toBeVisible();

  await form2.locator('.pc-input[type="text"]').fill(QUESTION); // 質問文。
  await form2.locator('.pc-input-date').first().fill(dayKey); // 開始日＝今日（終了日は既定の +6日＝7日間）。
  await form2.locator('.pc-textarea').fill(QUESTION_REASON);
  await page.locator('.modal-panel').getByRole('button', { name: 'ルールを追加' }).click();

  await expect(block.locator('.pc-plan', { hasText: QUESTION })).toBeVisible();

  // --- 2. 今日タブ: 不足条件に出て、パスワードが表示されない -------------------
  await page.locator('#tabs button[data-target="today"]').click();

  const checkRow = page.locator('.cond-check', { hasText: CAPTION });
  await expect(checkRow).toBeVisible();
  await expect(checkRow).toContainText('📷');
  await expect(checkRow.locator('.cond-plan')).toContainText(GOAL_NAME); // 由来の目標が辿れる。
  await expect(checkRow.locator('.mark')).toHaveText('✗');

  // 範囲ルールは「期間の何日目の分か」まで出る（各日が独立して要求されるため）。
  const rangeRow = page.locator('.cond-check', { hasText: QUESTION });
  await expect(rangeRow.locator('.cond-sub').first()).toContainText('未回答');
  await expect(rangeRow.locator('.cond-sub').first()).toContainText('の1日目');

  // 他の条件（手動チェック）を満たす。
  await page.locator('.cond', { hasText: CHECK_LABEL }).locator('input[type="checkbox"]').check();
  await expect(page.locator('.cond', { hasText: CHECK_LABEL }).locator('.mark')).toHaveText('✓');

  // 他の条件を全部満たしても、写真/質問が未達なのでゲートは閉じたまま＝パスワードは出ない。
  await expect(page.locator('.gate-hero.locked')).toBeVisible();
  await expect(page.locator('.gate-hero.unlocked')).toHaveCount(0);
  await expect(page.locator('.card', { hasText: 'パスワード' })).toContainText('未達成のためパスワードは表示できません');

  // --- 3. その場で答える（写真・質問）→ ゲートが開く ---------------------------
  // 質問はその場で答える。空回答は拒否される。
  await rangeRow.locator('.cond-answer').fill('   ');
  await rangeRow.getByRole('button', { name: '答える' }).click();
  await expect(page.locator('.toast')).toContainText('答えを入力してください');
  await expect(page.locator('.gate-hero.locked')).toBeVisible(); // まだ開かない。

  await rangeRow.locator('.cond-answer').fill('泡立ちは良い。乾燥は減った気がする');
  await rangeRow.getByRole('button', { name: '答える' }).click();
  await expect(page.locator('.cond-check', { hasText: QUESTION }).locator('.mark')).toHaveText('✓');
  // 写真ルールがまだ未達なので、ここではまだ開かない。
  await expect(page.locator('.gate-hero.locked')).toBeVisible();

  // 写真はキャプションを聞かれない（入力欄は無く、確認の文言だけが出る）。
  await expect(checkRow.locator('.cond-hint')).toContainText(`「${CAPTION}」で保存されます`);
  await checkRow.locator('.cond-file').setInputFiles({ name: 'front.png', mimeType: 'image/png', buffer: PNG });

  await expect(page.locator('.gate-hero.unlocked')).toBeVisible();
  await expect(page.locator('.gate-hero')).toContainText('UNLOCKED');
  // 提出したルールは ✓ に変わり、答える導線は消える（もう不足条件ではない）。
  await expect(checkRow.locator('.mark')).toHaveText('✓');
  await expect(checkRow.locator('.cond-actions')).toHaveCount(0);
  // 達成したのでパスワードが表示できる状態になる（生成コマンドは走らせない）。
  await expect(page.locator('.card', { hasText: 'パスワード' })).toContainText('達成済み');

  // --- 4. 目標タブ: 走行中プレビュー → ⑤沿革に載っている ----------------------
  await page.locator('#tabs button[data-target="goals"]').click();
  const card = page.locator('.gr-goal-card', { hasText: GOAL_NAME });
  // 進行中の導線は「レポートプレビュー」（完走後は「レポートを開く」）。
  await card.getByRole('button', { name: 'レポートプレビュー' }).click();

  const chronicle = page.locator('.gr-card', { hasText: '⑤ 沿革' });
  await expect(chronicle).toBeVisible();
  // ルール追加が理由つきの年表として並ぶ（Plan の入れ子ではなく rule_change の時系列）。
  await expect(chronicle).toContainText(CAPTION);
  await expect(chronicle).toContainText(PHOTO_REASON);
  await expect(chronicle.locator('.gr-chr-plate-img')).toHaveCount(1); // 提出した写真が図版として載る。
  // 質問は Q&A としてぶら下がる。
  await expect(chronicle).toContainText(QUESTION);
  await expect(chronicle.locator('.gr-chr-qa p')).toContainText('泡立ちは良い');

  // 走行中プレビューでは最終日写真の CTA を出さない（最終日がまだ来ていない）。
  await expect(page.locator('.gr-report')).not.toContainText('最終日の写真を追加');
  // ①カレンダーは Day1 の3ルールだけが埋まり、Day2 以降は未到来／対象外＝空白。
  // 凡例のスウォッチも .gr-cell を使うのでグリッド内に絞って数える。
  await expect(page.locator('.gr-cal .gr-cell.done')).toHaveCount(3);
  await expect(page.locator('.gr-cal .gr-cell.miss')).toHaveCount(0); // 未到来を未達成マスにしない。
  await expect(page.locator('.gr-cal .gr-cell.future')).toHaveCount(87); // 3ルール × 残り29日。
});
