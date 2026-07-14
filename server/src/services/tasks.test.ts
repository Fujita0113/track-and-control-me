import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { createTask, updateTask, getTask, listTasks } from './tasks.js';
import { resolvePlanningSignal } from './planning.js';

/**
 * かんばんタスクのカテゴリ（kanban-task-category）。
 * 両持ち保存（UUID照合＋名前色スナップショット）の作成・更新・NULL化と、
 * グループ削除後もスナップショットが残ること・改色しても照合(UUID)維持＋スナップショット不変（design D1〜D3）、
 * 集計/評価シグナルへ波及しないこと（2.5）をサービス層で検証する。
 */

const TODAY = '2026-07-10';
const TOMORROW = '2026-07-11';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

/** tab_group 行を作る（stable_group_id/name/color）。 */
function insertGroup(sid: string, name: string, color: string | null): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tab_group (stable_group_id, name, color, external_group_id, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, NULL, ?, ?)`,
  ).run(sid, name, color, now, now);
}

describe('カテゴリ付き作成・更新・NULL化', () => {
  it('既存タスクはカテゴリ無し（従来挙動・全列 null）', () => {
    const t = createTask(db, { title: 'カテゴリ無し' });
    expect(t.category_group_id).toBeNull();
    expect(t.category_name).toBeNull();
    expect(t.category_color).toBeNull();
  });

  it('グループ由来カテゴリを付けて作成（UUID＋name＋color を保存）', () => {
    const t = createTask(db, {
      title: '競プロ',
      category_group_id: 'grp-x',
      category_name: '競技プログラミング',
      category_color: 'blue',
    });
    const got = getTask(db, t.id)!;
    expect(got.category_group_id).toBe('grp-x');
    expect(got.category_name).toBe('競技プログラミング');
    expect(got.category_color).toBe('blue');
  });

  it('PATCH でカテゴリを後付けできる', () => {
    const t = createTask(db, { title: 'あとで分類' });
    const upd = updateTask(db, t.id, {
      category_group_id: 'grp-y',
      category_name: '英語',
      category_color: 'green',
    })!;
    expect(upd.category_group_id).toBe('grp-y');
    expect(upd.category_name).toBe('英語');
    expect(upd.category_color).toBe('green');
  });

  it('自由入力カテゴリ（group_id なし・色なし）', () => {
    const t = createTask(db, { title: '手入力', category_name: '読書' });
    const got = getTask(db, t.id)!;
    expect(got.category_group_id).toBeNull();
    expect(got.category_name).toBe('読書');
    expect(got.category_color).toBeNull();
  });

  it('PATCH で 3 列を NULL 化してカテゴリを除去できる', () => {
    const t = createTask(db, {
      title: 'いったん分類',
      category_group_id: 'grp-z',
      category_name: '雑務',
      category_color: 'yellow',
    });
    const upd = updateTask(db, t.id, {
      category_group_id: null,
      category_name: null,
      category_color: null,
    })!;
    expect(upd.category_group_id).toBeNull();
    expect(upd.category_name).toBeNull();
    expect(upd.category_color).toBeNull();
  });
});

describe('スナップショットの独立性（削除・改色に耐える）', () => {
  it('元グループを削除してもタスクの name/color スナップショットは残る', () => {
    insertGroup('grp-del', '競技プログラミング', 'blue');
    const t = createTask(db, {
      title: '本番',
      category_group_id: 'grp-del',
      category_name: '競技プログラミング',
      category_color: 'blue',
    });
    // グループ削除。
    db.prepare('DELETE FROM tab_group WHERE stable_group_id = ?').run('grp-del');
    const got = getTask(db, t.id)!;
    // 照合キー（UUID）は残るが、表示はスナップショットで生き続ける。
    expect(got.category_group_id).toBe('grp-del');
    expect(got.category_name).toBe('競技プログラミング');
    expect(got.category_color).toBe('blue');
  });

  it('元グループを改色してもタスクの照合(UUID)は維持され、スナップショットは当時値のまま', () => {
    insertGroup('grp-recolor', '英語', 'green');
    const t = createTask(db, {
      title: '英単語',
      category_group_id: 'grp-recolor',
      category_name: '英語',
      category_color: 'green', // 付与当時の色。
    });
    // グループの色を後から変更（green → red）。タスクのスナップショットには触れない。
    db.prepare('UPDATE tab_group SET color = ? WHERE stable_group_id = ?').run('red', 'grp-recolor');
    const got = getTask(db, t.id)!;
    expect(got.category_group_id).toBe('grp-recolor'); // 照合は UUID で不変。
    expect(got.category_color).toBe('green'); // 当時の色（凍結された表示写真）。
    // 現グループとの同一性は UUID で判定できる。
    const cur = db.prepare('SELECT color FROM tab_group WHERE stable_group_id = ?').get('grp-recolor') as {
      color: string;
    };
    expect(cur.color).toBe('red'); // グループ側は変わっている。
  });
});

describe('集計・評価への非波及（2.5）', () => {
  it('カテゴリ付与は翌日タスク計上（PLANNING シグナル）を変えない', () => {
    // カテゴリ無しの翌日タスク 1 件で tomorrow_tasks_registered=true。
    createTask(db, { title: '明日A', status: 'TODO', due: TOMORROW });
    const before = resolvePlanningSignal(db, TODAY, 'tomorrow_tasks_registered');
    // カテゴリ付きの翌日タスクを追加しても、計上ロジックは同じ（true のまま）。
    createTask(db, {
      title: '明日B',
      status: 'TODO',
      due: TOMORROW,
      category_group_id: 'grp-x',
      category_name: '競技プログラミング',
      category_color: 'blue',
    });
    const after = resolvePlanningSignal(db, TODAY, 'tomorrow_tasks_registered');
    expect(before).toBe(true);
    expect(after).toBe(true);
    // 既存 DONE 判定など他フィールドも壊れていない（DONE はカテゴリ有無に依らず非計上）。
    const done = createTask(db, {
      title: '完了',
      status: 'DONE',
      due: TOMORROW,
      category_name: 'その他',
    });
    expect(getTask(db, done.id)!.category_name).toBe('その他');
    expect(resolvePlanningSignal(db, TODAY, 'tomorrow_tasks_registered')).toBe(true);
    // listTasks は全件返す（カテゴリ列含む）。
    expect(listTasks(db).length).toBe(3);
  });
});
