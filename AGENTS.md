# Repository guidance

## User-interface changes

Before planning, implementing, or reviewing any user-facing UI change, read these files completely:

1. [`docs/ui-design-brief.md`](docs/ui-design-brief.md) — product direction and approved design decisions.
2. [`apps/web/AGENTS.md`](apps/web/AGENTS.md) — operational personality, voice, visual, mobile-first, and financial-state rules.

Treat both documents as binding product constraints for every UI feature, including changes made outside `apps/web` that affect what the user sees or reads.

Do not introduce a conflicting visual direction, interaction pattern, or tone by inference. If a new explicit product decision changes the personality, update both guides in the same change so future work receives the new direction.
