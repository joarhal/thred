import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  runInteractiveSession: vi.fn()
}));

vi.mock("../src/core/interactive/session.js", () => ({
  runInteractiveSession: mocked.runInteractiveSession
}));

import { runInteractiveEntry } from "../src/core/interactive/entry.js";

describe("interactive entry", () => {
  it("forwards all options to interactive session", async () => {
    mocked.runInteractiveSession.mockResolvedValue(undefined);

    await runInteractiveEntry("/repo/work", {
      isGit: true,
      baseBranch: "main",
      model: "gpt-5",
      reasoningEffort: "high",
      sandbox: "workspace-write",
      initialGoal: "Ship feature",
      initialSourceLabel: "cli-input",
      memoryContext: "memory snapshot",
      maxTaskRetries: 2,
      maxReviewIterations: 3,
      maxExternalIterations: 4,
      reviewPatience: 5,
      waitOnLimitMs: 30_000,
      noColor: true,
      verbose: false,
      executionBootstrap: { cwd: "/repo/work", isGit: true }
    });

    expect(mocked.runInteractiveSession).toHaveBeenCalledTimes(1);
    expect(mocked.runInteractiveSession).toHaveBeenCalledWith({
      cwd: "/repo/work",
      isGit: true,
      baseBranch: "main",
      model: "gpt-5",
      reasoningEffort: "high",
      sandbox: "workspace-write",
      initialGoal: "Ship feature",
      initialSourceLabel: "cli-input",
      memoryContext: "memory snapshot",
      maxTaskRetries: 2,
      maxReviewIterations: 3,
      maxExternalIterations: 4,
      reviewPatience: 5,
      waitOnLimitMs: 30_000,
      noColor: true,
      verbose: false,
      executionBootstrap: { cwd: "/repo/work", isGit: true }
    });
  });
});
