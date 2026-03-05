import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveInput } from "../src/core/input/resolve.js";

describe("input resolver", () => {
  it("resolves existing file input", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-input-"));
    const filePath = path.join(dir, "concept.md");
    await writeFile(filePath, "build auth flow", "utf8");

    const resolved = await resolveInput(filePath, dir);

    expect(resolved.mode).toBe("file");
    expect(resolved.sourceText).toBe("build auth flow");
    expect(resolved.sourcePath).toBe(filePath);
  });

  it("resolves missing path as inline text", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-input-"));

    const resolved = await resolveInput("some rough requirement", dir);

    expect(resolved.mode).toBe("text");
    expect(resolved.sourceText).toBe("some rough requirement");
    expect(resolved.sourcePath).toBeUndefined();
  });

  it("treats slash-containing requirement text as inline input", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-input-"));

    const resolved = await resolveInput("Add /api/v1/users route and update docs", dir);

    expect(resolved.mode).toBe("text");
    expect(resolved.sourceText).toBe("Add /api/v1/users route and update docs");
  });

  it("treats backslash-containing requirement text as inline input", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-input-"));

    const resolved = await resolveInput("Document escaping with \\\\ in examples", dir);

    expect(resolved.mode).toBe("text");
    expect(resolved.sourceText).toBe("Document escaping with \\\\ in examples");
  });

  it("throws when a missing path-like input has an extension", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-input-"));

    await expect(resolveInput("CONCEPT.md", dir)).rejects.toThrow("input file not found: CONCEPT.md");
  });

  it("throws when a missing path-like input is absolute", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-input-"));
    const absMissing = path.join(dir, "missing-input.txt");

    await expect(resolveInput(absMissing, dir)).rejects.toThrow(`input file not found: ${absMissing}`);
  });

  it("throws when a missing path-like input is explicitly relative", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-input-"));

    await expect(resolveInput("./concept", dir)).rejects.toThrow("input file not found: ./concept");
  });

  it("throws on empty input", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-input-"));

    await expect(resolveInput("   ", dir)).rejects.toThrow("input is required");
  });

  it("throws when input path exists but is a directory", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-input-"));
    const folderPath = path.join(dir, "folder");
    await mkdir(folderPath, { recursive: true });

    await expect(resolveInput(folderPath, dir)).rejects.toThrow("input path exists but is not a file");
  });

  it("throws when input file is empty", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-input-"));
    const filePath = path.join(dir, "empty.txt");
    await writeFile(filePath, "  \n", "utf8");

    await expect(resolveInput(filePath, dir)).rejects.toThrow("input file is empty");
  });
});
