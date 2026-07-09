## Context

Time is captured per browser **tab group** and stored raw in `daily_totals_snapshot(day_key, stable_group_id, ms)`. A second layer, **category**, buckets groups via `group_category_mapping` and carries `counts_toward_total` + WORK/AWAY `kind`. Totals (`categoryTotalsForDay` in `services/categories.ts`) only sum categories flagged `counts_toward_total = 1`; the seeded `uncategorized` is 0, and unmapped groups fall into it — producing the 0m-total bug. Rules/gate (`rules/rules.ts`, `rules/evaluate.ts`) evaluate a `CATEGORY` condition target against category totals. This is a single-user local app (Fastify + `tsx`, vanilla-JS SPA, `better-sqlite3` with a `user_version`-based migration list). The user wants the category layer gone; tab groups alone drive totals and rules.

## Goals / Non-Goals

**Goals:**
- Total work time = sum of all groups (incl. `ungrouped`), fixing the 0m total.
- Rules target a specific tab group (`GROUP`) instead of a category.
- Remove the category management UI and its endpoints; add `GET /api/groups`.
- Keep the migration non-destructive and the existing DB usable.

**Non-Goals:**
- Dropping `category` / `group_category_mapping` tables or the `category_key` snapshot columns (left dormant).
- Changing the browser extension, the divide-by-N capture math, or the timeline feature beyond removing its category picker.
- Merging the gate and rule-editing tabs (that is a separate change, `merge-gate-rules`).

## Decisions

- **Dormant tables over destructive drop.** Add migration v4 that only `ALTER TABLE rule_condition ADD COLUMN stable_group_id` and drops legacy `CATEGORY` conditions. Leave `category` / `group_category_mapping` and `category_key` columns in place. Rationale: in a local single-user DB, dropping buys no space/perf and risks FK breakage (`group_category_mapping → category`, snapshot columns on `session`/`activity_log_entry`); SQLite drops are irreversible. *Alternative considered:* full drop — rejected as higher-risk for zero benefit.
- **Freeze triggers bracketed around the cleanup delete.** The v2 `rule_condition` freeze triggers ABORT UPDATE/DELETE on frozen/past rows. The v4 migration must `DROP TRIGGER` (all three), `DELETE FROM rule_condition WHERE target='CATEGORY'`, then recreate the triggers verbatim. *Alternative:* delete only future-editable rows — rejected because legacy category conditions can exist on frozen days and would linger.
- **Gut `categories.ts` rather than delete it.** Many modules import from it; replace its contents with `totalWorkMsForDay` / `totalWorkSecondsForDay` (a single `SUM(ms)` over `daily_totals_snapshot`). Keeps the import graph stable. *Alternative:* move the helper into `summary.ts` and delete the file — cleaner but touches every importer; deferred.
- **`GROUP` replaces `CATEGORY` in the rule domain.** `RuleTarget` becomes `'GROUP'|'TOTAL_WORK'|'MANUAL_CHECK'|'PLANNING'`; `rule_condition` reads `stable_group_id`; `evaluate.ts` sums `daily_totals_snapshot` for that group/day. `RuleTarget` lives only server-side, so the `packages/contract` package needs no change.
- **Add `GET /api/groups`.** The rule editor's group picker needs a date-independent group list (`SELECT stable_group_id, name, color FROM tab_group`). Reusing `daySummary().groups` would tie the picker to a specific day.

## Risks / Trade-offs

- **Migration transaction abort if triggers not dropped first** → bracket the delete with DROP/CREATE TRIGGER; verify with `npm test` (db suite) on a copy of the DB.
- **Behavior change: `ungrouped` now counts toward total** (previously excluded) → accepted per user decision; if ever undesired, add `AND stable_group_id <> 'ungrouped'` to the sum.
- **7-day stacked bar breaks silently if `RangeDay` changes without the dashboard** → update `summary.ts` `RangeDay` and `dashboard.js` in lockstep.
- **Timeline manual-entry editor calls the removed `/api/categories`** → drop its category `<select>` and stop sending `categoryKey` (server defaults to `'uncategorized'`).
- **Non-final past days with only `CATEGORY` conditions may become permanently LOCKED** after those conditions are dropped → acceptable for a single-user dev DB; `is_final=1` snapshots are untouched so closed days do not relock.

## Migration Plan

1. Ship migration v4 (additive column + bracketed legacy-condition cleanup).
2. Stop seeding categories (`db/index.ts`); rework totals, summary, rules engine, API routes (server first, `npm run typecheck` gating each step).
3. Update frontend (remove categories tab, dashboard/rules/gate/timeline edits, `api.js`).
4. Update tests; run `npm run typecheck` + `npm test`.
5. Rollback: revert code; the dormant tables and additive column make the DB forward/backward compatible except for the already-deleted legacy `CATEGORY` conditions (restore from a DB backup if needed). Back up the SQLite file before first run.

## Open Questions

- None outstanding. Ungrouped-in-total and group-based rule targets were confirmed with the user.
