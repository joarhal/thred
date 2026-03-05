import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { reviewGeneratedPlan } from "../src/core/plan/review.js";

describe("generated plan review", () => {
  it("accepts single anchor path for sparse repositories", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-plan-review-sparse-"));
    await writeFile(path.join(cwd, ".gitignore"), ".thred/\n", "utf8");

    const plan = [
      "# Plan: Demo",
      "",
      "## Overview",
      "Initialize landing baseline.",
      "",
      "## Validation Commands",
      "- `git status --short`",
      "",
      "### Task 1: Prepare baseline",
      "- [ ] verify `.gitignore` and scaffold first files"
    ].join("\n");

    const codex = mockCodex([
      {
        output: JSON.stringify({
          status: "approved",
          summary: "Sufficiently grounded for sparse repository",
          issues: [],
          revisedPlanMarkdown: ""
        }),
        isRateLimited: false
      }
    ]);

    const reviewed = await reviewGeneratedPlan(codex, {
      sourceText: "Build a landing page",
      sourceMode: "text",
      sourceLabel: "inline",
      currentPlan: plan,
      projectContext: "Top-level entries: (none)",
      validationCommands: ["git status --short"],
      maxRetries: 1,
      cwd
    });

    expect(reviewed.revised).toBe(false);
    expect(reviewed.content).toContain("`.gitignore`");
    expect(reviewed.summary).toContain("plan review approved");
  });

  it("does not require path anchors when repository contains only hidden files", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-plan-review-empty-like-"));
    await writeFile(path.join(cwd, ".DS_Store"), "stub", "utf8");

    const plan = [
      "# Plan: Demo",
      "",
      "## Overview",
      "Initialize baseline in an empty directory.",
      "",
      "## Validation Commands",
      "- `true`",
      "",
      "### Task 1: Scaffold",
      "- [ ] create initial project files"
    ].join("\n");

    const codex = mockCodex([
      {
        output: JSON.stringify({
          status: "approved",
          summary: "Valid for empty repository",
          issues: [],
          revisedPlanMarkdown: ""
        }),
        isRateLimited: false
      }
    ]);

    const reviewed = await reviewGeneratedPlan(codex, {
      sourceText: "Bootstrap project",
      sourceMode: "text",
      sourceLabel: "inline",
      currentPlan: plan,
      projectContext: "Top-level entries: (none)",
      validationCommands: ["true"],
      maxRetries: 1,
      cwd
    });

    expect(reviewed.revised).toBe(false);
    expect(reviewed.summary).toContain("plan review approved");
  });

  it("revises plan when reviewer reports gaps", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-plan-review-"));
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src", "main.tsx"), "export {};\n", "utf8");
    await writeFile(path.join(cwd, "src", "App.tsx"), "export {};\n", "utf8");

    const codex = mockCodex([
      {
        output: JSON.stringify({
          status: "needs_revision",
          summary: "Plan lacks concrete paths",
          issues: ["Missing concrete file references"],
          revisedPlanMarkdown: [
            "# Plan: Demo",
            "",
            "## Overview",
            "Improve startup flow.",
            "",
            "## Validation Commands",
            "- `npm test`",
            "",
            "### Task 1: Wire startup logger",
            "- [ ] update `src/main.tsx` to register bootstrap hook",
            "",
            "### Task 2: Verify behavior",
            "- [ ] adjust `src/App.tsx` assertions and run tests"
          ].join("\n")
        }),
        isRateLimited: false
      }
    ]);

    const reviewed = await reviewGeneratedPlan(codex, {
      sourceText: "Add startup logger",
      sourceMode: "text",
      sourceLabel: "inline",
      currentPlan: [
        "# Plan: Demo",
        "",
        "## Overview",
        "Do work.",
        "",
        "## Validation Commands",
        "- `npm test`",
        "",
        "### Task 1: Implement",
        "- [ ] implement feature"
      ].join("\n"),
      projectContext: "src/main.tsx, src/App.tsx",
      validationCommands: ["npm test"],
      maxRetries: 1,
      cwd
    });

    expect(reviewed.revised).toBe(true);
    expect(reviewed.content).toContain("`src/main.tsx`");
    expect(reviewed.content).toContain("`src/App.tsx`");
  });

  it("keeps plan unchanged when reviewer approves and paths are concrete", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-plan-review-"));
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src", "main.tsx"), "export {};\n", "utf8");
    await writeFile(path.join(cwd, "src", "App.tsx"), "export {};\n", "utf8");

    const plan = [
      "# Plan: Demo",
      "",
      "## Overview",
      "Improve startup flow.",
      "",
      "## Validation Commands",
      "- `npm test`",
      "",
      "### Task 1: Wire startup logger",
      "- [ ] update `src/main.tsx` startup code",
      "",
      "### Task 2: Verify behavior",
      "- [ ] add checks in `src/App.tsx` and run tests"
    ].join("\n");

    const codex = mockCodex([
      {
        output: JSON.stringify({
          status: "approved",
          summary: "Plan is grounded and complete",
          issues: [],
          revisedPlanMarkdown: ""
        }),
        isRateLimited: false
      }
    ]);

    const reviewed = await reviewGeneratedPlan(codex, {
      sourceText: "Add startup logger",
      sourceMode: "text",
      sourceLabel: "inline",
      currentPlan: plan,
      projectContext: "src/main.tsx, src/App.tsx",
      validationCommands: ["npm test"],
      maxRetries: 1,
      cwd
    });

    expect(reviewed.revised).toBe(false);
    expect(reviewed.content).toContain("`src/main.tsx`");
    expect(reviewed.summary).toContain("plan review approved");
  });

  it("accepts review payload when output contains other json objects", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-plan-review-"));
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src", "main.tsx"), "export {};\n", "utf8");
    await writeFile(path.join(cwd, "src", "App.tsx"), "export {};\n", "utf8");

    const plan = [
      "# Plan: Demo",
      "",
      "## Overview",
      "Improve startup flow.",
      "",
      "## Validation Commands",
      "- `npm test`",
      "",
      "### Task 1: Wire startup logger",
      "- [ ] update `src/main.tsx` startup code",
      "",
      "### Task 2: Verify behavior",
      "- [ ] add checks in `src/App.tsx` and run tests"
    ].join("\n");

    const codex = mockCodex([
      {
        output: [
          '{"runId":"abc123","phase":"review"}',
          '{"status":"approved","summary":"Plan is grounded","issues":[],"revisedPlanMarkdown":""}',
          '{"tokensUsed":17314}'
        ].join("\n"),
        isRateLimited: false
      }
    ]);

    const reviewed = await reviewGeneratedPlan(codex, {
      sourceText: "Add startup logger",
      sourceMode: "text",
      sourceLabel: "inline",
      currentPlan: plan,
      projectContext: "src/main.tsx, src/App.tsx",
      validationCommands: ["npm test"],
      maxRetries: 1,
      cwd
    });

    expect(reviewed.revised).toBe(false);
    expect(reviewed.summary).toContain("plan review approved");
  });

  it("retries when revised plan markdown is invalid and accepts next valid revision", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-plan-review-"));
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src", "main.tsx"), "export {};\n", "utf8");
    await writeFile(path.join(cwd, "src", "App.tsx"), "export {};\n", "utf8");

    const codex = mockCodex([
      {
        output: JSON.stringify({
          status: "needs_revision",
          summary: "Needs clearer tasks",
          issues: ["Missing validation section"],
          revisedPlanMarkdown: [
            "# Plan: Demo",
            "",
            "## Overview",
            "Do a refactor.",
            "",
            "### Task 1: Refactor",
            "- [ ] update `src/main.tsx`",
            "",
            "### Task 2: Verify",
            "- [ ] update `src/App.tsx`"
          ].join("\n")
        }),
        isRateLimited: false
      },
      {
        output: JSON.stringify({
          status: "needs_revision",
          summary: "Fixed structure",
          issues: [],
          revisedPlanMarkdown: [
            "# Plan: Demo",
            "",
            "## Overview",
            "Do a refactor.",
            "",
            "## Validation Commands",
            "- `npm test`",
            "",
            "### Task 1: Refactor",
            "- [ ] update `src/main.tsx`",
            "",
            "### Task 2: Verify",
            "- [ ] update `src/App.tsx` and run tests"
          ].join("\n")
        }),
        isRateLimited: false
      }
    ]);

    const reviewed = await reviewGeneratedPlan(codex, {
      sourceText: "refactoring",
      sourceMode: "text",
      sourceLabel: "inline",
      currentPlan: [
        "# Plan: Demo",
        "",
        "## Overview",
        "Initial draft.",
        "",
        "## Validation Commands",
        "- `npm test`",
        "",
        "### Task 1: Start",
        "- [ ] do work"
      ].join("\n"),
      projectContext: "src/main.tsx, src/App.tsx",
      validationCommands: ["npm test"],
      maxRetries: 2,
      cwd
    });

    expect(reviewed.revised).toBe(true);
    expect(reviewed.content).toContain("## Validation Commands");
    expect(reviewed.content).toContain("`src/main.tsx`");
    expect(reviewed.content).toContain("`src/App.tsx`");
  });

  it("retries when revised plan changes required validation commands", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-plan-review-"));
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src", "main.tsx"), "export {};\n", "utf8");
    await writeFile(path.join(cwd, "src", "App.tsx"), "export {};\n", "utf8");

    const codex = mockCodex([
      {
        output: JSON.stringify({
          status: "needs_revision",
          summary: "Adds missing references",
          issues: ["Need stronger grounding"],
          revisedPlanMarkdown: [
            "# Plan: Demo",
            "",
            "## Overview",
            "Do a refactor.",
            "",
            "## Validation Commands",
            "- `npm run lint`",
            "",
            "### Task 1: Refactor",
            "- [ ] update `src/main.tsx`",
            "",
            "### Task 2: Verify",
            "- [ ] update `src/App.tsx` and run checks"
          ].join("\n")
        }),
        isRateLimited: false
      },
      {
        output: JSON.stringify({
          status: "needs_revision",
          summary: "Keeps expected command list",
          issues: [],
          revisedPlanMarkdown: [
            "# Plan: Demo",
            "",
            "## Overview",
            "Do a refactor.",
            "",
            "## Validation Commands",
            "- `npm test`",
            "",
            "### Task 1: Refactor",
            "- [ ] update `src/main.tsx`",
            "",
            "### Task 2: Verify",
            "- [ ] update `src/App.tsx` and run checks"
          ].join("\n")
        }),
        isRateLimited: false
      }
    ]);

    const reviewed = await reviewGeneratedPlan(codex, {
      sourceText: "refactoring",
      sourceMode: "text",
      sourceLabel: "inline",
      currentPlan: [
        "# Plan: Demo",
        "",
        "## Overview",
        "Initial draft.",
        "",
        "## Validation Commands",
        "- `npm test`",
        "",
        "### Task 1: Start",
        "- [ ] do work in `src/main.tsx`",
        "",
        "### Task 2: Verify",
        "- [ ] update `src/App.tsx` checks"
      ].join("\n"),
      projectContext: "src/main.tsx, src/App.tsx",
      validationCommands: ["npm test"],
      maxRetries: 2,
      cwd
    });

    expect(reviewed.revised).toBe(true);
    expect(reviewed.content).toContain("- `npm test`");
    expect(reviewed.content).not.toContain("- `npm run lint`");
  });

  it("throws after retry exhaustion when codex keeps returning errors", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-plan-review-"));
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src", "main.tsx"), "export {};\n", "utf8");
    await writeFile(path.join(cwd, "src", "App.tsx"), "export {};\n", "utf8");

    const codex = mockCodex([
      { output: "", isRateLimited: false, error: new Error("codex unavailable") },
      { output: "", isRateLimited: false, error: new Error("codex unavailable") }
    ]);

    await expect(
      reviewGeneratedPlan(codex, {
        sourceText: "refactoring",
        sourceMode: "text",
        sourceLabel: "inline",
        currentPlan: [
          "# Plan: Demo",
          "",
          "## Overview",
          "Initial draft.",
          "",
          "## Validation Commands",
          "- `npm test`",
          "",
          "### Task 1: Start",
          "- [ ] do work in `src/main.tsx`",
          "",
          "### Task 2: Verify",
          "- [ ] update `src/App.tsx` checks"
        ].join("\n"),
        projectContext: "src/main.tsx, src/App.tsx",
        validationCommands: ["npm test"],
        maxRetries: 1,
        cwd
      })
    ).rejects.toThrow("codex unavailable");
  });

  it("retries when approved payload includes issues and accepts corrected payload", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-plan-review-"));
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src", "main.tsx"), "export {};\n", "utf8");
    await writeFile(path.join(cwd, "src", "App.tsx"), "export {};\n", "utf8");

    const plan = [
      "# Plan: Demo",
      "",
      "## Overview",
      "Improve startup flow.",
      "",
      "## Validation Commands",
      "- `npm test`",
      "",
      "### Task 1: Wire startup logger",
      "- [ ] update `src/main.tsx` startup code",
      "",
      "### Task 2: Verify behavior",
      "- [ ] add checks in `src/App.tsx` and run tests"
    ].join("\n");

    const codex = mockCodex([
      {
        output: JSON.stringify({
          status: "approved",
          summary: "Looks clean",
          issues: ["warning: vague wording"],
          revisedPlanMarkdown: ""
        }),
        isRateLimited: false
      },
      {
        output: JSON.stringify({
          status: "approved",
          summary: "Looks clean now",
          issues: [],
          revisedPlanMarkdown: ""
        }),
        isRateLimited: false
      }
    ]);

    const reviewed = await reviewGeneratedPlan(codex, {
      sourceText: "Add startup logger",
      sourceMode: "text",
      sourceLabel: "inline",
      currentPlan: plan,
      projectContext: "src/main.tsx, src/App.tsx",
      validationCommands: ["npm test"],
      maxRetries: 1,
      cwd
    });

    expect(reviewed.revised).toBe(false);
    expect(reviewed.summary).toContain("plan review approved");
  });

  it("throws after retry exhaustion when review output is invalid json", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-plan-review-"));
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src", "main.tsx"), "export {};\n", "utf8");
    await writeFile(path.join(cwd, "src", "App.tsx"), "export {};\n", "utf8");

    const codex = mockCodex([
      { output: "not json", isRateLimited: false },
      { output: "still not json", isRateLimited: false }
    ]);

    await expect(
      reviewGeneratedPlan(codex, {
        sourceText: "refactoring",
        sourceMode: "text",
        sourceLabel: "inline",
        currentPlan: [
          "# Plan: Demo",
          "",
          "## Overview",
          "Initial draft.",
          "",
          "## Validation Commands",
          "- `npm test`",
          "",
          "### Task 1: Start",
          "- [ ] do work in `src/main.tsx`",
          "",
          "### Task 2: Verify",
          "- [ ] update `src/App.tsx` checks"
        ].join("\n"),
        projectContext: "src/main.tsx, src/App.tsx",
        validationCommands: ["npm test"],
        maxRetries: 1,
        cwd
      })
    ).rejects.toThrow(/Review output is invalid/i);
  });

  it("throws after retry exhaustion when revisions keep changing validation commands", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-plan-review-"));
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src", "main.tsx"), "export {};\n", "utf8");
    await writeFile(path.join(cwd, "src", "App.tsx"), "export {};\n", "utf8");

    const badRevision = [
      "# Plan: Demo",
      "",
      "## Overview",
      "Do a refactor.",
      "",
      "## Validation Commands",
      "- `npm run lint`",
      "",
      "### Task 1: Refactor",
      "- [ ] update `src/main.tsx`",
      "",
      "### Task 2: Verify",
      "- [ ] update `src/App.tsx` and run checks"
    ].join("\n");

    const codex = mockCodex([
      {
        output: JSON.stringify({
          status: "needs_revision",
          summary: "bad commands",
          issues: [],
          revisedPlanMarkdown: badRevision
        }),
        isRateLimited: false
      },
      {
        output: JSON.stringify({
          status: "needs_revision",
          summary: "still bad commands",
          issues: [],
          revisedPlanMarkdown: badRevision
        }),
        isRateLimited: false
      }
    ]);

    await expect(
      reviewGeneratedPlan(codex, {
        sourceText: "refactoring",
        sourceMode: "text",
        sourceLabel: "inline",
        currentPlan: [
          "# Plan: Demo",
          "",
          "## Overview",
          "Initial draft.",
          "",
          "## Validation Commands",
          "- `npm test`",
          "",
          "### Task 1: Start",
          "- [ ] do work in `src/main.tsx`",
          "",
          "### Task 2: Verify",
          "- [ ] update `src/App.tsx` checks"
        ].join("\n"),
        projectContext: "src/main.tsx, src/App.tsx",
        validationCommands: ["npm test"],
        maxRetries: 1,
        cwd
      })
    ).rejects.toThrow(/Revised plan changed validation commands/i);
  });

  it("throws after retry exhaustion when plans remain insufficiently anchored", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-plan-review-"));
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src", "main.tsx"), "export {};\n", "utf8");
    await writeFile(path.join(cwd, "src", "App.tsx"), "export {};\n", "utf8");
    await writeFile(path.join(cwd, "README.md"), "demo\n", "utf8");
    await writeFile(path.join(cwd, "package.json"), "{ \"name\": \"demo\" }\n", "utf8");

    const codex = mockCodex([
      {
        output: JSON.stringify({
          status: "approved",
          summary: "looks fine",
          issues: [],
          revisedPlanMarkdown: ""
        }),
        isRateLimited: false
      },
      {
        output: JSON.stringify({
          status: "approved",
          summary: "still fine",
          issues: [],
          revisedPlanMarkdown: ""
        }),
        isRateLimited: false
      }
    ]);

    await expect(
      reviewGeneratedPlan(codex, {
        sourceText: "refactoring",
        sourceMode: "text",
        sourceLabel: "inline",
        currentPlan: [
          "# Plan: Demo",
          "",
          "## Overview",
          "Initial draft.",
          "",
          "## Validation Commands",
          "- `npm test`",
          "",
          "### Task 1: Start",
          "- [ ] do work",
          "",
          "### Task 2: Verify",
          "- [ ] update checks"
        ].join("\n"),
        projectContext: "src/main.tsx, src/App.tsx",
        validationCommands: ["npm test"],
        maxRetries: 1,
        cwd
      })
    ).rejects.toThrow(/Plan is not sufficiently anchored to codebase/i);
  });
});

function mockCodex(outputs: Array<{ output: string; isRateLimited: boolean; error?: Error }>) {
  let index = 0;
  return {
    async run() {
      const next = outputs[index] ?? outputs[outputs.length - 1];
      index += 1;
      return next;
    }
  } as {
    run: () => Promise<{ output: string; isRateLimited: boolean; error?: Error }>;
  };
}
