import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { createTask, updateTask, deleteTask, listTasks } from './tasks.js';
import { getPlanningSignal } from './planning.js';
import {
  TaskTreeError,
  parseBlueprintText,
  importBlueprint,
  getBlueprint,
  computeOpenPath,
  createChildTask,
  createRootTask,
  createSiblingTask,
  setParent,
  setTreePosition,
  setSubtreeDone,
  startBranch,
  dropBranch,
  resolveLineageRootGoalId,
} from './task-tree.js';

/**
 * タスクツリー（spec: task-tree / goal-blueprint）。
 *
 * 「葉だけがカードになる」「容れ物の完了は導出」「取り込みは追加のみの一方向」という
 * 3つの決めごとをサービス層で固定する。DOM は一切前提にしない。
 */

const TODAY = '2026-07-10';
const TOMORROW = '2026-07-11';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

/** goal 行を直接作る（createGoal のバリデーション一式を経由せずチェインだけ組みたいため）。 */
function insertGoal(name: string, continuedGoalId: number | null = null): number {
  const info = db
    .prepare(
      `INSERT INTO goal (name, purpose, start_day, end_day, created_at, continued_goal_id)
       VALUES (?, '', ?, ?, ?, ?)`,
    )
    .run(name, TODAY, '2026-08-08', Date.now(), continuedGoalId);
  return Number(info.lastInsertRowid);
}

function titles(nodes: { title: string }[]): string[] {
  return nodes.map((n) => n.title);
}

// --- 取り込みパーサ（純関数） ---------------------------------------------

describe('parseBlueprintText: インデントが階層、バレットがタスク', () => {
  it('インデントの深さで親子になる', () => {
    const nodes = parseBlueprintText(
      ['- 苦手な質問への回答を用意する', '  - 質問をピックアップする', '  - Notion にまとめる'].join('\n'),
    );
    expect(titles(nodes)).toEqual(['苦手な質問への回答を用意する']);
    expect(titles(nodes[0]!.children)).toEqual(['質問をピックアップする', 'Notion にまとめる']);
  });

  it('深さに上限が無い（4階層でも通る）', () => {
    const nodes = parseBlueprintText(['- A', '  - B', '    - C', '      - D'].join('\n'));
    expect(nodes[0]!.children[0]!.children[0]!.children[0]!.title).toBe('D');
  });

  it('バレットの無い行は直前のタスクの本文になる', () => {
    const nodes = parseBlueprintText(
      ['- 質問をピックアップする', '  まず去年の資料から。', '  20問くらいに絞る。', '- Notion にまとめる'].join('\n'),
    );
    expect(titles(nodes)).toEqual(['質問をピックアップする', 'Notion にまとめる']);
    expect(nodes[0]!.notes).toBe('まず去年の資料から。\n20問くらいに絞る。');
    expect(nodes[1]!.notes).toBe('');
  });

  it('行頭の連番は読み捨てられ、階層はインデントだけで決まる', () => {
    const nodes = parseBlueprintText(['- 1. 苦手な質問への回答', '- 1.1 質問をピックアップ'].join('\n'));
    expect(titles(nodes)).toEqual(['苦手な質問への回答', '質問をピックアップ']);
  });

  it('空行は無視され、タスクの前のバレット無し行は捨てられる', () => {
    const nodes = parseBlueprintText(['面接対策', '', '- 志望動機を明確にする', ''].join('\n'));
    expect(titles(nodes)).toEqual(['志望動機を明確にする']);
    expect(nodes[0]!.notes).toBe('');
  });

  it('インデントが飛んでも1段だけ深いものとして扱う', () => {
    const nodes = parseBlueprintText(['- A', '      - B'].join('\n'));
    expect(titles(nodes)).toEqual(['A']);
    expect(titles(nodes[0]!.children)).toEqual(['B']);
  });
});

// --- 取り込み（DB 書き込み） ----------------------------------------------

describe('importBlueprint: 追加のみの一方向', () => {
  it('葉は保留に入り、容れ物は盤面に出ない', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, ['- 回答を用意する', '  - ピックアップ', '  - まとめる'].join('\n'));

    const all = listTasks(db);
    const container = all.find((t) => t.title === '回答を用意する')!;
    const leaf = all.find((t) => t.title === 'ピックアップ')!;
    expect(container.has_children).toBe(1);
    expect(leaf.has_children).toBe(0);
    expect(leaf.status).toBe('HOLD');
  });

  it('同じテキストを2回取り込むと2組に増え、既存は書き換わらない', () => {
    const goalId = insertGoal('面接対策');
    const text = ['- 回答を用意する', '  - ピックアップ'].join('\n');
    importBlueprint(db, goalId, text);
    const firstLeafId = listTasks(db).find((t) => t.title === 'ピックアップ')!.id;
    updateTask(db, firstLeafId, { status: 'DOING' });

    importBlueprint(db, goalId, text);

    const leaves = listTasks(db).filter((t) => t.title === 'ピックアップ');
    expect(leaves).toHaveLength(2);
    expect(listTasks(db).find((t) => t.id === firstLeafId)!.status).toBe('DOING');
  });

  it('空のテキストは拒否される', () => {
    const goalId = insertGoal('面接対策');
    expect(() => importBlueprint(db, goalId, '   \n\n')).toThrow(TaskTreeError);
  });

  it('本文は task.notes に入る（カンバンのノートと同じ列）', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, ['- ピックアップ', '  去年の資料から20問。'].join('\n'));
    expect(listTasks(db).find((t) => t.title === 'ピックアップ')!.notes).toBe('去年の資料から20問。');
  });
});

