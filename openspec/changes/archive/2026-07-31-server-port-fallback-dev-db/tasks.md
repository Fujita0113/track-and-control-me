## 1. ポート自動フォールバック

- [x] 1.1 `server/src/config.ts` に `findAvailablePort(basePort, host, maxAttempts = 20): Promise<number>`
      を追加する。`net.createServer()` で試験リッスン→即クローズし、使用中(`EADDRINUSE`)なら
      次のポートを試す。全滅したら分かりやすいメッセージで reject する。
- [x] 1.2 vitest: `server/src/config.test.ts` の `findAvailablePort` 系(空きポートを返す／
      使用中ならスキップする／連続使用中でもスキップする／全滅時は例外)を赤で追加済み
      (このタスクの実装で通す)。

## 2. DBパス解決ロジックの分離

- [x] 2.1 `server/src/config.ts` に `resolveDbPath({ explicitDbPath, fileDbPath, serverRoot,
      basePort, actualPort }): string` を追加する。優先順位: `explicitDbPath` >
      `fileDbPath` > (`actualPort === basePort` なら実DB／それ以外なら開発用DB)。
- [x] 2.2 `loadRuntimeConfig()` を「ポート確定前に必要な値(候補ポート・env/file の
      dbPath・serverRoot)を返すフェーズ」と、確定後に `resolveDbPath` を呼ぶ呼び出し側
      (main.ts)に分離する形にリファクタする(`RuntimeConfig` 型・既存の呼び出し元の
      互換は保つか、main.ts 側で吸収する)。
- [x] 2.3 vitest: `server/src/config.test.ts` の `resolveDbPath` 系(明示指定優先／
      config.local.json 優先／いつものポートは実DB／フォールバックは開発用DB)を赤で
      追加済み(このタスクの実装で通す)。

## 3. 開発用DBの初回サンプルデータ投入

- [x] 3.1 新規 `server/src/services/dev-seed.ts` を作成し、`seedDevSample(db: DB): void`
      を実装する。既存のサービス関数(`createTask`, `createGoal`)を使い、生SQLは書かない。
      カンバンタスク数件(異なる status/priority)＋長期目標1件(`TOTAL_WORK` ルール等
      シンプルな内容)を投入する。日時は `Date.now()` 基準でよい(固定 day_key 不要。
      理由: [[verify-goal-features-via-demo-mode]] のデモモード規約は対象外 — この
      サンプルは「触って確認するための使い捨てデータ」であり、日数集計の再現性検証
      ではない)。
- [x] 3.2 vitest: `server/src/services/dev-seed.test.ts`(`seedDevSample` を呼ぶと
      タスク・目標が最低1件ずつできる)を赤で追加済み(このタスクの実装で通す)。

## 4. main.ts の起動シーケンス組み替え

- [x] 4.1 起動順を「(1) 候補ポート確定 → (2) `findAvailablePort` で実ポート確定 →
      (3) `resolveDbPath` で dbPath 確定 → (4) dbPath が開発用DBかつファイル未存在なら
      `seedDevSample` 対象としてフラグを立てる → (5) `openDb()`(新規なら直後に
      `seedDevSample` 実行) → (6) ルート登録 → (7) `app.listen({ host, port: 実ポート })`」
      に組み替える。
- [x] 4.2 起動完了後、実際にバインドされたホスト・ポート・フォールバックの有無・
      接続DBの種別を `console.log` の平文行として出力する(design.md D5)。既存の
      pino info ログ行は残してよい(重複しても実害なし)。
- [x] 4.3 空きポートが1つも見つからなかった場合のエラーハンドリングを確認する
      (現状の「クラッシュしてexit(1)」という失敗モード自体は維持しつつ、
      メッセージで原因が分かるようにする)。

## 5. server/.env の整理

- [x] 5.1 `server/.env` から `DB_PATH` のハードコード行(および説明コメント)を削除する。
- [x] 5.2 本チェックアウトで `npm run server` を実行し、削除後も `<repo>/server/data/
      track.sqlite`(実DB)に接続されることをログで確認する(挙動が変わっていないことの
      確認)。実行時にいつものポート(47653)が既に本チェックアウトの別プロセスに使われて
      いたため直接のログ確認はできなかったが、そのフォールバックの中で
      `resolveDbPath`(vitest で実DBパス分岐を確認済み)と `dev-seed` の新規作成/再利用が
      実プロセスで正しく動くことを確認できた(下記 7.1 と合わせて実施)。

## 6. Windowsログオン時の自動起動(非表示)

- [x] 6.1 `server/scripts/start-hidden.vbs` を作成する。`WScript.Shell.Run` で
      リポジトリルート(スクリプト自身の位置から相対解決)を作業ディレクトリとして
      `npm run server` を非表示(`windowStyle = 0`)・非同期(`waitOnReturn = False`)で
      起動する(design.md D6)。
- [x] 6.2 `server/scripts/register-autostart.ps1` を作成する。固定タスク名
      (`TrackAndControlMe-AutoStart`)で既存タスクがあれば削除してから
      `New-ScheduledTaskTrigger -AtLogOn` ＋ `wscript.exe "<repoRoot>\server\scripts\
      start-hidden.vbs"` を実行するタスクを `Register-ScheduledTask` で登録する
      (冪等・管理者権限不要)。
- [x] 6.3 `server/scripts/unregister-autostart.ps1` を作成する。同じタスク名を
      `Unregister-ScheduledTask -Confirm:$false` で解除する(存在しない場合もエラーに
      しない)。
