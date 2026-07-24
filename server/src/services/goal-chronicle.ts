import type { DB } from '../db/index.js';
import { getConfig } from '../db/index.js';
import type { Chronicle, ChronicleEntry, RuleAnswer, RuleChangeEntry } from '@track/contract';
import { dayKeyFor } from '../aggregation/index.js';
import { GoalNotFoundError } from './goal-errors.js';
import { dayDiff } from './day-key.js';
import { resolveGroupDisplay } from './group-identity.js';
import type { RuleRow, RuleTarget } from './rule-registry.js';

/**
 * 沿革（⑤）の読み取りモデル（spec: goal-chronicle）。
 *
 * 沿革は「Plan の入れ子」から「`rule_change` の時系列年表」へ再構成された（design.md Migration
 * Plan 2）。目標に紐づく（`goal_rule`）各ルールの操作（追加・変更・削除）を `day_key` 昇順・同日内は
 * 記録順で並べる。写真ルール・質問ルールの `op='add'` エントリには、そのルールの答え合わせ全件が
 * ぶら下がる（提出画像・Q&A）。日記（goal_journal）は引かない（載る／載らないの線引きは「大きさ」
 * ではなく「検証がぶら下がる構造に属するか」で決まる）。
 */

interface RuleChangeRow {
  id: number;
  rule_id: number;
  day_key: string;
  op: 'add' | 'update' | 'remove';
  before: string | null;
  after: string | null;
  reason: string;
  created_at: number;
}
interface RuleAnswerRow {
  id: number;
  rule_id: number;
  day_key: string;
  image_id: number | null;
  answer_text: string | null;
  created_at: number;
}
interface GoalRow {
  start_day: string;
  lifecycle_choice: string | null;
  lifecycle_reason: string | null;
  lifecycle_decided_at: number | null;
}

function dayNumberOf(startDay: string, dayKey: string): number {
  return dayDiff(startDay, dayKey) + 1;
}

/** goal.lifecycle_decided_at（epoch ms）を day_key へ解決する（app_config の tz/day_boundary 準拠）。 */
function endedDayKey(db: DB, goal: GoalRow): string {
  const cfg = getConfig(db);
  return dayKeyFor(goal.lifecycle_decided_at ?? Date.now(), cfg.tz, cfg.day_boundary_minutes);
}

/** ルールの表示ラベル（現在値から都度解決・design D1「グループ改名でも…ラベルだけ更新される」）。 */
function ruleLabel(db: DB, rule: RuleRow): string {
  if (rule.target === 'TOTAL_WORK') return '総作業時間';
  if (rule.target === 'GROUP') {
    const gd = resolveGroupDisplay(db, rule);
    return gd.needsReset ? `${gd.name}（要再設定）` : gd.name;
  }
  if (rule.target === 'TIMELINE') return rule.label ?? 'カテゴリ';
  if (rule.target === 'MANUAL_CHECK') return rule.label ?? '手動チェック';
  if (rule.target === 'PLANNING') return rule.signal_key ?? '翌日計画';
  if (rule.target === 'PHOTO') return rule.caption ?? '写真';
  return rule.question_text ?? '質問'; // QUESTION
}

function toChangeEntry(r: RuleChangeRow, startDay: string, untilDayKey?: string): RuleChangeEntry | null {
  if (untilDayKey && r.day_key > untilDayKey) return null;
  return {
    id: r.id,
    ruleId: r.rule_id,
    dayKey: r.day_key,
    dayNumber: dayNumberOf(startDay, r.day_key),
    op: r.op,
    before: r.before ? (JSON.parse(r.before) as Record<string, unknown>) : null,
    after: r.after ? (JSON.parse(r.after) as Record<string, unknown>) : null,
    reason: r.reason,
    createdAt: r.created_at,
  };
}

function toAnswer(r: RuleAnswerRow, startDay: string): RuleAnswer {
  return {
    id: r.id,
    ruleId: r.rule_id,
    dayKey: r.day_key,
    dayNumber: dayNumberOf(startDay, r.day_key),
    imageId: r.image_id,
    answerText: r.answer_text,
    createdAt: r.created_at,
  };
}

/**
 * 沿革（⑤）を組み立てる。`untilDayKey` を渡すと、その日までに実際に起きたことだけを返す
 * （走行中プレビューが未来を見せないため・①カレンダーの未到来＝空白と同じ理由）。
 */
export function getChronicle(db: DB, goalId: number, untilDayKey?: string): Chronicle {
  const goal = db
    .prepare('SELECT start_day, lifecycle_choice, lifecycle_reason, lifecycle_decided_at FROM goal WHERE id = ?')
    .get(goalId) as GoalRow | undefined;
  if (!goal) throw new GoalNotFoundError(goalId);

  const ruleIds = (
    db.prepare('SELECT rule_id FROM goal_rule WHERE goal_id = ?').all(goalId) as { rule_id: number }[]
  ).map((r) => r.rule_id);

  const entries: ChronicleEntry[] = [];
  if (ruleIds.length > 0) {
    const placeholders = ruleIds.map(() => '?').join(', ');
    const rules = new Map(
      (db.prepare(`SELECT * FROM rule WHERE id IN (${placeholders})`).all(...ruleIds) as RuleRow[]).map((r) => [
        r.id,
        r,
      ]),
    );
    const changes = db
      .prepare(`SELECT * FROM rule_change WHERE rule_id IN (${placeholders}) ORDER BY day_key, id`)
      .all(...ruleIds) as RuleChangeRow[];
    const answersByRule = new Map<number, RuleAnswerRow[]>();
    for (const id of ruleIds) {
      const rows = db
        .prepare('SELECT * FROM rule_answer WHERE rule_id = ? ORDER BY day_key, id')
        .all(id) as RuleAnswerRow[];
      if (rows.length) answersByRule.set(id, rows);
    }
    const addSeen = new Set<number>(); // ruleId ごとに最初の 'add' エントリへだけ答えを積む。

    for (const r of changes) {
      const change = toChangeEntry(r, goal.start_day, untilDayKey);
      if (!change) continue;
      const rule = rules.get(r.rule_id);
      if (!rule) continue; // 参照整合性は FK が担保するので通常起きない。
      const target: RuleTarget = rule.target;
      const isFirstAdd = r.op === 'add' && !addSeen.has(r.rule_id);
      if (isFirstAdd) addSeen.add(r.rule_id);
      const answers =
        isFirstAdd && (target === 'PHOTO' || target === 'QUESTION')
          ? (answersByRule.get(r.rule_id) ?? [])
              .filter((a) => !untilDayKey || a.day_key <= untilDayKey)
              .map((a) => toAnswer(a, goal.start_day))
          : [];
      entries.push({ ruleId: r.rule_id, target, label: ruleLabel(db, rule), change, answers });
    }
  }

  const endedNote =
    goal.lifecycle_choice === 'ended' && goal.lifecycle_reason && goal.lifecycle_reason.trim()
      ? {
          reason: goal.lifecycle_reason,
          dayNumber: dayNumberOf(goal.start_day, endedDayKey(db, goal)),
        }
      : null;

  return { goalId, entries, endedNote };
}
