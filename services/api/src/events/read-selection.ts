// Match the serialized public contract, including array order; object member order isn't meaningful.
const canonical = (value: unknown): string | undefined => JSON.stringify(value, (_key, entry) =>
  entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
export const samePublicResult = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);
