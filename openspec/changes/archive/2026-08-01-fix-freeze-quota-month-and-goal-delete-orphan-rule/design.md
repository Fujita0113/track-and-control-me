## Context

issue #75（e2e失敗調査）から見つかった2件は独立したバグだが、どちらも「境界（日付/ライフサイクル）をまたぐ後始末の実装漏れ」という共通の性質を持つため1つの change にまとめる。

- `server/src/services/goal-freeze.ts`: `reserveFreezeMulti()` は月枠の重複チェックを「翌日（発効日）の月」で行うが、`freezeQuota()`（表示・API用）は「今日の月」で判定しており、月末（today の翌日が翌月になる日）にだけ両者が食い違う。
- `server/src/services/goals.ts`: `deleteGoal()` は `DELETE FROM goal WHERE id = ?` のみ実行する。スキーマ上 `goal_rule`（goal_id, rule_id の中間テーブル）は `goal(id) ON DELETE CASCADE` で紐付けが消えるが、`rule` テーブル自体の行は削除されない。**これは意図的な既存仕様であり、`goals.test.ts`「削除猶予（作成当日のみ）」の既存テストが `rule` 本体の行数 `1` を明示的に検証している**（rule本体を消すこと自体は今回のバグではない）。
- 真のバグは `listActiveRules()`（`server/src/services/rule-registry.ts:323-325`）側にある: `SELECT * FROM rule WHERE status = 'active' AND start_day <= ?` と `rule.status` だけを見ており、`deleteGoal()` は削除対象の goal に紐づいていた rule の `status` を何も更新しない。そのため親 goal を失っても `status='active'` のまま残り、`listActiveRules()`（→ `evaluate.ts` の解錠判定・`listDueRules`）に「達成不可能な未達成条件」として拾われ続け、当日以降の解錠ゲートを永久にブロックする。
- `rule` は goal 間で共有されうる（`goal_rule` は多対多。`goal-lifecycle-fork` で目標が完走→継続する際、同じ `rule_id` が新しい goal へ `INSERT OR IGNORE` で引き継がれる。`rule-registry.ts` の rule_id → 複数 goal_id を前提にしたクエリもある）。そのため goal 削除時に紐づく rule の `status` を無条件に変えると、他の goal がまだ追っているルールまで解錠評価から消してしまう。
- ルールを `status='removed'` にする手段は既に `rule-registry.ts` の `removeRule(db, ruleId, reason, nowMs)` として存在し、`editable-rule-registry` spec の「目標コーナーからルールを理由つきで削除する」導線（`DELETE /api/goals/:id/rules/:ruleId`）が使っている。`listActiveRules` はこの `status` を見て既に `removed` を除外している（`rule-registry.test.ts` の `listActiveRules` テストで確認済み）。

## Goals / Non-Goals

**Goals:**
- `freezeQuota()` が「今月使用済みか」を判定する基準を `reserveFreezeMulti()` の重複チェックと同じ月（翌日＝発効日の月）に揃え、月末での表示/予約の食い違いを無くす。
- `deleteGoal()` が、削除対象の goal にのみ紐づいていた rule（他のどの goal からも参照されなくなったもの）を `removeRule()` 相当の手段で `status='removed'` に遷移させ、解錠ゲートの評価対象（`listActiveRules`）から確実に外す。**rule 本体の行・変更履歴は既存どおり残す**（物理削除はしない・既存テストの前提を変えない）。
- 両方とも既存の `goal-freeze` / `goal-challenge` spec が既に示している意図（月枠は単一の基準・削除された目標のルールはゲートに残らない）に実装を合わせるだけで、ユーザー向けの新しい挙動や選択肢を追加しない。

**Non-Goals:**
- 凍結・削除まわりの新機能追加（例: 削除可能期間の拡張、月跨ぎ予約の別UI）は範囲外。
- `rule` 共有の設計自体（`goal-lifecycle-fork` の引き継ぎ方式）や、rule 本体を物理削除する方式への変更。既存の「rule本体は残る・他goalからまだ参照されていれば active のまま」という前提はそのまま使う。
- 過去に既に孤児化してしまった rule（本番DBに実在する可能性がある既存データ）のバックフィル/クリーンアップは範囲外（今回の修正は「以後発生させない」こと）。

## Decisions

### D1: `freezeQuota()` の月基準を「翌日（発効日）」に統一する

