# Aurora DSQL schema reference

## What is in DSQL now?

The database contains the **ledger, planning, payroll, Patrimonio and retained operational projection**, not every application record. Schema version 4 has twenty-four entity tables, two operational tables and one view under `olbia` in the regional DSQL cluster in `us-east-2`. The [planning/payroll rollout](dsql-planning-payroll.md) extends the original nine-table ledger projection additively. [Patrimonio](dsql-patrimonio.md) adds four canonical/audit tables and the card envelope. The [shadow rollout](https://github.com/DavidCs9/personal-finance-system/actions/runs/36882229551) passed full retained-content/financial/evidence verification; the separate [guarded rollout](https://github.com/DavidCs9/personal-finance-system/actions/runs/36884373746) also passed and is active.

DynamoDB remains the authority for application writes. Its stream projects supported records into DSQL; daily reconciliation repairs and verifies current state. The [movement read rollout](dsql-read-migration.md) introduces reversible shadow/guarded SQL reads with a source freshness check. The long-term destination, explicitly stated by David on 2026-09-30, is to retire DynamoDB after the remaining data and application dependencies migrate. That cutover has not happened.

The deployed schema and real historical ledger passed [production verification](https://github.com/DavidCs9/personal-finance-system/actions/runs/36801466045): 3,200 source/target comparisons, zero lag, zero mismatches, and matching monthly/currency financial aggregates. These are comparison counts across both passes, not a SQL row count. Counts below are the observed snapshot from that execution on 2026-10-01 UTC (2026-09-30 in America/Chihuahua); they are not live counters or a claim that all DynamoDB entities migrated.

| SQL table | Purpose | Rows in verified snapshot |
| --- | --- | ---: |
| `olbia.movements` | Bank-observed financial movements, including pending and rejected states. | 491 |
| `olbia.movement_observations` | Individual capture observations and their evidence/conciliation metadata. | 514 |
| `olbia.movement_revisions` | Persisted movement revisions; before/after changes and operation IDs remain in payload. | 401 |
| `olbia.categories` | Effective category catalog: persisted categories overlaid on code defaults. | 13 |
| `olbia.merchant_category_rules` | Merchant classification rules and their original metadata. | 172 |
| `olbia.cards` | David’s card profiles, including statement closing and payment due days. | 3 |
| `olbia.movement_tags` | Distinct tags derived from a movement’s payload. | 83 |
| `olbia.msi_plans` | Installment purchase plans derived from a movement’s MSI payload. | 20 |
| `olbia.msi_installments` | Individual scheduled installments, including future months. | 108 |

## Data still outside this projection

The projector accepts only the source key patterns documented below. Other DynamoDB records are not copied merely because a source scan or parity job succeeded.

The [operational-state extension](dsql-operational-state.md) projects retained claims, exceptions/retries/imports, bulk operations, prepared/sent email state, subscriptions and minimal assistant indices. All source writes and authoritative decisions remain DynamoDB. S3 evidence, Cognito and native AgentCore transcript/memory remain outside SQL. Already expired/deleted history absent from the source is not recovered or claimed.

Original MIME, CSV, PDF, XML and other evidence files remain in S3. SQL JSONB retains their references and source metadata; it does not embed or migrate the original files. Authentication remains with the existing identity provider.

## Common domain-table columns and constraints

Every domain table has these columns in addition to its table-specific fields:

| Column | SQL type | Nullable | Meaning |
| --- | --- | --- | --- |
| `source_pk` | `text` | No | Original DynamoDB partition key. |
| `source_sk` | `text` | No | Original DynamoDB sort key. |
| `row_id` | `text` | No | Stable identity of a row derived from that source item. |

The physical primary key is **(source_pk, source_sk, row_id)**. The `id` and `movement_id` columns are existing domain identities; they are not separate primary keys or database-enforced unique constraints. Table-specific columns are currently nullable in SQL, even where the transformer requires values. Application validation is stronger than the initial DDL.

There are no foreign keys, CHECK constraints, column defaults or cascading deletes in these domain tables. Items from a DynamoDB transaction can arrive independently, so the current projection preserves logical relationships without requiring fabricated parents. This schema is a migration projection, not yet the final SQL-authoritative write model.

Amounts use `bigint` in currency minor units. Keep currencies separate and preserve `personal_amount_minor` (Mi parte), including zero and absence. Driver bigint values must not be converted through floating-point arithmetic. Instants use `timestamptz`; comparisons preserve milliseconds. Statement/installment day values use `date`. Financial months use America/Chihuahua.

## Domain tables

The SQL below documents existing definitions. It is not a manual production migration script; changes must go through the versioned bootstrap and approved PR/deployment workflow.

### olbia.movements

Bank-observed financial movements, including pending and rejected states. Source: `EVENT#id / EVENT`. `row_id`: movement id.

```sql
CREATE TABLE IF NOT EXISTS olbia.movements (
    source_pk text NOT NULL,
    source_sk text NOT NULL,
    row_id text NOT NULL,
    id text,
    institution text,
    event_type text,
    status text,
    amount_minor bigint,
    currency text,
    personal_amount_minor bigint,
    merchant_raw text,
    category_id text,
    spend_month text,
    occurred_at timestamptz,
    received_at timestamptz,
    payload jsonb,
    PRIMARY KEY (source_pk, source_sk, row_id)
);
```

`amount_minor` is the bank-observed amount; `personal_amount_minor` is the optional personal share. `spend_month` is derived from `occurredAt`, falling back to `receivedAt`, in the financial time zone. `status` preserves the source state; the table is not restricted to accepted spending. `payload` retains the full movement payload, including fields not promoted to columns. No `card_id` is inferred from merchant, bank or account labels.

### olbia.movement_observations

Individual capture observations and their evidence/conciliation metadata. Source: `EVENT#id / OBSERVATION#…`. `row_id`: observation id.

```sql
CREATE TABLE IF NOT EXISTS olbia.movement_observations (
    source_pk text NOT NULL,
    source_sk text NOT NULL,
    row_id text NOT NULL,
    id text,
    movement_id text,
    capture_source text,
    payload jsonb,
    PRIMARY KEY (source_pk, source_sk, row_id)
);
```

### olbia.movement_revisions

Persisted movement revisions; before/after changes and operation IDs remain in payload. Source: `EVENT#id / REVISION#…`. `row_id`: revision id.

```sql
CREATE TABLE IF NOT EXISTS olbia.movement_revisions (
    source_pk text NOT NULL,
    source_sk text NOT NULL,
    row_id text NOT NULL,
    id text,
    movement_id text,
    created_at timestamptz,
    payload jsonb,
    PRIMARY KEY (source_pk, source_sk, row_id)
);
```

### olbia.categories

Effective category catalog: persisted categories overlaid on code defaults. Source: `CATEGORY_CATALOG / CAT#id`. `row_id`: category id.

```sql
CREATE TABLE IF NOT EXISTS olbia.categories (
    source_pk text NOT NULL,
    source_sk text NOT NULL,
    row_id text NOT NULL,
    id text,
    name text,
    sort_order integer,
    payload jsonb,
    PRIMARY KEY (source_pk, source_sk, row_id)
);
```

`payload` is the effective category object (id, name, sortOrder). Default categories may have relational rows even without a persisted source item. The checkpoint separately retains the persisted source envelope when one exists.

### olbia.merchant_category_rules

Merchant classification rules and their original metadata. Source: `CATEGORY_RULES / RULE#merchant`. `row_id`: rule id.

```sql
CREATE TABLE IF NOT EXISTS olbia.merchant_category_rules (
    source_pk text NOT NULL,
    source_sk text NOT NULL,
    row_id text NOT NULL,
    id text,
    merchant_key text,
    category_id text,
    payload jsonb,
    PRIMARY KEY (source_pk, source_sk, row_id)
);
```

### olbia.cards

David’s card profiles, including statement closing and payment due days. Source: `USER#owner / CARD#id`. `row_id`: card profile id.

```sql
CREATE TABLE IF NOT EXISTS olbia.cards (
    source_pk text NOT NULL,
    source_sk text NOT NULL,
    row_id text NOT NULL,
    id text,
    owner text,
    name text,
    cut_off_day integer,
    payment_due_day integer,
    payload jsonb,
    source_item jsonb,
    PRIMARY KEY (source_pk, source_sk, row_id)
);
```

Version 3 explicitly adds `source_item` with ALTER TABLE, preserving card envelope creation/update timestamps.

`owner` preserves David’s existing access identity; it does not introduce multiple users. `cut_off_day` and `payment_due_day` are day-of-month profile settings, not timestamps. A card profile is distinct from a movement’s observed bank account.

### olbia.movement_tags

Distinct tags derived from a movement’s payload. Source: `EVENT#id / EVENT`. `row_id`: tag text.

```sql
CREATE TABLE IF NOT EXISTS olbia.movement_tags (
    source_pk text NOT NULL,
    source_sk text NOT NULL,
    row_id text NOT NULL,
    movement_id text,
    tag text,
    payload jsonb,
    PRIMARY KEY (source_pk, source_sk, row_id)
);
```

Tags are distinct within each source movement. `payload` contains the tag object; there is no separate tag catalog.

### olbia.msi_plans

Installment purchase plans derived from a movement’s MSI payload. Source: `EVENT#id / EVENT`. `row_id`: movement id.

```sql
CREATE TABLE IF NOT EXISTS olbia.msi_plans (
    source_pk text NOT NULL,
    source_sk text NOT NULL,
    row_id text NOT NULL,
    movement_id text,
    months integer,
    principal_minor bigint,
    cuota_minor bigint,
    status text,
    needs_schedule_completion boolean,
    payload jsonb,
    PRIMARY KEY (source_pk, source_sk, row_id)
);
```

`principal_minor` is the plan principal; `cuota_minor` is the installment amount. Currency belongs to the source movement. `needs_schedule_completion` preserves the source’s optional flag. The full plan remains in `payload`.

### olbia.msi_installments

Individual scheduled installments, including future months. Source: `EVENT#id / EVENT`. `row_id`: installment index as text.

```sql
CREATE TABLE IF NOT EXISTS olbia.msi_installments (
    source_pk text NOT NULL,
    source_sk text NOT NULL,
    row_id text NOT NULL,
    movement_id text,
    installment_index integer,
    month text,
    amount_minor bigint,
    status text,
    occurred_on date,
    payload jsonb,
    PRIMARY KEY (source_pk, source_sk, row_id)
);
```

`month` is the scheduled financial month; `occurred_on` preserves an optional calendar date without inventing a time. Each installment object remains in `payload`. Reconciliation replaces the source movement’s derived rows, removing obsolete tags/plans/installments as well as inserting current ones.

### olbia.monthly_plans (version 2)

Source: `USER#owner / MONTH#YYYY-MM`. `row_id`: original month; plans have no payload ID.

```sql
CREATE TABLE IF NOT EXISTS olbia.monthly_plans (
    source_pk text NOT NULL, source_sk text NOT NULL, row_id text NOT NULL,
    owner text, month text, payload jsonb, source_item jsonb,
    PRIMARY KEY (source_pk, source_sk, row_id)
);
```

`payload` retains the complete fixed-expense list/order, original payment IDs, explicit-empty stops, legacy income and timestamps. `source_item` preserves the whole DynamoDB envelope. SQL selects the latest source sort key at or before the requested month using the primary-key index; reading never writes or materializes an inherited month.

### olbia.payroll (version 2)

Source: `USER#owner / PAYROLL#YYYY-MM#UUID`. `row_id`: original CFDI UUID.

```sql
CREATE TABLE IF NOT EXISTS olbia.payroll (
    source_pk text NOT NULL, source_sk text NOT NULL, row_id text NOT NULL,
    owner text, month text, uuid text, fecha_pago date, total_minor bigint,
    currency text, ingested_at timestamptz, source jsonb, payload jsonb, source_item jsonb,
    PRIMARY KEY (source_pk, source_sk, row_id)
);
```

`total_minor` is deposited liquidity in MXN; ordinary/extraordinary payroll, all component totals, SAT lines, employer and payment periods remain in `payload`. `source` retains XML bucket/key/hash metadata; `source_item` also preserves ingestion time and all source envelope fields. Payroll periods use the original source-key ranges and FechaPago/UUID ordering. CFDI dedupe claims remain in DynamoDB. The [version 2 gate](dsql-planning-payroll.md) checks original envelopes and financial results, including fund-derived Patrimonio and evidence hashes.

## Patrimonio tables (version 3)

All four use the same `(source_pk,source_sk,row_id)` primary key and columns `owner text`, `day date`, `captured_at timestamptz`, `source text`, `currency text`, `total_mxn_minor bigint`, `evidence jsonb`, `payload jsonb`, `source_item jsonb`. Payload and source_item preserve the complete original **flat** snapshot envelope, not a fabricated ledger payload.

| Table | Source SK / row_id | Additional columns |
| --- | --- | --- |
| `wealth_snapshots` | `WEALTH_SNAP#accountId#day` / original SK | `account_id text`, `holdings jsonb`, `fx_rate double precision`, `fx_source text` |
| `wealth_versions` | `WEALTH_VER#accountId#day#capturedAt` / original versionId | Same asset columns plus `version_id text`, `superseded_at timestamptz` |
| `liability_snapshots` | `LIAB_SNAP#cardId#day` / original SK | `card_id text` |
| `liability_versions` | `LIAB_VER#cardId#day#capturedAt` / original versionId | `card_id text`, `version_id text`, `superseded_at timestamptz` |

Audit tables never contribute to balances. Embedded holdings retain native currencies/quantities/value/unknown fields; evidence remains in S3. FX double precision preserves the source JS number; complete original metadata remains in JSONB. Fondo has no persisted snapshots: payroll continues deriving it. Canonical/account/day/month and historical as-of queries reuse existing domain calculations. Existing primary indexes cover owner-key ranges; no new secondary index is needed for this observed personal volume. See [full source/consumer inventory and contract](dsql-patrimonio.md).

## Application operational tables (version 4)

All nine additive tables use `(source_pk text NOT NULL, source_sk text NOT NULL, row_id text NOT NULL)` as primary key. Common nullable promoted columns: `id text`, `owner text`, `entity_type text`, `status text`, `created_at timestamptz`, `updated_at timestamptz`, `expires_at bigint`, `payload jsonb`, `source_item jsonb`. Complete original envelopes retain every unknown/optional field and status transition. Missing creation/status fields stay null, not fabricated. Owner derives only from existing owner/key contracts.

| Table | Additional promoted columns | Source / row identity |
| --- | --- | --- |
| dedupe_claims | event_id text, observation_id text | DEDUPE#… / CLAIM; row_id original SK |
| exception_claims | source_dedupe_key text, extractor_version text | EXCEPTION_DEDUPE#… / CLAIM; original SK |
| ingestion_exceptions | received_at timestamptz, retry_status text, discarded boolean, index_pk text, index_sk text | EXCEPTION#id / EXCEPTION; original payload.id |
| ingestion_retries | dispatched_at timestamptz, job jsonb | RETRY#id / DISPATCH or DISPATCH#requestId; original SK |
| import_records | source jsonb, applied_at timestamptz | USER#owner / IMPORT#provider#id; original SK |
| bulk_edit_operations | applied_at timestamptz, undone_at timestamptz | BULK_EDIT#owner / OP#id; original payload.operationId |
| delivery_records | month text, prepared_at timestamptz, sent_at timestamptz, content_sha256 text | USER#owner / MONTHLY_CLOSE#month or MONTH_END_BALANCE_REMINDER#month; original SK |
| push_subscriptions | active boolean, content_mode text | USER#owner / PUSH#id; original subscriptionId |
| assistant_threads | session_id text, title text, first_month text | USER#owner / ASSISTANT_THREAD#id or ACTIVE; original suffix |

Top-level numeric expiresAt alone promotes to expires_at. Bulk payload deadline is preserved in JSONB even after physical TTL is removed on apply/undo. Retained expired envelopes are parity evidence; live displays filter them, native source deletion removes SQL rows through tombstones. No custom SQL expiry authority or mirrored native memory exists. Primary-key ranges serve the observed personal volume; no additional secondary indexes are needed. See [complete keys/writers/read boundaries/retention](dsql-operational-state.md).

## Operational tables

### olbia.projection_state

One checkpoint per supported source PK/SK, including tombstones for missing source items. This is not an application entity table.

```sql
CREATE TABLE IF NOT EXISTS olbia.projection_state (
    source_pk text NOT NULL, source_sk text NOT NULL, generation bigint NOT NULL,
    source_hash text, source_item jsonb, deleted boolean NOT NULL,
    transformer_version integer NOT NULL, reconciled_at timestamptz NOT NULL,
    stream_arn text, stream_sequence text, stream_delivered_at timestamptz,
    PRIMARY KEY (source_pk,source_sk));
```

| Column | Meaning |
| --- | --- |
| `generation` | SQL-local counter incremented on each reconciliation; used to create concurrent-write conflicts on the checkpoint. |
| `source_hash` | SHA-256 of canonical source JSON; null for an absent source item. |
| `source_item` | Full DynamoDB source envelope as JSONB, not only the domain payload. Null when absent. |
| `deleted` | Whether the source item is absent. A default category can still have an effective relational row. |
| `transformer_version` | Projection transformation version, currently 4. |
| `reconciled_at` | Time SQL reconciliation applied the source’s current state. |
| `stream_arn`, `stream_sequence`, `stream_delivered_at` | Last applied stream-trigger evidence for this key. These are not a global source version or a completeness watermark; recovery replay can update them. |

The checkpoint and its derived rows commit in the same SQL transaction. Reconciliation rereads current DynamoDB; it does not write stale stream images into SQL. Checkpoint count includes defaults/tombstones and must not be treated as the number of financial movements.

### olbia.schema_migrations

```sql
CREATE TABLE IF NOT EXISTS olbia.schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL);
```

Records applied SQL schema versions. Bootstrap preserves versions 1/2/3 and adds version 4 with conflict-safe inserts. Version 2 created the two planning/payroll tables. Version 3 creates four Patrimonio tables and explicitly adds cards.source_item. CloudFormation bootstrap provider version 5 applied the additive DDL and grants; provider 6 extended category/rule SELECT grants and the card-cycle reader identity; provider 7 adds operational tables and the separate verifier role. Versions 2/3 of the provider previously handled deployment recovery and movement reader grants.

## View and indexes

### olbia.movement_months

```sql
CREATE OR REPLACE VIEW olbia.movement_months AS
    SELECT id AS movement_id, spend_month AS month FROM olbia.movements
    UNION SELECT movement_id, month FROM olbia.msi_installments;
```

Returns distinct (movement_id, month) pairs from the movement’s original financial month and its scheduled installment months. UNION removes duplicate pairs. The view includes all source states; callers must apply the domain’s status/spending rules. It is not a materialized view and is not the application’s current monthly query implementation.

### Secondary indexes

```sql
CREATE INDEX ASYNC IF NOT EXISTS movements_month_idx
    ON olbia.movements (spend_month, id);
CREATE INDEX ASYNC IF NOT EXISTS installments_month_idx
    ON olbia.msi_installments (month, movement_id);
```

Both are non-unique. Every table also has its primary-key index. Bootstrap waits for native index readiness before enabling projection.

## Access and maintenance

The SQL runtime role `olbia_projector` has schema USAGE and SELECT/INSERT/UPDATE/DELETE on the twenty-four entity tables and projection_state. It has SELECT only on schema_migrations and movement_months. The projector, maintenance, replay and schema-bootstrap IAM roles are associated with this SQL role. The schema-bootstrap function also has admin connection permission to perform DDL, then uses the non-admin role for its smoke check. The projector, maintenance and replay functions do not have admin connection permission.

`olbia_reader` has schema USAGE and SELECT only on `movements`, `movement_observations`, `movement_revisions`, `msi_installments`, `monthly_plans`, `payroll`, `cards`, `wealth_snapshots`, `wealth_versions`, `liability_snapshots`, `liability_versions`, `categories`, `merchant_category_rules`, `ingestion_exceptions`, `import_records`, `push_subscriptions` and `assistant_threads`. The API, read verification, agent tools, daily balance push, monthly close, month-end reminder and card-cycle push IAM identities connect through this role without SQL write/admin grants. Bootstrap provider 5 added the four snapshot/audit tables and existing cards; provider 6 adds SELECT on existing categories/rules and the card-cycle identity. Existing schema/transformer 3 keys/indexes remain.

Maintain this reference whenever DDL, transformation, keys, indexes or projection scope change. Adding a column to CREATE TABLE IF NOT EXISTS does not alter an existing table: future schema changes need explicit additive, versioned migrations.

Definition sources: [model.ts](../services/ledger/src/dsql/model.ts), [schema.ts](../services/ledger/src/dsql/schema.ts), [projection.ts](../services/ledger/src/dsql/projection.ts). Operational context: [runbook](dsql-migration-runbook.md), [migration plan](dsql-migration-plan.md), and [verified deployment repair](autonomous-runs/2026-09-30-dsql-deployment-repair.md).

The [remaining domain-read phase](dsql-domain-reads.md) keeps schema/transformer version 3 and uses bootstrap provider 6 for thirteen SELECT-only reader tables (adds existing categories/rules) and the existing card-cycle worker association. No new tables, columns, indexes or projection/recovery changes are needed.


Version 4 preserves migration rows 1/2/3 and adds row 4 and nine tables. Bootstrap provider 7 grants product olbia_reader SELECT only on four display tables (17 total with prior financial tables), and olbia_operational_verifier SELECT only on nine operational tables for the deployed probe. Projector runtime extends scoped table mutation grants across the complete 24-table projection; neither reader has mutation/admin permission. Existing native recovery and resource identities remain unchanged. Later schema text above preserves historical deployment context; the operational document/run record is the current rollout authority.
