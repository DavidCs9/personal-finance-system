import { randomUUID } from "node:crypto";
import type { IngestionException, ObservedPurchase, RawSourcePointer } from "@finance/domain";
import { sha256 } from "./in-memory.js";
import type {
  CardPurchaseParser,
  Clock,
  EventNotifier,
  IdGenerator,
  IncomingEmail,
  LedgerRepository,
  RawSourceStore,
} from "./types.js";

export type IngestionResult =
  | { readonly kind: "accepted"; readonly purchase: ObservedPurchase }
  | { readonly kind: "needs_review"; readonly exception: IngestionException }
  | { readonly kind: "duplicate"; readonly dedupeKey: string };

const systemClock: Clock = { now: () => new Date() };
const uuidGenerator: IdGenerator = { next: () => randomUUID() };

const normaliseMessageId = (value?: string): string | undefined =>
  value?.trim().replace(/^<|>$/g, "").toLowerCase() || undefined;

/**
 * Binds the originating email identity to its content. This is intentionally
 * not based on merchant, amount or date, which could describe valid purchases.
 */
export const stableDedupeKey = (email: IncomingEmail, sourceHash: string): string =>
  sha256(`${normaliseMessageId(email.sourceMessageId) ?? "no-message-id"}:${sourceHash}`);

export class IngestionPipeline {
  constructor(
    private readonly dependencies: {
      readonly rawSources: RawSourceStore;
      readonly ledger: LedgerRepository;
      readonly parsers: readonly CardPurchaseParser[];
      readonly notifier: EventNotifier;
      readonly clock?: Clock;
      readonly ids?: IdGenerator;
    },
  ) {}

  async ingest(email: IncomingEmail): Promise<IngestionResult> {
    // Persisting before any other action makes unknown templates recoverable.
    const sourceHash = sha256(email.mime);
    const source = await this.dependencies.rawSources.save({ mime: email.mime, sha256: sourceHash });
    const dedupeKey = stableDedupeKey(email, sourceHash);
    if (!(await this.dependencies.ledger.claimDedupeKey(dedupeKey))) {
      return { kind: "duplicate", dedupeKey };
    }

    const parser = this.dependencies.parsers.find((candidate) => candidate.matches(email));
    if (!parser) {
      return this.createException(email, source, "unsupported_source", "No configured parser accepted this email.");
    }

    try {
      const parsed = parser.parse(email);
      if (parsed.amount.amountMinor <= 0 || !parsed.amount.currency || !parsed.merchantRaw.trim()) {
        return this.createException(email, source, "missing_required_data", "Parser returned incomplete event data.", parser.institution);
      }

      const purchase: ObservedPurchase = {
        id: this.ids.next(),
        institution: parsed.institution,
        eventType: parsed.eventType ?? "card_purchase",
        status: "accepted",
        account: parsed.account,
        amount: parsed.amount,
        merchantRaw: parsed.merchantRaw,
        counterparty: parsed.counterparty,
        transferType: parsed.transferType,
        reference: parsed.reference,
        folio: parsed.folio,
        trackingKey: parsed.trackingKey,
        counterpartyInstitution: parsed.counterpartyInstitution,
        counterpartyAccountLastFour: parsed.counterpartyAccountLastFour,
        billingPeriod: parsed.billingPeriod,
        paymentMethodLastFour: parsed.paymentMethodLastFour,
        occurredAt: parsed.occurredAt,
        receivedAt: email.receivedAt,
        ingestedAt: this.clock.now().toISOString(),
        sourceMessageId: normaliseMessageId(email.sourceMessageId),
        source,
        parserVersion: parser.version,
        parseWarnings: parsed.parseWarnings ?? [],
      };
      await this.dependencies.ledger.savePurchase(purchase);
      await this.dependencies.notifier.notifyObservedPurchase(purchase);
      return { kind: "accepted", purchase };
    } catch (error) {
      const details = error instanceof Error ? error.message : "Unknown parser failure";
      return this.createException(email, source, "parser_failed", details, parser.institution);
    }
  }

  private get clock(): Clock {
    return this.dependencies.clock ?? systemClock;
  }

  private get ids(): IdGenerator {
    return this.dependencies.ids ?? uuidGenerator;
  }

  private async createException(
    email: IncomingEmail,
    source: RawSourcePointer,
    reason: IngestionException["reason"],
    details: string,
    institution?: IngestionException["institution"],
  ): Promise<IngestionResult> {
    const exception: IngestionException = {
      id: this.ids.next(),
      receivedAt: email.receivedAt,
      institution,
      reason,
      source,
      details,
    };
    await this.dependencies.ledger.saveException(exception);
    await this.dependencies.notifier.notifyException?.(exception);
    return { kind: "needs_review", exception };
  }
}
