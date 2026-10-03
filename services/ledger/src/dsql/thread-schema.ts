/** Application metadata only; AgentCore owns session discovery and transcript events. */
export const NATIVE_THREAD_TABLES = ['conversation_threads','assistant_thread_selection'] as const;
export const NATIVE_THREAD_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS olbia.conversation_threads (
    id text PRIMARY KEY CHECK (length(id) BETWEEN 33 AND 100 AND id ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]*$'),
    owner text NOT NULL CHECK (length(owner)>0),
    title text NOT NULL CHECK (length(title) BETWEEN 1 AND 72),
    first_month text NOT NULL CHECK (first_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
    UNIQUE (id,owner))`,
  `CREATE TABLE IF NOT EXISTS olbia.assistant_thread_selection (
    id smallint PRIMARY KEY CHECK (id=1), owner text NOT NULL CHECK (length(owner)>0),
    thread_id text, updated_at timestamptz NOT NULL,
    CONSTRAINT assistant_thread_selection_owner_fk FOREIGN KEY (thread_id,owner)
      REFERENCES olbia.conversation_threads(id,owner))`,
] as const;
export const nativeThreadReadGrant=(role:string)=>`GRANT SELECT ON olbia.conversation_threads,olbia.assistant_thread_selection TO ${role}`;
export const nativeThreadWriteGrants=(role:string)=>[
  `GRANT INSERT,DELETE ON olbia.conversation_threads TO ${role}`,
  `GRANT UPDATE (updated_at,expires_at) ON olbia.conversation_threads TO ${role}`,
  `GRANT INSERT ON olbia.assistant_thread_selection TO ${role}`,
  `GRANT UPDATE (thread_id,updated_at) ON olbia.assistant_thread_selection TO ${role}`,
];
