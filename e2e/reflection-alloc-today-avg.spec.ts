import { test, expect } from './fixtures.js';

/**
 * 振り返り「一日の配分」ビューのヘッダに、対象日の総作業時間の絶対値と、直近7日平均（対象日を除く）
 * との差分が +Nh Nm / -Nh Nm / ±0 で表示されることを検証する（issue #81 / spec: reflection-day-overview）。
 * 絶対値の表示は、差分だけでは「実際に何時間使ったか」が読み取れないという issue #81 の追加コメントを
 * 受けて補完したもの。
 */

test('一日の配分ビューで総作業時間と直近7日平均との差分が表示・更新される', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});

  // (c) 記録が何も無い新規状態: 対象日を「一日の配分」ビューに切り替えると、
  // 総作業時間も直近7日平均も 0 のため絶対値は 0m・差分は ±0 になる。
  await page.locator('#tabs button[data-target="reflection"]').click();
  await page.locator('.rf-viewtab', { hasText: '一日の配分' }).click();
  const statNum = page.locator('.rf-alloc-stat-num');
  const delta = page.locator('.rf-alloc-delta');
  await expect(statNum).toHaveText('0m');
  await expect(delta).toContainText('±0');

  // デモを開始する（本番 DB 非依存のデモ DB を seed）。
  await page.locator('#tabs button[data-target="settings"]').click();
  await page.getByRole('button', { name: '🧪 デモを開始' }).click();
  const demobar = page.locator('#demobar');
  await expect(demobar).toBeVisible();

  // (a) 開始前のプレビュー日（代表日 Day4 = 2026-06-14）: 総作業時間 18000s（5h 00m）・
  // 直近7日平均 6514s → 差分 +3h 11m（平均より多い日は + 表示）。
  await page.locator('#tabs button[data-target="reflection"]').click();
  await expect(statNum).toHaveText('5h 00m');
  await expect(delta).toContainText('+3h 11m');

  // (b)(d) 対象日を Day15（2026-06-25）へ進める（demobar は現在画面を自動で再描画する）:
  // 総作業時間 7800s（2h 10m）・直近7日平均 12720s → 差分 -1h 22m（平均より少ない日は - 表示、
  // かつ対象日切替で絶対値・差分表示が再取得・更新されることを確認する）。
  await demobar.getByRole('button', { name: '＋7日' }).click();
  await demobar.getByRole('button', { name: '＋7日' }).click();
  await demobar.getByRole('button', { name: '＋1日' }).click();
  await expect(demobar.locator('.demobar-status')).toContainText('2026-06-25');
  await expect(statNum).toHaveText('2h 10m');
  await expect(delta).toContainText('-1h 22m');
});
