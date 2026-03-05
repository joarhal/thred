import path from "node:path";
import os from "node:os";
import { chmod, mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { runCommand } from "../src/core/util/process.js";

interface PackedFile {
  path: string;
}

interface NpmPackEntry {
  filename: string;
  files: PackedFile[];
}

describe("release npm artifact", () => {
  const repoRoot = path.resolve(".");
  const originalPath = process.env.PATH;

  afterEach(() => {
    if (originalPath === undefined) {
      delete process.env.PATH;
      return;
    }
    process.env.PATH = originalPath;
  });

  it(
    "builds, packs, validates tarball contents, installs it, and runs CLI help",
    async () => {
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), "thred-release-pack-"));
      const packDestination = path.join(tempRoot, "pack");
      const installDir = path.join(tempRoot, "install");
      await mkdir(packDestination, { recursive: true });
      await mkdir(installDir, { recursive: true });

      const buildResult = await runCommand("npm", ["run", "build"], {
        cwd: repoRoot,
        timeoutMs: 180_000
      });
      expect(buildResult.code).toBe(0);

      const packResult = await runCommand("npm", ["pack", "--json", "--pack-destination", packDestination], {
        cwd: repoRoot,
        timeoutMs: 120_000
      });
      expect(packResult.code).toBe(0);

      const packed = parseNpmPackOutput(packResult.stdout);
      const tarballPath = path.join(packDestination, packed.filename);
      await expect(stat(tarballPath)).resolves.toBeDefined();

      const packedPaths = packed.files.map((entry) => entry.path);
      expect(packedPaths).toEqual(
        expect.arrayContaining(["package.json", "README.md", "LICENSE", "CHANGELOG.md", "dist/cli.js"])
      );
      expect(packedPaths.some((entry) => entry.startsWith("dist/prompts/review-agents/"))).toBe(true);
      expect(packedPaths.some((entry) => entry.startsWith("src/"))).toBe(false);
      expect(packedPaths.some((entry) => entry.startsWith("tests/"))).toBe(false);

      const npmInitResult = await runCommand("npm", ["init", "-y"], {
        cwd: installDir,
        timeoutMs: 30_000
      });
      expect(npmInitResult.code).toBe(0);

      const installResult = await runCommand(
        "npm",
        ["install", "--no-save", "--ignore-scripts", "--audit=false", "--fund=false", tarballPath],
        {
          cwd: installDir,
          timeoutMs: 180_000
        }
      );
      expect(installResult.code).toBe(0);

      const thredBin =
        process.platform === "win32"
          ? path.join(installDir, "node_modules", ".bin", "thred.cmd")
          : path.join(installDir, "node_modules", ".bin", "thred");
      await expect(stat(thredBin)).resolves.toBeDefined();

      const helpResult = await runCommand(thredBin, ["--help"], {
        cwd: installDir,
        timeoutMs: 30_000
      });
      expect(helpResult.code).toBe(0);
      const helpOutput = `${helpResult.stdout}\n${helpResult.stderr}`;
      expect(helpOutput).toContain("Usage:");
      expect(helpOutput).toContain("thred");
    },
    240_000
  );

  it(
    "runs tarball-installed non-interactive smoke flow in node-smoke-app and verifies plan/artifacts",
    async () => {
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), "thred-release-smoke-"));
      const packDestination = path.join(tempRoot, "pack");
      await mkdir(packDestination, { recursive: true });

      const buildResult = await runCommand("npm", ["run", "build"], {
        cwd: repoRoot,
        timeoutMs: 180_000
      });
      expect(buildResult.code).toBe(0);

      const packResult = await runCommand("npm", ["pack", "--json", "--pack-destination", packDestination], {
        cwd: repoRoot,
        timeoutMs: 120_000
      });
      expect(packResult.code).toBe(0);

      const packed = parseNpmPackOutput(packResult.stdout);
      const tarballPath = path.join(packDestination, packed.filename);
      await expect(stat(tarballPath)).resolves.toBeDefined();

      const smokeCwd = await createSmokeWorkspace(tempRoot);

      const installResult = await runCommand(
        "npm",
        [
          "install",
          "--no-save",
          "--no-package-lock",
          "--ignore-scripts",
          "--audit=false",
          "--fund=false",
          tarballPath
        ],
        {
          cwd: smokeCwd,
          timeoutMs: 180_000
        }
      );
      expect(installResult.code).toBe(0);

      const thredBin =
        process.platform === "win32"
          ? path.join(smokeCwd, "node_modules", ".bin", "thred.cmd")
          : path.join(smokeCwd, "node_modules", ".bin", "thred");
      await expect(stat(thredBin)).resolves.toBeDefined();

      const codexBinDir = await writeSmokeCodex(smokeCwd);
      process.env.PATH = `${codexBinDir}${path.delimiter}${originalPath ?? ""}`;

      const smokeResult = await runCommand(
        thredBin,
        [
          "add multiply function in src/math.js and tests in test/math.test.js",
          "--non-interactive",
          "--no-git",
          "--wait-on-limit",
          "5s",
          "--no-color"
        ],
        {
          cwd: smokeCwd,
          timeoutMs: 300_000
        }
      );
      expect(smokeResult.code, `${smokeResult.stdout}\n${smokeResult.stderr}`).toBe(0);

      const testResult = await runCommand("npm", ["test"], {
        cwd: smokeCwd,
        timeoutMs: 60_000
      });
      expect(testResult.code).toBe(0);
      expect(`${testResult.stdout}\n${testResult.stderr}`).toContain("multiply multiplies numbers");

      const artifacts = await readRunArtifacts(smokeCwd);
      await expect(stat(artifacts.logPath)).resolves.toBeDefined();
      await expect(stat(artifacts.eventsPath)).resolves.toBeDefined();
      await expect(stat(artifacts.statePath)).resolves.toBeDefined();
      await expect(stat(artifacts.reviewPath)).resolves.toBeDefined();

      const state = JSON.parse(await readFile(artifacts.statePath, "utf8")) as {
        status: string;
        phase: string;
      };
      expect(state.status).toBe("completed");
      expect(state.phase).toBe("finalize");

      const completedPlansDir = path.join(smokeCwd, "docs", "plans", "completed");
      const completedPlans = (await readdir(completedPlansDir)).filter((entry) => entry.endsWith(".md"));
      expect(completedPlans.length).toBeGreaterThan(0);
    },
    420_000
  );

  it("keeps release metadata in package.json aligned with npm publication", async () => {
    const packageJsonPath = path.join(repoRoot, "package.json");
    const rawPackageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown;
    expect(isRecord(rawPackageJson)).toBe(true);
    if (!isRecord(rawPackageJson)) {
      return;
    }
    expect(rawPackageJson.name).toBe("@joarhal/thred");

    const binField = rawPackageJson.bin;
    expect(isRecord(binField)).toBe(true);
    if (!isRecord(binField)) {
      return;
    }
    expect(binField.thred).toBe("dist/cli.js");

    const filesField = rawPackageJson.files;
    expect(Array.isArray(filesField)).toBe(true);
    if (!Array.isArray(filesField)) {
      return;
    }
    const publishedFiles = filesField.filter((value): value is string => typeof value === "string");
    expect(publishedFiles).toEqual(expect.arrayContaining(["dist", "README.md", "LICENSE", "CHANGELOG.md"]));
    expect(coversPublishedPath("dist/cli.js", publishedFiles)).toBe(true);

    const canonicalRepoHttpUrl = "https://github.com/joarhal/thred";

    const repositoryField = rawPackageJson.repository;
    expect(isRecord(repositoryField)).toBe(true);
    if (isRecord(repositoryField)) {
      expect(repositoryField.type).toBe("git");
      expect(repositoryField.url).toBe(`git+${canonicalRepoHttpUrl}.git`);
    }

    const bugsField = rawPackageJson.bugs;
    expect(isRecord(bugsField)).toBe(true);
    if (isRecord(bugsField)) {
      expect(bugsField.url).toBe(`${canonicalRepoHttpUrl}/issues`);
    }

    expect(rawPackageJson.homepage).toBe(`${canonicalRepoHttpUrl}#readme`);
    expect(rawPackageJson.license).toBe("MIT");

    const enginesField = rawPackageJson.engines;
    expect(isRecord(enginesField)).toBe(true);
    if (isRecord(enginesField)) {
      expect(typeof enginesField.node).toBe("string");
      expect(String(enginesField.node)).toMatch(/^>=20(\.\d+\.\d+)?$/);
    }
  });
});

