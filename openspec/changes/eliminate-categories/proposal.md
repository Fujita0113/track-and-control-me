## Why

The app currently has two layered concepts — tab **groups** (raw capture unit) and **categories** (a semantic bucket that groups map to). Categories add real cognitive and mechanical overhead: they own the `counts_toward_total` flag, WORK/AWAY classification, and the gate's rule targets. The concrete symptom is that the dashboard shows nonzero minutes per group/category yet a **総作業時間 of 0m**, because unmapped groups fall into the seeded `uncategorized` category (`counts_toward_total: 0`). The user does not want to classify activity — tab groups alone are sufficient.

## What Changes

- **BREAKING**: Remove the **category** concept end-to-end. Tab groups become the only classification unit.
- **総作業時間 = sum of all groups, always** — including the `ungrouped` pseudo-group. The `counts_toward_total` / WORK-AWAY filtering is dropped, which fixes the 0m total.
- **BREAKING**: Gate unlock rules replace the `CATEGORY` condition target with a `GROUP` target ("specific tab group ≥ N minutes"). `TOTAL_WORK`, `MANUAL_CHECK`, `PLANNING` targets stay. Legacy `CATEGORY` conditions are dropped by migration.
- Remove the **カテゴリ / マッピング** management tab and its `/api/categories` + `/api/mappings` endpoints. Add `GET /api/groups` to list tab groups for the rule editor.
- Dashboard: relabel "グループ別 (divide-by-N)" → "グループ別", remove the category doughnut and category-breakdown card, and switch the 7-day stacked bar from per-category to per-group.
- DB: additive migration (v4) adds `rule_condition.stable_group_id` and drops legacy category conditions; `category` / `group_category_mapping` tables and category columns are left **dormant** (not dropped) to avoid FK breakage in a single-user local DB.

## Capabilities

### New Capabilities
- `work-time-summary`: How daily total work time and the dashboard breakdown are computed and displayed from tab groups only (total = sum of all groups incl. ungrouped; no category layer).
- `unlock-rule-conditions`: The set of gate unlock rule condition targets and how each is evaluated, with time-based activity conditions targeting a specific tab group instead of a category.

### Modified Capabilities
<!-- No pre-existing specs in openspec/specs/; nothing to modify. -->

## Impact

- **Server**: `db/migrations.ts` (v4), `db/index.ts` (stop seeding categories), `services/categories.ts` (gut to group-sum totals), `services/summary.ts` (DaySummary/RangeDay group-based), `rules/rules.ts` + `rules/evaluate.ts` (GROUP target), `api/index.ts` (remove category/mapping routes, add `/api/groups`).
- **Frontend**: `static/index.html`, `static/js/main.js` (drop categories tab), `static/js/api.js` (drop category calls, add `getGroups`), `dashboard.js`, `rules.js`, `gate.js`, `timeline.js` (manual-entry category select removed); delete `static/js/categories.js`.
- **Tests**: `rules.test.ts`, `planning.test.ts`, `db.test.ts` (remove category seed/mapping assumptions).
- **Behavior change**: `ungrouped` time now counts toward the total (previously excluded). Non-final past days that had only `CATEGORY` conditions may become permanently LOCKED after those conditions are dropped — acceptable for a single-user dev DB.
- **Not affected**: browser extension (no category references); `category_key` snapshot columns on `session` / `activity_log_entry` remain dormant.
