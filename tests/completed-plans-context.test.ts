import { mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadCompletedPlansContext } from "../src/core/context/completed-plans.js";

describe("completed plans context loader", () => {
  it("returns empty context when completed plans directory is missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-completed-context-"));
    const snapshot = await loadCompletedPlansContext(dir);

    expect(snapshot.planCount).toBe(0);
    expect(snapshot.content).toContain("No completed plans found");
  });

  it("loads up to 5 most recently modified completed plans", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-completed-context-"));
    const completedDir = path.join(dir, "docs", "plans", "completed");
    await mkdir(completedDir, { recursive: true });

    for (let i = 1; i <= 6; i += 1) {
      const filePath = path.join(completedDir, `2026-03-0${i}-demo-${i}.md`);
      await writeFile(filePath, `# Plan: Demo ${i}\n\n## Overview\nPlan ${i}\n`, "utf8");
      const at = new Date(Date.UTC(2026, 2, i, 12, 0, 0));
      await utimes(filePath, at, at);
    }

    const snapshot = await loadCompletedPlansContext(dir);

    expect(snapshot.planCount).toBe(5);
    expect(snapshot.content).toContain("2026-03-06-demo-6.md");
    expect(snapshot.content).toContain("2026-03-02-demo-2.md");
    expect(snapshot.content).not.toContain("2026-03-01-demo-1.md");
    expect(snapshot.content.indexOf("2026-03-06-demo-6.md")).toBeLessThan(
      snapshot.content.indexOf("2026-03-05-demo-5.md")
    );
  });
});
