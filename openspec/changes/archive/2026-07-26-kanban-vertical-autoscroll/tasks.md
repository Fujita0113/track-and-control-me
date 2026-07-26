## 1. 縦自動スクロールの実装

- [x] 1.1 `server/static/js/kanban.js` の横スクロール実装(`EDGE_ZONE`/`MAX_SPEED`/`startAutoScroll`/`autoScrollStep`/`stopAutoScroll`, 行339-400付近)と対になる縦版を追加する(定数は独立させる: 例 `V_EDGE_ZONE`/`V_MAX_SPEED`、関数は `startVAutoScroll`/`vAutoScrollStep`/`stopVAutoScroll`)。
- [x] 1.2 `document` に `dragover` リスナーを追加し、`e.clientY` とビューポート上端(0)/下端(`window.innerHeight`)からの距離で上下の近傍ゾーン判定と食い込み量(intensity)を計算する。列側の `dragover`(挿入インジケータ計算)から `stopPropagation()` されていないことを前提にバブリングで拾う。
- [x] 1.3 縦スクロールは `window.scrollBy(0, dy)` で実行する(`requestAnimationFrame` ループ、`renderAll()` を呼ばない)。
- [x] 1.4 `drop` / `dragend` / ウィンドウ外への `dragleave`(`e.relatedTarget == null` 等)で `stopVAutoScroll()` を呼び、確実に停止させる。
- [x] 1.5 横方向のループと縦方向のループが独立して動作し、一方の停止がもう一方に影響しないことをコードレビューで確認する(design.md のコーナーケース対応)。

## 2. テスト

- [x] 2.1 新規 vitest は追加しない。理由: `server/static/js/**` は `vitest.config.ts` の `include`(`server/src/**/*.test.ts`, `extension/src/**/*.test.ts`, `packages/*/src/**/*.test.ts`)対象外であり、既存の横スクロール実装(issue #16)も同じ理由でユニットテストが無い前例に揃える。DOM/ポインタ座標に依存するロジックのため、検証は新規 e2e で行う。
- [x] 2.2 既存 e2e への影響: なし(`e2e/kanban-*.spec.ts` はドラッグ操作を行っていないため、今回の変更で赤くなる既存 spec は無い)。
- [x] 2.3 新規 e2e(実装後、DOM ができてから最後に書く): 「未着手に十分な数のタスクを積んでページを下へスクロールした状態(進行中列はビューポート上端より上へスクロールアウトしている)から、カードをドラッグしてビューポート上端近傍へポインタを寄せると自動的に上へスクロールして進行中列が現れ、そこへドロップできる」フローを1本追加する(spec.md の「上端でも同様に動作する」シナリオに対応。実装時の判明として、この横並びレイアウトでは全列が同じ上端起点のため「下端スクロールで新しい列が出現する」形は成立せず、上端方向が実際に issue #34 を解決するケースなのでこちらを採用。spec.md の SHALL 要件自体は上下双方向を規定しており変更不要)。CLAUDE.md のテスト凍結ルールに従い、`git stash` で実装を退避した状態(`CI=1`)でこの spec が落ちることを確認してから実装を戻して通す。
- [x] 2.4 `npm test` を実行し、既存スイートに回帰が無いことを確認する。(vitest 279件全通過。あわせて `CI=1 npx playwright test e2e/` で既存e2e18件+新規1件=19件全通過を確認)

## 3. デモ確認

- [x] 3.1 本変更は日数・日付が絡む機能ではないため、デモモードでの成果提示ルール(CLAUDE.md)は対象外。`PORT=8899 DB_PATH=:memory: npm run server` を起動し、未着手へ40件超のタスクを積んで深い位置までスクロールした状態から実マウスドラッグ(合成イベントではない)でビューポート上端近傍へ寄せ、`scrollY` が 3072→0 まで自動スクロールし「進行中」列が現れることをスクリーンショットで確認した。
