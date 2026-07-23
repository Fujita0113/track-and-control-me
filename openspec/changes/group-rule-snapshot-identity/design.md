## Context

現状のグループ同一性は3層に分裂している。

1. **拡張機能の `stableGroupId`**（`chrome.storage` の UUID）: 揮発的な chrome `groupId` を安定化する目的で導入されたが、identity フォールバック `title + ' ' + color` が**空タイトルにも適用される**ため、新規グループ作成直後（title=`''`）に `' pink'` `' blue'` という色だけのキーで無関係な既存グループの ID を継承する。実 DB では 116 グループ → 12 UUID に収束し、同一瞬間に開いている別グループが同じ ID を共有するサンプルが 2062 件ある。修正コミット（`7b0f943`）は入っているが、7/22 に作られたグループが空タイトル時点で既存 UUID を継承しているため、**ブラウザで動いているのは修正前ビルド**と推定される。
2. **表示系のスナップショット identity**（`tab_group_name_snapshot` + `group_color_snapshot`）: グループ別内訳（`today-group-breakdown`）・タイムライン（`timeline-run-view`）・振り返りリボン・配分バーは既にこちらへ移行済みで、壊れた `stable_group_id` を回避している。
3. **ルール評価**: `rule_condition.stable_group_id` と `daily_totals_snapshot` の `stable_group_id` 単位。**1 のバグをそのまま被る**唯一の経路で、issue #59 後半（競技プログラミング用ルールが面接の時間で解錠される）はここで起きている。

さらに 2 は「記録時点の名前」を分類キーそのものにしているため、**改名すると同じグループが別スライスへ分裂する**。ユーザーは改名を追随させたい（改名前の区間も新しい名前でまとめて表示し、ルール判定も合算する）と決めた。

制約:

- ローカル完結・単独開発・SQLite（better-sqlite3）・マイグレーションは `server/src/db/migrations.ts` の連番方式。
- `daily_totals_snapshot` の per-group 生データ、総作業時間、divide-by-N 配分、日境界分割は**変更しない**。
- 凍結済み（過去・当日）のルールセットは条件の追加削除・閾値変更をしてはならない（`same-day-rule-additions` の既存規定）。

## Goals / Non-Goals

**Goals:**

- ルール・目標・表示のすべてが**同一のグループ同一性**を使い、内訳の数字とルールの進捗が必ず一致する。
- 利用者に UUID を見せない。条件は常にグループ名（＋色）で表示・選択する。
- 改名がルール・目標・表示へ追随し、改名当日の進捗が巻き戻らない。
- 拡張機能の採番バグを不変条件（テスト可能な形）で閉じ、汚染済みマップを強制再構築する。
- 過去データを書き換えずに、過去分も正しい単位で読み直せる。

**Non-Goals:**

- 壊れた `stable_group_id` に基づく**過去の集計値の遡及修正**（`daily_totals_snapshot` の書き換え）は行わない。過去の解錠判定（`unlock_evaluation` の確定行）も再評価しない。
- 拡張機能側で過去の誤 ID を再構成すること（storage は破棄して作り直す）。
- グループの手動マージ UI（別グループを利用者が明示的に束ねる操作）。今回は改名検出による自動別名のみ。

## Decisions

### D1. サーバー側に identity レジストリを置く（拡張の UUID には依存しない）

`group_identity`（現在名・現在色・作成/最終観測時刻）と `group_identity_alias`（`(name, color)` → identity）の2表を新設する。

- 記録時点スナップショット `(name, color)` は **必ず**別名表を経由して identity へ解決する。未知の組は identity を新規作成し、その組を別名として登録する。
- ルール条件・目標実践は identity の**内部 ID**（INTEGER）を参照し、`condition_key = 'group:<identityId>'` とする。
- 表示名は常に identity の**現在名**。

**なぜ拡張の `stableGroupId` を主キーにしないか**: 揮発的な chrome `groupId` を跨いだ同一性の維持は本質的に推測であり、実際に壊れた。`(name, color)` は利用者が意図的に付けた識別で、`session` に不変のスナップショットとして既に残っている。サーバー側で解決すれば、拡張のバグ・再インストール・別プロファイルに耐える。

**なぜ `condition_key` に名前を埋め込まない（`group:<color>:<name>` にしない）か**: 改名のたびに `rule_condition` / `goal_practice` / `daily_check` / `unlock_evaluation.per_condition_results` / `practice_threshold_change` に散らばったキー文字列を書き換える必要が生じ、破綻しやすい。内部 ID なら改名は `group_identity.name` の 1 行更新で済む。

**代替案**: 表示だけ名前解決して評価は `stable_group_id` のまま → issue #59 後半（意味のすり替わり）が残るため却下。

