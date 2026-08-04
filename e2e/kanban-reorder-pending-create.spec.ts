import { test, expect } from './fixtures.js';

/**
 * カンバンで新規カード作成後、サーバー応答（実ID採番）が返る前に同じ列で別カードを
 * ドラッグ&ドロップすると、まだ負の仮IDを持つ作成中カードが並べ替えの送信配列に混入し
 * 400 エラー→ reload で巻き戻る不具合の修正確認（issue #79）。
 * あわせて、コンポーザを開いたまま（フォーカスしたまま）並べ替えても、盤面の再描画が
 * クラッシュしないことも検証する（issue #85: renderAll 再入によるクラッシュ）。
 * 実際のマウスジェスチャによる HTML5 D&D はヘッドレス環境で不安定なため、kanban.js の実イベント
 * リスナーへ合成 DragEvent を直接ディスパッチして検証する（kanban-vertical-autoscroll.spec.ts と同じ手法）。
 * ワーカー内のサーバーは他specの作成物が残り得るため、順序検証は runId を含むタイトルだけに
 * 絞り込んだ部分集合に対して行う（Locator.filter）。
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

test('未着手列で作成中のカードがある間に同列を並べ替えてもエラーにならず、確定後もリロード後に順序が保持される', async ({ page, request }) => {
  const runId = Math.random().toString(36).slice(2, 8);
  const titleA = `並替A${runId}`;
  const titleB = `並替B${runId}`;
  const titleC = `作成中${runId}`;

  await request.post('/api/tasks', { data: { title: titleA, status: 'TODO' } });
  await request.post('/api/tasks', { data: { title: titleB, status: 'TODO' } });

  await openKanban(page);
  const todo = page.locator('.kb-col[data-col="TODO"]');
  await expect(todo.locator('.kb-card', { hasText: titleA })).toBeVisible();
  await expect(todo.locator('.kb-card', { hasText: titleB })).toBeVisible();

  await page.route('**/api/tasks', async (route) => {
    if (route.request().method() === 'POST') {
      await new Promise((r) => setTimeout(r, 400));
      await route.continue();
    } else {
      await route.continue();
    }
  });

  await todo.locator('.kb-add').click();
  const composer = todo.locator('textarea.kb-composer');
  await composer.fill(titleC);
  await composer.press('Enter');
  await expect(todo.locator('.kb-card', { hasText: titleC })).toBeVisible({ timeout: 200 });
  // コンポーザは開いたまま（フォーカスされたまま）にする（issue #85: この状態で並べ替えが
  // クラッシュしないことも合わせて検証する）。

  // 作成の応答待ち（400ms）のうちに、カードBをカードAの前へドラッグして並べ替える。
  await dragBeforeCard(
    page,
    todo.locator('.kb-card', { hasText: titleB }),
    todo.locator('.kb-card', { hasText: titleA }),
    todo,
  );

  const ourTitles = todo.locator('.kb-card-title').filter({ hasText: runId });

  // エラーtoastは出ず、ローカルの並び順は即座に更新される。
  await expect(page.locator('.toast-err')).toHaveCount(0);
  await expect(ourTitles).toHaveText([titleB, titleA, titleC]);

  // 作成が確定した後も、順序は崩れずエラーも出ない。
  await page.waitForTimeout(600);
  await expect(page.locator('.toast-err')).toHaveCount(0);
  await expect(ourTitles).toHaveText([titleB, titleA, titleC]);

  // リロード後も並び順が保持されている（サーバーへ永続化されている）。
  await page.reload();
  await openKanban(page);
  const todoAfterReload = page.locator('.kb-col[data-col="TODO"]');
  await expect(todoAfterReload.locator('.kb-card-title').filter({ hasText: runId })).toHaveText([titleB, titleA, titleC]);
});

test('作成が失敗した場合、保留していた並べ替えは作成中カードを除いた順序でリロード後も保持される', async ({ page, request }) => {
  const runId = Math.random().toString(36).slice(2, 8);
  const titleA = `失敗並替A${runId}`;
  const titleB = `失敗並替B${runId}`;
  const titleC = `失敗する作成中${runId}`;

  await request.post('/api/tasks', { data: { title: titleA, status: 'TODO' } });
  await request.post('/api/tasks', { data: { title: titleB, status: 'TODO' } });

  await openKanban(page);
  const todo = page.locator('.kb-col[data-col="TODO"]');
  await expect(todo.locator('.kb-card', { hasText: titleA })).toBeVisible();
  await expect(todo.locator('.kb-card', { hasText: titleB })).toBeVisible();

  await page.route('**/api/tasks', async (route) => {
    if (route.request().method() === 'POST') {
      await new Promise((r) => setTimeout(r, 300));
      await route.fulfill({ status: 500, body: 'boom' });
    } else {
      await route.continue();
    }
  });

  await todo.locator('.kb-add').click();
  const composer = todo.locator('textarea.kb-composer');
  await composer.fill(titleC);
  await composer.press('Enter');
  await expect(todo.locator('.kb-card', { hasText: titleC })).toBeVisible({ timeout: 200 });
  // コンポーザは開いたまま（フォーカスされたまま）にする（issue #85: この状態で並べ替えが
  // クラッシュしないことも合わせて検証する）。

  // 作成の応答待ち（300ms）のうちに、カードBをカードAの前へドラッグして並べ替える。
  await dragBeforeCard(
    page,
    todo.locator('.kb-card', { hasText: titleB }),
    todo.locator('.kb-card', { hasText: titleA }),
    todo,
  );

  const ourTitles = todo.locator('.kb-card-title').filter({ hasText: runId });

  // 並べ替え自体はエラーにならず即座に反映される。
  await expect(page.locator('.toast-err')).toHaveCount(0);
  await expect(ourTitles).toHaveText([titleB, titleA, titleC]);

  // 作成が失敗すると、失敗したカードは除去され「追加に失敗」toastのみ出る
  // （並べ替え保存の失敗toastは出ない＝dirty flush が400にならないこと）。
  await expect(todo.locator('.kb-card', { hasText: titleC })).toHaveCount(0);
  await expect(page.locator('.toast-err', { hasText: '追加に失敗' })).toBeVisible();
  await expect(page.locator('.toast-err')).toHaveCount(1);
  await expect(ourTitles).toHaveText([titleB, titleA]);

  // リロード後も、失敗したカードを除いた並び順が保持されている。
  await page.reload();
  await openKanban(page);
  const todoAfterReload = page.locator('.kb-col[data-col="TODO"]');
  await expect(todoAfterReload.locator('.kb-card-title').filter({ hasText: runId })).toHaveText([titleB, titleA]);
});
