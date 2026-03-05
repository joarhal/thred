import { describe, expect, it } from "vitest";

import { durationToMs } from "../src/core/util/time.js";

describe("duration parser", () => {
  it("parses composite duration", () => {
    expect(durationToMs("1h30m")).toBe(5_400_000);
  });

  it("parses seconds", () => {
    expect(durationToMs("45s")).toBe(45_000);
  });

  it("throws on invalid format", () => {
    expect(() => durationToMs("abc")).toThrow(/invalid duration/i);
  });
});
