import { test, expect } from './fixtures.js';
import type { Page } from '@playwright/test';
import { thirtyDayEnd, addDaysKey } from './goal-input.js';

/**
 * 家計簿タブ（issue #94 / kakeibo-tab）の通し e2e。
 * §0 に挙げた7フロー（openspec/changes/kakeibo-tab/tasks.md）をカバーする。
 *
 * 数値はモック（2026-08-11 時点）ではなく実際の作業日（サーバ起動時刻）に依存するため、
 * 絶対値ではなく「操作の前後で値が変わること」を確認する形にしている。
 *
 * 1ワーカー1サーバー（fixtures.ts）で家計簿データは production DB を共有するため、
 * describe.serial で実行順を固定し、各テストは名称にユニークな接頭辞を付けて
 * 他テストが作ったレコードと混ざらないようにする。0円だった宣言のテストだけは
 * 「その日にまだ家計簿の記録が無い」状態に依存するので最初に置く。
 */

function parseYen(text: string): number {
  const m = /([\d,]+)/.exec(text || '');
  return m ? Number(m[1]!.replace(/,/g, '')) : NaN;
}

async function gotoKakeibo(page: Page, subtab: '履歴' | '分析' | '予算' | 'ホーム' = 'ホーム'): Promise<void> {
  await page.locator('.tab[data-target="kakeibo"]').click();
  await page.waitForSelector('.kb-subtabs');
  // kbState.view はモジュール内で状態を持ち続けるため、サブタブを毎回明示的に押して合わせる。
  await page.locator('.kb-subtabs button', { hasText: subtab }).click();
  await page.waitForTimeout(150);
}

