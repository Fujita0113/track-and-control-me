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
  setParent,
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
