import { test, expect } from '@playwright/test';

/**
 * ショートカット & ホバーヒント E2E（shortcut-hover-hints / issue #35）。
 * インメモリ DB（本番非干渉）で、数字キーのタブ切替・Esc のモーダル閉じ・保存 Ctrl+Enter・
 * 各ボタンのホバーヒント（カスタムツールチップ）を実ブラウザで確認する。
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // 初回オンボーディングが出たら閉じる（在れば）。
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
});

test('数字キー 1〜6 でタブ切替、入力中は発火しない（5.3）', async ({ page }) => {
  // 3 → カンバンがアクティブ。
  await page.keyboard.press('3');
  await expect(page.locator('#screen-kanban')).toHaveClass(/active/);
  await expect(page.locator('#tabs button[data-target="kanban"]')).toHaveClass(/active/);

  // 5 → 目標。
  await page.keyboard.press('5');
  await expect(page.locator('#screen-goals')).toHaveClass(/active/);

  // 6 → 設定。設定の入力にフォーカスして数字を打っても切替は起きず、入力へ反映される。
  await page.keyboard.press('6');
  await expect(page.locator('#screen-settings')).toHaveClass(/active/);
  const tz = page.locator('#screen-settings input[type="text"]').first();
  await tz.click();
  await tz.fill('');
  await page.keyboard.type('3');
  await expect(page.locator('#screen-settings')).toHaveClass(/active/); // タブは動かない
  await expect(tz).toHaveValue('3');
});

test('修飾キー併用の数字はタブ切替しない（5.3）', async ({ page }) => {
  await expect(page.locator('#screen-today')).toHaveClass(/active/);
  await page.keyboard.press('Control+2');
  await expect(page.locator('#screen-today')).toHaveClass(/active/); // 変化なし
});

test('各タブのホバーで番号ヒントが出る（5.3）', async ({ page }) => {
  const kanbanTab = page.locator('#tabs button[data-target="kanban"]');
  await expect(kanbanTab).toHaveAttribute('aria-keyshortcuts', '3');
  await kanbanTab.hover();
  const tip = page.locator('.sc-tip.show');
  await expect(tip).toBeVisible();
  await expect(tip.locator('.kbd')).toHaveText('3');
  // 離脱で非表示。
  await page.locator('.brand-name').hover();
  await expect(page.locator('.sc-tip.show')).toHaveCount(0);
});

test('モーダルの ✕ ホバーで Esc ヒント、Esc で閉じる（5.2）', async ({ page }) => {
  // モーダル無しの Esc は無反応（タブは today のまま）。
  await expect(page.locator('#screen-today')).toHaveClass(/active/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#screen-today')).toHaveClass(/active/);

  // 目標作成モーダルを開く。
  await page.locator('#tabs button[data-target="goals"]').click();
  await page.getByRole('button', { name: '＋ 新しい目標' }).click();
  await expect(page.locator('#modal-root')).toHaveClass(/open/);

  // ✕ に Esc ヒント。
  const close = page.locator('#modal-root .modal-header .icon-btn');
  await expect(close).toHaveAttribute('aria-keyshortcuts', 'Escape');
  await close.hover();
  const tip = page.locator('.sc-tip.show');
  await expect(tip).toBeVisible();
  await expect(tip.locator('.kbd')).toHaveText('Esc');

  // Esc でモーダルが閉じる。
  await page.keyboard.press('Escape');
  await expect(page.locator('#modal-root')).not.toHaveClass(/open/);
});

test('設定の保存が Ctrl+Enter で効き、ボタンにヒントが出る（5.1）', async ({ page }) => {
  await page.locator('#tabs button[data-target="settings"]').click();
  const save = page.getByRole('button', { name: '保存 (PATCH)' });
  await expect(save).toBeVisible();
  await expect(save).toHaveAttribute('aria-keyshortcuts', /Enter/);

  // ヒント表示（保存 + Ctrl/Cmd + Enter）。
  await save.hover();
  const tip = page.locator('.sc-tip.show');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('保存');
  await expect(tip.locator('.kbd')).toContainText(['Enter']);

  // フォーム内で Ctrl+Enter → 保存トースト。
  const tz = page.locator('#screen-settings input[type="text"]').first();
  await tz.click();
  await page.keyboard.press('Control+Enter');
  await expect(page.locator('.toast-ok')).toContainText('設定を保存しました');
});
