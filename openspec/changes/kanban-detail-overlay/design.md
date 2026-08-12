## Context

独立カンバンタブの現行レイアウトは `kb-main`（`kb-board-scroll` + `kb-aside`、幅340px固定のフレックス子要素）。`asideEl()` は、`S.detailId` が立っているときは `kb-aside` の中身を `detailEl(t)` に**差し替え**、立っていないときは進捗リング（`progressEl`）とログ（`logEl`）を表示する（`server/static/js/kanban.js:1316`）。つまり detail は常設サイドバー領域の中身が入れ替わる形で表示されており、専有面積は常に340px幅に制約される。

同じ `detailEl(t)` は、明日の計画（reflection画面の右サイドバー・タブ切替）へ `asideHost.detail` 経由で埋め込まれる別経路もある（`renderAsideInto`, `kanban.js:328`）。オーバーレイ化（表示位置・スクリム）はこちらスコープ外（[[opsx:propose の確認で独立カンバンタブのみに決定]]）。ただし後述のフッターボタン撤去は `detailEl(t)` 自体の変更なので、埋め込み側にも及ぶ。

**追記（issue #92 コメント、2026-08-11）**: 実装後にissue作成者から「タスクを削除・このタスクを分解する、の2ボタンを消してテキスト欄を広く使いたい」「サイドバーを覗かせず右端まで広げてほしい」「モーダルではなく単に覆いかぶさっているだけのUIにしてほしい」と追加要望があり、本ドキュメントは当初案から以下を変更している:
- サイドバー（進捗リング・ログ）を背後に覗かせる `padding-right: 340px` は撤回し、パネルは右端まで隙間なく拡張する。
- 詳細パネルのフッター（「タスクを削除」「このタスクを分解する」）を撤去する。分解機能はいったんカンバンから完全に撤去（バックエンドAPI・vitestは維持）。

**追記2（issue #92 コメント、2026-08-11T23:43:46Z）**: さらに3点の追加要望があり、以下を変更している（D6/D7）:
- 画面占有率を「約6割」から「約7割」へ拡大する。
- ノート本文だけが独立してスクロールし、タイトル・優先度・期限が据え置きになる現状の挙動をやめ、パネル全体を一体のスクロール領域にする。
- ノート入力欄のプレースホルダーは、フォーカス時（入力前でも）に隠れるようにする。

## Goals / Non-Goals

**Goals:**
- 独立カンバンタブでカードを開いたとき、detail パネルを画面の約7割・右端まで隙間なく占有するオーバーレイとして表示する。中央寄せの「モーダル」ではなく、画面の一部にただ覆いかぶさっているだけの平板なUI（角丸なし）にする。
- オーバーレイ表示中、パネル外側の余白（スクリム）をクリックすると閉じる。
- 既存の閉じる手段（✕ボタン）、既存のクラス名（`kb-detail`, `kb-detail-close`, `kb-detail-body` 等）を変えず、e2e への影響を最小化する。
- 詳細パネルのフッターから「タスクを削除」「このタスクを分解する」ボタンを撤去し、ノート編集欄（テキスト欄）が占める視覚的な割合を広げる。
- ノート本文が長くなっても、タイトル・優先度・期限とノートを別々のスクロール領域に分けず、パネル全体を一体でスクロールさせる。
- ノート入力欄のプレースホルダーは、内容の有無だけでなくフォーカスの有無にも連動して隠す。

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
- **2巡目コメントで `min(70vw, 840px)` へ変更（issue #92, 2026-08-11T23:43:46Z）**: 「もう少し広げてほしい、7割くらいまでなら大丈夫」との要望。720px の cap は 60vw=720px となる viewport 幅 1200px を境に切り替わる設計だったため、同じ考え方を踏襲し 840px（=70vw×1200px）を新しい cap にした。狭幅ブレークポイントの扱いは変更なし。

### D3: スクリムクリックで close（`e.target === overlay` 判定、`stopPropagation` は使わない）
スクリム要素（`.kb-detail-overlay`）に `click` リスナーを付け、`e.target === overlay`（＝クリックがスクリム自身に当たった、パネル内の子要素ではない）のときだけ `closeDetail()` を呼ぶ。
- 理由: 既存の `util.js` `openModal`/`closeModal`（`.modal-backdrop`）が同じ判定方式を使っており、コードベース内の既存パターンと一貫させた。`stopPropagation` を使わずとも、パネル内クリックは `e.target` がパネル配下の要素になるため自然に条件から外れる。
- 元々 `kb-board-scroll` の背景クリックで `closeDetail()` を呼ぶ実装があったが（`kanban.js:579`）、オーバーレイ化後はボードがスクリムの背後に回り到達不能なデッドコードになるため削除した。

