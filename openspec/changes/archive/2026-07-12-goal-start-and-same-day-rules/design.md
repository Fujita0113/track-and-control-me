## Context

このアプリのコミットメント担保は「凍結ポリシー」に集約されている。ルール変更は翌日以降にしか効かず（`upsertFutureRuleSet` は `effective_date >= 翌日` のみ）、当日/過去の実効ルールは `daily_rule_set.status`（`DRAFT_FUTURE → FROZEN_ACTIVE → PAST`）と **DB トリガ**（`rule_condition` の INSERT/UPDATE/DELETE を非 `DRAFT_FUTURE` ルールセットで ABORT）が二重にロックする。目標も `start_day = 翌日` 固定で、採用実践は翌日実効ルールに対して検証・ジャンル固定される。

凍結ポリシーの明示された目的は「**当日に既存の解錠条件を骨抜きにするゲーミングの抑制**」＝*緩める方向*を当日に効かせないことにある。issue #33 はこの目的を保ったまま、*厳しくする方向*（今日から始める・今日もう一本足す）だけを当日に解禁したい、というもの。実効ルールは常に「1 effective_date につき 1 ルールセット・latest ≤ day を継承」で解決される点、凍結が DB トリガで backstop されている点が主要な制約。

## Goals / Non-Goals

**Goals:**
- 目標の開始日を「今日／明日」から選べる（既定=今日）。今日開始は当日を Day 1 として即「進行中」。
- 当日に新規ルール条件を **追加** できる。当日追加分は同日中に限り自由に編集・削除できる。
- 当日追加で **day 開始時点のゲートが緩くなることは絶対にない**（既存の凍結条件は当日不変・追加のみ）＝凍結ポリシーの目的を維持する。
- 目標が採用した当日追加条件は、同日でもジャンル固定に従い削除・骨抜き不可になる。
- デモの振り返りで各目標の記録コーナーの見え方を（開始前でも）確認できる。

**Non-Goals:**
- **既存（凍結済み）条件の当日での引き上げ・引き下げ・削除**はしない（減らす方向は従来どおり翌日から。厳しくする既存条件変更も今回は当日対象外＝ユーザー回答は「新規追加」に限定）。
- 30日固定・状態導出（合否ラベルなし）・並行複数目標・「削除は作成当日のみ」は不変。
- パスワード生成・解錠 latch のロジック変更、タイムライン/カンバンの評価変更はしない。

## Decisions

### D1: 当日追加は新ステータス `DRAFT_TODAY` の当日ルールセットで表現する

`daily_rule_set.status` に `DRAFT_TODAY` を追加する。当日に条件を追加する操作は、`effective_date = today` のルールセットを次のいずれかで用意し、それを `DRAFT_TODAY`（＝当日のみ可変）にする:
- 当日ルールセットが無い（実効ルールは過去日から継承）場合 → **materialize**：継承 baseline 条件をコピーした `effective_date=today` の行を作り、そこへ追加条件を足す。
- 当日ルールセットが既にある（前日に翌日=当日として編集済みで `FROZEN_ACTIVE`）場合 → その行を `DRAFT_TODAY` に開き直して追加条件を足す（status 変更のみの UPDATE はトリガ許容）。

`DRAFT_TODAY` は当日のうちは freeze-on-read で凍結しない（同日中は何度でも add/編集/削除できる）。日境界の rollover で `DRAFT_TODAY(effective_date < today) → FROZEN_ACTIVE → PAST` と通常凍結する。つまり **当日追加した条件は今日は「下書き扱いで自由」、明日からは通常の凍結ルール**になる。

**なぜ別テーブルや per-condition 列でなく status か**: 凍結の backstop は DB トリガ（`daily_rule_set.status` 参照）が担っている。トリガは tz/offset 込みの「今日」を計算できないため、per-condition の `added_day` 判定はトリガに載せられず backstop が app 層に落ちてしまう。status を 1 値足し、トリガを `status NOT IN ('DRAFT_FUTURE','DRAFT_TODAY')` に緩めるだけなら、可変なのは「app が baseline 保存則の下でのみ作る `DRAFT_TODAY`」に限定され、真に凍結された過去行は従来どおりハードロックのまま。「1 effective_date=1 ルールセット・latest≤day 継承」という既存アーキテクチャも崩さない（新テーブル不要・`rule_condition` スキーマ変更不要）。

**代替案**: (a) 当日追加専用テーブル＋評価時 union — 評価パイプライン（`per_condition_results` 焼き込み→目標レポート）への波及が大きい。(b) `rule_condition.added_day` 列＋トリガの per-condition 化 — トリガが「今日」を持てず backstop 崩壊。いずれも不採用。

### D2: 当日編集の不変条件＝「baseline を保存し、追加のみ」

当日（`DRAFT_TODAY`）への書き込みは、**day 開始時点の baseline ゲートを完全に保存**しなければならない。baseline = 「`effective_date < today` の latest ルールセットから解決した実効条件」（当日行を materialize/開き直す前の姿）。検証則:
- baseline の各 `condition_key` が結果セットに存在し、threshold/target/label/signal 等が **baseline と不一致でない**こと（＝既存条件は当日いじれない）。
- 差分は **新規 `condition_key` の追加のみ**許す。当日追加分どうしは同日中、追加・値変更・削除が自由（比較は常に baseline に対して行うので、自分が足した分は引っ込められるが baseline 未満にはできない）。
- combinator は当日変更不可（`AND→OR` 等の骨抜き防止）。

この検証は書き込みトランザクション内で適用後に再検証し、破れば ABORT する（`assertGoalsSatisfied` と同じ「適用後アサート」方式）。ブートストラップ（実効ルール皆無の真の初期状態）は従来どおり当日フル編集可のまま（守るべき baseline が無い）。

