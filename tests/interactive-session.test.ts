import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  configureInteractiveOutput: vi.fn(),
  shutdownInteractiveOutput: vi.fn(),
  clearTerminalScreen: vi.fn(),
  clearPlanPreview: vi.fn(),
  printDebug: vi.fn(),
  printInfo: vi.fn(),
  printPlanPreview: vi.fn(),
  printSection: vi.fn(),
  printWarn: vi.fn(),
  promptChoice: vi.fn(),
  promptText: vi.fn(),
  setThinkingIndicator: vi.fn(),
  getInteractiveProgressSink: vi.fn(),
  listUnfinishedPlans: vi.fn(),
  executePlan: vi.fn(),
  detectValidationCommands: vi.fn(),
  runClarificationCycle: vi.fn(),
  buildProjectContextSnapshot: vi.fn(),
  generatePlanFromFreeform: vi.fn(),
  reviewGeneratedPlan: vi.fn(),
  saveGeneratedPlan: vi.fn(),
  cleanupInteractivePreflight: vi.fn(),
  removePlanAndCommitDeletionIfTracked: vi.fn(),
  codexRun: vi.fn()
}));

vi.mock("../src/core/interactive/ui.js", () => ({
  configureInteractiveOutput: mocked.configureInteractiveOutput,
  shutdownInteractiveOutput: mocked.shutdownInteractiveOutput,
  clearTerminalScreen: mocked.clearTerminalScreen,
  clearPlanPreview: mocked.clearPlanPreview,
  printDebug: mocked.printDebug,
  printInfo: mocked.printInfo,
  printPlanPreview: mocked.printPlanPreview,
  printSection: mocked.printSection,
  printWarn: mocked.printWarn,
  promptChoice: mocked.promptChoice,
  promptText: mocked.promptText,
  setThinkingIndicator: mocked.setThinkingIndicator,
  getInteractiveProgressSink: mocked.getInteractiveProgressSink
}));

vi.mock("../src/core/interactive/unfinished-plan.js", () => ({
  listUnfinishedPlans: mocked.listUnfinishedPlans
}));

vi.mock("../src/core/execute/run-plan.js", () => ({
  executePlan: mocked.executePlan
}));

vi.mock("../src/core/plan/validation-detect.js", () => ({
  detectValidationCommands: mocked.detectValidationCommands
}));