function parseNpmPackOutput(stdout: string): NpmPackEntry {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new Error("npm pack did not return JSON output");
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("npm pack JSON output is empty");
  }

  const first = parsed[0];
  if (!isRecord(first) || typeof first.filename !== "string" || first.filename.length === 0) {
    throw new Error("npm pack JSON output does not contain filename");
  }

  const rawFiles = Array.isArray(first.files) ? first.files : [];
  const files = rawFiles.filter((item): item is PackedFile => isRecord(item) && typeof item.path === "string");

  return {
    filename: first.filename,
    files
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function coversPublishedPath(targetPath: string, publishedPaths: string[]): boolean {
  return publishedPaths.some((entry) => {
    const normalizedEntry = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    return targetPath === normalizedEntry || targetPath.startsWith(`${normalizedEntry}/`);
  });
}

async function createSmokeWorkspace(tempRoot: string): Promise<string> {
  const workspace = path.join(tempRoot, "node-smoke-app");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(path.join(workspace, "test"), { recursive: true });
  await mkdir(path.join(workspace, "docs", "plans"), { recursive: true });

  await writeFile(
    path.join(workspace, "src", "math.js"),
    ["export function sum(a, b) {", "  return a + b;", "}", ""].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "test", "math.test.js"),
    [
      "import assert from 'node:assert/strict';",
      "import { test } from 'node:test';",
      "import { sum } from '../src/math.js';",
      "",
      "test('sum adds numbers', () => {",
      "  assert.equal(sum(2, 3), 5);",
      "});",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "package.json"),
    JSON.stringify(
      {
        name: "node-smoke-app",
        version: "0.0.0",
        type: "module",
        private: true,
        scripts: {
          test: "node --test"
        }
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  await writeFile(path.join(workspace, ".gitignore"), "node_modules\n.thred\n.fake-bin\n.codex-state.json\n", "utf8");

  return workspace;
}

async function writeSmokeCodex(cwd: string): Promise<string> {
  const binDir = path.join(cwd, ".fake-bin");
  await mkdir(binDir, { recursive: true });
  const codexPath = path.join(binDir, "codex");
  await writeFile(
    codexPath,
    [
      "#!/usr/bin/env node",
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "",
      "const prompt = process.argv.at(-1) ?? '';",
      "",
      "if (prompt.includes('Create an execution plan in strict markdown format.') || prompt.includes('Your previous plan output is invalid and must be fully regenerated.')) {",
      "  process.stdout.write([",
      "    '# Plan: Add Multiply Function',",
      "    '',",
      "    '## Overview',",
      "    'Add multiply support to src/math.js and validate it in test/math.test.js.',",
      "    'This smoke plan keeps execution focused to one task and npm test validation.',",
      "    '',",
      "    '## Validation Commands',",
      "    '- `npm test`',",
      "    '',",
      "    '### Task 1: Implement multiply support',",
      "    '- [ ] Add multiply export in src/math.js.',",
      "    '- [ ] Extend test/math.test.js with multiply coverage.',",
      "    '- [ ] run project tests - must pass before next task',",
      "    ''",
      "  ].join('\\n'));",
      "  process.exit(0);",
      "}",
      "",
      "if (prompt.includes('You are a critical plan reviewer for an AI coding agent workflow.')) {",
      "  process.stdout.write(JSON.stringify({",
      "    status: 'approved',",
      "    summary: 'Plan is executable and anchored to repository files.',",
      "    issues: [],",
      "    revisedPlanMarkdown: ''",
      "  }));",
      "  process.exit(0);",
      "}",
      "",
      "if (prompt.includes('You are implementing a single plan task.')) {",
      "  const mathPath = path.join(process.cwd(), 'src', 'math.js');",
      "  const testPath = path.join(process.cwd(), 'test', 'math.test.js');",
      "  let math = readFileSync(mathPath, 'utf8');",
      "  if (!math.includes('export function multiply')) {",
      "    math = `${math.trimEnd()}\\n\\nexport function multiply(a, b) {\\n  return a * b;\\n}\\n`;",
      "    writeFileSync(mathPath, math, 'utf8');",
      "  }",
      "  let tests = readFileSync(testPath, 'utf8');",
      "  if (!tests.includes('multiply multiplies numbers')) {",
      "    tests = tests.replace(\"import { sum } from '../src/math.js';\", \"import { multiply, sum } from '../src/math.js';\");",
      "    tests = `${tests.trimEnd()}\\n\\ntest('multiply multiplies numbers', () => {\\n  assert.equal(multiply(2, 3), 6);\\n});\\n`;",
      "    writeFileSync(testPath, tests, 'utf8');",
      "  }",
      "  process.stdout.write('OPERATION: Implement multiply helper\\nAdded multiply implementation and tests.\\n');",
      "  process.exit(0);",
      "}",
      "",
      "if (prompt.includes('Run a comprehensive code review')) {",
      "  process.stdout.write(JSON.stringify({ overallStatus: 'clean', findings: [] }));",
      "  process.exit(0);",
      "}",
      "",
      "if (prompt.includes('Apply fixes for the following review findings.')) {",
      "  process.stdout.write('OPERATION: Resolve review findings\\nNo fixes were needed.\\n');",
      "  process.exit(0);",
      "}",
      "",
      "process.stdout.write('OPERATION: noop\\nNo branch matched for codex stub prompt.\\n');",
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(codexPath, 0o755);
  return binDir;
}

async function readRunArtifacts(cwd: string): Promise<{
  runId: string;
  logPath: string;
  eventsPath: string;
  statePath: string;
  reviewPath: string;
}> {
  const runDir = path.join(cwd, ".thred", "artifacts", "runs");
  const entries = await readdir(runDir);
  const stateFile = entries.find((entry) => entry.endsWith(".json") && !entry.endsWith(".review.json"));
  if (!stateFile) {
    throw new Error(`run-state file not found in ${runDir}`);
  }

  const runId = stateFile.slice(0, -".json".length);
  return {
    runId,
    logPath: path.join(runDir, `${runId}.log`),
    eventsPath: path.join(runDir, `${runId}.events.jsonl`),
    statePath: path.join(runDir, `${runId}.json`),
    reviewPath: path.join(runDir, `${runId}.review.json`)
  };
}
