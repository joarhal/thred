import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { markTaskDone, nextPendingTask, parsePlan, parsePlanFile } from "../src/core/plan/parser.js";

describe("plan parser", () => {
  it("parses strict markdown format", () => {
    const input = `# Plan: Add auth\n\n## Overview\nShip authentication with API and UI updates.\n\n## Validation Commands\n- \`npm test\`\n\n### Task 1: API\n- [ ] add endpoint\n- [x] add tests\n\n### Task 2: UI\n- [ ] add screen\n`;

    const plan = parsePlan(input, "/tmp/plan.md");

    expect(plan.title).toBe("Plan: Add auth");
    expect(plan.validationCommands).toEqual(["npm test"]);
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[0]?.items[0]?.checked).toBe(false);
    expect(plan.tasks[0]?.items[1]?.checked).toBe(true);
  });

  it("throws on missing validation section", () => {
    const input = `# Plan: X\n\n## Overview\nDo work.\n\n### Task 1: A\n- [ ] do it\n`;
    expect(() => parsePlan(input, "x.md")).toThrow(/must appear after validation commands section/i);
  });

  it("throws when overview section is missing", () => {
    const input = `# Plan: X\n\n## Validation Commands\n- \`npm test\`\n\n### Task 1: A\n- [ ] do it\n`;
    expect(() => parsePlan(input, "x.md")).toThrow(/validation commands section must appear after overview/i);
  });

  it("throws when title does not start with Plan", () => {
    const input = `# Todo list\n\n## Overview\nDo work.\n\n## Validation Commands\n- \`npm test\`\n\n### Task 1: A\n- [ ] do it\n`;
    expect(() => parsePlan(input, "x.md")).toThrow(/title must start with 'Plan:'/i);
  });

  it("throws when validation section appears before overview", () => {
    const input = `# Plan: X\n\n## Validation Commands\n- \`npm test\`\n\n## Overview\nDo work.\n\n### Task 1: A\n- [ ] do it\n`;
    expect(() => parsePlan(input, "x.md")).toThrow(/validation commands section must appear after overview/i);
  });

  it("throws on plain bullets under task sections", () => {
    const input = `# Plan: X\n\n## Overview\nDo work.\n\n## Validation Commands\n- \`npm test\`\n\n### Task 1: A\n- [ ] do it\n- plain bullet\n`;
    expect(() => parsePlan(input, "x.md")).toThrow(/non-checkbox bullet/i);
  });

  it("throws on unsupported additional h2 sections", () => {
    const input = `# Plan: X\n\n## Overview\nDo work.\n\n## Validation Commands\n- \`npm test\`\n\n## Risks\nNeed fallback.\n\n### Task 1: A\n- [ ] do it\n`;
    expect(() => parsePlan(input, "x.md")).toThrow(/unsupported section header/i);
  });

  it("returns next pending task", () => {
    const input = `# Plan: X\n\n## Overview\nDo work.\n\n## Validation Commands\n- \`npm test\`\n\n### Task 1: A\n- [x] done\n\n### Task 2: B\n- [ ] todo\n`;
    const plan = parsePlan(input, "x.md");
    const task = nextPendingTask(plan);
    expect(task?.number).toBe(2);
  });

  it("marks selected task as done", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-plan-"));
    const planPath = path.join(dir, "plan.md");
    const input = `# Plan: X\n\n## Overview\nDo work.\n\n## Validation Commands\n- \`npm test\`\n\n### Task 1: A\n- [ ] one\n\n### Task 2: B\n- [ ] two\n`;
    await writeFile(planPath, input, "utf8");

    await markTaskDone(planPath, 2);

    const updated = await readFile(planPath, "utf8");
    const parsed = await parsePlanFile(planPath);
    expect(updated).toContain("### Task 2: B");
    expect(parsed.tasks[1]?.items[0]?.checked).toBe(true);
    expect(parsed.tasks[0]?.items[0]?.checked).toBe(false);
  });
});
