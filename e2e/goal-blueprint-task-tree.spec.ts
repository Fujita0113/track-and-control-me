import { test, expect } from './fixtures.js';

/**
 * タスクツリーがカンバンへどう出るかの通し E2E（issue #91 / spec: task-tree・goal-blueprint）。
 *   1. ツリーを投入する → カンバンの保留列に葉が並び、容れ物は盤面に出ない
 * 完了操作は D&D が不安定なため PATCH で代替する（既存 e2e の流儀・kanban-restore.spec.ts 参照）。
 *
 * change `task-list-card-tree-ui` で、タスク一覧側の DOM を踏んでいた2本
 * （「カンバンで葉を完了へ → 設計図に戻るとチェックが付いている」「進行中の葉に至る枝だけが開いている」）
 * をここから外した。タイトルが `<span>` から常時編集の `<input>` へ、チェックが
 * `<input type=checkbox>` から `<button>` へ変わるため、`hasText` も `toBeChecked` も
 * 成立しなくなる。差し替え後のセレクタは実装が発明するので、ここで書くと当てずっぽうになる。
 * 挙動そのものは vitest（`has_children と完了の導出` / `computeOpenPath: 現在地までの祖先だけを開く`）が
 * 押さえており、画面越しの確認は apply が新しい DOM に対して書き直す（tasks.md §0）。
 *
 * change `kanban-detail-overlay`（issue #92）で、詳細パネルから「このタスクを分解する」導線
 * （`.kb-decompose-toggle` 等）を撤去した（テキスト欄を広く使うため、いったんカンバンから外す
 * 判断）。それに伴い「盤面のカードを分解する→子が同じ列に現れる」のケースはここから削除した。
 * 分解機能自体（`POST /api/tasks/:id/children`）とその vitest（task-tree.test.ts）は健在。
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

// 投入は API で行う。まとめて追加の入力 UI は change ごとに作り替わっており、ここで踏むと
// 当てずっぽうになるため。この spec は「ツリーが盤面へどう出るか」だけを見張る。
test('ツリーを投入する → カンバンの保留列に葉が並び、容れ物は盤面に出ない', async ({ page, request }) => {
  const goal = await createGoal(request, `設計図取り込みe2e${Date.now()}`);
  await request.post(`/api/goals/${goal.id}/blueprint/import`, {
    data: { text: '- 苦手な質問への回答を用意する\n  - 質問をピックアップする\n  - Notion にまとめる' },
  });

  await page.locator('#tabs button[data-target="goals"]').click();
  await page.locator('.gr-goal-card', { hasText: goal.name }).first().waitFor();
  await openBlueprint(page, goal.name);
  // 見出しに目標名が出ることだけを見る。ノードの中身は `task-list-card-tree-ui` で
  // `<span>` から `<input>` へ変わるため、テキストで捕まえられなくなる。
  await expect(page.getByRole('heading').filter({ hasText: goal.name })).toBeVisible();

  await page.locator('#tabs button[data-target="kanban"]').click();
  const holdCol = page.locator('.kb-col[data-col="HOLD"]');
  await expect(holdCol.locator('.kb-card', { hasText: '質問をピックアップする' })).toBeVisible();
  await expect(holdCol.locator('.kb-card', { hasText: 'Notion にまとめる' })).toBeVisible();
  // 容れ物は盤面のどの列にも出ない（カードのタイトル要素で判定: 葉のパンくずと同名でも誤検出しない）。
  await expect(page.locator('.kb-card-title', { hasText: '苦手な質問への回答を用意する' })).toHaveCount(0);
});
