import path from "node:path";
import { readFile, rename } from "node:fs/promises";

import { runCommand } from "../util/process.js";
import { ensureDir } from "../util/fs.js";
import { branchNameFromPlanPath } from "../plan/parser.js";

const LEGACY_THRED_GITIGNORE_LINE = ".thred/";
const THRED_RUNTIME_GITIGNORE_LINES = [".thred/artifacts/", ".thred/runs/"] as const;

interface GitStatusEntry {
  xy: string;
  path: string;
  originalPath?: string;
}

export class GitService {
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  async ensureRepoRoot(): Promise<void> {
    const result = await this.git(["rev-parse", "--show-toplevel"]);
    const repoRoot = result.stdout.trim();
    if (path.resolve(repoRoot) !== path.resolve(this.cwd)) {
      throw new Error(`thred must run from repository root: ${repoRoot}`);
    }
  }

  async currentBranch(): Promise<string> {
    const result = await this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
    return result.stdout.trim();
  }

  async detectBaseBranch(override?: string): Promise<string> {
    if (override) {
      return override;
    }
    return this.detectDefaultBranch();
  }

  async checkpointDirtyWorkspaceBeforeExecution(planPath: string): Promise<{ committed: boolean; dirtyCount: number }> {
    const externalDirty = await this.listDirtyOutsidePlan(planPath);
    if (externalDirty.length === 0) {
      return { committed: false, dirtyCount: 0 };
    }

    const committed = await this.stageAllAndCommit("chore: checkpoint before execution");
    return {
      committed,
      dirtyCount: externalDirty.length
    };
  }

  async ensureCleanExceptPlan(planPath: string): Promise<void> {
    const externalDirty = await this.listDirtyOutsidePlan(planPath);

    if (externalDirty.length > 0) {
      throw new Error(
        `working tree has uncommitted changes outside plan file:\n${externalDirty.join("\n")}`
      );
    }
  }

  async ensureFeatureBranchForPlan(planPath: string, baseRef: string): Promise<string> {
    const relPlan = path.relative(this.cwd, planPath);
    const targetBranch = branchNameFromPlanPath(planPath);
    const current = await this.currentBranch();
    if (current === targetBranch) {
      await this.commitPlanIfNeeded(relPlan, planPath);
      return targetBranch;
    }
    if (current === "HEAD") {
      if (await this.branchExists(targetBranch)) {
        await this.git(["checkout", targetBranch]);
      } else {
        await this.git(["checkout", "-b", targetBranch]);
      }

      await this.commitPlanIfNeeded(relPlan, planPath);
      return targetBranch;
    }
    if (!matchesBaseBranch(current, baseRef)) {
      await this.commitPlanIfNeeded(relPlan, planPath);
      return current;
    }

    if (await this.branchExists(targetBranch)) {
      await this.git(["checkout", targetBranch]);
    } else {
      await this.git(["checkout", "-b", targetBranch]);
    }

    await this.commitPlanIfNeeded(relPlan, planPath);

    return targetBranch;
  }

  async stageAllAndCommit(message: string): Promise<boolean> {
    const preferredAdd = await this.gitSafe([
      "add",
      "-A",
      "--",
      ".",
      ":(exclude).thred/artifacts/**",
      ":(exclude)test-results/**",
      ":(exclude)playwright-report/**"
    ]);
    if (!preferredAdd.ok) {
      if (!isIgnoredPathspecFailure(preferredAdd.stderr, preferredAdd.stdout)) {
        throw new Error(`git add failed: ${preferredAdd.stderr || preferredAdd.stdout}`);
      }
      await this.git(["add", "-A", "--", "."]);
      await this.unstageExcludedArtifactPaths();
    }
    const hasChanges = await this.hasStagedChanges();
    if (!hasChanges) {
      return false;
    }
    await this.git(["commit", "-m", message]);
    return true;
  }

  async movePlanToCompleted(planPath: string, extraCommitPaths: string[] = []): Promise<string> {
    const relPlan = path.relative(this.cwd, planPath);
    const completedRel = path.join(path.dirname(relPlan), "completed", path.basename(relPlan));
    const completedAbs = path.join(this.cwd, completedRel);

    await ensureDir(path.dirname(completedAbs));
    const tracked = await this.isTrackedPath(relPlan);
    if (tracked) {
      await this.git(["mv", "--", relPlan, completedRel]);
    } else {
      await rename(path.join(this.cwd, relPlan), completedAbs);
      await this.git(["add", "-A", "--", completedRel]);
    }
    const normalizedExtraPaths = Array.from(
      new Set(
        extraCommitPaths
          .map((filePath) => {
            if (!filePath) {
              return "";
            }
            return path.isAbsolute(filePath) ? path.relative(this.cwd, filePath) : filePath;
          })
          .filter((filePath) => filePath !== "" && !filePath.startsWith(".."))
          .filter((filePath) => filePath !== relPlan && filePath !== completedRel)
      )
    );
    if (normalizedExtraPaths.length > 0) {
      await this.git(["add", "-A", "--", ...normalizedExtraPaths]);
    }
    const commitPathspec = tracked
      ? [relPlan, completedRel, ...normalizedExtraPaths]
      : [completedRel, ...normalizedExtraPaths];
    await this.git([
      "commit",
      "-m",
      `chore(plan): move completed plan ${path.basename(planPath)}`,
      "--",
      ...commitPathspec
    ]);
    return completedAbs;
  }

