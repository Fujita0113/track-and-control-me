## 1. DB マイグレーション

- [x] 1.1 `server/src/db/migrations.ts` に `rule_group_member` テーブル追加マイグレーション（`rule_id` FK + `group_identity_id` FK + `sort_order`）を追記する
- [x] 1.2 マイグレーション適用後に `rule_group_member` テーブルが存在することを確認（`openDb(':memory:')` でスモークテスト）

## 2. サーバー: ルールレジストリ拡張

- [x] 2.1 `server/src/services/rule-registry.ts` の `RuleTarget` 型に `'GROUP_OR'` を追加する
- [x] 2.2 `RuleRow` インターフェースはそのまま（`rule` 行に新列追加なし）
- [x] 2.3 `RuleContentInput` に `groupIdentityIds?: number[]` フィールドを追加する（`GROUP_OR` 専用）
- [x] 2.4 `validateContent` に `GROUP_OR` 検証を追加（`groupIdentityIds` が 2 件以上・`thresholdSeconds > 0` が必須）
- [x] 2.5 `createRule` で `GROUP_OR` のとき `rule_group_member` へ INSERT するロジックを追加（トランザクション内）
- [x] 2.6 `updateRule` で `GROUP_OR` のとき `rule_group_member` を DELETE → INSERT する差し替えロジックを追加
- [x] 2.7 `removeRule` で `rule_group_member` が CASCADE DELETE されることをマイグレーション定義で保証する（FK + ON DELETE CASCADE）
- [x] 2.8 `contentSnapshot` 関数に `groupIdentityIds` 配列を含める（`rule_group_member` を JOIN して取得）
- [x] 2.9 ルール取得（`listGoalRules` 等）で `GROUP_OR` ルールに `groupIdentityIds`・各グループ名を付与して返す

## 3. サーバー: 評価ロジック

- [x] 3.1 `server/src/rules/evaluate.ts` に `'GROUP_OR'` case を追加する
- [x] 3.2 `GROUP_OR` 評価: `rule_group_member` から全 `group_identity_id` を取得し、各 identity の aliases を集めてセッション合計秒を計算する
- [x] 3.3 評価結果の構造は `GROUP` と同形（`actualSeconds`, `thresholdSeconds`, `groupName`（要約名）, `met`）にする

## 4. サーバー: API 層

- [x] 4.1 `server/src/routes/goals.ts`（または `rules.ts`）でルール作成/更新 API が `groupIdentityIds` を受け取り `rule-registry` に渡すよう対応する
- [x] 4.2 ルール取得 API レスポンスに `GROUP_OR` 用の `groupIdentityIds` フィールドを含める

## 5. クライアント: 種別定義

- [x] 5.1 `server/static/js/targets.js` の `CONDITION_KINDS` に `{ v: 'GROUP_OR', target: 'GROUP_OR', signalKey: null, label: 'グループ OR 集計' }` を追加する
- [x] 5.2 `conditionKindTarget('GROUP_OR')` が `{ target: 'GROUP_OR', signalKey: null }` を返すことを確認する
- [x] 5.3 `targetLabel`・`conditionLabel` が `'GROUP_OR'` を `'グループ OR 集計'` と返すよう対応する

## 6. クライアント: ルールフォーム UI

- [x] 6.1 `server/static/js/rule-form.js` の `syncKind` に `GROUP_OR` ブランチを追加する（グループ複数選択チェックボックス + 分数入力）
- [x] 6.2 `GROUP_OR` 選択時：`groups` 一覧をチェックボックスで表示し、2件以上選択必須のバリデーションを UI 側でも行う
- [x] 6.3 `read()` で `GROUP_OR` のとき `groupIdentityIds` 配列を返すよう対応する
- [x] 6.4 `GROUP_OR` 編集時は既存 `groupIdentityIds` をチェック済み状態で表示する（prefill）
- [x] 6.5 `ruleDisplayLabel` で `GROUP_OR` の表示ラベルを組み立てる（2件: 「A または B XX分以上」 / 3件以上: 「A など XX分以上」）

## 7. クライアント: ゲート画面・目標画面の表示

- [x] 7.1 `server/static/js/today.js`（ゲート画面）で `GROUP_OR` 条件を `ruleDisplayLabel` か同等の関数で表示する
- [x] 7.2 `server/static/js/goals.js`（目標画面・ルール一覧）で `GROUP_OR` が正しく表示されることを確認する

## 8. テスト（vitest）

- [x] 8.1 `server/src/rules/evaluate.test.ts` に `GROUP_OR` 評価テストを追加する（赤テストを先に配置）:
  - 2グループ合計が閾値以上で `met=true`
  - 合計が閾値未満で `met=false`
  - グループが0セッションでもエラーにならない
- [x] 8.2 `server/src/services/rule-registry.test.ts` に `GROUP_OR` バリデーションテストを追加する:
  - `groupIdentityIds` が1件以下なら `RuleValidationError`
  - 2件以上なら `rule_group_member` 行が正しく挿入される
  - `updateRule` でメンバーが差し替えられる

## 9. テスト実行・確認

- [x] 9.1 `npm test` を実行し、8.1〜8.2 の新規テストが赤（未実装で失敗）であることを確認する
- [x] 9.2 実装完了後に `npm test` が全て緑になることを確認する

## E2E・既存テスト

