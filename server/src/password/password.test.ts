import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { openDb, getConfig, type DB } from '../db/index.js';
import { revealPasswords, maybeAutoReveal } from './reveal.js';

const DAY = '2026-07-10';
const PREV = '2026-07-09';

function sha6(dateStr: string): string {
  return createHash('sha256').update(dateStr).digest('hex').slice(0, 6);
}

function setUnlocked(db: DB, dayKey: string, firstMetAt = Date.now()): void {
  db.prepare(
    `INSERT INTO unlock_evaluation
       (day_key, status, conditions_met, per_condition_results, first_met_at, reveal_fired, is_final, updated_at)
     VALUES (?, 'UNLOCKED', 1, '[]', ?, 0, 0, ?)
     ON CONFLICT(day_key) DO UPDATE SET status='UNLOCKED', first_met_at=excluded.first_met_at`,
  ).run(dayKey, firstMetAt, Date.now());
}

let db: DB;
beforeEach(() => {
  db = openDb(':memory:'); // 既定の PW コマンド = ref/gen_password.ps1
});

describe('パスワード reveal（脱出弁なし）', () => {
  it('未達成では絶対に生成・表示しない（bypass 不可）', async () => {
    // unlock_evaluation を作らない = LOCKED。
    const res = await revealPasswords(db, DAY);
    expect(res.unlocked).toBe(false);
    expect(res.entries).toHaveLength(0);
    // ログにも成功記録が残らない。
    const logs = db.prepare('SELECT COUNT(*) AS c FROM revealed_password_log').get() as { c: number };
    expect(logs.c).toBe(0);
  });

  it(
    '達成時は前日+当日の2候補を生成する',
    async () => {
      setUnlocked(db, DAY);
      const res = await revealPasswords(db, DAY);
      expect(res.unlocked).toBe(true);
      expect(res.entries).toHaveLength(2);
      const today = res.entries.find((e) => e.role === 'TODAY')!;
      const yesterday = res.entries.find((e) => e.role === 'YESTERDAY')!;
      expect(today.targetDate).toBe(DAY);
      expect(yesterday.targetDate).toBe(PREV);
      // 実際に ref/gen_password.ps1 が走り、決定的な6桁hexを返す。
      expect(today.ok).toBe(true);
      expect(today.password).toBe(sha6(DAY));
      expect(yesterday.password).toBe(sha6(PREV));
    },
    20_000,
  );

  it(
    '平文は永続化されない（salted sha256 のみログ）',
    async () => {
      setUnlocked(db, DAY);
      const res = await revealPasswords(db, DAY);
      const plain = res.entries.find((e) => e.role === 'TODAY')!.password!;
      const salt = getConfig(db).password_hash_salt;
      expect(salt.length).toBeGreaterThan(0);

      const rows = db.prepare('SELECT * FROM revealed_password_log').all() as Record<string, unknown>[];
      expect(rows.length).toBe(2);
      for (const row of rows) {
        // どの列にも平文が入っていない。
        for (const v of Object.values(row)) {
          expect(String(v)).not.toBe(plain);
        }
      }
      const todayRow = rows.find((r) => r.role === 'TODAY')!;
      // 記録は salted sha256 と一致（平文とは一致しない）。
      expect(todayRow.password_sha256).toBe(
        createHash('sha256').update(`${salt}:${plain}`).digest('hex'),
      );
      expect(todayRow.password_sha256).not.toBe(plain);
    },
    20_000,
  );

  it(
    'コマンド失敗（存在しない実行体）はエラーで、パスワードを返さない',
    async () => {
      setUnlocked(db, DAY);
      db.prepare('UPDATE password_command_config SET command_template = ? WHERE is_active = 1').run(
        'definitely-not-a-real-cmd-xyz {date}',
      );
      const res = await revealPasswords(db, DAY);
      expect(res.unlocked).toBe(true);
      expect(res.missing).toBe(true);
      for (const e of res.entries) {
        expect(e.ok).toBe(false);
        expect(e.password).toBeNull();
        expect(e.error).toBeTruthy();
      }
      // 失敗はログに ok=0・hash NULL で残る（捏造しない）。
      const rows = db.prepare('SELECT ok, password_sha256 FROM revealed_password_log').all() as {
        ok: number;
        password_sha256: string | null;
      }[];
      expect(rows.every((r) => r.ok === 0 && r.password_sha256 === null)).toBe(true);
    },
    20_000,
  );

  it(
    '自動 reveal は一度だけ発火する（reveal_fired）',
    async () => {
      setUnlocked(db, DAY);
      await maybeAutoReveal(db, DAY);
      const after1 = db.prepare('SELECT reveal_fired FROM unlock_evaluation WHERE day_key = ?').get(DAY) as {
        reveal_fired: number;
      };
      expect(after1.reveal_fired).toBe(1);
      const count1 = (db.prepare('SELECT COUNT(*) AS c FROM revealed_password_log').get() as { c: number }).c;
      // 二度目は何もしない。
      await maybeAutoReveal(db, DAY);
      const count2 = (db.prepare('SELECT COUNT(*) AS c FROM revealed_password_log').get() as { c: number }).c;
      expect(count2).toBe(count1);
    },
    20_000,
  );
});
