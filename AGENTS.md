# Repository guidance

## User-interface changes

Before planning, implementing, or reviewing any user-facing UI change, read these files completely:

1. [`docs/ui-design-brief.md`](docs/ui-design-brief.md) — product direction and approved design decisions.
2. [`apps/web/AGENTS.md`](apps/web/AGENTS.md) — operational personality, voice, visual, mobile-first, and financial-state rules.

Treat both documents as binding product constraints for every UI feature, including changes made outside `apps/web` that affect what the user sees or reads.

Do not introduce a conflicting visual direction, interaction pattern, or tone by inference. If a new explicit product decision changes the personality, update both guides in the same change so future work receives the new direction.

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
