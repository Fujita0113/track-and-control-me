## ADDED Requirements

### Requirement: Rule condition targets are group-based, not category-based

A gate unlock rule condition SHALL support exactly these targets: `GROUP`, `TOTAL_WORK`, `MANUAL_CHECK`, and `PLANNING`. The system SHALL NOT support a `CATEGORY` condition target. A time-based activity condition SHALL reference a specific tab group by its `stable_group_id`.

#### Scenario: Author a group time condition

- **WHEN** the user creates a future rule condition of target `GROUP` for a specific tab group with threshold N minutes
- **THEN** the condition is stored with that group's `stable_group_id` and threshold
- **AND** the rule editor offers the target label "グループ作業" and lists selectable tab groups from `GET /api/groups`

#### Scenario: Group condition evaluation

- **WHEN** the gate evaluates a `GROUP` condition for a day
- **THEN** the actual value is the summed tracked time of that `stable_group_id` on that day
- **AND** the condition is met when the actual time is greater than or equal to the threshold

#### Scenario: Category target is unavailable

- **WHEN** the rule editor is opened
- **THEN** no `CATEGORY` / "カテゴリ作業" target option is offered

### Requirement: Legacy category conditions are removed on migration

The system SHALL remove any pre-existing rule conditions whose target was `CATEGORY` during migration, since a category cannot be mapped one-to-one to a single tab group.

#### Scenario: Existing category conditions dropped

- **WHEN** the database is migrated to the group-based schema
- **THEN** all rule conditions with target `CATEGORY` are deleted
- **AND** remaining conditions (`TOTAL_WORK`, `MANUAL_CHECK`, `PLANNING`) are preserved
