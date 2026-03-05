import type { CodexRunner } from "../codex/runner.js";
import {
  buildClarificationDecisionPrompt,
  buildClarificationQuestionPrompt,
  parseClarificationDecision,
  parseClarificationQuestion,
  type ClarificationAnswer
} from "../codex/prompts-interactive.js";
import { sleep } from "../util/time.js";
import type { ChoiceItem } from "./ui.js";

export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
}

interface ClarificationCycleLogger {
  startThinking(label: string): void;
  stopThinking(): void;
  debug(msg: string): void;
}

export interface ClarificationCycleInput {
  codex: CodexRunner;
  goal: string;
  existingAnswers: ClarificationAnswer[];
  conversationHistory: ConversationTurn[];
  latestUserMessage: string;
  currentPlan?: string;
  memoryContext?: string;
  maxRounds?: number;
  maxTaskRetries: number;
  waitOnLimitMs: number;
  promptChoice: (input: { title: string; hint?: string; items: ChoiceItem[] }) => Promise<string>;
  promptText: (input: {
    title: string;
    hint?: string;
    placeholder?: string;
    initialValue?: string;
    allowEmpty?: boolean;
  }) => Promise<string>;
  logger: ClarificationCycleLogger;
  onWarning?: (message: string) => void;
}

export interface ClarificationCycleResult {
  allAnswers: ClarificationAnswer[];
  addedAnswers: ClarificationAnswer[];
  softFallbackUsed: boolean;
}

export async function runClarificationCycle(input: ClarificationCycleInput): Promise<ClarificationCycleResult> {
  const answers: ClarificationAnswer[] = [...input.existingAnswers];
  const addedAnswers: ClarificationAnswer[] = [];
  const maxRounds = input.maxRounds ?? 8;
  const askedQuestionKeys = new Set(answers.map((answer) => normalizeQuestionKey(answer.question)));
  let latestUserMessage = input.latestUserMessage.trim() || input.goal.trim();
  let softFallbackUsed = false;
  let resolved = false;

  for (let round = 1; round <= maxRounds; round += 1) {
    const decisionPrompt = buildClarificationDecisionPrompt({
      goal: input.goal,
      answers,
      latestUserMessage,
      conversationHistory: formatConversationHistory(input.conversationHistory),
      currentPlan: input.currentPlan,
      memoryContext: input.memoryContext
    });

    const decision = await requestDecision({
      codex: input.codex,
      prompt: decisionPrompt,
      maxTaskRetries: input.maxTaskRetries,
      waitOnLimitMs: input.waitOnLimitMs,
      logger: input.logger,
      label: `clarification decision round ${round}`
    });

    if (!decision) {
      softFallbackUsed = true;
      input.onWarning?.("clarification decision failed; continuing with current state");
      break;
    }

    if (!decision.needsClarification) {
      resolved = true;
      break;
    }

    const questionPrompt = buildClarificationQuestionPrompt({
      goal: input.goal,
      answers,
      latestUserMessage,
      conversationHistory: formatConversationHistory(input.conversationHistory),
      unresolvedTopics: decision.unresolvedTopics,
      decisionRationale: decision.rationale,
      currentPlan: input.currentPlan,
      memoryContext: input.memoryContext
    });

    const question = await requestQuestion({
      codex: input.codex,
      prompt: questionPrompt,
      maxTaskRetries: input.maxTaskRetries,
      waitOnLimitMs: input.waitOnLimitMs,
      logger: input.logger,
      label: `clarification question round ${round}`
    });

    if (!question?.needsClarification || !question.question || !question.options) {
      softFallbackUsed = true;
      input.onWarning?.("clarification question generation failed; continuing with current state");
      break;
    }

    const questionText = question.question.trim();
    const questionKey = normalizeQuestionKey(questionText);
    if (askedQuestionKeys.has(questionKey)) {
      softFallbackUsed = true;
      input.onWarning?.("clarification loop repeated the same question; continuing with current state");
      break;
    }
    askedQuestionKeys.add(questionKey);
    const options = question.options;
    pushConversationTurn(input.conversationHistory, "assistant", questionText);

    const selected = await input.promptChoice({
      title: questionText,
      hint: "Choose an option or select free text",
      items: [
        ...options.map((option) => ({
          value: `option:${option.id}`,
          label: option.label,
          description: option.description,
          recommended: option.recommended
        })),
        {
          value: "free_text",
          label: "Free text",
          description: "Type your own answer"
        }
      ]
    });

    let answer = "";
    if (selected === "free_text") {
      answer = await input.promptText({
        title: "Enter your answer",
        placeholder: "free-form answer"
      });
    } else {
      const optionId = selected.replace(/^option:/, "");
      const option = options.find((item) => item.id === optionId);
      if (!option) {
        softFallbackUsed = true;
        input.onWarning?.("clarification answer selection was invalid; continuing with current state");
        break;
      }
      answer = `${option.label}: ${option.description}`;
    }

    const answered: ClarificationAnswer = {
      question: questionText,
      answer
    };
    answers.push(answered);
    addedAnswers.push(answered);
    pushConversationTurn(input.conversationHistory, "user", answer);
    latestUserMessage = answer;
  }

  if (!resolved && !softFallbackUsed && maxRounds > 0) {
    softFallbackUsed = true;
    input.onWarning?.(`clarification loop reached max rounds (${maxRounds}); continuing with current state`);
  }

  return {
    allAnswers: answers,
    addedAnswers,
    softFallbackUsed
  };
}