// --- 葉と容れ物 -------------------------------------------------------------

describe('has_children と完了の導出', () => {
  it('既存タスクは根の葉として扱われる', () => {
    const t = createTask(db, { title: '普段のタスク' });
    expect(listTasks(db).find((x) => x.id === t.id)!.has_children).toBe(0);
    expect(listTasks(db).find((x) => x.id === t.id)!.parent_task_id).toBe(null);
  });

  it('容れ物は子が全部決着するまで未完了', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, ['- 回答を用意する', '  - ピックアップ', '  - まとめる'].join('\n'));
    const idOf = (t: string) => listTasks(db).find((x) => x.title === t)!.id;

    updateTask(db, idOf('ピックアップ'), { status: 'DONE' });
    expect(getBlueprint(db, goalId).nodes[0]!.done).toBe(false);

    updateTask(db, idOf('まとめる'), { status: 'DONE' });
    expect(getBlueprint(db, goalId).nodes[0]!.done).toBe(true);
  });

  it('深い階層でも導出は下から積み上がる', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, ['- A', '  - A1', '    - A11', '    - A12'].join('\n'));
    const idOf = (t: string) => listTasks(db).find((x) => x.title === t)!.id;

    updateTask(db, idOf('A11'), { status: 'DONE' });
    expect(getBlueprint(db, goalId).nodes[0]!.done).toBe(false);

    updateTask(db, idOf('A12'), { status: 'DONE' });
    const a = getBlueprint(db, goalId).nodes[0]!;
    expect(a.done).toBe(true);
    expect(a.children[0]!.done).toBe(true);
  });
});

// --- 分解の規則 -------------------------------------------------------------

describe('分解の規則', () => {
  it('子は親がいた列を引き継ぐ', () => {
    const parent = createTask(db, { title: '回答を用意する', status: 'DOING' });
    const child = createChildTask(db, parent.id, { title: 'ピックアップ' });
    expect(child.status).toBe('DOING');
  });

  it('完了済みは分解できない', () => {
    const parent = createTask(db, { title: '終わったタスク', status: 'DONE' });
    expect(() => createChildTask(db, parent.id, { title: 'あとから割る' })).toThrow(TaskTreeError);
  });

  it('最後の子を消すと葉に戻る', () => {
    const parent = createTask(db, { title: '回答を用意する' });
    const child = createChildTask(db, parent.id, { title: 'ピックアップ' });
    expect(listTasks(db).find((t) => t.id === parent.id)!.has_children).toBe(1);
    deleteTask(db, child.id);
    expect(listTasks(db).find((t) => t.id === parent.id)!.has_children).toBe(0);
  });

  it('親を消しても子は残り、親の親へ繰り上がる', () => {
    const grand = createTask(db, { title: '祖父' });
    const parent = createChildTask(db, grand.id, { title: '親' });
    const child = createChildTask(db, parent.id, { title: '子' });

    deleteTask(db, parent.id);

    const after = listTasks(db).find((t) => t.id === child.id)!;
    expect(after).toBeDefined();
    expect(after.parent_task_id).toBe(grand.id);
  });

  it('根を消すと子が根に繰り上がり、goal_id を引き継ぐ', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, ['- 回答を用意する', '  - ピックアップ'].join('\n'));
    const parent = listTasks(db).find((t) => t.title === '回答を用意する')!;
    const child = listTasks(db).find((t) => t.title === 'ピックアップ')!;

    deleteTask(db, parent.id);

    const after = listTasks(db).find((t) => t.id === child.id)!;
    expect(after.parent_task_id).toBe(null);
    expect(after.goal_id).toBe(goalId);
  });
});

// --- 循環の禁止 -------------------------------------------------------------

