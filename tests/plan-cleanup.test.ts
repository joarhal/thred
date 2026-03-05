import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { removePlanAndCommitDeletionIfTracked } from "../src/core/interactive/plan-cleanup.js";
import { exists } from "../src/core/util/fs.js";
import { runCommand } from "../src/core/util/process.js";

describe("plan cleanup", () => {
  it("commits deletion when plan was tracked", async () => {
    const dir = await createGitRepo();
    const planPath = path.join(dir, "docs", "plans", "tracked.md");

    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, "# Plan: Tracked\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "chore: add tracked plan"]);

    const result = await removePlanAndCommitDeletionIfTracked(dir, planPath);

    expect(result.committed).toBe(true);
    expect(result.relativePath.replace(/\\/g, "/")).toBe("docs/plans/tracked.md");
    expect(await exists(planPath)).toBe(false);

    const status = await git(dir, ["status", "--porcelain"]);
    expect(status.trim()).toBe("");

    const lastMessage = (await git(dir, ["log", "-1", "--pretty=%s"]))
      .trim();
    expect(lastMessage).toContain("remove abandoned tracked.md");
  });

  it("only deletes when plan was untracked", async () => {
    const dir = await createGitRepo();
    const planPath = path.join(dir, "docs", "plans", "untracked.md");

    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, "# Plan: Untracked\n", "utf8");

    const result = await removePlanAndCommitDeletionIfTracked(dir, planPath);

    expect(result.committed).toBe(false);
    expect(result.relativePath.replace(/\\/g, "/")).toBe("docs/plans/untracked.md");
    expect(await exists(planPath)).toBe(false);

    const lastMessage = (await git(dir, ["log", "-1", "--pretty=%s"]))
      .trim();
    expect(lastMessage).toBe("chore: init");
  });
});

async function createGitRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "thred-cleanup-"));
  await git(dir, ["init"]);
  await git(dir, ["config", "user.name", "thred-tests"]);
  await git(dir, ["config", "user.email", "thred-tests@example.com"]);

  await writeFile(path.join(dir, "README.md"), "init\n", "utf8");
  await git(dir, ["add", "README.md"]);
  await git(dir, ["commit", "-m", "chore: init"]);
  return dir;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runCommand("git", args, { cwd });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return `${result.stdout}${result.stderr}`;
}