async function requestDecision(input: {
  codex: CodexRunner;
  prompt: string;
  maxTaskRetries: number;
  waitOnLimitMs: number;
  logger: ClarificationCycleLogger;
  label: string;
}) {
  let previousInvalidOutput = "";
  let parseError = "";

  for (let parseAttempt = 1; parseAttempt <= input.maxTaskRetries + 1; parseAttempt += 1) {
    const prompt =
      parseAttempt === 1
        ? input.prompt
        : [
            input.prompt,
            "",
            "Previous output was invalid JSON for this schema.",
            `Parse error: ${parseError}`,
            "Previous invalid output:",
            previousInvalidOutput,
            "",
            "Return corrected JSON only."
          ].join("\n");

    const result = await runCodexWithRetries({
      codex: input.codex,
      prompt,
      maxTaskRetries: input.maxTaskRetries,
      waitOnLimitMs: input.waitOnLimitMs,
      logger: input.logger,
      label: input.label
    });
    previousInvalidOutput = result.output;

    try {
      return parseClarificationDecision(result.output);
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }
  }

  return undefined;
}

async function requestQuestion(input: {
  codex: CodexRunner;
  prompt: string;
  maxTaskRetries: number;
  waitOnLimitMs: number;
  logger: ClarificationCycleLogger;
  label: string;
}) {
  let previousInvalidOutput = "";
  let parseError = "";

  for (let parseAttempt = 1; parseAttempt <= input.maxTaskRetries + 1; parseAttempt += 1) {
    const prompt =
      parseAttempt === 1
        ? input.prompt
        : [
            input.prompt,
            "",
            "Previous output was invalid JSON for this schema.",
            `Parse error: ${parseError}`,
            "Previous invalid output:",
            previousInvalidOutput,
            "",
            "Return corrected JSON only."
          ].join("\n");

    const result = await runCodexWithRetries({
      codex: input.codex,
      prompt,
      maxTaskRetries: input.maxTaskRetries,
      waitOnLimitMs: input.waitOnLimitMs,
      logger: input.logger,
      label: input.label
    });
    previousInvalidOutput = result.output;

    try {
      return parseClarificationQuestion(result.output);
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }
  }

  return undefined;
}

async function runCodexWithRetries(input: {
  codex: CodexRunner;
  prompt: string;
  maxTaskRetries: number;
  waitOnLimitMs: number;
  logger: ClarificationCycleLogger;
  label: string;
}): Promise<{ output: string }> {
  const maxAttempts = input.maxTaskRetries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    input.logger.debug(`${input.label}: codex attempt ${attempt}/${maxAttempts}`);
    input.logger.startThinking(`${input.label} (${attempt}/${maxAttempts})`);
    let result;
    try {
      result = await input.codex.run(input.prompt);
    } finally {
      input.logger.stopThinking();
    }

    if (result.isRateLimited) {
      input.logger.debug(`${input.label}: rate limit detected, waiting ${input.waitOnLimitMs}ms`);
      await sleep(input.waitOnLimitMs);
      continue;
    }

    if (!result.error) {
      return { output: result.output };
    }

    if (attempt < maxAttempts) {
      input.logger.debug(`${input.label}: codex failed, retrying`);
      continue;
    }

    throw result.error;
  }

  throw new Error(`codex failed for ${input.label}`);
}

function pushConversationTurn(history: ConversationTurn[], role: ConversationTurn["role"], text: string): void {
  const normalized = text.trim();
  if (!normalized) {
    return;
  }
  history.push({ role, text: normalized });
}

function formatConversationHistory(history: ConversationTurn[]): string {
  if (history.length === 0) {
    return "";
  }
  return history.map((turn, index) => `${index + 1}. ${turn.role}: ${turn.text}`).join("\n");
}

function normalizeQuestionKey(input: string): string {
  return input.trim().replace(/\s+/g, " ").toLowerCase();
}
