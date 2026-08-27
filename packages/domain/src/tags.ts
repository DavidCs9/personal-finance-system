export const MAX_EVENT_TAGS = 20;
export const MAX_EVENT_TAG_LENGTH = 48;

const TAG_PATTERN = /^[a-z0-9][a-z0-9_-]*(?::[a-z0-9][a-z0-9_-]*)?$/;

export class InvalidEventTagError extends Error {}

export const normalizeEventTag = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");

export const normalizeEventTags = (values: readonly unknown[]): readonly string[] => {
  if (!Array.isArray(values)) throw new InvalidEventTagError("tags must be an array.");
  const normalized = [...new Set(values.map((value) => {
    if (typeof value !== "string") throw new InvalidEventTagError("Cada tag debe ser texto.");
    const tag = normalizeEventTag(value);
    if (!tag || tag.length > MAX_EVENT_TAG_LENGTH || !TAG_PATTERN.test(tag)) {
      throw new InvalidEventTagError(`Tag inválido: ${value}`);
    }
    return tag;
  }))].sort((left, right) => left.localeCompare(right, "es"));
  if (normalized.length > MAX_EVENT_TAGS) {
    throw new InvalidEventTagError(`Un movimiento admite máximo ${MAX_EVENT_TAGS} tags.`);
  }
  return normalized;
};

export const applyEventTagChange = (
  current: readonly string[] | undefined,
  change: { readonly addTags?: readonly string[]; readonly removeTags?: readonly string[] },
): readonly string[] => {
  const existing = normalizeEventTags(current ?? []);
  const additions = normalizeEventTags(change.addTags ?? []);
  const removals = new Set(normalizeEventTags(change.removeTags ?? []));
  return normalizeEventTags([...existing.filter((tag) => !removals.has(tag)), ...additions]);
};
