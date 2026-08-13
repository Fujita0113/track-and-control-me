import { test, expect } from './fixtures.js';

/**
 * タスク一覧のカード型ツリー・キーボード操作の通し E2E（issue #91 / change task-list-card-tree-ui）。
 * tasks.md §0 に挙げた8フローを、実装した DOM に対して書く（propose 側では書かない・凍結ライン）。
 *   1. 空のツリーで Enter を続けて押し、マウスを使わずに3件を同じ深さで打ち込む
 *   2. 2件目で Tab → 1件目の子になり、1件目が容れ物になって盤面から消え、2件目がカードとして現れる
 *   3. 子で Shift+Tab → 親と同じ深さになり、親の直後に並ぶ
 *   4. 容れ物のチェックを付ける → 配下の葉が全部完了になる。外すと未着手へ戻る
 *   5. Ctrl+Enter で詳細モーダルが開き、本文を書いて閉じる → カンバンの同じカードのノートに反映される
 *   6. カンバンのカードの帯に目標名と直近の親が出る。同じ枝の2枚は同じ色
 *   7. ⋯ を開くと削除だけがあり、子を持つノードの削除には確認が出て子は繰り上がる
 *   8. デモモードでは追加・改名・階層の変更・完了の切り替え・⋯ のいずれも出ない
 *
 * change `kanban-goal-root-crumb`（issue #101）で、目標のタスク一覧から分解せず直接作った
 * 根タスクの帯（目標名だけを表示し、区切り記号・親名は出さない）のフローを1本追加した。
 *
 * タイトルは常時編集できる <input>（design D7）なので、Playwright の hasText（textContent 基準）
 * では値を捕まえられない。ノードのタイトルは `input.bp-node-title[value="..."]` で捕まえる。
 */

async function createGoal(request: import('@playwright/test').APIRequestContext, name: string) {
  const res = await request.post('/api/goals', {
    data: {
      name,
      purpose: '内定を取る',
      startReason: '就活のため',
      endDay: '2026-12-31',
      rules: [{ target: 'MANUAL_CHECK', label: '毎日振り返る', reason: '習慣化のため' }],
    },
  });
  return res.json();
}

function openBlueprint(page: import('@playwright/test').Page, goalName: string) {
  return page
    .locator('.gr-goal-card', { hasText: goalName })
    .getByRole('button', { name: 'タスク一覧', exact: true })
    .click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
});

async function gotoGoalBlueprint(page: import('@playwright/test').Page, goalName: string) {
  await page.locator('#tabs button[data-target="goals"]').click();
  await page.locator('.gr-goal-card', { hasText: goalName }).first().waitFor();
  await openBlueprint(page, goalName);
  await expect(page.locator('.bp-tree-wrap')).toBeVisible();
}

test('空のツリーで Enter を続けて押し、マウスを使わずに3件を同じ深さで打ち込む', async ({ page, request }) => {
  const goal = await createGoal(request, `キーボード追加e2e${Date.now()}`);
  await gotoGoalBlueprint(page, goal.name);

  // 空のツリーは自動でエフェメラルな追加入力が開いてフォーカスされている。
  const addInput = page.locator('.bp-add-input');
  await expect(addInput).toBeFocused();
  await addInput.fill('枝1');
  await addInput.press('Enter');
  await expect(page.locator('.bp-tree input.bp-node-title[value="枝1"]')).toBeVisible();

  await expect(page.locator('.bp-add-input')).toBeFocused();
  await page.locator('.bp-add-input').fill('枝2');
  await page.locator('.bp-add-input').press('Enter');
  await expect(page.locator('.bp-tree input.bp-node-title[value="枝2"]')).toBeVisible();

  await page.locator('.bp-add-input').fill('枝3');
  await page.locator('.bp-add-input').press('Enter');
  await expect(page.locator('.bp-tree input.bp-node-title[value="枝3"]')).toBeVisible();

  await expect(page.locator('.bp-tree > .bp-node')).toHaveCount(3);
});

test('2件目で Tab を押す → 1件目の子になり、1件目が容れ物になって盤面から消え、2件目がカードとして現れる', async ({ page, request }) => {
  const goal = await createGoal(request, `Tabで潜るe2e${Date.now()}`);
  const t1 = `分解元${Date.now()}`;
  const t2 = `分解先${Date.now()}`;
  await request.post(`/api/goals/${goal.id}/blueprint/root`, { data: { title: t1 } });
  await request.post(`/api/goals/${goal.id}/blueprint/root`, { data: { title: t2 } });
  await gotoGoalBlueprint(page, goal.name);

  await page.locator(`.bp-node-title[value="${t2}"]`).click();
  await page.keyboard.press('Tab');

  const parentRow = page.locator('.bp-node-row', { has: page.locator(`.bp-node-title[value="${t1}"]`) });
  await expect(parentRow.locator('.bp-node-childcount')).toHaveText('0/1');
  await expect(page.locator('.bp-tree > .bp-node > .bp-node-row')).toHaveCount(1); // 根は t1 だけ
  await expect(page.locator(`.bp-node-children .bp-node-title[value="${t2}"]`)).toBeVisible();

  await page.locator('#tabs button[data-target="kanban"]').click();
  await expect(page.locator('.kb-card-title', { hasText: t1 })).toHaveCount(0); // 容れ物は盤面に出ない
  const childCard = page.locator('.kb-card', { hasText: t2 });
  await expect(childCard).toBeVisible();
  await expect(childCard.locator('.kb-breadcrumb')).toContainText(t1);
});

