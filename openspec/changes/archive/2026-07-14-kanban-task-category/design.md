## Context

かんばんのタスク（`task`）は今カテゴリを持たない。実行の実体はブラウザ拡張が観測するタブグループで、`tab_group`（`stable_group_id`, `name`, `color`）に蓄積され `GET /api/groups` で取得できる。issue #27 は「かんばんのタスクをタブグループで分類し、後から見返す／いずれ長期目標レポートに載せる」ことを狙う。

タブグループの同一性はコードベースに2系統ある：
- **目標/ルールの GROUP 条件** … `group:<stable_group_id>`（UUID）で照合（`deriveConditionKey`）。
- **配分バー / today-group-breakdown**（issue #47） … `name + color`（`snapshotIdentityKey`）で束ねる。UUID振り直しでの分裂を避けるため。

UUID は Chrome の揮発 `groupId` を拡張が発番・記憶した写像（`chrome.storage.local` の `byGroupId` / `byIdentity`）に過ぎず、**永続でない**（再インストール・別PC・データ削除で振り直される）。一方 name+color は**名前や色の変更で分裂**する。既に `session` テーブルは `stable_group_id` ＋ `tab_group_name_snapshot` ＋ `group_color_snapshot` の両持ちでこの緊張を扱っている。

明日モードのトグルは `kanban.js` の `headerEl()` にあり、localStorage（`tcm_kanban_tomorrow`）でクライアント専用・日次リセットされる前例がある。

## Goals / Non-Goals

**Goals:**
- かんばんのタスクをタブグループ由来のカテゴリで分類できる（1タスク1カテゴリ、スキップ可）。
- カテゴリを付けた後にグループを削除・改名・改色しても表示と照合が壊れない保存方式にする。
- 将来アプリ独自色を導入する余地を、スキーマを縛らないことで残す。
- 集計・評価・目標追跡に一切波及させない（表示・保存レイヤに閉じる）。

**Non-Goals:**
- 目標30日レポートへのカテゴリ別タスク表示（別issue）。
- 追跡中目標のタスクのノスタルジック表示（別issue）。
- タイムラインエントリとタスクの明示的な紐付け（別issue）。
- タブグループの色を増やす／アプリ独自色の実装そのもの（別issue）。
- 目標追跡（`group:<uuid>`）の name+color 耐性化リファクタ（別issue、既存の未解決不整合として記録のみ）。

## Decisions

### D1: カテゴリは「UUID照合＋名前色スナップショット」の両持ちで保存（`session` と同型）

`task` に3列追加：
- `category_group_id TEXT NULL` … 照合キー。タブグループの `stable_group_id`。自由入力/その他は NULL。
- `category_name TEXT NULL` … 表示スナップショット（グループ名 or 手入力文字 or「その他」）。
- `category_color TEXT NULL` … 表示スナップショット。色を持たないカテゴリは NULL。

**なぜ**: UUID単独は再インストール・別PCで迷子になり、グループ削除で「名無しのUUID」になる。name+color単独は改名・改色で分裂する。両持ちなら、生きている間は UUID で正確に照合でき（将来の目標レポート統合が `group:<uuid>` に噛み合う）、グループ削除後もスナップショットで「これは競技プログラミング(青)のタスクだった」と表示できる。`session` が既に採る実績ある方式。

**代替案**: (a) UUIDのみ → 削除・別PCで表示不能。(b) name+colorのみ → 改名・改色で履歴が分裂、将来の目標(UUID)照合に変換層が必要。いずれも片側の弱点を埋められない。

### D2: color は制約なしの TEXT スナップショットとして保存

既存 `tab_group.color` / `group_color_snapshot` と同じく列挙型・CHECKで縛らない。`GroupColor`（zod enum・9色）はAPI/型レイヤの制約に留め、DBは緩いまま。

