import { createHash, randomBytes } from 'node:crypto';
import type { DB } from '../db/index.js';
import { getConfig, updateConfig } from '../db/index.js';
import { prevDayKey } from '../aggregation/index.js';
import { getEvaluation, markRevealFired } from '../rules/evaluate.js';
import { runPasswordCommand, type PasswordCommandConfigRow } from './command.js';

/**
 * reveal フロー（design.md D8 / spec: password-gate）。
 * - 達成（UNLOCKED）のときだけ生成。未達成では絶対に返さない（脱出弁なし）。
 * - 前日+当日の2候補を生成。
 * - 平文は永続化しない（salted sha256 のみログ）。UI へは一時的に平文を返す。
 */

export type PasswordRole = 'TODAY' | 'YESTERDAY';

export interface RevealedEntry {
  role: PasswordRole;
  targetDate: string;
  ok: boolean;
  password: string | null; // UI 表示用（永続化しない）
  error?: string;
}

export interface RevealResult {
  unlocked: boolean;
  dayKey: string;
  entries: RevealedEntry[];
  missing: boolean; // 片方でも失敗したか
  reason?: string; // unlocked=false のときの理由
}

function activeCommand(db: DB): PasswordCommandConfigRow | undefined {
  return db
    .prepare('SELECT * FROM password_command_config WHERE is_active = 1 ORDER BY version DESC, id DESC LIMIT 1')
    .get() as PasswordCommandConfigRow | undefined;
}

function ensureSalt(db: DB): string {
  const cfg = getConfig(db);
  if (cfg.password_hash_salt && cfg.password_hash_salt.length > 0) return cfg.password_hash_salt;
  const salt = randomBytes(16).toString('hex');
  updateConfig(db, { password_hash_salt: salt });
  return salt;
}

function saltedHash(salt: string, password: string): string {
  return createHash('sha256').update(`${salt}:${password}`).digest('hex');
}

/**
 * 達成日 dayKey のパスワードを生成して返す。未達成なら空で返す（脱出弁なし）。
 * auto=true は「達成瞬間の自動発火」。
 */
export async function revealPasswords(
  db: DB,
  dayKey: string,
  opts: { auto?: boolean; nowMs?: number } = {},
): Promise<RevealResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const evaluation = getEvaluation(db, dayKey);

  // 脱出弁なし: UNLOCKED（latch 済み）でなければ何も生成しない（task 5.4）。
  if (!evaluation || evaluation.status !== 'UNLOCKED' || evaluation.firstMetAt === null) {
    return {
      unlocked: false,
      dayKey,
      entries: [],
      missing: true,
      reason: '未達成のためパスワードは表示できません',
    };
  }

  const cmd = activeCommand(db);
  if (!cmd) {
    return { unlocked: true, dayKey, entries: [], missing: true, reason: 'パスワードコマンド未設定' };
  }

  const salt = ensureSalt(db);
  const cfg = getConfig(db);
  const targets: { role: PasswordRole; date: string }[] = [{ role: 'TODAY', date: dayKey }];
  if (cfg.reveal_yesterday === 1) {
    targets.push({ role: 'YESTERDAY', date: prevDayKey(dayKey) });
  }

  const logStmt = db.prepare(
    `INSERT INTO revealed_password_log
       (revealed_at, target_date, role, password_sha256, command_config_id, exit_code, ok, auto_fired, note)
     VALUES (@at, @date, @role, @hash, @cfg, @exit, @ok, @auto, @note)`,
  );

  const entries: RevealedEntry[] = [];
  let missing = false;
  for (const t of targets) {
    const res = await runPasswordCommand(cmd, t.date);
    // 平文は保存しない: 成功時のみ salted sha256 を記録。
    logStmt.run({
      at: nowMs,
      date: t.date,
      role: t.role,
      hash: res.ok && res.password ? saltedHash(salt, res.password) : null,
      cfg: cmd.id,
      exit: res.exitCode,
      ok: res.ok ? 1 : 0,
      auto: opts.auto ? 1 : 0,
      note: res.error ?? null,
    });
    if (!res.ok) missing = true;
    entries.push({
      role: t.role,
      targetDate: t.date,
      ok: res.ok,
      password: res.password, // UI 表示用（呼び出し側で速やかに破棄）
      ...(res.error ? { error: res.error } : {}),
    });
  }

  return { unlocked: true, dayKey, entries, missing };
}

/**
 * 達成瞬間の自動 reveal（一度だけ）。pipeline の justUnlocked から呼ぶ。
 * reveal_fired フラグで二重発火を防ぐ。平文は破棄（自動発火はログのみ）。
 */
export async function maybeAutoReveal(db: DB, dayKey: string, nowMs = Date.now()): Promise<void> {
  const evaluation = getEvaluation(db, dayKey);
  if (!evaluation || evaluation.status !== 'UNLOCKED') return;
  if (evaluation.revealFired) return;
  await revealPasswords(db, dayKey, { auto: true, nowMs });
  markRevealFired(db, dayKey);
}
