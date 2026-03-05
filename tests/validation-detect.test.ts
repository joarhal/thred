import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { detectValidationCommands } from "../src/core/plan/validation-detect.js";

describe("validation command detection", () => {
  it("detects test, coverage, and build scripts in deterministic order", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-validate-"));
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        scripts: {
          build: "vite build",
          test: "vitest run",
          "test:coverage": "vitest run --coverage"
        }
      }),
      "utf8"
    );

    const detection = await detectValidationCommands(dir);
    expect(detection).toEqual({
      commands: ["npm test", "npm run test:coverage", "npm run build"],
      diagnostics: []
    });
  });

  it("falls back to lint when test/build are absent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-validate-"));
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint ." } }),
      "utf8"
    );

    const detection = await detectValidationCommands(dir);
    expect(detection).toEqual({
      commands: ["npm run lint"],
      diagnostics: []
    });
  });

  it("uses git status fallback when no package scripts are available", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-validate-"));
    const detection = await detectValidationCommands(dir);
    expect(detection).toEqual({
      commands: ["git status --short"],
      diagnostics: []
    });
  });

  it("uses true fallback in no-git mode when no package scripts are available", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-validate-"));
    const detection = await detectValidationCommands(dir, { isGit: false });
    expect(detection).toEqual({
      commands: ["true"],
      diagnostics: []
    });
  });

  it("emits diagnostics and falls back when package.json contains invalid JSON", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-validate-"));
    await writeFile(path.join(dir, "package.json"), "{ invalid-json", "utf8");

    const detection = await detectValidationCommands(dir);
    expect(detection.commands).toEqual(["git status --short"]);
    expect(detection.diagnostics).toEqual([
      {
        code: "package_json_parse_error",
        message: "validation detection: package.json JSON is invalid, using fallback commands",
        hint: "Fix package.json JSON syntax",
        verboseDetail: `path=${path.join(dir, "package.json")}`
      }
    ]);
  });

  it("emits diagnostics for unreadable and shape-confused package.json variants", async () => {
    const unreadableDir = await mkdtemp(path.join(os.tmpdir(), "thred-validate-"));
    await mkdir(path.join(unreadableDir, "package.json"));
    const unreadableDetection = await detectValidationCommands(unreadableDir);
    expect(unreadableDetection.commands).toEqual(["git status --short"]);
    expect(unreadableDetection.diagnostics[0]).toEqual({
      code: "package_json_read_error",
      message: "validation detection: cannot read package.json, using fallback commands",
      hint: "Ensure package.json exists and is readable",
      verboseDetail: expect.stringContaining(`path=${path.join(unreadableDir, "package.json")}; errorCode=`)
    });

    const invalidScriptsDir = await mkdtemp(path.join(os.tmpdir(), "thred-validate-"));
    await writeFile(
      path.join(invalidScriptsDir, "package.json"),
      JSON.stringify({ scripts: "npm test" }),
      "utf8"
    );
    const invalidScriptsDetection = await detectValidationCommands(invalidScriptsDir);
    expect(invalidScriptsDetection.commands).toEqual(["git status --short"]);
    expect(invalidScriptsDetection.diagnostics).toEqual([
      {
        code: "package_json_invalid_scripts",
        message: "validation detection: package.json scripts are invalid, using fallback commands",
        hint: "Set package.json scripts to an object map to restore npm command detection",
        verboseDetail: "packageJson.scripts type=string"
      }
    ]);

    const invalidRootDir = await mkdtemp(path.join(os.tmpdir(), "thred-validate-"));
    await writeFile(path.join(invalidRootDir, "package.json"), JSON.stringify("not-an-object"), "utf8");
    const invalidRootDetection = await detectValidationCommands(invalidRootDir, { isGit: false });
    expect(invalidRootDetection).toEqual({
      commands: ["true"],
      diagnostics: [
        {
          code: "package_json_invalid_shape",
          message: "validation detection: package.json root is invalid, using fallback commands",
          hint: "Ensure package.json root is a JSON object",
          verboseDetail: `path=${path.join(invalidRootDir, "package.json")}; rootType=string`
        }
      ]
    });
  });
});
