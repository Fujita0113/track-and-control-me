## 0. 凍結ラインの申し送り

この change はフロントエンド（`server/static/js/goals.js` / `server/static/css/app.css`）のみで、
サーバ・API・DB を変更しない。vitest の対象は `server/src/**` `packages/*/src/**` `extension/src/**`
（`vitest.config.ts`）なので、**この change には赤で置ける vitest の seam が存在しない**。

- **propose が凍結したもの**: delta spec（`specs/goal-report/spec.md` / `specs/goal-report-day-detail/spec.md`）のみ。
- **追加した vitest**: なし（上記の理由）。`npm test` の結果は変更前と同一である（この change は
  1件もテストを増やしていないので、`npm test` は現状の緑をそのまま保つ）。
- **変更した既存 e2e**: なし。**既存 E2E への影響なし** — `goal-report-day-detail.spec.ts` は
  `.gr-goal-card` / `.gr-report` / `.gr-cal .gr-cell` / `.gr-daytip` / `.gr-textarea` しか参照しておらず、
  ③④のセレクタ（`.gr-ba*` / `.gr-reader*` / `.gr-day-select`）に触れていない。他の e2e も同様。
  `git diff -- e2e/` が空であることが apply 完了時の条件。
- **apply が最後に書く新規 e2e が覆うべきフロー**（セレクタではなくフローで指定する）:
  1. 「レポートを開く → ①の記録のある日のマスをクリック → ④が該当日のカードへ寄って強調される」
  2. 「レポートを開く → ③に日記の文面が出ておらず、写真だけが並んでいる」
  3. 「日別詳細モーダルから振り返りを保存 → 再描画後も④が同じ日のカードのままである」
  新規 e2e は `CI=1` を付けて stash 検証（実装を stash すると落ちること）を行うこと。

## 1. ③ を写真専用ブロックにする

- [x] 1.1 `goals.js` `blockBeforeAfter`: 文面並置を削除する（`const first` / `const last` と
      `card.appendChild(h('div', { class: 'gr-ba' }, baCol('Before', first), baCol('After', last)))` の
      3行）。画像領域・モードトグル・`syncToggleVisibility`・`finalPhotoCta` には触れない（design D1）
- [x] 1.2 `goals.js`: 未使用になった `baCol()` 関数を削除する
- [x] 1.3 `goals.js`: 見出しを `③ Before / After` → `③ 写真の比較` に変更する。モードトグルのラベル
      （`Before / After` / `全部くらべる`）は写真の比較モード名なので**変えない**
- [x] 1.4 `goals.js`: 関数名 `blockBeforeAfter` を `blockPhotoCompare` へ改名し、`renderReport` の
      呼び出し側も直す。ブロックコメントを「③ 写真の比較（2モードの画像比較 ＋ 最終日CTA）」へ更新
- [x] 1.5 `app.css`: `.gr-ba` / `.gr-ba-col` / `.gr-ba-head` / `.gr-ba-tag` / `.gr-ba-day` を削除する。
      **`.gr-ba-pair` / `.gr-ba-imgs` / `.gr-ba-figslot` と `.gr-hist-row .gr-ba-pair` は残す**（写真比較と
      履歴行が使っている・design D1）。フォーマッタをファイルにかけない（1ルール1行の書式を守る）
- [x] 1.6 `git diff --stat -- server/static/css/app.css` を見て、削除行数が想定（5行前後）の桁に
      収まっていることを確認する（整形の混入検知）

## 2. ④ を日記ストリップにする

- [x] 2.1 `goals.js` `blockReader` を `blockJournalStrip(rep, rs, imgBase)` へ作り替える。
      `rep.days` から `d.text.trim()` または `d.images.length` を持つ日だけをカード化し、
      `rs.cardByDay: Map<dayNumber, HTMLElement>` に登録する（design D2）
- [x] 2.2 各カードの中身: Day 番号と `dayKey` の見出し、出典タグ（`source === 'journal'` → 「日記」/
      `'reflection'` → 「振り返り」）、`renderMarkdown(d.text)` の本文、その日の画像
      （既存の `imgFig(imgBase, m, '')` をそのまま使う）。画像だけで本文が無い日は本文欄に
      「この日の記録はありません」を出す
