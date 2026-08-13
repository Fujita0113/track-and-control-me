import { test, expect } from './fixtures.js';

/**
 * issue #99（長期目標エディタ改修：ライト版 / change: goal-blueprint-editor-fix）の通し E2E。
 *   1. タイトルを編集してツリーの外へクリックすると、入力枠のフォーカスと選択枠 (.sel) が外れる。
 *      別のノードをクリックすればそこから↑↓でタスク移動を再開できる。
 *   2. Detail モーダルに本文を書いて閉じても、一覧の行の下にプレビューが出ない。
 *   3. 空のエフェメラルな追加入力（design D3・issue #99 追加コメント）は、他ノードクリック／
 *      ツリー外クリック／Escape／Delete のいずれでも閉じる。
 *      （「文字が入っていれば自動では閉じない」は、この change の前後で挙動が変わらない
 *        既存の性質のため red-proof できず、e2e には含めない。tasks.md §4.6 で手動確認する。）
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

test('タイトル編集後にツリー外をクリックすると入力枠と選択枠が外れ、別ノードをクリックすれば↑↓を再開できる', async ({ page, request }) => {
  const goal = await createGoal(request, `編集離脱e2e${Date.now()}`);
  const titleA = `タスクA${Date.now()}`;
  const titleB = `タスクB${Date.now()}`;
  await request.post(`/api/goals/${goal.id}/blueprint/root`, { data: { title: titleA } });
  await request.post(`/api/goals/${goal.id}/blueprint/root`, { data: { title: titleB } });
  await gotoGoalBlueprint(page, goal.name);

  const inputA = page.locator(`.bp-node-title[value="${titleA}"]`);
  await inputA.click();
  await expect(inputA).toBeFocused();
  const changedTitleA = `${titleA}改`;
  await inputA.fill(changedTitleA);
  // タイトル入力欄の外（ヘッダの目標名見出し）をクリックして離脱する。
  await page.locator('.bp-title', { hasText: goal.name }).click();

  const savedInputA = page.locator(`.bp-node-title[value="${changedTitleA}"]`);
  await expect(savedInputA).toBeVisible();
  await expect(savedInputA).not.toBeFocused();
  await expect(page.locator('.bp-node-row.sel')).toHaveCount(0);

  // 別のノードのタイトルをクリックして乗り換える。選択枠(.sel)の見た目は次の再描画まで
  // 追いつかない（クリックだけでは再描画しない・本 change のスコープ外の既存挙動）ため、
  // ここでは「そこから↑↓でタスク移動を再開できる」という機能面だけを見る。
  const inputB = page.locator(`.bp-node-title[value="${titleB}"]`);
  await inputB.click();
  await expect(inputB).toBeFocused();

  await page.keyboard.press('ArrowUp');
  await expect(savedInputA).toBeFocused();
  await expect(page.locator('.bp-node-row.sel input.bp-node-title')).toHaveValue(changedTitleA);
});

test('Detail モーダルに本文を書いて閉じても、一覧の行の下にプレビューが出ない', async ({ page, request }) => {
  const goal = await createGoal(request, `本文漏れe2e${Date.now()}`);
  const title = `葉${Date.now()}`;
  await request.post(`/api/goals/${goal.id}/blueprint/root`, { data: { title } });
  await gotoGoalBlueprint(page, goal.name);

  await page.locator(`.bp-node-title[value="${title}"]`).click();
  await page.keyboard.press('Control+Enter');
  const modal = page.locator('.bp-detail-veil');
  await expect(modal).toBeVisible();

  const body = 'この本文は一覧に漏れてはいけない';
  await modal.locator('.bp-detail-ed .rf-ed').click();
  await page.keyboard.type(body);
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);

  const taskId = (await (await request.get(`/api/goals/${goal.id}/blueprint`)).json()).nodes[0].id;
  await expect.poll(async () => {
    const tasks = await (await request.get('/api/tasks')).json();
    return tasks.find((t: { id: number }) => t.id === taskId)?.notes;
  }).toContain(body);

  await expect(page.locator('.bp-node-notes')).toHaveCount(0);
  await expect(page.locator('.bp-tree')).not.toContainText(body);
});

async function setupTwoTasks(
  page: import('@playwright/test').Page,
  request: import('@playwright/test').APIRequestContext,
  label: string,
) {
  const goal = await createGoal(request, `${label}${Date.now()}`);
  const titleA = `サンプル${Date.now()}`;
  const titleB = `サンプル2${Date.now()}`;
  await request.post(`/api/goals/${goal.id}/blueprint/root`, { data: { title: titleA } });
  await request.post(`/api/goals/${goal.id}/blueprint/root`, { data: { title: titleB } });
  await gotoGoalBlueprint(page, goal.name);
  return { goal, titleA, titleB };
}

/** タスクA（サンプル）を選んで Enter を押し、その直後に空のエフェメラル追加入力を開く。 */
async function openEmptyAddRowAfter(page: import('@playwright/test').Page, titleA: string) {
  const inputA = page.locator(`.bp-node-title[value="${titleA}"]`);
  await inputA.click();
  await page.keyboard.press('Enter');
  const addInput = page.locator('.bp-add-input');
  await expect(addInput).toBeVisible();
  await expect(addInput).toBeFocused();
  await expect(addInput).toHaveValue('');
  return addInput;
}

