import { test, expect } from './fixtures.js';
import { seedGroupIdentities } from './group-seed.js';

/**
 * 自動記録の削除フロー（spec: timeline-record-deletion / issue #90）。
 * タイムラインの AUTO ランを開き、削除操作→確認ステップの承認でブロックが消えること、
 * 確認ステップで取り止めた場合は消えないことを、実ブラウザ・実サーバー経路で検証する。
 */

test('AUTO ランを削除できる。確認ステップで取り止めれば消えない', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});

  const TITLE = 'E2E消えるはずグループ';
  await seedGroupIdentities(page, [{ title: TITLE, color: 'blue' }]);

  await page.locator('#tabs button[data-target="reflection"]').click();

  // 65秒の断片は最小高さ(18px)で「tiny」表示になり、名前はテキストではなく title 属性に入る
  // (server/static/js/timeline.js の blockEl() 参照)。属性セレクタで拾う。
  const block = page.locator(`.tlc-block:not(.leisure)[title="${TITLE}"]`);
  await expect(block).toBeVisible({ timeout: 10000 });

  const popover = page.locator('.tlc-pop');

  // 確認ステップで取り止めると削除されない。
  await block.click();
  await expect(popover).toBeVisible();
  await popover.locator('.tlc-pop-delete').click();
  await expect(popover.locator('.tlc-pop-delete-confirm')).toBeVisible();
  await popover.getByRole('button', { name: '取り止め' }).click();
  await expect(popover.locator('.tlc-pop-delete')).toBeVisible();
  await popover.locator('.icon-btn').click();
  await expect(popover).toHaveCount(0);
  await expect(block).toBeVisible();

  // 削除操作 → 確認 → 承認するとタイムラインからそのブロックが消える。
  await block.click();
  await expect(popover).toBeVisible();
  await popover.locator('.tlc-pop-delete').click();
  await popover.getByRole('button', { name: '実行' }).click();
  await expect(page.locator('.toast')).toContainText('自動記録を削除しました');
  await expect(block).toHaveCount(0);
});
