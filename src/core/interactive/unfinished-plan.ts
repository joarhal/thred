import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

export interface UnfinishedPlan {
  path: string;
  relativePath: string;
  mtimeMs: number;
}

export async function listUnfinishedPlans(cwd: string): Promise<UnfinishedPlan[]> {
  const plansRoot = path.join(cwd, "docs", "plans");
  const plans = await collectMarkdownPlans(plansRoot, plansRoot);
  return plans
    .filter((plan) => !isCompletedPlan(plan.relativePath))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function deletePlanFile(planPath: string): Promise<void> {
  await rm(planPath, { force: true });
}

async function collectMarkdownPlans(root: string, dir: string): Promise<UnfinishedPlan[]> {
  const entries = await safeReadDir(dir);
  const results: UnfinishedPlan[] = [];

  for (const entry of entries) {
    const absPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const nested = await collectMarkdownPlans(root, absPath);
      results.push(...nested);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }

    const fileStat = await stat(absPath);
    results.push({
      path: absPath,
      relativePath: path.relative(root, absPath),
      mtimeMs: fileStat.mtimeMs
    });
  }

  return results;
}

function isCompletedPlan(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return normalized === "completed" || normalized.startsWith("completed/");
}

async function safeReadDir(dir: string): Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
