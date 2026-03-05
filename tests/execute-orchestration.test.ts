import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  resetArtifacts: vi.fn(),
  getArtifactsRunsDir: vi.fn(),
  ensureThredWorkspace: vi.fn(),
  prepareExecutionBootstrap: vi.fn(),
  executePlan: vi.fn(),
  runInteractiveEntry: vi.fn(),
  resolveInput: vi.fn(),
  loadCompletedPlansContext: vi.fn(),
  loadThredSettings: vi.fn(),
  saveThredSettings: vi.fn(),
  detectValidationCommands: vi.fn(),
  buildProjectContextSnapshot: vi.fn(),
  generatePlanFromFreeform: vi.fn(),
  reviewGeneratedPlan: vi.fn(),
  saveGeneratedPlan: vi.fn(),
  loggerCreate: vi.fn(),
  loggerClose: vi.fn()
}));

vi.mock("../src/core/artifacts/manager.js", () => ({
  resetArtifacts: mocked.resetArtifacts,
  getArtifactsRunsDir: mocked.getArtifactsRunsDir,
  ensureThredWorkspace: mocked.ensureThredWorkspace
}));

vi.mock("../src/core/execute/run-plan.js", () => ({
  prepareExecutionBootstrap: mocked.prepareExecutionBootstrap,
  executePlan: mocked.executePlan
}));

vi.mock("../src/core/interactive/entry.js", () => ({
  runInteractiveEntry: mocked.runInteractiveEntry
}));

vi.mock("../src/core/input/resolve.js", () => ({
  resolveInput: mocked.resolveInput
}));

vi.mock("../src/core/context/completed-plans.js", () => ({
  loadCompletedPlansContext: mocked.loadCompletedPlansContext
}));

vi.mock("../src/core/plan/validation-detect.js", () => ({
  detectValidationCommands: mocked.detectValidationCommands
}));

vi.mock("../src/core/plan/project-context.js", () => ({
  buildProjectContextSnapshot: mocked.buildProjectContextSnapshot
}));

vi.mock("../src/core/plan/generate.js", () => ({
  generatePlanFromFreeform: mocked.generatePlanFromFreeform
}));

vi.mock("../src/core/plan/review.js", () => ({
  reviewGeneratedPlan: mocked.reviewGeneratedPlan
}));

vi.mock("../src/core/plan/save.js", () => ({
  saveGeneratedPlan: mocked.saveGeneratedPlan
}));

vi.mock("../src/core/progress/logger.js", () => ({
  ProgressLogger: {
    create: mocked.loggerCreate
  }
}));

vi.mock("../src/core/settings/service.js", async () => {
  const actual = await vi.importActual<typeof import("../src/core/settings/service.js")>(
    "../src/core/settings/service.js"
  );
  return {
    ...actual,
    loadThredSettings: mocked.loadThredSettings,
    saveThredSettings: mocked.saveThredSettings
  };
});

vi.mock("../src/core/codex/runner.js", () => ({
  CodexRunner: class {}
}));

import { executeExistingPlan, executeFromInput } from "../src/commands/execute.js";
import type { ExecuteCommandArgs, RunCommandArgs } from "../src/commands/execute.js";

