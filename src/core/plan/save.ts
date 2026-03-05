import { writeFile } from "node:fs/promises";
import path from "node:path";

import { ensureDir, exists, slugify, todayDatePrefix } from "../util/fs.js";

export async function saveGeneratedPlan(cwd: string, planTitle: string, content: string): Promise<string> {
  const plansDir = path.join(cwd, "docs", "plans");
  await ensureDir(plansDir);

  const normalizedTitle = planTitle.replace(/^Plan:\s*/i, "").trim();
  const stem = `${todayDatePrefix()}-${slugify(normalizedTitle || "generated-plan")}`;
  const outPath = await nextAvailablePath(plansDir, stem);

  await writeFile(outPath, content, "utf8");
  return outPath;
}

async function nextAvailablePath(dir: string, stem: string): Promise<string> {
  let index = 0;
  while (true) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const candidate = path.join(dir, `${stem}${suffix}.md`);
    if (!(await exists(candidate))) {
      return candidate;
    }
    index += 1;
  }
}
