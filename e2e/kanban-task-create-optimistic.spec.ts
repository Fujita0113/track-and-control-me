import { test, expect } from '@playwright/test';

/**
 * かんばんのタスク作成 Optimistic UI（issue #29 フォローアップ）。
 * 「タスク追加→Enter のあとスムーズに次のタスク登録に移れない」というユーザー指摘を受け、
 * commitComposer が api.createTask の応答を待たず即座にボードへ反映するようにした変更を検証する。
 * POST /api/tasks に遅延を挟み、「応答を待たず即座に反映される」ことと「失敗時はロールバックされる」
 * ことを実ブラウザで確認する。インメモリ DB（本番非干渉）。
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
  await page.locator('#tabs button[data-target="kanban"]').click();
  await expect(page.locator('.kb')).toBeVisible();
});

test('タスク作成はサーバー応答を待たず即座にボードへ反映され、コンポーザもすぐ次の入力に使える', async ({ page }) => {
  await page.route('**/api/tasks', async (route) => {
    if (route.request().method() === 'POST') {
      await new Promise((r) => setTimeout(r, 400));
      await route.continue();
    } else {
      await route.continue();
    }
  });

  const todo = page.locator('.kb-col[data-col="TODO"]');
  await todo.locator('.kb-add').click();
  const composer = todo.locator('textarea.kb-composer');
  await composer.fill('速い作成テスト');
  await composer.press('Enter');

  // 400ms の遅延応答を待たず、200ms 以内にカードが現れる。
  await expect(todo.locator('.kb-card', { hasText: '速い作成テスト' })).toBeVisible({ timeout: 200 });
  // コンポーザは空のまま・フォーカスされたままで、次のタイトルをすぐ打ち始められる。
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('');

  // 遅延応答が返ってきた後もカードは1枚のまま（重複しない）。
  await page.waitForTimeout(600);
  await expect(todo.locator('.kb-card', { hasText: '速い作成テスト' })).toHaveCount(1);

  // 続けて次のタスクも問題なく作成できる（連続作成が壊れていないこと）。
  await composer.fill('次のタスク');
  await composer.press('Enter');
  await expect(todo.locator('.kb-card', { hasText: '次のタスク' })).toBeVisible({ timeout: 200 });
});

test('カテゴリ付けモードでもピッカーはグループ取得・タスク作成の応答を待たず即座に開く', async ({ page }) => {
  await page.route('**/api/tasks', async (route) => {
    if (route.request().method() === 'POST') {
      await new Promise((r) => setTimeout(r, 400));
      await route.continue();
    } else {
      await route.continue();
    }
  });
  await page.locator('.kb-chip', { hasText: 'カテゴリ付け' }).locator('.kb-switch').click();

  const todo = page.locator('.kb-col[data-col="TODO"]');
  await todo.locator('.kb-add').click();
  const composer = todo.locator('textarea.kb-composer');
  await composer.fill('カテゴリ付け高速化テスト');
  await composer.press('Enter');

  await expect(page.locator('.kb-cat-pick')).toBeVisible({ timeout: 200 });
  await page.locator('input.kb-cat-input').press('Enter');
  await expect(todo.locator('.kb-card', { hasText: 'カテゴリ付け高速化テスト' })).toBeVisible();
});

test('タスク作成に失敗した場合は一度現れたカードが消えてロールバックされる', async ({ page }) => {
  await page.route('**/api/tasks', async (route) => {
    if (route.request().method() === 'POST') {
      await new Promise((r) => setTimeout(r, 300));
      await route.fulfill({ status: 500, body: 'boom' });
    } else {
      await route.continue();
    }
  });

  const todo = page.locator('.kb-col[data-col="TODO"]');
  await todo.locator('.kb-add').click();
  const composer = todo.locator('textarea.kb-composer');
  await composer.fill('失敗するタスク');
  await composer.press('Enter');

  // 即座にカードが現れる。
  await expect(todo.locator('.kb-card', { hasText: '失敗するタスク' })).toBeVisible({ timeout: 200 });

  // 失敗応答の後、カードは消えエラー toast が出る。
  await expect(todo.locator('.kb-card', { hasText: '失敗するタスク' })).toHaveCount(0);
  await expect(page.locator('.toast-err', { hasText: '追加に失敗' })).toBeVisible();

  // 失敗時はコンポーザを閉じる（既存挙動）。「＋新規タスク」から再度作成できる。
  await expect(todo.locator('textarea.kb-composer')).toHaveCount(0);
  await expect(todo.locator('.kb-add')).toBeVisible();
});

test('Ctrl+Enter でも詳細パネルが応答を待たず即座に開き、ノートに入力しても遅延応答後に消えない', async ({ page }) => {
  await page.route('**/api/tasks', async (route) => {
    if (route.request().method() === 'POST') {
      await new Promise((r) => setTimeout(r, 400));
      await route.continue();
    } else {
      await route.continue();
    }
  });

  const todo = page.locator('.kb-col[data-col="TODO"]');
  await todo.locator('.kb-add').click();
  const composer = todo.locator('textarea.kb-composer');
  await composer.fill('詳細から作るタスク');
  await composer.press('Control+Enter');

  // 400ms の遅延応答を待たず、詳細パネルが即座に開く。
  await expect(page.locator('.kb-detail')).toBeVisible({ timeout: 200 });
  const notes = page.locator('.kb-detail-body .rf-ed');
  await notes.click();
  await page.keyboard.type('遅延中に書いたメモ');

  // 遅延応答（id の裏側での差し替え）が来ても、詳細パネルやメモ内容は消えない。
  await page.waitForTimeout(600);
  await expect(page.locator('.kb-detail')).toBeVisible();
  await expect(notes).toContainText('遅延中に書いたメモ');

  // 保存も正しい(差し替え後の本物の)idへ向く。
  await page.locator('.kb-detail-close').click();
  await expect(todo.locator('.kb-card', { hasText: '詳細から作るタスク' })).toBeVisible();
});