describe('setParent: 循環を作らせない', () => {
  it('自分自身の下へは付け替えられない', () => {
    const a = createTask(db, { title: 'A' });
    expect(() => setParent(db, a.id, a.id)).toThrow(TaskTreeError);
  });

  it('自分の子孫の下へは付け替えられない', () => {
    const a = createTask(db, { title: 'A' });
    const b = createChildTask(db, a.id, { title: 'B' });
    const c = createChildTask(db, b.id, { title: 'C' });
    expect(() => setParent(db, a.id, c.id)).toThrow(TaskTreeError);
    expect(listTasks(db).find((t) => t.id === a.id)!.parent_task_id).toBe(null);
  });

  it('正しい付け替えは通る', () => {
    const a = createTask(db, { title: 'A' });
    const b = createTask(db, { title: 'B' });
    setParent(db, b.id, a.id);
    expect(listTasks(db).find((t) => t.id === b.id)!.parent_task_id).toBe(a.id);
  });
});

// --- 枝への着手・打ち切り ---------------------------------------------------

describe('startBranch / dropBranch', () => {
  it('配下の保留の葉だけが未着手へ移る', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, ['- 枝1', '  - a', '  - b', '  - c', '  - d', '- 枝2', '  - e'].join('\n'));
    const branch1 = listTasks(db).find((t) => t.title === '枝1')!;
    const c = listTasks(db).find((t) => t.title === 'c')!;
    const d = listTasks(db).find((t) => t.title === 'd')!;
    updateTask(db, c.id, { status: 'DOING' });
    updateTask(db, d.id, { status: 'DONE' });

    startBranch(db, branch1.id);

    const byTitle = (t: string) => listTasks(db).find((x) => x.title === t)!;
    expect(byTitle('a').status).toBe('TODO');
    expect(byTitle('b').status).toBe('TODO');
    expect(byTitle('c').status).toBe('DOING'); // 着手済みは動かさない
    expect(byTitle('d').status).toBe('DONE'); // 完了済みは動かさない
    expect(byTitle('e').status).toBe('HOLD'); // 別の枝は動かさない
  });

  it('打ち切りには理由が要る', () => {
    const parent = createTask(db, { title: '枝' });
    createChildTask(db, parent.id, { title: 'a' });
    expect(() => dropBranch(db, parent.id, '  ')).toThrow(TaskTreeError);
  });

  it('打ち切りは未完了の葉だけを対象にし、完了済みの理由を上書きしない', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, ['- 枝', '  - a', '  - b', '  - c'].join('\n'));
    const branch = listTasks(db).find((t) => t.title === '枝')!;
    const c = listTasks(db).find((t) => t.title === 'c')!;
    updateTask(db, c.id, { status: 'DONE' });

    dropBranch(db, branch.id, '志望先が変わったため');

    const byTitle = (t: string) => listTasks(db).find((x) => x.title === t)!;
    expect(byTitle('a').drop_reason).toBe('志望先が変わったため');
    expect(byTitle('b').drop_reason).toBe('志望先が変わったため');
    expect(byTitle('c').drop_reason).toBe(null); // 完了済みは触らない
    expect(byTitle('a').status).toBe('DONE'); // 盤面から外れる
  });

  it('打ち切った枝は決着済みになる', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, ['- 枝', '  - a', '  - b'].join('\n'));
    const branch = listTasks(db).find((t) => t.title === '枝')!;
    dropBranch(db, branch.id, 'やめた');
    expect(getBlueprint(db, goalId).nodes[0]!.done).toBe(true);
  });
});

// --- 展開規則（現在地までのパス） -------------------------------------------

describe('computeOpenPath: 現在地までの祖先だけを開く', () => {
  function threeBranches(goalId: number): void {
    importBlueprint(
      db,
      goalId,
      ['- 枝1', '  - a', '  - b', '- 枝2', '  - c', '- 枝3', '  - d'].join('\n'),
    );
  }

  it('何も終わっていなければ最初の枝だけ開く', () => {
    const goalId = insertGoal('面接対策');
    threeBranches(goalId);
    const { nodes } = getBlueprint(db, goalId);
    const open = computeOpenPath(nodes);
    const idOf = (t: string) => listTasks(db).find((x) => x.title === t)!.id;
    expect(open).toContain(idOf('枝1'));
    expect(open).not.toContain(idOf('枝2'));
    expect(open).not.toContain(idOf('枝3'));
  });

  it('終わった枝は畳まれ、次の未完了の枝が開く', () => {
    const goalId = insertGoal('面接対策');
    threeBranches(goalId);
    const idOf = (t: string) => listTasks(db).find((x) => x.title === t)!.id;
    updateTask(db, idOf('a'), { status: 'DONE' });
    updateTask(db, idOf('b'), { status: 'DONE' });

    const open = computeOpenPath(getBlueprint(db, goalId).nodes);
    expect(open).not.toContain(idOf('枝1'));
    expect(open).toContain(idOf('枝2'));
  });

  it('進行中の葉があればそちらが優先される', () => {
    const goalId = insertGoal('面接対策');
    threeBranches(goalId);
    const idOf = (t: string) => listTasks(db).find((x) => x.title === t)!.id;
    updateTask(db, idOf('d'), { status: 'DOING' });

    const open = computeOpenPath(getBlueprint(db, goalId).nodes);
    expect(open).toContain(idOf('枝3'));
    expect(open).not.toContain(idOf('枝1'));
  });

  it('深い階層では祖先のパスだけが開く', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, ['- A', '  - A1', '    - A11', '  - A2', '- B', '  - B1'].join('\n'));
    const idOf = (t: string) => listTasks(db).find((x) => x.title === t)!.id;
    updateTask(db, idOf('A11'), { status: 'DOING' });

    const open = computeOpenPath(getBlueprint(db, goalId).nodes);
    expect(open).toContain(idOf('A'));
    expect(open).toContain(idOf('A1'));
    expect(open).not.toContain(idOf('B'));
  });

  it('全部決着していれば何も開かない', () => {
    const goalId = insertGoal('面接対策');
    threeBranches(goalId);
    for (const t of ['a', 'b', 'c', 'd']) {
      updateTask(db, listTasks(db).find((x) => x.title === t)!.id, { status: 'DONE' });
    }
    expect(computeOpenPath(getBlueprint(db, goalId).nodes)).toEqual([]);
  });
});

