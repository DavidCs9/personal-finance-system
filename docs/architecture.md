# Architecture (C4)

Maps of Olbia at three levels of zoom, following the [C4 model](https://c4model.com/). Mermaid flowcharts use C4 colours and stereotypes so they render cleanly on GitHub.

| Colour | Meaning |
| --- | --- |
| Dark blue | «Person» |
| Mid blue | «Software System» in scope |
| Light blue | «Container» or «Component» |
| Grey | External «Person», system, or «Container» |

Start with the [system context diagram in the root README](../README.md#architecture), then zoom into containers and components below.

## Container diagram (C2)

**Scope:** Olbia. **Audience:** engineers and operators.

Shows how responsibilities split across the SPA, HTTP edge, email ingestion pipeline, scheduled push and wealth sync, and data stores. Application logic lives in `services/*` and `packages/domain`. Shared observed-event persistence and month indexing live in `services/ledger`. `infrastructure/lambda/` holds thin adapters that re-export service handlers (plus a few infra-only functions: SES receipt, retry dispatcher, VAPID custom resource).

```mermaid
flowchart TB
  classDef person fill:#08427B,stroke:#052E56,color:#fff,stroke-width:1px
  classDef external fill:#999999,stroke:#6B6B6B,color:#fff,stroke-width:1px
  classDef container fill:#438DD5,stroke:#2E6295,color:#fff,stroke-width:1px
  classDef store fill:#438DD5,stroke:#2E6295,color:#fff,stroke-width:1px

  owner["`**Owner**
«Person»`"]
  gmail["`**Gmail**
«Software System»`"]
  shortcuts["`**Apple Shortcuts**
«Software System»`"]
  bitso["`**Bitso**
«Software System»`"]
  ibkr["`**IBKR Flex + Banxico**
«Software System»`"]
  textract["`**Amazon Textract**
«Software System»`"]
  webpush["`**Web Push network**
«Software System»`"]

  subgraph olbia["`**Olbia**`"]
    direction TB

    subgraph presentation["`**Presentation**`"]
      spa["`**Web SPA**
«Container: React · Vite · CloudFront»
_Resumen, Movimientos, Patrimonio, imports, push_`"]
      cognito["`**Identity**
«Container: Cognito»
_Single-user sign-in, JWT issuer_`"]
    end

    subgraph edge["`**HTTP edge**`"]
      api["`**Ledger API**
«Container: HTTP API + Lambda»
_Events, months, cards, wealth, statements, nómina, push_`"]
      apple["`**Apple Pay Capture**
«Container: HTTP API + Lambda»
_Bearer Shortcut intake_`"]
    end

    subgraph pipeline["`**Email ingestion**`"]
      ses["`**Email Gateway**
«Container: SES»
_Inbound receive + exception mail_`"]
      receipt["`**Email Receipt**
«Container: Lambda»
_Enqueues pointer-only jobs_`"]
      queue[("`**Ingestion Queue**
«Container: SQS + DLQ»`")]
      ingest["`**Ingestion Worker**
«Container: Lambda»
_Parse, dedupe, reconcile, notify_`"]
      bedrock["`**Bedrock Fallback Worker**
«Container: Lambda + SQS/DLQ»
_Structured extraction + evidence_`"]
      retry["`**Retry Dispatcher**
«Container: Lambda»
_Re-queues recoverable exceptions_`"]
    end

    subgraph data["`**Data**`"]
      ddb[("`**Metadata Store**
«Container: DynamoDB»
_Events, plans, cards, wealth, push_`")]
      raw[("`**Raw Source Store**
«Container: S3 + KMS»
_Encrypted MIME, CSV, PDF, evidence_`")]
    end

    daily["`**Daily Balance Push**
«Container: Lambda + Scheduler»
_07:00 America/Chihuahua summary_`"]
    cardsPush["`**Card Cycle Push**
«Container: Lambda + Scheduler»
_07:05 cut-off and payment reminders_`"]
    bitsoSync["`**Bitso Sync**
«Container: Lambda + Scheduler»
_06:30 America/Chihuahua_`"]
    ibkrSync["`**IBKR Sync**
«Container: Lambda + Scheduler»
_06:45 America/Chihuahua_`"]
  end

  owner -->|"Uses · HTTPS"| spa
  spa -->|"Signs in · SRP"| cognito
  spa -->|"Calls · JSON/HTTPS + JWT"| api

  gmail -->|"Forwards alerts · SMTP"| ses
  ses -->|"Stores MIME"| raw
  ses -->|"Invokes after store"| receipt
  receipt -->|"Enqueues pointer"| queue
  queue -->|"Delivers jobs"| ingest
  ingest -->|"Reads MIME"| raw
  ingest -->|"Queues parser failures"| bedrock
  bedrock -->|"Returns structured candidates"| queue
  bedrock -->|"Reads MIME"| raw
  ingest -->|"Writes events/exceptions"| ddb
  ingest -->|"Emails exceptions"| ses
  ses -->|"Delivers exception mail"| owner
  ingest -->|"Pushes new observations"| webpush

  shortcuts -->|"Posts captures · HTTPS + bearer"| apple
  apple -->|"Writes events"| ddb
  apple -->|"Pushes new observations"| webpush

  api -->|"Reads/writes"| ddb
  api -->|"CSV, PDF, nómina, wealth evidence"| raw
  api -->|"AnalyzeDocument"| textract
  api -->|"Writes retry jobs"| ddb
  retry -->|"Watches retries · stream"| ddb
  retry -->|"Re-queues jobs"| queue

  daily -->|"Reads month state"| ddb
  daily -->|"Pushes daily summary"| webpush
  cardsPush -->|"Reads cards + subscriptions"| ddb
  cardsPush -->|"Pushes cut-off/payment"| webpush
  bitsoSync -->|"Balances + tickers"| bitso
  bitsoSync -->|"Writes wealth snapshots"| ddb
  ibkrSync -->|"Flex + FIX"| ibkr
  ibkrSync -->|"Writes wealth snapshots"| ddb
  webpush -->|"Notifies devices"| owner

  class owner person
  class gmail,shortcuts,bitso,ibkr,textract,webpush external
  class spa,cognito,api,apple,ses,receipt,ingest,bedrock,retry,daily,cardsPush,bitsoSync,ibkrSync container
  class queue,ddb,raw store
```

## Component diagram — Ingestion Worker (C3)

**Scope:** Ingestion Worker container. **Audience:** developers changing parsers or reconciliation.

```mermaid
flowchart TB
  classDef component fill:#85BBF0,stroke:#5D8AB3,color:#000,stroke-width:1px
  classDef external fill:#999999,stroke:#6B6B6B,color:#fff,stroke-width:1px

  queue[("`**Ingestion Queue**
«Container: SQS»`")]
  raw[("`**Raw Source Store**
«Container: S3 + KMS»`")]
  ddb[("`**Metadata Store**
«Container: DynamoDB»`")]
  ses["`**Email Gateway**
«Container: SES»`"]
  webpush["`**Web Push network**
«Software System»`"]
  bedrock["`**Amazon Bedrock**
«Software System»`"]
  fallbackQueue[("`**Fallback Queue + DLQ**
«Container: SQS»`")]

  subgraph ingest["`**Ingestion Worker**`"]
    direction TB
    consumer["`**SQS Consumer**
«Component: TypeScript»
_Loads jobs, reports batch failures_`"]
    dedupe["`**Source Dedupe**
«Component: TypeScript»
_Claims message-id + SHA-256_`"]
    parsers["`**Email Parsers**
«Component: TypeScript»
_Amex, Santander, Nu, AWS Billing_`"]
    mime["`**MIME Normalizer**
«Component: mailparser»
_RFC MIME and HTML to text_`"]
    validator["`**Extraction Validator**
«Component: TypeScript»
_Schema, evidence, money, time_`"]
    reconcile["`**Observed Event Writer**
«Component: TypeScript»
_Persists observations, links matches_`"]
    exceptions["`**Exception Recorder**
«Component: TypeScript»
_Stores failures for UI recovery_`"]
    mail["`**Exception Mailer**
«Component: TypeScript»
_SES alerts for ingestion failures_`"]
    push["`**Purchase Push**
«Component: TypeScript»
_Notifies on accepted events_`"]
  end

  queue -->|"Delivers jobs"| consumer
  consumer -->|"Reads MIME"| raw
  consumer -->|"Normalizes MIME"| mime
  consumer -->|"Claims source identity"| dedupe
  dedupe -->|"Writes dedupe claim"| ddb
  consumer -->|"Selects parser"| parsers
  parsers -->|"Parsed purchase"| reconcile
  parsers -->|"Parse failure"| fallbackQueue
  fallbackQueue -->|"Structured extraction"| bedrock
  bedrock -->|"Candidate + evidence"| validator
  validator -->|"Validated purchase"| reconcile
  validator -->|"Rejected extraction"| exceptions
  reconcile -->|"Writes event + observation"| ddb
  reconcile -->|"New accepted event"| push
  exceptions -->|"Writes exception"| ddb
  exceptions -->|"Needs alert"| mail
  mail -->|"Sends email"| ses
  push -->|"Sends notification"| webpush

  class consumer,dedupe,mime,parsers,validator,reconcile,exceptions,mail,push component
  class queue,fallbackQueue,raw,ddb,ses,webpush,bedrock external
```

## Component diagram — Ledger API (C3)

**Scope:** Ledger API container. **Audience:** developers changing HTTP routes or ledger mutations.

Exception retries write a DynamoDB retry job; the Retry Dispatcher (C2) watches the stream and re-queues SQS — the API does not send to SQS directly.

Month income on `GET /months/:month` is derived from CFDI nómina payslips. `PUT /months/:month` persists only `upcomingPayments`.

```mermaid
flowchart TB
  classDef component fill:#85BBF0,stroke:#5D8AB3,color:#000,stroke-width:1px
  classDef external fill:#999999,stroke:#6B6B6B,color:#fff,stroke-width:1px

  spa["`**Web SPA**
«Container: React · Vite»`"]
  ddb[("`**Metadata Store**
«Container: DynamoDB»`")]
  raw[("`**Raw Source Store**
«Container: S3 + KMS»`")]
  textract["`**Amazon Textract**
«Software System»`"]

  subgraph api["`**Ledger API**`"]
    direction TB
    router["`**HTTP Router**
«Component: TypeScript»
_JWT-authenticated request routing_`"]
    events["`**Events API**
«Component: TypeScript»
_List, patch, serve raw evidence_`"]
    manual["`**Manual Entry**
«Component: TypeScript»
_Observed charges without automation_`"]
    exceptions["`**Exceptions API**
«Component: TypeScript»
_List, retry, discard recovery items_`"]
    months["`**Monthly Plan API**
«Component: TypeScript»
_Upcoming payments; income via nómina GET_`"]
    cards["`**Cards API**
«Component: TypeScript»
_Cut-off and payment day profiles_`"]
    wealth["`**Wealth API**
«Component: TypeScript»
_Overview, Cajita, liabilities, sync_`"]
    statements["`**Statement Imports**
«Component: TypeScript»
_Amex + Santander PDF via Textract_`"]
    csv["`**Santander CSV Import**
«Component: TypeScript»
_Preview and apply reconciliation_`"]
    nomina["`**CFDI Nómina**
«Component: TypeScript»
_XML upload and payslip queries_`"]
    pushsubs["`**Push Subscriptions**
«Component: TypeScript»
_Register and remove endpoints_`"]
  end

  spa -->|"JSON/HTTPS + JWT"| router
  router -->|"Events routes"| events
  router -->|"POST /events/manual"| manual
  router -->|"Exception routes"| exceptions
  router -->|"Month routes"| months
  router -->|"Card routes"| cards
  router -->|"Wealth routes"| wealth
  router -->|"Statement preview/poll/apply"| statements
  router -->|"CSV import routes"| csv
  router -->|"POST /imports/nomina"| nomina
  router -->|"Push routes"| pushsubs

  events -->|"Reads/writes"| ddb
  events -->|"Reads MIME evidence"| raw
  manual -->|"Creates events"| ddb
  exceptions -->|"Updates + writes retry jobs"| ddb
  months -->|"Reads/writes"| ddb
  cards -->|"Reads/writes"| ddb
  wealth -->|"Reads/writes"| ddb
  wealth -->|"Stores sync evidence"| raw
  statements -->|"Stores PDF + textract JSON"| raw
  statements -->|"AnalyzeDocument"| textract
  statements -->|"Links or creates events"| ddb
  csv -->|"Stores CSV"| raw
  csv -->|"Links or creates events"| ddb
  nomina -->|"Stores XML + payslips"| ddb
  nomina -->|"Stores XML evidence"| raw
  pushsubs -->|"Reads/writes"| ddb

  class router,events,manual,exceptions,months,cards,wealth,statements,csv,nomina,pushsubs component
  class spa,ddb,raw,textract external
```

## Component diagram — Web SPA (C3)

**Scope:** Web SPA container. **Audience:** developers changing the review UI.

```mermaid
flowchart TB
  classDef component fill:#85BBF0,stroke:#5D8AB3,color:#000,stroke-width:1px
  classDef external fill:#999999,stroke:#6B6B6B,color:#fff,stroke-width:1px

  cognito["`**Identity**
«Container: Cognito»`"]
  api["`**Ledger API**
«Container: HTTP API + Lambda»`"]
  webpush["`**Web Push network**
«Software System»`"]

  subgraph spa["`**Web SPA**`"]
    direction TB
    auth["`**Auth Session**
«Component: React»
_Personalized Cognito sign-in and JWT refresh_`"]
    summary["`**Summary View**
«Component: React»
_Spend, remaining, pace, MSI, cards_`"]
    movements["`**Movements View**
«Component: React»
_Events, recovery, capture actions_`"]
    wealthView["`**Patrimonio View**
«Component: React»
_Neto, assets, Debes, history_`"]
    sheets["`**Action Sheets**
«Component: React»
_Income, payments, statements, recovery_`"]
    privateMode["`**Private Mode**
«Component: React»
_Blurs amounts in the UI_`"]
    pushpref["`**Push Preference**
«Component: React»
_Device subscribe (amounts mode)_`"]
    client["`**Ledger API Client**
«Component: TypeScript»
_TanStack Query + fetch boundary_`"]
  end

  auth -->|"Signs in · SRP"| cognito
  auth -->|"Supplies JWT"| client
  summary -->|"Loads month + events"| client
  movements -->|"Loads events + exceptions"| client
  wealthView -->|"Loads wealth overview"| client
  sheets -->|"Mutates ledger state"| client
  pushpref -->|"Manages subscriptions"| client
  pushpref -->|"Subscribes browser"| webpush
  client -->|"JSON/HTTPS + JWT"| api

  class auth,summary,movements,wealthView,sheets,privateMode,pushpref,client component
  class cognito,api,webpush external
```

## Related docs

- [V1 decisions](v1-decisions.md) — binding scope, data model, and AWS choices
- [Patrimonio](patrimonio.md)
- [Meses sin intereses (MSI)](msi.md)
- [UI design brief](ui-design-brief.md)
- [Gmail → SES forwarding](gmail-forwarding.md)
- [Apple Pay Shortcut](apple-pay-shortcut.md)
- [Push on new observable](push-on-new-observable.md)
- [Daily balance push](daily-balance-push.md)
- [Card cycle push](card-cycle-push.md)
