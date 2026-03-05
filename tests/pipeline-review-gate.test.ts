import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { PipelineRunner } from "../src/core/pipeline/runner.js";
import type { Finding, ReviewRunSummary, ReviewSeveritySummary, RunOptions, RunState } from "../src/types.js";

describe("pipeline review gate", () => {
  it("marks final review as clean when no findings remain", async () => {
    const setup = await createRunnerSetup();
    const mutable = setup.mutable;
    mutable.reviewOnce = vi
      .fn()
      .mockResolvedValueOnce({ findings: [] })
      .mockResolvedValueOnce({ findings: [] });

    const summary = await mutable.runFinalReview("main");

    expect(summary.status).toBe("clean");
    expect(summary.findings.total).toBe(0);
    expect(setup.stateWrites.at(-1)?.review?.status).toBe("clean");
    expect(mutable.writeMandatoryBacklog).toHaveBeenCalledTimes(1);
  });

  it("marks final review as warnings when only non-blocking findings remain", async () => {
    const setup = await createRunnerSetup();
    const mutable = setup.mutable;
    const mediumFinding: Finding = {
      id: "f-medium",
      severity: "medium",
      file: "src/app.ts",
      line: 21,
      summary: "Handle missing state",
      rationale: "State can be undefined under load"
    };
    const lowFinding: Finding = {
      id: "f-low",
      severity: "low",
      file: "src/ui.ts",
      line: 8,
      summary: "Tighten empty-state copy",
      rationale: "Missing guidance increases support load"
    };
    mutable.reviewOnce = vi
      .fn()
      .mockResolvedValueOnce({ findings: [mediumFinding, lowFinding] })
      .mockResolvedValueOnce({ findings: [mediumFinding, lowFinding] });

    const summary = await mutable.runFinalReview("main");

    expect(summary.status).toBe("warnings");
    expect(summary.findings).toEqual({ total: 2, critical: 0, high: 0, medium: 1, low: 1 });
    expect(setup.stateWrites.at(-1)?.review?.status).toBe("warnings");
    expect(mutable.writeMandatoryBacklog).toHaveBeenCalledTimes(1);
    expect(mutable.writeMandatoryBacklog).toHaveBeenCalledWith([mediumFinding, lowFinding]);
  });

  it("rejects when high findings remain after recording failed review status", async () => {
    const setup = await createRunnerSetup();
    const mutable = setup.mutable;
    const highFinding: Finding = {
      id: "f-high",
      severity: "high",
      file: "src/security.ts",
      line: 7,
      summary: "Sanitize command input",
      rationale: "Unsanitized command input allows shell injection"
    };
    mutable.reviewOnce = vi
      .fn()
      .mockResolvedValueOnce({ findings: [highFinding] })
      .mockResolvedValueOnce({ findings: [highFinding] });

    await expect(mutable.runFinalReview("main")).rejects.toThrow("final review still has findings");
    expect(setup.stateWrites.at(-1)?.review?.status).toBe("failed");
    expect(mutable.writeMandatoryBacklog).toHaveBeenCalledTimes(1);
  });

  it("rejects when critical findings remain after recording failed review status", async () => {
    const setup = await createRunnerSetup();
    const mutable = setup.mutable;
    const criticalFinding: Finding = {
      id: "f-critical",
      severity: "critical",
      file: "src/auth.ts",
      line: 3,
      summary: "Avoid secret leakage to logs",
      rationale: "Secret leakage is an immediate release blocker"
    };
    mutable.reviewOnce = vi
      .fn()
      .mockResolvedValueOnce({ findings: [criticalFinding] })
      .mockResolvedValueOnce({ findings: [criticalFinding] });

    await expect(mutable.runFinalReview("main")).rejects.toThrow("final review still has findings");
    expect(setup.stateWrites.at(-1)?.review?.findings).toEqual({
      total: 1,
      critical: 1,
      high: 0,
      medium: 0,
      low: 0
    });
    expect(mutable.writeMandatoryBacklog).toHaveBeenCalledTimes(1);
  });

  it("still accounts for medium/low backlog when high findings remain", async () => {
    const setup = await createRunnerSetup();
    const mutable = setup.mutable;
    const highFinding: Finding = {
      id: "f-high",
      severity: "high",
      file: "src/security.ts",
      line: 17,
      summary: "Validate external command args",
      rationale: "Untrusted input reaches shell command"
    };
    const mediumFinding: Finding = {
      id: "f-medium",
      severity: "medium",
      file: "src/runner.ts",
      line: 29,
      summary: "Guard retry bounds",
      rationale: "Out-of-range retries can degrade runtime reliability"
    };
    const lowFinding: Finding = {
      id: "f-low",
      severity: "low",
      file: "src/ui.ts",
      line: 41,
      summary: "Polish warning text",
      rationale: "Unclear warnings slow down triage"
    };
    const findings = [highFinding, mediumFinding, lowFinding];
    mutable.reviewOnce = vi
      .fn()
      .mockResolvedValueOnce({ findings })
      .mockResolvedValueOnce({ findings });

    await expect(mutable.runFinalReview("main")).rejects.toThrow("final review still has findings");
    expect(setup.stateWrites.at(-1)?.review?.status).toBe("failed");
    expect(setup.stateWrites.at(-1)?.review?.findings).toEqual({
      total: 3,
      critical: 0,
      high: 1,
      medium: 1,
      low: 1
    });
    expect(mutable.writeMandatoryBacklog).toHaveBeenCalledWith(findings);
  });
});

