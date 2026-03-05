import { buildPlanGenerationPrompt, buildPlanRepairPrompt } from "../codex/prompts-plan.js";
import {
  getValidationCommandMismatchReason,
  normalizeMarkdownPlan,
  normalizeValidationCommands,
  parsePlan,
  renderPlanMarkdown
} from "./parser.js";

export interface GeneratePlanInput {
  sourceText: string;
  sourceMode: "file" | "text";
  sourceLabel: string;
  validationCommands: string[];
  projectContext: string;
  memoryContext?: string;
  maxRetries: number;
}

export interface GeneratedPlan {
  content: string;
  title: string;
}

interface PlanGeneratorClient {
  run(prompt: string): Promise<{ output: string; error?: Error; isRateLimited: boolean }>;
}

export async function generatePlanFromFreeform(
  codex: PlanGeneratorClient,
  input: GeneratePlanInput
): Promise<GeneratedPlan> {
  const maxAttempts = input.maxRetries + 1;
  const generationPrompt = buildPlanGenerationPrompt({
    sourceText: input.sourceText,
    sourceMode: input.sourceMode,
    sourceLabel: input.sourceLabel,
    validationCommands: input.validationCommands,
    projectContext: input.projectContext,
    memoryContext: input.memoryContext
  });
  const expectedValidationCommands = normalizeValidationCommands(input.validationCommands);

  let parseError = "";
  let previousInvalidOutput = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const prompt =
      parseError.trim().length === 0
        ? generationPrompt
        : buildPlanRepairPrompt({
            sourceText: input.sourceText,
            sourceMode: input.sourceMode,
            sourceLabel: input.sourceLabel,
            validationCommands: input.validationCommands,
            projectContext: input.projectContext,
            memoryContext: input.memoryContext,
            parseError,
            previousOutput: previousInvalidOutput
          });

    const result = await codex.run(prompt);
    if (result.error) {
      if (attempt < maxAttempts) {
        continue;
      }
      throw result.error;
    }

    const normalized = normalizeMarkdownPlan(result.output, "<generated-plan>");
    previousInvalidOutput = normalized;

    try {
      const parsed = parsePlan(normalized, "<generated-plan>");
      const commandMismatchReason = getValidationCommandMismatchReason(
        parsed.validationCommands,
        expectedValidationCommands
      );
      if (commandMismatchReason) {
        parseError =
          "Plan changed required validation commands. " +
          `Keep commands EXACTLY unchanged in content and order. ${commandMismatchReason}.`;
        if (attempt < maxAttempts) {
          continue;
        }
        throw new Error(parseError);
      }

      return {
        content: ensureTrailingNewline(renderPlanMarkdown(parsed)),
        title: parsed.title
      };
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
      if (attempt < maxAttempts) {
        continue;
      }
      throw new Error(`failed to generate a valid plan: ${parseError}`);
    }
  }

  throw new Error("failed to generate a valid plan");
}

function ensureTrailingNewline(input: string): string {
  return input.endsWith("\n") ? input : `${input}\n`;
}
