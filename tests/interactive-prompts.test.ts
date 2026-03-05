import { describe, expect, it } from "vitest";

import {
  buildClarificationDecisionPrompt,
  buildClarificationQuestionPrompt,
  parseClarificationDecision,
  parseClarificationQuestion
} from "../src/core/codex/prompts-interactive.js";

describe("interactive clarification prompts", () => {
  it("parses clarification decision payload", () => {
    const parsed = parseClarificationDecision(
      JSON.stringify({
        needsClarification: true,
        rationale: "User asked for stack recommendations.",
        unresolvedTopics: ["tech_stack"]
      })
    );

    expect(parsed.needsClarification).toBe(true);
    expect(parsed.rationale).toContain("stack");
    expect(parsed.unresolvedTopics).toEqual(["tech_stack"]);
  });

  it("rejects unresolved topics when needsClarification=false", () => {
    expect(() =>
      parseClarificationDecision(
        JSON.stringify({
          needsClarification: false,
          rationale: "Ready",
          unresolvedTopics: ["scope"]
        })
      )
    ).toThrow(/unresolvedTopics/);
  });

  it("rejects decision payload without rationale", () => {
    expect(() =>
      parseClarificationDecision(
        JSON.stringify({
          needsClarification: true,
          unresolvedTopics: ["scope"]
        })
      )
    ).toThrow(/rationale is required/);
  });

  it("parses valid clarification question payload", () => {
    const parsed = parseClarificationQuestion(
      JSON.stringify({
        needsClarification: true,
        question: "Which stack should we use first?",
        options: [
          { id: "react_vite", label: "React + Vite", description: "Fast component workflow", recommended: true },
          { id: "nextjs", label: "Next.js", description: "SSR-ready from start", recommended: false }
        ]
      })
    );

    expect(parsed.needsClarification).toBe(true);
    expect(parsed.question).toBe("Which stack should we use first?");
    expect(parsed.options).toHaveLength(2);
  });

  it("parses decision payload when output contains multiple json objects", () => {
    const raw = [
      '{"runId":"abc123","phase":"clarification"}',
      '{"needsClarification":true,"rationale":"Need stack choice","unresolvedTopics":["tech_stack"]}',
      '{"tokensUsed":1234}'
    ].join("\n");
    const parsed = parseClarificationDecision(raw);
    expect(parsed.needsClarification).toBe(true);
    expect(parsed.unresolvedTopics).toEqual(["tech_stack"]);
  });

  it("parses question payload when output contains multiple json objects", () => {
    const raw = [
      '{"runId":"abc123"}',
      '{"needsClarification":true,"question":"Pick stack","options":[{"id":"react_vite","label":"React + Vite","description":"DX","recommended":true},{"id":"nextjs","label":"Next.js","description":"SSR","recommended":false}]}',
      '{"tokensUsed":42}'
    ].join("\n");
    const parsed = parseClarificationQuestion(raw);
    expect(parsed.needsClarification).toBe(true);
    expect(parsed.question).toBe("Pick stack");
  });

  it("supports fenced json output", () => {
    const parsed = parseClarificationQuestion(
      ["```json", '{"needsClarification":false}', "```"].join("\n")
    );

    expect(parsed).toEqual({ needsClarification: false });
  });

  it("rejects question payload without exactly one recommended option", () => {
    expect(() =>
      parseClarificationQuestion(
        JSON.stringify({
          needsClarification: true,
          question: "Pick one",
          options: [
            { id: "a", label: "A", description: "A", recommended: false },
            { id: "b", label: "B", description: "B", recommended: false }
          ]
        })
      )
    ).toThrow(/exactly one option must be recommended/);
  });

  it("rejects question payload when option id is not snake_case", () => {
    expect(() =>
      parseClarificationQuestion(
        JSON.stringify({
          needsClarification: true,
          question: "Pick one",
          options: [
            { id: "ReactVite", label: "A", description: "A", recommended: true },
            { id: "nextjs", label: "B", description: "B", recommended: false }
          ]
        })
      )
    ).toThrow(/option id must be snake_case/);
  });

  it("includes conversation and latest-message priority in decision prompt", () => {
    const prompt = buildClarificationDecisionPrompt({
      goal: "Build a landing page",
      answers: [],
      latestUserMessage: "I don't know which framework to choose",
      conversationHistory: "1. user: Build landing page",
      memoryContext: "# Memory\n- Keep setup simple"
    });

    expect(prompt).toContain("Latest user message:");
    expect(prompt).toContain("Conversation history (oldest -> newest):");
    expect(prompt).toContain("Latest user message — if it asks a question");
    expect(prompt).toContain("Session memory:");
  });

  it("includes unresolved topics and decision rationale in question prompt", () => {
    const prompt = buildClarificationQuestionPrompt({
      goal: "Build a landing page",
      answers: [],
      latestUserMessage: "What stack should we use?",
      conversationHistory: "1. user: Build landing page",
      unresolvedTopics: ["tech_stack"],
      decisionRationale: "User explicitly asked for stack options"
    });

    expect(prompt).toContain("Unresolved topics:");
    expect(prompt).toContain("tech_stack");
    expect(prompt).toContain("Decision rationale from previous step:");
    expect(prompt).toContain("Mark exactly one option as recommended=true.");
  });
});
