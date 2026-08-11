## Context

独立カンバンタブの現行レイアウトは `kb-main`（`kb-board-scroll` + `kb-aside`、幅340px固定のフレックス子要素）。`asideEl()` は、`S.detailId` が立っているときは `kb-aside` の中身を `detailEl(t)` に**差し替え**、立っていないときは進捗リング（`progressEl`）とログ（`logEl`）を表示する（`server/static/js/kanban.js:1316`）。つまり detail は常設サイドバー領域の中身が入れ替わる形で表示されており、専有面積は常に340px幅に制約される。

同じ `detailEl(t)` は、明日の計画（reflection画面の右サイドバー・タブ切替）へ `asideHost.detail` 経由で埋め込まれる別経路もある（`renderAsideInto`, `kanban.js:328`）。オーバーレイ化（表示位置・スクリム）はこちらスコープ外（[[opsx:propose の確認で独立カンバンタブのみに決定]]）。ただし後述のフッターボタン撤去は `detailEl(t)` 自体の変更なので、埋め込み側にも及ぶ。

**追記（issue #92 コメント、2026-08-11）**: 実装後にissue作成者から「タスクを削除・このタスクを分解する、の2ボタンを消してテキスト欄を広く使いたい」「サイドバーを覗かせず右端まで広げてほしい」「モーダルではなく単に覆いかぶさっているだけのUIにしてほしい」と追加要望があり、本ドキュメントは当初案から以下を変更している:
- サイドバー（進捗リング・ログ）を背後に覗かせる `padding-right: 340px` は撤回し、パネルは右端まで隙間なく拡張する。
- 詳細パネルのフッター（「タスクを削除」「このタスクを分解する」）を撤去する。分解機能はいったんカンバンから完全に撤去（バックエンドAPI・vitestは維持）。

## Goals / Non-Goals

**Goals:**
- 独立カンバンタブでカードを開いたとき、detail パネルを画面の約6割・右端まで隙間なく占有するオーバーレイとして表示する。中央寄せの「モーダル」ではなく、画面の一部にただ覆いかぶさっているだけの平板なUI（角丸なし）にする。
- オーバーレイ表示中、パネル外側の余白（スクリム）をクリックすると閉じる。
- 既存の閉じる手段（✕ボタン）、既存のクラス名（`kb-detail`, `kb-detail-close`, `kb-detail-body` 等）を変えず、e2e への影響を最小化する。
- 詳細パネルのフッターから「タスクを削除」「このタスクを分解する」ボタンを撤去し、ノート編集欄（テキスト欄）が占める視覚的な割合を広げる。

**Non-Goals:**
- 明日の計画（reflection画面埋め込み）の detail の**表示位置**（オーバーレイ化）は変更しない。ただしフッターボタン撤去は共有関数の変更として埋め込み側にも及ぶ（Non-Goal は位置決め・スクリムのみ）。
- Esc キーでの close や、新規キーボードショートカットの追加は行わない（issue #92 で要求されていない）。
- モバイル/狭幅時のレイアウトを新設計する（既存の1100pxブレークポイントの扱いを踏襲する）。
- 削除・分解機能の代替導線（カード上の別ボタン等）を新設しない。削除は既存のカード上ゴミ箱アイコン・右クリックで足りる。分解はいったん機能ごとカンバンから外し、必要になれば別issueで置き場所を再検討する。

## Decisions

### D1: `kb-aside` の中身入れ替えをやめ、detail は別レイヤーのオーバーレイにする
現状の `asideEl()` は detail 開時に中身を差し替えているが、これをやめて `kb-aside` は常に進捗＋ログを表示する。detail は `kb-main` の外（`page` 直下）に新規要素 `kb-detail-overlay`（スクリム＋パネルのラッパー）として条件付きで追加する。
- 理由: サイドバー幅（340px）に縛られずにパネル幅を独立して制御できる。GitHub の Issue 詳細と同様、背景（ボード＋既存サイドバー）を暗くしつつ全体の上に浮かせる構造に一致する。
- 代替案: `kb-aside` 自体を可変幅にして拡張する案は検討したが、ボード側の横スクロール領域を狭めてしまい「画面の6割」という要求を安定して満たせないため不採用。

### D2: パネル幅は `min(60vw, 720px)`、狭幅時（`max-width:1100px`、既存ブレークポイント流用）は `100vw`
- 理由: 60vw を上限なしで使うと大画面で間延びする。720px は現行のノート編集エリア（`kb-detail-body`）が十分に使える幅として妥当。狭幅では `kb-aside` が縦積みになる既存ブレークポイントに合わせ、detail も全幅にしないと「6割」が実用に耐えない幅になる。
- 代替案: 固定px幅のみ（レスポンシブなし）は却下。ウルトラワイド〜モバイルまで想定する既存の `@media (max-width: 1100px)` と整合させる。

### D3: スクリムクリックで close（`e.target === overlay` 判定、`stopPropagation` は使わない）
スクリム要素（`.kb-detail-overlay`）に `click` リスナーを付け、`e.target === overlay`（＝クリックがスクリム自身に当たった、パネル内の子要素ではない）のときだけ `closeDetail()` を呼ぶ。
- 理由: 既存の `util.js` `openModal`/`closeModal`（`.modal-backdrop`）が同じ判定方式を使っており、コードベース内の既存パターンと一貫させた。`stopPropagation` を使わずとも、パネル内クリックは `e.target` がパネル配下の要素になるため自然に条件から外れる。
- 元々 `kb-board-scroll` の背景クリックで `closeDetail()` を呼ぶ実装があったが（`kanban.js:579`）、オーバーレイ化後はボードがスクリムの背後に回り到達不能なデッドコードになるため削除した。

