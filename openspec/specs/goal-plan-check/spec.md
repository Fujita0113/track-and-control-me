# goal-plan-check Specification

## Purpose
振り返りタブの目標コーナーで Plan（賭け・仮説・方針変更）を短文で立て、1つの Plan に複数の Check をぶら下げる。Check は「種類（写真／質問）×いつ（単発／範囲）」の独立2軸で指定でき、日記は Plan/Check とは独立に保存し、Plan/Check は理由つきで取り下げられる。

## Requirements
### Requirement: Plan は振り返りタブの目標コーナーで書く

システムは、**進行中**の目標ごとに、振り返りタブの目標コーナーから **Plan**（賭け＝仮説・計画・方針変更を短文で表したもの）を作成できなければならない（MUST）。Plan は `goal_id`・`day_key`（記録が属する固定 day_key）・本文（非空）を持つ SHALL。Plan の本文には購入・根拠も溶かして書く（例:「ボリュームアップシャンプーを使えば髪質が良くなるのではないだろうか」）ため、**種別（購入／決断／仮説等）の選択肢を設けてはならない**（MUST NOT）。開始前・完走後の目標に対する Plan の作成は拒否 SHALL する。

#### Scenario: 進行中の目標に Plan を書ける

- **WHEN** 進行中の目標のコーナーで「ボリュームアップシャンプーを使えば髪質が良くなるのではないだろうか」を Plan として保存する
- **THEN** その Plan が当日の `day_key` つきで保存され、コーナーに表示される

#### Scenario: 完走後の目標には Plan を書けない

- **WHEN** 完走した目標に対し Plan を作成しようとする
- **THEN** リクエストは拒否され、Plan は作成されない

#### Scenario: 本文が空の Plan は作れない

- **WHEN** 本文を空白のみにして Plan を保存しようとする
- **THEN** バリデーションで拒否される

### Requirement: 1つの Plan に Check を複数ぶら下げられる

システムは、1つの Plan に対し **0個以上の Check**（答え合わせ）をぶら下げられなければならない（MUST）。**Check を1つも持たない Plan も作成できる** SHALL（方針だけを書く場合。例:「ブログはやめる。反応が薄いから」）。Check は必ずいずれかの Plan に属する SHALL とし、Plan から独立した Check を作ってはならない（MUST NOT）。

#### Scenario: Plan に Check を2つぶら下げる

- **WHEN** 1つの Plan に対し写真 Check と質問 Check を追加して保存する
- **THEN** 両方がその Plan に属する Check として保存される

#### Scenario: Check なしの Plan を作れる

- **WHEN** Check を1つも追加せずに Plan を保存する
- **THEN** Plan 単体で保存され、沿革に載る

### Requirement: Check は種類と「いつ」の独立した2軸を持つ

Check は **種類** と **いつ** の2つの軸を持ち、**両者は独立** SHALL する。種類が「いつ」を決めてはならない（MUST NOT）。

- **種類**: `photo`（📷 写真を投稿する）または `question`（💬 質問に答える）
  - `photo` は**先指定キャプション**（非空）を持つ SHALL。これは提出画像の保存キャプションとなり、後から変更してはならない（MUST NOT）。
  - `question` は**先に書いた質問文**（非空）を持つ SHALL。
- **いつ**: `single`（単発＝ある1日）または `range`（範囲＝開始日から N 日間・毎日）
  - `single` は `start_day_key` を持つ SHALL（相対指定「3日後」・絶対指定「7/18」のいずれで入力しても固定 day_key へ解決する）。
  - `range` は `start_day_key` と `span_days`（≧2）を持つ SHALL。

`photo × range`（毎日写真を撮って変化を追う）・`question × single`（一度だけ答える）を含む**全4通りの組み合わせを作成できる** SHALL。

加えて Check は任意の **場所メモ**（`place_note`）と **時刻メモ**（`time_note`）を持てる SHALL。これらは**説明メタデータであり、達成判定に一切用いてはならない**（MUST NOT）。

#### Scenario: 写真×範囲の Check を作れる

- **WHEN** 種類=📷写真・キャプション「前髪・正面」、いつ=範囲・3日後から7日間 の Check を作成する
- **THEN** その Check が `kind=photo`・`schedule=range`・`span_days=7` として保存される

#### Scenario: 質問×単発の Check を作れる

- **WHEN** 種類=💬質問・質問文「使用感はどうだった？」、いつ=単発・3日後 の Check を作成する
- **THEN** その Check が `kind=question`・`schedule=single` として保存される

#### Scenario: 種類を変えても「いつ」の選択肢は変わらない

- **WHEN** Check フォームで種類を📷写真から💬質問へ切り替える
- **THEN** 「いつ」のトグル（単発／範囲）とその入力値は影響を受けない

#### Scenario: 場所・時刻メモは判定に使われない

- **WHEN** 場所メモ「洗面所」・時刻メモ「朝」を持つ写真 Check に、深夜に別の場所で撮った写真を提出する
- **THEN** その Check は達成として扱われる（メモは判定に用いない）

#### Scenario: 写真 Check のキャプションは後から変更できない

- **WHEN** 作成済みの写真 Check のキャプションを変更しようとする
- **THEN** リクエストは拒否される

### Requirement: 日記は Plan / Check とは独立に保存する

振り返りタブの目標コーナーの **日記**（自由記入）は、既存の `goal-journal` のまま `Plan` / `Check` とは独立に保存 SHALL する。日記の本文は Plan にも Check にも紐づかない SHALL。

#### Scenario: 日記だけを書いて保存できる

- **WHEN** Plan を作らず日記本文だけを書いて保存する
- **THEN** 日記が保存され、Plan は作成されない

### Requirement: 理由つき取り下げ

システムは、Plan および Check を **理由テキスト（非空）を伴って取り下げ** できる SHALL。

- **Check の取り下げ**: その Check は `cancelled` となり、以後ゲートに参加しない SHALL。
- **Plan の取り下げ**: その Plan は `withdrawn` となり、**ぶら下がる未達の Check がすべて `cancelled` になる** SHALL。
- 取り下げた Plan / Check は**沿革から消してはならない**（MUST NOT）。理由テキストとともに残す SHALL。
- 理由が空の取り下げは拒否 SHALL する（MUST NOT）。
- 既に達成済み（`satisfied`）の Check は取り下げられない SHALL。

#### Scenario: 理由つきで Check を取り下げるとゲートから外れる

- **WHEN** 未達の写真 Check を理由「シャンプーが肌に合わず返品した」つきで取り下げる
- **THEN** その Check は `cancelled` となりゲートに参加しなくなり、沿革には理由つきで残る

#### Scenario: Plan を取り下げるとぶら下がる Check も外れる

- **WHEN** 未達の Check を2つ持つ Plan を理由つきで取り下げる
- **THEN** Plan は `withdrawn`、2つの Check は `cancelled` となり、いずれも沿革に残る

#### Scenario: 理由なしの取り下げは拒否される

- **WHEN** 理由テキストを空にして取り下げようとする
- **THEN** リクエストは拒否され、状態は変わらない

#### Scenario: 達成済みの Check は取り下げられない

- **WHEN** 既に写真を提出した Check を取り下げようとする
- **THEN** リクエストは拒否される