### D4: `detailEl(t)` からフッターの「タスクを削除」「このタスクを分解する」を撤去する
`kb-detail-foot` からは削除ボタン（`kb-del-btn`）を外し、ヒント文だけを残す。`decomposeEl(t)` 関数・呼び出し・関連state（`S.decomposeOpen`）・CSS（`.kb-decompose*`）を丸ごと削除する。`kb-detail`, `kb-detail-close`, `kb-detail-title`, `kb-detail-body` など他のクラス名・DOM構造は変更しない。
- 理由: issue #92 の追加コメントで、これらのボタンがテキスト欄を狭く見せている・実運用で使っていないと明言された。削除操作はカード上のゴミ箱アイコン・右クリックで代替可能。分解操作は他に代替導線がないため、いったん機能ごと撤去する（AskUserQuestion でユーザーに確認済み: 分解フローの既存e2e `goal-blueprint-task-tree.spec.ts` は削除し、分解機能はカンバンからは使わない前提にする）。
- `detailEl(t)` は独立カンバンタブと明日の計画（埋め込み）で共有するため、この変更は両方の文脈に及ぶ（表示位置のオーバーレイ化は独立タブのみだが、フッター構成は共通）。埋め込み側の既存e2eを確認したところ `kb-del-btn` / `kb-decompose*` への参照はなく、影響なし。
- 代替案: overlay 文脈だけ非表示にする（`detailEl(t, {showActions:false})` のような呼び出し側オプション）も検討したが、埋め込み側にボタンだけ残す理由が無く、実装・spec双方の複雑化を避けるため不採用（両文脈で統一して撤去）。

### D5: overlay の背景クリックは、直前のカードクリックから500ms以内なら「dblclick」とみなしリネームへ切り替える（**D8 で撤回・置き換え**）
D1で `kb-detail-overlay`（`inset:0` のスクリム）を導入したことで、カードの dblclick（ブラウザは click→click→dblclick の順で発火）のうち2回目の click/dblclick が、1回目の click が開いた overlay（z-index 45、全画面）に奪われ、カード自身の `dblclick` リスナーへ届かなくなる回帰が生じた（`kanban-card-quick-actions.spec.ts` のダブルクリックリネーム3ケースが赤くなった。この回帰は red/green 証明の過程で発見: `git stash push -- server/` で本変更前のサーバーコードに戻すと同spec 13件が全 pass することで、既存の不具合ではなく本変更が持ち込んだ回帰だと確定した）。
- 対策: カードの click ハンドラで `lastCardClickId`/`lastCardClickAt`（モジュールスコープの変数）を記録し、overlay の背景クリック（`e.target === overlay`）がそれと同一カード・500ms以内であれば「dblclick の2回目」とみなし、`closeDetail()` の代わりに `S.detailId=null; S.renamingId=t.id; renderAll()`（従来の card 側 dblclick ハンドラと同じ遷移）を行う。
- 理由: native な `dblclick` イベントはDOM入れ替え（overlay挿入）を跨ぐと発火先が不安定なため、時間ベースの手動判定に寄せた。500ms は一般的なOSのダブルクリック閾値の上限を目安にした値で、Playwrightの `dblclick()`（既定 delay 0ms）は十分に収まる一方、意図的な単発クリックでの背景クリック閉じ（通常はもっと間隔が空く）を誤検知する実害は小さいと判断した。
- カード側の既存 `dblclick` リスナー（`if (S.detailId === t.id) {...} S.renamingId = t.id;`）はそのまま残している（overlay 生成前のタイミングでdblclickが飛来するごく短い競合状態の保険。到達率は低いが害もない）。
- 検証: `git stash push -- server/` → `CI=1 npx playwright test e2e/kanban-detail-overlay.spec.ts e2e/kanban-card-quick-actions.spec.ts`（新規specは赤・quick-actionsは13件green）→ `git stash pop` → 同コマンド（新規spec含め全green）で red/green 証明済み。加えて `kanban-*` 系e2e 50件・vitest 555件を通しで実行し他への影響がないことを確認した。
- **撤回の経緯（2巡目コメント対応中に発覚）**: D6/D7 実装後にkanban-detail-overlay.spec.tsへ新規e2eを2本追加したところ、既存の「余白クリックで閉じる」テストが再び赤くなった。原因を診断用の一時spec（`document` に capture-phase の click/dblclick リスナーを仕込み `event.detail` と `target` をログ出力）で実測したところ、**dblclick の2回目の click は必ずしも overlay 自身（背景）に落ちるとは限らず、パネル本体（`.kb-detail-body` 等）の上に落ちるケースがある**と判明した（カードの画面上の位置が、右寄せされたパネルの領域と重なっているかどうかに依存するため）。この場合 `e.target !== overlay` となり D5 のロジックが素通りしてしまい、リネームへの切り替えが発火しない。加えて `e.target === overlay` のケースで `e.detail`（クリックカウント）を使う代替案も試したが、`e.detail` はクリック対象要素をまたぐと保証された値にならないことが同じ実測で分かり、これも不採用にした。500ms の経過時間判定も、Playwright の高速な操作列（余白クリックで閉じるテストの一連の `await`）が偶然その閾値内に収まってしまい、「意図的な単発クリックでの close」を dblclick と誤検知する偽陽性を引き起こした（実測で確認）。位置・target に依存する判定はすべて頑健性に欠けると判断し、D8 のアーキテクチャ変更（クリックそのものを遅延させ、overlay 生成前に dblclick を確定させる）へ切り替えた。