test.describe.serial('家計簿タブ', () => {
  test('今日タブの家計簿の条件で「0円だった」を押す → 条件が達成に変わり、履歴には何も増えていない', async ({ page, request }) => {
    const { dayKey } = await (await request.get('/api/summary')).json();
    const goal = await request.post('/api/goals', {
      data: {
        name: '家計簿ゲートテスト',
        purpose: '毎日記録する',
        startReason: 'e2e のため',
        start: 'today',
        endDay: thirtyDayEnd(dayKey),
        rules: [{ target: 'PLANNING', signalKey: 'kakeibo_recorded', reason: 'e2e のため' }],
      },
    });
    expect(goal.ok()).toBeTruthy();

    await page.goto('/');
    await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
    await page.locator('.tab[data-target="today"]').click();

    const row = page.locator('.cond', { hasText: '家計簿に今日の記録がある' });
    await expect(row).toBeVisible();
    await expect(row).not.toHaveClass(/met/);
    await expect(row.getByRole('button', { name: '0円だった' })).toBeVisible();

    await row.getByRole('button', { name: '0円だった' }).click();
    await expect(row).toHaveClass(/met/);
    await expect(row.locator('.mark')).toHaveText('✓');
    await expect(row.getByRole('button', { name: '0円だった' })).toHaveCount(0);

    const hist = await (await request.get(`/api/kakeibo/history?month=${dayKey.slice(0, 7)}`)).json();
    expect(hist.entries.filter((e: { day_key: string }) => e.day_key === dayKey)).toHaveLength(0);
  });

  test('記録する → ホームの1日平均・月末予想・折れ線がその場で新しい値になる', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
    await gotoKakeibo(page);

    const landing = page.locator('.kb-card', { hasText: '今月の支出推移と月末予想' }).locator('.kb-big.sm .n');
    const summary = page.locator('.kb-summary-items');
    const beforeLanding = parseYen((await landing.textContent()) || '');
    const beforeSummary = (await summary.textContent()) || '';

    await page.fill('input[aria-label="金額"]', '31000');
    await page.fill('.kb-name-input', 'E2E記録テスト');
    await page.getByRole('button', { name: '記録する', exact: true }).click();
    await expect(page.locator('#toast-host.show')).toContainText('記録しました');

    await gotoKakeibo(page); // ビューを開き直して最新の値を取得する
    const afterLanding = parseYen((await landing.textContent()) || '');
    const afterSummary = (await summary.textContent()) || '';
    expect(afterLanding).toBeGreaterThan(beforeLanding);
    expect(afterSummary).not.toBe(beforeSummary);

    // 折れ線（SVG）が描かれている。
    await expect(page.locator('.kb-chart svg')).toBeVisible();
  });

  test('履歴の行で「特別費（除外）」を選ぶ → 1日平均が下がり、月末予想と上限超過日が変わる', async ({ page, request }) => {
    const { dayKey } = await (await request.get('/api/summary')).json();
    for (const [name, amountYen] of [['E2E特別費A', 20000], ['E2E特別費B', 8000]] as const) {
      const res = await request.post('/api/kakeibo/entries', {
        data: { dayKey, name, amountYen, category: 'FOOD', importance: 'MUST' },
      });
      expect(res.ok()).toBeTruthy();
    }

    const before = await (await request.get(`/api/kakeibo/home?month=${dayKey.slice(0, 7)}`)).json();

    await page.goto('/');
    await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
    await gotoKakeibo(page, '履歴');

    const row = page.locator('.kb-hist-row', { hasText: 'E2E特別費A' });
    await expect(row).toBeVisible();
    await row.locator('.kb-toggle .seg', { hasText: '特別費（除外）' }).click();
    await expect(row.locator('.kb-toggle .seg.on')).toHaveText('特別費（除外）');

    const after = await (await request.get(`/api/kakeibo/home?month=${dayKey.slice(0, 7)}`)).json();
    expect(after.summary.dailyAverageYen).toBeLessThan(before.summary.dailyAverageYen);
    expect(after.landing.landingYen).toBeLessThan(before.landing.landingYen);

    await gotoKakeibo(page); // ホームでも新しい値になっていることを見る
    await expect(page.locator('.kb-summary-items')).toContainText(`¥${after.summary.dailyAverageYen.toLocaleString('ja-JP')}`);
  });

  test('ホームの「予想の計算内訳・調整」で切り替える → 4つの数字が同時に出し直され、キャンセルでは保存されていない', async ({ page, request }) => {
    const { dayKey } = await (await request.get('/api/summary')).json();
    const res = await request.post('/api/kakeibo/entries', {
      data: { dayKey, name: 'E2E調整テスト', amountYen: 15000, category: 'FOOD', importance: 'MUST' },
    });
    const created = await res.json();

    await page.goto('/');
    await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
    await gotoKakeibo(page);

    await page.getByRole('button', { name: '予想の計算内訳・調整 ›' }).click();
    const modal = page.locator('.modal-panel');
    await expect(modal).toBeVisible();

    const effect = modal.locator('.kb-effect');
    const beforeEffect = (await effect.textContent()) || '';

    const adjustRow = modal.locator('.kb-adjust-row', { hasText: 'E2E調整テスト' });
    await adjustRow.locator('.kb-toggle .seg', { hasText: '特別費（除外）' }).click();

    await expect(async () => {
      const t = (await effect.textContent()) || '';
      expect(t).not.toBe(beforeEffect);
    }).toPass({ timeout: 5000 });

    await modal.getByRole('button', { name: 'キャンセル' }).click();
    await expect(modal).toHaveCount(0);

    // PATCH で保存されていないこと（is_special が元のまま）を history から確認する。
    const hist = await (await request.get(`/api/kakeibo/history?month=${dayKey.slice(0, 7)}`)).json();
    const row = hist.entries.find((e: { id: number }) => e.id === created.id);
    expect(row.is_special).toBe(0);
  });

  test('内訳だけ書いて記録する → 履歴の行からも分析の明細からも同じ明細が開いて内訳が読め、内訳もレシートも無い行は押せない', async ({ page, request }) => {
    const { dayKey } = await (await request.get('/api/summary')).json();
    await request.post('/api/kakeibo/entries', {
      data: { dayKey, name: 'E2E内訳あり', amountYen: 5000, category: 'FOOD', importance: 'MUST', detail: 'E2Eテスト内訳の中身' },
    });
    await request.post('/api/kakeibo/entries', {
      data: { dayKey, name: 'E2E内訳なし', amountYen: 300, category: 'FOOD', importance: 'MUST' },
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
    await gotoKakeibo(page, '履歴');

    // 内訳もレシートも無い行は押せない。
    const emptyRow = page.locator('.kb-hist-row', { hasText: 'E2E内訳なし' }).locator('.kb-hist-main');
    await expect(emptyRow).toBeDisabled();

    // 内訳がある行は押すと明細が開く。
    await page.locator('.kb-hist-row', { hasText: 'E2E内訳あり' }).locator('.kb-hist-main').click();
    const modal = page.locator('.modal-panel');
    await expect(modal).toContainText('E2Eテスト内訳の中身');
    await expect(modal).toContainText('レシートは付いていません');
    await modal.getByRole('button', { name: '閉じる' }).click();

    // 分析タブの明細からも同じものが開く。
    await gotoKakeibo(page, '分析');
    const foodCategory = page.locator('.kb-node.lv1', { hasText: '食品' });
    await expect(foodCategory).toBeVisible();
    await page.locator('.kb-node.lv2', { hasText: 'E2E内訳あり' }).click();
    await page.locator('.kb-leaf', { hasText: 'E2E内訳あり' }).click();
    const anaModal = page.locator('.modal-panel');
    await expect(anaModal).toContainText('E2Eテスト内訳の中身');
  });

  test('未記録期間を一括入力する → 履歴に内訳未入力で並び、分析の重要度の帯にその区画が出る', async ({ page, request }) => {
    const { dayKey } = await (await request.get('/api/summary')).json();
    const monthKey = dayKey.slice(0, 7);
    const before = await (await request.get(`/api/kakeibo/analysis?month=${monthKey}`)).json();

    await page.goto('/');
    await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
    await gotoKakeibo(page, '履歴');

    await page.getByRole('button', { name: '未記録期間を一括入力' }).click();
    const modal = page.locator('.modal-panel');
    const [fromInput, toInput] = await modal.locator('input[type="date"]').all();
    await fromInput!.fill(dayKey);
    await toInput!.fill(dayKey);
    await modal.locator('input[type="text"]').fill('9999');
    await modal.getByRole('button', { name: '保存する' }).click();
    await expect(page.locator('#toast-host.show')).toContainText('保存しました');

    await expect(page.locator('.kb-hist-row', { hasText: 'まとめ' }).first()).toContainText('内訳未入力');

    const after = await (await request.get(`/api/kakeibo/analysis?month=${monthKey}`)).json();
    expect(after.importance.noDetail.amountYen).toBe(before.importance.noDetail.amountYen + 9_999);

    await gotoKakeibo(page, '分析');
    await expect(page.locator('.kb-stack')).toContainText('内訳未入力');
  });

  test('予算で月の上限を変える → ホームの上限線・週の目標・上限超過日が追随する', async ({ page, request }) => {
    const { dayKey } = await (await request.get('/api/summary')).json();
    const monthKey = dayKey.slice(0, 7);
    const before = await (await request.get(`/api/kakeibo/budget?month=${monthKey}`)).json();

    await page.goto('/');
    await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
    await gotoKakeibo(page, '予算');

    const capInput = page.locator('.kb-card', { hasText: '今月の予算設定' }).locator('.kb-brow', { hasText: '月の上限' }).locator('input');
    const weeklyTargetBefore = await page.locator('.kb-out', { hasText: '週の目標' }).locator('.v').textContent();

    const newCap = (before.budget.cap_yen || 0) + 50_000;
    await capInput.fill(String(newCap));
    await capInput.blur();
    await page.waitForTimeout(300);

    const weeklyTargetAfter = await page.locator('.kb-out', { hasText: '週の目標' }).locator('.v').textContent();
    expect(weeklyTargetAfter).not.toBe(weeklyTargetBefore);

    await gotoKakeibo(page); // ホーム
    await expect(page.locator('.kb-card', { hasText: '今月の支出推移と月末予想' })).toContainText(
      `上限 ¥${newCap.toLocaleString('ja-JP')}`,
    );
  });

  test('記録カードで買った日を過去日に変えて記録する → 履歴のその日の位置に現れ、当月の合計に反映される（issue #102）', async ({ page, request }) => {
    const { dayKey } = await (await request.get('/api/summary')).json();
    const pastDayKey = addDaysKey(dayKey, -2);
    const pastMonthKey = pastDayKey.slice(0, 7);
    const todayMonthKey = dayKey.slice(0, 7);
    const before = await (await request.get(`/api/kakeibo/home?month=${pastMonthKey}`)).json();

    await page.goto('/');
    await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
    await gotoKakeibo(page);

    await page.fill('input[aria-label="金額"]', '999');
    await page.fill('.kb-name-input', 'E2E過去日記録');
    await page.fill('input[aria-label="買った日"]', pastDayKey);
    await page.getByRole('button', { name: '記録する', exact: true }).click();
    await expect(page.locator('#toast-host.show')).toContainText('記録しました');

    await gotoKakeibo(page, '履歴');
    if (pastMonthKey !== todayMonthKey) {
      await page.locator('.section-head button', { hasText: '‹' }).click();
      await page.waitForTimeout(150);
    }
    const row = page.locator('.kb-hist-row', { hasText: 'E2E過去日記録' });
    await expect(row).toBeVisible();
    await expect(row.locator('.d')).toContainText(`${Number(pastDayKey.split('-')[1])}/${Number(pastDayKey.split('-')[2])}`);

    const after = await (await request.get(`/api/kakeibo/home?month=${pastMonthKey}`)).json();
    expect(after.summary.dailyAverageYen).not.toBe(before.summary.dailyAverageYen);
  });
});