### D2. `GROUP` 条件の評価は identity の別名すべてに一致する `session` の合算

```sql
SELECT COALESCE(SUM(credited_ms), 0) FROM session
 WHERE day_key = ?
   AND (tab_group_name_snapshot, COALESCE(group_color_snapshot,'')) IN (<identity の別名集合>)
```

- `session.credited_ms` は divide-by-N 適用後の持ち分で、`today-group-breakdown` が内訳に使っているのと同じ源泉。したがって**内訳の数字とゲートの進捗が定義上一致**する。
- `daily_totals_snapshot` は権威データとして従来どおり書き続ける（レポート・過去日の再現に使う）が、`GROUP` 条件の判定源泉ではなくなる。

**代替案**: `daily_totals_snapshot` に identity 列を足して集計し直す → 過去分の再計算が必要で、壊れた ID からは復元できないため却下。

### D3. 改名検出は拡張側でデバウンスして 1 イベントにまとめる

- `groups.ts` のマップに `byGroupId` の値として `{ stableId, title, color }` を持たせ、`tabGroups.onUpdated` で**直前の title/color** と比較する。
- 判定: 直前 title が**非空**で、新 title も非空、かつ両者が異なる → 改名候補。直前 title が空（＝新規グループへの命名）は改名として扱わない。
- 名前入力は 1 文字ずつ `onUpdated` を発火させる（実測: `せ` → `せっけ` → … → `設計理解`）。**静止 5 秒**のデバウンスを掛け、確定後の `(oldTitle, oldColor) → (newTitle, newColor)` を 1 件だけ送る。デバウンス中に SW が停止しうるため、保留中の改名は `chrome.storage` に置き、`chrome.alarms`（最小粒度 30 秒ではなく `setTimeout` + 次回ウェイク時のフラッシュ）で確実に送出する。
- 送出は既存 WS の新メッセージ `{ type: 'groupRename', rename: {...} }`。`ActivitySample` に混ぜない（サンプルは区間化の入力であり、意味の異なる制御イベントを混入させない）。イベント種別 `GROUP_RENAMED` は `EventTypeSchema` へ追加し、サンプル側は従来どおり `GROUP_UPDATED` で流す。

**代替案**: サーバー側で「同じ `stable_group_id` の名前が変わった」ことから推測する → 壊れた `stable_group_id` に依存するため却下。

### D4. 改名の適用範囲

サーバーが `groupRename` を受けたとき、旧 `(name,color)` の identity `I` に対して:

1. `I.name/color` を新しい値へ更新する（現在名の変更）。
2. 旧 `(name,color)` は `group_identity_alias` に残す（過去の session が引き続き `I` へ解決される）。
3. 新 `(name,color)` を `I` の別名として登録する。
4. 新 `(name,color)` が**別の identity `J` に既に属していた**場合はマージする。`created_at` が古い方を残し、もう一方の別名・参照（`rule_condition` / `goal_practice`）を残す側へ付け替え、消える側は削除する。マージは 1 トランザクション。
5. `goal_practice.label_snapshot`（採用時の表示名スナップショット）を新名へ更新する。

ルール側は identity ID 参照なので**書き換え不要**（未来ルール・当日ルール・凍結済みルールすべてが自動的に新名で表示・判定される）。「凍結済みルールを変えない」制約は、条件の集合・閾値を変えないことを意味しており、参照先グループの表示名が変わるのは違反しない。

改名当日の旧名区間は 2 により同じ identity に解決されるため、D2 の合算に含まれる（進捗が巻き戻らない）。

### D5. 表示（内訳・タイムライン）は identity 単位・現在名

- `snapshotIdentityKey(stableGroupId, name, color)`（`summary.ts`）を「`(name,color)` → identity ID」の解決へ置き換える。未グループ（`UNGROUPED_KEY`）は従来どおり単一キーへ集約する。
- 表示名・色は identity の現在値。改名前の区間も新名で表示され、束ねも 1 本になる。
- これは `today-group-breakdown` / `timeline-run-view` の「現在の `tab_group` 行の名前でラベル解決してはならない」という既存規定と衝突するため、両スペックを改訂する。旧規定は**壊れた `tab_group` 行に引きずられること**を防ぐためのもので、identity レジストリは同じ問題を持たない（現在名は改名イベントでのみ動く）。

### D6. 選択肢は「直近30日に実測された identity」

`GET /api/groups/recent?days=30` を追加し、`session` を identity 単位で集計して合計時間降順に返す（名前・色・合計秒・最終観測日）。**合計 60 秒未満の identity は除外**する（名前入力途中の文字列がノイズとして混じるため）。ルール編集・目標インライン作成の両方がこの一覧を使う。`GET /api/groups`（`tab_group` 由来）は後方互換のため残すが、UI からは使わない。

