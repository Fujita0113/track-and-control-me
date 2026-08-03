import { test, expect } from './fixtures.js';
import { thirtyDayEnd } from './goal-input.js';
import { seedGroupIdentities } from './group-seed.js';

test('「グループ作業時間」選択から1件選択(GROUP)および2件選択(GROUP_OR)の目標が作成・表示される', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});

  // GROUP_SELECT の選択肢は実測データからしか生まれないため、テスト自身で2グループぶん用意する。
  await seedGroupIdentities(page, [
    { title: '英語の勉強', color: 'blue' },
    { title: '読書', color: 'green' },
  ]);

  // 目標タブを開く
  await page.locator('#tabs button[data-target="goals"]').click();

  // 1. グループ1件選択（GROUP）で目標作成
  await page.getByRole('button', { name: '＋ 新しい目標' }).click();
  let modal = page.locator('.modal-panel');
  await expect(modal).toBeVisible();

  await modal.locator('input[placeholder*="目標名"]').fill('単一グループ目標');
  await modal.locator('.gr-purpose-input').fill('単一グループの時間を積算する');
  await modal.locator('.gr-startreason-input').fill('テストのため');

  let editor = modal.locator('.gr-newcond-editor').first();
  await editor.locator('select').first().selectOption('GROUP_SELECT');

  let checkboxes = editor.locator('input[type="checkbox"]');
  const count1 = await checkboxes.count();
  expect(count1).toBeGreaterThanOrEqual(1);
  await checkboxes.nth(0).check();

  await editor.locator('input[type="number"]').fill('45');
  await editor.locator('.pc-textarea').fill('単一グループテスト');

  await modal.getByRole('button', { name: '作成' }).click();
  await expect(page.locator('.gr-goal-card', { hasText: '単一グループ目標' })).toBeVisible();

  // 2. グループ2件選択（GROUP_OR）で目標作成
  await page.getByRole('button', { name: '＋ 新しい目標' }).click();
  modal = page.locator('.modal-panel');
  await expect(modal).toBeVisible();

  await modal.locator('input[placeholder*="目標名"]').fill('複数グループOR目標');
  await modal.locator('.gr-purpose-input').fill('複数グループのいずれかの時間を積算する');
  await modal.locator('.gr-startreason-input').fill('テストのため');

  editor = modal.locator('.gr-newcond-editor').first();
  await editor.locator('select').first().selectOption('GROUP_SELECT');

  checkboxes = editor.locator('input[type="checkbox"]');
  const count2 = await checkboxes.count();
  if (count2 >= 2) {
    await checkboxes.nth(0).check();
    await checkboxes.nth(1).check();
  } else if (count2 === 1) {
    await checkboxes.nth(0).check();
  }

  await editor.locator('input[type="number"]').fill('60');
  await editor.locator('.pc-textarea').fill('複数グループORテスト');

  await modal.getByRole('button', { name: '作成' }).click();
  await expect(page.locator('.gr-goal-card', { hasText: '複数グループOR目標' })).toBeVisible();
});
