import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { PipelineRunner } from "../src/core/pipeline/runner.js";
import type { RunOptions, RunState } from "../src/types.js";

describe("pipeline no-git mode", () => {
  it("uses local preflight context and skips git operations", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-no-git-preflight-"));
    const planPath = await writePlanFixture(dir);

    const logger = createLogger(dir);
    const stateWrites: RunState[] = [];
    const stateStore = {
      write: vi.fn(async (state: RunState) => {
        stateWrites.push(JSON.parse(JSON.stringify(state)) as RunState);
      })
    };

    const options: RunOptions = {
      planPath,
      isGit: false,
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
      runId: "no-git-preflight",
      logger: logger as any,
      stateStore: stateStore as any
    });

    const mutable = runner as unknown as {
      preflight: () => Promise<{ baseBranch: string; branch: string }>;
      git: {
        ensureRepoRoot: ReturnType<typeof vi.fn>;
        detectBaseBranch: ReturnType<typeof vi.fn>;
        checkpointDirtyWorkspaceBeforeExecution: ReturnType<typeof vi.fn>;
        ensureFeatureBranchForPlan: ReturnType<typeof vi.fn>;
        ensureCleanExceptPlan: ReturnType<typeof vi.fn>;
      };
    };
    mutable.git = {
      ensureRepoRoot: vi.fn(async () => {}),
      detectBaseBranch: vi.fn(async () => "main"),
      checkpointDirtyWorkspaceBeforeExecution: vi.fn(async () => ({ committed: false, dirtyCount: 0 })),
      ensureFeatureBranchForPlan: vi.fn(async () => "feature/demo"),
      ensureCleanExceptPlan: vi.fn(async () => {})
    };

    const context = await mutable.preflight();

    expect(context).toEqual({ baseBranch: "local", branch: "local" });
    expect(mutable.git.ensureRepoRoot).not.toHaveBeenCalled();
    expect(mutable.git.detectBaseBranch).not.toHaveBeenCalled();
    expect(mutable.git.checkpointDirtyWorkspaceBeforeExecution).not.toHaveBeenCalled();
    expect(mutable.git.ensureFeatureBranchForPlan).not.toHaveBeenCalled();
    expect(mutable.git.ensureCleanExceptPlan).not.toHaveBeenCalled();
    expect(stateWrites.at(-1)?.branch).toBe("local");
  });

  it("moves plan locally during finalize and does not call git finalize methods", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-no-git-finalize-"));
    const planPath = await writePlanFixture(dir);

    const logger = createLogger(dir);
    const stateWrites: RunState[] = [];
    const stateStore = {
      write: vi.fn(async (state: RunState) => {
        stateWrites.push(JSON.parse(JSON.stringify(state)) as RunState);
      })
    };

    const options: RunOptions = {
      planPath,
      isGit: false,
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
      runId: "no-git-finalize",
      logger: logger as any,
      stateStore: stateStore as any
    });

    const mutable = runner as unknown as {
      runFinalizePhase: (baseBranch: string, branch: string) => Promise<void>;
      state: RunState;
      git: {
        movePlanToCompleted: ReturnType<typeof vi.fn>;
        diffStats: ReturnType<typeof vi.fn>;
      };
    };
    mutable.state = {
      runId: "no-git-finalize",
      planPath,
      branch: "local",
      phase: "memory",
      status: "running",
      startedAt: "2026-03-04T00:00:00.000Z"
    };
    mutable.git = {
      movePlanToCompleted: vi.fn(async () => ""),
      diffStats: vi.fn(async () => ({ files: 0, additions: 0, deletions: 0 }))
    };

    await mutable.runFinalizePhase("local", "local");

    const completedPlanPath = path.join(dir, "docs", "plans", "completed", path.basename(planPath));
    expect(stateWrites.at(-1)?.status).toBe("completed");
    expect(stateWrites.at(-1)?.stats).toEqual({
      commits: 0,
      files: 0,
      additions: 0,
      deletions: 0
    });
    expect(mutable.git.movePlanToCompleted).not.toHaveBeenCalled();
    expect(mutable.git.diffStats).not.toHaveBeenCalled();
    expect(logger.success).toHaveBeenCalledWith(expect.stringContaining("plan moved to"));
    expect(logger.success).toHaveBeenCalledWith(expect.stringContaining("on local"));
    expect(await pathExists(completedPlanPath)).toBe(true);
    expect(await pathExists(planPath)).toBe(false);
  });
});

async function writePlanFixture(cwd: string): Promise<string> {
  const planPath = path.join(cwd, "docs", "plans", "2026-03-04-local.md");
  await mkdir(path.dirname(planPath), { recursive: true });
  await writeFile(
    planPath,
    [
      "# Plan: Local mode",
      "",
      "## Overview",
      "Run fully without git.",
      "",
      "## Validation Commands",
      "- `true`",
      "",
      "### Task 1: Demo",
      "- [ ] done"
    ].join("\n"),
    "utf8"
  );
  return planPath;
}

function createLogger(cwd: string) {
  return {
    logPath: path.join(cwd, ".thred", "artifacts", "runs", "test.log"),
    phase: vi.fn(async () => {}),
    info: vi.fn(async () => {}),
    debug: vi.fn(async () => {}),
    warn: vi.fn(async () => {}),
    error: vi.fn(async () => {}),
    success: vi.fn(async () => {}),
    rawToolOutput: vi.fn(async () => {})
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
