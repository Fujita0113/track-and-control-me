import { test, expect } from '@playwright/test';

/**
 * 左ビューによるサイドバーと日付ストリップの駆動（reflection-timeline-workspace / issue #67）。
 * 「明日の計画」ビューでは日付ストリップが消え、右サイドバーに詳細/ログタブが現れる。
 * 他ビューへ戻すと、離脱前の対象日を保ったままストリップが再表示され、詳細/ログタブは閉じる。
 */

/** 'YYYY-MM-DD' に n 日加算（UTC 計算・util.js の addDays と同じ規則）。 */
function addDays(dayKey: string, n: number): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
});

test('明日の計画ビューでは日付ストリップが消え、他ビューへ戻すと離脱前の対象日のまま再表示される', async ({ page, request }) => {
  const { dayKey } = await (await request.get('/api/summary')).json();
  const yesterday = addDays(dayKey, -1);
  const yesterdayDay = String(Number(yesterday.split('-')[2]));

  await page.locator('#tabs button[data-target="reflection"]').click();
  await expect(page.locator('.rf-strip-host')).toBeVisible();
  // タイムライン/一日の配分のみのときは詳細/ログタブは存在しない。
  await expect(page.locator('.rf-sb-tab')).toHaveCount(0);

  // 対象日を前日へ変更する。
  await page.locator('.rf-strip-arrow', { hasText: '‹' }).click();
  await expect(page.locator('.rf-chip-date.active .rf-chip-day')).toHaveText(yesterdayDay);

  // 明日の計画ビューへ切替: ストリップが消え、詳細/ログタブが現れる。
  await page.locator('.rf-viewtab', { hasText: '明日の計画' }).click();
  await expect(page.locator('.rf-plan')).toBeVisible();
  await expect(page.locator('.rf-strip-host')).toBeHidden();
  await expect(page.locator('.rf-sb-tab', { hasText: '詳細' })).toBeVisible();
  await expect(page.locator('.rf-sb-tab', { hasText: 'ログ' })).toBeVisible();

  // 横スクロールしてもビューは切り替わらない（左メインのビュータブは「明日の計画」のまま）。
  await expect(page.locator('.rf-viewtab', { hasText: '明日の計画' })).toHaveClass(/active/);

  // 他ビュー（一日の配分）へ戻すと、詳細/ログタブが閉じ、ストリップが離脱前の対象日のまま再表示される。
  await page.locator('.rf-viewtab', { hasText: '一日の配分' }).click();
  await expect(page.locator('.rf-strip-host')).toBeVisible();
  await expect(page.locator('.rf-sb-tab')).toHaveCount(0);
  await expect(page.locator('.rf-chip-date.active .rf-chip-day')).toHaveText(yesterdayDay);
});
