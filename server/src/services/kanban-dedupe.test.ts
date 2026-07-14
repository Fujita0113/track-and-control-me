// @ts-nocheck — 型宣言を持たないブラウザ ESM（static/js/kanban.js）の純関数を直接検証するため。
// tsc の型検査対象外にする（vitest/esbuild は型を無視して実行する）。
import { describe, it, expect } from 'vitest';
// クライアントの純粋関数を直接検証する（DOM 非依存の dedup ロジック）。
import { dedupeGroups } from '../../static/js/kanban.js';

/**
 * カテゴリ候補の重複排除（issue #27・同名同色分裂の解消）。
 * 拡張の再インストール等で同名同色グループが別 UUID として複数残っても、
 * 候補チップは name+color で 1 つに束ねる（最近使った代表 UUID を残す）。
 */
describe('dedupeGroups（同名同色の束ね）', () => {
  it('同名同色の別 UUID は 1 件に束ね、最近使った代表（先頭）を残す', () => {
    const groups = [
      { stable_group_id: 'new-uuid', name: 'アルゴリズム', color: 'blue' },
      { stable_group_id: 'old-uuid', name: 'アルゴリズム', color: 'blue' },
    ];
    const out = dedupeGroups(groups);
    expect(out).toHaveLength(1);
    expect(out[0].stable_group_id).toBe('new-uuid'); // last_seen_at DESC 順の先頭が代表。
  });

  it('同名でも色が違えば別候補として残す', () => {
    const groups = [
      { stable_group_id: 'a', name: 'アルゴリズム', color: 'blue' },
      { stable_group_id: 'b', name: 'アルゴリズム', color: 'red' },
    ];
    expect(dedupeGroups(groups)).toHaveLength(2);
  });

  it('異なる名前は保持し、順序は入力（最近使った順）を維持する', () => {
    const groups = [
      { stable_group_id: 'a', name: '英語', color: 'green' },
      { stable_group_id: 'b', name: 'アルゴリズム', color: 'blue' },
      { stable_group_id: 'c', name: 'アルゴリズム', color: 'blue' }, // 重複。
      { stable_group_id: 'd', name: '数学', color: 'red' },
    ];
    expect(dedupeGroups(groups).map((g) => g.name)).toEqual(['英語', 'アルゴリズム', '数学']);
  });

  it('color=null 同士も同名なら束ねる', () => {
    const groups = [
      { stable_group_id: 'a', name: 'メモ', color: null },
      { stable_group_id: 'b', name: 'メモ', color: null },
    ];
    expect(dedupeGroups(groups)).toHaveLength(1);
  });

  it('空配列・undefined を安全に扱う', () => {
    expect(dedupeGroups([])).toEqual([]);
    expect(dedupeGroups(undefined)).toEqual([]); // 実行時ガードの確認。
  });
});
