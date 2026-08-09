import { test, expect } from './fixtures.js';

/**
 * 設計図とタスクツリーの通し E2E（issue #91 / spec: task-tree・goal-blueprint）。
 * §0 に挙げた4フロー:
 *   1. 設計図でテキストを取り込む → カンバンの保留列に葉が並び、容れ物は盤面に出ない
 *   2. カンバンで葉を完了へ → 設計図に戻るとチェックが付いている
 *   3. 盤面のカードを分解する → そのカードが消えて子が同じ列に現れる
 *   4. 設計図を開くと、進行中の葉に至る枝だけが開いている
 * 完了操作は D&D が不安定なため PATCH で代替する（既存 e2e の流儀・kanban-restore.spec.ts 参照）。
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
    .getByRole('button', { name: '設計図', exact: true })
    .click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
});

// まとめて追加の「入力 UI」自体は change `task-list-inline-edit` で作り替わる（モード切替を撤去し、
// ノードから開くパネルになる）。ここで UI を踏むと当てずっぽうになるので、投入は API で行い、
// この spec は「ツリーが盤面へどう出るか」だけを見張る。入力 UI の e2e は作り替え後に書く。
test('ツリーを投入する → カンバンの保留列に葉が並び、容れ物は盤面に出ない', async ({ page, request }) => {
  const goal = await createGoal(request, `設計図取り込みe2e${Date.now()}`);
  await request.post(`/api/goals/${goal.id}/blueprint/import`, {
    data: { text: '- 苦手な質問への回答を用意する\n  - 質問をピックアップする\n  - Notion にまとめる' },
  });

  await page.locator('#tabs button[data-target="goals"]').click();
  await page.locator('.gr-goal-card', { hasText: goal.name }).first().waitFor();
  await openBlueprint(page, goal.name);
  await expect(page.locator('.bp-node-title', { hasText: '苦手な質問への回答を用意する' })).toBeVisible();

  await page.locator('#tabs button[data-target="kanban"]').click();
  const holdCol = page.locator('.kb-col[data-col="HOLD"]');
  await expect(holdCol.locator('.kb-card', { hasText: '質問をピックアップする' })).toBeVisible();
  await expect(holdCol.locator('.kb-card', { hasText: 'Notion にまとめる' })).toBeVisible();
  // 容れ物は盤面のどの列にも出ない（カードのタイトル要素で判定: 葉のパンくずと同名でも誤検出しない）。
  await expect(page.locator('.kb-card-title', { hasText: '苦手な質問への回答を用意する' })).toHaveCount(0);
});

test('カンバンで葉を完了へ → 設計図に戻るとチェックが付いている', async ({ page, request }) => {
  const goal = await createGoal(request, `設計図完了同期e2e${Date.now()}`);
  await request.post(`/api/goals/${goal.id}/blueprint/import`, {
    data: { text: '- 回答を用意する\n  - ピックアップする' },
  });
  const bp = await (await request.get(`/api/goals/${goal.id}/blueprint`)).json();
  const leafId = bp.nodes[0].children[0].id;

  // カンバンで完了にする（実際の操作はドラッグだが、既存 e2e の流儀に倣い PATCH で代替する）。
  await request.patch(`/api/tasks/${leafId}`, { data: { status: 'DONE' } });

  await page.locator('#tabs button[data-target="goals"]').click();
  await page.locator('.gr-goal-card', { hasText: goal.name }).first().waitFor();
  await openBlueprint(page, goal.name);

  // 全決着で既定は畳まれているため、容れ物を開いてチェックを確認する。
  await page.locator('.bp-toggle').first().click();
  await expect(page.locator('.bp-node-title.done', { hasText: 'ピックアップする' })).toBeVisible();
  await expect(page.locator('.bp-checkbox').nth(1)).toBeChecked();
});

test('盤面のカードを分解する → そのカードが消えて子が同じ列に現れる', async ({ page, request }) => {
  const title = `分解対象e2e${Date.now()}`;
  await request.post('/api/tasks', { data: { title, status: 'TODO' } });

  await page.locator('#tabs button[data-target="kanban"]').click();
  const todoCol = page.locator('.kb-col[data-col="TODO"]');
  await expect(todoCol.locator('.kb-card', { hasText: title })).toBeVisible();
  await todoCol.locator('.kb-card', { hasText: title }).click();

  await page.locator('.kb-decompose-toggle').click();
  await page.locator('.kb-decompose-ta').fill('子タスクA\n子タスクB');
  await page.locator('.kb-decompose-submit').click();

  // 親カードは盤面から消える（タイトル要素で判定: 子カードのパンくずと同名でも誤検出しない）。
  await expect(page.locator('.kb-card-title', { hasText: title })).toHaveCount(0);
  // 子は同じ列（未着手）に現れ、親のパンくずを持つ。
  const childA = todoCol.locator('.kb-card', { hasText: '子タスクA' });
  await expect(childA).toBeVisible();
  await expect(childA.locator('.kb-breadcrumb-text')).toHaveText(title);
  const childB = todoCol.locator('.kb-card', { hasText: '子タスクB' });
  await expect(childB).toBeVisible();
  await expect(childB.locator('.kb-breadcrumb-text')).toHaveText(title);
});

test('設計図を開くと、進行中の葉に至る枝だけが開いている', async ({ page, request }) => {
  const goal = await createGoal(request, `設計図展開e2e${Date.now()}`);
  await request.post(`/api/goals/${goal.id}/blueprint/import`, {
    data: { text: '- 枝1\n  - 未着手の葉\n- 枝2\n  - 進行中の葉' },
  });
  const bp = await (await request.get(`/api/goals/${goal.id}/blueprint`)).json();
  const progressingLeaf = bp.nodes[1].children[0];
  await request.patch(`/api/tasks/${progressingLeaf.id}`, { data: { status: 'DOING' } });

  await page.locator('#tabs button[data-target="goals"]').click();
  await page.locator('.gr-goal-card', { hasText: goal.name }).first().waitFor();
  await openBlueprint(page, goal.name);

  // 進行中の葉を持つ枝2は開いている。
  await expect(page.locator('.bp-node-title', { hasText: '枝2' })).toBeVisible();
  await expect(page.locator('.bp-node-title', { hasText: '進行中の葉' })).toBeVisible();
  // 未完了のままの枝1は畳まれていて、子（未着手の葉）は DOM にすら現れない。
  await expect(page.locator('.bp-node-title', { hasText: '枝1' })).toBeVisible();
  await expect(page.locator('.bp-node-title', { hasText: '未着手の葉' })).toHaveCount(0);
});
