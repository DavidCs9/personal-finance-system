# SQL normalization audit — 2026-10-01

## Objective and completion criteria

Analyze the post-migration data model before implementation. Audit every live SQL table against its purpose, code consumers, actual retained data, relationships, redundancy and suitable relational identity. Deliver a table-by-table report with concrete cleanup findings and an ordered normalization proposal. No schema or production data changes are authorized by this analysis request.

## Constraints

- Follow repository guidance and David's single-owner product north star.
- Use real production data for read-only diagnosis; keep raw records, identifiers, sources and financial values outside Git.
- Verify the active AWS login identity immediately before production reads. Keep DynamoDB and existing recovery resources intact.
- Verify native DSQL capabilities before recommending constraints or replacement infrastructure.
- Preserve history, evidence, rejected movements, Mi parte, MSI and monthly-plan inheritance semantics.

## Progress and next steps

- Read repository guidance, product north star, cutover documentation, the transformer, schema, authoritative store, domain contracts and relevant consumers. Read UI/product guides before assessing the financial behavior that normalization must preserve.
- AWS login credentials were already valid; STS confirmed the expected account/operator. No new login was needed.
- Captured the actual SQL catalog and all 29 tables plus one view in one transaction containing SELECT statements, followed by ROLLBACK. Snapshot: 2026-10-01 21:28:49.960 America/Chihuahua (2026-10-02T03:28:49.960Z).
- Profiled natural keys, required-field presence, parent references, embedded child collections, audit links and selected arithmetic invariants locally.
- Recomputed every projected domain row and envelope hash. The reused transformer's source was byte-identical to this checkout's transformer. Verified 2,660 domain rows against 2,449 envelope/checkpoint rows; zero hash/checkpoint issues, zero column/payload differences and zero unexpected rows.
- Investigated category references, MSI evidence identities, missing dedupe targets and apparent duplicate signatures. Recorded findings in [the audit](../dsql-normalization-audit.md).

## Decisions

### D1 — Audit the authoritative SQL model, including the compatibility ledger

- Context: Earlier migration documentation still describes DynamoDB authority, while the completed cutover uses SQL envelopes as authority.
- Evidence and uncertainty: Live `runtime_state` and cutover code/documentation establish SQL authority. Writers still use the document-command adapter and derive relational rows transactionally.
- Alternatives and tradeoffs: Audit only domain columns, missing the true write model; or inventory envelopes, derived rows and consumers together.
- Decision and reason: Audit both layers and treat removing the adapter as part of normalization, after consumers migrate. Do not delete `projection_state` prematurely.
- Consequences, verification, and revisit conditions: A relational schema alone is insufficient while the document model remains authoritative. Cross-checked every derived row and checkpoint locally against a consistent live snapshot.
- Status: Validated.

### D2 — Separate actual defects from intentional retained history

- Context: SQL references and duplicate signatures can look invalid without their domain meaning.
- Evidence and uncertainty: MSI evidence references are statement-row identities/backfill markers; rejected plans intentionally retain their histories. Five accepted same-signature movement pairs have only day-level transaction times, so duplication is unproven. Two absent dedupe movement targets remain unresolved.
- Alternatives and tradeoffs: Rewrite/delete suspicious rows automatically; or classify findings and propose auditable cleanup after semantic review.
- Decision and reason: Report confirmed inconsistencies separately from evidence-model mismatches and review candidates. Retain raw/history JSON where it records immutable facts or flexible audit changes.
- Consequences, verification, and revisit conditions: No production cleanup during the audit. Category repair, dedupe resolution and evidence mapping precede FK enforcement; original source evidence is required to settle suspected financial duplicates.
- Status: Validated for classification; individual cleanup remains future work.

## Verification results

- Live catalog: 29 base tables, one view, 29 primary-key constraints, no foreign-key/CHECK/standalone UNIQUE constraints, two secondary indexes.
- Core movement/observation/revision/MSI parent links, card-liability parents, current/version day links, retry-exception links and revision/bulk-operation links checked.
- Payroll net and line totals, holdings-to-snapshot sums, Mi parte bounds, card cycle days, canonical snapshot uniqueness and embedded payment identity checks passed.
- Confirmed cleanup/model findings: 15 accepted movements with absent catalog categories; two claims with absent movement targets; 26 MSI references requiring typed provenance.
- Native DSQL documentation reviewed for foreign keys, CHECK/UNIQUE/NOT NULL, async index/constraint validation and ALTER limitations.
- Raw snapshot, profiling scripts and detailed findings retained privately in `/tmp/olbia-normalization-audit/`, with directory mode 0700 and files mode 0600. These are local temporary artifacts, not a durable backup.
- No application tests were run: this request produced analysis documentation only. Automated document coverage confirmed individual entries for all 29 tables and the view; version-ID and bulk-member uniqueness checks passed; whitespace validation passed.

## Outcome and remaining work

The initial table-by-table audit is complete. The report distinguishes verified data health, structural weaknesses, proposed relational keys and staged implementation. No production mutation, schema migration, deployment, commit or PR was performed. Future work is to agree the target model, implement auditable repairs, migrate domain readers/writers, enforce validated native constraints, and eventually retire the compatibility layer after dependency verification.
