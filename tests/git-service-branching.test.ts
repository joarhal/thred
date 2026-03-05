import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { GitService } from "../src/core/git/service.js";
import { runCommand } from "../src/core/util/process.js";

describe("git service branching", () => {
  it("creates plan branch when running from base branch", async () => {
    const dir = await createGitRepo();
    const planPath = path.join(dir, "docs", "plans", "2026-03-03-add-auth.md");

    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, "# Plan: Add auth\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "chore: add plan"]);

    const gitService = new GitService(dir);
    const branch = await gitService.ensureFeatureBranchForPlan(planPath, "main");

    expect(branch).toBe("add-auth");
    expect((await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("add-auth");
  });

  it("switches to existing plan branch when it already exists", async () => {
    const dir = await createGitRepo();
    const planPath = path.join(dir, "docs", "plans", "2026-03-03-add-auth.md");

    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, "# Plan: Add auth\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "chore: add plan"]);

    await git(dir, ["checkout", "-b", "add-auth"]);
    await git(dir, ["commit", "--allow-empty", "-m", "feat: existing branch work"]);
    await git(dir, ["checkout", "main"]);

    const gitService = new GitService(dir);
    const branch = await gitService.ensureFeatureBranchForPlan(planPath, "main");

    expect(branch).toBe("add-auth");
    expect((await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("add-auth");
    expect((await git(dir, ["log", "-1", "--pretty=%s"])).trim()).toBe("feat: existing branch work");
  });

  it("keeps current branch when not on base branch", async () => {
    const dir = await createGitRepo();
    const planPath = path.join(dir, "docs", "plans", "2026-03-03-add-auth.md");

    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, "# Plan: Add auth\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "chore: add plan"]);
    await git(dir, ["checkout", "-b", "existing-feature"]);

    const gitService = new GitService(dir);
    const branch = await gitService.ensureFeatureBranchForPlan(planPath, "main");

    expect(branch).toBe("existing-feature");
    expect((await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("existing-feature");
    expect(await localBranchExists(dir, "add-auth")).toBe(false);
  });

  it("switches detached HEAD to the derived plan branch", async () => {
    const dir = await createGitRepo();
    const planPath = path.join(dir, "docs", "plans", "2026-03-03-add-auth.md");

    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, "# Plan: Add auth\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "chore: add plan"]);
    await git(dir, ["checkout", "--detach"]);

    const gitService = new GitService(dir);
    const branch = await gitService.ensureFeatureBranchForPlan(planPath, "main");

    expect(branch).toBe("add-auth");
    expect((await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("add-auth");
  });

  it("tracks and commits untracked plan when running from non-base branch", async () => {
    const dir = await createGitRepo();
    const planPath = path.join(dir, "docs", "plans", "2026-03-03-add-auth.md");

    await git(dir, ["checkout", "-b", "existing-feature"]);
    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, "# Plan: Add auth\n", "utf8");

    const gitService = new GitService(dir);
    const branch = await gitService.ensureFeatureBranchForPlan(planPath, "main");

    expect(branch).toBe("existing-feature");
    expect((await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("existing-feature");
    expect((await git(dir, ["log", "-1", "--pretty=%s"])).trim()).toBe("chore(plan): add 2026-03-03-add-auth.md");
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
  });

  it("detects default branch from local repo when no override provided", async () => {
    const dir = await createGitRepo();
    const gitService = new GitService(dir);

    await git(dir, ["checkout", "-b", "work-in-progress"]);

    const base = await gitService.detectBaseBranch();
    expect(base).toBe("main");
  });

  it("returns origin/main when only remote-tracking main exists", async () => {
    const dir = await createGitRepo();
    const gitService = new GitService(dir);

    await git(dir, ["checkout", "-b", "work-in-progress"]);
    await git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await git(dir, ["branch", "-D", "main"]);

    const base = await gitService.detectBaseBranch();
    expect(base).toBe("origin/main");
  });

  it("uses origin HEAD symbolic ref when it points to remote-only default branch", async () => {
    const dir = await createGitRepo();
    const gitService = new GitService(dir);

    await git(dir, ["checkout", "-b", "work-in-progress"]);
    await git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await git(dir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    await git(dir, ["branch", "-D", "main"]);

    const base = await gitService.detectBaseBranch();
    expect(base).toBe("origin/main");
  });

  it("uses explicit base branch override", async () => {
    const dir = await createGitRepo();
    const gitService = new GitService(dir);

    const base = await gitService.detectBaseBranch("release/1.0");
    expect(base).toBe("release/1.0");
  });

  it("creates checkpoint commit before execution when workspace is dirty", async () => {
    const dir = await createGitRepo();
    const planPath = path.join(dir, "docs", "plans", "2026-03-03-add-auth.md");
    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, "# Plan: Add auth\n\n## Validation Commands\n- `git status --short`\n\n### Task 1: Demo\n- [ ] done\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "chore: add plan"]);

    await writeFile(path.join(dir, ".gitignore"), "node_modules/\n", "utf8");

    const gitService = new GitService(dir);
    const checkpoint = await gitService.checkpointDirtyWorkspaceBeforeExecution(planPath);

    expect(checkpoint.committed).toBe(true);
    expect(checkpoint.dirtyCount).toBeGreaterThan(0);
    expect((await git(dir, ["log", "-1", "--pretty=%s"])).trim()).toBe("chore: checkpoint before execution");
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
  });

  it("commits generated plan when creating feature branch from base branch", async () => {
    const dir = await createGitRepo();
    const planPath = path.join(dir, "docs", "plans", "2026-03-03-add-auth.md");

    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, "# Plan: Add auth\n", "utf8");

    const gitService = new GitService(dir);
    const branch = await gitService.ensureFeatureBranchForPlan(planPath, "main");

    expect(branch).toBe("add-auth");
    expect((await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("add-auth");
    expect((await git(dir, ["log", "-1", "--pretty=%s"])).trim()).toBe("chore(plan): add 2026-03-03-add-auth.md");
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
  });

  it("ignores playwright-report runtime artifacts during preflight checks and staging", async () => {
    const dir = await createGitRepo();
    const planPath = path.join(dir, "docs", "plans", "2026-03-03-add-auth.md");
    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, "# Plan: Add auth\n\n## Validation Commands\n- `git status --short`\n\n### Task 1: Demo\n- [ ] done\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "chore: add plan"]);

    await mkdir(path.join(dir, "playwright-report"), { recursive: true });
    await writeFile(path.join(dir, "playwright-report", "index.html"), "<html></html>\n", "utf8");
    await writeFile(path.join(dir, "README.md"), "updated\n", "utf8");

    const gitService = new GitService(dir);
    const checkpoint = await gitService.checkpointDirtyWorkspaceBeforeExecution(planPath);

    expect(checkpoint.committed).toBe(true);
    const status = (await git(dir, ["status", "--porcelain"])).trim();
    expect(status).toContain("?? playwright-report/");
    expect(status).not.toContain("README.md");
  });

  it("keeps runtime artifact directories unstaged when fallback add path is used", async () => {
    const dir = await createGitRepo();
    const planPath = path.join(dir, "docs", "plans", "2026-03-03-add-auth.md");
    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, "# Plan: Add auth\n\n## Validation Commands\n- `git status --short`\n\n### Task 1: Demo\n- [ ] done\n", "utf8");
    await writeFile(path.join(dir, ".gitignore"), ".thred/artifacts/\n.thred/runs/\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "chore: add plan and ignore"]);

    await mkdir(path.join(dir, ".thred"), { recursive: true });
    await writeFile(path.join(dir, ".thred", "local.log"), "noise\n", "utf8");
    await mkdir(path.join(dir, "test-results"), { recursive: true });
    await writeFile(path.join(dir, "test-results", "result.txt"), "result\n", "utf8");
    await mkdir(path.join(dir, "playwright-report"), { recursive: true });
    await writeFile(path.join(dir, "playwright-report", "index.html"), "<html></html>\n", "utf8");
    await writeFile(path.join(dir, "README.md"), "updated\n", "utf8");

    const gitService = new GitService(dir);
    const checkpoint = await gitService.checkpointDirtyWorkspaceBeforeExecution(planPath);

    expect(checkpoint.committed).toBe(true);
    const status = (await git(dir, ["status", "--porcelain"])).trim();
    expect(status).toContain("?? test-results/");
    expect(status).toContain("?? playwright-report/");
    const committedFiles = (await git(dir, ["show", "--name-only", "--pretty=format:", "HEAD"]))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    expect(committedFiles).toContain("README.md");
    expect(committedFiles).not.toContain("test-results/result.txt");
    expect(committedFiles).not.toContain("playwright-report/index.html");
  });

  it("allows exact runtime .thred ignore additions during cleanliness checks", async () => {
    const dir = await createGitRepo();
    const planPath = path.join(dir, "docs", "plans", "2026-03-03-add-auth.md");
    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, "# Plan: Add auth\n\n## Validation Commands\n- `git status --short`\n\n### Task 1: Demo\n- [ ] done\n", "utf8");
    await writeFile(path.join(dir, ".gitignore"), "node_modules/\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "chore: add plan and gitignore"]);

    await appendFile(path.join(dir, ".gitignore"), ".thred/artifacts/\n.thred/runs/\n", "utf8");

    const gitService = new GitService(dir);
    await expect(gitService.ensureCleanExceptPlan(planPath)).resolves.toBeUndefined();
  });

  it("allows untracked .gitignore containing only runtime .thred rules during cleanliness checks", async () => {
    const dir = await createGitRepo();
    const planPath = path.join(dir, "docs", "plans", "2026-03-03-add-auth.md");
    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, "# Plan: Add auth\n\n## Validation Commands\n- `git status --short`\n\n### Task 1: Demo\n- [ ] done\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "chore: add plan"]);

    await writeFile(path.join(dir, ".gitignore"), ".thred/artifacts/\n.thred/runs/\n", "utf8");

    const gitService = new GitService(dir);
    await expect(gitService.ensureCleanExceptPlan(planPath)).resolves.toBeUndefined();
  });

  it("does not ignore mixed .gitignore edits when runtime .thred rules are added", async () => {
    const dir = await createGitRepo();
    const planPath = path.join(dir, "docs", "plans", "2026-03-03-add-auth.md");
    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, "# Plan: Add auth\n\n## Validation Commands\n- `git status --short`\n\n### Task 1: Demo\n- [ ] done\n", "utf8");
    await writeFile(path.join(dir, ".gitignore"), "node_modules/\ndist/\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "chore: add plan and gitignore"]);

    await writeFile(path.join(dir, ".gitignore"), "dist/\n.thred/artifacts/\n", "utf8");

    const gitService = new GitService(dir);
    await expect(gitService.ensureCleanExceptPlan(planPath)).rejects.toThrow(
      /working tree has uncommitted changes outside plan file/i
    );
  });

  it("does not ignore tracked runtime artifact modifications", async () => {
    const dir = await createGitRepo();
    const planPath = path.join(dir, "docs", "plans", "2026-03-03-add-auth.md");
    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, "# Plan: Add auth\n\n## Validation Commands\n- `git status --short`\n\n### Task 1: Demo\n- [ ] done\n", "utf8");
    await mkdir(path.join(dir, "test-results"), { recursive: true });
    await writeFile(path.join(dir, "test-results", "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "chore: add plan and tracked artifact file"]);

    await writeFile(path.join(dir, "test-results", "tracked.txt"), "after\n", "utf8");

    const gitService = new GitService(dir);
    await expect(gitService.ensureCleanExceptPlan(planPath)).rejects.toThrow(
      /working tree has uncommitted changes outside plan file/i
    );
  });

  it("ignores tracked runtime artifact deletions during checkpoint cleanliness checks", async () => {
    const dir = await createGitRepo();
    const planPath = path.join(dir, "docs", "plans", "2026-03-03-add-auth.md");
    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, "# Plan: Add auth\n\n## Validation Commands\n- `git status --short`\n\n### Task 1: Demo\n- [ ] done\n", "utf8");
    await mkdir(path.join(dir, "test-results"), { recursive: true });
    await writeFile(path.join(dir, "test-results", "tracked.txt"), "before\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "chore: add plan and tracked artifact file"]);

    await appendFile(path.join(dir, "README.md"), "changed\n", "utf8");
    await rm(path.join(dir, "test-results", "tracked.txt"));

    const gitService = new GitService(dir);
    const checkpoint = await gitService.checkpointDirtyWorkspaceBeforeExecution(planPath);

    expect(checkpoint.committed).toBe(true);
    await expect(gitService.ensureCleanExceptPlan(planPath)).resolves.toBeUndefined();
    expect((await git(dir, ["status", "--porcelain"])).includes(" D test-results/tracked.txt")).toBe(true);
  });

  it("reports renamed paths as original -> current during cleanliness checks", async () => {
    const dir = await createGitRepo();
    const planPath = path.join(dir, "docs", "plans", "2026-03-03-add-auth.md");
    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, "# Plan: Add auth\n\n## Validation Commands\n- `git status --short`\n\n### Task 1: Demo\n- [ ] done\n", "utf8");
    await writeFile(path.join(dir, "old-name.txt"), "before\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "chore: add plan and rename fixture"]);

    await git(dir, ["mv", "old-name.txt", "new-name.txt"]);

    const gitService = new GitService(dir);
    await expect(gitService.ensureCleanExceptPlan(planPath)).rejects.toThrow(
      /old-name\.txt -> new-name\.txt/
    );
  });

  it("moves tracked plan to completed with git mv and archives in commit", async () => {
    const dir = await createGitRepo();
    const relPlan = "docs/plans/2026-03-03-add-auth.md";
    const relCompletedPlan = "docs/plans/completed/2026-03-03-add-auth.md";
    const planPath = path.join(dir, relPlan);

    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, "# Plan: Add auth\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "chore: add plan"]);

    const gitService = new GitService(dir);
    const movedPath = await gitService.movePlanToCompleted(planPath);

    expect(movedPath).toBe(path.join(dir, relCompletedPlan));
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
    expect((await git(dir, ["log", "-1", "--pretty=%s"])).trim()).toBe(
      "chore(plan): move completed plan 2026-03-03-add-auth.md"
    );

    const nameStatus = await git(dir, ["show", "--name-status", "--pretty=format:", "HEAD"]);
    expect(nameStatus).toMatch(/R\d+\s+docs\/plans\/2026-03-03-add-auth\.md\s+docs\/plans\/completed\/2026-03-03-add-auth\.md/);
  });

  it("includes extra commit paths when moving plan to completed", async () => {
    const dir = await createGitRepo();
    const relPlan = "docs/plans/2026-03-03-add-auth.md";
    const relBacklog = "docs/release/stability-backlog.md";
    const planPath = path.join(dir, relPlan);
    const backlogPath = path.join(dir, relBacklog);

    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, "# Plan: Add auth\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "chore: add plan"]);

    await mkdir(path.dirname(backlogPath), { recursive: true });
    await writeFile(backlogPath, "# Stability Backlog\n", "utf8");

    const gitService = new GitService(dir);
    await gitService.movePlanToCompleted(planPath, [backlogPath]);

    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
    const committedFiles = (await git(dir, ["show", "--name-only", "--pretty=format:", "HEAD"]))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    expect(committedFiles).toContain("docs/plans/completed/2026-03-03-add-auth.md");
    expect(committedFiles).toContain(relBacklog);
  });

  it("moves untracked plan to completed and commits destination path", async () => {
    const dir = await createGitRepo();
    const relPlan = "docs/plans/2026-03-03-add-auth.md";
    const relCompletedPlan = "docs/plans/completed/2026-03-03-add-auth.md";
    const planPath = path.join(dir, relPlan);

    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, "# Plan: Add auth\n", "utf8");

    const gitService = new GitService(dir);
    const movedPath = await gitService.movePlanToCompleted(planPath);

    expect(movedPath).toBe(path.join(dir, relCompletedPlan));
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
    expect((await git(dir, ["log", "-1", "--pretty=%s"])).trim()).toBe(
      "chore(plan): move completed plan 2026-03-03-add-auth.md"
    );

    const committedFiles = (await git(dir, ["show", "--name-only", "--pretty=format:", "HEAD"]))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    expect(committedFiles).toContain(relCompletedPlan);
    expect(committedFiles).not.toContain(relPlan);
  });
});

async function createGitRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "thred-git-service-"));
  await git(dir, ["init"]);
  await git(dir, ["config", "user.name", "thred-tests"]);
  await git(dir, ["config", "user.email", "thred-tests@example.com"]);

  await writeFile(path.join(dir, "README.md"), "init\n", "utf8");
  await git(dir, ["add", "README.md"]);
  await git(dir, ["commit", "-m", "chore: init"]);
  await git(dir, ["branch", "-M", "main"]);
  return dir;
}

async function localBranchExists(cwd: string, name: string): Promise<boolean> {
  const result = await runCommand("git", ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], { cwd });
  return result.code === 0;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runCommand("git", args, { cwd });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return `${result.stdout}${result.stderr}`;
}
