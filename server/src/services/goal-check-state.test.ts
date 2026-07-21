import { describe, it, expect } from 'vitest';
import {
  isCheckActiveOn,
  isCheckMetOn,
  isCheckDueOn,
  rangeDayNumber,
  checkConditionKey,
  checkLabel,
  type CheckState,
} from './goal-check-state.js';

/**
 * Check の状態導出（design D2・D3）。
 * ★日付が絡む挙動（繰り越し・期間・取り下げ後の無効化）はここで固める。e2e では扱わない。
 */

const single: CheckState = {
  schedule: 'single',
  startDayKey: '2026-07-18',
  spanDays: null,
  status: 'active',
  planWithdrawn: false,
};
// 7/18〜7/24 の7日間。
const range: CheckState = {
  schedule: 'range',
  startDayKey: '2026-07-18',
  spanDays: 7,
  status: 'active',
  planWithdrawn: false,
};

describe('単発Check: 達成するまで繰り越す', () => {
  it('開始日前は有効にならない（仕掛けた直後はゲートに影響しない）', () => {
    expect(isCheckActiveOn(single, '2026-07-15')).toBe(false);
    expect(isCheckActiveOn(single, '2026-07-17')).toBe(false);
    expect(isCheckActiveOn(single, '2026-07-18')).toBe(true);
  });

  it('未提出のまま日をまたいでもロックが解けない（上限なしで有効・未達が続く）', () => {
    for (const day of ['2026-07-18', '2026-07-19', '2026-07-20', '2026-08-30']) {
      expect(isCheckActiveOn(single, day)).toBe(true);
      expect(isCheckMetOn(single, [], day)).toBe(false);
      expect(isCheckDueOn(single, [], day)).toBe(true);
    }
  });

  it('提出した日以降はずっと met（繰り越し＝latch と整合）', () => {
    const results = ['2026-07-20']; // 2日遅れて提出。
    expect(isCheckMetOn(single, results, '2026-07-18')).toBe(false); // 提出前の日は未達のまま。
    expect(isCheckMetOn(single, results, '2026-07-19')).toBe(false);
    expect(isCheckMetOn(single, results, '2026-07-20')).toBe(true);
    expect(isCheckMetOn(single, results, '2026-07-21')).toBe(true);
    expect(isCheckMetOn(single, results, '2026-12-31')).toBe(true);
  });

  it('単発は rangeDayNumber を持たない', () => {
    expect(rangeDayNumber(single, '2026-07-18')).toBeNull();
  });
});

describe('範囲Check: その日限り・繰り越さない・期間後は消える', () => {
  it('期間内の各日だけ有効', () => {
    expect(isCheckActiveOn(range, '2026-07-17')).toBe(false); // 開始前
    expect(isCheckActiveOn(range, '2026-07-18')).toBe(true); // 初日
    expect(isCheckActiveOn(range, '2026-07-24')).toBe(true); // 最終日（start+6）
    expect(isCheckActiveOn(range, '2026-07-25')).toBe(false); // 期間終了後は消える
  });

  it('サボった日は翌日へ繰り越さない（7/21 は 7/21 の分のみ要求）', () => {
    const results = ['2026-07-18', '2026-07-19']; // 7/20 をサボった。
    expect(isCheckMetOn(range, results, '2026-07-20')).toBe(false); // 7/20 は未達のまま履歴に残る。
    // 7/21 に提出すれば 7/21 は開く（7/20 の負債は持ち越されない）。
    expect(isCheckMetOn(range, [...results, '2026-07-21'], '2026-07-21')).toBe(true);
  });

  it('各日が独立してゲートを閉じる（前日の達成は今日を助けない）', () => {
    const results = ['2026-07-18'];
    expect(isCheckMetOn(range, results, '2026-07-18')).toBe(true);
    expect(isCheckMetOn(range, results, '2026-07-19')).toBe(false);
    expect(isCheckDueOn(range, results, '2026-07-19')).toBe(true);
  });

  it('期間を過ぎたら未提出日があってもゲートに現れない', () => {
    const results = ['2026-07-18']; // 6日サボったが…
    expect(isCheckDueOn(range, results, '2026-07-25')).toBe(false);
    expect(isCheckActiveOn(range, '2026-07-25')).toBe(false);
  });

  it('N日中の何日目かを返す（期間外は null）', () => {
    expect(rangeDayNumber(range, '2026-07-18')).toBe(1);
    expect(rangeDayNumber(range, '2026-07-21')).toBe(4);
    expect(rangeDayNumber(range, '2026-07-24')).toBe(7);
    expect(rangeDayNumber(range, '2026-07-25')).toBeNull();
    expect(rangeDayNumber(range, '2026-07-17')).toBeNull();
  });

  it('span=2 の最小範囲', () => {
    const two: CheckState = { ...range, spanDays: 2 };
    expect(isCheckActiveOn(two, '2026-07-19')).toBe(true);
    expect(isCheckActiveOn(two, '2026-07-20')).toBe(false);
  });

  it('月をまたぐ範囲でも境界が正しい', () => {
    const across: CheckState = { ...range, startDayKey: '2026-07-29', spanDays: 5 }; // 7/29〜8/2
    expect(isCheckActiveOn(across, '2026-08-02')).toBe(true);
    expect(isCheckActiveOn(across, '2026-08-03')).toBe(false);
    expect(rangeDayNumber(across, '2026-08-01')).toBe(4);
  });
});

describe('取り下げ後は無効化される', () => {
  it('Check 単体の取り下げでゲートから外れる', () => {
    const cancelled: CheckState = { ...single, status: 'cancelled' };
    expect(isCheckActiveOn(cancelled, '2026-07-18')).toBe(false);
    expect(isCheckDueOn(cancelled, [], '2026-07-19')).toBe(false);
  });

  it('Plan ごとの取り下げで配下の Check がゲートから外れる', () => {
    const orphaned: CheckState = { ...range, planWithdrawn: true };
    expect(isCheckActiveOn(orphaned, '2026-07-18')).toBe(false);
    expect(isCheckDueOn(orphaned, [], '2026-07-18')).toBe(false);
  });
});

describe('合成条件のキーとラベル', () => {
  it('check: 名前空間を使う', () => {
    expect(checkConditionKey(42)).toBe('check:42');
  });

  it('ラベルは写真＝キャプション／質問＝質問文', () => {
    expect(checkLabel('photo', '前髪・正面', '')).toBe('前髪・正面');
    expect(checkLabel('question', '', '使用感はどうだった？')).toBe('使用感はどうだった？');
  });
});
