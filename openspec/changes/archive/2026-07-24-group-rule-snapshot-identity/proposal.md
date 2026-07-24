## Why

解錠ルールの「グループ作業」条件が、ゲート画面で `グループ: 70d5118e-e7c2-467d-8097-73a500a5e9bf` のように生の UUID で表示され、何の条件かわからない（issue #59 前半）。

さらに深刻な事実として、その UUID（`stable_group_id`）自体が壊れている。実 DB を追ったところ、2週間で作られたタブグループ **116個**に対して発行された `stable_group_id` は **12個**しかなく、同じ瞬間に開いている別グループ同士が同一 ID を共有しているサンプルが **2062件**ある。`70d5118e…` 1本が `英語` / `Python` / `webエンジニアリング` / `面接` / `振り返り` / `アルゴリズム` / `競技プログラミング` / `開発` を飲み込んでいる。原因は拡張機能の identity フォールバック（`title + ' ' + color`）で、グループ新規作成直後は title が空文字のため `' pink'` `' blue'` という**色だけのキー**で無関係な既存グループの ID を継承していた。名前入力ダイアログで色を選び直すと色をまたいで伝染するため、全グループが数個の ID へ収束する。

結果として「競技プログラミングのグループを指定したはずのルールが、面接に費やした時間で達成される」（issue #59 後半）。ルール判定だけが今も壊れやすい `stable_group_id` に張り付いており、グループ別内訳・タイムライン・振り返りリボンが既に移行済みの「記録時点のスナップショット identity（名前＋色）」から取り残されている。

加えて、ユーザーの実運用では**タブグループの改名**が起こりうるが、現在は改名がどこにも伝播しないため、名前を変えた瞬間にルールが空振りする（名前ベースへ移行すると顕在化する）。

## What Changes

- **BREAKING（内部モデル）**: サーバーに**グループ identity レジストリ**（`group_identity` ＋ 別名表 `group_identity_alias`）を導入する。記録時点スナップショット `(名前, 色)` を identity へ解決し、以後の表示・ルール判定はこの identity を単位とする。
- 解錠ルールの `GROUP` 条件を `stable_group_id` 参照から **identity 参照**（`condition_key = 'group:<identityId>'`）へ移行する。評価は当該 identity の別名すべてに一致する `session.credited_ms` の合算で行う。
- ゲート画面（今日タブ）・ルール一覧・目標画面で、`GROUP` 条件を**グループ名（＋色チップ）**で表示する。UUID を利用者に見せない。あわせてゲート画面の `TIMELINE` 条件も「＜カテゴリ＞ ◯分以上 / 実績」を表示する。
- ルール編集・目標のインライン条件作成のグループ選択肢を、`tab_group` テーブル（壊れた UUID 行）ではなく**直近30日に実際に計測された identity（合計時間降順）**から出す。
- **タブグループの改名を検出**する。拡張機能が `tabGroups.onUpdated` の title/色変更をデバウンスして `GROUP_RENAMED` としてサーバーへ送り、サーバーは identity の現在名を更新し、旧名を別名として保持する。改名は未来ルール・当日ルール・目標の採用実践すべての参照先へ追随し、改名当日の旧名区間も別名として合算される（進捗バーが巻き戻らない）。
- グループ別内訳・タイムライン・振り返りリボンの表示名を、**別名チェーンを解決した現在名**にする（改名前の区間も新しい名前で表示する）。束ね単位も identity 単位になり、改名で断片化しない。
- 拡張機能の `stableGroupId` 採番を不変条件付きで固める: 空タイトルでは identity フォールバックを一切使わない／同一解決パス内で2グループへ同じ ID を与えない（検出したら再採番する）／マップ schema version を上げて汚染済みマップを強制クリアする。ビルド反映漏れを検出できるよう拡張のバージョンをサンプルへ載せ、サーバーが古いビルドを警告する。
- 既存データは書き換えない。過去のセッションは記録時点の `(名前, 色)` から identity へ解決する。旧 `group:<uuid>` 形式の凍結済みルール条件は従来経路のまま評価し、表示だけ名前解決＋「要再設定」ヒントを出す。

## Capabilities

### New Capabilities

- `group-identity-registry`: 記録時点スナップショット `(名前, 色)` をサーバー側の安定 identity へ解決するレジストリと別名表。表示・ルール判定・選択肢の共通の単位。
- `group-rule-identity`: 解錠ルール／目標実践の `GROUP` 条件を identity 参照にし、名前で表示・選択する。旧 `group:<uuid>` の後方互換。
- `tab-group-rename-tracking`: タブグループ改名の検出（拡張）と、identity の現在名更新・別名保持・ルール／目標／表示への追随。
- `extension-stable-group-id`: 拡張機能の `stableGroupId` 採番の不変条件（空タイトル identity 禁止・同一瞬間の重複禁止・汚染マップの強制再構築）。

### Modified Capabilities

- `today-group-breakdown`: 分類キーを「記録時点の `(名前, 色)` そのもの」から「その `(名前, 色)` が解決される identity」へ変更し、表示名は identity の現在名（別名解決後）とする。現在名の解決元が壊れた `tab_group` 行ではなくなるため、旧規定の「現在名でラベル解決してはならない」を差し替える。
- `timeline-run-view`: AUTO ブロックの束ね単位を identity（別名解決後）とし、ラベルを現在名にする。改名をまたいだ区間は分断せず1本のランとして扱う。
- `goal-challenge`: 実践の `condition_key` 列挙のうち `group:<stableGroupId>` を `group:<identityId>` に更新し、改名時にラベルスナップショットを追随させる。
- `goal-inline-condition`: インライン作成する `GROUP` 条件の入力を「既存グループの `stableGroupId`」から「identity（直近使用グループから選択／新規名）」へ変更する。

## Impact

- **DB**: 新テーブル `group_identity` / `group_identity_alias`、`rule_condition` に identity 参照列を追加（既存 `stable_group_id` 列は後方互換のため残す）。マイグレーションで既存 `session` の distinct `(名前, 色)` から identity を初期構築する。
- **サーバー**: `services/summary.ts`（内訳・`listGroups`）、`services/timeline.ts`、`services/day-allocation.ts`、`rules/evaluate.ts` の `GROUP` 分岐、`services/goals.ts`、`services/ingest.ts`／`recompute.ts`（identity 解決の呼び出し）、`api/index.ts`（直近グループ一覧・改名受信）。
- **拡張機能**: `extension/src/groups.ts`（採番の不変条件・改名検出）、`extension/src/sw.ts`（イベント配線・デバウンス）、`packages/contract`（`GROUP_RENAMED` イベント・payload 型）。**拡張の再ビルドとブラウザ側リロードが必須**（現在動いているのは修正前ビルドと推定される）。
- **UI**: `static/js/today.js`（条件表示）、`static/js/rules.js`（条件テキスト・グループピッカー）、`static/js/goals.js`（実践ラベル）、`static/js/timeline.js`・`state.js`（identity キー）。
- **デモモード**: `demo-seed.ts` の焼き込みデータに identity 行を追加し、`demo.test.ts` の期待値を更新する。
- **非対象**: `daily_totals_snapshot` の per-group 生データ、総作業時間の算入スコープ、divide-by-N 配分、日境界分割は変更しない。