**帰結**: 当日のゲートは常に `baseline ⊆ 当日ゲート`。緩める方向は一切通らず、凍結ポリシーの目的を維持。既に当日 latch で UNLOCKED 済みなら、当日追加で条件が増えても `unlock_evaluation.first_met_at` の latch により再ロックされない（追加は懲罰的に働かない）。

### D3: 目標の開始日を選択式にする（既定=今日）

作成入力に `start = 'today' | 'tomorrow'`（既定 `today`）を足す。`start_day = today | nextDayKey(today)`、`end_day = start_day + 29`（30日固定は不変）。採用候補・採用検証・ラベルスナップショットは **`getEffectiveRuleSet(start_day)`** に対して行う（今日開始なら当日実効ルール＝D1 の当日追加を含む）。状態導出は既存（`today >= start_day` で `active`）でそのまま今日開始が「進行中 Day 1」になる。「削除は作成当日のみ」は `created day == today` 判定なので不変。

ジャンル固定 `assertGoalsSatisfied` のロック起点を `max(tomorrow, start_day)` から **`max(today, start_day)`** に広げる。今日開始目標は当日から残期間の実効ルールに採用 `condition_key` を要求する＝当日追加して採用した条件は同日でも削除・骨抜き不可（D2 の「自由編集」より採用ロックが優先）。採用中の時間条件の閾値変更に理由必須（`recordThresholdChanges`）も当日開始で当日から効く。

### D4: インライン条件（goal-inline-condition）の追記先を開始日で分岐

`newConditions`（その場作成の TIMELINE）は、目標の開始日の実効ルールへ追記する:
- 今日開始 → 当日ルール（D1 の `DRAFT_TODAY` 経路で materialize/追記）へ足し、`timeline:<ラベル>` を当日から採用。
- 明日開始 → 従来どおり翌日ルールへ追記。

作成と採用は一体トランザクション（途中失敗で目標も条件も作らない）を維持。

### D5: デモの振り返りは目標記録コーナーをプレビュー表示する

デモ入場直後（仮想「今日」が目標の開始前）でも、振り返りタブに各目標の記録コーナーの見え方を出す。仮想日付が目標期間内ならその日のサンプル日記を（従来どおり閲覧専用で）表示し、**期間外（開始前を含む）なら期間内の代表日のサンプル記録をプレビューとして読み取り専用で表示**する（「デモ入場直後は空表示」を解消）。デモ帯・日付ジャンプ・「開始前から物語を体験」という既存のデモ設計は据え置き、記録の見え方だけ確認可能にする。本番の振り返り挙動は不変。

## Risks / Trade-offs

- **[凍結 backstop の一部が app 層に移る]** `DRAFT_TODAY` はトリガ上は可変。→ 緩和は D2 の「適用後アサート（baseline 保存則）」をトランザクション内で強制。真に凍結された過去行は従来トリガでハードロックのまま。baseline の元 `FROZEN_ACTIVE/PAST` 行は materialize 後も残し、監査/修復のアンカーにする。
- **[当日既存行を開き直すケース]** 前日に「当日実効」として編集済みの `FROZEN_ACTIVE` 行を `DRAFT_TODAY` に戻す遷移が要る。→ status のみ UPDATE はトリガ許容。開き直し時の baseline はその行の現条件のスナップショット。
- **[freeze-on-read / rollover の分岐追加]** `ensureFrozenIfDue` は「当日の `DRAFT_TODAY` は凍結しない／`effective_date < today` の `DRAFT_TODAY` は凍結する」を判定する必要がある。→ 単純な日付比較で分岐。回帰は既存 112 テスト＋新規で担保。
- **[目標テーブル空・当日追加未使用時の不変性]** ジャンル固定/理由必須は goal が空なら no-op、`DRAFT_TODAY` 経路は当日追加を使わない限り発生しない。→ 既存挙動は完全不変（apply 時に回帰テストで確認）。
- **[採用ロックと自由編集の衝突]** 当日追加→同日採用した条件は「自由編集」から外れ、削除不可・閾値変更は理由必須になる。→ 仕様に明記（採用は意図的なロックイン）。

## Migration Plan

1. マイグレーション追加（additive）: 5 つの `rule_condition`/`daily_rule_set` トリガを drop→recreate し、可変判定を `status IN ('DRAFT_FUTURE','DRAFT_TODAY')` に緩める。既存行は無変更。`status` は TEXT・CHECK 無しなので値追加にスキーマ変更不要。
2. サーバー: `RuleStatus` に `DRAFT_TODAY`、当日 add-only パス（`upsertFutureRuleSet` の `effective_date==today` 分岐 or 専用関数）＋ baseline 保存アサート、`ensureFrozenIfDue`/rollover の `DRAFT_TODAY` 分岐、`goals.ts` の開始日選択・`start_day` 実効ルール検証・インライン追記先分岐、`assertGoalsSatisfied` のロック起点。
3. フロント: 目標作成 UI の開始日選択、ルールタブの当日追加動線（既存条件は当日ロック表示のまま）、デモ振り返りの記録プレビュー、デモシード調整。
4. ロールバック: トリガを旧定義へ戻す前に残存 `DRAFT_TODAY` 行を `FROZEN_ACTIVE` へ寄せる（当日追加を凍結扱いに確定）ワンショットが必要な点を手順に明記。

## Open Questions

- 当日ルール追加の UI 入口は「ルールタブの追加動線」と「目標作成のインライン作成」の2つで足りるか（今日タブ等からの導線は不要と判断）。
- デモの記録プレビューで見せる「代表日」はサンプルの好調日/谷の日どちらが体験上わかりやすいか（実装時にスクショで判断）。
