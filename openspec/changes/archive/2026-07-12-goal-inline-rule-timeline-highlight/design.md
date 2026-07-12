## Context

`timeline-record-practice`（TIMELINE 条件・`timeline:<ラベル>` 安定キー・採用/レポート対応）により、自己申告の手動記録で習慣を30日チャレンジに乗せられるようになった。本変更はその実運用で出た2つの摩擦（issue #21 追加コメント）を解消する。

現状の関連実装:
- タイムライン（`static/js/timeline.js`）は MANUAL 記録を `tlc-block leisure` クラスのブロックで描画する。各ブロックは `categoryKey`（手動カテゴリの trim 名）を持つ。記録ポップオーバーはカテゴリチップを直近使用順（`GET /api/categories`）で出す。強調表示の仕組みは無い。
- 目標作成（`static/js/goals.js` → `POST /api/goals` → `services/goals.ts createGoal`）は、`adoptCandidates`（翌日=開始日の実効ルールに現存する条件）から選んで `condition_key` を採用するのみ。新規条件を作る導線が無く、`upsertFutureRuleSet`（未来ルールの作成/全置換）を先に別画面で叩く必要がある。
- ルール編集の凍結ポリシー: 未来日は編集可、当日/過去は凍結。`assertGoalsSatisfied`（採用中 `condition_key` が残期間で欠けないか）と閾値理由必須（`recordThresholdChanges`）が `upsertFutureRuleSet` 内で効く。

## Goals / Non-Goals

**Goals:**
- タイムライン画面で、目標が「追っている」自己申告カテゴリに一致する手動記録・カテゴリチップを、表示のみで強調する（評価・集計・解錠に非影響）。
- 目標作成画面から新規条件（初期は TIMELINE: カテゴリ＋分数）を作成し、開始日=翌日の未来ルールへ追記して同時に採用する。作成→採用を1操作に束ね、部分失敗で不整合を残さない。
- 既存の凍結・ジャンル固定・閾値理由必須ポリシーと整合させ、既存採用条件を壊さない。

**Non-Goals:**
- TIMELINE 以外のターゲット（TOTAL_WORK/GROUP/PLANNING）のインライン作成。今回は TIMELINE のみ。
- カテゴリの改名・統合 UI（カテゴリ名は `timeline:*` の安定キーを兼ねるため据え置き・`timeline-record-practice` の Non-Goal を継承）。
- 強調表示の色/スタイルの作り込み（クラス付与までを本変更で担保し、視覚細部は ref/ 突き合わせで調整）。
- 既存条件の閾値変更を目標作成画面から行うこと（作成は追記のみ。閾値変更は従来どおりルール編集）。

## Decisions

### D1: 「追っているカテゴリ」= アクティブ／開始前の目標が採用中の `timeline:<ラベル>` から導く
強調対象カテゴリ集合は、フロントで `GET /api/goals` を引き、`status` が `active` または `upcoming` の目標の実践のうち `conditionKey` が `timeline:` で始まるものを集め、**`conditionKey.slice('timeline:'.length)` をカテゴリ名**として集合化する。手動記録ブロックの `categoryKey`／ポップオーバーのチップ名がこの集合に含まれるとき強調する。

- 一致は `category_key` 文字列の完全一致（TIMELINE 評価と同じ規則）で一貫させる。表示用ラベルスナップショット（「掃除 15分以上」）ではなくキー接尾辞を使うのが確実。
- **代替案**: 実効ルールの全 TIMELINE 条件のラベルを対象 → 目標に採用していない条件まで光り、「追っている」の意図から過大。採用中に限定する。

### D2: 強調は表示専用（評価・集計・解錠に非影響）
強調は CSS クラス付与のみ（手動記録ブロックへ `tracked` 修飾、ポップオーバーのカテゴリチップへ `tracked` 修飾）。`manual-category-registry` の不変条件「カテゴリは表示ラベルで、集計・解錠には影響しない（TIMELINE 条件から参照された場合の評価を除く）」と整合する。強調自体は評価に一切波及しない。

