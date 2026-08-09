## Context

レポート画面（`server/static/js/goals.js` の `renderReport`）は ヘッダ＋①〜⑤の1カラム構成。今回触るのは③と④の2ブロックだけで、**サーバ・API・DB は一切変更しない**。

現状の関連する形:

- `blockBeforeAfter(rep, imgBase)`（`goals.js:1230`）— 見出し＋モードトグル、**文面並置（`.gr-ba` / `baCol`）**、最終日CTA、画像領域（`renderDefaultMode` / `renderAllMode`）の4つが1関数に同居している。今回消すのは**文面並置だけ**。
- `blockReader(rep, rs, imgBase)`（`goals.js:1428`）— `<select>` で1日を選び、`rs.renderReader(dayNumber)` が①のハイライト更新と本文・画像の差し替えを行う。
- `readerState`（`renderReport` 内）— `{ selected, cellsByDay, headerByDay, renderReader }`。①のセル生成時に `cellsByDay` / `headerByDay` が埋まり、④が①のハイライトを駆動する。この**逆流の配線はそのまま使える**。
- `rep.days[i]` = `{ dayNumber, dayKey, text, source, images[] }`。④が要る情報は既に全部ここにある。追加取得は不要。

制約:

- `app.css` は「1ルール1行」のコンパクト書式。触っていない行の書式を変えない（プロジェクトルール）。
- デモモードは同じ `days[]` を返すので、④は本番・デモで同じコードパスを通る。

## Goals / Non-Goals

**Goals:**

- ③を写真専用ブロックにする（文面並置の削除のみ。画像まわりは1行も変えない）
- ④を横スクロールの日記ストリップにし、①からの連動を「選択」から「スクロール＋強調」へ移す
- 再描画（モーダル保存後）で読んでいた位置を失わない

**Non-Goals:**

- サーバ／API／DB の変更。`rep` のレスポンス形は不変
- ①②⑤・完走フォーク・日別詳細モーダルの中身の変更
- 写真比較のロジック・見た目の変更（`renderDefaultMode` / `renderAllMode` / `finalPhotoCta` は無改造）
- 設計図（親タスクツリー）— 別 change

## Decisions

### D1. ③は「関数を作り直す」のではなく「文面並置の3行を落とす」

`blockBeforeAfter` から `const first` / `const last` / `card.appendChild(h('div', { class: 'gr-ba' }, ...))` の3行と `baCol()` 関数を削除し、見出しを「③ 写真の比較」に変える。それだけ。

- **代替案（ブロックごと書き直す）を採らない理由**: モードトグルの表示同期（`syncToggleVisibility`）・CTA 後の再描画・空メッセージの出し分けは既に噛み合っており、書き直すと写真比較を壊すリスクだけが増える。issue が消せと言ったのは文面であって写真ではない。
- `rep.goal.afterDayNumber` は文面並置の After 側を決めるためだけに使われていたので、UI から参照が消える。**サーバ側のフィールドは残す**（削ると `goals.ts` と `demo.test.ts` に波及するだけで、得るものが無い。未知フィールドを無視する前方互換の読み手方針にも沿う）。
- CSS は `.gr-ba` / `.gr-ba-col` / `.gr-ba-head` / `.gr-ba-tag` / `.gr-ba-day` を削除。**`.gr-ba-pair` / `.gr-ba-imgs` / `.gr-ba-figslot` は残す**（写真比較が使う）。`.gr-hist-row .gr-ba-pair`（履歴行）も残す。

### D2. ④は「カードの配列 ＋ Map で日→要素」。`renderReader` は捨てず、意味を変える

④は `rep.days` から `text.trim()` または `images.length` を持つ日だけをカード化し、`cardByDay: Map<dayNumber, HTMLElement>` を持つ。

`readerState.renderReader(dayNumber)` という**呼び口はそのまま残す**。①のセルの click ハンドラ（`goals.js` の①生成側）は無改造で済み、中身だけが「セレクタを合わせて本文を差し替える」から「①のハイライトを更新し、`cardByDay` に当たれば `scrollIntoView` して `.sel` を付ける」に変わる。

- **代替案（①側の click を書き換えて④へ直接命令する）を採らない理由**: ①→④の連動点が増える。いまは `renderReader` 1点に閉じているので、そこを保つ。
- `cardByDay` に無い日（記録なし）は**①のハイライトだけ更新して return**。`scrollIntoView` を呼ばない。強調中のカードがあれば外さない、ではなく**外す**（強調は1枚まで＝spec）。記録の無い日を選んだら強調ゼロになる。

