import path from "node:path";
import { chmod, cp, mkdtemp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { executeExistingPlan } from "../src/commands/execute.js";
import { detectValidationCommands } from "../src/core/plan/validation-detect.js";
import { runCommand } from "../src/core/util/process.js";

describe("node smoke app integration", () => {
  const fixtureCwd = path.resolve("test-projects/node-smoke-app");
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  const originalMode = process.env.THRED_TEST_CODEX_MODE;

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalMode === undefined) {
      delete process.env.THRED_TEST_CODEX_MODE;
    } else {
      process.env.THRED_TEST_CODEX_MODE = originalMode;
    }
  });

  it("detects validation command from fixture package scripts", async () => {
    const detection = await detectValidationCommands(fixtureCwd);
    expect(detection).toEqual({
      commands: ["npm test"],
      diagnostics: []
    });
  });

  it("executes fixture validation command successfully", async () => {
    const result = await runCommand("npm", ["test"], {
      cwd: fixtureCwd,
      timeoutMs: 30_000
    });

    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).toContain("sum adds numbers");
  });

  it("completes full execute run, moves plan to completed, and writes run artifacts", async () => {
    const cwd = await createSmokeWorkspace();
    await writeLocalSettings(cwd, 1);
    const codexBinDir = await writeFakeCodex(cwd);

    process.chdir(cwd);
    process.env.PATH = `${codexBinDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.THRED_TEST_CODEX_MODE = "success";

    await executeExistingPlan("docs/plans/2026-03-03-add-multiply.md", {
      waitOnLimit: "5s",
      noGit: true,
      noColor: true,
      verbose: false,
      sandbox: "danger-full-access"
    });

    const movedPlanPath = path.join(cwd, "docs", "plans", "completed", "2026-03-03-add-multiply.md");
    const originalPlanPath = path.join(cwd, "docs", "plans", "2026-03-03-add-multiply.md");
    expect(await pathExists(movedPlanPath)).toBe(true);
    expect(await pathExists(originalPlanPath)).toBe(false);

    const artifacts = await readRunArtifacts(cwd);
    expect(await pathExists(artifacts.logPath)).toBe(true);
    expect(await pathExists(artifacts.eventsPath)).toBe(true);
    expect(await pathExists(artifacts.statePath)).toBe(true);
    expect(await pathExists(artifacts.reviewPath)).toBe(true);

    const state = JSON.parse(await readFile(artifacts.statePath, "utf8")) as {
      status: string;
      phase: string;
      review?: { status: string };
    };
    expect(state.status).toBe("completed");
    expect(state.phase).toBe("finalize");
    expect(state.review?.status).toBe("clean");

    const report = JSON.parse(await readFile(artifacts.reviewPath, "utf8")) as {
      status: string;
      findings: unknown[];
    };
    expect(report.status).toBe("clean");
    expect(report.findings).toHaveLength(0);
  });

  it("fails execution and preserves plan when final review keeps blocking findings", async () => {
    const cwd = await createSmokeWorkspace();
    await writeLocalSettings(cwd, 0);
    const codexBinDir = await writeFakeCodex(cwd);

    process.chdir(cwd);
    process.env.PATH = `${codexBinDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.THRED_TEST_CODEX_MODE = "review-fail";

    await expect(
      executeExistingPlan("docs/plans/2026-03-03-add-multiply.md", {
        waitOnLimit: "5s",
        noGit: true,
        noColor: true,
        verbose: false,
        sandbox: "danger-full-access"
      })
    ).rejects.toThrow(/final review still has findings/i);

    const completedPlanPath = path.join(cwd, "docs", "plans", "completed", "2026-03-03-add-multiply.md");
    const originalPlanPath = path.join(cwd, "docs", "plans", "2026-03-03-add-multiply.md");
    expect(await pathExists(completedPlanPath)).toBe(false);
    expect(await pathExists(originalPlanPath)).toBe(true);

    const artifacts = await readRunArtifacts(cwd);
    const state = JSON.parse(await readFile(artifacts.statePath, "utf8")) as {
      status: string;
      phase: string;
      review?: { status: string };
      error?: string;
    };
    expect(state.status).toBe("failed");
    expect(state.phase).toBe("review");
    expect(state.review?.status).toBe("failed");
    expect(state.error).toMatch(/final review still has findings/i);

    const report = JSON.parse(await readFile(artifacts.reviewPath, "utf8")) as {
      status: string;
      findings: Array<{ severity: string; summary: string }>;
    };
    expect(report.status).toBe("failed");
    expect(report.findings.some((finding) => finding.severity === "high")).toBe(true);
    expect(report.findings.some((finding) => /forced review failure/i.test(finding.summary))).toBe(true);
  });
});

