import type { Institution, ObservedPurchase } from "@finance/domain";

export interface ParsedPurchase {
  readonly institution: Institution;
  readonly account?: ObservedPurchase["account"];
  readonly amount: ObservedPurchase["amount"];
  readonly merchantRaw: string;
  readonly eventType?: "card_purchase" | "outgoing_transfer" | "card_charge";
  readonly counterparty?: string;
  readonly transferType?: "spei";
  readonly reference?: string;
  readonly folio?: string;
  readonly trackingKey?: string;
  readonly counterpartyInstitution?: string;
  readonly counterpartyAccountLastFour?: string;
  readonly billingPeriod?: string;
  readonly paymentMethodLastFour?: string;
  readonly occurredAt?: string;
  readonly parseWarnings?: readonly string[];
}