// --- 継続チェイン -----------------------------------------------------------

describe('継続チェインを跨いだ設計図', () => {
  it('チェインのどの目標から開いても同じツリーが返る', () => {
    const first = insertGoal('面接対策');
    const second = insertGoal('面接対策', null);
    db.prepare("UPDATE goal SET lifecycle_choice = 'continued', continued_goal_id = ? WHERE id = ?").run(
      second,
      first,
    );

    importBlueprint(db, first, ['- 回答を用意する', '  - ピックアップ'].join('\n'));

    expect(resolveLineageRootGoalId(db, second)).toBe(first);
    expect(titles(getBlueprint(db, second).nodes)).toEqual(['回答を用意する']);
    expect(titles(getBlueprint(db, first).nodes)).toEqual(['回答を用意する']);
  });

  it('2代目から取り込んでも1代目から読める（設計図は1本）', () => {
    const first = insertGoal('面接対策');
    const second = insertGoal('面接対策');
    db.prepare('UPDATE goal SET continued_goal_id = ? WHERE id = ?').run(second, first);

    importBlueprint(db, second, '- あとから足した枝');

    expect(titles(getBlueprint(db, first).nodes)).toEqual(['あとから足した枝']);
  });
});

// --- PLANNING シグナル -------------------------------------------------------

describe('容れ物は翌日の未完了タスク数に数えない', () => {
  it('容れ物を除いて数える', () => {
    const parent = createTask(db, { title: '容れ物', due: TOMORROW });
    createChildTask(db, parent.id, { title: '葉', due: TOMORROW });

    expect(getPlanningSignal(db, TODAY).tomorrowTaskCount).toBe(1);
  });

  it('親子を持たないタスクだけなら従来どおり数える', () => {
    createTask(db, { title: 'x', due: TOMORROW });
    createTask(db, { title: 'y', due: TOMORROW });
    createTask(db, { title: 'z', due: TOMORROW });

    expect(getPlanningSignal(db, TODAY).tomorrowTaskCount).toBe(3);
  });
});

// ==========================================================================
// 以下は change `task-list-inline-edit`（issue #91 フィードバック）が凍結する契約。
// ツリーの上で構造を触れるようにするために要る2つのサーバ側の seam:
//   - まとめて追加の取り込み先指定（importBlueprint の第4引数）
//   - 枝への着手のラベルに出す件数（getBlueprint の holdLeafCount）
// ==========================================================================

describe('まとめて追加は取り込み先のノードを選べる', () => {
  it('指定したノードの子孫になり、根は増えない', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, '- test2');
    const parent = listTasks(db).find((t) => t.title === 'test2')!;

    importBlueprint(db, goalId, ['- 回答を用意する', '  - ピックアップ'].join('\n'), parent.id);

    const { nodes } = getBlueprint(db, goalId);
    expect(titles(nodes)).toEqual(['test2']); // 根は増えない
    expect(titles(nodes[0]!.children)).toEqual(['回答を用意する']);
    expect(titles(nodes[0]!.children[0]!.children)).toEqual(['ピックアップ']);
  });

  it('指定の有無で行き先が変わる（指定なしは従来どおり根）', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, '- 枝1');
    const branch1 = listTasks(db).find((t) => t.title === '枝1')!;

    importBlueprint(db, goalId, '- 枝1の子', branch1.id);
    importBlueprint(db, goalId, '- 枝2');

    const { nodes } = getBlueprint(db, goalId);
    expect(titles(nodes)).toEqual(['枝1', '枝2']);
    expect(titles(nodes[0]!.children)).toEqual(['枝1の子']);
  });

  it('取り込み先が完了済みなら拒否される', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, '- test2');
    const parent = listTasks(db).find((t) => t.title === 'test2')!;
    updateTask(db, parent.id, { status: 'DONE' });

    expect(() => importBlueprint(db, goalId, '- あとから', parent.id)).toThrow(TaskTreeError);
  });

  it('別の目標のツリーのノードは取り込み先にできない', () => {
    const goalA = insertGoal('面接対策');
    const goalB = insertGoal('筋トレ');
    importBlueprint(db, goalA, '- Aの枝');
    const foreign = listTasks(db).find((t) => t.title === 'Aの枝')!;

    expect(() => importBlueprint(db, goalB, '- Bの枝', foreign.id)).toThrow(TaskTreeError);
  });

  it('ぶら下げた葉は保留に入り、親は容れ物になる', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, '- test2');
    const parent = listTasks(db).find((t) => t.title === 'test2')!;
    expect(parent.has_children).toBe(0); // この時点では葉

    importBlueprint(db, goalId, '- ぶら下げた葉', parent.id);

    const leaf = listTasks(db).find((t) => t.title === 'ぶら下げた葉')!;
    expect(leaf.parent_task_id).toBe(parent.id);
    expect(leaf.status).toBe('HOLD');
    expect(listTasks(db).find((t) => t.id === parent.id)!.has_children).toBe(1);
  });
});

