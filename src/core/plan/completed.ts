import path from "node:path";
import { rename } from "node:fs/promises";

import { ensureDir } from "../util/fs.js";

export async function movePlanToCompletedLocal(cwd: string, planPath: string): Promise<string> {
  const relPlan = path.relative(cwd, planPath);
  const completedRel = path.join(path.dirname(relPlan), "completed", path.basename(relPlan));
  const completedAbs = path.join(cwd, completedRel);

  await ensureDir(path.dirname(completedAbs));
  await rename(path.join(cwd, relPlan), completedAbs);
  return completedAbs;
}