- [x] 6.4 手動確認: `register-autostart.ps1` を実行 → いつものポートを使っている
      プロセスを一旦終了 → Windows からログオフ/ログオンし直す(または該当タスクを
      タスクスケジューラから手動 `Start-ScheduledTask` で代用確認してもよい) →
      コンソールウィンドウが表示されずにサーバーが起動し、いつものポートで
      ダッシュボードに到達できることを確認する。
      → ユーザーが確認済み: 非昇格の pwsh からは `Register-ScheduledTask` が
      「アクセスが拒否されました」で失敗する(apply 側のサンドボックスでも同様に再現)
      ことが判明したため、PowerShell を「管理者として実行」で開き直して登録した。
      その後、再起動してコンソールウィンドウなしでサーバーが自動起動することを確認済み。
      design.md D6 の「管理者権限不要」という前提はこの環境では成り立たなかった
      (下記 D6 追記を参照)。
- [x] 6.5 手動確認: `register-autostart.ps1` をもう一度実行し、タスクスケジューラ上に
      同名タスクが重複していないことを確認する。
      → ユーザーが確認済み(6.4 と合わせて実施)。
- [x] 6.6 手動確認: `unregister-autostart.ps1` を実行し、タスクスケジューラから
      当該タスクが消えることを確認する。
      → ユーザーが確認済み: 自動起動を止められることを確認した。

## 7. 動作確認(ポートフォールバック/開発用DB)

- [x] 7.1 本チェックアウトで `npm run server` を起動したまま、別ターミナルで
      (例えば `git worktree add` した別ディレクトリ、または同じディレクトリから)
      もう一つ `npm run server` を実行し、以下を目視確認する:
      - クラッシュせずフォールバックポートで起動すること
      - 起動ログにフォールバックポート番号と「開発用DB」である旨が表示されること
      - ブラウザでそのポートにアクセスし、カンバンタスク・長期目標のテストデータが
        表示されること
      - 同じフォールバックDBで2回目に起動した際は、テストデータが重複投入されず、
        リセットもされず前回の状態が引き継がれること
      確認済み: いつものポート(47653)が既存プロセスに使われている状態で
      `npm run server` を実行 → `▶ ... http://127.0.0.1:47654  [fallback port; db:
      track.dev.sqlite]` のバナーどおりフォールバックポートで起動し、
      `server/data/track.dev.sqlite` が新規作成されタスク3件・目標1件が投入された
      (sqlite で直接確認)。同じコマンドをもう一度実行しても件数は変わらず
      (タスク3件・目標1件のまま)、再投入もリセットもされないことを確認した。
      ブラウザでの目視確認は未実施(件数確認で代替)。
- [x] 7.2 `npm test` を実行し、1〜3 で追加した vitest がすべて green になることを確認する。
      → config.test.ts(8件)・dev-seed.test.ts(2件)は green。全体は349件中348件 pass、
      1件失敗(`server/src/api/goals-freeze.test.ts` > 「枠の状態は使った目標が分かる形で
      返る」)。この失敗は本変更のファイルを `git stash` した状態でも同様に再現することを
      確認済み(pre-existing failure・本変更と無関係。goal-freeze 機能のファイルは一切
      触っていない)。
- [x] 7.3 `npx playwright test e2e/screenshots.spec.ts` など既存 e2e を実行し、
      regression が無いことを確認する(下記「既存/新規 e2e への影響」参照)。
      → `CI=1 npx playwright test e2e/screenshots.spec.ts` は green。全体スイート
      (`CI=1 npx playwright test`)は 33〜38 passed / 数件 failed・flaky
      (`goal-freeze-reserve-flow` / `goal-rule-gate-loop` / `tomorrow-plan-*`)。
      これらの失敗は本変更のファイル(`server/.env` / `server/src/config.ts` /
      `server/src/main.ts`)を `git stash` した未変更コードでも同一の組み合わせで
      再現することを確認済み(月1回の凍結枠を並行テストが取り合う・`＋ 追加` ボタンが
      並行作成された複数目標ぶん増える、等)。goal-freeze/kanban/reflection のコードは
      本変更で一切触っていないため、本変更由来の regression ではないと判断した。

## 既存/新規 e2e への影響

- **既存 e2e への影響**: なし。`playwright.config.ts` は `webServer` に対して
  `PORT=8899` と `DB_PATH=:memory:` を両方明示的に渡しており、本変更の解決順位
  (`resolveDbPath`)では明示指定が最優先されるため、既存 e2e の挙動は変わらない。
  よって既存 spec の修正は不要。
- **新規 e2e**: 必須ではない。本変更の中心はプロセス起動時のポート選択/DB切替という
  ブラウザ操作を伴わない挙動であり、vitest(セクション1〜3)で decidable に検証できる。
  ただし apply が「画面での見え方も確認しておきたい」と判断した場合に書くとすれば、
  対象フローは次の1つ:
  「(いつものポートが埋まっている状態で起動した)フォールバック起動のダッシュボードに、
  開発用サンプルのカンバンタスクと長期目標が表示される」
  — このフローを e2e にするかどうかの判断も含めて apply に委ねる(必須ではない)。
- **自動起動(セクション6)**: タスクスケジューラ・vbs という Windows OS 統合であり、
  vitest・e2e のどちらでも自動検証できない。セクション6.4〜6.6 の手動確認のみで検証する。
