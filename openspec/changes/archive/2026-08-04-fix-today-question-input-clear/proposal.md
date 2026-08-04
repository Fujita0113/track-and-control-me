## Why

今日タブでロック中の目標の**質問ルール**に回答しているとき、入力途中で文言が消えるバグが報告されている（issue #83）。原因は `today.js` の 30 秒ごとのゲート再描画（`setInterval(refreshGate, 30000)`）で、質問回答欄（インライン `<input class="cond-answer">`）がフォーカス中かどうかに関係なく `clear()` で丸ごと作り直されるため。既存のスキップガードは「モーダルが開いているか」しか見ておらず、写真/質問ルールの回答欄はモーダルではなくゲート領域に直接置かれている（`goal-check-gate` の「今日タブから直接ルールに答える」）ため、このガードの対象外になっていた。

## What Changes

- ゲート領域の 30 秒自動更新中に、質問回答欄へ**未送信の入力があるとき**は、その回答欄を**再生成せず現状の値・フォーカスを保持**する。
- 対象は質問ルールの `<input class="cond-answer">` のみ（写真ルールはファイル選択欄で同種の被害が起きにくいため対象外）。
- 自動更新自体（30秒ポーリング）は変更しない。他の行（達成状況・パスワード表示等）は従来どおり最新化される。

## Capabilities

### New Capabilities
(なし)

### Modified Capabilities
- `goal-check-gate`: 「今日タブから直接ルールに答える」要件に、質問回答欄の未送信入力を自動更新が破棄してはならない旨を追加する。

## Impact

- `server/static/js/today.js`: `refreshGate` / `renderGate` / `condRow` / `ruleAnswerRow` 周辺。
- 既存 e2e（今日タブのゲート・質問回答まわり）への影響有無は design/tasks で確認する。
