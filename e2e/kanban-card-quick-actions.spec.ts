import { test, expect } from '@playwright/test';

/**
 * かんばんカードから詳細パネルを開かずに操作する E2E
 * （kanban-card-quick-delete / kanban-card-inline-rename, issue #29）。
 * ゴミ箱アイコン・右クリックからの削除と、ダブルクリックによるカード上インライン
 * リネームを実ブラウザで確認する。インメモリ DB（本番非干渉）。
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

test('ゴミ箱アイコンから削除する→確認して消える', async ({ page }) => {
  const { title } = await seedTask(page.request, 'ゴミ箱で削除するタスク');
  await page.reload();
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 2000 }).catch(() => {});
  await page.locator('#tabs button[data-target="kanban"]').click();

  const card = page.locator('.kb-card', { hasText: title });
  await expect(card).toBeVisible();

  page.once('dialog', (d) => d.accept());
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

  page.once('dialog', (d) => d.dismiss());
  await card.locator('.kb-card-del').click();

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