  async diffStats(baseRef: string): Promise<{ files: number; additions: number; deletions: number }> {
    const result = await this.git(["diff", "--numstat", `${baseRef}...HEAD`]);
    const lines = result.stdout.split(/\r?\n/).filter(Boolean);

    let files = 0;
    let additions = 0;
    let deletions = 0;

    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 3) continue;
      files += 1;
      if (parts[0] !== "-") additions += Number(parts[0]);
      if (parts[1] !== "-") deletions += Number(parts[1]);
    }

    return { files, additions, deletions };
  }

  private async branchExists(branch: string): Promise<boolean> {
    const res = await this.gitSafe(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (res.ok) {
      return true;
    }

    const remoteRes = await this.gitSafe(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
    return remoteRes.ok;
  }

  private async detectDefaultBranch(): Promise<string> {
    const originHead = await this.gitSafe(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    if (originHead.ok) {
      const ref = originHead.stdout.trim();
      if (ref) {
        const candidate = ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
        if (candidate && await this.refExists(`refs/heads/${candidate}`)) {
          return candidate;
        }
        if (candidate && await this.refExists(`refs/remotes/origin/${candidate}`)) {
          return `origin/${candidate}`;
        }
      }
    }

    for (const candidate of ["main", "master", "trunk", "develop"]) {
      if (await this.refExists(`refs/heads/${candidate}`)) {
        return candidate;
      }
      if (await this.refExists(`refs/remotes/origin/${candidate}`)) {
        return `origin/${candidate}`;
      }
    }

    return this.currentBranch();
  }

  private async refExists(ref: string): Promise<boolean> {
    const result = await this.gitSafe(["show-ref", "--verify", "--quiet", ref]);
    return result.ok;
  }

  private async fileHasChanges(relPath: string): Promise<boolean> {
    const result = await this.git(["status", "--porcelain", "-uall", "--", relPath]);
    return result.stdout.trim() !== "";
  }

  private async commitPlanIfNeeded(relPlan: string, planPath: string): Promise<void> {
    if (!(await this.fileHasChanges(relPlan))) {
      return;
    }
    await this.git(["add", "--", relPlan]);
    await this.git(["commit", "-m", `chore(plan): add ${path.basename(planPath)}`]);
  }

  private async isTrackedPath(relPath: string): Promise<boolean> {
    const result = await this.gitSafe(["ls-files", "--error-unmatch", "--", relPath]);
    return result.ok;
  }

  private async unstageExcludedArtifactPaths(): Promise<void> {
    const reset = await this.gitSafe([
      "reset",
      "--",
      ".thred/artifacts",
      "test-results",
      "playwright-report"
    ]);
    if (!reset.ok && !isPathspecDidNotMatchError(reset.stderr, reset.stdout)) {
      throw new Error(`git reset failed: ${reset.stderr || reset.stdout}`);
    }
  }

  private async hasStagedChanges(): Promise<boolean> {
    const result = await this.gitSafe(["diff", "--cached", "--quiet"]);
    if (result.code === 0) {
      return false;
    }
    if (result.code === 1) {
      return true;
    }

    throw new Error(`git diff --cached --quiet failed: ${result.stderr || result.stdout}`);
  }

  private async isThredGitignoreOnlyChange(): Promise<boolean> {
    const status = await this.gitSafe(["status", "--porcelain", "-uall", "--", ".gitignore"]);
    if (!status.ok) {
      return false;
    }
    const statusLines = status.stdout
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean);

    if (statusLines.length === 1 && isUntrackedStatusLine(statusLines[0] ?? "")) {
      const gitignorePath = path.join(this.cwd, ".gitignore");
      const content = await readFile(gitignorePath, "utf8");
      return hasOnlyThredGitignoreEntry(content);
    }

    const diff = await this.gitSafe(["diff", "--unified=0", "--", ".gitignore"]);
    if (!diff.ok && diff.code !== 1) {
      return false;
    }

    const lines = diff.stdout.split(/\r?\n/).map((line) => line.trimEnd());
    let thredAdditions = 0;

    for (const line of lines) {
      if (
        line === "" ||
        line.startsWith("diff --git ") ||
        line.startsWith("index ") ||
        line.startsWith("+++ ") ||
        line.startsWith("--- ") ||
        line.startsWith("@@")
      ) {
        continue;
      }

      if (line.startsWith("-")) {
        return false;
      }

      if (line === "\\ No newline at end of file") {
        return false;
      }

      if (!line.startsWith("+")) {
        continue;
      }

      const added = line.slice(1).trim();
      if (THRED_RUNTIME_GITIGNORE_LINES.includes(added as (typeof THRED_RUNTIME_GITIGNORE_LINES)[number])) {
        thredAdditions += 1;
        continue;
      }
      return false;
    }

    return thredAdditions > 0;
  }

  private async listDirtyOutsidePlan(planPath: string): Promise<string[]> {
    const relPlan = path.relative(this.cwd, planPath);
    const status = await this.git(["status", "--porcelain=v1", "-z", "-uall"]);
    const dirtyEntries = parseStatusEntries(status.stdout);
    const shouldIgnoreGitignoreOnly = dirtyEntries.some((entry) => entry.path === ".gitignore")
      ? await this.isThredGitignoreOnlyChange()
      : false;

    const externalDirty: string[] = [];
    for (const entry of dirtyEntries) {
      const filePath = entry.path;
      if (filePath === relPlan) {
        continue;
      }
      if (isThredRuntimePath(filePath) && (isUntrackedStatusCode(entry.xy) || isDeletedStatusCode(entry.xy))) {
        continue;
      }
      if (filePath === ".gitignore" && shouldIgnoreGitignoreOnly) {
        continue;
      }
      externalDirty.push(formatStatusEntry(entry));
    }

    return externalDirty;
  }

  private async git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const result = await runCommand("git", args, { cwd: this.cwd });
    if (result.code !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return result;
  }

  private async gitSafe(
    args: string[]
  ): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
    const result = await runCommand("git", args, { cwd: this.cwd });
    return {
      ok: result.code === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code
    };
  }
}

