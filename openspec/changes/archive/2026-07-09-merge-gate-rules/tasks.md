## 1. Prepare rule-editing for reuse

- [x] 1.1 In `server/static/js/rules.js`, export `rulesetCard` and `openRuleEditor` (and the reload helper) so they can be composed from the gate screen
- [x] 1.2 Unify the duplicated target-label vocabulary (`targetLabel` in `gate.js`, `TARGETS` in `rules.js`) into one shared definition

## 2. Compose the merged gate screen

- [x] 2.1 In `server/static/js/gate.js`, after the gate body, render a rule-editing section (ruleset list via `api.getRules()` + "＋翌日のルールを作成" button) using the reused `rules.js` renderers
- [x] 2.2 Scope the 30s refresh to re-render only the gate region; ensure an open rule-editor modal is not discarded
- [x] 2.3 After a rule save/delete, re-render only the rule-editing section (keep gate state stable)

## 3. Collapse the tabs

- [x] 3.1 `server/static/index.html`: remove the `rules` nav button and `#screen-rules` section (keep the single "ゲート" tab)
- [x] 3.2 `server/static/js/main.js`: remove `import * as rules` and the `rules` key in `SCREENS`

## 4. Verification

- [x] 4.1 `npm run server` E2E: the "ゲート" tab shows today's state + progress + reveal AND the ruleset list + create button; no separate "ルール編集" tab
- [x] 4.2 Create/edit/delete a future ruleset from the merged screen; confirm freeze rules (today/past read-only)
- [x] 4.3 Open the rule editor, wait past one 30s refresh; confirm the modal and unsaved input survive
- [x] 4.4 Confirm password reveal still works when unlocked
