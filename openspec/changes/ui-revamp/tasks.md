## 1. バックエンド: スキーマ拡張と API

- [x] 1.1 `server/src/db/migrations.ts` に `reflections.satisfaction INTEGER NULL` を追加（後方互換・既存行は NULL）
- [x] 1.2 `server/src/db/migrations.ts` に `tasks.priority TEXT DEFAULT 'low'` / `tasks.due TEXT NULL` / `tasks.notes TEXT NULL` を追加
- [x] 1.3 `reflection` サービス/エンドポイントを satisfaction 対応に拡張（`PUT /api/reflection/{date}` が `{content, satisfaction}` を受理）
- [x] 1.4 `GET /api/reflections`（日付・満足度の一覧）を追加
- [x] 1.5 `tasks` サービス/エンドポイントを priority/due/notes 対応に拡張（作成・更新で受理、取得で返却）
- [x] 1.6 `server/src/services/planning.ts` の翌日タスク判定を `due`/`planned_for` の翌日一致で維持（PLANNING 契約不変）
- [x] 1.7 `npm test` / `npm run typecheck` が green（rules/aggregation/rollover/planning を壊さない）

## 2. 情報設計: タブ再編と「今日」ハブ (today-hub)

- [x] 2.1 `server/static/js/today.js` を新設し、旧 dashboard の総作業サマリ・グループ別ドーナツ・7日棒を移植（「除外内訳」カードは削除）
- [x] 2.2 旧 gate の解錠ヒーロー・条件進捗・パスワード解錠を `today.js` に統合
- [x] 2.3 MANUAL_CHECK 条件を条件進捗リストの行内チェックボックス化し `putCheck` を配線（旧 checks.js を吸収）
- [x] 2.4 翌日ルール編集セクションを `rules.js` 再利用で同居させる
- [x] 2.5 30秒リフレッシュをヒーロー/進捗領域のみに限定し、開いているモーダルを破棄しないガードを実装
- [x] 2.6 `index.html` のタブを 今日 / タイムライン / カンバン / 振り返り / 設定 の 5 つへ再編（ダッシュボード・ゲート・当日チェックの独立タブ/セクションを削除）
- [x] 2.7 `main.js` の `SCREENS` 登録を差し替え（today/timeline/kanban/reflection/settings）

## 3. オンボーディング (onboarding-initial-rules)

- [x] 3.1 起動時に「当日ルール無し かつ 未来ルール無し」を検出するロジックを追加（`getUnlock` の hasRuleSet と `getRules` で判定）
- [x] 3.2 条件成立時に初期ルール作成を促すモーダルを表示し、翌日ルール作成（`openRuleEditor`）へ誘導
- [x] 3.3 未来ルールが 1 つ以上あるときは表示しないことを確認

## 4. タイムライン全面刷新 (timeline-calendar)

- [x] 4.1 `timeline.js` を `ref/timeline/TabTimeline.dc.html` 準拠で縦型単一カラムに書き換え（時刻ガター・時間ライン・境界目盛り・現在時刻ライン）
- [x] 4.2 重なりブロックの列分割レイアウトを実装し、タイトル省略表示（ellipsis）と開始/終了の安定ソートで文字切れ・順序入替を解消
- [x] 4.3 AUTO=グループ色/白文字・手動/離席=グレー破線+「自己申告」バッジのスタイルを `app.css` に追加
- [x] 4.4 空きギャップのマウスドラッグ記録を実装（占有ブロック上は非発火、`yToMin`、30分グリッド＋近傍ブロック端への吸着、ドラッグゴースト表示）
- [x] 4.5 「離席として記録」ボタンを廃止
- [x] 4.6 ドラッグ確定ポップオーバー（開始/終了 time 入力・カテゴリチップ・自由メモ・追加/キャンセル）を実装し `api.addManual` へ保存
- [x] 4.7 微小ドラッグ（<10分）はクリック扱いに分岐、スクロール/クリックとの競合対策（stopPropagation・user-select:none）
- [x] 4.8 ブロッククリックの詳細ポップオーバー（時間帯・種別・削除）を実装

## 5. カンバン刷新 (kanban-board)

- [x] 5.1 `kanban.js` を planning から分離・新設し、列を 保留/未着手/進行中/完了 に再定義
- [x] 5.2 カード UI（優先度バッジ 高/中/低・期限ラベル・タイトル）を Cadence Board 準拠で実装
- [x] 5.3 HTML5 draggable による列間 D&D と状態更新（`updateTask`）を配線
- [x] 5.4 完了列ドロップで完了扱い→軽量祝福演出→当日アクティビティログ記録を実装（サウンドは設定トグルで既定 OFF）
- [x] 5.5 カード詳細（優先度セレクタ・期限ピッカー・Markdown ノート編集）を実装し保存
- [x] 5.6 当日進捗ドーナツ（完了/総数）とアクティビティログ（当日完了・新しい順）を実装
- [x] 5.7 翌日期限タスク登録で PLANNING の翌日タスク数が増えることを確認

## 6. 振り返り刷新 (reflection-journal)

- [x] 6.1 `reflection.js` を新設し、上部に満足度 5 段階（1〜5 選択）を実装
- [x] 6.2 下部に Markdown ライブプレビュー（自前・最小サブセット・HTML エスケープ）を実装、CDN 非依存
- [x] 6.3 保存で `{content, satisfaction}` を `putReflection` に送信
- [x] 6.4 過去振り返りの日付一覧（`GET /api/reflections`）→選択で該当日の満足度・本文を表示
- [x] 6.5 保存で PLANNING の reflectionDone が従来どおり真になることを確認

## 7. スタイルと運用メモ

- [x] 7.1 `app.css` を刷新（カレンダー/カンバン/満足度/ポップオーバー等のスタイル追加、Google Fonts は system-ui にフォールバック）
- [x] 7.2 設定画面/README に「オンデマンド起動は時間計測は約16時間分バッファで概ね可、04:00 ロールオーバー/凍結は常駐前提」の運用メモを追記

## 8. 検証 (E2E)

- [x] 8.1 `npm run server` E2E: タブが 今日/タイムライン/カンバン/振り返り/設定 の 5 つで、除外内訳・当日チェック独立タブが無い
- [x] 8.2 「今日」で総作業・ドーナツ・7日棒・解錠状態・条件進捗・手動チェックのインライン操作・パスワード解錠が動作
- [x] 8.3 ルール皆無状態で起動→初期ルールダイアログ表示→翌日ルール作成、以後は非表示
- [x] 8.4 タイムライン: 列分割で文字切れ/順序入替が無い、ギャップドラッグで 30 分吸着、ポップオーバーで時刻/タイトル確定、ブロック削除
- [x] 8.5 カンバン: 4 列 D&D、完了演出＋ログ、カード詳細（優先度/期限/ノート）保存、進捗ドーナツ、翌日タスクで PLANNING 充足
- [x] 8.6 振り返り: 満足度＋ライブプレビュー保存、過去日参照、reflectionDone 反映
- [x] 8.7 `npm test` / `npm run typecheck` green
