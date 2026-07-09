## ADDED Requirements

### Requirement: Gate and rule editing share one screen

The system SHALL present today's unlock evaluation and future-day rule authoring on a single tab. The system SHALL NOT expose a separate "ルール編集" tab.

#### Scenario: Single tab hosts both

- **WHEN** the user opens the "ゲート" tab
- **THEN** today's lock state, condition progress, and (when unlocked) password reveal are shown
- **AND** a rule-editing section with the existing rulesets and a "＋翌日のルールを作成" action is shown on the same screen
- **AND** there is no separate "ルール編集" tab

### Requirement: Rule authoring works from the merged screen

The system SHALL allow creating, editing, and deleting future-day rulesets from the merged screen, preserving the freeze rules (only future-dated rulesets are editable).

#### Scenario: Create tomorrow's rule from the merged screen

- **WHEN** the user clicks "＋翌日のルールを作成" and saves conditions
- **THEN** the ruleset for tomorrow is persisted
- **AND** the merged screen reflects the new ruleset without a full page reload

#### Scenario: Frozen rulesets remain read-only

- **WHEN** the merged screen lists today's or a past ruleset
- **THEN** no edit/delete controls are offered for it

### Requirement: Auto-refresh does not disrupt rule editing

The merged screen SHALL keep the gate's periodic refresh of today's state while an open rule-editor modal is not discarded by that refresh.

#### Scenario: Refresh with an open editor

- **WHEN** the periodic gate refresh fires while the rule-editor modal is open
- **THEN** the modal and its unsaved input remain intact
