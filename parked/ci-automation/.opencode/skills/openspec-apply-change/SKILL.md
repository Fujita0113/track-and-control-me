---
name: openspec-apply-change
description: Implement tasks from an OpenSpec change. Use when the user wants to start implementing, continue implementation, or work through tasks.
license: MIT
compatibility: Requires openspec CLI.
metadata:
  author: openspec
  version: "1.0"
  generatedBy: "1.4.1"
---

Implement tasks from an OpenSpec change.

**Input**: Optionally specify a change name. If omitted, check if it can be inferred from conversation context. If vague or ambiguous you MUST prompt for available changes.

**Steps**

1. **Select the change**

   If a name is provided, use it. Otherwise:
   - Infer from conversation context if the user mentioned a change
   - Auto-select if only one active change exists
   - If ambiguous, run `openspec list --json` to get available changes and use the **AskUserQuestion tool** to let the user select

   Always announce: "Using change: <name>" and how to override (e.g., `/opsx-apply <other>`).

2. **Check status to understand the schema**
   ```bash
   openspec status --change "<name>" --json
   ```
   Parse the JSON to understand:
   - `schemaName`: The workflow being used (e.g., "spec-driven")
   - `planningHome`, `changeRoot`, and `actionContext`: planning scope and edit constraints
   - Which artifact contains the tasks (typically "tasks" for spec-driven, check status for others)

3. **Get apply instructions**

   ```bash
   openspec instructions apply --change "<name>" --json
   ```

   This returns:
   - `contextFiles`: artifact ID -> array of concrete file paths (varies by schema - could be proposal/specs/design/tasks or spec/tests/implementation/docs)
   - Progress (total, complete, remaining)
   - Task list with status
   - Dynamic instruction based on current state

   **Handle states:**
   - If `state: "blocked"` (missing artifacts): show message, suggest using openspec-continue-change
   - If `state: "all_done"`: congratulate, suggest archive
   - Otherwise: proceed to implementation

   **Workspace guard:** If status JSON reports `actionContext.mode: "workspace-planning"` and `allowedEditRoots` is empty, explain that full workspace apply is not supported in this slice. Treat linked repos and folders as read-only context, ask the user to select an affected area through an explicit implementation workflow, and STOP before editing files.

4. **Read context files**

   Read every file path listed under `contextFiles` from the apply instructions output.
   The files depend on the schema being used:
   - **spec-driven**: proposal, specs, design, tasks
   - Other schemas: follow the contextFiles from CLI output

5. **Show current progress**

   Display:
   - Schema being used
   - Progress: "N/M tasks complete"
   - Remaining tasks overview
   - Dynamic instruction from CLI

