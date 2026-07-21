import { test, expect, type APIRequestContext } from '@playwright/test';

/**
 * 長期目標ループの通し E2E（long-term-goal-loop / issue #54）。
 * `ユーザーフロー.md` の背骨を1本で踏む:
 *   振り返りタブで Plan＋Check を仕掛ける → 今日タブで不足条件に出る＆パスワードが出ない
 *   → その場で写真を出す → ゲートが開く → 目標タブでレポートプレビュー → ⑤沿革に載っている
 *
 * ★日付を跨ぐ挙動（単発の繰り越し・範囲の非繰り越し・未到来）はここでは扱わない。
 * 実時刻に依存せず1日で完結する筋だけを踏む（日付が絡む挙動は
 * goal-check-state.test.ts / rules.test.ts / goals.test.ts のユニット側で固めている）。
 *
 * インメモリ DB（本番非干渉）。ゲートを「他の条件は全部満たした」状態にしてから Check を足し、
 * Check だけがロックの原因である状況を作る。
 */

const CHECK_LABEL = '振り返りを書いた';
const PLAN_BODY = 'ボリュームアップシャンプーを使えば髪質が良くなるのではないだろうか';
const CAPTION = '前髪・正面';
const QUESTION = '使用感はどうだった？';

/** 1x1 の最小 PNG（写真提出用）。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * 手動チェック1つだけのルールを当日へ置き、その実践を採用した進行中の目標を作る。
 *
 * ここでは**まだチェックを付けない**。先に付けると解錠が latch し（一度 UNLOCKED になったら
 * relock しない）、後から Check を足してもゲートが閉じず、この筋を踏めなくなる。
 * 「他の条件を満たす」のは Check を仕掛けた後に行う（ユーザーフローの順序どおり）。
 */
async function seedGoal(request: APIRequestContext): Promise<string> {
  const { dayKey } = await (await request.get('/api/summary')).json();

  await request.put(`/api/rules/${dayKey}`, {
    data: { combinator: 'ALL', conditions: [{ target: 'MANUAL_CHECK', label: CHECK_LABEL }] },
  });
  const goal = await request.post('/api/goals', {
    data: { name: '髪質を改善する', purpose: '髪で悩まない', practices: [`manual:${CHECK_LABEL}`], start: 'today' },
  });
  expect(goal.ok()).toBeTruthy();
  return dayKey;
}

