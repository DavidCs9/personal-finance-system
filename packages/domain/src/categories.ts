/** Spend category catalog + merchant→category rules. */

export interface SpendCategory {
  readonly id: string;
  readonly name: string;
  readonly sortOrder: number;
}

export interface MerchantCategoryRule {
  readonly id: string;
  /** Normalized merchant key (see normalizeMerchantKey). */
  readonly merchantKey: string;
  /** Optional substring match when exact key misses. */
  readonly pattern?: string;
  readonly categoryId: string;
  readonly source: "seed" | "human" | "llm_residual" | "agent_confirmed";
  readonly updatedAt: string;
}

/** Suggested default catalog for V1 (fixed list; subcategories later). */
export const DEFAULT_SPEND_CATEGORIES: readonly SpendCategory[] = [
  { id: "restaurantes", name: "Restaurantes", sortOrder: 10 },
  { id: "supermercado", name: "Supermercado", sortOrder: 20 },
  { id: "transporte", name: "Transporte", sortOrder: 30 },
  { id: "vivienda", name: "Vivienda", sortOrder: 40 },
  { id: "servicios", name: "Servicios", sortOrder: 50 },
  { id: "suscripciones", name: "Suscripciones", sortOrder: 60 },
  { id: "shopping", name: "Shopping", sortOrder: 70 },
  { id: "entretenimiento", name: "Entretenimiento", sortOrder: 80 },
  { id: "salud", name: "Salud", sortOrder: 90 },
  { id: "viajes", name: "Viajes", sortOrder: 100 },
  { id: "transferencias", name: "Transferencias", sortOrder: 110 },
  { id: "otros", name: "Otros", sortOrder: 120 },
];

export const isValidCategoryId = (value: string): boolean =>
  /^[a-z][a-z0-9_]{0,39}$/.test(value);

/** Collapse merchant/counterparty text for rule matching. */
export const normalizeMerchantKey = (raw: string): string =>
  raw
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

export const resolveCategoryId = (
  merchantRaw: string,
  rules: readonly MerchantCategoryRule[],
): string | undefined => {
  const key = normalizeMerchantKey(merchantRaw);
  if (!key) return undefined;
  const exact = rules.find((rule) => rule.merchantKey === key);
  if (exact) return exact.categoryId;
  const patterned = rules
    .filter((rule) => rule.pattern && key.includes(normalizeMerchantKey(rule.pattern)))
    .sort((left, right) => (right.pattern?.length ?? 0) - (left.pattern?.length ?? 0));
  return patterned[0]?.categoryId;
};

export const categoryLabel = (
  categoryId: string | null | undefined,
  catalog: readonly SpendCategory[],
): string => {
  if (!categoryId) return "Sin categoría";
  return catalog.find((item) => item.id === categoryId)?.name ?? categoryId;
};

/** Heuristic seed suggestions from merchant text (rules-first; LLM fills residuals later). */
export const suggestCategoryIdFromMerchant = (merchantRaw: string): string | undefined => {
  const key = normalizeMerchantKey(merchantRaw);
  if (!key) return undefined;
  const tests: readonly (readonly [RegExp, string])[] = [
    [/\b(uber|didi|cabify|metro|pemex|gasolin|oxxo gas|toll|caseta)\b/, "transporte"],
    [/\b(uber eats|rappi|didi food|restaur|cafe|coffee|starbucks|vips|toks|sushi|pizza|burger|tacos)\b/, "restaurantes"],
    [/\b(walmart|soriana|chedraui|heb|costco|sam s|super|abarrotes|la comer)\b/, "supermercado"],
    [/\b(netflix|spotify|apple\.com|icloud|google|amazon prime|disney|youtube|microsoft|adobe)\b/, "suscripciones"],
    [/\b(cfe|telmex|totalplay|izzi|megacable|agua|predial|renta)\b/, "servicios"],
    [/\b(farmacia|hospital|doctor|dental|laboratorio)\b/, "salud"],
    [/\b(aeroméxico|aeromexico|vivaaerobus|volaris|hotel|booking|airbnb|expedia)\b/, "viajes"],
    [/\b(amazon|liverpool|palacio|zara|shein|mercado libre|mercadolibre)\b/, "shopping"],
    [/\b(cinepolis|cinemex|steam|playstation|xbox)\b/, "entretenimiento"],
    [/\b(spei|transfer|traspaso)\b/, "transferencias"],
  ];
  for (const [pattern, categoryId] of tests) {
    if (pattern.test(key)) return categoryId;
  }
  return undefined;
};
