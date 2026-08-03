import { test, expect } from '@playwright/test';
import { thirtyDayEnd } from './goal-input.js';

test('GROUP_OR ルールの作成と表示フロー', async ({ page }) => {
  const { dayKey } = await (await page.request.get('/api/summary')).json();

  await page.goto('/');
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});

  // 目標タブを開く
  await page.locator('#tabs button[data-target="goals"]').click();
  await page.getByRole('button', { name: '＋ 新しい目標' }).click();

  const modal = page.locator('.modal-panel');
  await expect(modal).toBeVisible();

  // 目標名・めざす状態・開始理由
  await modal.locator('input[placeholder*="目標名"]').fill('学習習慣');
  await modal.locator('.gr-purpose-input').fill('英語または読書を30分継続する');
  await modal.locator('.gr-startreason-input').fill('自己投資のため');

  // ルール編集
  const editor = modal.locator('.gr-newcond-editor').first();
  await editor.locator('select').first().selectOption('GROUP_SELECT');

  // 対象グループが表示され、選択できること
  const checkboxes = editor.locator('input[type="checkbox"]');
  const count = await checkboxes.count();
  if (count >= 2) {
    await checkboxes.nth(0).check();
    await checkboxes.nth(1).check();
  }

  await editor.locator('input[type="number"]').fill('30');
  await editor.locator('.pc-textarea').fill('習慣づくりのため');

  await modal.getByRole('button', { name: '作成' }).click();

  // 目標カードが作成されること
  await expect(page.locator('.gr-goal-card', { hasText: '学習習慣' })).toBeVisible();
});