test('子で Shift+Tab を押す → 親と同じ深さになり、親の直後に並ぶ', async ({ page, request }) => {
  const goal = await createGoal(request, `ShiftTabe2e${Date.now()}`);
  await request.post(`/api/goals/${goal.id}/blueprint/import`, {
    data: { text: '- P\n  - C1\n  - C2\n  - C3' },
  });
  await gotoGoalBlueprint(page, goal.name);

  await page.locator('.bp-node-title[value="C2"]').click();
  await page.keyboard.press('Shift+Tab');

  // 根は P・C2 の順（C2 が P の直後）。P の子は C1・C3 だけになる。
  const rootRows = page.locator('.bp-tree > .bp-node > .bp-node-row .bp-node-title');
  await expect(rootRows).toHaveCount(2);
  await expect(rootRows.nth(0)).toHaveValue('P');
  await expect(rootRows.nth(1)).toHaveValue('C2');
  const pChildren = page.locator('.bp-tree > .bp-node > .bp-node-children .bp-node-title');
  await expect(pChildren).toHaveCount(2);
  await expect(pChildren.nth(0)).toHaveValue('C1');
  await expect(pChildren.nth(1)).toHaveValue('C3');
});

test('容れ物のチェックを付ける → 配下の葉が全部完了になり、外すと未着手へ戻る', async ({ page, request }) => {
  const goal = await createGoal(request, `一括完了e2e${Date.now()}`);
  const bp = await (
    await request.post(`/api/goals/${goal.id}/blueprint/import`, { data: { text: '- 枝\n  - a\n  - b' } })
  ).json();
  const branch = bp.nodes[0];
  await gotoGoalBlueprint(page, goal.name);

  const branchRow = page.locator(`.bp-node-row[data-id="${branch.id}"]`);
  await branchRow.locator('.bp-checkbox').click();

  await expect.poll(async () => {
    const tasks = await (await request.get('/api/tasks')).json();
    return tasks.filter((t: { id: number; status: string }) => branch.children.some((c: { id: number }) => c.id === t.id) && t.status === 'DONE').length;
  }).toBe(2);
  // 葉2つに加え、容れ物自身の完了も子から導出されて .done が付く（3件）。
  await expect(page.locator('.bp-node-title.done')).toHaveCount(3);

  await branchRow.locator('.bp-checkbox').click();
  await expect.poll(async () => {
    const tasks = await (await request.get('/api/tasks')).json();
    return tasks.filter((t: { id: number; status: string }) => branch.children.some((c: { id: number }) => c.id === t.id) && t.status === 'TODO').length;
  }).toBe(2);
});

test('Ctrl+Enter で詳細モーダルが開き、本文を書いて閉じる → カンバンの同じカードのノートに反映される', async ({ page, request }) => {
  const goal = await createGoal(request, `詳細モーダルe2e${Date.now()}`);
  const title = `葉${Date.now()}`;
  await request.post(`/api/goals/${goal.id}/blueprint/root`, { data: { title } });
  await gotoGoalBlueprint(page, goal.name);

  await page.locator(`.bp-node-title[value="${title}"]`).click();
  await page.keyboard.press('Control+Enter');
  const modal = page.locator('.bp-detail-veil');
  await expect(modal).toBeVisible();
  await expect(modal.locator('.bp-detail-crumb')).toHaveText(goal.name);
  await expect(modal.locator('.bp-detail-title')).toHaveText(title);

  const body = '# メモ\n進め方を書く';
  await modal.locator('.bp-detail-ed .rf-ed').click();
  await page.keyboard.type(body);
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);

  const taskId = (await (await request.get('/api/goals/' + goal.id + '/blueprint')).json()).nodes[0].id;
  await expect.poll(async () => {
    const tasks = await (await request.get('/api/tasks')).json();
    return tasks.find((t: { id: number }) => t.id === taskId)?.notes;
  }).toContain('進め方を書く');

  await page.locator('#tabs button[data-target="kanban"]').click();
  await page.locator('.kb-card', { hasText: title }).click();
  await expect(page.locator('.kb-detail-body .rf-ed')).toContainText('進め方を書く');
});