interface MutableRunner {
  state: RunState;
  runFinalReview: (baseBranch: string) => Promise<ReviewRunSummary>;
  reviewOnce: (...args: unknown[]) => Promise<{ findings: Finding[] }>;
  runReviewFixLoop: (input: { passId: string; initialFindings: Finding[] }) => Promise<{
    report: {
      name: string;
      iterations: number;
      stopReason: string;
      findings: ReviewSeveritySummary;
    };
    findings: Finding[];
  }>;
  writeReviewReport: (...args: unknown[]) => Promise<void>;
  writeMandatoryBacklog: (...args: unknown[]) => Promise<void>;
}

async function createRunnerSetup(): Promise<{
  mutable: MutableRunner;
  stateWrites: RunState[];
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "thred-pipeline-review-gate-"));
  const planPath = path.join(dir, "docs", "plans", "2026-03-04-review-gate.md");
  await mkdir(path.dirname(planPath), { recursive: true });
  await writeFile(
    planPath,
    [
      "# Plan: Review gate coverage",
      "",
      "## Overview",
      "Add explicit final review gate tests.",
      "",
      "## Validation Commands",
      "- `git status --short`",
      "",
      "### Task 1: Add tests",
      "- [ ] add coverage"
    ].join("\n"),
    "utf8"
  );

  const logger = {
    logPath: path.join(dir, ".thred", "artifacts", "runs", "test.log"),
    phase: vi.fn(async () => {}),
    info: vi.fn(async () => {}),
    debug: vi.fn(async () => {}),
    warn: vi.fn(async () => {}),
    error: vi.fn(async () => {}),
    success: vi.fn(async () => {})
  };

  const stateWrites: RunState[] = [];
  const stateStore = {
    write: vi.fn(async (state: RunState) => {
      stateWrites.push(JSON.parse(JSON.stringify(state)) as RunState);
    })
  };

  const options: RunOptions = {
    planPath,
    isGit: true,
    maxTaskRetries: 1,
    maxReviewIterations: 1,
    maxExternalIterations: 1,
    reviewPatience: 1,
    waitOnLimitMs: 1_000,
    noColor: true
  };

  const runner = new PipelineRunner({
    options,
    cwd: dir,
    runId: "review-gate",
    logger: logger as any,
    stateStore: stateStore as any
  });

  const mutable = runner as unknown as MutableRunner;
  mutable.state = {
    runId: "review-gate",
    planPath,
    branch: "feature/review-gate",
    phase: "review",
    status: "running",
    startedAt: "2026-03-04T00:00:00.000Z"
  };

  mutable.runReviewFixLoop = vi.fn(async (input: { passId: string; initialFindings: Finding[] }) => ({
    report: {
      name: input.passId,
      iterations: 0,
      stopReason: "clean",
      findings: countBySeverity(input.initialFindings)
    },
    findings: input.initialFindings
  }));
  mutable.writeReviewReport = vi.fn(async () => {});
  mutable.writeMandatoryBacklog = vi.fn(async () => {});

  return { mutable, stateWrites };
}

function countBySeverity(findings: Finding[]): ReviewSeveritySummary {
  let critical = 0;
  let high = 0;
  let medium = 0;
  let low = 0;
  for (const finding of findings) {
    if (finding.severity === "critical") {
      critical += 1;
      continue;
    }
    if (finding.severity === "high") {
      high += 1;
      continue;
    }
    if (finding.severity === "medium") {
      medium += 1;
      continue;
    }
    low += 1;
  }
  return {
    total: findings.length,
    critical,
    high,
    medium,
    low
  };
}
