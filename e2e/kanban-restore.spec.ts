import { test, expect } from '@playwright/test';

/**
 * かんばんの「アーカイブ済みタスクを戻す」E2E（kanban-restore-archived / issue #45）。
 * インメモリ DB（本番非干渉）で、完了（DONE）タスクがアクティビティログに出現→「戻す」で
 * 未着手（TODO）列へ復帰しログから消えることを実ブラウザで確認する。
 * 完了操作自体は D&D で不安定なため、DONE タスクは API でシード（done_at を今日に刻む）する。
 */

/** DONE 状態で done_at=今日 のタスクをシードする（title を返す）。 */
async function seedArchivedTask(request: import('@playwright/test').APIRequestContext, title: string) {
  const created = await request.post('/api/tasks', { data: { title, status: 'DOING' } });
  const { id } = await created.json();
  await request.patch(`/api/tasks/${id}`, { data: { status: 'DONE' } });
  return { id, title };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
});

test('アクティビティログの「戻す」で完了タスクが未着手列へ復帰する（issue #45）', async ({ page }) => {
  const { title } = await seedArchivedTask(page.request, '誤ってアーカイブしたタスク');

  // かんばんを開くと reload() でシード済みタスクが読み込まれる。
  await page.locator('#tabs button[data-target="kanban"]').click();
  await expect(page.locator('.kb')).toBeVisible();

  // アクティビティログに完了として出現し、「戻す」ボタンがある。
  const logRow = page.locator('.kb-log-row', { hasText: title });
  await expect(logRow).toBeVisible();
  await expect(logRow.locator('.kb-log-text')).toContainText('を完了しました');
  const undo = logRow.locator('.kb-log-undo');
  await expect(undo).toBeVisible();

  // 復帰前は未着手列に当該カードは無い。
  const todoCard = page.locator('.kb-col[data-col="TODO"] .kb-card', { hasText: title });
  await expect(todoCard).toHaveCount(0);

  // 「戻す」→ 未着手列末尾へ復帰し、ログからは消える。
  await undo.click();
  await expect(todoCard).toHaveCount(1);
  await expect(page.locator('.kb-log-row', { hasText: title })).toHaveCount(0);

  // リロードしても永続化されている（done_at クリア＝TODO のまま）。
  await page.reload();
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 2000 }).catch(() => {});
  await page.locator('#tabs button[data-target="kanban"]').click();
  await expect(page.locator('.kb-col[data-col="TODO"] .kb-card', { hasText: title })).toHaveCount(1);
  await expect(page.locator('.kb-log-row', { hasText: title })).toHaveCount(0);
});
