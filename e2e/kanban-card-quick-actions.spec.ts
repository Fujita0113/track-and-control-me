import { test, expect } from './fixtures.js';

/**
 * かんばんカードから詳細パネルを開かずに操作する E2E
 * （kanban-card-quick-delete / kanban-card-inline-rename, issue #29）。
 * ゴミ箱アイコン・右クリックからの削除と、ダブルクリックによるカード上インライン
 * リネームを実ブラウザで確認する。インメモリ DB（本番非干渉）。
 *
 * kanban-delete-skip-confirm（issue #95）以降、ゴミ箱アイコン起点の確認は
 * 「次回から確認しない」を持つカスタムモーダルに置き換わり window.confirm() を使わない。
 * そのモーダルの DOM は実装時に決まるためここでは踏まず、確認の有無だけを検証できる
 * 経路（右クリック＝window.confirm() のまま／スキップ設定ON＝ダイアログ自体が出ない）に
 * 差し替えている。カスタムモーダル自体の新規 e2e は実装後に別途追加する。
 */

async function seedTask(request: import('@playwright/test').APIRequestContext, title: string) {
  const created = await request.post('/api/tasks', { data: { title, status: 'TODO' } });
  const { id } = await created.json();
  return { id, title };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
  await page.locator('#tabs button[data-target="kanban"]').click();
  await expect(page.locator('.kb')).toBeVisible();
});

test('ゴミ箱アイコンから削除する→「次回から確認しない」が有効なら確認なしで即削除される', async ({ page }) => {
  const { title } = await seedTask(page.request, 'スキップ設定ONで削除するタスク');
  // kanban-delete-skip-confirm design D3 で決めた localStorage キー契約。
  // カスタムモーダルの DOM には依存しない（それは apply が実装時に決める）。
  await page.evaluate(() => localStorage.setItem('tcm_kanban_skip_delete_confirm', '1'));
  await page.reload();
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 2000 }).catch(() => {});
  await page.locator('#tabs button[data-target="kanban"]').click();

  const card = page.locator('.kb-card', { hasText: title });
  await expect(card).toBeVisible();

  // スキップ設定が有効なので確認ステップ自体が出ない。万一まだ出る場合は Playwright が
  // 既定でダイアログを自動 dismiss するため、以下の toHaveCount(0) が失敗して検知できる。
  await card.locator('.kb-card-del').click();

  await expect(card).toHaveCount(0);
  await expect(page.locator('.kb-detail')).toHaveCount(0);
});

test('カードを右クリックして削除する→確認して消える', async ({ page }) => {
  const { title } = await seedTask(page.request, '右クリックで削除するタスク');
  await page.reload();
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 2000 }).catch(() => {});
  await page.locator('#tabs button[data-target="kanban"]').click();

  const card = page.locator('.kb-card', { hasText: title });
  await expect(card).toBeVisible();

  page.once('dialog', (d) => d.accept());
  await card.click({ button: 'right' });

  await expect(card).toHaveCount(0);
  await expect(page.locator('.kb-detail')).toHaveCount(0);
});

test('確認をキャンセルすると削除されない', async ({ page }) => {
  const { title } = await seedTask(page.request, 'キャンセルするタスク');
  await page.reload();
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 2000 }).catch(() => {});
  await page.locator('#tabs button[data-target="kanban"]').click();

  const card = page.locator('.kb-card', { hasText: title });
  await expect(card).toBeVisible();

  // kanban-delete-skip-confirm 以降もゴミ箱アイコンではなく右クリック（window.confirm() の
  // まま変わらない経路）でキャンセル動作を検証する（ゴミ箱アイコン側は新モーダルに置き換わる）。
  page.once('dialog', (d) => d.dismiss());
  await card.click({ button: 'right' });

  await expect(card).toHaveCount(1);
});

