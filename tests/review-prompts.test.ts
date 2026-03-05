import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildReviewFixPrompt,
  buildReviewPrompt,
  buildReviewPromptMultiAgentFocused,
  buildReviewPromptMultiAgent
} from "../src/core/codex/prompts.js";
import {
  buildPlanGenerationPrompt,
  buildPlanRepairPrompt,
  buildPlanReviewPrompt
} from "../src/core/codex/prompts-plan.js";

describe("review prompts", () => {
  it("builds a multi-agent review prompt using all configured agent files", () => {
    const prompt = buildReviewPromptMultiAgent("main", "docs/plans/123.md");
    const agentsDir = path.join(process.cwd(), "src/core/codex/prompts/review-agents");
    const agentNames = readdirSync(agentsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name.replace(/\.md$/i, "").replace(/[-_]+/g, " "));

    expect(agentNames.length).toBeGreaterThan(0);
    expect(prompt).toContain(`Launch ${agentNames.length} review agents in parallel`);
    for (const agentName of agentNames) {
      expect(prompt).toContain(`Agent ${agentName}`);
    }
    expect(prompt).toContain("git log main..HEAD --oneline");
    expect(prompt).toContain("git diff main...HEAD");
    expect(prompt).toContain("git diff --stat main...HEAD");
    expect(prompt).toContain("Sub-reviewers must return findings in free-form plain text");
    expect(prompt).toContain("Sub-reviewer outputs are free-form text.");
    expect(prompt).toContain("Output must contain exactly one JSON object and nothing else.");
    expect(prompt).toContain("Do not output drafts, alternatives, retries, or multiple JSON payloads.");
    expect(prompt).toContain("Never print a second JSON object for corrections");
    expect(prompt).toContain("Do not include any braces `{}` outside the final JSON object.");
    expect(prompt).not.toContain("Example (clean):");
    expect(prompt).not.toContain("<base>");
    expect(prompt).toContain('"overallStatus":"clean|issues_found"');
  });

  it("omits git commands in no-git review prompts", () => {
    const prompt = buildReviewPromptMultiAgentFocused("local", "docs/plans/123.md", ["critical"], {
      isGit: false
    });

    expect(prompt).toContain("Git is unavailable in this run");
    expect(prompt).not.toContain("git log");
    expect(prompt).not.toContain("git diff");
  });

  it("keeps buildReviewPrompt mapped to multi-agent behavior", () => {
    const prompt = buildReviewPrompt("main", "docs/plans/123.md");
    expect(prompt).toContain("Launch");
    expect(prompt).toContain("review agents in parallel");
  });

  it("adds severity focus instructions for focused prompts", () => {
    const multi = buildReviewPromptMultiAgentFocused("main", "docs/plans/123.md", ["critical"]);

    expect(multi).toContain("Focus primarily on critical findings");
    expect(multi).not.toContain("Focus primarily on medium");
  });

  it("supports selecting specific review agents per pass", () => {
    const prompt = buildReviewPromptMultiAgentFocused("main", "docs/plans/123.md", ["critical"], {
      agentNames: ["documentation", "quality"]
    });

    expect(prompt).toContain("Launch 2 review agents in parallel");
    expect(prompt).toContain("Agent documentation");
    expect(prompt).toContain("Agent quality");
    expect(prompt).not.toContain("Agent testing");
  });

  it("loads project-level review agents from thred.review-agents", () => {
    const fixtureCwd = mkdtempSync(path.join(os.tmpdir(), "thred-review-agents-"));
    const projectAgentsDir = path.join(fixtureCwd, "thred.review-agents");
    mkdirSync(projectAgentsDir, { recursive: true });
    writeFileSync(
      path.join(projectAgentsDir, "project-only.md"),
      "Review project-specific architecture deviations.",
      "utf8"
    );

    const prompt = buildReviewPromptMultiAgentFocused("main", "docs/plans/123.md", ["high"], {
      cwd: fixtureCwd,
      agentNames: ["project-only"]
    });

    expect(prompt).toContain("Launch 1 review agents in parallel");
    expect(prompt).toContain("Agent project only");
  });

  it("allows literal double-brace snippets inside injected variables", () => {
    const prompt = buildReviewFixPrompt(
      [
        {
          id: "F-1",
          severity: "high",
          file: "src/core/codex/prompts/review-multi-agent.md",
          line: 2,
          summary: "Template includes literal placeholder `{{baseRef}}` in content",
          rationale: "Must preserve literal placeholder in findings payload."
        }
      ],
      ["npm test"]
    );

    expect(prompt).toContain("{{baseRef}}");
    expect(prompt).toContain("Findings JSON:");
  });

  it("renders plan-generation and plan-repair templates without unresolved placeholders", () => {
    const generation = buildPlanGenerationPrompt({
      sourceText: "ship feature",
      sourceMode: "text",
      sourceLabel: "inline",
      validationCommands: ["npm test", "npm run build"],
      projectContext: "src/main.tsx\nsrc/App.tsx"
    });
    const repair = buildPlanRepairPrompt({
      sourceText: "ship feature",
      sourceMode: "text",
      sourceLabel: "inline",
      validationCommands: ["npm test", "npm run build"],
      projectContext: "src/main.tsx\nsrc/App.tsx",
      parseError: "missing overview section",
      previousOutput: "# Plan: Demo"
    });

    expect(generation).not.toContain("{{");
    expect(repair).not.toContain("{{");
    expect(generation).toContain("## Overview");
    expect(generation).toContain("## Validation Commands");
    expect(generation).not.toContain("## Final Validation");
    expect(generation).toContain("plain list bullets under tasks");
    expect(repair).toContain("Regeneration contract:");
  });

  it("uses true as validation fallback when commands list is empty", () => {
    const generation = buildPlanGenerationPrompt({
      sourceText: "ship feature",
      sourceMode: "text",
      sourceLabel: "inline",
      validationCommands: [],
      projectContext: "src/main.tsx"
    });

    expect(generation).toContain("- `true`");
    expect(generation).not.toContain("git status --short");
  });

  it("renders strict plan-review prompt contract", () => {
    const prompt = buildPlanReviewPrompt({
      sourceText: "ship feature",
      sourceMode: "text",
      sourceLabel: "inline",
      currentPlan: "# Plan: Demo",
      projectContext: "src/main.tsx\nsrc/App.tsx",
      validationCommands: ["npm test"],
      priorFeedback: "keep validation commands unchanged"
    });

    expect(prompt).not.toContain("{{");
    expect(prompt).toContain("Return exactly one JSON object only");
    expect(prompt).toContain("revisedPlanMarkdown");
    expect(prompt).toContain("commands unchanged");
    expect(prompt).toContain("## Validation Commands");
    expect(prompt).toContain("status` MUST be `needs_revision");
    expect(prompt).toContain("Do not ask the user to fix the plan manually");
    expect(prompt).not.toContain("## Final Validation");
  });
});
