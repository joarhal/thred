import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export const COMPLETED_PLANS_MAX_CONTEXT_FILES = 5;

const COMPLETED_PLANS_RELATIVE_DIR = path.join("docs", "plans", "completed");

export interface CompletedPlansContextSnapshot {
  path: string;
  content: string;
  lineCount: number;
  charCount: number;
  planCount: number;
}

interface CompletedPlanEntry {
  name: string;
  fullPath: string;
  modifiedAt: Date;
  content: string;
}

export async function loadCompletedPlansContext(
  cwd: string,
  maxPlans = COMPLETED_PLANS_MAX_CONTEXT_FILES
): Promise<CompletedPlansContextSnapshot> {
  const completedDir = path.join(cwd, COMPLETED_PLANS_RELATIVE_DIR);
  const plans = await readRecentCompletedPlans(completedDir, maxPlans);
  const content = ensureTrailingNewline(renderCompletedPlansContext(plans));

  return {
    path: completedDir,
    content,
    lineCount: countLines(content),
    charCount: countChars(content),
    planCount: plans.length
  };
}

async function readRecentCompletedPlans(completedDir: string, maxPlans: number): Promise<CompletedPlanEntry[]> {
  let entries;
  try {
    entries = await readdir(completedDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const markdownFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => path.join(completedDir, entry.name));

  if (markdownFiles.length === 0) {
    return [];
  }

  const loaded = await Promise.all(
    markdownFiles.map(async (fullPath) => {
      const fileStat = await stat(fullPath);
      const content = await readFile(fullPath, "utf8");
      return {
        name: path.basename(fullPath),
        fullPath,
        modifiedAt: fileStat.mtime,
        content: content.trim()
      } satisfies CompletedPlanEntry;
    })
  );

  const limit = Number.isFinite(maxPlans) && maxPlans > 0 ? Math.floor(maxPlans) : COMPLETED_PLANS_MAX_CONTEXT_FILES;
  return loaded.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime()).slice(0, limit);
}

function renderCompletedPlansContext(plans: CompletedPlanEntry[]): string {
  if (plans.length === 0) {
    return [
      "# Completed Plans Context",
      "",
      `No completed plans found in \`${COMPLETED_PLANS_RELATIVE_DIR}\`.`
    ].join("\n");
  }

  const sections = plans.map((plan, index) =>
    [
      `## ${index + 1}. ${plan.name}`,
      `Modified: ${plan.modifiedAt.toISOString()}`,
      "",
      plan.content || "(empty plan file)"
    ].join("\n")
  );

  return [
    "# Completed Plans Context",
    "",
    `Most recent completed plans from \`${COMPLETED_PLANS_RELATIVE_DIR}\` (newest first, max ${plans.length}).`,
    "",
    sections.join("\n\n")
  ].join("\n");
}

function ensureTrailingNewline(input: string): string {
  return input.endsWith("\n") ? input : `${input}\n`;
}

function countLines(content: string): number {
  const normalized = content.replace(/\r\n/g, "\n").trimEnd();
  if (normalized === "") {
    return 0;
  }
  return normalized.split("\n").length;
}

function countChars(content: string): number {
  return content.trimEnd().length;
}
