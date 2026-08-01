import { createHash } from "node:crypto";
import type { EventRevision, IngestionException, ObservedPurchase, RawSourcePointer } from "@finance/domain";
import type { EventNotifier, LedgerRepository, RawSourceStore } from "./types.js";

/** Development/test double; production adapters will use S3 and DynamoDB. */
export class InMemoryRawSourceStore implements RawSourceStore {
  private readonly objects = new Map<string, string>();

  async save(input: { readonly mime: string; readonly sha256: string }): Promise<RawSourcePointer> {
    const key = `raw/${input.sha256}.eml`;
    this.objects.set(key, input.mime);
    return { bucket: "in-memory-raw-sources", key, sha256: input.sha256, contentType: "message/rfc822" };
  }

  async get(pointer: RawSourcePointer): Promise<string | undefined> {
    return this.objects.get(pointer.key);
  }
}

export class InMemoryLedgerRepository implements LedgerRepository {
  private readonly dedupeKeys = new Set<string>();
  readonly purchases = new Map<string, ObservedPurchase>();
  readonly exceptions = new Map<string, IngestionException>();
  readonly revisions = new Map<string, EventRevision[]>();

  async claimDedupeKey(dedupeKey: string): Promise<boolean> {
    if (this.dedupeKeys.has(dedupeKey)) return false;
    this.dedupeKeys.add(dedupeKey);
    return true;
  }

  async savePurchase(purchase: ObservedPurchase): Promise<void> {
    this.purchases.set(purchase.id, purchase);
  }

  async saveException(exception: IngestionException): Promise<void> {
    this.exceptions.set(exception.id, exception);
  }

  async getPurchase(id: string): Promise<ObservedPurchase | undefined> {
    return this.purchases.get(id);
  }

  async listPurchases(): Promise<readonly ObservedPurchase[]> {
    return [...this.purchases.values()];
  }

  async listRevisions(observedPurchaseId: string): Promise<readonly EventRevision[]> {
    return this.revisions.get(observedPurchaseId) ?? [];
  }
}

export class InMemoryNotifier implements EventNotifier {
  readonly observedPurchases: ObservedPurchase[] = [];
  readonly reportedExceptions: IngestionException[] = [];

  async notifyObservedPurchase(purchase: ObservedPurchase): Promise<void> {
    this.observedPurchases.push(purchase);
  }

  async notifyException(exception: IngestionException): Promise<void> {
    this.reportedExceptions.push(exception);
  }
}

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