`reserveFreezeMulti()` は常に `startDay = addDaysKey(today, 1)` を発効日とし、`quotaRowForMonth(db, startDay.slice(0, 7))` で重複チェックする。`freezeQuota()` は「今の状態を尋ねられたら、次に予約したら/した場合にどうなるか」を答える窓口でもあるため、同じ「翌日の月」を基準にすべきである。共有ヘルパー `quotaMonthOf(today)` を `goal-freeze.ts` 内に追加し、`reserveFreezeMulti()` の `startDay.slice(0, 7)` と `freezeQuota()` の月計算の両方をこれに置き換える（今日基準 → 翌日基準に統一。通常日は today と翌日が同じ月なので既存の振る舞いは変わらず、月末だけ修正される）。

代替案として「`reserveFreezeMulti()` 側を今日基準に変える」も検討したが、凍結は必ず翌日発効という設計（design D5・goal-freeze spec）と矛盾するため却下。翌日基準に揃えるのが正しい。

### D2: `deleteGoal()` は「他goalからの参照が0件になったruleだけ」`removeRule()` で `status='removed'` にする

`rule` 本体を物理削除するのではなく、既存の `removeRule(db, ruleId, reason, nowMs)`（`rule-registry.ts`）が持つ「`status='removed'` に更新し `rule_change` へ記録する」処理をそのまま再利用する。トランザクション内で:
1. 削除対象 goal に紐づく `rule_id` 一覧を `goal_rule` から事前に取得する。
2. `DELETE FROM goal WHERE id = ?` を実行する（`goal_rule` の紐付けは FK カスケードで自動削除。`rule` 本体はここでは消えない＝既存挙動のまま）。
3. 1で集めた各 `rule_id` について、`goal_rule` に残存する参照が無ければ（＝他のどの goal からも追われていなければ）`removeRule(db, ruleId, '目標の削除に伴い自動的に削除', nowMs)` を呼ぶ。理由は固定文言でよい（目標削除という上位操作自体がユーザーの意思表示であり、個々のルール削除ごとに再度理由入力を求めるのは過剰）。まだ他 goal から参照されている `rule_id` には触れない。

代替案として「`listActiveRules()` 側に `goal_rule` の JOIN 条件を足し、親 goal が1つも無い rule を除外する」も検討したが、`rule-registry.test.ts` の既存テスト群（`createRule` で goal に紐付けず単体の rule を作り `listActiveRules` に含まれることを検証している）と根本的に矛盾するため却下。`rule-registry` 層は元々 goal 非依存の設計であり、goal とのライフサイクル紐付けは `goals.ts` 側（`deleteGoal`）の責務とするのが既存アーキテクチャに沿う。

代替案として「`deleteGoal()` が rule 本体を物理削除する」も検討したが、`goals.test.ts` の既存テスト（削除後も rule 本体が1件残ることを明示的に検証）と矛盾するため却下。

## Risks / Trade-offs

- [Risk] 本番DB（`server/data/track.sqlite`）に、今回の修正前から既に孤児化した `rule` 行が残っている可能性がある → [Mitigation] 今回のスコープは「以後発生させない」こと。既存の孤児データが実際に解錠をブロックしているかはデモ/実DBで確認し、もし本当に存在するなら別途ワンオフのクリーンアップ（本changeのtasksには含めない）を検討する。
- [Risk] `freezeQuota()` の月基準変更は、月末以外の日には既存の振る舞いと数学的に完全に同じ（today と翌日が同じ月のため）だが、念のため既存の `goals-freeze.test.ts` の全ケース（月末以外のケース含む）を通して回帰が無いことを確認する。
- [Risk] `deleteGoal()` の rule 除去判定は `goal_rule` への他参照の有無で行うため、削除処理の途中（同一トランザクション内）で他goalが同じruleへ新規に紐づく競合は理論上あり得るが、`better-sqlite3` は同期的でトランザクション内は単一操作のため実運用上のレースは発生しない。
- [Risk] `removeRule()` は `rule_change` に `op='remove'` の記録を残す。目標削除に伴う自動除去も同じ記録経路を通るため、沿革（chronicle）側がこの自動除去エントリをどう表示するか（他goalに影響しないか）は既存の `goal-chronicle` の挙動を壊さないことを実装時に確認する。

## Migration Plan

- スキーマ変更は無し（既存テーブル・FKをそのまま使う）。
- デプロイは通常のコード変更としてリリースするのみ。ロールバックは変更前のコードに戻すだけで良い（データの後方互換性に影響しない）。
