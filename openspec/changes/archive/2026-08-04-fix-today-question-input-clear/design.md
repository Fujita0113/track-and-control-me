## Context

`server/static/js/today.js` の `show()` は、ゲート領域（`gateRegion`）を初回描画後 `setInterval(refreshGate, 30000)` で30秒ごとに再描画する（`today.js:65`）。`refreshGate` は「モーダルが開いていればスキップ」という未保存入力保護を持つ（`today.js:60-63`）が、質問ルールの回答欄（`ruleAnswerRow` が作る `<input class="cond-answer">`、`today.js:343`）はモーダルではなく `gateRegion` に直接置かれているため保護の対象外。`renderGate`（`today.js:148`）は `clear(region)`（`today.js:154`、中身は `util.js` の `removeChild` ループ）で子要素を全部破棄してから作り直すため、フォーカス中の回答欄も含め毎回**新規 `<input>`** が生成される（value 保持の仕組みが無い）。結果、質問に入力中でも30秒経過すると入力が消える（issue #83）。

`condRow`/`ruleAnswerRow` は `unlock.perCondition` の各要素 `c` に対して呼ばれ、`c.ruleId` で対象ルールを一意に識別できる（写真提出 `api.submitRulePhoto(c.ruleId, ...)` と同じ識別子）。

## Goals / Non-Goals

**Goals:**
- 質問ルールの回答欄に未送信の入力がある状態で30秒自動更新が走っても、入力中の値とフォーカス（カーソル位置含む）を保持する。
- 30秒自動更新そのものは維持し、他の行（達成状況・パスワード表示・解錠ヒーロー等）は従来どおり最新化する。

**Non-Goals:**
- 写真回答欄（`<input type="file">`）の状態保持（ファイル選択欄は選択後即送信のフローで、同種の被害が起きにくいため対象外）。
- ゲート領域全体を差分更新（仮想DOM化）する汎用的な仕組みの導入。今回は質問回答欄のみのピンポイント対応とする。
- モーダル側の保護ロジックの変更。
- vitest でのカバレッジ追加。`server/static/js` は `vitest.config.ts` の対象外（extension のブラウザ実行時依存コードと同様の理由でスコープ外）で、今回の変更にサービス層/APIの変更もないため、検証は既存 e2e の確認と apply 時の新規 e2e に委ねる。

## Decisions

**「未送信入力のスナップショット→再描画後に復元」方式を採用する（DOM全体の差分更新はしない）。**

`renderGate` 内で `clear(region)` の直前に、既存の `.cond-answer` 入力欄のうち値が非空のものを `ruleId → { value, focused, selectionStart, selectionEnd }` の Map として退避する。再描画後（新しい `<input>` を生成する `ruleAnswerRow` 内）で、同じ `ruleId` に退避値があれば `input.value` に復元し、`focused` だったものは region を DOM に反映した後に `input.focus()` + `setSelectionRange` でカーソル位置も戻す。

代替案として検討したが不採用:
- **A. 質問回答欄がある間は `refreshGate` 自体をスキップ（モーダル判定と同じパターンを流用）**: 実装は最も単純だが、達成状況やパスワード表示など他の行の最新化も止めてしまう。ゲートは他ユーザー操作（例: 別の条件がその間に外部から満たされる等）を反映する場であり、「質問欄が1つ空いているだけで全体が固まる」のは体験として退化になるため不採用。
- **B. `renderGate` を差分パッチ方式（既存ノードを条件ごとに再利用し、変更があった行だけ更新）に全面書き換え**: 恒久的には筋が良いが、`condRow` 全体（写真/チェックボックス/時間型など）の構造を洗い直す必要がありスコープが今回のバグ修正を大きく超える。将来的な改修候補として `## Open Questions` に残す。
- **C. `<input>` に `autocomplete`/`form` を使いブラウザのフォーム復元に任せる**: JS で毎回ノードを作り直す限りブラウザの入力復元は効かず、根本解決にならない。

値の退避キーは `c.conditionKey`（`rule:<id>` 形式、既存の安定キー）ではなく `c.ruleId` を使う。`ruleAnswerRow` が既に `c.ruleId` をそのまま API 呼び出しに使っており、対応関係を追加で調べる必要がないため。

フォーカス復元は「退避した要素が `document.activeElement` だった場合のみ」行う。ユーザーがブラー済み（他要素をクリック済み）の場合にまで奪還すると別のフォーカス操作を妨害するため。

## Risks / Trade-offs

- [Risk] 復元処理を `ruleAnswerRow` 内に埋め込むと、通常の初回描画（`show()` 冒頭の `refreshGate()` 呼び出し）でも退避 Map の参照が必要になり実装が煩雑化する → Mitigation: 退避 Map は `renderGate` のローカル変数とし、無ければ空 Map として渡す。`ruleAnswerRow` 側は「退避値があれば使う、無ければ何もしない」の分岐のみで済むようにする。
- [Risk] `selectionStart`/`selectionEnd` の復元はブラウザ依存の挙動差がある → Mitigation: 失敗しても致命的ではない（value 自体は復元されるので最悪カーソル位置だけ末尾に戻る）。try/catch で握りつぶす。
- [Risk] 退避→復元の間に該当ルールが他経路（例:別タブ操作や他条件充足の結果）で `met=true` になっていた場合、`ruleAnswerRow` は `met` 行に切り替わり `<input>` 自体を描画しなくなる（`today.js:316` `if (met) return row;`）→ 退避した入力は自然に破棄される。これは意図した挙動（回答欄が無くなるのは正しい）なので対処不要。

## Open Questions

- ゲート領域の再描画を汎用的な差分更新に置き換えるかどうかは、今回のスコープ外として保留する（上記代替案B）。
