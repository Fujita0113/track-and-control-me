## Context

カンバンはローカル Fastify サーバが配信する素の JS SPA（`server/static/js/kanban.js`、Cadence Board の忠実移植）。タスクは REST + SQLite（`server/src/services/tasks.ts` → `task` テーブル）で永続化される。WebSocket/`packages/contract` はタブ活動の取り込み専用でタスクとは無関係。

現状の要点:
- `task` テーブルには `sort_order INTEGER NOT NULL DEFAULT 0` が**既に存在**し、`listTasks` は `ORDER BY status, sort_order, id` で取得している。
- `PATCH /api/tasks/:id` の `PATCHABLE` ホワイトリストは `sort_order` を**既に許可**。`createTask` も `sort_order` を受け付ける。
- しかしフロントは `sort_order` を一切送っておらず、全カードが `0`。結果、列内順序は実質「id 昇順（作成順）」に固定。
- DnD はライブラリ非依存の HTML5 ネイティブ。カード `dragstart` で `S.draggingId` を保持し、列 `dragover` は**列全体ハイライト**のみ、`onDrop` は**同一列を早期リターン**、列間移動は状態のみ更新して位置は成り行き（末尾）。
- 参照実装（`ref/kanban/Cadence Board.dc.html`）にも列内並べ替えは無く、流用不可。
- 各タスク書き込み（PATCH/POST）ごとに `refreshPlanningStatus` + `runPipeline` が走る。
- 完了列（DONE）は完了演出＋当日ログへアーカイブする特殊列で、常設カードを持たない。

制約: CSP `style-src 'self'`（インライン style 不可、クラスベース）。フロントにビルド工程・npm 依存なし。単一ユーザー・ローカル利用。

## Goals / Non-Goals

**Goals:**
- 保留・未着手・進行中の各列で、カードを同一列内ドラッグ&ドロップして任意位置へ並べ替えられる。
- 並び順を `sort_order` として堅牢・一意に永続化し、再読み込み後も保持する。
- ドラッグ中に挿入位置インジケータを表示し、どこへ入るか明確にする。
- 新規カードに末尾ランクを与え、`sort_order` 全 0 衝突を解消する。既存の未整列列を並べ替え時に正規化する。
- 列間移動もドロップ位置に応じた挿入インデックスへ配置する。

**Non-Goals:**
- タッチ/モバイルでの並べ替え（HTML5 DnD の制約。本アプリはデスクトップ companion）。
- 完了列（DONE）内の並べ替え（完了演出・アーカイブ専用のまま）。
- キーボード操作での並べ替え・アクセシビリティ強化（将来課題）。
- 参照実装の視覚仕様の変更（トーンは Cadence Board を維持し、インジケータのみ最小追加）。
- 複数クライアント同時編集の競合解決（単一ユーザー前提、楽観更新で十分）。

## Decisions

### 決定1: 順序表現は「列単位の連番再インデックス（contiguous integer）」

並べ替え確定時に、影響を受けた列のカードを表示順どおり `sort_order = 0,1,2,…` に振り直す。

- **なぜ**: 既存カードは全 `0` で、いずれにせよ初回に正規化が必要。連番再インデックスは正規化と並べ替えを同一操作で兼ね、順序が常に一意・決定的になる。カード数は個人利用で小規模（列あたり数十件）のため全書き換えコストは無視できる。
- **代替**: 分数/間隔ランク（隣接カードの中点を採番）。書き込み数は減るが、浮動小数の精度枯渇時に別途正規化が必要になり、全 0 初期状態の扱いも別途要る。小規模データでは複雑さに見合わないため不採用。

### 決定2: 一括再インデックス用のバッチエンドポイントを新設

`POST /api/tasks/reorder` を追加。ボディは影響列ごとの順序付き id 配列:

```
{ "order": [ { "status": "TODO", "ids": [12, 8, 3] }, { "status": "DOING", "ids": [5] } ] }
```

サーバは 1 トランザクション内で、各 `ids[i]` のタスクに `sort_order = i`（必要なら `status` も当該キーへ）を設定し、パイプライン再実行は**1 回だけ**行う。`server/src/services/tasks.ts` に `reorderTasks(order)` を実装し、`server/src/api/planning.ts` にルート追加。`server/static/js/api.js` に `reorder(order)` メソッド追加。

- **なぜ**: 再インデックスは複数カードに及ぶ。単発 `updateTask` を N 回呼ぶと HTTP N 往復・パイプライン N 回実行・部分失敗で不整合の恐れ。バッチなら atomic かつパイプライン 1 回。列間移動（source/dest 2 列）も 1 リクエストで一貫更新できる。
- **代替**: 既存 `updateTask(id,{sort_order})` を移動カードのみに使う。実装は最小だが、周囲カードの正規化ができず、全 0 初期状態を解消できない。単発フォールバックとしては可だが主経路にはしない。

