## 1. バックエンド: バッチ再インデックス

- [x] 1.1 `server/src/services/tasks.ts` に `reorderTasks(order)` を実装（`order: Array<{ status, ids }>`）。1 トランザクション内で各 `ids[i]` に `sort_order = i` を設定し、`status` が指定と異なる場合は `status` も更新（DONE への変更は本関数の対象外とする）
- [x] 1.2 `createTask` を変更し、`sort_order` 未指定時は当該 `status` の `MAX(sort_order)+1`（無ければ 0）をサーバ側で採番
- [x] 1.3 `server/src/api/planning.ts` に `POST /api/tasks/reorder` ルートを追加。`reorderTasks` を呼び、`refreshPlanningStatus` + `runPipeline` を**1 回だけ**実行
- [x] 1.4 `reorder` ボディの入力検証（zod）を追加し、未知の id / 空配列 / 不正 status を弾く
- [x] 1.5 （任意）`CREATE INDEX idx_task_status_order ON task(status, sort_order)` をマイグレーションに追加

## 2. フロントエンド API クライアント

- [x] 2.1 `server/static/js/api.js` に `reorder(order)` メソッドを追加（`POST /api/tasks/reorder`）
- [x] 2.2 新規カード作成呼び出しが `sort_order` を送らずともサーバ末尾採番に依存する形であることを確認（必要なら調整）

## 3. フロントエンド: ドラッグ挿入位置の算出とインジケータ

- [x] 3.1 列 `dragover` ハンドラで `e.clientY` と各 `.kb-card`（ドラッグ中カードを除く）の垂直中点を比較し、挿入インデックスを算出するヘルパを追加
- [x] 3.2 挿入位置プレースホルダ要素（`.kb-drop-indicator`）を CSS クラスで定義（`server/static/css/app.css`、CSP 準拠のクラスベース）
- [x] 3.3 `dragover` 中にプレースホルダを **`renderAll` を使わず直接 DOM 操作**で該当位置へ挿入/移動。`preventDefault` を呼び drop を許可
- [x] 3.4 `dragend` / drop 時にプレースホルダと列ハイライトを確実に除去
- [x] 3.5 並べ替え可能列（HOLD/TODO/DOING）のみでインジケータを表示し、DONE 列では表示しない

## 4. フロントエンド: 並べ替え確定ロジック

- [x] 4.1 `onDrop` の `normStatus(t.status) === colKey` 早期リターンを撤去し、同一列時は算出インデックスへ `S.tasks` の列内順序を並べ替え → `renderAll` → `api.reorder`（当該列 1 件）で保存
- [x] 4.2 列間移動時は `status` 更新＋算出インデックス挿入 → `renderAll` → `api.reorder`（source/dest 2 列分の id 配列）で保存
- [x] 4.3 DONE へのドロップは従来の `completeTask` 経路を維持（並べ替え対象外）
- [x] 4.4 保存失敗時はエラー表示のうえ `loadTasks()` で再取得しサーバ状態へ収束（既存の失敗時パターンに倣う）
- [x] 4.5 ドラッグ操作ヒント文言（「列の移動はボードでカードをドラッグ」）を並べ替えにも触れる形へ更新

## 5. 検証

- [x] 5.1 未着手列で全 `sort_order=0` の既存カードを並べ替え、表示順を保ったまま連番へ正規化され永続化されることを確認（再読み込みで維持）
- [x] 5.2 同一列内でカードを上下に移動し、意図した位置に入ることを確認（同位置ドロップで破綻しないことも）
- [x] 5.3 別列の中間位置へ移動し、status 更新＋挿入位置反映＋両列の並び順永続化を確認
- [x] 5.4 新規カードが列末尾に追加され、`sort_order` が一意であることを確認
- [x] 5.5 完了列へのドロップが従来どおり完了演出＋アクティビティログ記録になることを確認
- [x] 5.6 ドラッグ中インジケータが追従し、drop/中止で消えること、ドラッグ中に描画崩れが起きないことを確認
- [x] 5.7 参照実装のトーン（クリーム背景・列見た目）が崩れていないことをスクリーンショットで目視確認
