import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ensureGitWorkspaceReady } from "../src/commands/execute.js";
import { runCommand } from "../src/core/util/process.js";

describe("execute git bootstrap", () => {
  it("initializes a git repository in non-repo directory", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-exec-bootstrap-"));

    await ensureGitWorkspaceReady(dir);

    expect(await hasHead(dir)).toBe(true);
    expect(await latestCommitSubject(dir)).toBe("initial commit");
  });

  it("creates initial commit when repository has no commits", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-exec-bootstrap-"));
    await git(dir, ["init"]);
    await writeFile(path.join(dir, "README.md"), "demo\n", "utf8");

    await ensureGitWorkspaceReady(dir);

    expect(await hasHead(dir)).toBe(true);
    expect(await latestCommitSubject(dir)).toBe("initial commit");
    expect((await git(dir, ["status", "--porcelain"])).includes("?? README.md")).toBe(true);
  });

  it("does not create extra commits when HEAD already exists", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-exec-bootstrap-"));
    await git(dir, ["init"]);
    await git(dir, ["commit", "--allow-empty", "-m", "already initialized"], {
      GIT_AUTHOR_NAME: "tests",
      GIT_AUTHOR_EMAIL: "tests@example.com",
      GIT_COMMITTER_NAME: "tests",
      GIT_COMMITTER_EMAIL: "tests@example.com"
    });

    const before = Number(await git(dir, ["rev-list", "--count", "HEAD"]));
    await ensureGitWorkspaceReady(dir);
    const after = Number(await git(dir, ["rev-list", "--count", "HEAD"]));

    expect(before).toBe(1);
    expect(after).toBe(1);
    expect(await latestCommitSubject(dir)).toBe("already initialized");
  });

  it("initializes in non-empty non-repo directory", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-exec-bootstrap-populated-"));
    await writeFile(path.join(dir, "notes.txt"), "local draft\n", "utf8");

    await ensureGitWorkspaceReady(dir);

    expect(await hasHead(dir)).toBe(true);
    expect(await latestCommitSubject(dir)).toBe("initial commit");
    expect((await git(dir, ["status", "--porcelain"])).includes("?? notes.txt")).toBe(true);
  });

  it("creates initial commit even when pre-commit hook fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-exec-bootstrap-hooks-"));
    await git(dir, ["init"]);
    await mkdir(path.join(dir, ".git", "hooks"), { recursive: true });
    const hookPath = path.join(dir, ".git", "hooks", "pre-commit");
    await writeFile(hookPath, "#!/bin/sh\nexit 1\n", { encoding: "utf8", mode: 0o755 });
    await chmod(hookPath, 0o755);

    await ensureGitWorkspaceReady(dir);

    expect(await hasHead(dir)).toBe(true);
    expect(await latestCommitSubject(dir)).toBe("initial commit");
  });
});

async function hasHead(cwd: string): Promise<boolean> {
  const result = await runCommand("git", ["rev-parse", "--verify", "HEAD"], { cwd });
  return result.code === 0;
}

async function latestCommitSubject(cwd: string): Promise<string> {
  return (await git(cwd, ["log", "-1", "--pretty=%s"])).trim();
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await runCommand("git", args, { cwd, env });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return `${result.stdout}${result.stderr}`;
}