### D8: カードの detail オープンを `CARD_OPEN_DELAY_MS`（300ms）遅延させ、dblclick が overlay 生成前に確定するようにする
`cardEl(t)` の click ハンドラは `openDetail(t)` を即座に呼ばず、`setTimeout(..., CARD_OPEN_DELAY_MS)` で遅延実行する。同じ要素の `dblclick` ハンドラは、保留中のタイマーを `clearTimeout` で取り消してから、従来通り `S.renamingId = t.id; renderAll();`（detail は開かせない）を行う。overlay 側の背景クリックは単純な `e.target === overlay ? closeDetail() : void` に戻した（D5 の時間/detailベースの特別分岐は不要になった）。
- 理由: D5・`e.detail` 案がいずれも「2回目の click がどこに落ちるか」という予測不能な要素に依存して壊れた根本原因は、**1回目の click で即座に detail（全画面規模のoverlay）を開いてしまうため、2回目の click/dblclick が本来のターゲット（カード）ではなくoverlay側の要素に奪われる**こと自体にある。overlay が「まだ存在しない」うちに dblclick 判定を確定させれば、2回とも従来通りカード自身がターゲットになり、この問題がそもそも起きない。
- トレードオフ: 単発クリックでの detail オープンに、当初の「即座に開く（体感速度優先）」というコメント（`cardEl` 冒頭）から300msの遅延が入る。ただし人間の知覚では300ms程度は概ね即時と感じられる範囲であり、既存e2eで単発クリックのdetailオープンに厳格な短いタイムアウトを課しているものは無い（`kanban-task-create-optimistic.spec.ts` の `timeout: 200` はCtrl+Enterでの新規作成パス（`S.detailId = tempId` を直接セット）で、cardEl の click 経路とは別のためこの変更の影響を受けない）ことを確認済み。
- 代替案: 遅延なしで即座に開きつつ、overlay 側で「これはdblclickの一部だった」と事後的に検出する各種ヒューリスティック（D5・`e.detail`・座標比較など）を検討したが、いずれも「2回目のクリックがどの要素に落ちるか」というレンダリング結果に依存し、カードの画面上の位置によって挙動が変わる（＝本質的に頑健でない）ため全て不採用。
- 検証: 診断用一時spec（`_diag-evtest.spec.ts`、確認後に削除）で実際の `click`/`dblclick` イベントの `target`/`detail` をログ出力し、上記の問題を実測で特定した。実装後、`git stash push -- server/` → `CI=1 npx playwright test e2e/kanban-detail-overlay.spec.ts e2e/kanban-card-quick-actions.spec.ts e2e/kanban-rename-reorder-reentrancy.spec.ts`（新規3specは赤・既存13件green）→ `git stash pop` → 同コマンド（16件全green）で red/green 証明済み。加えて `kanban-*`/`goal-blueprint-*`/`tomorrow-plan-*` 系 e2e 52件・vitest 555件を通しで実行し他への影響がないことを確認した。
- **スコープ修正（3巡目コメント対応中に発覚）**: `cardEl(t)` は独立カンバンタブと埋め込み盤面（明日の計画、`O.asideHost` あり）の両方で共有される。当初 D8 の遅延を無条件に適用したところ、埋め込み側の既存e2e（`tomorrow-plan-board-detail-sidebar.spec.ts`）が1回だけ flaky になった（1敗→retryでpass）。埋め込み盤面は `renderAll()` の `O.asideHost` 分岐（`kanban.js:298`）でオーバーレイ自体を生成しないため、そもそも D8 が解決したい「2回目のclickがoverlayに奪われる」問題が存在しない。遅延は不要な副作用でしかないため、`card` の click ハンドラで `O.asideHost` が真のとき（埋め込み時）は従来通り `openDetail(t)` を即時呼ぶよう分岐し、`CARD_OPEN_DELAY_MS` は独立カンバンタブ限定にスコープを絞った。修正後、`tomorrow-plan-board-detail-sidebar.spec.ts` を `--repeat-each=5`（10回）実行し安定してpassすることを確認した。

