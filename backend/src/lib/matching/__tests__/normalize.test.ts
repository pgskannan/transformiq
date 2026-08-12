// TQ-036 (FR-BP-004): "Sample messy BP records normalize to the canonical format." See
// lib/matching/normalize.ts's header for why this file's rules ARE the canonical format
// decision (no separate data-dictionary artifact exists yet).
import {
  addressMatchKey,
  identifierMatchKey,
  nameMatchKey,
  normalizeAddressLine,
  normalizeCountryCode,
  normalizeDisplayText,
  normalizePostalCode,
} from "../normalize";

describe("normalizeDisplayText (TQ-036)", () => {
  it("trims and collapses internal whitespace without touching casing", () => {
    expect(normalizeDisplayText("  Acme   Corp  ")).toBe("Acme Corp");
  });

  it("treats null/undefined as empty", () => {
    expect(normalizeDisplayText(null)).toBe("");
    expect(normalizeDisplayText(undefined)).toBe("");
  });
});

describe("nameMatchKey (TQ-036)", () => {
  it("reduces case, legal-suffix, and punctuation variants of the same messy name to one key", () => {
    const variants = ["Acme Corp", "Acme Corp.", "ACME CORPORATION", "  acme   corp  ", "Acme, Corp"];
    const keys = variants.map(nameMatchKey);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe("ACME");
  });

  it("does not collapse genuinely different company names", () => {
    expect(nameMatchKey("Acme Corp")).not.toBe(nameMatchKey("Ajax Corp"));
  });

  it("strips a representative set of legal-entity suffixes", () => {
    expect(nameMatchKey("Initech LLC")).toBe("INITECH");
    expect(nameMatchKey("Globex GmbH")).toBe("GLOBEX");
    expect(nameMatchKey("Stark Industries Ltd")).toBe("STARK INDUSTRIES");
  });
});

describe("normalizeAddressLine / addressMatchKey (TQ-036)", () => {
  it("collapses whitespace in a display address line", () => {
    expect(normalizeAddressLine("  1  Infinite   Loop  ")).toBe("1 Infinite Loop");
  });

  it("reduces messy address variants to the same match key", () => {
    const a = addressMatchKey({
      line1: "1 Infinite Loop",
      city: "Cupertino",
      postalCode: "95014",
      countryCode: "us",
    });
    const b = addressMatchKey({
      line1: "  1   infinite loop.",
      city: "CUPERTINO",
      postalCode: "95 014",
      countryCode: "US",
    });
    expect(a).toBe(b);
  });

  it("distinguishes genuinely different addresses", () => {
    const a = addressMatchKey({ line1: "1 Infinite Loop", city: "Cupertino", postalCode: "95014", countryCode: "US" });
    const b = addressMatchKey({ line1: "500 Oracle Pkwy", city: "Redwood City", postalCode: "94065", countryCode: "US" });
    expect(a).not.toBe(b);
  });
});

describe("normalizeCountryCode / normalizePostalCode (TQ-036)", () => {
  it("uppercases and trims a country code", () => {
    expect(normalizeCountryCode(" us ")).toBe("US");
  });

  it("uppercases, trims, and strips internal whitespace from a postal code", () => {
    expect(normalizePostalCode(" sw1a 1aa ")).toBe("SW1A1AA");
  });
});

describe("identifierMatchKey (TQ-036, feeds TQ-031 exact matching)", () => {
  it("treats dash/dot/space/slash-separated variants of the same identifier as equal", () => {
    const variants = ["12-3456789", "12.3456789", "12 3456789", "12/3456789", "123456789"];
    const keys = variants.map(identifierMatchKey);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe("123456789");
  });

  it("is case-insensitive", () => {
    expect(identifierMatchKey("abc123")).toBe(identifierMatchKey("ABC123"));
  });

  it("does not collapse genuinely different identifier values", () => {
    expect(identifierMatchKey("123456789")).not.toBe(identifierMatchKey("987654321"));
  });
});
