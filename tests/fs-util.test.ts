import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureDir, exists, repoRelative, slugify, todayDatePrefix } from "../src/core/util/fs.js";

describe("fs utils", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates directories recursively and checks path existence", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "thred-fs-util-"));
    const nested = path.join(base, "a", "b", "c");
    const filePath = path.join(nested, "demo.txt");

    expect(await exists(filePath)).toBe(false);
    await ensureDir(nested);
    await writeFile(filePath, "ok", "utf8");
    expect(await exists(filePath)).toBe(true);
  });

  it("slugifies mixed input into a deterministic file-safe stem", () => {
    expect(slugify("  Demo PLAN!!! with   Spaces  ")).toBe("demo-plan-with-spaces");
    expect(slugify("----")).toBe("unnamed");
    expect(slugify("A".repeat(300))).toHaveLength(64);
  });

  it("formats local date prefix in YYYY-MM-DD", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-04T08:15:00.000Z"));
    expect(todayDatePrefix()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("renders repository-relative path and '.' for cwd itself", () => {
    expect(repoRelative("/repo/project", "/repo/project")).toBe(".");
    expect(repoRelative("/repo/project", "/repo/project/docs/plans/a.md")).toBe(path.join("docs", "plans", "a.md"));
  });
});