test('カンバンのカードの帯に目標名と直近の親が出る。同じ枝の2枚は同じ色', async ({ page, request }) => {
  const goal = await createGoal(request, `帯の色e2e${Date.now()}`);
  await request.post(`/api/goals/${goal.id}/blueprint/import`, {
    data: { text: '- 枝A\n  - leafA1\n  - leafA2' },
  });
  await page.locator('#tabs button[data-target="kanban"]').click();

  const cardA1 = page.locator('.kb-card', { hasText: 'leafA1' });
  const cardA2 = page.locator('.kb-card', { hasText: 'leafA2' });
  await expect(cardA1.locator('.kb-breadcrumb')).toContainText(goal.name);
  await expect(cardA1.locator('.kb-breadcrumb')).toContainText('枝A');
  await expect(cardA2.locator('.kb-breadcrumb')).toContainText('枝A');

  const classA1 = await cardA1.locator('.kb-breadcrumb').getAttribute('class');
  const classA2 = await cardA2.locator('.kb-breadcrumb').getAttribute('class');
  const colorOf = (cls: string | null) => (cls || '').split(' ').find((c) => c.startsWith('c-'));
  expect(colorOf(classA1)).toBeTruthy();
  expect(colorOf(classA1)).toBe(colorOf(classA2)); // 同じ枝は同じ色
});

test('目標のタスク一覧から分解せず直接作った根タスクの帯には目標名だけが出る（issue #101 / change kanban-goal-root-crumb）', async ({ page, request }) => {
  const goal = await createGoal(request, `根タスク帯e2e${Date.now()}`);
  await request.post(`/api/goals/${goal.id}/blueprint/import`, {
    data: { text: '- 分解しない根タスク' },
  });
  await page.locator('#tabs button[data-target="kanban"]').click();

  const card = page.locator('.kb-card', { hasText: '分解しない根タスク' });
  const crumb = card.locator('.kb-breadcrumb');
  await expect(crumb).toHaveText(goal.name); // 目標名だけで、区切り記号・親名は出ない
  await expect(crumb.locator('.kb-breadcrumb-sep')).toHaveCount(0);
  await expect(crumb.locator('.kb-breadcrumb-parent')).toHaveCount(0);
});

test('⋯ を開くと削除だけがあり、子を持つノードの削除には確認が出て子は繰り上がる', async ({ page, request }) => {
  const goal = await createGoal(request, `削除メニューe2e${Date.now()}`);
  const bp = await (
    await request.post(`/api/goals/${goal.id}/blueprint/import`, { data: { text: '- 枝X\n  - c1\n  - c2' } })
  ).json();
  const branch = bp.nodes[0];
  await gotoGoalBlueprint(page, goal.name);

  const branchRow = page.locator(`.bp-node-row[data-id="${branch.id}"]`);
  await branchRow.hover();
  await branchRow.locator('.bp-node-menu-btn').click();
  const menuItems = page.locator('.bp-menu .bp-menu-item');
  await expect(menuItems).toHaveCount(1);
  await expect(menuItems.first()).toHaveText('削除');

  page.once('dialog', (d) => d.accept());
  await menuItems.first().click();

  await expect(page.locator(`.bp-node-title[value="枝X"]`)).toHaveCount(0);
  // 子は根へ繰り上がって残る。
  await expect(page.locator('.bp-tree > .bp-node > .bp-node-row .bp-node-title')).toHaveCount(2);
  await expect(page.locator('.bp-node-title[value="c1"]')).toBeVisible();
  await expect(page.locator('.bp-node-title[value="c2"]')).toBeVisible();
});

test('デモモードでは追加・改名・階層の変更・完了の切り替え・⋯ のいずれも出ない', async ({ page }) => {
  await page.locator('#tabs button[data-target="settings"]').click();
  await page.getByRole('button', { name: '🧪 デモを開始' }).click();
  await expect(page.locator('#demobar')).toBeVisible();

  await page.locator('#tabs button[data-target="goals"]').click();
  await page.locator('.gr-goal-card', { hasText: 'メンタルを安定させる' }).first().waitFor();
  await openBlueprint(page, 'メンタルを安定させる');
  await expect(page.locator('.bp-tree-wrap')).toBeVisible();

  await expect(page.locator('.bp-tree input.bp-node-title')).toHaveCount(0);
  await expect(page.locator('.bp-tree span.bp-node-title').first()).toBeVisible();
  await expect(page.locator('.bp-node-menu-btn')).toHaveCount(0);
  await expect(page.locator('.bp-add-btn')).toHaveCount(0);
  await expect(page.locator('.bp-legend')).toHaveCount(0);
  await expect(page.locator('.bp-head-actions').getByRole('button', { name: 'まとめて追加' })).toHaveCount(0);

  await page.locator('.bp-node-row').first().click();
  await page.keyboard.press('Control+Enter');
  await expect(page.locator('.bp-detail-veil')).toHaveCount(0);
});
