import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { PipelineRunner } from "../src/core/pipeline/runner.js";
import type { RunOptions, RunState } from "../src/types.js";

describe("pipeline runner state persistence", () => {
  it("keeps phase order and persists run state transitions on successful run", async () => {
    const phaseOrder: string[] = [];
    const stateWrites: RunState[] = [];

    const logger = {
      logPath: "/tmp/thred-run.log",
      phase: vi.fn(async (name: string) => {
        phaseOrder.push(name);
      }),
      info: vi.fn(async () => {}),
      debug: vi.fn(async () => {}),
      warn: vi.fn(async () => {}),
      error: vi.fn(async () => {}),
      success: vi.fn(async () => {})
    };

    const stateStore = {
      write: vi.fn(async (state: RunState) => {
        stateWrites.push(JSON.parse(JSON.stringify(state)) as RunState);
      })
    };

    const options: RunOptions = {
      planPath: "/tmp/work/docs/plans/2026-03-03-demo.md",
      isGit: true,
      maxTaskRetries: 1,
      maxReviewIterations: 1,
      maxExternalIterations: 1,
      reviewPatience: 1,
      waitOnLimitMs: 1000,
      noColor: true
    };

    const runner = new PipelineRunner({
      options,
      cwd: "/tmp/work",
      runId: "run-123",
      logger: logger as any,
      stateStore: stateStore as any
    });

    const mutable = runner as unknown as {
      state: RunState;
      preflight: () => Promise<{ baseBranch: string; branch: string }>;
      runTaskLoop: () => Promise<void>;
      runFinalReview: () => Promise<RunState["review"]>;
      runMemoryPhase: () => Promise<void>;
      countCommits: () => Promise<number>;
      git: {
        movePlanToCompleted: (planPath: string) => Promise<string>;
        diffStats: () => Promise<{ files: number; additions: number; deletions: number }>;
      };
    };

    const reviewSummary = {
      gate: "critical+high",
      status: "clean",
      stopReason: "clean",
      findings: { total: 0, critical: 0, high: 0, medium: 0, low: 0 }
    } as const;

    mutable.preflight = async () => {
      mutable.state = {
        runId: "run-123",
        planPath: options.planPath,
        branch: "demo",
        phase: "preflight",
        status: "running",
        startedAt: "2026-03-03T10:00:00.000Z"
      };
      await stateStore.write(mutable.state);
      return { baseBranch: "main", branch: "demo" };
    };
    mutable.runTaskLoop = vi.fn(async () => {
      mutable.state.currentTask = 99;
    });
    mutable.runFinalReview = vi.fn(async () => {
      mutable.state.review = reviewSummary;
      await stateStore.write(mutable.state);
      return reviewSummary;
    });
    mutable.runMemoryPhase = vi.fn(async () => {});
    mutable.countCommits = vi.fn(async () => 3);
    mutable.git = {
      movePlanToCompleted: vi.fn(
        async (planPathValue: string) =>
          path.join(path.dirname(planPathValue), "completed", path.basename(planPathValue))
      ),
      diffStats: vi.fn(async () => ({ files: 4, additions: 20, deletions: 5 }))
    };

    await runner.run();

    expect(phaseOrder).toEqual(["preflight", "tasks", "review", "memory", "finalize"]);
    expect(stateWrites.map((state) => `${state.phase}:${state.status}`)).toEqual([
      "preflight:running",
      "tasks:running",
      "review:running",
      "review:running",
      "memory:running",
      "finalize:running",
      "finalize:completed"
    ]);
    expect(stateWrites[3]?.review).toEqual(reviewSummary);
    expect(stateWrites.filter((state) => state.phase !== "tasks").every((state) => state.currentTask === undefined)).toBe(true);
    expect(stateWrites[6]?.stats).toEqual({
      commits: 3,
      files: 4,
      additions: 20,
      deletions: 5
    });
  });

  it("persists failed run state when preflight throws before state initialization", async () => {
    const logger = {
      logPath: "/tmp/thred-run.log",
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
      planPath: "/tmp/work/docs/plans/2026-03-03-demo.md",
      isGit: true,
      maxTaskRetries: 1,
      maxReviewIterations: 1,
      maxExternalIterations: 1,
      reviewPatience: 1,
      waitOnLimitMs: 1000,
      noColor: true
    };

    const runner = new PipelineRunner({
      options,
      cwd: "/tmp/work",
      runId: "run-preflight-fail",
      logger: logger as any,
      stateStore: stateStore as any
    });

    const mutable = runner as unknown as {
      preflight: () => Promise<{ baseBranch: string; branch: string }>;
    };
    mutable.preflight = vi.fn(async () => {
      throw new Error("plan parse failed");
    });

    await expect(runner.run()).rejects.toThrow("plan parse failed");

    expect(stateWrites).toHaveLength(1);
    expect(stateWrites[0]).toEqual(
      expect.objectContaining({
        runId: "run-preflight-fail",
        planPath: options.planPath,
        branch: "unknown",
        phase: "preflight",
        status: "failed",
        error: "plan parse failed"
      })
    );
    expect(stateWrites[0]?.startedAt).toBeTruthy();
    expect(stateWrites[0]?.finishedAt).toBeTruthy();
    expect(logger.error).toHaveBeenCalledWith("plan parse failed");
  });

  it("fails in current phase when state write errors during phase transition", async () => {
    const phaseOrder: string[] = [];
    const stateWrites: RunState[] = [];
    let writeAttempt = 0;

    const logger = {
      logPath: "/tmp/thred-run.log",
      phase: vi.fn(async (name: string) => {
        phaseOrder.push(name);
      }),
      info: vi.fn(async () => {}),
      debug: vi.fn(async () => {}),
      warn: vi.fn(async () => {}),
      error: vi.fn(async () => {}),
      success: vi.fn(async () => {})
    };

    const stateStore = {
      write: vi.fn(async (state: RunState) => {
        writeAttempt += 1;
        stateWrites.push(JSON.parse(JSON.stringify(state)) as RunState);
        if (writeAttempt === 2) {
          throw new Error("state store write failed");
        }
      })
    };

    const options: RunOptions = {
      planPath: "/tmp/work/docs/plans/2026-03-03-demo.md",
      isGit: true,
      maxTaskRetries: 1,
      maxReviewIterations: 1,
      maxExternalIterations: 1,
      reviewPatience: 1,
      waitOnLimitMs: 1000,
      noColor: true
    };

    const runner = new PipelineRunner({
      options,
      cwd: "/tmp/work",
      runId: "run-write-fail",
      logger: logger as any,
      stateStore: stateStore as any
    });

    const mutable = runner as unknown as {
      state: RunState;
      preflight: () => Promise<{ baseBranch: string; branch: string }>;
      runTaskLoop: ReturnType<typeof vi.fn>;
      runFinalReview: ReturnType<typeof vi.fn>;
      runMemoryPhase: ReturnType<typeof vi.fn>;
      countCommits: ReturnType<typeof vi.fn>;
      git: {
        movePlanToCompleted: ReturnType<typeof vi.fn>;
        diffStats: ReturnType<typeof vi.fn>;
      };
    };

    mutable.preflight = async () => {
      mutable.state = {
        runId: "run-write-fail",
        planPath: options.planPath,
        branch: "demo",
        phase: "preflight",
        status: "running",
        startedAt: "2026-03-03T10:00:00.000Z"
      };
      await stateStore.write(mutable.state);
      return { baseBranch: "main", branch: "demo" };
    };
    mutable.runTaskLoop = vi.fn(async () => {});
    mutable.runFinalReview = vi.fn(async () => ({
      gate: "critical+high",
      status: "clean",
      stopReason: "clean",
      findings: { total: 0, critical: 0, high: 0, medium: 0, low: 0 }
    }));
    mutable.runMemoryPhase = vi.fn(async () => {});
    mutable.countCommits = vi.fn(async () => 1);
    mutable.git = {
      movePlanToCompleted: vi.fn(async () => options.planPath),
      diffStats: vi.fn(async () => ({ files: 0, additions: 0, deletions: 0 }))
    };

    await expect(runner.run()).rejects.toThrow("state store write failed");

    expect(phaseOrder).toEqual(["preflight", "tasks"]);
    expect(mutable.runTaskLoop).not.toHaveBeenCalled();
    expect(stateWrites.map((state) => `${state.phase}:${state.status}`)).toEqual([
      "preflight:running",
      "tasks:running",
      "tasks:failed"
    ]);
    expect(logger.error).toHaveBeenCalledWith("state store write failed");
  });

  it("drops stale currentTask when failing after repeated review-phase state writes", async () => {
    const phaseOrder: string[] = [];
    const stateWrites: RunState[] = [];

    const logger = {
      logPath: "/tmp/thred-run.log",
      phase: vi.fn(async (name: string) => {
        phaseOrder.push(name);
      }),
      info: vi.fn(async () => {}),
      debug: vi.fn(async () => {}),
      warn: vi.fn(async () => {}),
      error: vi.fn(async () => {}),
      success: vi.fn(async () => {})
    };

    const stateStore = {
      write: vi.fn(async (state: RunState) => {
        stateWrites.push(JSON.parse(JSON.stringify(state)) as RunState);
      })
    };

    const options: RunOptions = {
      planPath: "/tmp/work/docs/plans/2026-03-03-demo.md",
      isGit: true,
      maxTaskRetries: 1,
      maxReviewIterations: 1,
      maxExternalIterations: 1,
      reviewPatience: 1,
      waitOnLimitMs: 1000,
      noColor: true
    };

    const runner = new PipelineRunner({
      options,
      cwd: "/tmp/work",
      runId: "run-review-fail",
      logger: logger as any,
      stateStore: stateStore as any
    });

    const mutable = runner as unknown as {
      state: RunState;
      preflight: () => Promise<{ baseBranch: string; branch: string }>;
      runTaskLoop: ReturnType<typeof vi.fn>;
      runFinalReview: ReturnType<typeof vi.fn>;
      runMemoryPhase: ReturnType<typeof vi.fn>;
      countCommits: ReturnType<typeof vi.fn>;
      git: {
        movePlanToCompleted: ReturnType<typeof vi.fn>;
        diffStats: ReturnType<typeof vi.fn>;
      };
    };

    mutable.preflight = async () => {
      mutable.state = {
        runId: "run-review-fail",
        planPath: options.planPath,
        branch: "demo",
        phase: "preflight",
        status: "running",
        startedAt: "2026-03-03T10:00:00.000Z"
      };
      await stateStore.write(mutable.state);
      return { baseBranch: "main", branch: "demo" };
    };
    mutable.runTaskLoop = vi.fn(async () => {
      mutable.state.currentTask = 7;
    });
    mutable.runFinalReview = vi.fn(async () => {
      mutable.state.currentTask = 123;
      await stateStore.write(mutable.state);
      throw new Error("review crashed after state write");
    });
    mutable.runMemoryPhase = vi.fn(async () => {});
    mutable.countCommits = vi.fn(async () => 1);
    mutable.git = {
      movePlanToCompleted: vi.fn(async () => options.planPath),
      diffStats: vi.fn(async () => ({ files: 0, additions: 0, deletions: 0 }))
    };

    await expect(runner.run()).rejects.toThrow("review crashed after state write");

    expect(phaseOrder).toEqual(["preflight", "tasks", "review"]);
    expect(stateWrites.filter((state) => state.phase === "review" && state.status === "running")).toHaveLength(2);
    const failedState = stateWrites.at(-1);
    expect(failedState?.phase).toBe("review");
    expect(failedState?.status).toBe("failed");
    expect(failedState?.currentTask).toBeUndefined();
    expect(failedState?.error).toBe("review crashed after state write");
  });
});
