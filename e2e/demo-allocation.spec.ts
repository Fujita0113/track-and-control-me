import { test, expect } from '@playwright/test';

/**
 * デモモードで振り返りタブの「一日の配分」バーを実ブラウザで検証する
 * （reflection-alloc-group-identity / issue #47）。
 * 同名同色（振り返り・紫）の作り直しグループが1本の大きなスライスへ合算され、
 * 6分割・埋没しないことを、実際の描画（showDemo → buildAllocCard）で確認する。
 */

test('デモの振り返り配分バーで振り返り(紫)が1本に合算される', async ({ page }) => {
  await page.goto('/');

  // 初回起動のオンボーディング・モーダルが出たら閉じる（クリックを遮らないように）。
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});

  // 設定タブ → デモを開始（本番 DB 非依存のデモ DB を seed）。
  await page.locator('#tabs button[data-target="settings"]').click();
  await page.getByRole('button', { name: '🧪 デモを開始' }).click();

  // デモ帯が出る。開始直後は「開始前」。Day15（2026-06-25）まで仮想日付を進める
  // （開始前 2026-06-10 から +7 +7 +1 = +15 日）。
  const demobar = page.locator('#demobar');
  await expect(demobar).toBeVisible();
  await demobar.getByRole('button', { name: '＋7日' }).click();
  await demobar.getByRole('button', { name: '＋7日' }).click();
  await demobar.getByRole('button', { name: '＋1日' }).click();
  await expect(demobar.locator('.demobar-status')).toContainText('2026-06-25');

  // 振り返りタブへ。配分バー（デモ・読み取り専用）が描画される。
  await page.locator('#tabs button[data-target="reflection"]').click();

  const allocCard = page.locator('.rf-alloc-card');
  await expect(allocCard).toBeVisible();

  // 「振り返り」ラベルの棒はちょうど1本（6分割していない）。
  const reflectLabels = allocCard.locator('.rf-bar-label', { hasText: '振り返り' });
  await expect(reflectLabels).toHaveCount(1);

  // 最上段（最大）の棒が「振り返り」＝埋没していない。値は 3h（"3h 00m"）。
  const firstRow = allocCard.locator('.rf-bar-row').first();
  await expect(firstRow.locator('.rf-bar-label')).toHaveText('振り返り');
  await expect(firstRow.locator('.rf-bar-val')).toHaveText('3h 00m');
});