### D4: `detailEl(t)` からフッターの「タスクを削除」「このタスクを分解する」を撤去する
`kb-detail-foot` からは削除ボタン（`kb-del-btn`）を外し、ヒント文だけを残す。`decomposeEl(t)` 関数・呼び出し・関連state（`S.decomposeOpen`）・CSS（`.kb-decompose*`）を丸ごと削除する。`kb-detail`, `kb-detail-close`, `kb-detail-title`, `kb-detail-body` など他のクラス名・DOM構造は変更しない。
- 理由: issue #92 の追加コメントで、これらのボタンがテキスト欄を狭く見せている・実運用で使っていないと明言された。削除操作はカード上のゴミ箱アイコン・右クリックで代替可能。分解操作は他に代替導線がないため、いったん機能ごと撤去する（AskUserQuestion でユーザーに確認済み: 分解フローの既存e2e `goal-blueprint-task-tree.spec.ts` は削除し、分解機能はカンバンからは使わない前提にする）。
- `detailEl(t)` は独立カンバンタブと明日の計画（埋め込み）で共有するため、この変更は両方の文脈に及ぶ（表示位置のオーバーレイ化は独立タブのみだが、フッター構成は共通）。埋め込み側の既存e2eを確認したところ `kb-del-btn` / `kb-decompose*` への参照はなく、影響なし。
- 代替案: overlay 文脈だけ非表示にする（`detailEl(t, {showActions:false})` のような呼び出し側オプション）も検討したが、埋め込み側にボタンだけ残す理由が無く、実装・spec双方の複雑化を避けるため不採用（両文脈で統一して撤去）。

### D5: overlay の背景クリックは、直前のカードクリックから500ms以内なら「dblclick」とみなしリネームへ切り替える
D1で `kb-detail-overlay`（`inset:0` のスクリム）を導入したことで、カードの dblclick（ブラウザは click→click→dblclick の順で発火）のうち2回目の click/dblclick が、1回目の click が開いた overlay（z-index 45、全画面）に奪われ、カード自身の `dblclick` リスナーへ届かなくなる回帰が生じた（`kanban-card-quick-actions.spec.ts` のダブルクリックリネーム3ケースが赤くなった。この回帰は red/green 証明の過程で発見: `git stash push -- server/` で本変更前のサーバーコードに戻すと同spec 13件が全 pass することで、既存の不具合ではなく本変更が持ち込んだ回帰だと確定した）。
- 対策: カードの click ハンドラで `lastCardClickId`/`lastCardClickAt`（モジュールスコープの変数）を記録し、overlay の背景クリック（`e.target === overlay`）がそれと同一カード・500ms以内であれば「dblclick の2回目」とみなし、`closeDetail()` の代わりに `S.detailId=null; S.renamingId=t.id; renderAll()`（従来の card 側 dblclick ハンドラと同じ遷移）を行う。
- 理由: native な `dblclick` イベントはDOM入れ替え（overlay挿入）を跨ぐと発火先が不安定なため、時間ベースの手動判定に寄せた。500ms は一般的なOSのダブルクリック閾値の上限を目安にした値で、Playwrightの `dblclick()`（既定 delay 0ms）は十分に収まる一方、意図的な単発クリックでの背景クリック閉じ（通常はもっと間隔が空く）を誤検知する実害は小さいと判断した。
- カード側の既存 `dblclick` リスナー（`if (S.detailId === t.id) {...} S.renamingId = t.id;`）はそのまま残している（overlay 生成前のタイミングでdblclickが飛来するごく短い競合状態の保険。到達率は低いが害もない）。
- 検証: `git stash push -- server/` → `CI=1 npx playwright test e2e/kanban-detail-overlay.spec.ts e2e/kanban-card-quick-actions.spec.ts`（新規specは赤・quick-actionsは13件green）→ `git stash pop` → 同コマンド（新規spec含め全green）で red/green 証明済み。加えて `kanban-*` 系e2e 50件・vitest 555件を通しで実行し他への影響がないことを確認した。

## Risks / Trade-offs

- [Risk] `.kb-del-btn` へのフォーカス到達を前提にしていた既存e2e（`kanban-note-editor.spec.ts` の2ケース）が壊れる → Mitigation: ボタンの有無に依存しない表現（エディタにフォーカスが留まる／留まらない）へ書き換えた。
- [Risk] 「盤面のカードを分解する」既存e2e（`goal-blueprint-task-tree.spec.ts`）が、UI導線撤去により実行不能になる → Mitigation: ユーザー承認のうえ当該テストケースを削除。分解機能自体・バックエンドAPI・`task-tree.test.ts` は変更せず健在（UIから使えなくなるだけ）。
- [Risk] サイドバー（進捗リング・ログ）がオーバーレイに完全に隠れることで、detail を開いたまま進捗を確認する手段が無くなる → Mitigation: これは issue 作成者の明示的な要望（右端まで広げる＝サイドバーを覗かせない）であり許容する。✕ボタンでいつでも閉じられる。

## Migration Plan

DBスキーマ変更・APIの変更を伴わないフロントエンドのみの変更のため、通常のコミット→デプロイで完結する。ロールバックは当該コミットの revert で足りる。
