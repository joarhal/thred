import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { cleanupInteractivePreflight } from "../src/core/interactive/preflight-cleanup.js";
import { exists } from "../src/core/util/fs.js";
import { runCommand } from "../src/core/util/process.js";

describe("interactive preflight cleanup", () => {
  it("commits deleted plans and relocates known artifacts", async () => {
    const dir = await createGitRepo();

    const trackedPlan = path.join(dir, "docs", "plans", "old.md");
    await mkdir(path.dirname(trackedPlan), { recursive: true });
    await writeFile(trackedPlan, "# Plan: Old\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "chore: add old plan"]);

    await rm(trackedPlan);

    const artifactPath = path.join(dir, "test-results", "run-1", "error-context.md");
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, "artifact\n", "utf8");

    const result = await cleanupInteractivePreflight(dir);

    expect(result.committedDeletedPlans).toContain("docs/plans/old.md");
    expect(result.relocatedArtifacts).toContain(".thred/artifacts/test-results");
    expect(await exists(artifactPath)).toBe(false);

    const status = (await git(dir, ["status", "--porcelain"]))
      .trim();
    expect(status).toBe("");
  });

  it("is no-op on clean workspace", async () => {
    const dir = await createGitRepo();

    const result = await cleanupInteractivePreflight(dir);

    expect(result.committedDeletedPlans).toHaveLength(0);
    expect(result.relocatedArtifacts).toHaveLength(0);
  });

  it("does not auto-commit deleted markdown files outside docs/plans", async () => {
    const dir = await createGitRepo();

    const notePath = path.join(dir, "docs", "notes", "old.md");
    await mkdir(path.dirname(notePath), { recursive: true });
    await writeFile(notePath, "# Notes\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "chore: add notes"]);

    await rm(notePath);

    const result = await cleanupInteractivePreflight(dir);

    expect(result.committedDeletedPlans).toHaveLength(0);
    expect(result.relocatedArtifacts).toHaveLength(0);
    expect((await git(dir, ["status", "--porcelain"])).includes(" D docs/notes/old.md")).toBe(true);
  });

  it("does not auto-commit deleted archived plans under docs/plans/completed", async () => {
    const dir = await createGitRepo();

    const archivedPlanPath = path.join(dir, "docs", "plans", "completed", "old.md");
    await mkdir(path.dirname(archivedPlanPath), { recursive: true });
    await writeFile(archivedPlanPath, "# Plan: Completed\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "chore: add archived plan"]);

    await rm(archivedPlanPath);

    const result = await cleanupInteractivePreflight(dir);

    expect(result.committedDeletedPlans).toHaveLength(0);
    expect(result.relocatedArtifacts).toHaveLength(0);
    expect((await git(dir, ["status", "--porcelain"])).includes(" D docs/plans/completed/old.md")).toBe(true);
  });
});

async function createGitRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "thred-preflight-cleanup-"));
  await git(dir, ["init"]);
  await git(dir, ["config", "user.name", "thred-tests"]);
  await git(dir, ["config", "user.email", "thred-tests@example.com"]);

  await writeFile(path.join(dir, "README.md"), "init\n", "utf8");
  await writeFile(path.join(dir, ".gitignore"), ".thred/\n", "utf8");
  await git(dir, ["add", "README.md", ".gitignore"]);
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
