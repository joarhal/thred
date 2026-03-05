import { relocateKnownProjectArtifacts } from "../artifacts/manager.js";
import { runCommand } from "../util/process.js";

export interface InteractivePreflightCleanupResult {
  committedDeletedPlans: string[];
  relocatedArtifacts: string[];
}

export async function cleanupInteractivePreflight(
  cwd: string,
  options: { isGit?: boolean } = {}
): Promise<InteractivePreflightCleanupResult> {
  const isGit = options.isGit ?? true;
  if (!isGit) {
    const relocatedNoGit = await relocateKnownProjectArtifacts(cwd);
    return {
      committedDeletedPlans: [],
      relocatedArtifacts: relocatedNoGit.map((item) => item.targetRelativePath)
    };
  }

  const status = await runCommand("git", ["status", "--porcelain", "-uall"], { cwd });
  if (status.code !== 0) {
    throw new Error(`git status failed during interactive cleanup: ${status.stderr || status.stdout}`);
  }

  const lines = status.stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);

  const deletedPlans = new Set<string>();
  for (const line of lines) {
    const statusCode = line.slice(0, 2);
    const filePath = extractStatusPath(line);

    if (isDeletedStatus(statusCode) && isPlanPath(filePath)) {
      deletedPlans.add(filePath);
    }
  }

  let committedDeletedPlans: string[] = [];
  if (deletedPlans.size > 0) {
    const planPaths = [...deletedPlans];

    const add = await runCommand("git", ["add", "-A", "--", ...planPaths], { cwd });
    if (add.code !== 0) {
      throw new Error(`git add failed during interactive cleanup: ${add.stderr || add.stdout}`);
    }

    const staged = await runCommand("git", ["diff", "--cached", "--quiet", "--", ...planPaths], { cwd });
    if (staged.code === 1) {
      const commit = await runCommand(
        "git",
        ["commit", "-m", "chore(plan): cleanup abandoned plans", "--", ...planPaths],
        { cwd }
      );

      if (commit.code !== 0) {
        throw new Error(`git commit failed during interactive cleanup: ${commit.stderr || commit.stdout}`);
      }

      committedDeletedPlans = planPaths;
    } else if (staged.code !== 0) {
      throw new Error(`git diff --cached failed during interactive cleanup: ${staged.stderr || staged.stdout}`);
    }
  }

  const relocated = await relocateKnownProjectArtifacts(cwd);

  return {
    committedDeletedPlans,
    relocatedArtifacts: relocated.map((item) => item.targetRelativePath)
  };
}

function isDeletedStatus(statusCode: string): boolean {
  return statusCode.includes("D");
}

function isPlanPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return (
    normalized.startsWith("docs/plans/") &&
    !normalized.startsWith("docs/plans/completed/") &&
    normalized.endsWith(".md")
  );
}

function extractStatusPath(statusLine: string): string {
  const trimmed = statusLine.length > 3 ? statusLine.slice(3) : statusLine;
  const renameSeparator = " -> ";
  if (trimmed.includes(renameSeparator)) {
    return trimmed.split(renameSeparator).at(-1) ?? trimmed;
  }
  return trimmed;
}
