# Architecture (C4)

Maps of Olbia at three levels of zoom, following the [C4 model](https://c4model.com/). Mermaid flowcharts use C4 colours and stereotypes so they render cleanly on GitHub.

| Colour | Meaning |
| --- | --- |
| Dark blue | Person |
| Mid blue | Software system in scope |
| Light blue | Container or component |
| Grey | External person, system, or container |

Start with the [system context diagram in the root README](../README.md#architecture), then zoom into containers and components below.

## Container diagram (C2)

**Scope:** Olbia. **Audience:** engineers and operators.

Shows how responsibilities split across the SPA, HTTP edge, email ingestion pipeline, scheduled push, and data stores. Production entry points live under `infrastructure/lambda/`; `services/*` are portable libraries used mainly for tests.

```mermaid
flowchart TB
  classDef person fill:#08427B,stroke:#052E56,color:#fff,stroke-width:1px
  classDef external fill:#999999,stroke:#6B6B6B,color:#fff,stroke-width:1px
  classDef container fill:#438DD5,stroke:#2E6295,color:#fff,stroke-width:1px
  classDef store fill:#438DD5,stroke:#2E6295,color:#fff,stroke-width:1px

  owner["Owner\nPerson"]
  gmail["Gmail\nSoftware System"]
  shortcuts["Apple Shortcuts\nSoftware System"]
  webpush["Web Push network\nSoftware System"]

  subgraph olbia["Olbia"]
    direction TB

    subgraph presentation["Presentation"]
      spa["Web SPA\nContainer: React · Vite · CloudFront\nResumen, Movimientos, imports, push prefs"]
      cognito["Identity\nContainer: Cognito\nSingle-user sign-in, JWT issuer"]
    end

    subgraph edge["HTTP edge"]
      api["Ledger API\nContainer: HTTP API + Lambda\nEvents, plans, imports, push subscriptions"]
      apple["Apple Pay Capture\nContainer: HTTP API + Lambda\nBearer Shortcut intake"]
    end

    subgraph pipeline["Email ingestion"]
      ses["Email Gateway\nContainer: SES\nInbound receive + exception mail"]
      receipt["Email Receipt\nContainer: Lambda\nEnqueues pointer-only jobs"]
      queue[("Ingestion Queue\nContainer: SQS + DLQ")]
      ingest["Ingestion Worker\nContainer: Lambda\nParse, dedupe, reconcile, notify"]
      retry["Retry Dispatcher\nContainer: Lambda\nRe-queues recoverable exceptions"]
    end

    subgraph data["Data"]
      ddb[("Metadata Store\nContainer: DynamoDB\nEvents, observations, plans, dedupe, push")]
      raw[("Raw Source Store\nContainer: S3 + KMS\nEncrypted MIME, CSV, evidence")]
    end

    daily["Daily Balance Push\nContainer: Lambda + Scheduler\n07:00 America/Chihuahua summary"]
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
  ingest -->|"Writes events/exceptions"| ddb
  ingest -->|"Emails exceptions"| ses
  ses -->|"Delivers exception mail"| owner
  ingest -->|"Pushes new observations"| webpush

  shortcuts -->|"Posts captures · HTTPS + bearer"| apple
  apple -->|"Writes events"| ddb
  apple -->|"Pushes new observations"| webpush

  api -->|"Reads/writes"| ddb
  api -->|"CSV + raw evidence"| raw
  api -->|"Writes retry jobs"| ddb
  retry -->|"Watches retries · stream"| ddb
  retry -->|"Re-queues jobs"| queue

  daily -->|"Reads month state"| ddb
  daily -->|"Pushes daily summary"| webpush
  webpush -->|"Notifies devices"| owner

  class owner person
  class gmail,shortcuts,webpush external
  class spa,cognito,api,apple,ses,receipt,ingest,retry,daily container
  class queue,ddb,raw store
```

## Component diagram — Ingestion Worker (C3)

**Scope:** Ingestion Worker container. **Audience:** developers changing parsers or reconciliation.

```mermaid
flowchart TB
  classDef component fill:#85BBF0,stroke:#5D8AB3,color:#000,stroke-width:1px
  classDef external fill:#999999,stroke:#6B6B6B,color:#fff,stroke-width:1px

  queue[("Ingestion Queue\nContainer: SQS")]
  raw[("Raw Source Store\nContainer: S3 + KMS")]
  ddb[("Metadata Store\nContainer: DynamoDB")]
  ses["Email Gateway\nContainer: SES"]
  webpush["Web Push network\nSoftware System"]

  subgraph ingest["Ingestion Worker"]
    direction TB
    consumer["SQS Consumer\nComponent: TypeScript\nLoads jobs, reports batch failures"]
    dedupe["Source Dedupe\nComponent: TypeScript\nClaims message-id + SHA-256"]
    parsers["Email Parsers\nComponent: TypeScript\nAmex, Santander, Nu, AWS Billing"]
    reconcile["Observed Event Writer\nComponent: TypeScript\nPersists observations, links matches"]
    exceptions["Exception Recorder\nComponent: TypeScript\nStores failures for UI recovery"]
    mail["Exception Mailer\nComponent: TypeScript\nSES alerts for ingestion failures"]
    push["Purchase Push\nComponent: TypeScript\nNotifies on accepted events"]
  end

  queue -->|"Delivers jobs"| consumer
  consumer -->|"Reads MIME"| raw
  consumer -->|"Claims source identity"| dedupe
  dedupe -->|"Writes dedupe claim"| ddb
  consumer -->|"Selects parser"| parsers
  parsers -->|"Parsed purchase"| reconcile
  parsers -->|"Parse failure"| exceptions
  reconcile -->|"Writes event + observation"| ddb
  reconcile -->|"New accepted event"| push
  exceptions -->|"Writes exception"| ddb
  exceptions -->|"Needs alert"| mail
  mail -->|"Sends email"| ses
  push -->|"Sends notification"| webpush

  class consumer,dedupe,parsers,reconcile,exceptions,mail,push component
  class queue,raw,ddb,ses,webpush external
```

## Component diagram — Ledger API (C3)

**Scope:** Ledger API container. **Audience:** developers changing HTTP routes or ledger mutations.

Exception retries write a DynamoDB retry job; the Retry Dispatcher (C2) watches the stream and re-queues SQS — the API does not send to SQS directly.

```mermaid
flowchart TB
  classDef component fill:#85BBF0,stroke:#5D8AB3,color:#000,stroke-width:1px
  classDef external fill:#999999,stroke:#6B6B6B,color:#fff,stroke-width:1px

  spa["Web SPA\nContainer: React · Vite"]
  ddb[("Metadata Store\nContainer: DynamoDB")]
  raw[("Raw Source Store\nContainer: S3 + KMS")]

  subgraph api["Ledger API"]
    direction TB
    router["HTTP Router\nComponent: TypeScript\nJWT-authenticated request routing"]
    events["Events API\nComponent: TypeScript\nList, patch, serve raw evidence"]
    manual["Manual Entry\nComponent: TypeScript\nObserved charges without automation"]
    exceptions["Exceptions API\nComponent: TypeScript\nList, retry, discard recovery items"]
    months["Monthly Plan API\nComponent: TypeScript\nIncome and upcoming payments"]
    csv["Santander CSV Import\nComponent: TypeScript\nPreview and apply reconciliation"]
    pushsubs["Push Subscriptions\nComponent: TypeScript\nRegister and remove endpoints"]
  end

  spa -->|"JSON/HTTPS + JWT"| router
  router -->|"Events routes"| events
  router -->|"POST /events/manual"| manual
  router -->|"Exception routes"| exceptions
  router -->|"Month routes"| months
  router -->|"Import routes"| csv
  router -->|"Push routes"| pushsubs

  events -->|"Reads/writes"| ddb
  events -->|"Reads MIME evidence"| raw
  manual -->|"Creates events"| ddb
  exceptions -->|"Updates + writes retry jobs"| ddb
  months -->|"Reads/writes"| ddb
  csv -->|"Stores CSV"| raw
  csv -->|"Links or creates events"| ddb
  pushsubs -->|"Reads/writes"| ddb

  class router,events,manual,exceptions,months,csv,pushsubs component
  class spa,ddb,raw external
```

## Component diagram — Web SPA (C3)

**Scope:** Web SPA container. **Audience:** developers changing the review UI.

```mermaid
flowchart TB
  classDef component fill:#85BBF0,stroke:#5D8AB3,color:#000,stroke-width:1px
  classDef external fill:#999999,stroke:#6B6B6B,color:#fff,stroke-width:1px

  cognito["Identity\nContainer: Cognito"]
  api["Ledger API\nContainer: HTTP API + Lambda"]
  webpush["Web Push network\nSoftware System"]

  subgraph spa["Web SPA"]
    direction TB
    auth["Auth Session\nComponent: React\nCognito sign-in and JWT refresh"]
    summary["Summary View\nComponent: React\nSpend, remaining, pace"]
    movements["Movements View\nComponent: React\nEvents, recovery, capture actions"]
    sheets["Action Sheets\nComponent: React\nIncome, payments, detail, CSV, recovery"]
    pushpref["Push Preference\nComponent: React\nDevice subscribe and content mode"]
    client["Ledger API Client\nComponent: TypeScript\nTanStack Query + fetch boundary"]
  end

  auth -->|"Signs in · SRP"| cognito
  auth -->|"Supplies JWT"| client
  summary -->|"Loads month + events"| client
  movements -->|"Loads events + exceptions"| client
  sheets -->|"Mutates ledger state"| client
  pushpref -->|"Manages subscriptions"| client
  pushpref -->|"Subscribes browser"| webpush
  client -->|"JSON/HTTPS + JWT"| api

  class auth,summary,movements,sheets,pushpref,client component
  class cognito,api,webpush external
```

## Related docs

- [V1 decisions](v1-decisions.md) — binding scope, data model, and AWS choices
- [Gmail → SES forwarding](gmail-forwarding.md)
- [Apple Pay Shortcut](apple-pay-shortcut.md)
- [Push on new observable](push-on-new-observable.md)
- [Daily balance push](daily-balance-push.md)