### D6: オーバーレイのスクロールはパネル自体で行い、`.kb-detail-body` の独立スクロールをやめる
`.kb-detail-overlay .kb-detail` に `overflow-y: auto` を付け、パネル（`kb-detail-close-row`〜`kb-detail-foot` までの flex column 全体）をスクロールコンテナにする。`.kb-detail-body` 側は `flex: none; overflow: visible; max-height: none; min-height: 0;` でリセットし、独自のスクロール領域を持たせない。
- 理由: issue #92 2巡目コメントで「ノート本文だけが独立スクロールし、タイトル・優先度・期限が据え置きになるのをやめて、パネル全体を一体でスクロールさせたい」と明示された。`.rf-ed`（contenteditable）自体は元々 `overflow` を持たず内容量に応じて自然に伸びる要素なので、親の独立スクロールさえやめれば「パネル全体が1つの続き物としてスクロールする」挙動に自然になる。
- 代替案: `position: sticky` でタイトル・優先度・期限だけ上部固定にする案も考えられたが、issue コメントは明確に「一緒にスクロールされてほしい」（＝固定ではない）と述べているため不採用。
- この変更はオーバーレイ文脈限定（`.kb-detail-overlay .kb-detail-body` へのスコープ）。埋め込み（明日の計画）の `.kb-detail-body`（52vh max-height の独立スクロール）は変更しない。

### D7: ノートプレースホルダーの表示切替に `focus`/`blur` を追加する（kanban detail 限定）
`detailEl(t)` 内で `notesEditor.el`（`createMarkdownEditor` が返す contenteditable 要素）に直接 `focus`/`blur` リスナーを追加し、フォーカス時は常にプレースホルダーを隠し、ブラー時は内容が空なら再表示する。既存の `onChange` ベースの表示切替（内容の有無で判定）はそのまま残す。
- 理由: issue #92 2巡目コメントで「入力し始めた文字とプレースホルダーの文字が被るのが面倒。カーソルを合わせた時点で隠れてほしい」と明示された。
- 実装スコープを kanban detail に限定した理由: `.rf-ph`/`.rf-ed`（`md-editor.js` の共有コンポーネント）は振り返り（`.rf-journal`）やタスクツリー詳細（`.bp-detail-ed`）など他画面でも使われている。`createMarkdownEditor` 本体や `.rf-ph` の共通スタイルを変更すると影響範囲が本 change の対象外（他 capability）まで広がるため、`notesEditor.el` への直接のイベントリスナー追加という、呼び出し側（`detailEl`）だけで完結する形にした。他画面のプレースホルダー挙動は変更しない。
- 代替案: `createMarkdownEditor` に `onFocus`/`onBlur` コールバックを新設する案も考えたが、他の呼び出し箇所（reflection.js 等）に影響しない形（オプション引数を渡さなければ従来通り）にできる一方、今回変更する必要があるのは kanban detail の1箇所だけなので、共有コンポーネントの API を広げるより呼び出し側で完結させる方がシンプルと判断した。

## Risks / Trade-offs

- [Risk] `.kb-del-btn` へのフォーカス到達を前提にしていた既存e2e（`kanban-note-editor.spec.ts` の2ケース）が壊れる → Mitigation: ボタンの有無に依存しない表現（エディタにフォーカスが留まる／留まらない）へ書き換えた。
- [Risk] 「盤面のカードを分解する」既存e2e（`goal-blueprint-task-tree.spec.ts`）が、UI導線撤去により実行不能になる → Mitigation: ユーザー承認のうえ当該テストケースを削除。分解機能自体・バックエンドAPI・`task-tree.test.ts` は変更せず健在（UIから使えなくなるだけ）。
- [Risk] サイドバー（進捗リング・ログ）がオーバーレイに完全に隠れることで、detail を開いたまま進捗を確認する手段が無くなる → Mitigation: これは issue 作成者の明示的な要望（右端まで広げる＝サイドバーを覗かせない）であり許容する。✕ボタンでいつでも閉じられる。
- [Risk] カードの単発クリックによる detail オープンに 300ms の遅延が入り（D8）、既存コメントが謳っていた「即座に開く」体感が僅かに損なわれる → Mitigation: 300ms は知覚上ほぼ即時の範囲であり、既存e2eに単発クリック経路の厳格な短タイムアウトは無いことを確認済み。ダブルクリックでのリネームがオーバーレイ導入で構造的に壊れるのを、位置依存の脆いヒューリスティックなしで直す方が優先度が高いと判断した。

## Migration Plan

DBスキーマ変更・APIの変更を伴わないフロントエンドのみの変更のため、通常のコミット→デプロイで完結する。ロールバックは当該コミットの revert で足りる。
