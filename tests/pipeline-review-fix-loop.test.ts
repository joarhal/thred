import { describe, expect, it, vi } from "vitest";

import { PipelineRunner } from "../src/core/pipeline/runner.js";
import type { Finding, RunOptions } from "../src/types.js";

type ValidationResult = { ok: boolean; output: string; failedCommandIndex?: number; failedCommand?: string };

interface MutableRunner {
  runReviewFixLoop: (input: {
    passId: string;
    baseBranch: string;
    planPath: string;
    validationCommands: string[];
    focusSeverities: Finding["severity"][];
    agents?: string[];
    maxIterations: number;
    patience: number;
    initialFindings: Finding[];
  }) => Promise<{
    report: {
      name: string;
      iterations: number;
      stopReason: string;
      findings: { total: number; critical: number; high: number; medium: number; low: number };
    };
    findings: Finding[];
  }>;
  runCodexWithLimitWait: (prompt: string, label: string) => Promise<{ output: string; error?: Error }>;
  runValidationCommands: (commands: string[], scopeLabel: string) => Promise<ValidationResult>;
  reviewOnce: (
    baseBranch: string,
    planPath: string,
    severities: Finding["severity"][],
    progressLabel: string
  ) => Promise<{ findings: Finding[] }>;
  git: {
    stageAllAndCommit: (message: string) => Promise<boolean>;
  };
}

describe("pipeline review fix loop", () => {
  it("throws when codex fix request fails", async () => {
    const mutable = createRunnerMutable();
    mutable.runCodexWithLimitWait = vi.fn(async () => ({ output: "", error: new Error("codex failed") }));

    await expect(
      mutable.runReviewFixLoop({
        ...baseLoopInput(),
        maxIterations: 1,
        patience: 0,
        initialFindings: [sampleFinding("high-1", "high")]
      })
    ).rejects.toThrow(/review stabilize_critical_high fix failed/i);
  });

  it("throws when fix validation fails", async () => {
    const mutable = createRunnerMutable();
    mutable.runCodexWithLimitWait = vi.fn(async () => ({ output: "OPERATION: Apply review fixes" }));
    mutable.runValidationCommands = vi.fn(async () => ({
      ok: false,
      output: "\n$ npm test\nvalidation failed",
      failedCommandIndex: 1,
      failedCommand: "npm test"
    }));

    await expect(
      mutable.runReviewFixLoop({
        ...baseLoopInput(),
        maxIterations: 1,
        patience: 0,
        initialFindings: [sampleFinding("high-1", "high")]
      })
    ).rejects.toThrow(/fixes failed validation/i);
  });

  it("stops on patience stalemate when findings remain unchanged with no commit", async () => {
    const mutable = createRunnerMutable();
    const unchangedFindings = [sampleFinding("high-1", "high")];

    mutable.runCodexWithLimitWait = vi.fn(async () => ({ output: "OPERATION: Try review fix" }));
    mutable.runValidationCommands = vi.fn(async () => ({ ok: true, output: "" }));
    mutable.git = {
      stageAllAndCommit: vi.fn(async () => false)
    };
    mutable.reviewOnce = vi.fn(async () => ({ findings: unchangedFindings }));

    const result = await mutable.runReviewFixLoop({
      ...baseLoopInput(),
      maxIterations: 4,
      patience: 2,
      initialFindings: unchangedFindings
    });

    expect(result.report.stopReason).toBe("stalemate");
    expect(result.report.iterations).toBe(2);
    expect(result.findings).toEqual(unchangedFindings);
  });

  it("stops on max iterations when target findings keep remaining", async () => {
    const mutable = createRunnerMutable();

    mutable.runCodexWithLimitWait = vi.fn(async () => ({ output: "OPERATION: Try review fix" }));
    mutable.runValidationCommands = vi.fn(async () => ({ ok: true, output: "" }));
    mutable.git = {
      stageAllAndCommit: vi.fn(async () => true)
    };
    mutable.reviewOnce = vi
      .fn()
      .mockResolvedValueOnce({ findings: [sampleFinding("high-2", "high")] })
      .mockResolvedValueOnce({ findings: [sampleFinding("high-3", "high")] });

    const result = await mutable.runReviewFixLoop({
      ...baseLoopInput(),
      maxIterations: 2,
      patience: 0,
      initialFindings: [sampleFinding("high-1", "high")]
    });

    expect(result.report.stopReason).toBe("max_iterations");
    expect(result.report.iterations).toBe(2);
    expect(result.report.findings.high).toBe(1);
  });

  it("preserves non-focused findings between focused review iterations", async () => {
    const mutable = createRunnerMutable();
    const highFinding = sampleFinding("high-1", "high");
    const mediumFinding = sampleFinding("medium-1", "medium");

    mutable.runCodexWithLimitWait = vi.fn(async () => ({ output: "OPERATION: Try review fix" }));
    mutable.runValidationCommands = vi.fn(async () => ({ ok: true, output: "" }));
    mutable.git = {
      stageAllAndCommit: vi.fn(async () => true)
    };
    mutable.reviewOnce = vi.fn(async () => ({ findings: [] }));

    const result = await mutable.runReviewFixLoop({
      ...baseLoopInput(),
      maxIterations: 1,
      patience: 0,
      initialFindings: [highFinding, mediumFinding]
    });

    expect(result.findings).toEqual([mediumFinding]);
    expect(result.report.findings).toEqual({ total: 1, critical: 0, high: 0, medium: 1, low: 0 });
  });
});

function createRunnerMutable(): MutableRunner {
  const options: RunOptions = {
    planPath: "/tmp/work/docs/plans/2026-03-03-demo.md",
    isGit: true,
    maxTaskRetries: 1,
    maxReviewIterations: 3,
    maxExternalIterations: 3,
    reviewPatience: 2,
    waitOnLimitMs: 1_000,
    noColor: true
  };

  const runner = new PipelineRunner({
    options,
    cwd: "/tmp/work",
    runId: "review-fix-loop",
    logger: {
      logPath: "/tmp/thred-review-fix-loop.log",
      phase: vi.fn(async () => {}),
      info: vi.fn(async () => {}),
      debug: vi.fn(async () => {}),
      warn: vi.fn(async () => {}),
      error: vi.fn(async () => {}),
      success: vi.fn(async () => {}),
      rawToolOutput: vi.fn(async () => {})
    } as any,
    stateStore: {
      write: vi.fn(async () => {})
    } as any
  });

  const mutable = runner as unknown as MutableRunner;
  mutable.runCodexWithLimitWait = vi.fn(async () => ({ output: "OPERATION: noop" }));
  mutable.runValidationCommands = vi.fn(async () => ({ ok: true, output: "" }));
  mutable.reviewOnce = vi.fn(async () => ({ findings: [] }));
  mutable.git = {
    stageAllAndCommit: vi.fn(async () => true)
  };

  return mutable;
}

function baseLoopInput() {
  return {
    passId: "stabilize_critical_high",
    baseBranch: "main",
    planPath: "/tmp/work/docs/plans/2026-03-03-demo.md",
    validationCommands: ["npm test"],
    focusSeverities: ["critical", "high"] as Finding["severity"][]
  };
}

function sampleFinding(id: string, severity: Finding["severity"]): Finding {
  return {
    id,
    severity,
    file: "src/app.ts",
    line: 10,
    summary: `${severity} issue ${id}`,
    rationale: "needs a fix"
  };
}
