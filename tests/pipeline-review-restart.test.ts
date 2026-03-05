import { describe, expect, it, vi } from "vitest";

import { PipelineRunner } from "../src/core/pipeline/runner.js";
import { InvalidReviewStatusError } from "../src/core/review/parse.js";
import type { RunOptions, RunState } from "../src/types.js";

describe("pipeline review phase restart", () => {
  it("restarts full review when overallStatus parse error is returned", async () => {
    const logger = createLogger();
    const stateStore = createStateStore();
    const runner = createRunner({
      logger,
      stateStore
    });

    const mutable = runner as unknown as {
      state: RunState;
      runReviewPhase: (baseBranch: string) => Promise<void>;
      runFinalReview: ReturnType<typeof vi.fn>;
    };
    mutable.state = {
      runId: "review-restart-success",
      planPath: "/tmp/work/docs/plans/demo.md",
      branch: "local",
      phase: "tasks",
      status: "running",
      startedAt: new Date().toISOString()
    };
    mutable.runFinalReview = vi
      .fn()
      .mockRejectedValueOnce(new InvalidReviewStatusError())
      .mockResolvedValueOnce({
        gate: "critical+high",
        status: "clean",
        stopReason: "clean",
        findings: { total: 0, critical: 0, high: 0, medium: 0, low: 0 }
      });

    await expect(mutable.runReviewPhase("local")).resolves.toBeUndefined();
    expect(mutable.runFinalReview).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      "review: invalid overallStatus in model output, restarting full review (1/2)"
    );
  });

  it("does not restart full review when error only carries invalid-status code", async () => {
    const logger = createLogger();
    const stateStore = createStateStore();
    const runner = createRunner({
      logger,
      stateStore
    });

    const mutable = runner as unknown as {
      state: RunState;
      runReviewPhase: (baseBranch: string) => Promise<void>;
      runFinalReview: ReturnType<typeof vi.fn>;
    };
    mutable.state = {
      runId: "review-restart-code-fallback",
      planPath: "/tmp/work/docs/plans/demo.md",
      branch: "local",
      phase: "tasks",
      status: "running",
      startedAt: new Date().toISOString()
    };
    mutable.runFinalReview = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("x"), { code: "THRED_INVALID_REVIEW_STATUS" }));

    await expect(mutable.runReviewPhase("local")).rejects.toThrow("x");
    expect(mutable.runFinalReview).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("fails after restart limit is exhausted for typed invalid-status errors", async () => {
    const logger = createLogger();
    const stateStore = createStateStore();
    const runner = createRunner({
      logger,
      stateStore
    });

    const mutable = runner as unknown as {
      state: RunState;
      runReviewPhase: (baseBranch: string) => Promise<void>;
      runFinalReview: ReturnType<typeof vi.fn>;
    };
    mutable.state = {
      runId: "review-restart-fail",
      planPath: "/tmp/work/docs/plans/demo.md",
      branch: "local",
      phase: "tasks",
      status: "running",
      startedAt: new Date().toISOString()
    };
    mutable.runFinalReview = vi
      .fn()
      .mockRejectedValue(new InvalidReviewStatusError());

    await expect(mutable.runReviewPhase("local")).rejects.toThrow(
      "invalid review output: overallStatus must be clean or issues_found"
    );
    expect(mutable.runFinalReview).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith(
      "review: invalid overallStatus in model output, restarting full review (1/2)"
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "review: invalid overallStatus in model output, restarting full review (2/2)"
    );
  });

  it("does not restart when a generic error only matches the old message fragment", async () => {
    const logger = createLogger();
    const stateStore = createStateStore();
    const runner = createRunner({
      logger,
      stateStore
    });

    const mutable = runner as unknown as {
      state: RunState;
      runReviewPhase: (baseBranch: string) => Promise<void>;
      runFinalReview: ReturnType<typeof vi.fn>;
    };
    mutable.state = {
      runId: "review-restart-generic-error",
      planPath: "/tmp/work/docs/plans/demo.md",
      branch: "local",
      phase: "tasks",
      status: "running",
      startedAt: new Date().toISOString()
    };
    mutable.runFinalReview = vi
      .fn()
      .mockRejectedValue(new Error("invalid review output: overallStatus must be clean or issues_found"));

    await expect(mutable.runReviewPhase("local")).rejects.toThrow(
      "invalid review output: overallStatus must be clean or issues_found"
    );
    expect(mutable.runFinalReview).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

function createRunner(input: {
  logger: ReturnType<typeof createLogger>;
  stateStore: ReturnType<typeof createStateStore>;
}): PipelineRunner {
  const options: RunOptions = {
    planPath: "/tmp/work/docs/plans/demo.md",
    isGit: false,
    maxTaskRetries: 1,
    maxReviewIterations: 1,
    maxExternalIterations: 1,
    reviewPatience: 1,
    waitOnLimitMs: 1_000,
    noColor: true
  };

  return new PipelineRunner({
    options,
    cwd: "/tmp/work",
    runId: "review-restart",
    logger: input.logger as any,
    stateStore: input.stateStore as any
  });
}

function createLogger() {
  return {
    logPath: "/tmp/thred-review-restart.log",
    phase: vi.fn(async () => {}),
    info: vi.fn(async () => {}),
    debug: vi.fn(async () => {}),
    warn: vi.fn(async () => {}),
    error: vi.fn(async () => {}),
    success: vi.fn(async () => {}),
    rawToolOutput: vi.fn(async () => {})
  };
}

function createStateStore() {
  return {
    write: vi.fn(async () => {})
  };
}
