import { describe, expect, it } from "vitest";

import {
  buildReviewFailureMessage,
  previewFindings,
  summarizeCodexOutput,
  summarizeReviewFindings
} from "../src/core/pipeline/runner.js";

describe("pipeline logging helpers", () => {
  it("builds one-line codex summary from first non-empty line", () => {
    const output = "\n\nImplemented task checklist.\n- updated files\n- ran tests";
    expect(summarizeCodexOutput(output)).toBe("Implemented task checklist.");
  });

  it("prefers OPERATION title when present", () => {
    const output = "notes before\nOPERATION: Update logging format\n- removed summary header";
    expect(summarizeCodexOutput(output)).toBe("OPERATION: Update logging format");
  });

  it("normalizes OPERATION title casing and spacing", () => {
    const output = "operation :   tighten phase transitions";
    expect(summarizeCodexOutput(output)).toBe("OPERATION: tighten phase transitions");
  });

  it("truncates OPERATION title to max length", () => {
    const output = "OPERATION: This operation title is intentionally long to exercise truncation behavior";
    expect(summarizeCodexOutput(output, 32)).toBe("OPERATION: This operation tit...");
  });

  it("falls back for empty codex output", () => {
    expect(summarizeCodexOutput(" \n\t ")).toBe("empty response");
  });

  it("summarizes findings by severity", () => {
    expect(
      summarizeReviewFindings([
        {
          id: "a",
          severity: "high",
          file: "a.ts",
          line: 1,
          summary: "x",
          rationale: "x"
        },
        {
          id: "b",
          severity: "medium",
          file: "b.ts",
          line: 2,
          summary: "y",
          rationale: "y"
        },
        {
          id: "c",
          severity: "critical",
          file: "c.ts",
          line: 3,
          summary: "z",
          rationale: "z"
        }
      ])
    ).toBe("total=3 (critical=1, high=1, medium=1, low=0)");
  });

  it("formats compact finding previews", () => {
    expect(
      previewFindings(
        [
          {
            id: "x",
            severity: "high",
            file: "src/app.ts",
            line: 42,
            summary: "Handle null state before mapping items",
            rationale: "null"
          }
        ],
        3
      )
    ).toEqual(["[high] src/app.ts:42 Handle null state before mapping items"]);
  });

  it("builds readable review failure message with top findings", () => {
    expect(
      buildReviewFailureMessage(
        [
          {
            id: "x",
            severity: "high",
            file: "src/app.ts",
            line: 42,
            summary: "Handle null state before mapping items",
            rationale: "null"
          },
          {
            id: "y",
            severity: "medium",
            file: "src/ui.ts",
            line: 17,
            summary: "Add guard for optional value",
            rationale: "guard"
          }
        ],
        1
      )
    ).toBe(
      "final review still has findings: total=2 (critical=0, high=1, medium=1, low=0); top findings: [high] src/app.ts:42 Handle null state before mapping items"
    );
  });

  it("builds review failure message scoped to gate severities", () => {
    expect(
      buildReviewFailureMessage(
        [
          {
            id: "a",
            severity: "high",
            file: "src/high.ts",
            line: 7,
            summary: "High issue",
            rationale: "high"
          },
          {
            id: "b",
            severity: "critical",
            file: "src/critical.ts",
            line: 11,
            summary: "Critical issue",
            rationale: "critical"
          }
        ],
        ["critical"]
      )
    ).toBe(
      "final review still has findings: total=1 (critical=1, high=0, medium=0, low=0); top findings: [critical] src/critical.ts:11 Critical issue"
    );
  });

  it("omits top-findings preview when gate filter removes all findings", () => {
    expect(
      buildReviewFailureMessage(
        [
          {
            id: "a",
            severity: "high",
            file: "src/high.ts",
            line: 7,
            summary: "High issue",
            rationale: "high"
          }
        ],
        ["critical"]
      )
    ).toBe("final review still has findings: total=0 (critical=0, high=0, medium=0, low=0)");
  });
});