async function createSmokeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "thred-node-smoke-"));
  const workspace = path.join(root, "node-smoke-app");
  await mkdir(workspace, { recursive: true });

  await cp(path.join("test-projects", "node-smoke-app", "src"), path.join(workspace, "src"), { recursive: true });
  await cp(path.join("test-projects", "node-smoke-app", "test"), path.join(workspace, "test"), { recursive: true });
  await cp(path.join("test-projects", "node-smoke-app", "docs"), path.join(workspace, "docs"), { recursive: true });
  await cp(path.join("test-projects", "node-smoke-app", "package.json"), path.join(workspace, "package.json"));
  await cp(path.join("test-projects", "node-smoke-app", "package-lock.json"), path.join(workspace, "package-lock.json"));

  return workspace;
}

async function writeLocalSettings(cwd: string, reviewFixIterations: number): Promise<void> {
  const settingsPath = path.join(cwd, ".thred", "settings.yaml");
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(
    settingsPath,
    [
      "model: inherit",
      "reasoningEffort: high",
      "reviewPipeline:",
      "  version: 1",
      "  passes:",
      "    baseline_all_findings:",
      "      kind: scan",
      "      severities: [critical, high, medium, low]",
      "    stabilize_critical_high:",
      "      kind: fix_loop",
      "      severities: [critical, high]",
      `      maxIterations: ${reviewFixIterations}`,
      "      patience: 0",
      "    final_all_findings_verification:",
      "      kind: scan",
      "      severities: [critical, high, medium, low]",
      ""
    ].join("\n"),
    "utf8"
  );
}

async function writeFakeCodex(cwd: string): Promise<string> {
  const binDir = path.join(cwd, ".fake-bin");
  await mkdir(binDir, { recursive: true });
  const codexPath = path.join(binDir, "codex");
  await writeFile(
    codexPath,
    [
      "#!/usr/bin/env node",
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "",
      "const prompt = process.argv.at(-1) ?? '';",
      "const mode = process.env.THRED_TEST_CODEX_MODE ?? 'success';",
      "const statePath = path.join(process.cwd(), '.codex-state.json');",
      "let state = { reviewPromptCount: 0 };",
      "if (existsSync(statePath)) {",
      "  try {",
      "    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));",
      "    if (typeof parsed.reviewPromptCount === 'number') {",
      "      state.reviewPromptCount = parsed.reviewPromptCount;",
      "    }",
      "  } catch {",
      "    state = { reviewPromptCount: 0 };",
      "  }",
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
      "  console.log('OPERATION: Implement multiply helper');",
      "  console.log('Added multiply implementation and tests.');",
      "} else if (prompt.includes('Apply fixes for the following review findings.')) {",
      "  console.log('OPERATION: Resolve review findings');",
      "  console.log('Applied fixes for review findings.');",
      "} else if (prompt.includes('Run a comprehensive code review')) {",
      "  state.reviewPromptCount += 1;",
      "  if (mode === 'success' && state.reviewPromptCount >= 2) {",
      "    process.stdout.write(JSON.stringify({ overallStatus: 'clean', findings: [] }));",
      "  } else {",
      "    process.stdout.write(JSON.stringify({",
      "      overallStatus: 'issues_found',",
      "      findings: [{",
      "        id: 'smoke-high-1',",
      "        severity: 'high',",
      "        file: 'src/math.js',",
      "        line: 1,",
      "        summary: 'Forced review failure in smoke integration',",
      "        rationale: 'Intentional blocker for integration test coverage'",
      "      }]",
      "    }));",
      "  }",
      "} else {",
      "  console.log('OPERATION: noop');",
      "  console.log('No branch matched for codex stub prompt.');",
      "}",
      "",
      "writeFileSync(statePath, JSON.stringify(state), 'utf8');",
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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
