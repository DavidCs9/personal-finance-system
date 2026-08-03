export interface CardCycle {
  readonly id: string;
  readonly name: string;
  readonly cutOffDay: number;
  readonly paymentDueDay: number;
  readonly institution?: "american_express_mx" | "santander_mx" | "nu_mx";
  readonly createdAt?: string;
  readonly updatedAt?: string;
}
