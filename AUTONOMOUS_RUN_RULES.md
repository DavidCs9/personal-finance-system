# Autonomous run rules

These rules apply when the user authorizes autonomous work or a long-running execution. Follow the user's objective and the repository's `AGENTS.md` constraints throughout the run.

## Keep moving with judgment

- Work toward the authorized objective until its completion criteria are met. Implement, verify, review, and correct as needed.
- Do not stop merely because a decision is difficult, information is incomplete, or several reasonable approaches exist. Investigate enough to make an informed choice, use your best judgment, record the dilemma, and continue.
- Choose using the user's intent, available evidence, and existing product and architecture constraints. Prefer a proportional solution that preserves correctness and is easy to verify and revise.
- Distinguish verified facts from assumptions. An assumption may support a decision, but must not be presented as a confirmed fact or an explicit user preference.
- Autonomy does not override explicit instructions, expand the authorized scope, or replace required approvals. If the next action cannot proceed within those boundaries, record the specific blocker and continue independent work. Ask for the minimum missing input only when necessary.

## Persist the run locally

At the start, create `work-notes/YYYY-MM-DD-<task-slug>.md` using the user's local date and a descriptive task slug. Use a distinct suffix if needed. This directory is Git-ignored and local only. Never stage, force-add, commit or push run notes or execution logs. Do not create run records under `docs/`, which contains only current product and operating guidance.

Record the objective, completion criteria, relevant constraints, current progress, verification results, and next steps. Update it at meaningful checkpoints and before handing off or stopping. When resuming the same run, read and update its existing record rather than starting from scratch.

## Capture significant dilemmas when deciding

Record a dilemma when choosing between plausible alternatives has a meaningful effect on behavior, correctness, architecture, scope, cost, or maintainability, or when an uncertain assumption materially affects the result. Routine implementation details do not need individual entries.

Write each entry when the decision is made, before implementing the chosen approach. Do not defer the record until the end of the run. Include a concise, reviewable decision rationale with:

- **Context:** the dilemma and why it matters.
- **Evidence and uncertainty:** known facts, relevant references, missing information, and assumptions.
- **Alternatives:** viable options considered and the practical advantages and disadvantages of each.
- **Decision and reason:** the chosen option and why it best serves the objective under the constraints.
- **Consequences and verification:** expected tradeoffs, how to check the choice, and what would justify revisiting it.
- **Status:** provisional, validated, superseded, or blocked.

Preserve prior entries when a decision changes. Add the new evidence and replacement decision, and mark the earlier decision as superseded. An autonomous choice does not become an approved product decision merely because it is recorded.

## Verify and close the run

Run checks appropriate to the actual changes. If a check fails, use the result to correct the work or reconsider a recorded decision. Avoid repeating the same failed approach without new evidence; investigate another viable path and record significant changes of direction.

At a genuine blocker or handoff, update and retain the active record and link it in the response. Claim completion only when the objective and required verification are satisfied.

At completion, extract lasting decisions into the existing canonical documents and summarize relevant verification in the PR description or commit message. Keep useful completed notes locally in the ignored directory; they never belong in the commit or PR. Do not copy execution logs into documentation or create a permanent page for each completed feature. The final response links the result; link a local note when it helps resume unfinished work. An unfinished run must retain its local resumable record.

## Run record template

```markdown
# <Task> — <local date>

## Objective and completion criteria

## Constraints

## Progress and next steps

## Decisions

### D1 — <Dilemma>
- Context:
- Evidence and uncertainty:
- Alternatives and tradeoffs:
- Decision and reason:
- Consequences, verification, and revisit conditions:
- Status:

## Verification results

## Outcome and remaining work
```
