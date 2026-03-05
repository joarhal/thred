import { renderPromptTemplate } from "./prompt-templates.js";
import clarificationDecisionTemplate from "./prompts/clarification-decision.md";
import clarificationQuestionTemplate from "./prompts/clarification-question.md";
import planRevisionTemplate from "./prompts/plan-revision.md";

export interface ClarificationOption {
  id: string;
  label: string;
  description: string;
  recommended?: boolean;
}

export interface ClarificationQuestion {
  needsClarification: boolean;
  question?: string;
  options?: ClarificationOption[];
}

export interface ClarificationAnswer {
  question: string;
  answer: string;
}

export interface ClarificationDecision {
  needsClarification: boolean;
  rationale: string;
  unresolvedTopics: string[];
  assumptionsMade: string[];
}

export function buildClarificationDecisionPrompt(input: {
  goal: string;
  answers: ClarificationAnswer[];
  latestUserMessage: string;
  conversationHistory: string;
  currentPlan?: string;
  memoryContext?: string;
}): string {
  const answered =
    input.answers.length === 0
      ? "No clarifications collected yet."
      : input.answers.map((item, index) => `${index + 1}. Q: ${item.question}\n   A: ${item.answer}`).join("\n");
  const memorySection = input.memoryContext ? `\n\nSession memory:\n${input.memoryContext.trimEnd()}` : "";
  const planSection = input.currentPlan ? `\n\nCurrent plan draft:\n${input.currentPlan.trimEnd()}` : "";

  return renderPromptTemplate(clarificationDecisionTemplate, {
    goal: input.goal,
    latestUserMessage: input.latestUserMessage,
    conversationHistory: input.conversationHistory,
    planSection,
    memorySection,
    answered
  });
}

export function buildClarificationQuestionPrompt(input: {
  goal: string;
  answers: ClarificationAnswer[];
  latestUserMessage: string;
  conversationHistory: string;
  unresolvedTopics: string[];
  decisionRationale: string;
  currentPlan?: string;
  memoryContext?: string;
}): string {
  const answered =
    input.answers.length === 0
      ? "No clarifications collected yet."
      : input.answers.map((item, index) => `${index + 1}. Q: ${item.question}\n   A: ${item.answer}`).join("\n");
  const memorySection = input.memoryContext ? `\n\nSession memory:\n${input.memoryContext.trimEnd()}` : "";
  const planSection = input.currentPlan ? `\n\nCurrent plan draft:\n${input.currentPlan.trimEnd()}` : "";

  return renderPromptTemplate(clarificationQuestionTemplate, {
    goal: input.goal,
    latestUserMessage: input.latestUserMessage,
    conversationHistory: input.conversationHistory,
    planSection,
    memorySection,
    answered,
    decisionRationale: input.decisionRationale,
    unresolvedTopics: input.unresolvedTopics.length > 0 ? input.unresolvedTopics.join(", ") : "(none)"
  });
}

export function buildPlanRevisionPrompt(input: {
  goal: string;
  answers: ClarificationAnswer[];
  validationCommands: string[];
  previousPlan: string;
  revisionFeedback: string;
  projectContext?: string;
  memoryContext?: string;
  conversationHistory?: string;
}): string {
  const clarifications =
    input.answers.length === 0
      ? "No clarifications."
      : input.answers.map((item, index) => `${index + 1}. ${item.question} => ${item.answer}`).join("\n");
  const memorySection = input.memoryContext ? `\n\nSession memory:\n${input.memoryContext.trimEnd()}` : "";
  const contextSection = input.projectContext
    ? `\n\nRepository context (use for concrete file-level changes):\n${input.projectContext.trimEnd()}`
    : "";
  const conversationHistorySection = input.conversationHistory
    ? `\n\nConversation history (oldest -> newest):\n${input.conversationHistory.trimEnd()}`
    : "";

  return renderPromptTemplate(planRevisionTemplate, {
    goal: input.goal,
    memorySection,
    contextSection,
    conversationHistorySection,
    clarifications,
    previousPlan: input.previousPlan,
    revisionFeedback: input.revisionFeedback,
    validationCommands: formatValidationCommands(input.validationCommands)
  });
}

export function parseClarificationDecision(raw: string): ClarificationDecision {
  const candidates = extractJsonCandidates(raw);
  if (candidates.length === 0) {
    throw new Error("invalid clarification decision payload: output does not contain JSON object");
  }

  let firstError: Error | null = null;
  for (const candidate of candidates) {
    try {
      return parseClarificationDecisionCandidate(candidate);
    } catch (error) {
      if (firstError === null) {
        firstError = error instanceof Error ? error : new Error("invalid clarification decision payload");
      }
    }
  }

  throw firstError ?? new Error("invalid clarification decision payload");
}