### D3. スクロールは `scrollIntoView({ block: 'nearest', inline: 'center' })`

`block: 'nearest'` にしないと、横スクロールのつもりでページ全体が縦にも飛ぶ。`inline: 'center'` で対象カードを中央に寄せる。`behavior: 'smooth'` は初回描画（`renderReport` 末尾の `readerState.renderReader()`）でも走るとページを開いた瞬間に動くので、**初回は `'auto'`、以降は `'smooth'`** とする（`renderReader` に第2引数 `smooth` を足す）。

### D4. 再描画で位置を失わない件は「`selected` を引き継ぐ」で足りる

モーダル保存後の再描画は `renderReport(root, goalId)` の呼び直しで、`readerState` は作り直される。`readerState.selected` の初期値をいまの `1` 固定から**「呼び出し元が渡した日、無ければ最初のカードの Day」**に変える。`renderReport` に省略可能な第3引数 `selectedDay` を足し、モーダルの保存後経路（`openDayDetailModal` の再描画コールバック）がその日を渡す。

- **代替案（スクロール位置 px を保存して復元）を採らない理由**: カードの枚数と高さが保存で変わりうる（記録が増える）ので px は当てにならない。Day 番号は安定している。

### D5. カードの寸法は固定幅・固定高で、本文はカード内で縦スクロール

- 幅 `clamp(280px, 26vw, 360px)`、高さ固定。`.gr-strip` は `display:flex; overflow-x:auto; scroll-snap-type: x proximity`。
- 本文領域だけ `overflow-y:auto`。カードごと高さが違うと横スクロールがガタつくので高さを揃える。
- ストリップは `overflow-x:auto` を**自分で持つ**（ページ本体を横に伸ばさない・spec の MUST NOT）。`.gr-report` 側に `min-width:0` が要る可能性があるので実装時に確認する。
- 画像はカード内の本文の下に、既存の `imgFig(imgBase, m, '')` をそのまま使って並べる（④は現在も同じ関数で描いている）。

`ref/` に静的モックを1枚置いてスクショで確認してから CSS を確定する（[[reference-impl-in-ref-dir]] の運用）。

## Risks / Trade-offs

- [横スクロール領域が3重に衝突する（ページ縦・ストリップ横・カード内縦）] → ストリップは `overscroll-behavior-x: contain`、カード本文は `overscroll-behavior-y: contain` を付けて、端に達したときに親へ伝播させない。ホイールの横変換は自前でやらない（トラックパッド／シフト＋ホイールのブラウザ既定に任せる）。
- [記録のある日が0〜1件だとストリップに見えず、ただのカードが1枚置かれた状態になる] → 仕様上それで正しい（空カードを並べない方針の裏返し）。0件は一文のみ。1件はカード1枚。特別扱いしない。
- [`scrollIntoView` が①のクリックで走ると、①自体が画面外へ出ることがある] → `block: 'nearest'` で縦移動を抑える（D3）。日別詳細モーダルが同時に開くので、モーダルを閉じた後に①が見えていることを目視で確認する。
- [文面並置を消したことで「Day1 と最終日を並べて見る」用途が失われる] → 意図した削除（issue #91）。ストリップの両端をめくれば同じ2枚は読める。写真の比較は③に残るので、対比という体験自体は消えない。
- [デモモードで検証しないと日数まわりの成果が見えない] → プロジェクトルールに従い、デモモード（`POST /api/demo/reset` → レポート）で30日ぶんのストリップを実際に出して確認する。デモの `days[]` は32日ぶん・全日 `source === 'journal'` なので（`demo.test.ts:129-131`）、**全日がカードになる密なストリップ**になる。逆に「記録の無い日を飛ばす」挙動はデモでは確認できないため、そこは本番DBか一時DBで別途確認する。

## Migration Plan

DB マイグレーション無し。フロントの差し替えのみで、既存データの読み替えも不要。巻き戻しは `goals.js` / `app.css` の revert で完結する。

## Open Questions

- カードの高さの実値（本文3〜4行ぶん＋画像1枚が見える程度を想定）は `ref/` のモックを見てから決める。
- ストリップの scroll-snap を `proximity` にするか `mandatory` にするか。`mandatory` だとカード間の中途半端な位置に止まれず読みづらい可能性があるため `proximity` を既定とし、モックで判断する。
