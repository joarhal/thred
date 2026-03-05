import { renderPromptTemplate } from "./prompt-templates.js";
import planGenerationTemplate from "./prompts/plan-generation.md";
import planRepairTemplate from "./prompts/plan-repair.md";
import planReviewTemplate from "./prompts/plan-review.md";
import { normalizeMarkdownPlan, normalizeValidationCommands } from "../plan/parser.js";

export function buildPlanGenerationPrompt(input: {
  sourceText: string;
  sourceMode: "file" | "text";
  sourceLabel: string;
  validationCommands: string[];
  projectContext: string;
  memoryContext?: string;
}): string {
  const memorySection = buildOptionalSection("Session memory:", input.memoryContext);
  return renderPromptTemplate(planGenerationTemplate, {
    sourceMode: input.sourceMode,
    sourceLabel: input.sourceLabel,
    sourceText: input.sourceText,
    projectContext: input.projectContext,
    validationCommands: formatValidationCommands(input.validationCommands),
    memorySection
  });
}

export function buildPlanRepairPrompt(input: {
  sourceText: string;
  sourceMode: "file" | "text";
  sourceLabel: string;
  validationCommands: string[];
  projectContext: string;
  memoryContext?: string;
  parseError: string;
  previousOutput: string;
}): string {
  return renderPromptTemplate(planRepairTemplate, {
    parseError: input.parseError,
    previousOutput: input.previousOutput,
    planGenerationPrompt: buildPlanGenerationPrompt({
      sourceText: input.sourceText,
      sourceMode: input.sourceMode,
      sourceLabel: input.sourceLabel,
      validationCommands: input.validationCommands,
      projectContext: input.projectContext,
      memoryContext: input.memoryContext
    })
  });
}

export function buildPlanReviewPrompt(input: {
  sourceText: string;
  sourceMode: "file" | "text";
  sourceLabel: string;
  currentPlan: string;
  projectContext: string;
  validationCommands: string[];
  priorFeedback?: string;
}): string {
  const priorFeedbackSection = buildOptionalSection(
    "Previous review feedback that MUST be fixed:",
    input.priorFeedback
  );
  return renderPromptTemplate(planReviewTemplate, {
    sourceMode: input.sourceMode,
    sourceLabel: input.sourceLabel,
    sourceText: input.sourceText,
    projectContext: input.projectContext,
    priorFeedbackSection,
    currentPlan: normalizeMarkdownPlan(input.currentPlan, "<review-prompt-plan>"),
    validationCommands: formatValidationCommands(input.validationCommands)
  });
}

function formatValidationCommands(commands: string[]): string {
  const normalized = normalizeValidationCommands(commands);
  const unique = Array.from(new Set(normalized));
  if (unique.length === 0) {
    return "- `true`";
  }
  return unique.map((cmd) => `- \`${cmd}\``).join("\n");
}

function buildOptionalSection(title: string, content?: string): string {
  if (!content?.trim()) {
    return "";
  }
  return `\n\n${title}\n${content.trimEnd()}`;
}