test('空の追加入力を開いたまま別のノードをクリックすると閉じ、そのノードを選べて↑↓で移動できる', async ({ page, request }) => {
  const { titleA, titleB } = await setupTwoTasks(page, request, '追加入力吸い寄せe2e');
  await openEmptyAddRowAfter(page, titleA);

  const inputB = page.locator(`.bp-node-title[value="${titleB}"]`);
  await inputB.click();

  await expect(page.locator('.bp-add-input')).toHaveCount(0);
  await expect(inputB).toBeFocused();

  const inputA = page.locator(`.bp-node-title[value="${titleA}"]`);
  await page.keyboard.press('ArrowUp');
  await expect(inputA).toBeFocused();
});

test('空の追加入力を開いたままツリーの外をクリックすると閉じる', async ({ page, request }) => {
  const { goal, titleA } = await setupTwoTasks(page, request, '追加入力外クリックe2e');
  await openEmptyAddRowAfter(page, titleA);

  await page.locator('.bp-title', { hasText: goal.name }).click();

  await expect(page.locator('.bp-add-input')).toHaveCount(0);
  await expect(page.locator('.bp-node-row.sel')).toHaveCount(0);
});

test('空の追加入力は Escape でも Delete でも閉じ、直前に触っていたノードへ戻る', async ({ page, request }) => {
  const { titleA, titleB } = await setupTwoTasks(page, request, '追加入力Esc削除e2e');
  const inputA = page.locator(`.bp-node-title[value="${titleA}"]`);
  const inputB = page.locator(`.bp-node-title[value="${titleB}"]`);

  await openEmptyAddRowAfter(page, titleA);
  await page.keyboard.press('Escape');
  await expect(page.locator('.bp-add-input')).toHaveCount(0);
  await expect(inputA).toBeFocused();

  await inputB.click();
  await page.keyboard.press('Enter');
  const addInputAfterB = page.locator('.bp-add-input');
  await expect(addInputAfterB).toBeFocused();
  await page.keyboard.press('Delete');
  await expect(page.locator('.bp-add-input')).toHaveCount(0);
  await expect(inputB).toBeFocused();
});

test('追加入力で Tab を押すと消えずにインデントし、直前のタスクの子として作られる。Shift+Tab で戻せる', async ({ page, request }) => {
  const { titleA, titleB } = await setupTwoTasks(page, request, '追加入力Tabインデントe2e');
  const addInput = await openEmptyAddRowAfter(page, titleA);

  await addInput.press('Tab');
  await expect(addInput).toBeVisible();
  await expect(addInput).toBeFocused();
  // 子モードへ入ると titleA の下（インデントされた位置）へ入力欄が移る。
  await expect(page.locator('.bp-node-children .bp-add-input')).toHaveCount(1);

  await addInput.press('Shift+Tab');
  await expect(addInput).toBeVisible();
  await expect(addInput).toBeFocused();
  await expect(page.locator('.bp-node-children .bp-add-input')).toHaveCount(0);

  await addInput.press('Tab');
  const childTitle = `子タスク${Date.now()}`;
  await addInput.fill(childTitle);
  await addInput.press('Enter');

  const parentRow = page.locator('.bp-node-row', { has: page.locator(`.bp-node-title[value="${titleA}"]`) });
  await expect(parentRow.locator('.bp-node-childcount')).toHaveText('0/1');
  await expect(page.locator(`.bp-node-children .bp-node-title[value="${childTitle}"]`)).toBeVisible();
  // titleB は根に残ったまま（子にはならない）。
  await expect(page.locator(`.bp-tree > .bp-node > .bp-node-row .bp-node-title[value="${titleB}"]`)).toBeVisible();
});

test('追加入力にタイトルを打ちかけた状態で Tab を押しても、入力済みの文字は消えない', async ({ page, request }) => {
  const { titleA } = await setupTwoTasks(page, request, '追加入力Tab文字保持e2e');
  const addInput = await openEmptyAddRowAfter(page, titleA);

  const draftTitle = `打ちかけ${Date.now()}`;
  await addInput.fill(draftTitle);
  await addInput.press('Tab');
  await expect(page.locator('.bp-node-children .bp-add-input')).toHaveValue(draftTitle);

  await page.locator('.bp-node-children .bp-add-input').press('Shift+Tab');
  await expect(page.locator('.bp-add-input')).toHaveValue(draftTitle);

  await page.locator('.bp-add-input').press('Enter');
  await expect(page.locator(`.bp-tree > .bp-node > .bp-node-row .bp-node-title[value="${draftTitle}"]`)).toBeVisible();
});