export function parseClarificationQuestion(raw: string): ClarificationQuestion {
  const candidates = extractJsonCandidates(raw);
  if (candidates.length === 0) {
    throw new Error("invalid clarification payload: output does not contain JSON object");
  }

  let firstError: Error | null = null;
  for (const candidate of candidates) {
    try {
      return parseClarificationQuestionCandidate(candidate);
    } catch (error) {
      if (firstError === null) {
        firstError = error instanceof Error ? error : new Error("invalid clarification payload");
      }
    }
  }

  throw firstError ?? new Error("invalid clarification payload");
}

function parseClarificationDecisionCandidate(jsonText: string): ClarificationDecision {
  const parsed = JSON.parse(jsonText) as Partial<ClarificationDecision>;
  if (typeof parsed.needsClarification !== "boolean") {
    throw new Error("invalid clarification decision payload: needsClarification must be boolean");
  }

  const rationale = typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";
  if (!rationale) {
    throw new Error("invalid clarification decision payload: rationale is required");
  }
  const unresolvedTopics = normalizeStringList(parsed.unresolvedTopics);
  const assumptionsMade = normalizeStringList(parsed.assumptionsMade);

  if (parsed.needsClarification && unresolvedTopics.length === 0) {
    throw new Error("invalid clarification decision payload: unresolvedTopics must not be empty when needsClarification=true");
  }
  if (!parsed.needsClarification && unresolvedTopics.length > 0) {
    throw new Error("invalid clarification decision payload: unresolvedTopics must be empty when needsClarification=false");
  }

  return {
    needsClarification: parsed.needsClarification,
    rationale,
    unresolvedTopics,
    assumptionsMade
  };
}

function parseClarificationQuestionCandidate(jsonText: string): ClarificationQuestion {
  const parsed = JSON.parse(jsonText) as Partial<ClarificationQuestion>;
  if (typeof parsed.needsClarification !== "boolean") {
    throw new Error("invalid clarification payload: needsClarification must be boolean");
  }

  if (!parsed.needsClarification) {
    return { needsClarification: false };
  }

  const question = parsed.question?.trim();
  if (!question) {
    throw new Error("invalid clarification payload: question is required");
  }

  if (!Array.isArray(parsed.options)) {
    throw new Error("invalid clarification payload: options must contain 2-4 items");
  }
  if (parsed.options.length < 2 || parsed.options.length > 4) {
    throw new Error("invalid clarification payload: options must contain 2-4 items");
  }

  const options: ClarificationOption[] = [];
  const seenIds = new Set<string>();
  for (const option of parsed.options) {
    if (!option || typeof option.id !== "string" || typeof option.label !== "string" || typeof option.description !== "string") {
      throw new Error("invalid clarification payload: each option must include id, label, description");
    }

    const id = option.id.trim();
    const label = option.label.trim();
    const description = option.description.trim();
    if (!id || !/^[a-z][a-z0-9_]*$/.test(id)) {
      throw new Error("invalid clarification payload: option id must be snake_case");
    }
    if (!label || !description) {
      throw new Error("invalid clarification payload: option label/description must be non-empty");
    }
    if (seenIds.has(id)) {
      throw new Error("invalid clarification payload: option ids must be unique");
    }
    seenIds.add(id);
    options.push({
      id,
      label,
      description,
      recommended: Boolean(option.recommended)
    });
  }

  const recommendedCount = options.filter((option) => Boolean(option.recommended)).length;
  if (recommendedCount !== 1) {
    throw new Error("invalid clarification payload: exactly one option must be recommended");
  }

  return {
    needsClarification: true,
    question,
    options
  };
}

function extractJsonCandidates(rawOutput: string): string[] {
  const trimmed = rawOutput.trim();
  const candidates: string[] = [];
  const seen = new Set<string>();

  const addCandidate = (candidate: string): void => {
    const normalized = candidate.trim();
    if (!normalized || seen.has(normalized) || !isJsonObject(normalized)) {
      return;
    }
    seen.add(normalized);
    candidates.push(normalized);
  };

  const fenceMatches = trimmed.matchAll(/```json\s*([\s\S]*?)\s*```/gi);
  for (const match of fenceMatches) {
    if (match[1]) {
      addCandidate(match[1]);
    }
  }

  const lineCandidates = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}"));
  for (const candidate of lineCandidates) {
    addCandidate(candidate);
  }

  for (const candidate of findJsonObjectCandidates(trimmed)) {
    addCandidate(candidate);
  }

  return candidates;
}

function isJsonObject(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function findJsonObjectCandidates(input: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (!ch) {
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }

    if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(input.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

function normalizeStringList(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return Array.from(new Set(input.filter((item): item is string => typeof item === "string").map((item) => item.trim()))).filter(
    Boolean
  );
}

function formatValidationCommands(commands: string[]): string {
  return commands
    .map((command) => command.trim())
    .filter(Boolean)
    .map((command) => `  - \`${command}\``)
    .join("\n");
}
