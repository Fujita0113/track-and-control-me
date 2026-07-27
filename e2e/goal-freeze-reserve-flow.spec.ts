import { test, expect, type APIRequestContext } from '@playwright/test';

/**
 * 一時凍結の予約フロー（spec: goal-freeze・issue #60）。
 *
 * 「予約した当日は効かない（翌日発効）」という凍結の核となる制約を、実ブラウザ＋実サーバーで
 * 確認する: 振り返りタブで凍結を予約する → 予約した当日の今日タブのゲートは変わらない →
 * 月枠はアプリ全体で1つなので他の目標のカードにも及ぶ → 発効前に取り消すと枠が戻る。
 *
 * ★発効・解除など日付を跨ぐ挙動は実時刻に依存させず単体テスト側（goal-freeze.test.ts /
 * goals-freeze.test.ts）で固めてある。実ブラウザの e2e では実時刻を跨げないため、
 * 日付を跨ぐ挙動はここでは扱わない（goal-rule-gate-loop.spec.ts と同じ方針）。
 */

function addDays(dayKey: string, n: number): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + n);
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

const GOAL_A = '設計理解をしたい';
const GOAL_B = '茶色取りたい';
const CHECK_A = '素振り';
const CHECK_B = '腹筋';
const FREEZE_REASON = 'OpenWork の大タスクに数日ぶん全振りする';

async function seedGoal(request: APIRequestContext, name: string, checkLabel: string, dayKey: string): Promise<void> {
  const res = await request.post('/api/goals', {
    data: {
      name,
      purpose: 'テスト用',
      start: 'today',
      rules: [{ target: 'MANUAL_CHECK', label: checkLabel, startDay: dayKey, endDay: null, reason: '毎日やる' }],
    },
  });
  expect(res.ok()).toBeTruthy();
}

test('凍結を予約しても当日のゲートは変わらず、月枠は他の目標にも及び、取消すると戻る', async ({ page, request }) => {
  const { dayKey } = await (await request.get('/api/summary')).json();
  const freezeEnd = addDays(dayKey, 5);

  await seedGoal(request, GOAL_A, CHECK_A, dayKey);
  await seedGoal(request, GOAL_B, CHECK_B, dayKey);

  await page.goto('/');
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});

  // --- 1. 今日タブ: 凍結前は両方のルールがゲートに現れる（前提の確認） ---------
  await page.locator('#tabs button[data-target="today"]').click();
  await expect(page.locator('.cond', { hasText: CHECK_A }).first()).toBeVisible();
  await expect(page.locator('.cond', { hasText: CHECK_B }).first()).toBeVisible();

  // --- 2. 振り返りタブ: モーダルから目標Aの凍結を予約する -------------------------
  await page.locator('#tabs button[data-target="reflection"]').click();
  const cardA = page.locator('.rf-journal').filter({ has: page.locator('.rf-journal-title', { hasText: GOAL_A }) });
  await expect(cardA).toBeVisible();
  const freezeBlockA = cardA.locator('.gf-block').first();
  await expect(freezeBlockA).toContainText('今月の凍結枠は空いています');

  // モーダルを起動
  const triggerBtn = cardA.getByRole('button', { name: /一時凍結/ }).first();
  await triggerBtn.scrollIntoViewIfNeeded();
  await triggerBtn.click();
  const modal = page.locator('.modal-root').filter({ hasText: '目標を一時凍結する' });
  await expect(modal).toContainText(GOAL_A);
  await expect(modal).toContainText(CHECK_A);

  await modal.locator('textarea').fill(FREEZE_REASON);
  await modal.locator('input[type="date"]').fill(freezeEnd);
  await modal.getByRole('button', { name: /一時凍結を予約/ }).click();

  await expect(page.locator('.toast')).toContainText('凍結を予約しました');
  await expect(cardA.locator('.gf-block').first()).toContainText('一時凍結（予約中）');
  await expect(cardA.locator('.gf-block').first()).toContainText(FREEZE_REASON);

  // --- 3. 予約した当日は今日タブのゲートに変わりが無い（翌日発効・design D5の核） ---
  await page.locator('#tabs button[data-target="today"]').click();
  await expect(page.locator('.cond', { hasText: CHECK_A }).first()).toBeVisible();
  await expect(page.locator('.cond', { hasText: CHECK_B }).first()).toBeVisible();

  // --- 4. 月枠はアプリ全体で1つ。目標Bのカードにも使用済みである旨が出て、
  //        予約ボタンは表示されない ---------------------------
  await page.locator('#tabs button[data-target="reflection"]').click();
  const cardB = page.locator('.rf-journal').filter({ has: page.locator('.rf-journal-title', { hasText: GOAL_B }) });
  const freezeBlockB = cardB.locator('.gf-block').first();
  await expect(freezeBlockB).toContainText('今月の凍結枠は使用済みです');
  await expect(freezeBlockB).toContainText(GOAL_A);
  await expect(freezeBlockB.getByRole('button', { name: /一時凍結する/ })).toHaveCount(0);

  // --- 5. 発効前の取消で枠が戻る（両方の目標カードに反映される） --------------
  page.once('dialog', (d) => d.accept());
  await freezeBlockA.getByRole('button', { name: '取消' }).click();
  await expect(page.locator('.toast')).toContainText('取り消しました');
  await expect(cardA.locator('.gf-block')).toContainText('今月の凍結枠は空いています');
  await expect(cardB.locator('.gf-block')).toContainText('今月の凍結枠は空いています');
});

