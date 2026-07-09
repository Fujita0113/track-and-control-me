## ADDED Requirements

### Requirement: Daily total work time sums all tab groups

The system SHALL compute a day's total work time as the sum of tracked time across ALL tab groups for that day, including the `ungrouped` pseudo-group. The system SHALL NOT apply any category-based `counts_toward_total` or WORK/AWAY filtering when computing the total.

#### Scenario: Total equals sum of every group

- **WHEN** a day has group A = 30m, group B = 45m, and ungrouped = 15m of tracked time
- **THEN** the reported 総作業時間 for that day is 90m

#### Scenario: Total is nonzero when only untracked/unmapped groups exist

- **WHEN** a day has tracked time only in tab groups that were never assigned to any category
- **THEN** the reported 総作業時間 equals the sum of that time (it is NOT 0m)

### Requirement: Dashboard presents work time by group without categories

The dashboard SHALL display the daily total work time and a per-group breakdown, and SHALL NOT display any category-based breakdown. The per-group breakdown label SHALL read "グループ別" (without a "divide-by-N" suffix).

#### Scenario: Group breakdown shown, category breakdown absent

- **WHEN** the user opens the dashboard for a day with tracked group time
- **THEN** a "グループ別" doughnut of per-group time is shown
- **AND** no category doughnut and no category-breakdown card are shown

#### Scenario: Multi-day chart is grouped by tab group

- **WHEN** the user views the recent multi-day work-time chart
- **THEN** each day's bar is broken down by tab group (not by category)
