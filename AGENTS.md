# Repository guidance

## User-interface changes

Before planning, implementing, or reviewing any user-facing UI change, read these files completely:

1. [`docs/ui-design-brief.md`](docs/ui-design-brief.md) — product direction and approved design decisions.
2. [`apps/web/AGENTS.md`](apps/web/AGENTS.md) — operational personality, voice, visual, mobile-first, and financial-state rules.

Treat both documents as binding product constraints for every UI feature, including changes made outside `apps/web` that affect what the user sees or reads. Patrimonio product rules also live in [`docs/patrimonio.md`](docs/patrimonio.md); keep the three-tab model (Resumen / Movimientos / Patrimonio) intact unless an explicit product decision updates those guides.

Do not introduce a conflicting visual direction, interaction pattern, or tone by inference. If a new explicit product decision changes the personality, update both guides in the same change so future work receives the new direction.

## Prefer native capabilities

Before designing or implementing a manual solution for infrastructure, observability, logging, authentication, caching, integrations, or other platform concerns, first verify whether the relevant provider or framework already offers a native capability that meets the need.

Prefer the native capability when it provides the required behavior, reliability, security, and observability. Build custom code only for a documented gap, and state that gap and the reason the native option is insufficient before adding the custom implementation. Do not duplicate provider-managed telemetry or data capture with application logs merely because it is easier to add locally.

## AWS local access

- Use `aws login` credentials for interactive local AWS access. Verify the active identity with `aws sts get-caller-identity` immediately before any production operation.
- When AWS authentication is needed for an in-scope task, or the user explicitly asks to log in, infer authorization and run `aws login` without requesting separate confirmation unless the user explicitly says not to. Never replace an expired or broken login session with permanent access keys.
- Keep production data changes auditable: use an already-deployed application/API capability when one exists. Do not write directly to DynamoDB to bypass domain mutations, revision history, validation, or authentication.

## Production deployment

- Never deploy application or infrastructure code manually from a local machine. Do not run `cdk deploy`, update Lambda code/configuration directly, or invoke deployment APIs as a shortcut.
- All production code changes must go through a pull request and the required `quality` check. Production deployment is owned exclusively by the `deploy-production` GitHub Actions job after the approved change lands on `main`.
- Local AWS access may be used for read-only diagnosis and for auditable production data operations supported by code that is already deployed. It must not be used to release unreviewed code.

## Pull requests and linear history

`main` requires linear history. Use this workflow for every pull request:

1. Fetch the current base and create the feature branch directly from `origin/main`.
2. Before the final push, run `git fetch origin` followed by `git rebase origin/main`.
3. Resolve rebase conflicts intentionally, stage the resolved files, and continue with `git rebase --continue`.
4. Never merge `main` into a feature branch; that introduces a merge commit and can block the PR.
5. If the branch was already pushed before rebasing, update it with `git push --force-with-lease`, never plain `--force`.
6. Wait for the required `quality` check and confirm the PR is `CLEAN` and `MERGEABLE`.
7. Complete the PR with **Squash and merge** or **Rebase and merge**. Do not use **Create a merge commit**.

Preserve unrelated user changes throughout this workflow. If a rebase would overwrite or ambiguously combine them, stop and request direction.
