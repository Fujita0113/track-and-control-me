// @ts-nocheck — 型宣言を持たないブラウザ ESM（static/js/kanban.js）の純関数を直接検証するため。
// tsc の型検査対象外にする（vitest/esbuild は型を無視して実行する）。
import { describe, it, expect } from 'vitest';
// クライアントの純粋関数を直接検証する（DOM/localStorage 非依存の分岐ロジック）。
import { shouldSkipDeleteConfirm } from '../../static/js/kanban.js';

/**
 * ゴミ箱アイコン起点の削除確認のみ「次回から確認しない」を効かせる分岐ロジック（issue #95）。
 * 右クリック・詳細パネル起点は、設定値に関わらず常に確認を経る（design D1）。
 */
describe('shouldSkipDeleteConfirm（起点別の確認省略判定）', () => {
  it('ゴミ箱アイコン起点かつ設定 ON なら省略する', () => {
    expect(shouldSkipDeleteConfirm('trash', true)).toBe(true);
  });

  it('ゴミ箱アイコン起点でも設定 OFF なら省略しない', () => {
    expect(shouldSkipDeleteConfirm('trash', false)).toBe(false);
  });

  it('右クリック起点は設定 ON でも省略しない', () => {
    expect(shouldSkipDeleteConfirm('contextmenu', true)).toBe(false);
  });

  it('詳細パネル起点は設定 ON でも省略しない', () => {
    expect(shouldSkipDeleteConfirm('detail', true)).toBe(false);
  });

  it('設定値が undefined/null でも安全に false 扱いする', () => {
    expect(shouldSkipDeleteConfirm('trash', undefined)).toBe(false);
    expect(shouldSkipDeleteConfirm('trash', null)).toBe(false);
  });
});
