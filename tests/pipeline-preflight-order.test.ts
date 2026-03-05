import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { PipelineRunner } from "../src/core/pipeline/runner.js";
import { runCommand } from "../src/core/util/process.js";
import type { RunOptions, RunState } from "../src/types.js";

describe("pipeline preflight checkpoint ordering", () => {
  it("checkpoints dirty workspace before switching to an existing conflicting plan branch", async () => {
    const dir = await createRepoWithConflictingBranchCheckout();
    const planPath = path.join(dir, "docs", "plans", "2026-03-03-add-auth.md");

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
      waitOnLimitMs: 1000,
      noColor: true
    };

    const runner = new PipelineRunner({
      options,
      cwd: dir,
      runId: "preflight-order",
      logger: logger as any,
      stateStore: stateStore as any
    });

    const context = await (runner as unknown as {
      preflight: () => Promise<{ baseBranch: string; branch: string }>;
    }).preflight();

    expect(context.baseBranch).toBe("main");
    expect(context.branch).toBe("add-auth");
    expect(await gitOut(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("add-auth");
    expect(await gitOut(dir, ["log", "-1", "--pretty=%s", "main"])).toBe("chore: checkpoint before execution");
    expect(await gitOut(dir, ["status", "--porcelain"])).toBe("");
    expect(stateWrites.at(-1)?.branch).toBe("add-auth");
  });
});

async function createRepoWithConflictingBranchCheckout(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "thred-preflight-order-"));
  await git(dir, ["init"]);
  await git(dir, ["config", "user.name", "thred-tests"]);
  await git(dir, ["config", "user.email", "thred-tests@example.com"]);

  const planPath = path.join(dir, "docs", "plans", "2026-03-03-add-auth.md");
  await mkdir(path.dirname(planPath), { recursive: true });
  await mkdir(path.join(dir, "src"), { recursive: true });

  await writeFile(path.join(dir, "src", "conflict.txt"), "base\n", "utf8");
  await writeFile(path.join(dir, "README.md"), "init\n", "utf8");
  await writeFile(
    planPath,
    [
      "# Plan: Add auth",
      "",
      "## Overview",
      "Add authentication.",
      "",
      "## Validation Commands",
      "- `git status --short`",
      "",
      "### Task 1: Setup",
      "- [ ] done"
    ].join("\n"),
    "utf8"
  );
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "chore: init with plan"]);
  await git(dir, ["branch", "-M", "main"]);

  await git(dir, ["checkout", "-b", "add-auth"]);
  await writeFile(path.join(dir, "src", "conflict.txt"), "feature-branch-change\n", "utf8");
  await git(dir, ["add", "src/conflict.txt"]);
  await git(dir, ["commit", "-m", "feat: change conflict file on feature branch"]);

  await git(dir, ["checkout", "main"]);
  await writeFile(path.join(dir, "src", "conflict.txt"), "dirty-main-change\n", "utf8");

  return await gitOut(dir, ["rev-parse", "--show-toplevel"]);
}

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runCommand("git", args, { cwd });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

async function gitOut(cwd: string, args: string[]): Promise<string> {
  const result = await runCommand("git", args, { cwd });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}