6. **Implement tasks (loop until done or blocked)**

   **Frozen for the whole of apply** — do NOT edit, delete, skip, `test.skip`, `test.fixme`,
   or loosen an assertion in any of these:
   - the spec deltas (`openspec/changes/<name>/specs/`)
   - the vitest tests propose wrote
   - every **pre-existing** `e2e/**/*.spec.ts`

   A failure in the frozen set means the implementation is not done yet — not that the test
   is wrong. A pre-existing e2e turning red is the highest-signal event in this workflow: it
   says the change broke shipped behavior.

   **Yours to write**: the implementation, additional vitest tests, and the **new** e2e spec
   for the flow `tasks.md` names. Write the e2e **last**, against the DOM you actually built —
   propose deliberately did not guess at selectors.

   For each pending task:
   - Show which task is being worked on
   - Make the code changes required
   - Keep changes minimal and focused
   - Mark task complete in the tasks file: `- [ ]` → `- [x]`
   - Continue to next task

   **Pause if:**
   - Task is unclear → ask for clarification
   - Implementation reveals a design issue → suggest updating artifacts
   - Error or blocker encountered → report and wait for guidance
   - User interrupts
   - A frozen test looks wrong → follow the escalation below

   **Prove the new e2e is real (red-proof — deterministic, no model calls)**

   A spec you wrote yourself, after the fact, proves nothing until it has been shown to fail
   without your change. After writing a new e2e spec:

   ```bash
   git stash push -- server/ extension/ packages/
   CI=1 npx playwright test e2e/<new-spec>.spec.ts   # MUST fail
   git stash pop
   CI=1 npx playwright test e2e/<new-spec>.spec.ts   # MUST pass
   ```

   `CI=1` is REQUIRED. Without it, `reuseExistingServer` in `playwright.config.ts` reuses the
   already-running server, the stashed run executes against the new code anyway, and you get a
   false green that certifies a worthless spec.

   If the stashed run passes, the spec asserts nothing about your change — rewrite it until it
   fails. Report both outcomes; do not claim red-proof you did not run.

   **Escalation: a frozen test is wrong (ask once, then obey the answer)**

   Only when you have implemented the behavior the design describes AND concluded the frozen
   test itself contradicts it (asserts a removed feature, wrong expected value, stale selector
   for markup this change legitimately replaces):

   1. STOP. Do not edit it, and do not keep working around it.
   2. Ask the user once with the **AskUserQuestion tool**:
      > propose で作られたテストに誤りが見つかり通りません。変更しても良いでしょうか。

      Include: which file and assertion, actual vs. expected output, why this is a test error
      rather than an implementation gap, and what the corrected test would assert.
   3. If approved → edit it, make it pass, and name the change in the summary and the commit
      message.
   4. If not approved → leave it untouched. Fix the implementation, or mark the task blocked
      and report.

   Ask at most once per task. Needing a second round on the same test means the proposal
   (spec deltas / design) is likely wrong — report that instead of asking again.
   "It would be faster" or "my implementation is more natural" are not grounds to escalate;
   only a test that contradicts the agreed design is.

   **Unattended runs (CI: `xs-auto.yml`) cannot ask.** There the answer is always "no": leave
   the frozen test untouched, append the evidence you would have shown the user to the end of
   `tasks.md`, and finish red. A red PR a human reviews beats a green one built on a test the
   model rewrote for itself.

   Before reporting completion, verify the frozen set is untouched:
   ```bash
   git status --short e2e/ && git diff --stat -- e2e/ openspec/changes/
   ```
   Pre-existing specs and spec deltas must show no changes. Only your new e2e file may appear,
   as untracked. Anything else must be an approved change from the escalation — otherwise revert it.

7. **On completion or pause, show status**

   Display:
   - Tasks completed this session
   - Overall progress: "N/M tasks complete"
   - If all done: suggest archive
   - If paused: explain why and wait for guidance

**Output During Implementation**

```
## Implementing: <change-name> (schema: <schema-name>)

Working on task 3/7: <task description>
[...implementation happening...]
✓ Task complete

Working on task 4/7: <task description>
[...implementation happening...]
✓ Task complete
```

**Output On Completion**

```
## Implementation Complete

**Change:** <change-name>
**Schema:** <schema-name>
**Progress:** 7/7 tasks complete ✓

### Completed This Session
- [x] Task 1
- [x] Task 2
...

All tasks complete! Ready to archive this change.
```

**Output On Pause (Issue Encountered)**

```
## Implementation Paused

**Change:** <change-name>
**Schema:** <schema-name>
**Progress:** 4/7 tasks complete

### Issue Encountered
<description of the issue>

**Options:**
1. <option 1>
2. <option 2>
3. Other approach

What would you like to do?
```

**Guardrails**
- NEVER edit, delete, or skip the frozen set (spec deltas, propose's vitest,
  pre-existing `e2e/**/*.spec.ts`) — ask the user once first (step 6)
- Write the NEW e2e last, then red-proof it with `git stash` + `CI=1` (step 6)
- Keep going through tasks until done or blocked
- Always read context files before starting (from the apply instructions output)
- If task is ambiguous, pause and ask before implementing
- If implementation reveals issues, pause and suggest artifact updates
- Keep code changes minimal and scoped to each task
- Update task checkbox immediately after completing each task
- Pause on errors, blockers, or unclear requirements - don't guess
- Use contextFiles from CLI output, don't assume specific file names

**Fluid Workflow Integration**

This skill supports the "actions on a change" model:

- **Can be invoked anytime**: Before all artifacts are done (if tasks exist), after partial implementation, interleaved with other actions
- **Allows artifact updates**: If implementation reveals design issues, suggest updating artifacts - not phase-locked, work fluidly
