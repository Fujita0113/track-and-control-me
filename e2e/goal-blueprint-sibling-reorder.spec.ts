import { test, expect } from './fixtures.js';

/**
 * タスク一覧で兄弟の並び順だけを Alt+↑/Alt+↓ で入れ替えるフローの通し E2E
 * （issue #104 / change goal-blueprint-sibling-reorder）。
 * propose 側では書かず、実装した DOM に対して apply の最後に書く（凍結ラインの対象外）。
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

async function gotoGoalBlueprint(page: import('@playwright/test').Page, goalName: string) {
  await page.locator('#tabs button[data-target="goals"]').click();
  await page.locator('.gr-goal-card', { hasText: goalName }).first().waitFor();
  await openBlueprint(page, goalName);
  await expect(page.locator('.bp-tree-wrap')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
});

test('タスク一覧で兄弟を Alt+↑ で並べ替えると、表示順が入れ替わりリロード後も維持される', async ({ page, request }) => {
  const goal = await createGoal(request, `兄弟並べ替えe2e${Date.now()}`);
  await request.post(`/api/goals/${goal.id}/blueprint/import`, { data: { text: '- 枝A\n- 枝B' } });
  await gotoGoalBlueprint(page, goal.name);

  const rootTitles = page.locator('.bp-tree > .bp-node > .bp-node-row .bp-node-title');
  await expect(rootTitles).toHaveCount(2);
  await expect(rootTitles.nth(0)).toHaveValue('枝A');
  await expect(rootTitles.nth(1)).toHaveValue('枝B');

  await page.locator('.bp-node-title[value="枝B"]').click();
  await page.keyboard.press('Alt+ArrowUp');

  await expect(rootTitles.nth(0)).toHaveValue('枝B');
  await expect(rootTitles.nth(1)).toHaveValue('枝A');

  await page.reload();
  await page.getByRole('button', { name: 'あとで' }).click({ timeout: 3000 }).catch(() => {});
  await gotoGoalBlueprint(page, goal.name);
  const rootTitlesAfterReload = page.locator('.bp-tree > .bp-node > .bp-node-row .bp-node-title');
  await expect(rootTitlesAfterReload).toHaveCount(2);
  await expect(rootTitlesAfterReload.nth(0)).toHaveValue('枝B');
  await expect(rootTitlesAfterReload.nth(1)).toHaveValue('枝A');
});
