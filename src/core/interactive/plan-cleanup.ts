import path from "node:path";

import { runCommand } from "../util/process.js";
import { deletePlanFile } from "./unfinished-plan.js";

export interface PlanCleanupResult {
  committed: boolean;
  relativePath: string;
}

export async function removePlanAndCommitDeletionIfTracked(
  cwd: string,
  planPath: string,
  options: { isGit?: boolean } = {}
): Promise<PlanCleanupResult> {
  const isGit = options.isGit ?? true;
  const relativePath = path.relative(cwd, planPath);

  await deletePlanFile(planPath);

  if (!isGit) {
    return { committed: false, relativePath };
  }

  const status = await runCommand("git", ["status", "--porcelain", "--", relativePath], { cwd });
  if (status.code !== 0) {
    throw new Error(`git status failed while deleting plan: ${status.stderr || status.stdout}`);
  }

  if (status.stdout.trim() === "") {
    return { committed: false, relativePath };
  }

  const add = await runCommand("git", ["add", "-A", "--", relativePath], { cwd });
  if (add.code !== 0) {
    throw new Error(`git add failed while deleting plan: ${add.stderr || add.stdout}`);
  }

  const staged = await runCommand("git", ["diff", "--cached", "--quiet", "--", relativePath], { cwd });
  if (staged.code === 0) {
    return { committed: false, relativePath };
  }
  if (staged.code !== 1) {
    throw new Error(`git diff --cached failed while deleting plan: ${staged.stderr || staged.stdout}`);
  }

  const commitMsg = `chore(plan): remove abandoned ${path.basename(planPath)}`;
  const commit = await runCommand("git", ["commit", "-m", commitMsg, "--", relativePath], { cwd });
  if (commit.code !== 0) {
    throw new Error(`git commit failed while deleting plan: ${commit.stderr || commit.stdout}`);
  }

  return { committed: true, relativePath };
}
