import { test, expect } from './fixtures.js';
import type { Page } from '@playwright/test';

/**
 * 直近7日ベース予想・週ごとの支出（issue #105 / change: kakeibo-recent-forecast）の通し e2e。
 * kakeibo-tab.spec.ts と同じく production DB を共有するワーカーサーバーを使うため、
 * describe.serial + ユニーク接頭辞の名称で他テストと混ざらないようにする。
 */

function fmtYen(n: number): string {
  return `¥${Math.round(n).toLocaleString('ja-JP')}`;
}

async function gotoKakeibo(page: Page, subtab: '履歴' | '分析' | '予算' | 'ホーム' = 'ホーム'): Promise<void> {
  await page.locator('.tab[data-target="kakeibo"]').click();
  await page.waitForSelector('.kb-subtabs');
  await page.locator('.kb-subtabs button', { hasText: subtab }).click();
  await page.waitForTimeout(150);
}

test.describe.serial('家計簿タブ: 直近7日ベース予想・週ごとの支出', () => {
  test('ホームで基準トグルを「直近7日ベース」に切り替える → 月末予想・1日平均・上限超過日が変わり、グラフが再描画される', async ({
    page,
    request,
  }) => {
    const { dayKey } = await (await request.get('/api/summary')).json();
    const monthKey = dayKey.slice(0, 7);

    // 直近7日と月全体の平均が同値になりにくいよう、今日に大きめの支出を1件足しておく。
    const res = await request.post('/api/kakeibo/entries', {
      data: { dayKey, name: 'E2E直近7日基準テスト', amountYen: 42_000, category: 'FOOD', importance: 'MUST' },
    });
    expect(res.ok()).toBeTruthy();

    const home = await (await request.get(`/api/kakeibo/home?month=${monthKey}`)).json();
    const all = { dailyAverageYen: home.summary.dailyAverageYen, landingYen: home.landing.landingYen };
    const recent = { dailyAverageYen: home.landing.recent.dailyAverageYen, landingYen: home.landing.recent.landingYen };

    await page.goto('/');
    await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
    await gotoKakeibo(page);

    const forecastCard = page.locator('.kb-card', { hasText: '今月の支出推移と月末予想' });
    await expect(forecastCard).toContainText(fmtYen(all.landingYen));
    await expect(forecastCard).toContainText(fmtYen(all.dailyAverageYen));
    const canvas = forecastCard.locator('.kb-chart canvas');
    await expect(canvas).toBeVisible();
    const beforeAriaLabel = await canvas.getAttribute('aria-label');

    await forecastCard.getByRole('button', { name: '直近7日ベース' }).click();

    await expect(forecastCard).toContainText(fmtYen(recent.landingYen));
    await expect(forecastCard).toContainText(fmtYen(recent.dailyAverageYen));
    const afterAriaLabel = await canvas.getAttribute('aria-label');
    expect(afterAriaLabel).not.toBe(beforeAriaLabel);

    // 「これまでの平均」に戻すと元の値の表示に戻る。
    await forecastCard.getByRole('button', { name: 'これまでの平均ペース' }).click();
    await expect(forecastCard).toContainText(fmtYen(all.landingYen));
  });

  test('分析タブで週ごとの支出を見る → 進行中の週が分かり、新規記録が該当週の棒に反映される', async ({ page, request }) => {
    const { dayKey } = await (await request.get('/api/summary')).json();
    const monthKey = dayKey.slice(0, 7);

    const before = await (await request.get(`/api/kakeibo/analysis?month=${monthKey}`)).json();
    const beforeWeek = before.weeks.find((w: { inProgress: boolean }) => w.inProgress);
    expect(beforeWeek).toBeTruthy();

    const res = await request.post('/api/kakeibo/entries', {
      data: { dayKey, name: 'E2E週次テスト', amountYen: 3_333, category: 'FOOD', importance: 'MUST' },
    });
    expect(res.ok()).toBeTruthy();

    const after = await (await request.get(`/api/kakeibo/analysis?month=${monthKey}`)).json();
    const afterWeek = after.weeks.find(
      (w: { weekFromDayKey: string }) => w.weekFromDayKey === beforeWeek.weekFromDayKey,
    );
    expect(afterWeek.spentYen).toBe(beforeWeek.spentYen + 3_333);

    await page.goto('/');
    await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
    await gotoKakeibo(page, '分析');

    const weeklyCard = page.locator('.kb-card', { hasText: '週ごとの支出' });
    await expect(weeklyCard).toBeVisible();

    const inProgressRow = weeklyCard.locator('.kb-weekly-row.inprogress');
    await expect(inProgressRow).toBeVisible();
    await expect(inProgressRow).toContainText('進行中');
    await expect(inProgressRow.locator('.v')).toHaveText(fmtYen(afterWeek.spentYen));
  });
});