describe('getBlueprint は枝への着手の対象件数を返す', () => {
  it('容れ物は配下の保留の葉の数を持つ', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, ['- 枝1', '  - a', '  - b', '  - c', '- 枝2', '  - d'].join('\n'));
    const idOf = (t: string) => listTasks(db).find((x) => x.title === t)!.id;
    updateTask(db, idOf('c'), { status: 'DOING' });

    const { nodes } = getBlueprint(db, goalId);
    expect(nodes[0]!.holdLeafCount).toBe(2); // a, b（c は進行中なので数えない）
    expect(nodes[1]!.holdLeafCount).toBe(1);
  });

  it('深い階層でも下から積み上がる', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, ['- A', '  - A1', '    - A11', '    - A12', '  - A2'].join('\n'));

    const a = getBlueprint(db, goalId).nodes[0]!;
    expect(a.holdLeafCount).toBe(3); // A11, A12, A2
    expect(a.children[0]!.holdLeafCount).toBe(2); // A11, A12
  });

  it('葉自身は保留なら1、そうでなければ0', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, ['- 枝', '  - 保留の葉', '  - 完了の葉'].join('\n'));
    const idOf = (t: string) => listTasks(db).find((x) => x.title === t)!.id;
    updateTask(db, idOf('完了の葉'), { status: 'DONE' });

    const branch = getBlueprint(db, goalId).nodes[0]!;
    expect(branch.children[0]!.holdLeafCount).toBe(1);
    expect(branch.children[1]!.holdLeafCount).toBe(0);
    expect(branch.holdLeafCount).toBe(1);
  });

  it('保留の葉が無い枝は0になる（着手の導線を出さない判断に使う）', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, ['- 枝', '  - a', '  - b'].join('\n'));
    const idOf = (t: string) => listTasks(db).find((x) => x.title === t)!.id;
    updateTask(db, idOf('a'), { status: 'DOING' });
    updateTask(db, idOf('b'), { status: 'DONE' });

    expect(getBlueprint(db, goalId).nodes[0]!.holdLeafCount).toBe(0);
  });
});

// ==========================================================================
// createRootTask: タスク一覧の「＋ 新しい枝を足す」（apply が追記・task-list-inline-edit）。
// importBlueprint 経由にすると parseBlueprintText の連番読み捨てが素のタイトルにも働いてしまう
// （例:「2つ目のタスク」の先頭「2」が消える）ため、テキスト取り込みを経由しない単発追加として分離した。
// ==========================================================================

describe('createRootTask: 根への単発追加', () => {
  it('目標直下に1件だけ足せる（既定は TODO）', () => {
    const goalId = insertGoal('面接対策');
    const task = createRootTask(db, goalId, '最初のタスク');
    expect(task.parent_task_id).toBe(null);
    expect(task.goal_id).toBe(goalId);
    expect(task.status).toBe('TODO');
  });

  it('先頭が数字のタイトルでも欠けない', () => {
    const goalId = insertGoal('面接対策');
    const task = createRootTask(db, goalId, '2つ目のタスク');
    expect(task.title).toBe('2つ目のタスク');
  });

  it('継続チェインの根へ紐づく', () => {
    const first = insertGoal('面接対策');
    const second = insertGoal('面接対策');
    db.prepare('UPDATE goal SET continued_goal_id = ? WHERE id = ?').run(second, first);

    const task = createRootTask(db, second, 'あとから足した');

    expect(task.goal_id).toBe(first);
  });
});

// ===========================================================================
// ここから下は change `task-list-card-tree-ui` が凍結したもの（apply は触るの禁止）。
// design doc `Task Tree.dc.html` の t1 が持つキーボード操作（Enter / Tab / Shift+Tab /
// Alt+C）と、カンバンのパンくず帯が要る情報を、サービス層の契約として固定する。
// ===========================================================================

