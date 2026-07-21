/**
 * 目標まわりの共有エラー。
 *
 * 目標本体（goals.ts）と沿革の読み取り（goal-chronicle.ts）の両方が投げるため、どちらにも
 * 属さない場所に置く（循環 import を作らずに1つのクラスを共有する）。API 層は1つ catch すれば 404 に写せる。
 */
export class GoalNotFoundError extends Error {
  constructor(id: number) {
    super(`目標が見つかりません: ${id}`);
    this.name = 'GoalNotFoundError';
  }
}
