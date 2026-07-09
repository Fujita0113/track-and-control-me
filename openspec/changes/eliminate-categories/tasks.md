## 1. Database & seed

- [x] 1.1 Add migration v4 to `server/src/db/migrations.ts`: `ALTER TABLE rule_condition ADD COLUMN stable_group_id TEXT`
- [x] 1.2 In v4, DROP the three `rule_condition` freeze triggers, `DELETE FROM rule_condition WHERE target='CATEGORY'`, then recreate the triggers verbatim from v2 (259-281)
- [x] 1.3 Remove the `category` seed block in `server/src/db/index.ts:44-61` (keep `app_config` etc.)

## 2. Server services — totals & summary

- [x] 2.1 Gut `server/src/services/categories.ts`: replace `categoryTotalsForDay` with `totalWorkMsForDay` / `totalWorkSecondsForDay` (SUM over `daily_totals_snapshot`, incl. ungrouped); delete category/mapping helpers
- [x] 2.2 `server/src/services/summary.ts`: drop `categories` from `DaySummary`; set `totalWorkSeconds` from `totalWorkSecondsForDay`; keep `groups`/`excluded`
- [x] 2.3 `summary.ts`: repurpose `rangeSummary`/`RangeDay` to per-group breakdown for the 7-day chart
- [x] 2.4 `summary.ts`: add `listGroups(db)` (`SELECT stable_group_id, name, color FROM tab_group ORDER BY last_seen_at DESC`)
- [x] 2.5 `npm run typecheck` — resolve type breaks so far

## 3. Server — rules engine

- [x] 3.1 `server/src/rules/rules.ts`: `RuleTarget = 'GROUP'|'TOTAL_WORK'|'MANUAL_CHECK'|'PLANNING'`; `RuleConditionRow`/`ConditionInput` use `stable_group_id`
- [x] 3.2 `rules.ts`: update `deriveConditionKey` (`group:${stableGroupId}`), `contentHash`, and `upsertFutureRuleSet` INSERT columns
- [x] 3.3 `server/src/rules/evaluate.ts`: import `totalWorkSecondsForDay`; replace `CATEGORY` case with `GROUP` case (SUM `daily_totals_snapshot` for group/day); rename `categoryKey`→`stableGroupId` in `ConditionResult`
- [x] 3.4 `npm run typecheck`

## 4. Server — API routes

- [x] 4.1 `server/src/api/index.ts`: remove `/api/categories` (69-99) and `/api/mappings` (101-112) routes + their imports
- [x] 4.2 Add `GET /api/groups` → `listGroups(db)`
- [x] 4.3 `npm run typecheck`

## 5. Frontend — remove categories tab

- [x] 5.1 `server/static/index.html`: remove the categories nav button (24) and `#screen-categories` section (35)
- [x] 5.2 `server/static/js/main.js`: remove `import * as categories` and the `categories` key in `SCREENS`
- [x] 5.3 Delete `server/static/js/categories.js`
- [x] 5.4 `server/static/js/api.js`: remove category/mapping calls; add `getGroups: () => req('GET','/api/groups')`

## 6. Frontend — dashboard, rules, gate, timeline

- [x] 6.1 `dashboard.js`: drop `api.getCategories()`; remove category total card (grid-3→grid-2); remove category doughnut; relabel to "グループ別"; full-width group doughnut
- [x] 6.2 `dashboard.js`: switch the 7-day stacked bar from `day.categories` to `day.groups`, retitle to group-based
- [x] 6.3 `rules.js`: `TARGETS` `CATEGORY`→`GROUP` ("グループ作業"); `getCategories()`→`getGroups()`; update `condText`/`condEditorRow`/`fromRow`/`row._get` to group (`value:g.stable_group_id`)
- [x] 6.4 `gate.js`: `targetLabel` and `condRow`/progress-bar branch `CATEGORY`→`GROUP` using `c.stableGroupId`
- [x] 6.5 `timeline.js`: remove the category `<select>` from the manual-entry editor; stop sending `categoryKey`

## 7. Tests & verification

- [x] 7.1 `server/src/rules/rules.test.ts`: drop `setMapping`; convert the CATEGORY condition/assertions to `GROUP` (`stableGroupId`)
- [x] 7.2 `server/src/services/planning.test.ts`: remove unused `setMapping` import; adjust total expectations if needed
- [x] 7.3 `server/src/db/db.test.ts`: remove category-seed assertions (14-16, 31-32)
- [x] 7.4 Run `npm run typecheck` and `npm test` — all green
- [x] 7.5 Manual E2E (`npm run server`): nonzero 総作業時間, single "グループ別" doughnut, no categories tab, group-target rule saves & evaluates in the gate, timeline manual add works