### D7. 拡張機能の採番を不変条件で固める

1. 空タイトルのとき identity フォールバックを**引かない・書かない**（現行コードで実装済み。テストで固定する）。
2. **同一解決パス内で 2 グループが同じ `stableGroupId` を持ってはならない**。`gatherState` は解決後に重複を検査し、衝突したグループには新しい UUID を再採番して `byGroupId` を上書きする（後勝ちではなく、`groupId` が小さい方＝先に観測された方を維持）。この不変条件は「今回の根本原因を二度と再発させない」ための最後の砦であり、単体テストで固定する。
3. `GROUP_MAP_SCHEMA_VERSION` を 3 へ上げ、汚染済みの `byGroupId` / `byIdentity` を強制クリアする。
4. `manifest.json` の `version` を上げ、サーバーは受信した `extVersion` が既知の最小版未満なら**ダッシュボードに警告バナー**を出す（「拡張機能が古いビルドです。再読み込みしてください」）。今回の「修正済みなのに動いていない」を再発させないための可視化。

### D8. 後方互換（旧 `group:<uuid>` 条件）

- `rule_condition` に `group_identity_id INTEGER` を追加する。既存行は `NULL` のまま、`stable_group_id` が残る。
- 評価: `group_identity_id` があれば D2、無ければ従来の `daily_totals_snapshot` 合算（＝過去の判定を変えない）。
- 表示: 旧条件は `tab_group` の名前で解決し、末尾に「（要再設定）」を添える。UUID は表示しない（解決できない場合は「不明なグループ（要再設定）」）。
- 新規作成・編集経路は必ず `group_identity_id` を書く。実 DB に存在する旧 `GROUP` 条件は 1 件（`2026-07-15` の凍結済み）のみで、これは履歴として保存する。

## Risks / Trade-offs

- **[名前が空のグループ]** 無題グループの `(‘’, color)` が identity 化されると意味のない行が増える → 空名は identity を作らず、従来どおり `UNGROUPED_KEY` とは別の「無題」扱いで内訳にのみ出す。ルールの選択肢（D6）にも出さない。
- **[改名の誤検出]** 利用者が「別の作業をするために名前を丸ごと書き換えた」場合、意味的には別グループなのに同一 identity に合流する → 今回はユーザーの明示希望（改名は追随・過去表示も新名）に従う。将来必要なら改名時に「別グループとして扱う」選択肢を UI で出せるよう、`group_identity_alias` に `since` を持たせて分割できる形にしておく。
- **[デバウンス中の SW 停止]** MV3 の SW は約 30 秒で停止するため `setTimeout` が飛ぶ → 保留状態を `chrome.storage` に永続し、次のウェイク（ハートビート含む）でフラッシュする。最悪でも 30 秒遅れで送出される。
- **[マージの巻き戻し不能]** identity マージは非可逆 → マージは改名イベント由来のみに限定し、マージ内容を `activity`（サーバーログ）に残す。
- **[過去の内訳の見え方が変わる]** 改名を追随するため、過去日の内訳ラベルが新名になる（ユーザーの明示選択）→ 過去の `session` の生データは不変なので、必要になれば表示規則の切り戻しで復元できる。
- **[拡張のリロード漏れ]** 実装しても反映されなければ何も直らない → D7-4 の警告バナーと、`docs` ではなく実際の手順（`npm run build:ext` → `edge://extensions` で再読み込み）を tasks に明記し、デモではなく実 DB の新規グループで採番が分離することを確認する。

## Migration Plan

1. マイグレーション（新版）で `group_identity` / `group_identity_alias` / `rule_condition.group_identity_id` を作成する。
2. 同マイグレーション内で、既存 `session` の distinct `(tab_group_name_snapshot, group_color_snapshot)`（空名・`ungrouped` を除く）から identity を初期構築する。この時点では別名は 1 identity につき 1 組（改名履歴は不明なので推測しない）。
3. 既存の `GROUP` ルール条件は変換しない（D8 の後方互換経路で評価・表示）。
4. 拡張機能をビルドし直し、ブラウザで再読み込みする（`GROUP_MAP_SCHEMA_VERSION=3` により storage マップは自動クリア）。
5. ロールバック: マイグレーションは追加のみ（既存列・既存テーブルを破壊しない）。UI とサーバーの参照先を戻せば旧挙動へ復帰できる。

## Open Questions

- 無題グループ（title=`''`）を内訳でどう見せるか（現行は空ラベル）。今回は挙動を変えないが、`(‘’, color)` が増えるようなら別途整理する。
- 改名の「別グループとして扱う」選択 UI は将来課題（`since` を持つことで実装可能にはしておく）。