vi.mock("../src/core/interactive/clarification-cycle.js", () => ({
  runClarificationCycle: mocked.runClarificationCycle
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

vi.mock("../src/core/interactive/preflight-cleanup.js", () => ({
  cleanupInteractivePreflight: mocked.cleanupInteractivePreflight
}));

vi.mock("../src/core/interactive/plan-cleanup.js", () => ({
  removePlanAndCommitDeletionIfTracked: mocked.removePlanAndCommitDeletionIfTracked
}));

vi.mock("../src/core/codex/runner.js", () => ({
  CodexRunner: class {
    async run(prompt: string): Promise<unknown> {
      return mocked.codexRun(prompt);
    }
  }
}));

vi.mock("../src/core/ui/terminal.js", () => ({
  shouldSuppressToolLine: () => false,
  extractToolProgressBullet: () => null,
  createToolCompactFilterState: () => ({
    headerSeparators: 0,
    seen: new Set<string>(),
    consecutiveCommandSummaries: 0
  }),
  selectCompactToolLine: (line: string) => line
}));

import { runInteractiveSession } from "../src/core/interactive/session.js";

describe("interactive session flow", () => {
  const sink = { log: vi.fn() };
  const originalStdinTty = process.stdin.isTTY;
  const originalStdoutTty = process.stdout.isTTY;

  beforeEach(() => {
    vi.clearAllMocks();
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;

    mocked.getInteractiveProgressSink.mockReturnValue(sink);
    mocked.listUnfinishedPlans.mockResolvedValue([]);
    mocked.promptChoice.mockResolvedValue("continue");
    mocked.promptText.mockResolvedValue("");
    mocked.detectValidationCommands.mockResolvedValue({
      commands: ["npm test"],
      diagnostics: []
    });
    mocked.runClarificationCycle.mockResolvedValue({
      allAnswers: [],
      addedAnswers: [],
      softFallbackUsed: false
    });
    mocked.buildProjectContextSnapshot.mockResolvedValue({ summary: "repo summary" });
    mocked.generatePlanFromFreeform.mockResolvedValue({
      title: "Demo Plan",
      content: "# Plan: Demo"
    });
    mocked.reviewGeneratedPlan.mockImplementation(async (_codex: unknown, input: { currentPlan: string }) => {
      const titleMatch = input.currentPlan.match(/^#\s+(Plan:\s+.+)$/m);
      return {
        title: titleMatch?.[1] ?? "Demo Plan",
        content: input.currentPlan,
        summary: "clean",
        revised: false
      };
    });
    mocked.saveGeneratedPlan.mockResolvedValue("/tmp/repo/docs/plans/2026-03-03-demo.md");
    mocked.cleanupInteractivePreflight.mockResolvedValue({
      committedDeletedPlans: [],
      relocatedArtifacts: []
    });
    mocked.removePlanAndCommitDeletionIfTracked.mockResolvedValue({
      relativePath: "docs/plans/2026-03-03-demo.md",
      committed: false
    });
    mocked.executePlan.mockResolvedValue(undefined);
    mocked.codexRun.mockResolvedValue({
      output: "# Plan: Revised Demo\n\n## Overview\nUpdated overview.\n\n## Validation Commands\n- `npm test`\n\n### Task 1: Updated task\n- [ ] done\n",
      error: undefined,
      isRateLimited: false
    });
  });

  afterEach(() => {
    process.stdin.isTTY = originalStdinTty;
    process.stdout.isTTY = originalStdoutTty;
  });

  it("fails fast when interactive mode is not running in a TTY", async () => {
    process.stdin.isTTY = false;
    process.stdout.isTTY = false;

    await expect(runInteractiveSession(baseOptions())).rejects.toThrow("interactive mode requires TTY");
    expect(mocked.clearTerminalScreen).not.toHaveBeenCalled();
  });

  it("continues execution from an unfinished plan when selected", async () => {
    mocked.listUnfinishedPlans.mockResolvedValue([
      {
        path: "/tmp/repo/docs/plans/2026-03-03-demo.md",
        relativePath: "docs/plans/2026-03-03-demo.md"
      }
    ]);
    mocked.promptChoice.mockResolvedValue("continue");

    await runInteractiveSession(baseOptions());

    expect(mocked.executePlan).toHaveBeenCalledTimes(1);
    expect(mocked.executePlan).toHaveBeenCalledWith(
      "/tmp/repo/docs/plans/2026-03-03-demo.md",
      "/tmp/repo",
      expect.objectContaining({
        planPath: "/tmp/repo/docs/plans/2026-03-03-demo.md",
        sink
      })
    );
    expect(mocked.promptText).not.toHaveBeenCalled();
    expect(mocked.shutdownInteractiveOutput).toHaveBeenCalledTimes(1);
  });

  it("generates, reviews, and executes a new plan when user accepts preview", async () => {
    mocked.promptText
      .mockResolvedValueOnce("Refactor payment module")
      .mockResolvedValueOnce("");

    await runInteractiveSession(baseOptions());

    expect(mocked.detectValidationCommands).toHaveBeenCalledTimes(1);
    expect(mocked.detectValidationCommands).toHaveBeenCalledWith("/tmp/repo", { isGit: true });
    expect(mocked.runClarificationCycle).toHaveBeenCalledTimes(1);
    expect(mocked.generatePlanFromFreeform).toHaveBeenCalledTimes(1);
    expect(mocked.reviewGeneratedPlan).toHaveBeenCalledTimes(1);
    expect(mocked.saveGeneratedPlan).toHaveBeenCalledTimes(1);
    expect(mocked.cleanupInteractivePreflight).toHaveBeenCalledTimes(1);
    expect(mocked.printPlanPreview).toHaveBeenCalledWith("# Plan: Demo");
    expect(mocked.executePlan).toHaveBeenCalledWith(
      "/tmp/repo/docs/plans/2026-03-03-demo.md",
      "/tmp/repo",
      expect.objectContaining({
        planPath: "/tmp/repo/docs/plans/2026-03-03-demo.md",
        sink
      })
    );
  });

  it("fails when initial plan quality review fails", async () => {
    mocked.promptText.mockResolvedValueOnce("Refactor payment module");
    mocked.reviewGeneratedPlan.mockRejectedValueOnce(new Error("review failed"));

    await expect(runInteractiveSession(baseOptions())).rejects.toThrow(
      "initial plan quality review failed: review failed"
    );
    expect(mocked.executePlan).not.toHaveBeenCalled();
  });

  it("revises plan when user provides feedback before accepting", async () => {
    mocked.promptText
      .mockResolvedValueOnce("Refactor payment module")
      .mockResolvedValueOnce("Split into two tasks")
      .mockResolvedValueOnce("");

    mocked.runClarificationCycle
      .mockResolvedValueOnce({
        allAnswers: [],
        addedAnswers: [],
        softFallbackUsed: false
      })
      .mockResolvedValueOnce({
        allAnswers: [{ question: "Need split?", answer: "Yes" }],
        addedAnswers: [{ question: "Need split?", answer: "Yes" }],
        softFallbackUsed: false
      });

    mocked.codexRun.mockResolvedValueOnce({
      output:
        "# Plan: Revised Demo\n\n## Overview\nUpdated overview.\n\n## Validation Commands\n- `npm test`\n\n### Task 1: Split prep\n- [ ] add shared prep\n\n### Task 2: Split execution\n- [ ] implement split path\n",
      error: undefined,
      isRateLimited: false
    });

    await runInteractiveSession(baseOptions());

    expect(mocked.runClarificationCycle).toHaveBeenCalledTimes(2);
    expect(mocked.runClarificationCycle).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        latestUserMessage: "Split into two tasks",
        currentPlan: "# Plan: Demo"
      })
    );
    expect(mocked.saveGeneratedPlan).toHaveBeenCalledWith(
      "/tmp/repo",
      "Plan: Revised Demo",
      expect.stringContaining("### Task 2: Split execution")
    );
  });

  it("fails when revised plan quality review fails", async () => {
    mocked.promptText
      .mockResolvedValueOnce("Refactor payment module")
      .mockResolvedValueOnce("Split into two tasks");

    mocked.reviewGeneratedPlan.mockReset();
    mocked.reviewGeneratedPlan
      .mockResolvedValueOnce({
        title: "Plan: Demo",
        content: "# Plan: Demo",
        summary: "clean",
        revised: false
      })
      .mockRejectedValueOnce(new Error("review failed"));

    await expect(runInteractiveSession(baseOptions())).rejects.toThrow(
      "revised plan quality review failed: review failed"
    );
    expect(mocked.executePlan).not.toHaveBeenCalled();
  });

  it("retries plan revision when first revised output is malformed", async () => {
    mocked.promptText
      .mockResolvedValueOnce("Refactor payment module")
      .mockResolvedValueOnce("Make validation explicit")
      .mockResolvedValueOnce("");

    mocked.runClarificationCycle
      .mockResolvedValueOnce({
        allAnswers: [],
        addedAnswers: [],
        softFallbackUsed: false
      })
      .mockResolvedValueOnce({
        allAnswers: [],
        addedAnswers: [],
        softFallbackUsed: false
      });

    mocked.codexRun
      .mockResolvedValueOnce({
        output: "not a valid plan",
        error: undefined,
        isRateLimited: false
      })
      .mockResolvedValueOnce({
        output:
          "# Plan: Revised Demo\n\n## Overview\nUpdated overview.\n\n## Validation Commands\n- `npm test`\n\n### Task 1: Validation\n- [ ] add explicit validation command\n",
        error: undefined,
        isRateLimited: false
      });

    await runInteractiveSession(baseOptions());

    expect(mocked.codexRun).toHaveBeenCalledTimes(2);
    const secondPrompt = mocked.codexRun.mock.calls[1]?.[0] as string | undefined;
    expect(secondPrompt).toContain("Previous parse error:");
    expect(secondPrompt).toContain("Previous invalid plan:");
    expect(mocked.saveGeneratedPlan).toHaveBeenCalledWith(
      "/tmp/repo",
      "Plan: Revised Demo",
      expect.stringContaining("### Task 1: Validation")
    );
  });

  it("retries plan revision when revised output changes validation commands", async () => {
    mocked.promptText
      .mockResolvedValueOnce("Refactor payment module")
      .mockResolvedValueOnce("Split into two tasks")
      .mockResolvedValueOnce("");

    mocked.runClarificationCycle
      .mockResolvedValueOnce({
        allAnswers: [],
        addedAnswers: [],
        softFallbackUsed: false
      })
      .mockResolvedValueOnce({
        allAnswers: [],
        addedAnswers: [],
        softFallbackUsed: false
      });

    mocked.codexRun
      .mockResolvedValueOnce({
        output:
          "# Plan: Revised Demo\n\n## Overview\nUpdated overview.\n\n## Validation Commands\n- `npm run lint`\n\n### Task 1: Split prep\n- [ ] add shared prep\n",
        error: undefined,
        isRateLimited: false
      })
      .mockResolvedValueOnce({
        output:
          "# Plan: Revised Demo\n\n## Overview\nUpdated overview.\n\n## Validation Commands\n- `npm test`\n\n### Task 1: Split prep\n- [ ] add shared prep\n",
        error: undefined,
        isRateLimited: false
      });

    await runInteractiveSession(baseOptions());

    expect(mocked.codexRun).toHaveBeenCalledTimes(2);
    const secondPrompt = mocked.codexRun.mock.calls[1]?.[0] as string | undefined;
    expect(secondPrompt).toContain("Revised plan changed validation commands.");
    expect(secondPrompt).toContain("Command 1 must be 'npm test', got 'npm run lint'");
    expect(mocked.saveGeneratedPlan).toHaveBeenCalledWith(
      "/tmp/repo",
      "Plan: Revised Demo",
      expect.stringContaining("- `npm test`")
    );
  });

  it("fails revision clearly when validation-command mismatch persists across retries", async () => {
    mocked.promptText
      .mockResolvedValueOnce("Refactor payment module")
      .mockResolvedValueOnce("Split into two tasks");

    mocked.runClarificationCycle
      .mockResolvedValueOnce({
        allAnswers: [],
        addedAnswers: [],
        softFallbackUsed: false
      })
      .mockResolvedValueOnce({
        allAnswers: [],
        addedAnswers: [],
        softFallbackUsed: false
      });

    mocked.codexRun
      .mockResolvedValueOnce({
        output:
          "# Plan: Revised Demo\n\n## Overview\nUpdated overview.\n\n## Validation Commands\n- `npm run lint`\n\n### Task 1: Split prep\n- [ ] add shared prep\n",
        error: undefined,
        isRateLimited: false
      })
      .mockResolvedValueOnce({
        output:
          "# Plan: Revised Demo\n\n## Overview\nUpdated overview.\n\n## Validation Commands\n- `npm run check`\n\n### Task 1: Split prep\n- [ ] add shared prep\n",
        error: undefined,
        isRateLimited: false
      });

    await expect(runInteractiveSession(baseOptions())).rejects.toThrow(
      /failed to revise plan: Revised plan changed validation commands/i
    );
    expect(mocked.codexRun).toHaveBeenCalledTimes(2);
  });
});

function baseOptions() {
  return {
    cwd: "/tmp/repo",
    isGit: true,
    model: "gpt-5-codex",
    reasoningEffort: "high" as const,
    sandbox: "danger-full-access" as const,
    memoryContext: "session memory",
    maxTaskRetries: 1,
    maxReviewIterations: 2,
    maxExternalIterations: 2,
    reviewPatience: 1,
    waitOnLimitMs: 30_000,
    noColor: true,
    verbose: false
  };
}
