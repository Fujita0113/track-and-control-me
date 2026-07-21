import type { CheckKind, CheckSchedule, CheckStatus } from '@track/contract';
import { addDaysKey } from './day-key.js';

/**
 * Check の状態導出（spec: goal-check-gate / design.md D2・D3）。
 *
 * **状態は永続化しない。** 「対象日に有効か」「met か」は (check, dayKey) から毎回導出する。
 * 状態を持つと日次 cron での遷移が必要になり、オンデマンド起動（README の運用メモ）で壊れるため。
 * 永続するのは終端の `cancelled` / `withdrawn` のみ（D9）。
 *
 * 単発（single）と範囲（range）の意味論の違いは、下の導出式**だけ**から生まれる（D3）。
 * 追加の分岐は要らない:
 *   single … 有効期間に上限が無く、met は「提出日以降ずっと true」 → 達成するまで**繰り越す**
 *   range  … 有効期間が [start, start+span) に限られ、met はその日の result のみを見る
 *            → サボった日は**繰り越さず**、期間を過ぎれば消える
 *
 * この非対称は意図の違い（「遅れてでも出す価値がある一点」vs「その日の姿は後から撮れない」）が
 * そのままデータの形に落ちたもの。
 */

/** 導出に必要な Check の最小形（DB 行・テストのリテラルどちらも渡せる）。 */
export interface CheckState {
  schedule: CheckSchedule;
  startDayKey: string;
  /** schedule=range のとき期間日数（>= 2）。single は null。 */
  spanDays: number | null;
  status: CheckStatus;
  /** 所属 Plan が取り下げ済みか（Plan の取り下げは配下 Check を無効化する）。 */
  planWithdrawn: boolean;
}

/**
 * 対象日に**有効**か（＝その日のゲートに合流するか）。
 * 取り下げ済み（Check 単体 / Plan ごと）は常に無効。
 * `start_day_key` より前は無効＝仕掛けた直後はゲートに何の影響もない。
 */
export function isCheckActiveOn(check: CheckState, dayKey: string): boolean {
  if (check.status === 'cancelled') return false;
  if (check.planWithdrawn) return false;
  if (dayKey < check.startDayKey) return false;
  if (check.schedule === 'single') return true; // 上限なし＝達成するまで毎日合流（繰り越し）。
  // range: [start, start+span) の各日のみ。期間を過ぎたら消える（繰り越さない）。
  const end = addDaysKey(check.startDayKey, Math.max(0, check.spanDays ?? 0));
  return dayKey < end;
}

/**
 * 対象日に **met**（達成）か。
 *   single … 回答が1件でもあり、その day_key <= dayKey（提出日以降ずっと met＝latch と整合）
 *   range  … その dayKey ちょうどの回答があるか（前日の達成は今日を助けない）
 * `resultDayKeys` は当該 Check の回答日（順不同）。
 */
export function isCheckMetOn(check: CheckState, resultDayKeys: readonly string[], dayKey: string): boolean {
  if (check.schedule === 'single') return resultDayKeys.some((d) => d <= dayKey);
  return resultDayKeys.some((d) => d === dayKey);
}

/**
 * 対象日に「回答すべき」か＝有効かつ未達。今日タブの不足条件・初回トーストの母集合。
 */
export function isCheckDueOn(check: CheckState, resultDayKeys: readonly string[], dayKey: string): boolean {
  return isCheckActiveOn(check, dayKey) && !isCheckMetOn(check, resultDayKeys, dayKey);
}

/**
 * 範囲Check の「N日中の何日目か」（1 始まり）。期間外・単発は null。
 * 今日タブの「7/18〜7/24 の1日目」表示に使う。
 */
export function rangeDayNumber(check: CheckState, dayKey: string): number | null {
  if (check.schedule !== 'range') return null;
  if (!isCheckActiveOn(check, dayKey)) return null;
  let n = 0;
  while (n < (check.spanDays ?? 0)) {
    if (addDaysKey(check.startDayKey, n) === dayKey) return n + 1;
    n++;
  }
  return null;
}

/** 合成条件の condition_key（既存キーと衝突しない `check:` 名前空間）。 */
export function checkConditionKey(checkId: number): string {
  return `check:${checkId}`;
}

/** 今日タブ・沿革の表示ラベル＝写真はキャプション／質問は質問文。 */
export function checkLabel(kind: CheckKind, caption: string, questionText: string): string {
  return kind === 'photo' ? caption : questionText;
}
