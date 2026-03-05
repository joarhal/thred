import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  commandExists: vi.fn(),
  runCommand: vi.fn(),
  loggerCreate: vi.fn(),
  stateStoreCreate: vi.fn(),
  runnerConstructor: vi.fn(),
  runnerRun: vi.fn(),
  loggerClose: vi.fn(),
  sinkLog: vi.fn()
}));

vi.mock("../src/core/util/process.js", () => ({
  commandExists: mocked.commandExists,
  runCommand: mocked.runCommand
}));

vi.mock("../src/core/progress/logger.js", () => ({
  ProgressLogger: {
    create: mocked.loggerCreate
  }
}));

vi.mock("../src/core/state/store.js", () => ({
  RunStateStore: {
    create: mocked.stateStoreCreate
  }
}));

vi.mock("../src/core/pipeline/runner.js", () => ({
  PipelineRunner: class {
    constructor(deps: unknown) {
      mocked.runnerConstructor(deps);
    }

    async run(): Promise<void> {
      await mocked.runnerRun();
    }
  }
}));

import { executePlan } from "../src/core/execute/run-plan.js";

describe("execute plan bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.commandExists.mockResolvedValue(true);
    mocked.runCommand.mockResolvedValue({ code: 0, stdout: "true\n", stderr: "" });
    mocked.loggerCreate.mockResolvedValue({ close: mocked.loggerClose });
    mocked.stateStoreCreate.mockResolvedValue({ write: vi.fn() });
    mocked.runnerRun.mockResolvedValue(undefined);
    mocked.loggerClose.mockResolvedValue(undefined);
  });

  it("initializes logger, run state store, and runner with resolved plan path", async () => {
    const cwd = "/tmp/thred-run-plan";
    const planPathArg = "docs/plans/2026-03-03-demo.md";
    const sink = { log: mocked.sinkLog };

    await executePlan(planPathArg, cwd, {
      planPath: planPathArg,
      baseBranch: "main",
      model: "gpt-5-codex",
      reasoningEffort: "xhigh",
      sandbox: "workspace-write",
      memoryContext: "# Completed Plans\n- Keep commits tight",
      maxTaskRetries: 1,
      maxReviewIterations: 2,
      maxExternalIterations: 3,
      reviewPatience: 2,
      waitOnLimitMs: 5000,
      noColor: true,
      verbose: true,
      sink
    });

    expect(mocked.commandExists).toHaveBeenNthCalledWith(1, "codex");
    expect(mocked.commandExists).toHaveBeenNthCalledWith(2, "git");

    const loggerCall = mocked.loggerCreate.mock.calls[0];
    expect(loggerCall).toBeDefined();
    const runDir = loggerCall?.[0] as string;
    const runId = loggerCall?.[1] as string;
    expect(runDir).toBe(path.join(cwd, ".thred", "artifacts", "runs"));
    expect(runId).toMatch(/^\d{4}-\d{2}-\d{2}-2026-03-03-demo-[a-f0-9]{8}$/);
    expect(loggerCall?.[2]).toBe(true);
    expect(loggerCall?.[3]).toBe(true);
    expect(loggerCall?.[4]).toBe(sink);

    expect(mocked.stateStoreCreate).toHaveBeenCalledWith(runDir, runId);
    const deps = mocked.runnerConstructor.mock.calls[0]?.[0] as {
      options: {
        planPath: string;
        baseBranch?: string;
        model?: string;
        reasoningEffort?: string;
        sandbox?: string;
        memoryContext?: string;
        maxTaskRetries: number;
        maxReviewIterations: number;
        maxExternalIterations: number;
        reviewPatience: number;
        isGit: boolean;
        waitOnLimitMs: number;
      };
      cwd: string;
      runId: string;
      logger: { close: () => Promise<void> };
      stateStore: unknown;
    };
    expect(deps.cwd).toBe(cwd);
    expect(deps.runId).toBe(runId);
    expect(deps.options.planPath).toBe(path.resolve(cwd, planPathArg));
    expect(deps.options.baseBranch).toBe("main");
    expect(deps.options.model).toBe("gpt-5-codex");
    expect(deps.options.reasoningEffort).toBe("xhigh");
    expect(deps.options.sandbox).toBe("workspace-write");
    expect(deps.options.memoryContext).toBe("# Completed Plans\n- Keep commits tight");
    expect(deps.options.maxTaskRetries).toBe(1);
    expect(deps.options.maxReviewIterations).toBe(2);
    expect(deps.options.maxExternalIterations).toBe(3);
    expect(deps.options.reviewPatience).toBe(2);
    expect(deps.options.isGit).toBe(true);
    expect(deps.options.waitOnLimitMs).toBe(5000);
    expect(deps.logger.close).toBe(mocked.loggerClose);
    expect(mocked.runnerRun).toHaveBeenCalledTimes(1);
    expect(mocked.loggerClose).toHaveBeenCalledTimes(1);
  });

  it("forwards lifecycle limits and memory context for full pipeline phases", async () => {
    const cwd = "/tmp/thred-run-plan";
    const planPathArg = "docs/plans/2026-03-03-demo.md";

    await executePlan(planPathArg, cwd, {
      planPath: planPathArg,
      memoryContext: "# Completed Plans\n- avoid flaky tests",
      maxTaskRetries: 4,
      maxReviewIterations: 6,
      maxExternalIterations: 7,
      reviewPatience: 5,
      waitOnLimitMs: 12_000,
      noColor: false,
      verbose: false,
      bootstrap: { cwd: path.resolve(cwd), isGit: false }
    });

    const deps = mocked.runnerConstructor.mock.calls[0]?.[0] as {
      options: {
        memoryContext?: string;
        maxTaskRetries: number;
        maxReviewIterations: number;
        maxExternalIterations: number;
        reviewPatience: number;
        waitOnLimitMs: number;
        isGit: boolean;
      };
    };

    expect(deps.options.memoryContext).toBe("# Completed Plans\n- avoid flaky tests");
    expect(deps.options.maxTaskRetries).toBe(4);
    expect(deps.options.maxReviewIterations).toBe(6);
    expect(deps.options.maxExternalIterations).toBe(7);
    expect(deps.options.reviewPatience).toBe(5);
    expect(deps.options.waitOnLimitMs).toBe(12_000);
    expect(deps.options.isGit).toBe(false);
  });

  it("always closes logger when runner fails", async () => {
    mocked.runnerRun.mockRejectedValueOnce(new Error("runner failed"));

    await expect(
      executePlan("docs/plans/2026-03-03-demo.md", "/tmp/thred-run-plan", {
        planPath: "docs/plans/2026-03-03-demo.md",
        maxTaskRetries: 1,
        maxReviewIterations: 1,
        maxExternalIterations: 1,
        reviewPatience: 1,
        waitOnLimitMs: 1000,
        noColor: false,
        verbose: false
      })
    ).rejects.toThrow("runner failed");

    expect(mocked.loggerClose).toHaveBeenCalledTimes(1);
  });

  it("reuses provided bootstrap context and skips duplicate environment checks", async () => {
    const cwd = "/tmp/thred-run-plan";
    const planPathArg = "docs/plans/2026-03-03-demo.md";

    await executePlan(planPathArg, cwd, {
      planPath: planPathArg,
      maxTaskRetries: 1,
      maxReviewIterations: 1,
      maxExternalIterations: 1,
      reviewPatience: 1,
      waitOnLimitMs: 1000,
      noColor: false,
      verbose: false,
      bootstrap: { cwd: path.resolve(cwd), isGit: false }
    });

    expect(mocked.commandExists).not.toHaveBeenCalled();
    expect(mocked.runCommand).not.toHaveBeenCalled();
    const deps = mocked.runnerConstructor.mock.calls[0]?.[0] as { options: { isGit: boolean } };
    expect(deps.options.isGit).toBe(false);
    expect(mocked.runnerRun).toHaveBeenCalledTimes(1);
  });

  it("fails early when required commands are missing", async () => {
    mocked.commandExists.mockImplementation(async (command: string) => command !== "codex");

    await expect(
      executePlan("docs/plans/2026-03-03-demo.md", "/tmp/thred-run-plan", {
        planPath: "docs/plans/2026-03-03-demo.md",
        maxTaskRetries: 1,
        maxReviewIterations: 1,
        maxExternalIterations: 1,
        reviewPatience: 1,
        waitOnLimitMs: 1000,
        noColor: false,
        verbose: false
      })
    ).rejects.toThrow("codex not found in PATH");

    expect(mocked.loggerCreate).not.toHaveBeenCalled();
    expect(mocked.stateStoreCreate).not.toHaveBeenCalled();
    expect(mocked.runnerConstructor).not.toHaveBeenCalled();
  });
});
