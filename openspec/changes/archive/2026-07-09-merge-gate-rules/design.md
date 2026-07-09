## Context

The SPA is a flat tab bar (`index.html`) driven by `main.js` `activate()`, swapping `.active` on `<section>`s. `gate.js` (read-side: `getUnlock` + `getPlanning`, hero/progress/reveal, 30s `setInterval`) and `rules.js` (write-side: `getRules`, `rulesetCard`, `openRuleEditor` → `putRule`) are the two halves of the unlock feature and already share the same target vocabulary. All backend endpoints already exist and are independent. This change is purely frontend composition and depends on `eliminate-categories` having already converted both modules to group-based targets.

## Goals / Non-Goals

**Goals:**
- One "ゲート" tab that hosts today's evaluation and future-rule authoring.
- Preserve current behavior: 30s refresh, freeze rules, password reveal.

**Non-Goals:**
- No server/endpoint changes.
- Not folding in the 当日チェック tab (out of scope this change).
- No change to how rules are evaluated (that is `eliminate-categories`).

## Decisions

- **`gate.js` becomes the host module; reuse `rules.js` rendering.** `gate.js` `show()` renders the gate body, then appends a rule-editing section that reuses `rules.js`'s `rulesetCard`/`openRuleEditor`. Export those from `rules.js` and import them, rather than duplicating. *Alternative:* fully inline rules into gate.js — rejected to avoid copy-paste drift.
- **Timer owns only the gate region.** The 30s refresh re-renders the gate body (hero/progress/reveal) but NOT the rule-editing section, so an open modal is never torn down. Guard: skip/limit refresh side-effects while a modal is open. *Alternative:* pause the timer whenever the modal opens — simpler but staler; the region-scoped re-render is preferred.
- **Collapse tabs in `index.html` + `main.js`.** Remove the `rules` tab/section and its `SCREENS` entry; the gate screen now covers both. Unify the duplicated target-label maps (`targetLabel` in gate, `TARGETS` in rules) into one.

## Risks / Trade-offs

- **Timer vs. open modal** → scope the periodic re-render to the gate region only; verify by opening the editor and waiting past one refresh interval.
- **Reload semantics after save** → after `putRule` succeeds, re-render only the rule-editing section (not the whole screen) to keep gate state stable.
- **Ordering dependency** → must land after `eliminate-categories`; otherwise the merged screen would still reference category-based rule targets.

## Migration Plan

1. Land `eliminate-categories` first.
2. Export `rulesetCard`/`openRuleEditor` from `rules.js`; compose them in `gate.js`.
3. Remove the `rules` tab/section (`index.html`) and its registration (`main.js`).
4. Manual E2E per the tasks checklist.
5. Rollback: restore the two tabs (revert `index.html`/`main.js`) and the `gate.js` composition; no data implications.

## Open Questions

- None. Scope confirmed as gate + rule-editing only (checks tab stays separate).
