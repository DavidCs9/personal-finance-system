import type { EventRevision, Institution, ObservedPurchase } from "@finance/domain";
import type { LedgerRepository, RawSourceStore } from "@finance/ingestion";

export interface FeedFilter {
  readonly institution?: Institution;
  readonly accountId?: string;
  readonly from?: string;
  readonly to?: string;
}

export interface PurchaseDetail {
  readonly purchase: ObservedPurchase;
  readonly revisions: readonly EventRevision[];
}

export class FinanceApiService {
  constructor(
    private readonly ledger: LedgerRepository,
    private readonly rawSources: RawSourceStore,
  ) {}

  async feed(filter: FeedFilter = {}): Promise<readonly ObservedPurchase[]> {
    const purchases = await this.ledger.listPurchases();
    return purchases
      .filter((purchase) => {
        if (filter.institution && purchase.institution !== filter.institution) return false;
        if (filter.accountId && purchase.account?.accountId !== filter.accountId) return false;
        if (filter.from && purchase.receivedAt < filter.from) return false;
        if (filter.to && purchase.receivedAt > filter.to) return false;
        return true;
      })
      .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt));
  }

  async detail(id: string): Promise<PurchaseDetail | undefined> {
    const purchase = await this.ledger.getPurchase(id);
    if (!purchase) return undefined;
    return { purchase, revisions: await this.ledger.listRevisions(id) };
  }

  async raw(id: string): Promise<string | undefined> {
    const purchase = await this.ledger.getPurchase(id);
    return purchase ? this.rawSources.get(purchase.source) : undefined;
  }

  async revisions(id: string): Promise<readonly EventRevision[] | undefined> {
    const purchase = await this.ledger.getPurchase(id);
    return purchase ? this.ledger.listRevisions(id) : undefined;
  }
}