/** getBlueprint の子の並び（tree_order 順）をタイトルで取り出す。 */
function childTitles(db: DB, goalId: number, path: number[] = []): string[] {
  let nodes = getBlueprint(db, goalId).nodes;
  for (const idx of path) nodes = nodes[idx]!.children;
  return nodes.map((n) => n.title);
}

// --- Enter: 兄弟の追加（design D5） -----------------------------------------

describe('createSiblingTask: 部分木の直後に同じ深さで足す', () => {
  it('同じ親の子になり、対象の直後に入る', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, '- 容れ物\n  - A1\n  - A2');
    const a1 = getBlueprint(db, goalId).nodes[0]!.children[0]!;

    createSiblingTask(db, a1.id, 'A1.5');

    expect(childTitles(db, goalId, [0])).toEqual(['A1', 'A1.5', 'A2']);
  });

  it('対象の列（status）を引き継ぐ', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, '- 容れ物\n  - A1');
    const a1 = getBlueprint(db, goalId).nodes[0]!.children[0]!;
    updateTask(db, a1.id, { status: 'DOING' });

    const sib = createSiblingTask(db, a1.id, 'A2');

    expect(sib.status).toBe('DOING');
  });

  it('根の兄弟は根になり、同じ目標を引き継ぐ', () => {
    const goalId = insertGoal('面接対策');
    const root = createRootTask(db, goalId, '枝1');

    const sib = createSiblingTask(db, root.id, '枝2');

    expect(sib.parent_task_id).toBe(null);
    expect(sib.goal_id).toBe(goalId);
    expect(childTitles(db, goalId)).toEqual(['枝1', '枝2']);
  });

  it('継続チェインの2代目から足しても根の目標に紐づく', () => {
    const first = insertGoal('面接対策');
    const second = insertGoal('面接対策');
    db.prepare('UPDATE goal SET continued_goal_id = ? WHERE id = ?').run(second, first);
    const root = createRootTask(db, second, '枝1');

    const sib = createSiblingTask(db, root.id, '枝2');

    expect(sib.goal_id).toBe(first);
  });

  it('存在しないタスクの兄弟は作れない', () => {
    expect(() => createSiblingTask(db, 9999, 'どこにも付かない')).toThrow(TaskTreeError);
  });
});

// --- Tab / Shift+Tab: 階層を1段動かす（design D4） --------------------------

describe('setTreePosition: 1段深く / 1段浅く', () => {
  it('新しい親の末尾の子になる（1段深く）', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, '- A\n  - A1\n- B');
    const [a, b] = getBlueprint(db, goalId).nodes;

    setTreePosition(db, b!.id, { parentId: a!.id, afterTaskId: null });

    expect(childTitles(db, goalId)).toEqual(['A']);
    expect(childTitles(db, goalId, [0])).toEqual(['A1', 'B']);
  });

  it('子孫は一緒に動く', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, '- A\n- B\n  - B1\n    - B1a');
    const [a, b] = getBlueprint(db, goalId).nodes;

    setTreePosition(db, b!.id, { parentId: a!.id, afterTaskId: null });

    expect(childTitles(db, goalId, [0])).toEqual(['B']);
    expect(childTitles(db, goalId, [0, 0])).toEqual(['B1']);
    expect(childTitles(db, goalId, [0, 0, 0])).toEqual(['B1a']);
  });

  it('afterTaskId で親の直後に並ぶ（1段浅く）', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, '- 根\n  - P\n    - C1\n    - C2\n    - C3\n  - Q');
    const rootNode = getBlueprint(db, goalId).nodes[0]!;
    const p = rootNode.children[0]!;
    const c2 = p.children[1]!;

    setTreePosition(db, c2.id, { parentId: rootNode.id, afterTaskId: p.id });

    // P の3番目の子の後ろではなく、P の直後。
    expect(childTitles(db, goalId, [0])).toEqual(['P', 'C2', 'Q']);
    expect(childTitles(db, goalId, [0, 0])).toEqual(['C1', 'C3']);
  });

  it('根まで浅くすると祖先の目標を引き継ぐ', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, '- P\n  - C1\n  - C2');
    const p = getBlueprint(db, goalId).nodes[0]!;
    const c1 = p.children[0]!;

    setTreePosition(db, c1.id, { parentId: null, afterTaskId: p.id });

    const moved = listTasks(db).find((t) => t.id === c1.id)!;
    expect(moved.parent_task_id).toBe(null);
    expect(moved.goal_id).toBe(goalId);
    expect(childTitles(db, goalId)).toEqual(['P', 'C1']);
  });

  it('自分の子孫の下へは動かせない', () => {
    const a = createTask(db, { title: 'A' });
    const b = createChildTask(db, a.id, { title: 'B' });
    const c = createChildTask(db, b.id, { title: 'C' });

    expect(() => setTreePosition(db, a.id, { parentId: c.id, afterTaskId: null })).toThrow(
      TaskTreeError,
    );
    expect(listTasks(db).find((t) => t.id === a.id)!.parent_task_id).toBe(null);
  });

  it('自分自身を親にはできない', () => {
    const a = createTask(db, { title: 'A' });
    expect(() => setTreePosition(db, a.id, { parentId: a.id, afterTaskId: null })).toThrow(
      TaskTreeError,
    );
  });

  it('存在しないタスクは動かせない', () => {
    expect(() => setTreePosition(db, 9999, { parentId: null, afterTaskId: null })).toThrow(
      TaskTreeError,
    );
  });
});