test('削除は即座にボードから消える（Optimistic UI）が、失敗時は復元される', async ({ page }) => {
  const { id, title } = await seedTask(page.request, 'サーバーエラーで復元されるタスク');
  await page.reload();
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 2000 }).catch(() => {});
  await page.locator('#tabs button[data-target="kanban"]').click();

  // DELETE を失敗させる。応答に遅延を入れ、「サーバー応答を待たず消える」→「失敗後に戻る」の
  // 2段階を確実に観測できるようにする（即時応答だと一瞬で戻ってしまい判定が不安定になるため）。
  await page.route(`**/api/tasks/${id}`, async (route) => {
    if (route.request().method() === 'DELETE') {
      await new Promise((r) => setTimeout(r, 400));
      await route.fulfill({ status: 500, body: 'boom' });
    } else {
      await route.continue();
    }
  });

  const card = page.locator(`.kb-card[data-id="${id}"]`);
  await expect(card).toBeVisible();

  // kanban-delete-skip-confirm 以降もゴミ箱アイコンではなく右クリック（window.confirm() の
  // まま変わらない経路）で検証する。削除実行部（execDelete）は起点によらず共通なので、
  // Optimistic UI とロールバックの回帰はこの経路でも同じく検知できる。
  page.once('dialog', (d) => d.accept());
  await card.click({ button: 'right' });

  // サーバー応答（失敗）を待たず即座にボードから消える。
  await expect(card).toHaveCount(0);

  // 失敗レスポンスの後、ロールバックされ元の位置に復元される。
  await expect(card).toHaveCount(1);
  await expect(card.locator('.kb-card-title')).toHaveText(title);
  await expect(page.locator('.toast-err', { hasText: '削除に失敗' })).toBeVisible();
});

// --- ゴミ箱アイコンのカスタム確認モーダル（kanban-delete-skip-confirm, issue #95） -----

test('ゴミ箱アイコンで削除を開始すると、確認モーダルに「次回から確認しない」チェックボックスが出る', async ({ page }) => {
  const { title } = await seedTask(page.request, 'モーダル表示を確認するタスク');
  await page.reload();
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 2000 }).catch(() => {});
  await page.locator('#tabs button[data-target="kanban"]').click();

  const card = page.locator('.kb-card', { hasText: title });
  await expect(card).toBeVisible();
  await card.locator('.kb-card-del').click();

  await expect(page.locator('#modal-root')).toHaveClass(/open/);
  await expect(page.locator('.modal-panel', { hasText: 'このタスクを削除しますか?' })).toBeVisible();
  await expect(page.locator('.modal-panel', { hasText: '次回から確認しない' }).locator('input[type="checkbox"]')).toHaveCount(1);
  // まだ削除は実行されていない。
  await expect(card).toHaveCount(1);
});

test('チェックを入れて削除する→以後ゴミ箱アイコンでの削除は確認モーダルを経ずに即実行される', async ({ page }) => {
  const first = await seedTask(page.request, '1件目・チェックして削除するタスク');
  const second = await seedTask(page.request, '2件目・確認省略で消えるタスク');
  await page.reload();
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 2000 }).catch(() => {});
  await page.locator('#tabs button[data-target="kanban"]').click();

  const firstCard = page.locator('.kb-card', { hasText: first.title });
  await firstCard.locator('.kb-card-del').click();
  await page.locator('.modal-panel input[type="checkbox"]').check();
  await page.locator('.modal-panel button.danger', { hasText: '削除' }).click();

  await expect(firstCard).toHaveCount(0);
  await expect(page.locator('#modal-root')).not.toHaveClass(/open/);

  // 2件目: 確認モーダルを経ずに即削除される。
  const secondCard = page.locator('.kb-card', { hasText: second.title });
  await expect(secondCard).toBeVisible();
  await secondCard.locator('.kb-card-del').click();

  await expect(secondCard).toHaveCount(0);
  await expect(page.locator('#modal-root')).not.toHaveClass(/open/);
});

test('チェックを入れずに削除する→次回もゴミ箱アイコンで確認モーダルが出る', async ({ page }) => {
  const first = await seedTask(page.request, '1件目・チェックせず削除するタスク');
  const second = await seedTask(page.request, '2件目・再度確認されるタスク');
  await page.reload();
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 2000 }).catch(() => {});
  await page.locator('#tabs button[data-target="kanban"]').click();

  const firstCard = page.locator('.kb-card', { hasText: first.title });
  await firstCard.locator('.kb-card-del').click();
  await page.locator('.modal-panel button.danger', { hasText: '削除' }).click(); // チェックは入れない

  await expect(firstCard).toHaveCount(0);
  await expect(page.locator('#modal-root')).not.toHaveClass(/open/);

  // 2件目: 再び確認モーダルが出る。
  const secondCard = page.locator('.kb-card', { hasText: second.title });
  await expect(secondCard).toBeVisible();
  await secondCard.locator('.kb-card-del').click();

  await expect(page.locator('#modal-root')).toHaveClass(/open/);
  await expect(secondCard).toHaveCount(1); // まだ削除されていない
});

