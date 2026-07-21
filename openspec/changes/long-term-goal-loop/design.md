## Context

`ユーザーフロー.md` が本変更の**唯一の受け入れ基準**である。この design はそれを実装に落とすための判断だけを書く。

前提となる既存の作り：

- 解錠評価（`server/src/rules/evaluate.ts`）は当日の実効条件を AND 評価し、`unlock_evaluation.per_condition_results` にスナップショットして latch する（`first_met_at` が刻まれたら relock しない・`is_final=1` の過去日は再評価しない）。
- 条件は `effective_date` 単位のルールセットに属し、未来へ継承される（`rule-editor-inherit-conditions` / `same-day-rule-additions`）。`RuleTarget = TOTAL_WORK | GROUP | MANUAL_CHECK | PLANNING | TIMELINE`。
- 画像は `goal_image` に `goal_id`＋`day_key`＋キャプションで保存され、`goal-report ③` がキャプションでグループ化して Before/After を描く。
- 振り返りタブに目標ごとの日記コーナーが既にある（`goal-journal`）。ダッシュボードには `toast()` が既にある。
- **進行中の目標には詳細画面が無い**。目標カードからの遷移は完走後のレポートのみ。

**前回の失敗（`dated-photo-gate-and-event-log`）の教訓**: データモデルから設計し画面を一度も描かなかったため、「目標詳細に歴史ビューを追加」という*存在しない画面*を前提に spec を書き、実装が行き場を失った。今回はフローを先に確定させてからこの design を書いている。

## Goals / Non-Goals

**Goals:**
- PDCA を比喩でなく画面に出す：**Plan（賭け）と Check（答え合わせ）を一級のデータ**にする。
- 沿革に載る／載らないの線引きを、主観（大きさ）ではなく**構造（検証がぶら下がるか）**で決める。
- 既存の画面分業に従う：**書く＝振り返りタブ／詰まる＝今日タブ／読む＝目標タブ**。
- 「30日待たないと姿が分からない」を、**新画面を作らず既存レポートの鍵を外して**解消する。
- 単発Check には強い歯（繰り越しロック）を、範囲Check には現実的な歯（その日限り）を与える。

**Non-Goals:**
- 追跡グループの入替／作業時間の器／折れ線の優雅な畳み込み（#54 の D スレッド）。
- 撤退条件のシステム化。
- 沿革の縦書き・ミニマル組版、LLM によるテキスト整形（**完全ローカル・オフライン原則を維持**）。
- 場所・時刻の機械検証（app は位置情報を持たない）。
- Plan の種別選択（仮説／方針変更／計画）。Plan の文を読めば分かる。
- 時刻スケジュールの通知・OS 常駐トースト（croner / pwsh / WinRT）。

## Decisions

### D1: Plan / Check / Result の3テーブル。日次ルールセットからは独立させる

```
goal_plan(id, goal_id, day_key, body, status{active,withdrawn}, withdraw_reason, created_at)
goal_check(id, plan_id, kind{photo,question}, caption, question_text,
           schedule{single,range}, start_day_key, span_days,
           place_note, time_note, status{cancelled,...}, cancel_reason, created_at)
goal_check_result(id, check_id, day_key, image_id, answer_text, created_at)
```

理由: 既存の `rule_condition` は「未来へ継承される」意味論を持つが、Check は「開始日に発火し、達成（または期間終了）で終わる」という異なる寿命を持つ。混ぜると継承・凍結ロジックと衝突する。独立テーブルにして評価時に**合成条件として注入**する。

`goal_check.status` に `pending/active/satisfied` を**永続化しない**（D2 参照）。永続するのは終端の `cancelled` のみ。

### D2: Check の達成状態は永続化せず、対象日から遅延導出する

評価時に `(check, dayKey)` から導出する：

```
対象日に有効か  = status != cancelled
                 && plan.status != withdrawn
                 && single: start_day_key <= dayKey
                    range : start_day_key <= dayKey < start_day_key + span_days
met            = single: goal_check_result が1件でも存在し、その day_key <= dayKey
                 range : その dayKey の goal_check_result が存在する
```

理由: 状態を永続化すると日次 cron での遷移が必要になり、オンデマンド起動（README の運用メモ）で壊れる。導出なら backend の起動タイミングに依存しない。`single` の met が「提出日以降ずっと true」になるのは latch と整合する（一度きりの事実は relock しない）。

### D3: 単発＝繰り越し／範囲＝その日限り、を D2 の導出式だけで表現する

上の式がそのまま2つの意味論を生む。追加の分岐は要らない：

- `single`: 有効期間に上限が無い → 達成するまで毎日合流し続ける（**繰り越し**）。
- `range`: 有効期間が `[start, start+span)` に限られ、met はその日の result のみを見る → **サボった日は翌日に持ち越されず、期間を過ぎれば消える**。

意図の違い（「遅れてでも出す価値がある一点」vs「その日の姿は後から撮れない」）が、そのままデータの形に落ちている。

### D4: 合成条件として解錠評価へ AND 合流させる

