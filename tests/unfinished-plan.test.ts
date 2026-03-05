import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { deletePlanFile, listUnfinishedPlans } from "../src/core/interactive/unfinished-plan.js";
import { exists } from "../src/core/util/fs.js";

describe("unfinished plans", () => {
  it("lists markdown plans and excludes completed ones", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-plans-"));
    const plansDir = path.join(dir, "docs", "plans");
    const completedDir = path.join(plansDir, "completed");

    await mkdir(completedDir, { recursive: true });

    const activePlan = path.join(plansDir, "2026-03-03-active.md");
    const completedPlan = path.join(completedDir, "2026-03-03-done.md");

    await writeFile(activePlan, "# Plan: Active\n", "utf8");
    await writeFile(completedPlan, "# Plan: Done\n", "utf8");

    const plans = await listUnfinishedPlans(dir);

    expect(plans).toHaveLength(1);
    expect(plans[0]?.relativePath).toBe("2026-03-03-active.md");
  });

  it("deletes plan file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-plans-"));
    const filePath = path.join(dir, "plan.md");

    await writeFile(filePath, "# Plan: Remove\n", "utf8");
    expect(await exists(filePath)).toBe(true);

    await deletePlanFile(filePath);

    expect(await exists(filePath)).toBe(false);
  });
});
