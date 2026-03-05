import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  MEMORY_SOFT_LIMIT_CHARS,
  buildMemoryCompressionPrompt,
  buildMemoryRewritePrompt,
  loadMemorySnapshot,
  parseMemoryRewriteResponse,
  saveMemoryContent
} from "../src/core/memory/service.js";

describe("memory service", () => {
  it("creates MEMORY.md when missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-memory-"));
    const snapshot = await loadMemorySnapshot(dir);

    expect(snapshot.path.endsWith(path.join(".thred", "MEMORY.md"))).toBe(true);
    expect(snapshot.content).toContain("# Thred Memory");
  });

  it("does not auto-trim long memory files", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-memory-"));
    const memoryPath = path.join(dir, ".thred", "MEMORY.md");
    await mkdir(path.dirname(memoryPath), { recursive: true });
    const long = [
      "# Thred Memory",
      "",
      "## Notes",
      ...Array.from({ length: 900 }, (_, i) => `- note ${i + 1}: validation-and-edge-case-summary-for-memory-compaction`)
    ].join("\n");
    await writeFile(memoryPath, `${long}\n`, "utf8");

    const snapshot = await loadMemorySnapshot(dir);
    expect(snapshot.lineCount).toBeGreaterThan(500);
    expect(snapshot.charCount).toBeGreaterThan(MEMORY_SOFT_LIMIT_CHARS);
  });

  it("parses full markdown rewrite output", () => {
    const parsed = parseMemoryRewriteResponse(
      [
        "```markdown",
        "# Thred Memory",
        "",
        "## Notes",
        "- keep commits focused",
        "```"
      ].join("\n")
    );

    expect(parsed).toContain("# Thred Memory");
    expect(parsed).toContain("keep commits focused");
  });

  it("saves rewritten memory content", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-memory-"));
    const saved = await saveMemoryContent(
      dir,
      ["# Thred Memory", "", "## Notes", "- reusable note"].join("\n")
    );

    const file = await readFile(saved.path, "utf8");
    expect(file).toContain("- reusable note");
  });

  it("includes char soft-limit and task summary instructions in rewrite prompt", () => {
    const prompt = buildMemoryRewritePrompt({
      memoryContent: "# Thred Memory\n\n## Notes\n- old",
      memoryLineCount: 10,
      memoryCharCount: 120,
      softLimitChars: MEMORY_SOFT_LIMIT_CHARS,
      planTitle: "Plan: Demo",
      planPath: "docs/plans/demo.md",
      completedTasks: [
        {
          number: 1,
          title: "Implement",
          checklist: ["do work"],
          summary: "done"
        }
      ],
      encounteredIssues: ["validation failed once, then fixed"]
    });

    expect(prompt).toContain(`Soft limit: target <= ${MEMORY_SOFT_LIMIT_CHARS} characters`);
    expect(prompt).toContain("Completed tasks this run:");
    expect(prompt).toContain("Encountered issues and edge-cases this run:");
  });

  it("builds compression prompt with hard char target", () => {
    const prompt = buildMemoryCompressionPrompt({
      memoryContent: "# Thred Memory\n\n## Notes\n- very long",
      currentCharCount: 9999,
      softLimitChars: MEMORY_SOFT_LIMIT_CHARS
    });

    expect(prompt).toContain(`HARD target: <= ${MEMORY_SOFT_LIMIT_CHARS} characters`);
    expect(prompt).toContain("Current chars: 9999");
  });
});
