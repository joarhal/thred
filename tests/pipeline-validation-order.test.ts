import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  runCommand: vi.fn(),
  relocateKnownProjectArtifacts: vi.fn()
}));

vi.mock("../src/core/util/process.js", async () => {
  const actual = await vi.importActual<typeof import("../src/core/util/process.js")>(
    "../src/core/util/process.js"
  );
  return {
    ...actual,
    runCommand: mocked.runCommand
  };
});

vi.mock("../src/core/artifacts/manager.js", async () => {
  const actual = await vi.importActual<typeof import("../src/core/artifacts/manager.js")>(
    "../src/core/artifacts/manager.js"
  );
  return {
    ...actual,
    relocateKnownProjectArtifacts: mocked.relocateKnownProjectArtifacts
  };
});

import { PipelineRunner } from "../src/core/pipeline/runner.js";
import type { RunOptions } from "../src/types.js";

describe("pipeline validation command ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("relocates known artifacts once after all validation commands complete", async () => {
    mocked.runCommand.mockResolvedValue({ code: 0, stdout: "ok\n", stderr: "" });
    mocked.relocateKnownProjectArtifacts.mockResolvedValue([]);

    const mutable = createRunnerMutable();
    const result = await mutable.runValidationCommands(["echo first", "echo second"], "task 1");

    expect(result.ok).toBe(true);
    expect(mocked.runCommand).toHaveBeenCalledTimes(2);
    expect(mocked.relocateKnownProjectArtifacts).toHaveBeenCalledTimes(1);

    const secondValidationCallOrder = mocked.runCommand.mock.invocationCallOrder[1];
    const relocateCallOrder = mocked.relocateKnownProjectArtifacts.mock.invocationCallOrder[0];
    expect(typeof secondValidationCallOrder).toBe("number");
    expect(typeof relocateCallOrder).toBe("number");
    expect((secondValidationCallOrder ?? 0) < (relocateCallOrder ?? 0)).toBe(true);
  });

  it("relocates known artifacts once after a validation failure", async () => {
    mocked.runCommand.mockResolvedValue({ code: 1, stdout: "", stderr: "failed\n" });
    mocked.relocateKnownProjectArtifacts.mockResolvedValue([]);

    const mutable = createRunnerMutable();
    const result = await mutable.runValidationCommands(["npm test", "npm run build"], "task 1");

    expect(result.ok).toBe(false);
    expect(result.failedCommandIndex).toBe(1);
    expect(result.failedCommand).toBe("npm test");
    expect(mocked.runCommand).toHaveBeenCalledTimes(1);
    expect(mocked.relocateKnownProjectArtifacts).toHaveBeenCalledTimes(1);
  });
});

function createRunnerMutable(): {
  runValidationCommands: (
    commands: string[],
    scopeLabel: string
  ) => Promise<{ ok: boolean; output: string; failedCommandIndex?: number; failedCommand?: string }>;
} {
  const options: RunOptions = {
    planPath: "/tmp/work/docs/plans/2026-03-03-demo.md",
    isGit: true,
    maxTaskRetries: 1,
    maxReviewIterations: 1,
    maxExternalIterations: 1,
    reviewPatience: 1,
    waitOnLimitMs: 1_000,
    noColor: true
  };

  const runner = new PipelineRunner({
    options,
    cwd: "/tmp/work",
    runId: "validation-order",
    logger: {
      logPath: "/tmp/thred-validation-order.log",
      phase: vi.fn(async () => {}),
      info: vi.fn(async () => {}),
      debug: vi.fn(async () => {}),
      warn: vi.fn(async () => {}),
      error: vi.fn(async () => {}),
      success: vi.fn(async () => {}),
      rawToolOutput: vi.fn(async () => {})
    } as any,
    stateStore: {
      write: vi.fn(async () => {})
    } as any
  });

  return runner as unknown as {
    runValidationCommands: (
      commands: string[],
      scopeLabel: string
    ) => Promise<{ ok: boolean; output: string; failedCommandIndex?: number; failedCommand?: string }>;
  };
}
