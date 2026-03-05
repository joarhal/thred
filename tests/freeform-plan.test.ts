import { describe, expect, it } from "vitest";

import { generatePlanFromFreeform } from "../src/core/plan/generate.js";

describe("free-form plan generation", () => {
  it("accepts valid markdown plan output", async () => {
    const codex = mockCodex([
      {
        output: [
          "# Plan: Demo",
          "",
          "## Overview",
          "Do something useful.",
          "",
          "## Validation Commands",
          "- `npm test`",
          "",
          "### Task 1: Build",
          "- [ ] implement feature",
          "",
          "### Task 2: Verify",
          "- [ ] add tests"
        ].join("\n"),
        isRateLimited: false
      }
    ]);

    const generated = await generatePlanFromFreeform(codex, {
      sourceText: "ship feature",
      sourceMode: "text",
      sourceLabel: "inline",
      validationCommands: ["npm test"],
      projectContext: "src/main.tsx, src/App.tsx",
      maxRetries: 1
    });

    expect(generated.title).toBe("Plan: Demo");
    expect(generated.content).toContain("## Validation Commands");
  });

  it("retries when first markdown draft is parser-invalid and returns repaired draft", async () => {
    const codex = mockCodex([
      {
        output: "# Plan: Broken\n\n## Validation Commands\n- `npm test`\n",
        isRateLimited: false
      },
      {
        output: [
          "# Plan: Fixed",
          "",
          "## Overview",
          "Now valid.",
          "",
          "## Validation Commands",
          "- `npm test`",
          "",
          "### Task 1: Work",
          "- [ ] do it"
        ].join("\n"),
        isRateLimited: false
      }
    ]);

    const generated = await generatePlanFromFreeform(codex, {
      sourceText: "ship feature",
      sourceMode: "text",
      sourceLabel: "inline",
      validationCommands: ["npm test"],
      projectContext: "src/main.tsx, src/App.tsx",
      maxRetries: 1
    });

    expect(generated.title).toBe("Plan: Fixed");
    expect(generated.content).toContain("## Validation Commands");
    expect(generated.content).toContain("Now valid.");
  });

  it("normalizes repeated task numbering in model output", async () => {
    const codex = mockCodex([
      {
        output: [
          "# Plan: Refactor",
          "",
          "## Overview",
          "Project-wide improvements.",
          "",
          "## Validation Commands",
          "- `npm test`",
          "",
          "### Task 1: Analyze",
          "- [ ] inspect modules",
          "",
          "### Task 2: Refactor",
          "- [ ] split components",
          "",
          "### Task 1: Verify",
          "- [ ] run tests"
        ].join("\n"),
        isRateLimited: false
      }
    ]);

    const generated = await generatePlanFromFreeform(codex, {
      sourceText: "refactor project",
      sourceMode: "text",
      sourceLabel: "inline",
      validationCommands: ["npm test"],
      projectContext: "src/main.tsx, src/App.tsx",
      maxRetries: 0
    });

    expect(generated.content).toContain("### Task 1: Analyze");
    expect(generated.content).toContain("### Task 2: Refactor");
    expect(generated.content).toContain("### Task 3: Verify");
  });

  it("extracts markdown body from fenced output and ignores outer noise", async () => {
    const codex = mockCodex([
      {
        output: [
          "sure, here is the plan:",
          "",
          "```markdown",
          "# Plan: Demo",
          "",
          "## Overview",
          "Do something useful.",
          "",
          "## Validation Commands",
          "- `npm test`",
          "",
          "### Task 1: Build",
          "- [ ] implement feature",
          "```",
          "",
          "tokens used",
          "2,822"
        ].join("\n"),
        isRateLimited: false
      }
    ]);

    const generated = await generatePlanFromFreeform(codex, {
      sourceText: "ship feature",
      sourceMode: "text",
      sourceLabel: "inline",
      validationCommands: ["npm test"],
      projectContext: "src/main.tsx, src/App.tsx",
      maxRetries: 0
    });

    expect(generated.content).not.toContain("tokens used");
    expect(generated.content).not.toContain("2,822");
    expect(generated.content).toContain("### Task 1: Build");
  });

  it("strips trailing token-usage footer from plain markdown output", async () => {
    const codex = mockCodex([
      {
        output: [
          "# Plan: Demo",
          "",
          "## Overview",
          "Do something useful.",
          "",
          "## Validation Commands",
          "- `npm test`",
          "",
          "### Task 1: Build",
          "- [ ] implement feature",
          "",
          "### Task 2: Verify",
          "- [ ] add tests",
          "",
          "tokens used",
          "2,822"
        ].join("\n"),
        isRateLimited: false
      }
    ]);

    const generated = await generatePlanFromFreeform(codex, {
      sourceText: "ship feature",
      sourceMode: "text",
      sourceLabel: "inline",
      validationCommands: ["npm test"],
      projectContext: "src/main.tsx, src/App.tsx",
      maxRetries: 0
    });

    expect(generated.content).toContain("### Task 2: Verify");
    expect(generated.content).not.toContain("tokens used");
    expect(generated.content).not.toContain("2,822");
  });

  it("enforces validation command list during generation", async () => {
    const codex = mockCodex([
      {
        output: [
          "# Plan: Demo",
          "",
          "## Overview",
          "Do something useful.",
          "",
          "## Validation Commands",
          "- `npm run lint`",
          "",
          "### Task 1: Build",
          "- [ ] implement feature"
        ].join("\n"),
        isRateLimited: false
      },
      {
        output: [
          "# Plan: Demo",
          "",
          "## Overview",
          "Do something useful.",
          "",
          "## Validation Commands",
          "- `npm test`",
          "",
          "### Task 1: Build",
          "- [ ] implement feature"
        ].join("\n"),
        isRateLimited: false
      }
    ]);

    const generated = await generatePlanFromFreeform(codex, {
      sourceText: "ship feature",
      sourceMode: "text",
      sourceLabel: "inline",
      validationCommands: ["npm test"],
      projectContext: "src/main.tsx, src/App.tsx",
      maxRetries: 1
    });

    expect(generated.content).toContain("- `npm test`");
    expect(generated.content).not.toContain("- `npm run lint`");
  });

  it("throws when model output stays parser-invalid across retries", async () => {
    const codex = mockCodex([
      {
        output: "# Plan: Broken\n\n## Validation Commands\n- `npm test`\n",
        isRateLimited: false
      },
      {
        output: "# Plan: Still Broken\n\n## Validation Commands\n- `npm test`\n",
        isRateLimited: false
      }
    ]);

    await expect(
      generatePlanFromFreeform(codex, {
        sourceText: "ship feature",
        sourceMode: "text",
        sourceLabel: "inline",
        validationCommands: ["npm test"],
        projectContext: "src/main.tsx, src/App.tsx",
        maxRetries: 1
      })
    ).rejects.toThrow(/failed to generate a valid plan/i);
  });

  it("retries when codex returns an execution error before succeeding", async () => {
    const codex = mockCodex([
      {
        output: "",
        isRateLimited: false,
        error: new Error("codex temporary failure")
      },
      {
        output: [
          "# Plan: Recovered",
          "",
          "## Overview",
          "Recovered after transient error.",
          "",
          "## Validation Commands",
          "- `npm test`",
          "",
          "### Task 1: Build",
          "- [ ] implement feature"
        ].join("\n"),
        isRateLimited: false
      }
    ]);

    const generated = await generatePlanFromFreeform(codex, {
      sourceText: "ship feature",
      sourceMode: "text",
      sourceLabel: "inline",
      validationCommands: ["npm test"],
      projectContext: "src/main.tsx, src/App.tsx",
      maxRetries: 1
    });

    expect(generated.title).toBe("Plan: Recovered");
  });

  it("throws final codex error after retries are exhausted", async () => {
    const codex = mockCodex([
      {
        output: "",
        isRateLimited: false,
        error: new Error("codex temporary failure")
      },
      {
        output: "",
        isRateLimited: false,
        error: new Error("codex unavailable")
      }
    ]);

    await expect(
      generatePlanFromFreeform(codex, {
        sourceText: "ship feature",
        sourceMode: "text",
        sourceLabel: "inline",
        validationCommands: ["npm test"],
        projectContext: "src/main.tsx, src/App.tsx",
        maxRetries: 1
      })
    ).rejects.toThrow("codex unavailable");
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
