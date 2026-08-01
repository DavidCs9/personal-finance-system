import type {
  EventRevision,
  IngestionException,
  Institution,
  ObservedPurchase,
  RawSourcePointer,
} from "@finance/domain";

/** An email obtained from Gmail before it is persisted or parsed. */
export interface IncomingEmail {
  readonly mime: string;
  readonly receivedAt: string;
  readonly sourceMessageId?: string;
}

export interface ParsedPurchase {
  readonly institution: Institution;
  readonly account?: ObservedPurchase["account"];
  readonly amount: ObservedPurchase["amount"];
  readonly merchantRaw: string;
  readonly eventType?: "card_purchase" | "outgoing_transfer";
  readonly counterparty?: string;
  readonly transferType?: "spei";
  readonly reference?: string;
  readonly folio?: string;
  readonly trackingKey?: string;
  readonly counterpartyInstitution?: string;
  readonly counterpartyAccountLastFour?: string;
  readonly occurredAt?: string;
  readonly parseWarnings?: readonly string[];
}

export interface CardPurchaseParser {
  readonly institution: Institution;
  readonly version: string;
  matches(email: IncomingEmail): boolean;
  parse(email: IncomingEmail): ParsedPurchase;
}

export interface RawSourceStore {
  save(input: { readonly mime: string; readonly sha256: string }): Promise<RawSourcePointer>;
  get(pointer: RawSourcePointer): Promise<string | undefined>;
}

export interface LedgerRepository {
  /** Returns false when this exact email identity has already been accepted for processing. */
  claimDedupeKey(dedupeKey: string): Promise<boolean>;
  savePurchase(purchase: ObservedPurchase): Promise<void>;
  saveException(exception: IngestionException): Promise<void>;
  getPurchase(id: string): Promise<ObservedPurchase | undefined>;
  listPurchases(): Promise<readonly ObservedPurchase[]>;
  listRevisions(observedPurchaseId: string): Promise<readonly EventRevision[]>;
}

export interface EventNotifier {
  notifyObservedPurchase(purchase: ObservedPurchase): Promise<void>;
  notifyException?(exception: IngestionException): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}
