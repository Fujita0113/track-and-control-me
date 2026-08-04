import { test, expect } from './fixtures.js';

/**
 * カードタイトルのインライン編集（リネーム）中に、盤面の再描画を伴う操作（同一列の
 * ドラッグ&ドロップ並べ替え）を行うと、リネーム入力 `<input class="kb-card-title-edit">`
 * が DOM から除去される際の同期 blur → `commitComposer` 相当の早期return内 `renderAll()`
 * 再入で盤面がクラッシュする不具合の修正確認（issue #85、design D1/D2 の `renderAll()`
 * 再入ガード。コンポーザ版は kanban-reorder-pending-create.spec.ts で検証済み、これは
 * カードタイトルのリネーム版）。
 * 実際のマウスジェスチャによる HTML5 D&D はヘッドレス環境で不安定なため、kanban.js の実イベント
 * リスナーへ合成 DragEvent を直接ディスパッチして検証する（kanban-vertical-autoscroll.spec.ts と同じ手法）。
 */

async function openKanban(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
  await page.locator('#tabs button[data-target="kanban"]').click();
  await expect(page.locator('.kb')).toBeVisible();
}

/** カードBをカードAの直前へドラッグする（同一列内の並べ替え）。 */
async function dragBeforeCard(
  page: import('@playwright/test').Page,
  cardToDrag: import('@playwright/test').Locator,
  targetCard: import('@playwright/test').Locator,
  colElm: import('@playwright/test').Locator,
) {
  const dragHandle = await cardToDrag.elementHandle();
  const targetHandle = await targetCard.elementHandle();
  const colHandle = await colElm.elementHandle();
  if (!dragHandle || !targetHandle || !colHandle) throw new Error('drag handles not found');
  await page.evaluate(([drag, target, col]) => {
    const dt = new DataTransfer();
    drag.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const rect = target.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, clientX: rect.left + 10, clientY: rect.top + 4, dataTransfer: dt };
    col.dispatchEvent(new DragEvent('dragover', opts));
    col.dispatchEvent(new DragEvent('drop', opts));
  }, [dragHandle, targetHandle, colHandle]);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('カードタイトルをリネーム中（空文字・フォーカスしたまま）に別カードを並べ替えてもクラッシュせず反映される', async ({ page, request }) => {
  const runId = Math.random().toString(36).slice(2, 8);
  const titleA = `並替A${runId}`;
  const titleB = `並替B${runId}`;
  const titleC = `編集中${runId}`;

  await request.post('/api/tasks', { data: { title: titleA, status: 'TODO' } });
  await request.post('/api/tasks', { data: { title: titleB, status: 'TODO' } });
  await request.post('/api/tasks', { data: { title: titleC, status: 'TODO' } });

  const pageErrors: Error[] = [];
  page.on('pageerror', (err) => pageErrors.push(err));

  await openKanban(page);
  const todo = page.locator('.kb-col[data-col="TODO"]');
  await expect(todo.locator('.kb-card', { hasText: titleA })).toBeVisible();
  await expect(todo.locator('.kb-card', { hasText: titleB })).toBeVisible();
  await expect(todo.locator('.kb-card', { hasText: titleC })).toBeVisible();

  // カードCをダブルクリックしてリネーム編集に入り、入力を空文字にする（未確定・フォーカスしたまま）。
  await todo.locator('.kb-card', { hasText: titleC }).dblclick();
  const renameInput = todo.locator('input.kb-card-title-edit');
  await expect(renameInput).toBeFocused();
  await renameInput.fill('');

  // リネーム入力が空文字・フォーカスされたままの状態で、カードBをカードAの前へドラッグする。
  await dragBeforeCard(
    page,
    todo.locator('.kb-card', { hasText: titleB }),
    todo.locator('.kb-card', { hasText: titleA }),
    todo,
  );

  const ourTitles = todo.locator('.kb-card-title').filter({ hasText: runId });

  // 再描画中に例外は発生せず、並べ替えは即座に反映される。
  await expect(page.locator('.toast-err')).toHaveCount(0);
  await expect(ourTitles).toHaveText([titleB, titleA, titleC]);
  expect(pageErrors).toEqual([]);

  // リネームは未確定（空文字）だったため、カードCのタイトルは元のまま維持される。
  await expect(todo.locator('.kb-card-title', { hasText: titleC })).toHaveText(titleC);

  // リロード後もA・Bの並び順が保持されている（サーバーへ永続化されている）。
  await page.reload();
  await openKanban(page);
  const todoAfterReload = page.locator('.kb-col[data-col="TODO"]');
  await expect(todoAfterReload.locator('.kb-card-title').filter({ hasText: runId })).toHaveText([titleB, titleA, titleC]);
});
