## Why

The **ゲート** tab (reads today's rule, shows progress, reveals the password) and the **ルール編集** tab (authors tomorrow's rule) are the read and write halves of a single unlock mechanism. Splitting them across two tabs makes the daily ritual — check today's progress, then set tomorrow's rule — feel disjointed. Combining them into one screen is clearer.

## What Changes

- Merge the **ゲート** and **ルール編集** tabs into a single tab ("ゲート").
- The merged screen shows, top to bottom: today's lock state + condition progress + password reveal (current gate), then the rule-editing section (ruleset list + "＋翌日のルールを作成").
- Remove the separate **ルール編集** tab/section and its screen registration.
- Frontend-only: no server or endpoint changes. Depends on `eliminate-categories` landing first (the merged screen composes the already group-based `gate.js` and `rules.js`).

## Capabilities

### New Capabilities
- `gate-screen`: A single screen that presents today's unlock evaluation (state, progress, password reveal) together with authoring of future-day rules.

### Modified Capabilities
<!-- No pre-existing specs in openspec/specs/. -->

## Impact

- **Frontend only**: `server/static/index.html` (collapse two tabs/sections into one), `server/static/js/main.js` (drop `rules` screen registration), `server/static/js/gate.js` (host the rule-editing section), `server/static/js/rules.js` (its `rulesetCard`/`openRuleEditor` reused or moved).
- **No server changes**: `/api/unlock`, `/api/rules`, `/api/password/reveal`, `/api/groups` all already exist.
- **Timer/modal interaction**: the gate's 30s auto-refresh must not clobber an open rule-editor modal.