- 既存 e2e への影響: `server/static/js/rule-form.js` の条件ドロップダウンに選択肢が追加されるが、既存テストが特定の選択肢を位置で指定していない限り壊れないはず。`e2e/` の関連 spec を確認し、必要であれば既存 spec を修正する（新規 e2e は apply 時に DOM 確定後に書く）。
- apply が書く新規 e2e フロー: 「GROUP_OR ルールを作成 → ゲートに条件が表示される → セッション合計が閾値を超えてゲートが開く」

---

**vitest 赤テスト（propose 段階で作成・凍結）:**

`server/src/rules/evaluate.test.ts` に以下を追記する（実装前は失敗すること）:

```ts
describe('GROUP_OR ルールの評価', () => {
  it('2グループの合計が閾値以上なら met=true', () => {
    const id1 = resolveIdentity(db, '英語の勉強', 'blue')!;
    const id2 = resolveIdentity(db, '読書', 'green')!;
    seedSession(db, '英語の勉強', 'blue', jst(2026, 7, 20, 9, 0), jst(2026, 7, 20, 9, 20)); // 1200秒
    seedSession(db, '読書', 'green', jst(2026, 7, 20, 10, 0), jst(2026, 7, 20, 10, 10)); // 600秒
    createRule(db, {
      target: 'GROUP_OR',
      groupIdentityIds: [id1, id2],
      thresholdSeconds: 1800,
      startDay: DAY,
      reason: 'r',
    });

    const evalResult = evaluateDay(db, DAY, jst(2026, 7, 20, 12, 0));
    const cond = evalResult.perCondition.find((c) => c.target === 'GROUP_OR')!;
    expect(cond.actualSeconds).toBe(1800);
    expect(cond.met).toBe(true);
  });

  it('2グループの合計が閾値未満なら met=false', () => {
    const id1 = resolveIdentity(db, '英語の勉強', 'blue')!;
    const id2 = resolveIdentity(db, '読書', 'green')!;
    seedSession(db, '英語の勉強', 'blue', jst(2026, 7, 20, 9, 0), jst(2026, 7, 20, 9, 10)); // 600秒
    createRule(db, {
      target: 'GROUP_OR',
      groupIdentityIds: [id1, id2],
      thresholdSeconds: 1800,
      startDay: DAY,
      reason: 'r',
    });

    const evalResult = evaluateDay(db, DAY, jst(2026, 7, 20, 12, 0));
    const cond = evalResult.perCondition.find((c) => c.target === 'GROUP_OR')!;
    expect(cond.actualSeconds).toBe(600);
    expect(cond.met).toBe(false);
  });

  it('全グループにセッションがなくても評価できる（0秒・met=false）', () => {
    const id1 = resolveIdentity(db, '英語の勉強', 'blue')!;
    const id2 = resolveIdentity(db, '読書', 'green')!;
    createRule(db, {
      target: 'GROUP_OR',
      groupIdentityIds: [id1, id2],
      thresholdSeconds: 900,
      startDay: DAY,
      reason: 'r',
    });

    const evalResult = evaluateDay(db, DAY, jst(2026, 7, 20, 12, 0));
    const cond = evalResult.perCondition.find((c) => c.target === 'GROUP_OR')!;
    expect(cond.actualSeconds).toBe(0);
    expect(cond.met).toBe(false);
  });
});
```

`server/src/services/rule-registry.test.ts` に追記:

```ts
describe('GROUP_OR バリデーション', () => {
  it('groupIdentityIds が1件以下なら RuleValidationError', () => {
    const id1 = resolveIdentity(db, 'A', null)!;
    expect(() =>
      createRule(db, {
        target: 'GROUP_OR',
        groupIdentityIds: [id1],
        thresholdSeconds: 900,
        startDay: '2026-07-20',
        reason: 'r',
      })
    ).toThrow('グループは2件以上選択してください');
  });

  it('groupIdentityIds が2件なら rule_group_member に2行挿入される', () => {
    const id1 = resolveIdentity(db, 'A', null)!;
    const id2 = resolveIdentity(db, 'B', null)!;
    const rule = createRule(db, {
      target: 'GROUP_OR',
      groupIdentityIds: [id1, id2],
      thresholdSeconds: 900,
      startDay: '2026-07-20',
      reason: 'r',
    });
    const members = db
      .prepare('SELECT group_identity_id FROM rule_group_member WHERE rule_id = ? ORDER BY sort_order')
      .all(rule.id) as { group_identity_id: number }[];
    expect(members.map((m) => m.group_identity_id)).toEqual([id1, id2]);
  });

  it('updateRule でグループ一覧が差し替わる', () => {
    const id1 = resolveIdentity(db, 'A', null)!;
    const id2 = resolveIdentity(db, 'B', null)!;
    const id3 = resolveIdentity(db, 'C', null)!;
    const rule = createRule(db, {
      target: 'GROUP_OR',
      groupIdentityIds: [id1, id2],
      thresholdSeconds: 900,
      startDay: '2026-07-20',
      reason: 'r',
    });
    updateRule(db, rule.id, {
      target: 'GROUP_OR',
      groupIdentityIds: [id1, id3],
      thresholdSeconds: 900,
      startDay: '2026-07-20',
      reason: '差し替え',
    });
    const members = db
      .prepare('SELECT group_identity_id FROM rule_group_member WHERE rule_id = ? ORDER BY sort_order')
      .all(rule.id) as { group_identity_id: number }[];
    expect(members.map((m) => m.group_identity_id)).toEqual([id1, id3]);
  });
});
```