### 決定3: DnD は HTML5 ネイティブ継続。中点ヒットテスト＋直接 DOM プレースホルダ

- 列 `dragover` で `e.clientY` と各 `.kb-card`（ドラッグ中カードを除く）の垂直中点を比較し挿入インデックスを算出。
- 挿入位置には専用プレースホルダ要素（`.kb-drop-indicator`、CSS クラスで表現）を **`renderAll` を使わず直接 DOM 挿入/移動**する。ドラッグ確定（drop）後に初めて `S.tasks` を更新し `renderAll`。
- **なぜ**: kanban.js の既存コメントどおり、HTML5 ドラッグ中に `renderAll` すると進行中ドラッグが壊れる。既存の列ハイライトも直接 DOM 操作で行っており、その流儀に合わせる。中点比較はライブラリ不要で参照実装のトーンを崩さない。
- **代替**: SortableJS 等の DnD ライブラリ導入。ビルド工程・npm 依存が無い方針に反し、CSP とも相性が悪いため不採用。

### 決定4: 同一列ドロップの早期リターンを挿入ロジックへ置換

`onDrop` の `if (!t || normStatus(t.status) === colKey) return;` を、同一列時は「算出インデックスへ `S.tasks` 内の順序を更新 → renderAll → `api.reorder` で当該列を保存」に置換。列間時は「status 更新 + 算出インデックス挿入 → renderAll → `api.reorder` で source/dest 2 列を保存」。DONE は従来の `completeTask` 経路を維持。

### 決定5: 新規カードの末尾ランクはサーバ側で採番

`createTask` で `sort_order` 未指定時、サーバが当該 `status` の `MAX(sort_order)+1`（無ければ 0）を採番する。

- **なぜ**: クライアントが列全体を走査せずとも末尾が保証され、atomic。全 0 衝突を作らない。フロントは `sort_order` を送らずとも正しく末尾に入る。
- **代替**: クライアントで `S.tasks` から列 max を計算し送信。動くが、正規化前の全 0 列では max=0 のため新規=1 となり既存 0 群の直後には来るが、複数新規作成の一意性はサーバ採番の方が堅牢。サーバ採番を主とする。

## Risks / Trade-offs

- **HTML5 ドラッグ中の再描画でドラッグが壊れる** → プレースホルダはすべて直接 DOM 操作。`S.tasks` 更新と `renderAll` は drop 後のみ。`dragover` で `preventDefault` を必ず呼び drop を許可。
- **PATCH/reorder ごとに planning パイプラインが走る** → バッチ `reorder` でパイプライン実行を 1 回に集約。`sort_order` は `planned_for`/`due`/status ベースの planning シグナルに影響しない（並べ替え自体は planning を変えない）。
- **楽観更新後にサーバ保存が失敗** → 保存失敗時はエラー表示のうえ `loadTasks()` で再取得してサーバ状態へ収束（既存の失敗時パターンに倣う）。単一ユーザーで競合はほぼ発生しない。
- **正規化により多数カードの `updated_at` が更新される** → 並べ替えは意図的な変更操作であり許容。`updated_at` を並べ替えで更新しない選択も可能だが、まずは通常更新扱いにして単純化。
- **タッチ環境で並べ替え不可** → Non-goal として明示。デスクトップ利用前提。
- **列間移動で source/dest の両方を送り忘れる** → `reorder` は渡された列のみ再インデックスする契約。フロントは移動時に必ず 2 列分の id 配列を構築するユニットで担保。

## Migration Plan

- **DB マイグレーション不要**（`sort_order` は v1 から存在）。データ移行なし。
- 既存の全 0 データは、各列の**初回並べ替え時に連番へ遅延正規化**される（決定1）。一括バックフィルは不要だが、必要なら起動時に列単位で一度だけ `reorderTasks` を流すワンショットも可能（任意）。
- 任意の最適化として `CREATE INDEX idx_task_status_order ON task(status, sort_order)` を追加してよい（並べ替えの正しさには不要、読み取り最適化のみ）。
- ロールバック: フロントの DnD 変更を戻せば挙動は従来（列移動のみ）に戻る。`sort_order` 値が非 0 でも `ORDER BY status, sort_order, id` は従来と矛盾しないため、サーバ側の巻き戻しは不要。

## Open Questions

- `reorder` を新設せず、まず単発 `updateTask` フォールバックだけで MVP を出すか？（本設計はバッチ主経路を推奨。実装コスト次第で段階導入可。）
- 起動時ワンショット正規化を入れるか、遅延正規化のみにするか（既定は遅延のみ）。
- 並べ替えで `updated_at` を更新すべきか（既定は更新する。タイムライン/振り返り表示に影響が出るなら再検討）。
