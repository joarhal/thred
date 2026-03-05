import { describe, expect, it } from "vitest";

import {
  ConflictingPayloadsError,
  NoPayloadFoundError,
  extractJsonPayload,
  parseReviewResult
} from "../src/core/review/parse.js";

describe("review parser regression", () => {
  it("returns clean result for a single valid payload", () => {
    const result = parseReviewResult('{"overallStatus":"clean","findings":[]}');

    expect(result).toEqual({ overallStatus: "clean", findings: [] });
  });

  it("keeps valid payload when adjacent candidate has invalid overallStatus", () => {
    const mixed = [
      '{"overallStatus":"blocked","findings":[]}',
      '{"overallStatus":"issues_found","findings":[{"id":"f-good","severity":"medium","file":"src/b.ts","line":11,"summary":"Valid","rationale":"Because"}]}'
    ].join("\n");

    const result = parseReviewResult(mixed);

    expect(result.overallStatus).toBe("issues_found");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.id).toBe("f-good");
  });

  it("keeps valid payload when adjacent review-shaped candidate is malformed", () => {
    const mixed = [
      '{"overallStatus":"issues_found","findings":[{"id":"f-bad","severity":"high","file":"src/a.ts","line":7,"summary":123,"rationale":"broken"}]}',
      '{"overallStatus":"issues_found","findings":[{"id":"f-good","severity":"low","file":"src/c.ts","line":3,"summary":"Valid","rationale":"Because"}]}'
    ].join("\n");

    const result = parseReviewResult(mixed);

    expect(result.overallStatus).toBe("issues_found");
    expect(result.findings[0]?.id).toBe("f-good");
  });

  it("extracts nested review payload from wrapped object", () => {
    const wrapped = JSON.stringify({
      meta: { runId: "abc123" },
      payload: { overallStatus: "clean", findings: [] }
    });

    const result = parseReviewResult(wrapped);

    expect(result.overallStatus).toBe("clean");
    expect(result.findings).toHaveLength(0);
  });

  it("returns the last payload when multiple valid payloads have the same status", () => {
    const mixed = [
      '{"overallStatus":"issues_found","findings":[{"id":"f-old","severity":"high","file":"src/a.ts","line":2,"summary":"Old","rationale":"Because"}]}',
      '{"overallStatus":"issues_found","findings":[{"id":"f-new","severity":"high","file":"src/a.ts","line":9,"summary":"New","rationale":"Because"}]}'
    ].join("\n");

    const result = parseReviewResult(mixed);

    expect(result.findings[0]?.id).toBe("f-new");
  });

  it("throws NoPayloadFoundError for empty output", () => {
    expect(() => parseReviewResult("   \n\t")).toThrow(NoPayloadFoundError);
  });

  it("throws NoPayloadFoundError when no valid payloads are found", () => {
    const mixed = [
      '{"overallStatus":"blocked","findings":[]}',
      '{"runId":"abc123"}',
      '{"overallStatus":"issues_found","findings":[]}'
    ].join("\n");

    expect(() => parseReviewResult(mixed)).toThrow(NoPayloadFoundError);
  });

  it("captures candidate payloads in NoPayloadFoundError", () => {
    const raw = [
      '{"overallStatus":"blocked","findings":[]}',
      '{"overallStatus":"issues_found","findings":[]}'
    ].join("\n");

    try {
      parseReviewResult(raw);
      throw new Error("expected parseReviewResult to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(NoPayloadFoundError);
      const typed = error as NoPayloadFoundError;
      expect(typed.candidates).toEqual([
        '{"overallStatus":"blocked","findings":[]}',
        '{"overallStatus":"issues_found","findings":[]}'
      ]);
      expect(typed.message).toContain("invalid review output: no valid review payload found");
      expect(typed.message).toContain("candidateCount=2");
      expect(typed.hint).toContain("Return exactly one JSON payload");
    }
  });

  it("throws ConflictingPayloadsError when valid payload statuses conflict", () => {
    const mixed = [
      '{"overallStatus":"clean","findings":[]}',
      '{"overallStatus":"issues_found","findings":[{"id":"f-2","severity":"critical","file":"src/cli.ts","line":38,"summary":"Broken","rationale":"Because"}]}'
    ].join("\n");

    try {
      parseReviewResult(mixed);
      throw new Error("expected parseReviewResult to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictingPayloadsError);
      const typed = error as ConflictingPayloadsError;
      expect(typed.payloads).toEqual([
        '{"overallStatus":"clean","findings":[]}',
        '{"overallStatus":"issues_found","findings":[{"id":"f-2","severity":"critical","file":"src/cli.ts","line":38,"summary":"Broken","rationale":"Because"}]}'
      ]);
      expect(typed.statuses).toEqual(["clean", "issues_found"]);
      expect(typed.message).toContain("conflicting review payload statuses");
      expect(typed.message).toContain("payloadCount=2");
    }
  });

  it("retains all valid payloads in conflict error diagnostics", () => {
    const mixed = [
      '{"overallStatus":"clean","findings":[],"traceId":"a"}',
      '{"overallStatus":"clean","findings":[],"traceId":"b"}',
      '{"overallStatus":"issues_found","findings":[{"id":"f-2","severity":"critical","file":"src/cli.ts","line":38,"summary":"Broken","rationale":"Because"}]}'
    ].join("\n");

    try {
      parseReviewResult(mixed);
      throw new Error("expected parseReviewResult to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictingPayloadsError);
      const typed = error as ConflictingPayloadsError;
      expect(typed.payloads).toHaveLength(3);
      expect(typed.statuses).toEqual(["clean", "clean", "issues_found"]);
    }
  });

  it("throws conflict even when clean and issues payload are both valid", () => {
    const cleanPayload = '{"overallStatus":"clean","findings":[]}';
    const issuesPayload =
      '{"overallStatus":"issues_found","findings":[{"id":"f-3","severity":"high","file":"src/x.ts","line":4,"summary":"Issue","rationale":"Because"}]}';

    expect(() => parseReviewResult([cleanPayload, issuesPayload].join("\n"))).toThrow(ConflictingPayloadsError);
  });

  it("normalizes legacy major/minor severities", () => {
    const result = parseReviewResult(
      '{"overallStatus":"issues_found","findings":[{"id":"f-major","severity":"major","file":"src/a.ts","line":7,"summary":"Issue","rationale":"Because"},{"id":"f-minor","severity":"minor","file":"src/b.ts","line":11,"summary":"Issue","rationale":"Because"}]}'
    );

    expect(result.findings.map((item) => item.severity)).toEqual(["high", "medium"]);
  });

  it("extractJsonPayload prefers review-shaped payloads", () => {
    const mixed = [
      '{"runId":"abc123"}',
      '{"overallStatus":"clean","findings":[]}'
    ].join("\n");

    expect(extractJsonPayload(mixed)).toBe('{"overallStatus":"clean","findings":[]}');
  });
});