- [x] 2.3 カードが1枚も作れない場合は、ストリップの代わりに一文のみを表示する
- [x] 2.4 `<select class="gr-day-select">` による日付セレクタを削除する（①のマスが唯一の導線になる）
- [x] 2.5 `rs.renderReader(dayNumber, smooth)` の中身を差し替える: ①のセル/ヘッダのハイライト更新は
      **現行のまま残し**、本文差し替えの代わりに `rs.cardByDay.get(rs.selected)` を
      `scrollIntoView({ block: 'nearest', inline: 'center', behavior: smooth ? 'smooth' : 'auto' })` して
      `.sel` を付ける。強調は常に1枚（前の `.sel` を外す）。カードが無い日はスクロールせず、
      強調はゼロになる（design D2/D3）
- [x] 2.6 `renderReport` に省略可能な第3引数 `selectedDay` を足し、`readerState.selected` の初期値を
      「`selectedDay` があればそれ、無ければ最初のカードの Day、カードが無ければ 1」にする。
      末尾の初回呼び出しは `smooth = false` で呼ぶ（design D3/D4）
- [x] 2.7 `openDayDetailModal` の再描画コールバック（`goals.js:980` 付近）が、保存後の
      `renderReport` にその日の Day 番号を渡すようにする（design D4）
- [x] 2.8 `app.css`: `.gr-reader-head` / `.gr-reader-src` / `.gr-reader-body` / `.gr-reader-imgs` /
      `.gr-day-select` を削除し、`.gr-strip` / `.gr-strip-card` / `.gr-strip-card.sel` /
      `.gr-strip-head` / `.gr-strip-body` / `.gr-strip-imgs` を追加する。
      `.gr-strip` は `display:flex; overflow-x:auto; overscroll-behavior-x:contain; scroll-snap-type:x proximity`、
      カードは固定幅 `clamp(280px,26vw,360px)`・固定高、`.gr-strip-body` は
      `overflow-y:auto; overscroll-behavior-y:contain`（design D5）
- [x] 2.9 `.gr-report` 側でページ本体が横に伸びていないことを確認する（必要なら `min-width:0`）。
      横スクロールがストリップの内側に閉じていることが spec の MUST NOT

## 3. 見た目の確定

- [x] 3.1 `ref/` にストリップの静的モックを1枚置き、カード高・snap（`proximity` か `mandatory` か）を
      スクショで確認してから CSS の実値を確定する（design Open Questions）
- [x] 3.2 ストリップ・カード内・ページの3重スクロールが互いに暴れないことを実機で確認する

## 4. デモモードで成果を出す（プロジェクトルール）

- [x] 4.1 `PORT=<空きポート> DB_PATH=:memory: npm run server` で起動し、`POST /api/demo/reset` の後に
      デモの目標レポートを開く。デモは32日ぶん全日に日記があるので（`demo.test.ts:129-131`）、
      **32枚の密なストリップ**が出ることを確認する
- [x] 4.2 デモで①のマスをクリックし、④が該当カードへ寄ること・**モーダルは開かないこと**を確認する
      （`goal-report-day-detail` のデモ要件）
- [x] 4.3 デモで③に文面が出ておらず写真だけが並ぶこと、最終日CTAが出ないこと（デモは閲覧専用）を確認する
- [x] 4.4 「記録の無い日はカードにならない」はデモでは確認できない（全日に日記があるため）。
      一時DB（`DB_PATH=:memory:` の本番モード）で日記を1〜2日だけ書いて、飛ばされることを確認する

## 5. 新規 e2e（apply が DOM を作った後に書く）

- [x] 5.1 §0 に挙げた3フローの e2e を書く。セレクタは実装した DOM から採る
- [x] 5.2 `git stash push -- server/` → `$env:CI="1"; npx playwright test e2e/<new-spec>.spec.ts` で
      **落ちること**を確認 → `git stash pop` → 通ることを確認する。`CI=1` は必須
      （無いと `reuseExistingServer` が起動済みサーバを使い回して偽の緑になる）
- [x] 5.3 `git diff -- e2e/` に**新規ファイルの追加以外の差分が無い**ことを確認する（既存 e2e は凍結）
