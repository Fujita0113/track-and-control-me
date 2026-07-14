import { test, expect } from '@playwright/test';

/**
 * かんばんの「カテゴリ付けモード」E2E（kanban-task-category / tasks 4.4・4.5）。
 * インメモリ DB（本番非干渉）で、モードON→タスク作成→カテゴリ選択→カードにバッジ、
 * スキップ経路（Esc で未分類）、モードOFF時の連続作成不変を実ブラウザで確認する。
 * 空 DB のためグループ候補は無く、自由入力／その他／スキップ経路を検証する
 * （グループ由来の焼き込みはサービス／API テストで担保）。
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // 初回オンボーディングが出たら閉じる（クリックを遮らないように）。
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
  await page.locator('#tabs button[data-target="kanban"]').click();
  await expect(page.locator('.kb')).toBeVisible();
});

/** カテゴリ付けトグルを ON にする。 */
async function enableCategorize(page: import('@playwright/test').Page) {
  await page.locator('.kb-chip', { hasText: 'カテゴリ付け' }).locator('.kb-switch').click();
}

/** TODO 列のコンポーザにタイトルを入れて Enter で作成する。 */
async function addTask(page: import('@playwright/test').Page, title: string) {
  const todo = page.locator('.kb-col[data-col="TODO"]');
  await todo.locator('.kb-add').click();
  const composer = todo.locator('textarea.kb-composer');
  await composer.fill(title);
  await composer.press('Enter');
}

test('モードON→作成→初めから先頭候補が選択されEnterで確定できる（issue #27）', async ({ page }) => {
  await enableCategorize(page);
  await addTask(page, 'キーボードで確定');

  const picker = page.locator('.kb-cat-pick');
  await expect(picker).toBeVisible();
  // 開いた直後、先頭候補がハイライト（.active）されている。空 DB では「その他」が先頭。
  await expect(picker.locator('.kb-cat-chip.active')).toHaveCount(1);
  await expect(picker.locator('.kb-cat-chip.other')).toHaveClass(/active/);

  // 何も入力せず Enter → ハイライト中の候補（その他）が確定する。
  await picker.locator('input.kb-cat-input').press('Enter');

  const card = page.locator('.kb-col[data-col="TODO"] .kb-card', { hasText: 'キーボードで確定' });
  await expect(card.locator('.kb-cat-badge')).toHaveCount(1);
  await expect(card.locator('.kb-cat-badge')).toContainText('その他');
  // 選択後はコンポーザが再オープンし連続作成へ戻る。
  await expect(page.locator('.kb-col[data-col="TODO"] textarea.kb-composer')).toBeVisible();
});

test('自由入力カテゴリでカードにバッジが出る', async ({ page }) => {
  await enableCategorize(page);
  await addTask(page, '競プロを解く');

  const picker = page.locator('.kb-cat-pick');
  await expect(picker).toBeVisible();

  // 自由入力で確定（入力があれば矢印はカーソル移動・Enter は自由入力を優先）。
  await picker.locator('input.kb-cat-input').fill('アルゴリズム');
  await picker.locator('input.kb-cat-input').press('Enter');

  const card = page.locator('.kb-col[data-col="TODO"] .kb-card', { hasText: '競プロを解く' });
  await expect(card.locator('.kb-cat-badge')).toHaveCount(1);
  await expect(card.locator('.kb-cat-badge')).toContainText('アルゴリズム');
});

test('スキップ（Esc）で未分類のまま次入力へ', async ({ page }) => {
  await enableCategorize(page);
  await addTask(page, 'スキップするタスク');

  const picker = page.locator('.kb-cat-pick');
  await expect(picker).toBeVisible();
  await picker.locator('input.kb-cat-input').press('Escape');

  // バッジは付かない。
  const card = page.locator('.kb-col[data-col="TODO"] .kb-card', { hasText: 'スキップするタスク' });
  await expect(card).toBeVisible();
  await expect(card.locator('.kb-cat-badge')).toHaveCount(0);
  // コンポーザが再オープンしている。
  await expect(page.locator('.kb-col[data-col="TODO"] textarea.kb-composer')).toBeVisible();
});

test('モードOFF時は従来どおり連続作成（ピッカーを挟まない）', async ({ page }) => {
  // トグルは触らない（既定 OFF）。
  await addTask(page, 'OFF時のタスク');

  // ピッカーは出ず、コンポーザがそのまま連続作成のため開いたまま。
  await expect(page.locator('.kb-cat-pick')).toHaveCount(0);
  await expect(page.locator('.kb-col[data-col="TODO"] textarea.kb-composer')).toBeVisible();
  // 作成カードにバッジは無い。
  const card = page.locator('.kb-col[data-col="TODO"] .kb-card', { hasText: 'OFF時のタスク' });
  await expect(card).toBeVisible();
  await expect(card.locator('.kb-cat-badge')).toHaveCount(0);
});