function matchesBaseBranch(currentBranch: string, baseRef: string): boolean {
  if (!baseRef) {
    return false;
  }
  const normalized = baseRef.startsWith("origin/") ? baseRef.slice("origin/".length) : baseRef;
  return currentBranch === normalized || currentBranch === baseRef;
}

function parseStatusEntries(stdout: string): GitStatusEntry[] {
  const tokens = stdout.split("\0");
  const entries: GitStatusEntry[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "") {
      continue;
    }
    if (token.length < 3) {
      continue;
    }

    const xy = token.slice(0, 2);
    const rawPath = token.slice(3);
    if (xy.includes("R") || xy.includes("C")) {
      const originalPath = tokens[index + 1] ?? "";
      entries.push({
        xy,
        originalPath: originalPath || rawPath,
        path: rawPath
      });
      index += 1;
      continue;
    }

    entries.push({
      xy,
      path: rawPath
    });
  }

  return entries;
}

function formatStatusEntry(entry: GitStatusEntry): string {
  if (entry.originalPath) {
    return `${entry.xy} ${entry.originalPath} -> ${entry.path}`;
  }
  return `${entry.xy} ${entry.path}`;
}

function isThredRuntimePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return (
    normalized === ".thred/artifacts" ||
    normalized.startsWith(".thred/artifacts/") ||
    normalized === "test-results" ||
    normalized.startsWith("test-results/") ||
    normalized === "playwright-report" ||
    normalized.startsWith("playwright-report/")
  );
}

function isIgnoredPathspecFailure(stderr: string, stdout: string): boolean {
  const output = `${stderr}\n${stdout}`.toLowerCase();
  return (
    output.includes("ignored by one of your .gitignore files") &&
    (output.includes(".thred/artifacts") || output.includes("test-results") || output.includes("playwright-report"))
  );
}

function isPathspecDidNotMatchError(stderr: string, stdout: string): boolean {
  const output = `${stderr}\n${stdout}`.toLowerCase();
  return output.includes("did not match any file(s) known to git");
}

function isUntrackedStatusLine(statusLine: string): boolean {
  return statusLine.startsWith("?? ");
}

function isUntrackedStatusCode(xy: string): boolean {
  return xy === "??";
}

function isDeletedStatusCode(xy: string): boolean {
  return xy.includes("D");
}

function hasOnlyThredGitignoreEntry(content: string): boolean {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) {
    return false;
  }
  if (lines.includes(LEGACY_THRED_GITIGNORE_LINE)) {
    return false;
  }
  return lines.every((line) =>
    THRED_RUNTIME_GITIGNORE_LINES.includes(line as (typeof THRED_RUNTIME_GITIGNORE_LINES)[number])
  );
}
