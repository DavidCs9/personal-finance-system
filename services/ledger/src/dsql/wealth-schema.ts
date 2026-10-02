/** Immutable financial captures and explicit daily selection for David's Patrimonio. */
export const NATIVE_WEALTH_TABLES = [
  'asset_accounts', 'asset_captures', 'asset_holdings', 'asset_daily_captures', 'asset_capture_replacements',
  'liability_captures', 'liability_daily_captures', 'liability_capture_replacements',
] as const;

const signedMoney = 'BETWEEN -9007199254740991 AND 9007199254740991';
const nonnegativeMoney = 'BETWEEN 0 AND 9007199254740991';
const finiteQuantity = 'BETWEEN -1.7976931348623157e308::double precision AND 1.7976931348623157e308::double precision';
const evidence = `evidence_bucket text NOT NULL CHECK (length(evidence_bucket)>0),
  evidence_key text NOT NULL CHECK (length(evidence_key)>0),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  evidence_content_type text NOT NULL CHECK (evidence_content_type='application/json')`;

export const NATIVE_WEALTH_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS olbia.asset_accounts (
    id text PRIMARY KEY CHECK (id IN ('nu_cajita_emergencia','bitso','ibkr')),
    name text NOT NULL CHECK (length(name)>0), institution text NOT NULL CHECK (length(institution)>0),
    role text NOT NULL CHECK (role IN ('emergency_fund','crypto','brokerage')),
    sync text NOT NULL CHECK (sync IN ('manual','api','flex')),
    position integer NOT NULL UNIQUE CHECK (position BETWEEN 0 AND 2))`,
  `CREATE TABLE IF NOT EXISTS olbia.asset_captures (
    id uuid PRIMARY KEY, account_id text NOT NULL REFERENCES olbia.asset_accounts(id),
    owner text NOT NULL CHECK (length(owner)>0), day date NOT NULL, captured_at timestamptz NOT NULL,
    source text NOT NULL CHECK (source IN ('manual','api','flex')),
    fx_rate double precision CHECK (fx_rate>0 AND fx_rate<=1.7976931348623157e308::double precision),
    fx_source text, ${evidence},
    CONSTRAINT asset_captures_daily_identity_key UNIQUE (account_id,day,id),
    CHECK (day=(captured_at AT TIME ZONE 'America/Chihuahua')::date))`,
  `CREATE TABLE IF NOT EXISTS olbia.asset_holdings (
    capture_id uuid NOT NULL REFERENCES olbia.asset_captures(id),
    position integer NOT NULL CHECK (position>=0),
    id text NOT NULL CHECK (length(id)>0), symbol text NOT NULL CHECK (length(symbol)>0), name text NOT NULL,
    quantity double precision NOT NULL CHECK (quantity ${finiteQuantity}),
    currency text NOT NULL CHECK (length(currency)>0),
    value_native_minor bigint NOT NULL CHECK (value_native_minor ${signedMoney}),
    value_mxn_minor bigint NOT NULL CHECK (value_mxn_minor ${signedMoney}),
    PRIMARY KEY (capture_id,position), CONSTRAINT asset_holdings_identity_key UNIQUE (capture_id,id))`,
  `CREATE TABLE IF NOT EXISTS olbia.asset_daily_captures (
    account_id text NOT NULL, day date NOT NULL, capture_id uuid NOT NULL UNIQUE,
    PRIMARY KEY (account_id,day),
    CONSTRAINT asset_daily_capture_ownership_fk FOREIGN KEY (account_id,day,capture_id)
      REFERENCES olbia.asset_captures(account_id,day,id))`,
  `CREATE TABLE IF NOT EXISTS olbia.asset_capture_replacements (
    account_id text NOT NULL, day date NOT NULL,
    previous_capture_id uuid PRIMARY KEY, replacement_capture_id uuid NOT NULL UNIQUE,
    CONSTRAINT asset_replacement_previous_ownership_fk FOREIGN KEY (account_id,day,previous_capture_id)
      REFERENCES olbia.asset_captures(account_id,day,id),
    CONSTRAINT asset_replacement_next_ownership_fk FOREIGN KEY (account_id,day,replacement_capture_id)
      REFERENCES olbia.asset_captures(account_id,day,id),
    CHECK (previous_capture_id<>replacement_capture_id))`,
  `CREATE TABLE IF NOT EXISTS olbia.liability_captures (
    id uuid PRIMARY KEY, card_id text NOT NULL REFERENCES olbia.card_profiles(id),
    owner text NOT NULL CHECK (length(owner)>0), day date NOT NULL, captured_at timestamptz NOT NULL,
    amount_mxn_minor bigint NOT NULL CHECK (amount_mxn_minor ${nonnegativeMoney}),
    ${evidence},
    CONSTRAINT liability_captures_daily_identity_key UNIQUE (card_id,day,id),
    CHECK (day=(captured_at AT TIME ZONE 'America/Chihuahua')::date))`,
  `CREATE TABLE IF NOT EXISTS olbia.liability_daily_captures (
    card_id text NOT NULL, day date NOT NULL, capture_id uuid NOT NULL UNIQUE,
    PRIMARY KEY (card_id,day),
    CONSTRAINT liability_daily_capture_ownership_fk FOREIGN KEY (card_id,day,capture_id)
      REFERENCES olbia.liability_captures(card_id,day,id))`,
  `CREATE TABLE IF NOT EXISTS olbia.liability_capture_replacements (
    card_id text NOT NULL, day date NOT NULL,
    previous_capture_id uuid PRIMARY KEY, replacement_capture_id uuid NOT NULL UNIQUE,
    CONSTRAINT liability_replacement_previous_ownership_fk FOREIGN KEY (card_id,day,previous_capture_id)
      REFERENCES olbia.liability_captures(card_id,day,id),
    CONSTRAINT liability_replacement_next_ownership_fk FOREIGN KEY (card_id,day,replacement_capture_id)
      REFERENCES olbia.liability_captures(card_id,day,id),
    CHECK (previous_capture_id<>replacement_capture_id))`,
] as const;