describe("execute command orchestration", () => {
  const originalCwd = process.cwd();
  const originalStdinTty = process.stdin.isTTY;
  const originalStdoutTty = process.stdout.isTTY;

  beforeEach(() => {
    vi.clearAllMocks();
    process.chdir(originalCwd);
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;

    mocked.prepareExecutionBootstrap.mockResolvedValue({ cwd: process.cwd(), isGit: true });
    mocked.resetArtifacts.mockResolvedValue(undefined);
    mocked.getArtifactsRunsDir.mockReturnValue("/tmp/thred-runs");
    mocked.ensureThredWorkspace.mockResolvedValue(undefined);
    mocked.loadThredSettings.mockResolvedValue({
      settings: { model: "inherit", reasoningEffort: "high" }
    });
    mocked.loadCompletedPlansContext.mockResolvedValue({
      path: "/tmp/repo/docs/plans/completed",
      content: "memory",
      lineCount: 1,
      charCount: 6,
      planCount: 1
    });
    mocked.resolveInput.mockResolvedValue({
      mode: "text",
      sourceText: "implement feature",
      sourceLabel: "inline-input"
    });
    mocked.runInteractiveEntry.mockResolvedValue(undefined);
    mocked.detectValidationCommands.mockResolvedValue({
      commands: ["npm test"],
      diagnostics: []
    });
    mocked.buildProjectContextSnapshot.mockResolvedValue({ summary: "repo summary" });
    mocked.generatePlanFromFreeform.mockResolvedValue({
      title: "Demo Plan",
      content: "# Plan: Demo\n\n## Overview\n...\n"
    });
    mocked.reviewGeneratedPlan.mockResolvedValue({
      title: "Demo Plan",
      content: "# Plan: Demo\n\n## Overview\n...\n",
      summary: "clean",
      revised: false
    });
    mocked.saveGeneratedPlan.mockResolvedValue("/tmp/repo/docs/plans/2026-03-03-demo-plan.md");
    mocked.executePlan.mockResolvedValue(undefined);
    mocked.loggerCreate.mockResolvedValue({
      phase: vi.fn(async () => {}),
      info: vi.fn(async () => {}),
      debug: vi.fn(async () => {}),
      warn: vi.fn(async () => {}),
      error: vi.fn(async () => {}),
      success: vi.fn(async () => {}),
      close: mocked.loggerClose
    });
    mocked.loggerClose.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.stdin.isTTY = originalStdinTty;
    process.stdout.isTTY = originalStdoutTty;
  });

  it("dispatches to interactive entry when non-interactive mode is disabled", async () => {
    await executeFromInput("write tests", {
      ...defaultArgs(),
      nonInteractive: false
    });

    expect(mocked.runInteractiveEntry).toHaveBeenCalledTimes(1);
    expect(mocked.generatePlanFromFreeform).not.toHaveBeenCalled();
    expect(mocked.executePlan).not.toHaveBeenCalled();
  });

  it("fails interactive mode before bootstrap side effects when TTY is unavailable", async () => {
    process.stdin.isTTY = false;
    process.stdout.isTTY = false;

    await expect(
      executeFromInput("task text", {
        ...defaultArgs(),
        nonInteractive: false
      })
    ).rejects.toThrow("interactive mode requires TTY");

    expect(mocked.prepareExecutionBootstrap).not.toHaveBeenCalled();
    expect(mocked.resetArtifacts).not.toHaveBeenCalled();
    expect(mocked.loadThredSettings).not.toHaveBeenCalled();
    expect(mocked.loadCompletedPlansContext).not.toHaveBeenCalled();
    expect(mocked.runInteractiveEntry).not.toHaveBeenCalled();
  });

  it("fails with a clear error when non-interactive mode is missing input", async () => {
    await expect(
      executeFromInput(undefined, {
        ...defaultArgs(),
        nonInteractive: true
      })
    ).rejects.toThrow("non-interactive mode requires input");

    expect(mocked.runInteractiveEntry).not.toHaveBeenCalled();
    expect(mocked.loggerCreate).not.toHaveBeenCalled();
    expect(mocked.prepareExecutionBootstrap).not.toHaveBeenCalled();
  });

  it("validates wait-on-limit duration before bootstrap side effects", async () => {
    await expect(
      executeFromInput("task text", {
        ...defaultArgs(),
        waitOnLimit: "not-a-duration"
      })
    ).rejects.toThrow("invalid duration");

    expect(mocked.prepareExecutionBootstrap).not.toHaveBeenCalled();
    expect(mocked.resetArtifacts).not.toHaveBeenCalled();
  });

  it("fails before first-run setup side effects when bootstrap fails in execute-from-input flow", async () => {
    const isolatedCwd = await mkdtemp(path.join(os.tmpdir(), "thred-exec-order-"));
    process.chdir(isolatedCwd);
    mocked.prepareExecutionBootstrap.mockRejectedValueOnce(new Error("codex not found in PATH"));

    await expect(
      executeFromInput("task text", {
        ...defaultArgs(),
        nonInteractive: true
      })
    ).rejects.toThrow("codex not found in PATH");

    expect(mocked.prepareExecutionBootstrap).toHaveBeenCalledTimes(1);
    expect(mocked.ensureThredWorkspace).not.toHaveBeenCalled();
    expect(mocked.loadThredSettings).not.toHaveBeenCalled();
    expect(mocked.resetArtifacts).not.toHaveBeenCalled();
  });

  it("fails before first-run setup side effects when bootstrap fails in execute-existing-plan flow", async () => {
    const isolatedCwd = await mkdtemp(path.join(os.tmpdir(), "thred-exec-order-"));
    process.chdir(isolatedCwd);
    mocked.prepareExecutionBootstrap.mockRejectedValueOnce(new Error("codex not found in PATH"));

    await expect(
      executeExistingPlan("docs/plans/2026-03-03-existing.md", {
        ...defaultRunArgs()
      })
    ).rejects.toThrow("codex not found in PATH");

    expect(mocked.prepareExecutionBootstrap).toHaveBeenCalledTimes(1);
    expect(mocked.ensureThredWorkspace).not.toHaveBeenCalled();
    expect(mocked.loadThredSettings).not.toHaveBeenCalled();
    expect(mocked.resetArtifacts).not.toHaveBeenCalled();
  });

  it("runs non-interactive generation, review, save, and execute flow", async () => {
    await executeFromInput("task text", {
      ...defaultArgs(),
      nonInteractive: true,
      waitOnLimit: "45s",
      baseBranch: "main",
      sandbox: "workspace-write",
      verbose: true,
      noColor: true
    });

    expect(mocked.runInteractiveEntry).not.toHaveBeenCalled();
    expect(mocked.detectValidationCommands).toHaveBeenCalledTimes(1);
    expect(mocked.detectValidationCommands).toHaveBeenCalledWith(process.cwd(), { isGit: true });
    expect(mocked.buildProjectContextSnapshot).toHaveBeenCalledTimes(1);
    expect(mocked.generatePlanFromFreeform).toHaveBeenCalledTimes(1);
    expect(mocked.generatePlanFromFreeform).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceText: "implement feature",
        sourceMode: "text",
        sourceLabel: "inline-input",
        validationCommands: ["npm test"],
        projectContext: "repo summary",
        memoryContext: "memory",
        maxRetries: 1
      })
    );
    expect(mocked.reviewGeneratedPlan).toHaveBeenCalledTimes(1);
    expect(mocked.reviewGeneratedPlan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceText: "implement feature",
        sourceMode: "text",
        sourceLabel: "inline-input",
        currentPlan: "# Plan: Demo\n\n## Overview\n...\n",
        validationCommands: ["npm test"],
        projectContext: "repo summary",
        maxRetries: 1,
        cwd: process.cwd()
      })
    );
    expect(mocked.saveGeneratedPlan).toHaveBeenCalledTimes(1);
    expect(mocked.saveGeneratedPlan).toHaveBeenCalledWith(
      process.cwd(),
      "Demo Plan",
      "# Plan: Demo\n\n## Overview\n...\n"
    );
    expect(mocked.executePlan).toHaveBeenCalledTimes(1);
    expect(mocked.executePlan).toHaveBeenCalledWith(
      "/tmp/repo/docs/plans/2026-03-03-demo-plan.md",
      process.cwd(),
      expect.objectContaining({
        planPath: "/tmp/repo/docs/plans/2026-03-03-demo-plan.md",
        baseBranch: "main",
        memoryContext: "memory",
        sandbox: "workspace-write",
        maxTaskRetries: 1,
        maxReviewIterations: 3,
        maxExternalIterations: 4,
        reviewPatience: 2,
        waitOnLimitMs: 45_000,
        bootstrap: { cwd: process.cwd(), isGit: true }
      })
    );
    const detectOrder = mocked.detectValidationCommands.mock.invocationCallOrder[0] ?? 0;
    const generateOrder = mocked.generatePlanFromFreeform.mock.invocationCallOrder[0] ?? 0;
    const reviewOrder = mocked.reviewGeneratedPlan.mock.invocationCallOrder[0] ?? 0;
    const saveOrder = mocked.saveGeneratedPlan.mock.invocationCallOrder[0] ?? 0;
    const executeOrder = mocked.executePlan.mock.invocationCallOrder[0] ?? 0;
    expect(detectOrder).toBeLessThan(generateOrder);
    expect(generateOrder).toBeLessThan(reviewOrder);
    expect(reviewOrder).toBeLessThan(saveOrder);
    expect(saveOrder).toBeLessThan(executeOrder);
    expect(mocked.prepareExecutionBootstrap).toHaveBeenCalledTimes(1);
    expect(mocked.loggerClose).toHaveBeenCalledTimes(1);
  });

  it("closes logger when validation command detection fails in non-interactive flow", async () => {
    mocked.detectValidationCommands.mockRejectedValueOnce(new Error("detect failed"));

    await expect(
      executeFromInput("task text", {
        ...defaultArgs(),
        nonInteractive: true
      })
    ).rejects.toThrow("detect failed");

    expect(mocked.loggerCreate).toHaveBeenCalledTimes(1);
    expect(mocked.loggerClose).toHaveBeenCalledTimes(1);
  });

  it("closes logger when plan generation fails in non-interactive flow", async () => {
    mocked.generatePlanFromFreeform.mockRejectedValueOnce(new Error("generation failed"));

    await expect(
      executeFromInput("task text", {
        ...defaultArgs(),
        nonInteractive: true
      })
    ).rejects.toThrow("generation failed");

    expect(mocked.loggerCreate).toHaveBeenCalledTimes(1);
    expect(mocked.loggerClose).toHaveBeenCalledTimes(1);
  });

  it("closes logger when plan review fails in non-interactive flow", async () => {
    mocked.reviewGeneratedPlan.mockRejectedValueOnce(new Error("review failed"));

    await expect(
      executeFromInput("task text", {
        ...defaultArgs(),
        nonInteractive: true
      })
    ).rejects.toThrow("review failed");

    expect(mocked.loggerCreate).toHaveBeenCalledTimes(1);
    expect(mocked.loggerClose).toHaveBeenCalledTimes(1);
  });

  it("closes logger when plan save fails in non-interactive flow", async () => {
    mocked.saveGeneratedPlan.mockRejectedValueOnce(new Error("save failed"));

    await expect(
      executeFromInput("task text", {
        ...defaultArgs(),
        nonInteractive: true
      })
    ).rejects.toThrow("save failed");

    expect(mocked.loggerCreate).toHaveBeenCalledTimes(1);
    expect(mocked.loggerClose).toHaveBeenCalledTimes(1);
  });

  it("closes logger when execution fails in non-interactive flow", async () => {
    mocked.executePlan.mockRejectedValueOnce(new Error("execution failed"));

    await expect(
      executeFromInput("task text", {
        ...defaultArgs(),
        nonInteractive: true
      })
    ).rejects.toThrow("execution failed");

    expect(mocked.loggerCreate).toHaveBeenCalledTimes(1);
    expect(mocked.loggerClose).toHaveBeenCalledTimes(1);
  });

  it("runs existing plan directly without plan generation flow", async () => {
    await executeExistingPlan("docs/plans/2026-03-03-existing.md", {
      ...defaultRunArgs(),
      waitOnLimit: "45s",
      baseBranch: "main",
      sandbox: "workspace-write",
      verbose: true,
      noColor: true
    });

    expect(mocked.executePlan).toHaveBeenCalledWith(
      "docs/plans/2026-03-03-existing.md",
      process.cwd(),
      expect.objectContaining({
        planPath: "docs/plans/2026-03-03-existing.md",
        baseBranch: "main",
        memoryContext: "memory",
        sandbox: "workspace-write",
        maxTaskRetries: 1,
        maxReviewIterations: 3,
        maxExternalIterations: 4,
        reviewPatience: 2,
        waitOnLimitMs: 45_000,
        bootstrap: { cwd: process.cwd(), isGit: true }
      })
    );
    expect(mocked.prepareExecutionBootstrap).toHaveBeenCalledTimes(1);
    expect(mocked.resolveInput).not.toHaveBeenCalled();
    expect(mocked.generatePlanFromFreeform).not.toHaveBeenCalled();
    expect(mocked.reviewGeneratedPlan).not.toHaveBeenCalled();
    expect(mocked.saveGeneratedPlan).not.toHaveBeenCalled();
  });

  it("forwards --no-git flag into execution bootstrap", async () => {
    await executeExistingPlan("docs/plans/2026-03-03-existing.md", {
      ...defaultRunArgs(),
      noGit: true
    });

    expect(mocked.prepareExecutionBootstrap).toHaveBeenCalledWith(process.cwd(), { noGit: true });
  });

  it("prefers per-run --model override over persisted settings", async () => {
    mocked.loadThredSettings.mockResolvedValueOnce({
      settings: { model: "persisted-model", reasoningEffort: "high" }
    });

    await executeFromInput("task text", {
      ...defaultArgs(),
      nonInteractive: true,
      model: "run-override-model"
    });

    expect(mocked.executePlan).toHaveBeenCalledWith(
      "/tmp/repo/docs/plans/2026-03-03-demo-plan.md",
      process.cwd(),
      expect.objectContaining({
        model: "run-override-model"
      })
    );
  });
});

function defaultArgs(): ExecuteCommandArgs {
  return {
    waitOnLimit: "30m",
    noColor: false,
    verbose: false,
    nonInteractive: false,
    sandbox: "danger-full-access"
  };
}

function defaultRunArgs(): RunCommandArgs {
  return {
    waitOnLimit: "30m",
    noColor: false,
    verbose: false,
    sandbox: "danger-full-access"
  };
}
