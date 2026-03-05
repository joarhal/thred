import { describe, expect, it, vi } from "vitest";

import { runClarificationCycle, type ConversationTurn } from "../src/core/interactive/clarification-cycle.js";

describe("runClarificationCycle", () => {
  it("loops until codex marks clarification complete", async () => {
    const codex = mockCodex([
      {
        output: JSON.stringify({
          needsClarification: true,
          rationale: "Need stack decision",
          unresolvedTopics: ["tech_stack"]
        }),
        isRateLimited: false
      },
      {
        output: JSON.stringify({
          needsClarification: true,
          question: "Which stack for first iteration?",
          options: [
            { id: "react_vite", label: "React + Vite", description: "Fast DX", recommended: true },
            { id: "nextjs", label: "Next.js", description: "SSR-ready", recommended: false }
          ]
        }),
        isRateLimited: false
      },
      {
        output: JSON.stringify({
          needsClarification: false,
          rationale: "Decision is now explicit.",
          unresolvedTopics: []
        }),
        isRateLimited: false
      }
    ]);

    const history: ConversationTurn[] = [{ role: "user", text: "landing page. what stack should I use?" }];
    const result = await runClarificationCycle({
      codex,
      goal: "Build a landing page",
      existingAnswers: [],
      conversationHistory: history,
      latestUserMessage: "landing page. what stack should I use?",
      maxTaskRetries: 0,
      waitOnLimitMs: 0,
      promptChoice: async () => "option:react_vite",
      promptText: async () => "unused",
      logger: {
        startThinking: () => undefined,
        stopThinking: () => undefined,
        debug: () => undefined
      }
    });

    expect(result.softFallbackUsed).toBe(false);
    expect(result.addedAnswers).toHaveLength(1);
    expect(result.allAnswers).toHaveLength(1);
    expect(result.allAnswers[0]?.question).toContain("Which stack");
    expect(result.allAnswers[0]?.answer).toContain("React + Vite");
    expect(history.map((turn) => turn.role)).toEqual(["user", "assistant", "user"]);
    expect(codex.prompts).toHaveLength(3);
    expect(codex.prompts[0]).toContain("Conversation history (oldest -> newest):");
    expect(codex.prompts[0]).not.toContain("{{");
    expect(codex.prompts[1]).not.toContain("{{");
  });

  it("soft-fallbacks when decision parsing fails", async () => {
    const codex = mockCodex([{ output: "not-json", isRateLimited: false }]);
    const warnings: string[] = [];
    const promptChoice = vi.fn(async () => "option:a");

    const result = await runClarificationCycle({
      codex,
      goal: "Build a landing page",
      existingAnswers: [],
      conversationHistory: [{ role: "user", text: "lening" }],
      latestUserMessage: "lening",
      maxTaskRetries: 0,
      waitOnLimitMs: 0,
      promptChoice,
      promptText: async () => "text",
      logger: {
        startThinking: () => undefined,
        stopThinking: () => undefined,
        debug: () => undefined
      },
      onWarning: (message) => warnings.push(message)
    });

    expect(result.softFallbackUsed).toBe(true);
    expect(result.addedAnswers).toHaveLength(0);
    expect(promptChoice).not.toHaveBeenCalled();
    expect(warnings.length).toBeGreaterThan(0);
    expect(codex.prompts[0]).not.toContain("{{");
  });

  it("retries after rate limit and continues clarification flow", async () => {
    const codex = mockCodex([
      { output: "", isRateLimited: true },
      {
        output: JSON.stringify({
          needsClarification: false,
          rationale: "Enough context",
          unresolvedTopics: []
        }),
        isRateLimited: false
      }
    ]);

    const result = await runClarificationCycle({
      codex,
      goal: "Build a landing page",
      existingAnswers: [],
      conversationHistory: [{ role: "user", text: "need landing" }],
      latestUserMessage: "need landing",
      maxTaskRetries: 1,
      waitOnLimitMs: 0,
      promptChoice: async () => "free_text",
      promptText: async () => "unused",
      logger: {
        startThinking: () => undefined,
        stopThinking: () => undefined,
        debug: () => undefined
      }
    });

    expect(result.softFallbackUsed).toBe(false);
    expect(result.addedAnswers).toHaveLength(0);
    expect(codex.prompts).toHaveLength(2);
  });

  it("throws after codex errors exhaust retries", async () => {
    const codex = mockCodex([
      { output: "", isRateLimited: false, error: new Error("temporary outage") },
      { output: "", isRateLimited: false, error: new Error("still unavailable") }
    ]);

    await expect(
      runClarificationCycle({
        codex,
        goal: "Build a landing page",
        existingAnswers: [],
        conversationHistory: [{ role: "user", text: "need landing" }],
        latestUserMessage: "need landing",
        maxTaskRetries: 1,
        waitOnLimitMs: 0,
        promptChoice: async () => "free_text",
        promptText: async () => "unused",
        logger: {
          startThinking: () => undefined,
          stopThinking: () => undefined,
          debug: () => undefined
        }
      })
    ).rejects.toThrow("still unavailable");

    expect(codex.prompts).toHaveLength(2);
  });

  it("soft-fallbacks when loop reaches max rounds without resolving clarification", async () => {
    const codex = mockCodex([
      {
        output: JSON.stringify({
          needsClarification: true,
          rationale: "Still missing stack",
          unresolvedTopics: ["tech_stack"]
        }),
        isRateLimited: false
      },
      {
        output: JSON.stringify({
          needsClarification: true,
          question: "Pick stack",
          options: [
            { id: "react_vite", label: "React + Vite", description: "DX", recommended: true },
            { id: "nextjs", label: "Next.js", description: "SSR", recommended: false }
          ]
        }),
        isRateLimited: false
      }
    ]);

    const warnings: string[] = [];
    const result = await runClarificationCycle({
      codex,
      goal: "Build a landing page",
      existingAnswers: [],
      conversationHistory: [{ role: "user", text: "need landing" }],
      latestUserMessage: "need landing",
      maxRounds: 1,
      maxTaskRetries: 0,
      waitOnLimitMs: 0,
      promptChoice: async () => "option:react_vite",
      promptText: async () => "unused",
      logger: {
        startThinking: () => undefined,
        stopThinking: () => undefined,
        debug: () => undefined
      },
      onWarning: (message) => warnings.push(message)
    });

    expect(result.addedAnswers).toHaveLength(1);
    expect(result.softFallbackUsed).toBe(true);
    expect(warnings.join("\n")).toMatch(/reached max rounds/i);
  });
});

function mockCodex(outputs: Array<{ output: string; isRateLimited: boolean; error?: Error }>) {
  let index = 0;
  const prompts: string[] = [];
  return {
    prompts,
    run: async (prompt: string) => {
      prompts.push(prompt);
      const next = outputs[index] ?? outputs[outputs.length - 1] ?? { output: "", isRateLimited: false };
      index += 1;
      return next;
    }
  } as any;
}
