import { test, expect } from '@playwright/test';

/**
 * かんばんカード詳細のノートエディタ e2e（kanban-detail-shared-editor / issue #57）。
 * 独自の行ブロックエディタを共有エディタ(md-editor.js の createMarkdownEditor)へ置換した後、
 * (1) 複数ブロックをまたぐ選択・コピー、(2) Tab/Shift+Tab によるリスト・チェックリストのネスト
 * が成立することを実ブラウザで確認する。
 */
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

async function seedTask(request: import('@playwright/test').APIRequestContext, title: string, notes: string) {
  const created = await request.post('/api/tasks', { data: { title, status: 'TODO', notes } });
  const { id } = await created.json();
  return id;
}

async function fetchNotes(request: import('@playwright/test').APIRequestContext, id: number) {
  const res = await request.get('/api/tasks');
  const tasks = await res.json();
  return tasks.find((t: { id: number }) => t.id === id)?.notes ?? null;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
  await page.locator('#tabs button[data-target="kanban"]').click();
  await expect(page.locator('.kb')).toBeVisible();
});

test('複数ブロックをまたぐ Ctrl+A 選択でコピーできる（issue #57）', async ({ page }) => {
  const notes = '# 見出し\n本文A\n本文B';
  const title = `複数選択タスク${Date.now()}`;
  await seedTask(page.request, title, notes);
  await page.reload();
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 2000 }).catch(() => {});
  await page.locator('#tabs button[data-target="kanban"]').click();

  await page.locator('.kb-card', { hasText: title }).click();
  const editor = page.locator('.kb-detail-body .rf-ed');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+c');

  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.replace(/\r\n/g, '\n')).toBe(notes);
});

test('todo 行で Tab を押すとネストされ、フォーカスがエディタに留まる（削除ボタンへ飛ばない）', async ({ page }) => {
  const notes = '- [ ] タスク';
  const title = `Tabネストタスク${Date.now()}`;
  const id = await seedTask(page.request, title, notes);
  await page.reload();
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 2000 }).catch(() => {});
  await page.locator('#tabs button[data-target="kanban"]').click();

  await page.locator('.kb-card', { hasText: title }).click();
  const editor = page.locator('.kb-detail-body .rf-ed');
  await editor.locator('.rf-ed-task-text').click();
  await page.keyboard.press('Tab');

  // フォーカスはノートエディタ内に留まる（「タスクを削除」ボタンへ移動しない）。
  await expect(editor).toBeFocused();
  await expect(page.locator('.kb-del-btn')).not.toBeFocused();

  // 確定保存されたことを確認（詳細を閉じて flushSaves を通す）。
  await page.locator('.kb-detail-close').click();
  await expect.poll(() => fetchNotes(page.request, id)).toBe('  - [ ] タスク');
});

test('ネストした todo で Shift+Tab を押すとネストが解除される', async ({ page }) => {
  const notes = '  - [ ] タスク';
  const title = `Shift Tabタスク${Date.now()}`;
  const id = await seedTask(page.request, title, notes);
  await page.reload();
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 2000 }).catch(() => {});
  await page.locator('#tabs button[data-target="kanban"]').click();

  await page.locator('.kb-card', { hasText: title }).click();
  const editor = page.locator('.kb-detail-body .rf-ed');
  await editor.locator('.rf-ed-task-text').click();
  await page.keyboard.press('Shift+Tab');

  await expect(editor).toBeFocused();
  await page.locator('.kb-detail-close').click();
  await expect.poll(() => fetchNotes(page.request, id)).toBe('- [ ] タスク');
});

test('見出し・段落など非リスト行では Tab がフォーカス移動として働く', async ({ page }) => {
  const notes = 'ただの段落';
  const title = `Tabフォーカス移動タスク${Date.now()}`;
  await seedTask(page.request, title, notes);
  await page.reload();
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 2000 }).catch(() => {});
  await page.locator('#tabs button[data-target="kanban"]').click();

  await page.locator('.kb-card', { hasText: title }).click();
  const editor = page.locator('.kb-detail-body .rf-ed');
  await editor.click();
  await page.keyboard.press('Tab');

  // 非リスト行では既定のフォーカス移動が働き、詳細パネル内の次のコントロール（削除ボタン）へ到達する。
  await expect(page.locator('.kb-del-btn')).toBeFocused();
});

test('チェックボックストグルが保存される', async ({ page }) => {
  const notes = '- [ ] タスク';
  const title = `チェックトグルタスク${Date.now()}`;
  const id = await seedTask(page.request, title, notes);
  await page.reload();
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 2000 }).catch(() => {});
  await page.locator('#tabs button[data-target="kanban"]').click();

  await page.locator('.kb-card', { hasText: title }).click();
  const editor = page.locator('.kb-detail-body .rf-ed');
  await editor.locator('.rf-ed-check').click();
  await expect(editor.locator('.rf-ed-task.checked')).toBeVisible();

  await page.locator('.kb-detail-close').click();
  await expect.poll(() => fetchNotes(page.request, id)).toBe('- [x] タスク');
});
