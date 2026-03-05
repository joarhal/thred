import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { saveGeneratedPlan } from "../src/core/plan/save.js";
import { todayDatePrefix } from "../src/core/util/fs.js";

describe("plan save", () => {
  it("creates plan files under docs/plans and auto-increments suffix", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "thred-plan-save-"));
    const content = "# Plan: Demo\n\n## Overview\n...";

    const first = await saveGeneratedPlan(tempDir, "Plan: Demo Plan", content);
    const second = await saveGeneratedPlan(tempDir, "Plan: Demo Plan", content);

    expect(first).toMatch(new RegExp(`${todayDatePrefix()}-demo-plan\\.md$`));
    expect(second).toMatch(new RegExp(`${todayDatePrefix()}-demo-plan-2\\.md$`));
    await expect(readFile(first, "utf8")).resolves.toBe(content);
    await expect(readFile(second, "utf8")).resolves.toBe(content);
  });

  it("falls back to generated-plan when title is blank after normalization", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "thred-plan-save-"));
    const generated = await saveGeneratedPlan(tempDir, "Plan:", "# Plan: Generated");
    const unnamed = await saveGeneratedPlan(tempDir, "Plan: !!!", "# Plan: Generated");
    expect(path.basename(generated)).toMatch(new RegExp(`^${todayDatePrefix()}-generated-plan\\.md$`));
    expect(path.basename(unnamed)).toMatch(new RegExp(`^${todayDatePrefix()}-unnamed\\.md$`));
  });
});
