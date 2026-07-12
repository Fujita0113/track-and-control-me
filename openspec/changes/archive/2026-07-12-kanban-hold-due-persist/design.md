## Context

カンバンの期日は `computeDue()`（design D3）で列と「明日トグル」から自動決定される純関数で、`server/static/js/kanban.js` の複数経路で使われる:

- **作成時** (`createTask`): `due` を含めて `POST /api/tasks` で永続化 → 正しい。
- **手動指定** (`pickDue`) / **自動に戻す** (`resetDueAuto`): `PATCH /api/tasks/:id` で `due`(+`due_locked`) を永続化 → 正しい。
- **列間移動** (`onDrop`): `t.due = dec.due` で in-memory 更新するが、保存は `saveReorder()` → `POST /api/tasks/reorder` のみ。`reorderTasks`(server) は `status`/`sort_order`/`updated_at` だけを更新し **`due` を書かない**。

この結果、TODO(作成時 `due`=今日) を HOLD へ移すと画面は +7 日を表示するが DB は今日のまま。再読込で今日へ戻る（issue #30 の再現）。HOLD 作成タスクは `createTask` で +7 が保存済みのため影響を受けない。

## Goals / Non-Goals

**Goals:**
- 列移動で自動決定した `due` を確実に永続化し、再読込後も表示が一致する。
- 期日を変更しない移動では余計な書き込みを発生させない。

**Non-Goals:**
- `computeDue()` の決定規則そのものの変更（据え置き）。
- 並べ替え保存経路（`reorder` API / `reorderTasks`）のスキーマ変更。
- 既存の不整合データを一括是正するマイグレーション（次回移動時に自然是正されるため不要）。

## Decisions

### D1: `due` の永続化は既存の `PATCH /api/tasks/:id` を使う

`onDrop` の列間移動分岐で、`computeDue` が `change: true` を返し実際に `due` が変わった場合にのみ、`saveReorder` に加えて `api.updateTask(t.id, { due: t.due })` を呼ぶ。

- **理由**: `updateTask` は `due` 更新の実績経路（`pickDue`/`resetDueAuto` と同じ）。`reorder` API を拡張するより影響範囲が小さく、責務分離（reorder=並び順/状態、updateTask=フィールド）が保てる。
- **代替案**: `reorder` のボディに `due` を含め `reorderTasks` を拡張。→ API スキーマ(zod)・SQL・テストの変更が増え、状態遷移と期日更新が密結合になるため不採用。

### D2: 送信条件は「実際に変わったときだけ」

`if (!t.due_locked) { const dec = computeDue(...); if (dec.change) { t.due = dec.due; /* ここで保存対象とマーク */ } }`。`dec.change === false`（非HOLD→非HOLD、DONE）やロック済みでは `updateTask` を呼ばない。

- **理由**: 不要な PATCH を避け、既存挙動（据え置き）を保つ。DONE への移動は完了経路 (`completeTask`) が別途処理し、`computeDue` も `change:false` を返すため二重更新は起きない。

### D3: 保存の順序と失敗時の扱い

`saveReorder`（並び順）と `updateTask`（`due`）は独立フィールドのため順序依存はない。`updateTask` 失敗時は `pickDue` 同様に `toast` で通知する。`saveReorder` は失敗時に `reload()` する既存挙動を維持。

- **理由**: 既存のエラーハンドリング様式に合わせ、部分失敗でも UI と DB の乖離を最小化する。

## Risks / Trade-offs

- [列移動ごとに PATCH が1回増える] → 変更があった移動のみに限定するため増加は最小。ネットワーク往復は許容範囲。
- [`saveReorder` 成功・`updateTask` 失敗の部分失敗] → toast 通知し、次回移動や「自動に戻す」で是正可能。DB 破壊はない。
- [既存の不整合タスクは即時是正されない] → 一度でも列移動すれば正しい `due` が書かれる。ユーザー影響は軽微で、マイグレーションのコストを避ける判断。

## Migration Plan

- コード変更のみ。デプロイ後は列移動時に `due` が保存される。
- ロールバック: 変更を戻せば従来挙動（in-memory のみ）に戻る。データ破壊なし。

## Open Questions

- なし。
