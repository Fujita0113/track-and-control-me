## Context

ルールセットは日別で、`GET /api/rules/:date` は**明示ルールのみ**を返し（`getRuleSet`）、無ければ `{ ruleSet: null, conditions: [] }` を返す。実効ルールは「対象日に明示ルールが無ければ直近の過去ルールへフォールバック」で解決される（`getEffectiveRuleSet`）。`PUT /api/rules/:date` は当該日の条件を**全置換**する。

サーバのジャンル固定（`assertGoalsSatisfied`）は、進行中/開始前の各目標について残期間（`max(今日, start_day)`〜`end_day`）の各日の実効ルールを解決し、目標採用 `condition_key` が欠けていれば `GoalLockError` を投げる（設計どおり）。

現状 `rules.js` の「＋ ルールを作成」は、対象日（既存ルールがあれば翌日）の**明示ルール**を `api.getRule(target)` で取得し、無ければ空配列でエディタを開く。翌日には通常まだ明示ルールが無いため、エディタは既定 `TOTAL_WORK` 1件だけで開く。ユーザーが条件を1つ足して保存すると全置換 PUT が走り、翌日が今日から継承していた条件（目標採用の `planning:tomorrow_planned` / `timeline:掃除` 等）が消え、`GoalLockError` が発火する。これが issue #36 の実体（実DBで再現確認済み）。

## Goals / Non-Goals

**Goals:**
- 「条件を1つ追加しただけ」で継承条件（＝目標ジャンル固定条件を含む）が消えないようにする。
- 新規作成エディタの初期状態を、対象日の**現在の実効ルール**と一致させる。
- サーバ・API・既存の他フロー（明示ルール編集／当日追加）を変更しない。

**Non-Goals:**
- サーバのジャンル固定判定の変更（設計どおり正しい）。
- `GET /api/rules/:date` への実効ルール返却オプション追加（今回はクライアント側で解決するため不要）。
- タブグループ名の重複（「開発」が2件ある等）の是正 — 別issue。

## Decisions

### D1: 継承条件はクライアント側で `GET /api/rules` 一覧から解決する

「＋ ルールを作成」ハンドラは既に `api.getRules()`（全ルールセットを `effective_date DESC` で返す `listRuleSets`）を対象日決定に使っている。対象日に明示ルールが無い場合、この一覧から `effective_date < target` の最初の要素（＝直近の過去ルール）を取り、その `conditions` を初期条件に用いる。これはサーバの `getEffectiveRuleSet` のフォールバックと同一規則で、追加リクエストもサーバ改修も不要。

- 代替案: `GET /api/rules/:date?effective=1` を新設 → サーバ/契約変更が必要で過剰。今回は一覧で十分。
- 代替案: エディタ側で毎回継承を解決 → 「明示ルール編集」等は継承させたくないため、新規作成フローに限定する方が安全。

### D2: 明示ルールがある場合・真の初期状態は従来挙動を維持

対象日に明示ルール（`existing.ruleSet` が非 null）があればその条件を用いる。ルールセットが皆無（`getRules()` が空、対象=今日のブートストラップ）なら継承元が無いので空＋既定条件のまま。分岐は「明示ルール優先 → 無ければ継承 → それも無ければ空」の3段。

### D3: ロック表示は既存 `computeLocked` にそのまま乗る

継承条件は `condition_key` を保持したまま `openRuleEditor(target, conds, groups, reload, computeLocked(goals))` に渡す。`openRuleEditor` は `locked.keys.has(c.condition_key)` で各行のロック（種別/グループ/カテゴリ変更不可・削除不可、閾値は理由つき変更可）を描画するため、追加実装は不要。継承してきた目標採用条件は自動的に🔒表示になる。

## Risks / Trade-offs

- [継承条件が多いと初期エディタの行が増える] → これは正しい現在状態の反映。ユーザーは不要な継承条件を（ロックされていなければ）削除でき、全置換の意味が UI 上も明瞭になる。むしろ現状の「空で開く」方が誤操作を誘発していた。
- [`getRules()` の並び順に依存] → `listRuleSets` は `effective_date DESC` 固定。`find(r => r.ruleSet.effective_date < target)` で直近過去を安定取得できる（サーバのフォールバックと一致）。
- [対象日の実効ルールが当日の DRAFT_TODAY 追加分を含む場合] → 対象日は「翌日」であり、翌日の実効ルールは今日（当日追加分を含む実効条件）を継承する。`listRuleSets` は当日行（追加分込み）をそのまま返すため、継承にも追加分が反映され整合する。

## Migration Plan

- フロントのみの変更（`server/static/js/rules.js`）。デプロイは静的配信の更新で完結、DB マイグレーション不要。
- ロールバックは当該コミットの revert のみ。データ影響なし。

## Open Questions

- なし（挙動は既存フォールバック規則に一致させるだけで、仕様上の未決事項はない）。
