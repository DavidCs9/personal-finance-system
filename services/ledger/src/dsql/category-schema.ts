/** Lifecycle is separate so existing category identities and financial FKs stay intact. */
export const NATIVE_CATEGORY_TABLES = ['category_lifecycle', 'category_catalog_changes'] as const;
export const NATIVE_CATEGORY_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS olbia.category_lifecycle (
    category_id text PRIMARY KEY REFERENCES olbia.spend_categories(id),
    archived boolean NOT NULL, revision integer NOT NULL CHECK (revision > 0))`,
  `CREATE TABLE IF NOT EXISTS olbia.category_catalog_changes (
    operation_id uuid PRIMARY KEY,
    category_id text NOT NULL REFERENCES olbia.spend_categories(id),
    revision integer NOT NULL CHECK (revision > 0),
    changed_by text NOT NULL CHECK (length(changed_by)>0),
    action text NOT NULL CHECK (action IN ('create','update','archive','restore')),
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL,
    previous_value jsonb, next_value jsonb NOT NULL,
    UNIQUE (category_id,revision),
    CHECK (previous_value IS NULL OR jsonb_typeof(previous_value)='object'),
    CHECK (jsonb_typeof(next_value)='object'))`,
] as const;
export const nativeCategoryReadGrant = (role: string) =>
  `GRANT SELECT ON olbia.category_lifecycle,olbia.category_catalog_changes TO ${role}`;
export const nativeCategoryWriteGrants = (role: string) => [
  `GRANT INSERT ON olbia.category_lifecycle,olbia.category_catalog_changes TO ${role}`,
  `GRANT UPDATE (archived,revision) ON olbia.category_lifecycle TO ${role}`,
];
