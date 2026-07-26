import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * PR レビュー用のスクリーンショット撮影（CI 専用の用途だがローカルでも動く）。
 *
 * デモモード（DB_PATH=:memory: の固定 day_key サンプル）で全タブを撮る。
 * 拡張機能が接続されていなくてもデータが載った状態を見られるので、
 * 拡張なしの CI ランナー上でも UI の変化を目視確認できる。
 *
 * 出力先: test-results/screenshots/<n>-<tab>.png（.gitignore 済み）
 */

const OUT_DIR = 'test-results/screenshots';

const TABS: Array<{ target: string; label: string }> = [
  { target: 'today', label: '今日' },
  { target: 'reflection', label: '振り返り' },
  { target: 'kanban', label: 'カンバン' },
  { target: 'goals', label: '目標' },
  { target: 'settings', label: '設定' },
];

test('デモモードで全タブのスクリーンショットを撮る', async ({ page }) => {
  mkdirSync(OUT_DIR, { recursive: true });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');

  // 初回起動のオンボーディング・モーダルが出たら閉じる（クリックを遮らないように）。
  await page
    .getByRole('button', { name: 'あとで' })
    .click({ timeout: 3000 })
    .catch(() => {});

  // 設定タブ → デモを開始（本番 DB 非依存のデモ DB を seed）。
  await page.locator('#tabs button[data-target="settings"]').click();
  await page.getByRole('button', { name: '🧪 デモを開始' }).click();

  // デモ帯が出る。開始直後は「開始前」なので Day15（2026-06-25）まで仮想日付を進める。
  const demobar = page.locator('#demobar');
  await expect(demobar).toBeVisible();
  await demobar.getByRole('button', { name: '＋7日' }).click();
  await demobar.getByRole('button', { name: '＋7日' }).click();
  await demobar.getByRole('button', { name: '＋1日' }).click();
  await expect(demobar.locator('.demobar-status')).toContainText('2026-06-25');

  for (const [i, tab] of TABS.entries()) {
    await page.locator(`#tabs button[data-target="${tab.target}"]`).click();
    // 描画（グラフ含む）が落ち着くのを待つ。
    await page.waitForTimeout(600);
    await page.screenshot({
      path: `${OUT_DIR}/${i + 1}-${tab.target}.png`,
      fullPage: true,
    });
  }
});
