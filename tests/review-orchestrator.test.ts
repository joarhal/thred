import { describe, expect, it } from "vitest";

import { ReviewOrchestratorError, runReview } from "../src/core/review/orchestrator.js";
import {
  CONFLICTING_PAYLOADS_ERROR_CODE,
  ConflictingPayloadsError,
  NO_PAYLOAD_FOUND_ERROR_CODE,
  NoPayloadFoundError,
  parseReviewResult
} from "../src/core/review/parse.js";

describe("review orchestrator", () => {
  it("returns multi-agent result when parse succeeds", async () => {
    const warnings: string[] = [];

    const result = await runReview({
      maxRetries: 1,
      multiPrompt: "MULTI",
      runPrompt: async () => ({ output: "OK_MULTI" }),
      parse: (raw) => {
        if (raw === "OK_MULTI") {
          return { overallStatus: "clean", findings: [] };
        }
        throw new Error("parse failed");
      },
      onWarn: async (message) => {
        warnings.push(message);
      }
    });

    expect(result.overallStatus).toBe("clean");
    expect(warnings).toHaveLength(0);
  });

  it("normalizes finding order by severity before returning", async () => {
    const result = await runReview({
      maxRetries: 0,
      multiPrompt: "MULTI",
      runPrompt: async () => ({ output: "OK_MULTI" }),
      parse: () => ({
        overallStatus: "issues_found",
        findings: [
          {
            id: "f-low",
            severity: "low",
            file: "src/low.ts",
            line: 9,
            summary: "Low issue",
            rationale: "low"
          },
          {
            id: "f-critical",
            severity: "critical",
            file: "src/critical.ts",
            line: 4,
            summary: "Critical issue",
            rationale: "critical"
          }
        ]
      }),
      onWarn: async () => {}
    });

    expect(result.findings.map((item) => item.severity)).toEqual(["critical", "low"]);
  });

  it("retries multi-agent parse failures and succeeds without fallback", async () => {
    const warnings: string[] = [];
    const calls: string[] = [];

    const result = await runReview({
      maxRetries: 1,
      multiPrompt: "MULTI",
      runPrompt: async (prompt) => {
        calls.push(prompt);
        return calls.length === 1 ? { output: "BAD" } : { output: "OK_MULTI" };
      },
      parse: (raw) => {
        if (raw === "OK_MULTI") {
          return { overallStatus: "clean", findings: [] };
        }
        throw new Error("invalid json");
      },
      onWarn: async (message) => {
        warnings.push(message);
      }
    });

    expect(result.overallStatus).toBe("clean");
    expect(calls).toEqual(["MULTI", "MULTI"]);
    expect(warnings.some((message) => message.startsWith("multi-agent: review output parse failed, retrying"))).toBe(true);
  });

  it("retries no-payload parse failures with specific warning", async () => {
    const warnings: string[] = [];
    const calls: string[] = [];

    const result = await runReview({
      maxRetries: 1,
      multiPrompt: "MULTI",
      runPrompt: async (prompt) => {
        calls.push(prompt);
        return calls.length === 1 ? { output: "BAD" } : { output: "OK_MULTI" };
      },
      parse: (raw) => {
        if (raw === "OK_MULTI") {
          return { overallStatus: "clean", findings: [] };
        }
        throw new NoPayloadFoundError("BAD");
      },
      onWarn: async (message) => {
        warnings.push(message);
      }
    });

    expect(result.overallStatus).toBe("clean");
    expect(calls).toEqual(["MULTI", "MULTI"]);
    expect(warnings.some((message) => message.startsWith("multi-agent: review output has no valid payload, retrying"))).toBe(true);
    expect(warnings[0]).toContain(`code=${NO_PAYLOAD_FOUND_ERROR_CODE}`);
    expect(warnings[0]).toContain("candidateCount=0");
    expect(warnings[0]).toContain("rawChars=3");
  });

  it("retries conflicting-payload parse failures with specific warning", async () => {
    const warnings: string[] = [];
    const calls: string[] = [];

    const result = await runReview({
      maxRetries: 1,
      multiPrompt: "MULTI",
      runPrompt: async (prompt) => {
        calls.push(prompt);
        return calls.length === 1 ? { output: "BAD" } : { output: "OK_MULTI" };
      },
      parse: (raw) => {
        if (raw === "OK_MULTI") {
          return { overallStatus: "clean", findings: [] };
        }
        throw new ConflictingPayloadsError(
          ['{"overallStatus":"clean","findings":[]}', '{"overallStatus":"issues_found","findings":[{"id":"f-1","severity":"high","file":"src/a.ts","line":1,"summary":"x","rationale":"x"}]}'],
          ["clean", "issues_found"]
        );
      },
      onWarn: async (message) => {
        warnings.push(message);
      }
    });

    expect(result.overallStatus).toBe("clean");
    expect(calls).toEqual(["MULTI", "MULTI"]);
    expect(warnings.some((message) => message.startsWith("multi-agent: review output has conflicting payloads, retrying"))).toBe(true);
    expect(warnings[0]).toContain(`code=${CONFLICTING_PAYLOADS_ERROR_CODE}`);
    expect(warnings[0]).toContain("statuses=clean,issues_found");
    expect(warnings[0]).toContain("payloadCount=2");
  });

  it("accepts non-conflicting parser payload stream and returns final payload", async () => {
    const warnings: string[] = [];
    const result = await runReview({
      maxRetries: 0,
      multiPrompt: "MULTI",
      runPrompt: async () => ({
        output: [
          '{"overallStatus":"issues_found","findings":[{"id":"f-old","severity":"medium","file":"src/a.ts","line":2,"summary":"Old","rationale":"old"}]}',
          '{"overallStatus":"issues_found","findings":[{"id":"f-new","severity":"high","file":"src/b.ts","line":5,"summary":"New","rationale":"new"}]}'
        ].join("\n")
      }),
      parse: parseReviewResult,
      onWarn: async (message) => {
        warnings.push(message);
      }
    });

    expect(result.overallStatus).toBe("issues_found");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.id).toBe("f-new");
    expect(warnings).toHaveLength(0);
  });

  it("retries parser errors across no-payload and conflicting statuses before succeeding", async () => {
    const warnings: string[] = [];
    let calls = 0;
    const result = await runReview({
      maxRetries: 2,
      multiPrompt: "MULTI",
      runPrompt: async () => {
        calls += 1;
        if (calls === 1) {
          return { output: "not-json-at-all" };
        }
        if (calls === 2) {
          return {
            output: [
              '{"overallStatus":"clean","findings":[]}',
              '{"overallStatus":"issues_found","findings":[{"id":"f-conflict","severity":"high","file":"src/review.ts","line":7,"summary":"Conflict","rationale":"r"}]}'
            ].join("\n")
          };
        }
        return { output: '{"overallStatus":"clean","findings":[]}' };
      },
      parse: parseReviewResult,
      onWarn: async (message) => {
        warnings.push(message);
      }
    });

    expect(result).toEqual({ overallStatus: "clean", findings: [] });
    expect(calls).toBe(3);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain(`code=${NO_PAYLOAD_FOUND_ERROR_CODE}`);
    expect(warnings[1]).toContain(`code=${CONFLICTING_PAYLOADS_ERROR_CODE}`);
  });

  it("throws parse failure with conflicting payload metadata after retry exhaustion", async () => {
    try {
      await runReview({
        maxRetries: 0,
        multiPrompt: "MULTI",
        runPrompt: async () => ({
          output: [
            '{"overallStatus":"clean","findings":[]}',
            '{"overallStatus":"issues_found","findings":[{"id":"f-conflict","severity":"high","file":"src/review.ts","line":7,"summary":"Conflict","rationale":"r"}]}'
          ].join("\n")
        }),
        parse: parseReviewResult,
        onWarn: async () => undefined
      });
      throw new Error("expected runReview to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewOrchestratorError);
      const typed = error as ReviewOrchestratorError;
      expect(typed.failureKind).toBe("parse");
      expect(typed.attempts).toBe(1);
      expect(typed.message).toContain(`code=${CONFLICTING_PAYLOADS_ERROR_CODE}`);
      expect(typed.cause).toBeInstanceOf(ConflictingPayloadsError);
    }
  });

  it("fails when multi-agent output remains unparseable", async () => {
    const warnings: string[] = [];

    await expect(
      runReview({
        maxRetries: 0,
        multiPrompt: "MULTI",
        runPrompt: async () => ({ output: "   " }),
        parse: (raw) => {
          if (!raw.trim()) {
            throw new Error("review output is empty");
          }
          return { overallStatus: "clean", findings: [] };
        },
        onWarn: async (message) => {
          warnings.push(message);
        }
      })
    ).rejects.toThrow(ReviewOrchestratorError);

    expect(warnings).toHaveLength(0);
  });

  it("retries multi-agent execution failures before failing", async () => {
    const warnings: string[] = [];
    let calls = 0;

    const result = await runReview({
      maxRetries: 1,
      multiPrompt: "MULTI",
      runPrompt: async () => {
        calls += 1;
        if (calls === 1) {
          return { output: "", error: new Error("exec failed") };
        }
        return { output: "OK_MULTI" };
      },
      parse: () => ({ overallStatus: "clean", findings: [] }),
      onWarn: async (message) => {
        warnings.push(message);
      }
    });

    expect(result.overallStatus).toBe("clean");
    expect(calls).toBe(2);
    expect(warnings.some((message) => message.startsWith("multi-agent: codex execution failed, retrying"))).toBe(true);
  });

  it("fails when multi-agent execution errors exhaust retries", async () => {
    const warnings: string[] = [];
    await expect(
      runReview({
        maxRetries: 0,
        multiPrompt: "MULTI",
        runPrompt: async () => ({ output: "", error: new Error("exec failed") }),
        parse: () => ({ overallStatus: "clean", findings: [] }),
        onWarn: async (message) => {
          warnings.push(message);
        }
      })
    ).rejects.toThrow(ReviewOrchestratorError);
    expect(warnings).toHaveLength(0);
  });

  it("includes actionable diagnostics on orchestrator failures", async () => {
    try {
      await runReview({
        maxRetries: 0,
        multiPrompt: "MULTI",
        runPrompt: async () => ({ output: "", error: new Error("exec failed") }),
        parse: () => ({ overallStatus: "clean", findings: [] }),
        onWarn: async () => undefined
      });
      throw new Error("expected runReview to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewOrchestratorError);
      const typed = error as ReviewOrchestratorError;
      expect(typed.message).toContain("review execution failed after 1 attempt");
      expect(typed.message).toContain("kind=execution");
      expect(typed.message).toContain("hint=check codex output contract");
    }
  });
});