**なぜ**: Chromeのタブグループ色は本体固定で拡張から増やせないが、将来アプリ独自色を導入し得る。DBを縛らなければ後付けはマイグレーション不要で、緩めるのは zod 一箇所のみ。追加コストゼロで拡張の扉を開けておける。**照合には color を使わない**（照合はUUID）ため、将来色が可変になっても新機能のリンクは切れない。

### D3: 照合キーは UUID、name+color は「凍結された表示写真」に徹する

タスク付与時点の name/color を焼き込み、以後グループ側が改名・改色しても**書き換えない**（履歴として当時の見た目が正しい）。「今のグループと同一か」の判定は常に `category_group_id`（UUID）で行い、name+color を照合・dedup キーに使わない。

**なぜ**: name+color を照合キーにすると、将来色を可変にしたとき改色ごとに履歴が分裂する（#47 が配分バーで踏んだ病気の再発）。表示専用に隔離すればこの罠を回避できる。

### D4: モードトグルは明日モードと同じ localStorage・日次リセット方式

`headerEl()` に明日モードの隣へトグルを追加。状態は新しい localStorage キー（例 `tcm_kanban_categorize`）に `{date, on}` で保持し、日付が変わったら OFF。`app_config` には載せない。

**なぜ**: issue で「適度にオンオフしそう・明日モードではノイズ」との要望。前例(`tcm_kanban_tomorrow`)があり実装が最も軽い。サーバ設定は全端末永続で、こまめなオンオフには重い。

### D5: カテゴリ選択は作成後インライン・スキップ可

`commitComposer` でタスク作成後、モードONなら次の入力フォーカスの代わりに、作成タスク向けのカテゴリピッカーを同位置に出す。Esc/空Enterでスキップ（未分類）。IMEガードは既存 composer と同じ（`isComposing` / `keyCode 229`）。ピッカーの見た目は `timeline.js` の `openDraft` チップUIを参考にするが、**ソースは `/api/groups`**（`manual_category` ではない）。

**なぜ**: issue本文の操作像（Enter→次入力の位置がカテゴリ選択に置き換わる）そのまま。スキップ可で連続入力のテンポを壊さない。

### D6: 候補ソースは `GET /api/groups`（既知の全グループ・最近順）

「現在開いているグループ」を厳密に出すには kanban→サーバ→拡張のライブ状態(openGroupKeys)配線が新規に要り重い。既存 `listGroups`（`last_seen_at` 順）で「最近使ったグループ」を出せば計画用途に十分。

**なぜ**: 計画画面は「今この瞬間開いてるか」より「よく使うグループから選ぶ」が主。ライブ配線を足さず軽く実装できる。

## Risks / Trade-offs

- **[UUIDが別PC/再インストールで迷子]** → name+color スナップショットが表示を守る。目標レポート統合（別issue）で照合に使う際は、その時点でUUIDが引けない古いタスクの扱いを別途設計する。
- **[目標追跡が今も `group:<uuid>` のまま]** → 既存の未解決不整合。今回は触らず、タスク側を両持ちにして将来どちらにも寄せられる状態にする。別issueとして記録。
- **[`GET /api/groups` に大量の古いグループ]** → 最近順で上位を出し、候補数に上限を設ける（timeline チップの `MAX_CHIPS` 相当）。あふれは自由入力/「もっと見る」で拾う。
- **[color を縛らないことによる不正値混入]** → 表示専用でCSSクラス解決にフォールバック（未知色は中立色）。照合に使わないため機能破壊にはならない。

## Migration Plan

- 新マイグレーションで `task` に3列を `NULL` 許容で追加（既存行はカテゴリ無し＝従来挙動）。後方互換で追加のみ、破壊なし。
- ロールバックは列が使われないだけで既存機能に影響しない（`PATCHABLE`/POST から外せば書き込みも止まる）。

## Open Questions

- 候補数の上限値（timeline の `MAX_CHIPS=12` に合わせるか）。実装時に既存踏襲で決める。
- カード上バッジの位置（優先度/期日チップとの並び）。実装時に `ref/kanban` の見た目に合わせて調整。