test('確認モーダルでキャンセルする→タスクは削除されずボードに残る', async ({ page }) => {
  const { title } = await seedTask(page.request, 'モーダルでキャンセルするタスク');
  await page.reload();
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 2000 }).catch(() => {});
  await page.locator('#tabs button[data-target="kanban"]').click();

  const card = page.locator('.kb-card', { hasText: title });
  await card.locator('.kb-card-del').click();
  await expect(page.locator('#modal-root')).toHaveClass(/open/);
  await page.locator('.modal-panel button', { hasText: 'キャンセル' }).click();

  await expect(page.locator('#modal-root')).not.toHaveClass(/open/);
  await expect(card).toHaveCount(1);
});

test('確認モーダルで Escape を押す→タスクは削除されずボードに残る', async ({ page }) => {
  const { title } = await seedTask(page.request, 'モーダルでEscapeするタスク');
  await page.reload();
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 2000 }).catch(() => {});
  await page.locator('#tabs button[data-target="kanban"]').click();

  const card = page.locator('.kb-card', { hasText: title });
  await card.locator('.kb-card-del').click();
  await expect(page.locator('#modal-root')).toHaveClass(/open/);
  await page.keyboard.press('Escape');

  await expect(page.locator('#modal-root')).not.toHaveClass(/open/);
  await expect(card).toHaveCount(1);
});

test('カードをダブルクリックしてタイトルを直し、Enterで確定するとボード上のタイトルが変わる', async ({ page }) => {
  const { id, title } = await seedTask(page.request, '直す前のタイトル');
  await page.reload();
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 2000 }).catch(() => {});
  await page.locator('#tabs button[data-target="kanban"]').click();

  // リネーム中は .kb-card-title (テキスト) が input (value) に置き換わるため、
  // hasText では追跡できない。data-id で安定して同一カードを指す。
  const card = page.locator(`.kb-card[data-id="${id}"]`);
  await expect(card).toHaveText(new RegExp(title));
  await card.locator('.kb-card-title').dblclick();

  const input = card.locator('.kb-card-title-edit');
  await expect(input).toBeFocused();
  await input.fill('直した後のタイトル');
  await input.press('Enter');

  await expect(card.locator('.kb-card-title-edit')).toHaveCount(0);
  await expect(card.locator('.kb-card-title')).toHaveText('直した後のタイトル');
  await expect(page.locator('.kb-detail')).toHaveCount(0);

  // リロードしても保存されている。
  await page.reload();
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 2000 }).catch(() => {});
  await page.locator('#tabs button[data-target="kanban"]').click();
  await expect(page.locator('.kb-card', { hasText: '直した後のタイトル' })).toHaveCount(1);
  await expect(page.locator('.kb-card', { hasText: title })).toHaveCount(0);
});

test('カードをダブルクリックして編集中にEscapeで元のタイトルに戻る', async ({ page }) => {
  const { id, title } = await seedTask(page.request, 'Escapeで戻すタイトル');
  await page.reload();
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 2000 }).catch(() => {});
  await page.locator('#tabs button[data-target="kanban"]').click();

  const card = page.locator(`.kb-card[data-id="${id}"]`);
  await card.locator('.kb-card-title').dblclick();

  const input = card.locator('.kb-card-title-edit');
  await expect(input).toBeFocused();
  await input.fill('保存されないはずのタイトル');
  await input.press('Escape');

  await expect(card.locator('.kb-card-title-edit')).toHaveCount(0);
  await expect(card.locator('.kb-card-title')).toHaveText(title);
});

test('タイトル以外（優先度バッジ付近）をダブルクリックしてもリネームに入る', async ({ page }) => {
  const { id } = await seedTask(page.request, '優先度付近ダブルクリック');
  await page.reload();
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 2000 }).catch(() => {});
  await page.locator('#tabs button[data-target="kanban"]').click();

  const card = page.locator(`.kb-card[data-id="${id}"]`);
  await card.locator('.kb-pri').dblclick();

  await expect(card.locator('.kb-card-title-edit')).toBeFocused();
  await expect(page.locator('.kb-detail')).toHaveCount(0);
});
