import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ensureThredWorkspace,
  relocateKnownProjectArtifacts,
  resetArtifacts
} from "../src/core/artifacts/manager.js";
import { exists } from "../src/core/util/fs.js";

describe("artifacts manager", () => {
  it("tracks only runtime artifact ignore rules in .gitignore", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-artifacts-"));
    await writeFile(path.join(dir, ".gitignore"), "node_modules/\n", "utf8");

    await ensureThredWorkspace(dir);
    await ensureThredWorkspace(dir);

    const content = await readFile(path.join(dir, ".gitignore"), "utf8");
    const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    expect(lines.filter((line) => line === ".thred/")).toHaveLength(0);
    expect(lines.filter((line) => line === ".thred/artifacts/")).toHaveLength(1);
    expect(lines.filter((line) => line === ".thred/runs/")).toHaveLength(1);
  });

  it("removes legacy .thred/ ignore entry during workspace ensure", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-artifacts-"));
    await writeFile(path.join(dir, ".gitignore"), "node_modules/\n.thred/\n", "utf8");

    await ensureThredWorkspace(dir);

    const content = await readFile(path.join(dir, ".gitignore"), "utf8");
    const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    expect(lines).not.toContain(".thred/");
    expect(lines).toContain(".thred/artifacts/");
    expect(lines).toContain(".thred/runs/");
  });

  it("does not touch .gitignore when updateGitignore is disabled", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-artifacts-"));
    await writeFile(path.join(dir, ".gitignore"), "node_modules/\n", "utf8");

    await ensureThredWorkspace(dir, { updateGitignore: false });

    const content = await readFile(path.join(dir, ".gitignore"), "utf8");
    expect(content).toBe("node_modules/\n");
    expect(await exists(path.join(dir, ".thred", "artifacts"))).toBe(true);
  });

  it("relocates known project artifacts into .thred/artifacts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-artifacts-"));
    const source = path.join(dir, "test-results", "run-1", "error-context.md");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "artifact\n", "utf8");

    await ensureThredWorkspace(dir);
    const moved = await relocateKnownProjectArtifacts(dir);

    expect(moved.some((item) => item.sourceRelativePath === "test-results")).toBe(true);
    expect(await exists(path.join(dir, "test-results"))).toBe(false);
    expect(moved.some((item) => item.targetRelativePath === ".thred/artifacts/test-results")).toBe(true);
  });

  it("uses deterministic incrementing suffixes for repeated relocations", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-artifacts-"));
    const firstSource = path.join(dir, "test-results", "run-1", "error-context.md");
    await mkdir(path.dirname(firstSource), { recursive: true });
    await writeFile(firstSource, "artifact 1\n", "utf8");

    await ensureThredWorkspace(dir);
    const firstMoved = await relocateKnownProjectArtifacts(dir);
    expect(firstMoved[0]?.targetRelativePath).toBe(".thred/artifacts/test-results");

    const secondSource = path.join(dir, "test-results", "run-2", "error-context.md");
    await mkdir(path.dirname(secondSource), { recursive: true });
    await writeFile(secondSource, "artifact 2\n", "utf8");

    const secondMoved = await relocateKnownProjectArtifacts(dir);
    expect(secondMoved[0]?.targetRelativePath).toBe(".thred/artifacts/test-results-001");
  });

  it("clears artifacts directory on reset", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-artifacts-"));
    const artifact = path.join(dir, ".thred", "artifacts", "tmp", "data.txt");
    await mkdir(path.dirname(artifact), { recursive: true });
    await writeFile(artifact, "data\n", "utf8");

    await resetArtifacts(dir);

    expect(await exists(path.join(dir, ".thred", "artifacts"))).toBe(true);
    expect(await exists(artifact)).toBe(false);
  });
});