// --- Alt+↑ / Alt+↓: 兄弟内の並び順だけを入れ替える（issue #104） -------------

describe('setTreePosition: 深さを変えず同じ親の中で並び替える', () => {
  it('子どうしの隣接入れ替え: 前を後ろの直後へ移すと2つが入れ替わる', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, '- 容れ物\n  - A\n  - B\n  - C');
    const container = getBlueprint(db, goalId).nodes[0]!;
    const [a, b] = container.children;

    // A を B の直後へ挿入 = 隣り合う A・B が入れ替わる（afterTaskId の意味論は
    // 「参照ノードの“現在の”直後」であり、対象自身の元位置は考慮しないため、
    // 隣接入れ替えは常に「前を後ろの直後へ移す」形で表現する）。
    setTreePosition(db, a!.id, { parentId: container.id, afterTaskId: b!.id });

    expect(childTitles(db, goalId, [0])).toEqual(['B', 'A', 'C']);
    const moved = listTasks(db).find((t) => t.id === a!.id)!;
    expect(moved.parent_task_id).toBe(container.id);
  });

  it('根どうしの隣接入れ替えでも goal_id は変わらない', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, '- 枝1\n- 枝2\n- 枝3');
    const [root1, root2] = getBlueprint(db, goalId).nodes;

    setTreePosition(db, root1!.id, { parentId: null, afterTaskId: root2!.id });

    expect(childTitles(db, goalId)).toEqual(['枝2', '枝1', '枝3']);
    const moved = listTasks(db).find((t) => t.id === root1!.id)!;
    expect(moved.parent_task_id).toBe(null);
    expect(moved.goal_id).toBe(goalId);
  });

  it('落とし穴: afterTaskId=null は「先頭へ」ではなく「末尾へ」になる（design が回避する理由）', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, '- 枝1\n- 枝2\n- 枝3');
    const [, root2] = getBlueprint(db, goalId).nodes;

    setTreePosition(db, root2!.id, { parentId: null, afterTaskId: null });

    // 「先頭にする」つもりで afterTaskId: null を渡すと、実際は末尾に置かれる。
    // Alt+↑ で「対象を先頭へ」を実現したい場合はこの形を使ってはならない。
    expect(childTitles(db, goalId)).toEqual(['枝1', '枝3', '枝2']);
  });

  it('子を持つノードを入れ替えても子は一緒に付いてくる', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, '- A\n  - A1\n  - A2\n- B\n- C');
    const [a, b] = getBlueprint(db, goalId).nodes;

    setTreePosition(db, a!.id, { parentId: null, afterTaskId: b!.id });

    expect(childTitles(db, goalId)).toEqual(['B', 'A', 'C']);
    expect(childTitles(db, goalId, [1])).toEqual(['A1', 'A2']);
  });
});

// --- 容れ物のチェック / Alt+C: 部分木の一括完了（design D6） ----------------