test('Plan を仕掛け → 今日タブで詰まり → 写真で開き → 沿革に載る（ユーザーフローの背骨）', async ({ page }) => {
  const dayKey = await seedGoal(page.request);
  await page.goto('/');
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});

  // --- 1. 振り返りタブ: Plan を書き、Check（📷×単発・今日）を仕掛ける ---------
  await page.locator('#tabs button[data-target="reflection"]').click();
  const block = page.locator('.pc-block');
  await expect(block).toBeVisible();

  await block.getByRole('button', { name: '＋ Plan' }).click();
  await block.locator('.pc-textarea').fill(PLAN_BODY);
  await block.getByRole('button', { name: '保存' }).click();

  const plan = page.locator('.pc-plan', { hasText: PLAN_BODY });
  await expect(plan).toBeVisible();

  await plan.getByRole('button', { name: '＋ Check' }).click();
  const form = plan.locator('.pc-checkform');
  await expect(form).toBeVisible();

  // 種類=📷（既定）・撮るもの。「いつ」は単発（既定）で、開始日を今日にして当日ゲートへ効かせる。
  await form.locator('.pc-input[type="text"]').first().fill(CAPTION);
  await form.locator('.pc-input-date').fill(dayKey);
  await plan.getByRole('button', { name: 'Check を足す' }).click();

  // 仕掛け中として並ぶ。
  await expect(page.locator('.pc-pending-row', { hasText: CAPTION })).toBeVisible();

  // 2つ目: 💬×範囲。★種類を切り替えても「いつ」の選択は影響を受けない（2軸が独立）。
  await plan.getByRole('button', { name: '＋ Check' }).click();
  const form2 = plan.locator('.pc-checkform');
  await form2.getByRole('button', { name: '範囲' }).click(); // 先に「いつ」を範囲にする。
  await expect(form2.locator('.pc-input-num')).toBeVisible();
  await form2.getByText('💬 質問に答える').click(); // 後から種類を切り替える。
  // 種類を変えても「範囲」の選択と日数入力はそのまま残っている。
  await expect(form2.getByRole('button', { name: '範囲' })).toHaveClass(/on/);
  await expect(form2.locator('.pc-input-num')).toBeVisible();

  await form2.locator('.pc-input[type="text"]').nth(1).fill(QUESTION); // 質問文。
  await form2.locator('.pc-input-date').fill(dayKey);
  await form2.locator('.pc-input-num').fill('7');
  await plan.getByRole('button', { name: 'Check を足す' }).click();
  await expect(page.locator('.pc-pending-row', { hasText: QUESTION })).toBeVisible();

  // --- 2. 今日タブ: 不足条件に出て、パスワードが表示されない -------------------
  await page.locator('#tabs button[data-target="today"]').click();

  const checkRow = page.locator('.cond-check', { hasText: CAPTION });
  await expect(checkRow).toBeVisible();
  await expect(checkRow).toContainText('📷');
  await expect(checkRow.locator('.cond-plan')).toContainText(PLAN_BODY); // 由来の Plan が辿れる。
  await expect(checkRow.locator('.mark')).toHaveText('✗');

  // 範囲Check は「期間の何日目の分か」まで出る（各日が独立して要求されるため）。
  const rangeRow = page.locator('.cond-check', { hasText: QUESTION });
  await expect(rangeRow.locator('.cond-sub').first()).toContainText('未回答');
  await expect(rangeRow.locator('.cond-sub').first()).toContainText('の1日目');

  // 他の条件（手動チェック）を満たす。
  await page.locator('.cond', { hasText: CHECK_LABEL }).locator('input[type="checkbox"]').check();
  await expect(page.locator('.cond', { hasText: CHECK_LABEL }).locator('.mark')).toHaveText('✓');

  // 他の条件を全部満たしても、Check が未達なのでゲートは閉じたまま＝パスワードは出ない。
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
  // 写真Check がまだ未達なので、ここではまだ開かない。
  await expect(page.locator('.gate-hero.locked')).toBeVisible();

  // 写真はキャプションを聞かれない（入力欄は無く、確認の文言だけが出る）。
  await expect(checkRow.locator('.cond-hint')).toContainText(`「${CAPTION}」で保存されます`);
  await checkRow.locator('.cond-file').setInputFiles({ name: 'front.png', mimeType: 'image/png', buffer: PNG });

  await expect(page.locator('.gate-hero.unlocked')).toBeVisible();
  await expect(page.locator('.gate-hero')).toContainText('UNLOCKED');
  // 提出した Check は ✅ に変わり、答える導線は消える（もう不足条件ではない）。
  await expect(checkRow.locator('.mark')).toHaveText('✓');
  await expect(checkRow.locator('.cond-actions')).toHaveCount(0);
  // 達成したのでパスワードが表示できる状態になる（生成コマンドは走らせない）。
  await expect(page.locator('.card', { hasText: 'パスワード' })).toContainText('達成済み');

  // --- 4. 目標タブ: 走行中プレビュー → ⑤沿革に載っている ----------------------
  await page.locator('#tabs button[data-target="goals"]').click();
  const card = page.locator('.gr-goal-card', { hasText: '髪質を改善する' });
  // 進行中の導線は「レポートプレビュー」（完走後は「レポートを開く」）。
  await card.getByRole('button', { name: 'レポートプレビュー' }).click();

  const chronicle = page.locator('.gr-card', { hasText: '⑤ 沿革' });
  await expect(chronicle).toBeVisible();
  await expect(chronicle).toContainText(PLAN_BODY);
  await expect(chronicle.locator('.gr-chr-cap').first()).toContainText(CAPTION); // 写真の見出し。
  await expect(chronicle.locator('.gr-chr-plate-img')).toHaveCount(1); // 提出した写真が図版として載る。
  // 質問は Q&A で載り、範囲Check は「7日のうち1日。」を事実どおり示す。
  await expect(chronicle).toContainText(QUESTION);
  await expect(chronicle.locator('.gr-chr-qa p')).toContainText('泡立ちは良い');
  await expect(chronicle.locator('.gr-chr-note')).toContainText('7日のうち1日');
  // 日記は沿革に載らない（④日記リーダーが読む）。
  await expect(chronicle).not.toContainText('記録なし');

  // 走行中プレビューでは最終日写真の CTA を出さない（最終日がまだ来ていない）。
  await expect(page.locator('.gr-report')).not.toContainText('最終日の写真を追加');
  // ①カレンダーは Day1 以外が未到来＝空白（残りを未達成マスで埋めない）。
  // 凡例のスウォッチも .gr-cell を使うのでグリッド内に絞って数える。
  await expect(page.locator('.gr-cal .gr-cell.future')).toHaveCount(29);
  await expect(page.locator('.gr-cal .gr-cell.miss')).toHaveCount(0); // 未到来を未達成マスにしない。
});
