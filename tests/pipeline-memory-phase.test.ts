import { describe, expect, it, vi } from "vitest";

import type { RunOptions } from "../src/types.js";
import { PipelineRunner } from "../src/core/pipeline/runner.js";

describe("pipeline runner memory phase", () => {
  it("skips MEMORY.md rewrite and codex calls", async () => {
    const logger = {
      logPath: "/tmp/thred-run.log",
      phase: vi.fn(async () => {}),
      info: vi.fn(async () => {}),
      debug: vi.fn(async () => {}),
      warn: vi.fn(async () => {}),
      error: vi.fn(async () => {}),
      success: vi.fn(async () => {}),
      rawToolOutput: vi.fn(async () => {})
    };

    const stateStore = {
      write: vi.fn(async () => {})
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
      runId: "memory-phase",
      logger: logger as any,
      stateStore: stateStore as any
    });

    const mutable = runner as unknown as {
      runCodexWithLimitWait: ReturnType<typeof vi.fn>;
      runMemoryPhase: () => Promise<void>;
    };

    mutable.runCodexWithLimitWait = vi.fn(async () => ({ output: "", isRateLimited: false }));

    await mutable.runMemoryPhase();

    expect(logger.info).toHaveBeenCalledWith("memory phase skipped: using completed plans context instead of MEMORY.md");
    expect(mutable.runCodexWithLimitWait).not.toHaveBeenCalled();
  });
});
