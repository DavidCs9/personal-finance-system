import { describe, expect, it } from "vitest";
import {
  InvalidEventTagError,
  applyEventTagChange,
  normalizeEventTag,
  normalizeEventTags,
} from "../src/tags.js";

describe("event tags", () => {
  it("normalizes accents, whitespace, casing, and duplicates", () => {
    expect(normalizeEventTag("  Ciudad:CDMX ")).toBe("ciudad:cdmx");
    expect(normalizeEventTags(["Viaje:Végas", "viaje:vegas", " Trabajo "]))
      .toEqual(["trabajo", "viaje:vegas"]);
  });

  it("applies additions and removals deterministically", () => {
    expect(applyEventTagChange(["ciudad:cdmx", "personal"], {
      addTags: ["viaje:vegas"],
      removeTags: ["personal"],
    })).toEqual(["ciudad:cdmx", "viaje:vegas"]);
  });

  it("rejects malformed tags", () => {
    expect(() => normalizeEventTags(["dos:niveles:no"])).toThrow(InvalidEventTagError);
    expect(() => normalizeEventTags(["$privado"])).toThrow(InvalidEventTagError);
    expect(() => normalizeEventTags([42])).toThrow("Cada tag debe ser texto.");
  });
});