### D3: インライン条件作成＋採用を `createGoal` の1トランザクションに束ねる
`createGoal` の入力に新規条件 `newConditions`（初期は `{target:'TIMELINE', label, thresholdSeconds}` のみ許容）を追加する。処理順:
1. 開始日=翌日の**実効ルールの条件を materialize**（明示ルールが無ければフォールバック条件を複製）し、そこへ `newConditions` を**追記**した条件配列で `upsertFutureRuleSet(翌日, ...)` を呼ぶ。既存条件は `condition_key`・閾値を据え置きで渡す（＝閾値変更が無いので理由不要、`assertGoalsSatisfied` も既存キーが残るので通る）。
2. 追記で生成された `condition_key`（`timeline:<ラベル>`）を採用リストへ足し、従来の採用検証・`goal_practice` 挿入を行う。
3. いずれかで失敗（凍結・ジャンル固定・理由必須・採用不整合）したら全体 rollback。目標も条件も作られない。

- **代替案A**: 条件作成用の別 API をクライアントが先に叩く → 条件だけできて目標作成が失敗する部分失敗が起きうる。1操作に束ねる方が安全。
- **代替案B**: `upsertFutureRuleSet` に「追記」専用モードを足す → 全置換モデルを崩す。既存条件を明示的に渡す materialize で足りるため不要。

### D4: API 形は `POST /api/goals` の入力拡張
`POST /api/goals` の body に `newConditions?: Array<{target:'TIMELINE'; label:string; thresholdSeconds:number}>` を追加する。サーバーは D3 の手順で条件を追記・採用する。作成された条件はレスポンスの `practices` に現れる。バリデーション: `label` 非空・`thresholdSeconds > 0`。TIMELINE 以外の `target` は 400。

### D5: UI（`goals.js` 作成フォーム）
候補チェックリストの下に「＋ 習慣を追加（タイムライン記録）」を置き、開くと**カテゴリ入力（`GET /api/categories` を datalist 補完・自由入力可）＋分数**を出す。追加した行は「これから作成」として一覧に並べ、作成時に `newConditions` へ積む。既存候補の採用（`practices`）と併用可能。カテゴリ名は保存時にレジストリへ upsert される（`upsertFutureRuleSet` の既存挙動）。

## Risks / Trade-offs

- **[翌日ルールの materialize による固定化]** フォールバック継承だった翌日が明示 DRAFT_FUTURE ルールになる → 以後その日は過去ルールの変更を継承しなくなる。→ 緩和: `newConditions` が空の通常作成では materialize しない（従来経路のまま）。内容は同一複製なので即時の挙動差は無い旨を spec に明記。
- **[凍結境界との競合]** 目標開始は常に翌日固定＝未来日なので `upsertFutureRuleSet` は編集可。当日ブートストラップ特例には触れない。→ 通常は問題にならない。
- **[自己申告の強調が「ズルの助長」に見える]** 強調は事実の可視化のみで罰・スコアを付けない（#9 方針）。→ 表示専用に限定。
- **[強調の一致規則ズレ]** 強調（`category_key` 完全一致）と TIMELINE 評価（同一規則）を同じにして齟齬を防ぐ。

## Migration Plan

- スキーマ変更なし（既存 `rule_condition` / `goal_practice` を再利用）。
- 後方互換: `newConditions` を送らない既存クライアント・既存目標は完全 no-op。強調は追跡カテゴリが無ければ何も光らない。
- 依存: `timeline-record-practice` が apply/archive 済みであること（TIMELINE 条件・採用が前提）。
- ロールバック: フロントの強調は表示のみで安全に外せる。`newConditions` 経路を止めても、作成済みの目標・条件は通常の TIMELINE 条件として機能し続ける。

## Open Questions

- 強調の視覚表現（枠線／バッジ／背景トーン）は ref/ 実装と突き合わせて決定（メモリ: reference-impl-in-ref-dir）。
- 複数目標が別ラベルを追う場合は全ラベルを強調（許容）。ラベルごとの色分けは今回はしない。
- 目標作成画面で「既存の同名 TIMELINE 条件」を再作成しようとした場合の扱い（重複追記の抑止 or 既存採用へ寄せる）は実装時に確定。
