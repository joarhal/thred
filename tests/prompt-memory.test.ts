import { describe, expect, it } from "vitest";

import {
  buildClarificationDecisionPrompt,
  buildClarificationQuestionPrompt,
  buildPlanRevisionPrompt
} from "../src/core/codex/prompts-interactive.js";
import { buildTaskPrompt, buildValidationFixPrompt } from "../src/core/codex/prompts.js";
import { buildPlanGenerationPrompt, buildPlanReviewPrompt } from "../src/core/codex/prompts-plan.js";
import type { PlanDocument, PlanTask } from "../src/types.js";

describe("memory prompt context", () => {
  const memory = "# Thred Memory\n- keep commits focused";
  const plan: PlanDocument = {
    title: "Plan: Demo",
    validationCommands: ["npm test"],
    tasks: [],
    path: "docs/plans/demo.md"
  };
  const task: PlanTask = {
    number: 1,
    title: "Implement",
    items: [{ text: "ship feature", checked: false }]
  };

  it("injects memory into task prompts", () => {
    const taskPrompt = buildTaskPrompt(plan, task, memory);
    const fixPrompt = buildValidationFixPrompt(plan, task, "test failed", memory);

    expect(taskPrompt).toContain("Session memory:");
    expect(taskPrompt).toContain(memory);
    expect(fixPrompt).toContain("Session memory:");
    expect(fixPrompt).toContain(memory);
  });

  it("injects memory into plan-generation prompts", () => {
    const prompt = buildPlanGenerationPrompt({
      sourceText: "build feature",
      sourceMode: "text",
      sourceLabel: "inline",
      validationCommands: ["npm test"],
      projectContext: "src/main.tsx, src/App.tsx",
      memoryContext: memory
    });

    expect(prompt).toContain("Session memory:");
    expect(prompt).toContain(memory);
  });

  it("injects project context into plan-review prompt", () => {
    const prompt = buildPlanReviewPrompt({
      sourceText: "ship feature",
      sourceMode: "text",
      sourceLabel: "inline",
      currentPlan: "# Plan: Demo",
      projectContext: "src/main.tsx, src/App.tsx",
      validationCommands: ["npm test"]
    });

    expect(prompt).toContain("Repository context (MANDATORY):");
    expect(prompt).toContain("src/main.tsx");
    expect(prompt).toContain("status");
  });

  it("injects memory into interactive prompts", () => {
    const decision = buildClarificationDecisionPrompt({
      goal: "ship feature",
      answers: [],
      latestUserMessage: "Which stack should we choose?",
      conversationHistory: "1. user: ship feature",
      memoryContext: memory
    });
    const question = buildClarificationQuestionPrompt({
      goal: "ship feature",
      answers: [{ question: "Scope?", answer: "MVP" }],
      latestUserMessage: "give me options",
      conversationHistory: "1. user: ship feature\n2. assistant: Scope?\n3. user: MVP",
      unresolvedTopics: ["tech_stack"],
      decisionRationale: "User asked for options",
      currentPlan: "# Plan: Draft\n\n### Task 1: A\n- [ ] do A",
      memoryContext: memory
    });

    const revision = buildPlanRevisionPrompt({
      goal: "ship feature",
      answers: [],
      validationCommands: ["npm test"],
      previousPlan: "# Plan: Draft",
      revisionFeedback: "split tasks",
      memoryContext: memory,
      conversationHistory: "1. user: ship feature\n2. assistant: Which scope?"
    });

    expect(decision).toContain("Session memory:");
    expect(decision).toContain(memory);
    expect(question).toContain("Current plan draft:");
    expect(question).toContain("Session memory:");
    expect(question).toContain(memory);
    expect(revision).toContain("Session memory:");
    expect(revision).toContain(memory);
    expect(revision).toContain("Conversation history (oldest -> newest):");
  });
});
