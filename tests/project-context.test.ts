import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildProjectContextSnapshot } from "../src/core/plan/project-context.js";

describe("project context snapshot", () => {
  it("captures key files and likely entrypoints", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-project-context-"));
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "package.json"), '{"name":"demo"}\n', "utf8");
    await writeFile(path.join(cwd, "src", "main.tsx"), "export {};\n", "utf8");
    await writeFile(path.join(cwd, "src", "App.tsx"), "export {};\n", "utf8");

    const snapshot = await buildProjectContextSnapshot(cwd);

    expect(snapshot.summary).toContain("Repository context snapshot");
    expect(snapshot.summary).toContain("Likely entrypoints:");
    expect(snapshot.summary).toContain("src/main.tsx");
    expect(snapshot.summary).toContain("package.json");
  });
});