`evaluateDay` が、対象日に有効な Check を列挙し `per_condition_results` へ以下を追加する：

```
{ conditionKey: 'check:<checkId>', target: 'CHECK', met, label: <キャプション or 質問文> }
```

- 名前空間 `check:` は既存の `condition_key`（`total_work`/`group:`/`timeline:`/`manual:`/`planning:`）と衝突しない。
- `goal-report ①` の per_condition 読み手は「一致するエントリが無い日は未達成」＋「未知フィールドは無視」という前方互換の防御を既に持つ。Check は**実践（`goal_practice`）ではない**ので①のカレンダー行には現れない（沿革⑤が読み手）。
- 合流は当日ゲートを厳しくする方向のみ＝既存の `same-day-rule-additions` の原則に一致。

### D5: 写真Check の提出は goal_image を再利用し、先指定キャプションで焼き込む

提出時に `goal_image` へ `goal_id`＋提出日 `day_key`＋**Check の先指定キャプション**で1枚保存し、`image_id` を `goal_check_result` に持つ。

理由: 保存基盤・`goal-report ③` への流入・読み取り専用表示がすべて既存機構で賄える。キャプションを**先に決めて後から変えない**ことで、Before/After のグループ化キーが決定的になり、提出物が自動で正しい列に入る。

### D6: レポートの鍵を外し、「未到来」を「欠測」と区別する

`today > end_day` の制約を `today >= start_day` へ緩める。①達成カレンダーは3値になる：

```
達成    … per_condition_results の met = true
未達成  … met = false / 評価行が無い（欠測を美化しない・既存の思想）
未到来  … day_key > today → 空白（★新規。走行中プレビューの本体）
```

進行中に開くと ③ の After は「現時点で最も新しい記録のある日」、最終日写真 CTA は非表示（最終日が来ていないため）。

### D7: 通知はダッシュボード初回オープン時のアプリ内トースト1回

時刻でスケジュールしない。ダッシュボード読み込み時に「その日に回答すべき Check があるか」を問い合わせ、あれば既存 `toast()` で1回出す。「その日すでに出したか」は `day_key` 単位のフラグで判定する。

理由: 「その日最初に開いたとき1回」という要求は時刻起動を必要としない。croner・OS トースト（pwsh / WinRT）を丸ごとスコープから外せる。完全ローカル・オフライン原則もそのまま。

割り切り: 夜までダッシュボードを開かなければトーストも夜に出る。ただしユーザーが本当に困るのは「気づかないまま一日終わる」ことであり、それは今日タブのゲートで必ず防がれる。

### D8: 場所メモ／時刻メモは説明メタデータのみ

判定に一切使わない。UI ではリマインド文として表示するだけ。機械が保証するのは「その日に提出／回答があった」事実のみ。app は位置情報を持たないので検証不能であり、既存の `MANUAL_CHECK` も名誉ベースなので一貫している。

### D9: 取り下げは理由必須。取り下げた事実は沿革に残す

`cancelled` / `withdrawn` は終端状態として**永続化**する（D2 の例外）。理由テキスト必須。沿革から消さない。これが (B) の恒久ロックに対する**唯一の脱出弁**であり、「理由さえ書けば逃げられる」緩さと引き換えに、**逃げた事実が歴史に残る**ことを担保する。

## Risks / Trade-offs

- **質問Check の答えと日記の境界が曖昧**: 「今日はシャンプー3日目。泡立ちがいい」（日記・沿革外）と「泡立ちは良い」（質問の答え・沿革内）は内容がほぼ同じでも扱いが変わる。理屈（検証の有無）は通っているが、毎晩書くときに迷わないかは**使ってみないと分からない**。今は理屈どおり進め、実際に詰まったら直す。
- **単発Check の歯が鋭い**: 未達の単発Check は恒久ロックを生む。放置すると全ゲートが開かない。脱出弁は D9 のみ（設計上の意図＝コミット装置）。今日タブで不足条件として明示し、取り下げ導線をその場に置くことで緩和する。
- **`is_final` スナップショットとの整合**: 過去日の `unlock_evaluation.is_final=1` は再評価しない。単発Check を後から満たしても**過去の確定日は未達のまま**（`goal-report ①` の「欠測を美化しない」思想に一致）。満たした当日以降のみ met。この非対称は仕様として受け入れる。
- **範囲Check の各日は代替不能**: 仕様上そうあるべきだが、ユーザーが「まとめて後から埋めたい」と感じる可能性はある。埋められないのが正しい（その日の髪は撮れない）が、体験としての摩擦は残る。
- **レポートの鍵を外す影響**: 進行中の目標に対しレポート生成が走るようになるため、部分データ（時間型実践が0日分など）でも壊れないことを確認する必要がある。②時間の推移が1点しかない場合の描画など。
- **デモモードの決定性**: サンプルは固定 `day_key`／固定タイムスタンプで焼き込む（`Date.now()` 非依存）。既存の達成 24/30・中盤の谷の筋書きを壊さないよう、Plan/Check のサンプルは既存の谷日付近へ寄せる。