describe('setSubtreeDone: 部分木の葉をまとめて切り替える', () => {
  it('未完了の葉が全部完了になり、容れ物も完了として導出される', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, '- 枝\n  - a\n  - b\n  - c');
    const branch = getBlueprint(db, goalId).nodes[0]!;

    setSubtreeDone(db, branch.id, true);

    const after = getBlueprint(db, goalId).nodes[0]!;
    expect(after.done).toBe(true);
    expect(after.children.every((c) => c.done)).toBe(true);
  });

  it('外すと配下の葉が未着手へ戻る', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, '- 枝\n  - a\n  - b');
    const branch = getBlueprint(db, goalId).nodes[0]!;
    setSubtreeDone(db, branch.id, true);

    setSubtreeDone(db, branch.id, false);

    const after = getBlueprint(db, goalId).nodes[0]!;
    expect(after.done).toBe(false);
    expect(after.children.map((c) => c.status)).toEqual(['TODO', 'TODO']);
  });

  it('打ち切り済みの葉はどちらの向きでも動かない', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, '- 枝\n  - 打ち切る側\n- 別枝\n  - a\n  - b');
    const dropped = getBlueprint(db, goalId).nodes[0]!;
    dropBranch(db, dropped.id, '志望先が変わったため');
    // 打ち切り済みの葉を、これから一括操作する枝の下へ移す。
    const target = getBlueprint(db, goalId).nodes[1]!;
    const droppedLeafId = getBlueprint(db, goalId).nodes[0]!.children[0]!.id;
    setTreePosition(db, droppedLeafId, { parentId: target.id, afterTaskId: null });

    setSubtreeDone(db, target.id, true);
    setSubtreeDone(db, target.id, false);

    const leaf = listTasks(db).find((t) => t.id === droppedLeafId)!;
    expect(leaf.status).toBe('DONE');
    expect(leaf.drop_reason).toBe('志望先が変わったため');
  });

  it('葉なら自分だけが変わる', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, '- 枝\n  - a\n  - b');
    const branch = getBlueprint(db, goalId).nodes[0]!;
    const a = branch.children[0]!;

    setSubtreeDone(db, a.id, true);

    const after = getBlueprint(db, goalId).nodes[0]!;
    expect(after.children.map((c) => c.done)).toEqual([true, false]);
    expect(after.done).toBe(false);
  });

  it('容れ物の status を完了の根拠にしない（導出のまま）', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, '- 枝\n  - a\n  - b');
    const branch = getBlueprint(db, goalId).nodes[0]!;

    setSubtreeDone(db, branch.id, true);
    // 子を1つ未着手へ戻せば、容れ物は再び未完了として導出される。
    const a = getBlueprint(db, goalId).nodes[0]!.children[0]!;
    updateTask(db, a.id, { status: 'TODO' });

    expect(getBlueprint(db, goalId).nodes[0]!.done).toBe(false);
  });

  it('深い部分木でも一度で終わる', () => {
    const goalId = insertGoal('面接対策');
    importBlueprint(db, goalId, '- 枝\n  - 中\n    - x\n    - y\n  - z');
    const branch = getBlueprint(db, goalId).nodes[0]!;

    setSubtreeDone(db, branch.id, true);

    const after = getBlueprint(db, goalId).nodes[0]!;
    expect(after.done).toBe(true);
    expect(after.children[0]!.children.every((c) => c.done)).toBe(true);
  });

  it('存在しないタスクは切り替えられない', () => {
    expect(() => setSubtreeDone(db, 9999, true)).toThrow(TaskTreeError);
  });
});

// --- カンバンのパンくず帯が要る情報（design D2・D3） ------------------------

describe('listTasks は根の枝と目標名を返す', () => {
  it('葉から根の枝の id と目標名が引ける', () => {
    const goalId = insertGoal('メンタルを安定させる');
    importBlueprint(db, goalId, '- 睡眠のリズムを整える\n  - 起床時間を1週間記録する');
    const branch = getBlueprint(db, goalId).nodes[0]!;
    const leaf = branch.children[0]!;

    const row = listTasks(db).find((t) => t.id === leaf.id)!;

    expect(row.root_task_id).toBe(branch.id);
    expect(row.goal_name).toBe('メンタルを安定させる');
  });

  it('根自身の root_task_id は自分', () => {
    const goalId = insertGoal('メンタルを安定させる');
    const root = createRootTask(db, goalId, '枝1');

    const row = listTasks(db).find((t) => t.id === root.id)!;

    expect(row.root_task_id).toBe(root.id);
  });

  it('同じ枝の葉は同じ root_task_id を持ち、別の枝とは異なる', () => {
    const goalId = insertGoal('メンタルを安定させる');
    importBlueprint(db, goalId, '- 枝1\n  - a\n  - b\n- 枝2\n  - c');
    const [b1, b2] = getBlueprint(db, goalId).nodes;
    const rows = listTasks(db);
    const rootOf = (id: number) => rows.find((t) => t.id === id)!.root_task_id;

    expect(rootOf(b1!.children[0]!.id)).toBe(b1!.id);
    expect(rootOf(b1!.children[1]!.id)).toBe(b1!.id);
    expect(rootOf(b2!.children[0]!.id)).toBe(b2!.id);
    expect(rootOf(b1!.children[0]!.id)).not.toBe(rootOf(b2!.children[0]!.id));
  });

  it('目標に属さないツリーの葉は goal_name が null', () => {
    const parent = createTask(db, { title: '買い物リストを作る' });
    const child = createChildTask(db, parent.id, { title: '牛乳を買う' });

    const row = listTasks(db).find((t) => t.id === child.id)!;

    expect(row.root_task_id).toBe(parent.id);
    expect(row.goal_name).toBe(null);
  });

  it('継続チェインでは根の目標の名前が出る', () => {
    const first = insertGoal('1代目の目標');
    const second = insertGoal('2代目の目標');
    db.prepare('UPDATE goal SET continued_goal_id = ? WHERE id = ?').run(second, first);
    const root = createRootTask(db, second, '枝1');
    const leaf = createChildTask(db, root.id, { title: '葉' });

    const row = listTasks(db).find((t) => t.id === leaf.id)!;

    expect(row.goal_name).toBe('1代目の目標');
  });
});
