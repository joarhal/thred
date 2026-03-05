import { randomUUID } from "node:crypto";

import { CodexRunner } from "../codex/runner.js";
import {
  buildPlanRevisionPrompt,
  type ClarificationAnswer
} from "../codex/prompts-interactive.js";
import { executePlan, type ExecutionBootstrapContext } from "../execute/run-plan.js";
import { detectValidationCommands } from "../plan/validation-detect.js";
import { generatePlanFromFreeform, type GeneratedPlan } from "../plan/generate.js";
import {
  getValidationCommandMismatchReason,
  normalizeMarkdownPlan,
  normalizeValidationCommands,
  parsePlan,
  renderPlanMarkdown
} from "../plan/parser.js";
import { buildProjectContextSnapshot } from "../plan/project-context.js";
import { reviewGeneratedPlan } from "../plan/review.js";
import { saveGeneratedPlan } from "../plan/save.js";
import {
  createToolCompactFilterState,
  extractToolProgressBullet,
  selectCompactToolLine,
  shouldSuppressToolLine,
  type ToolCompactFilterState
} from "../ui/terminal.js";
import { toDisplayPath } from "../util/path-display.js";
import { sleep } from "../util/time.js";
import { runClarificationCycle, type ConversationTurn } from "./clarification-cycle.js";
import { removePlanAndCommitDeletionIfTracked } from "./plan-cleanup.js";
import { cleanupInteractivePreflight } from "./preflight-cleanup.js";
import {
  clearTerminalScreen,
  clearPlanPreview,
  configureInteractiveOutput,
  getInteractiveProgressSink,
  printDebug,
  printInfo,
  printPlanPreview,
  printSection,
  printWarn,
  promptChoice,
  promptText,
  setThinkingIndicator,
  shutdownInteractiveOutput
} from "./ui.js";
import { listUnfinishedPlans } from "./unfinished-plan.js";

export interface InteractiveSessionOptions {
  cwd: string;
  isGit: boolean;
  baseBranch?: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  initialGoal?: string;
  initialSourceLabel?: string;
  memoryContext?: string;
  maxTaskRetries: number;
  maxReviewIterations: number;
  maxExternalIterations: number;
  reviewPatience: number;
  waitOnLimitMs: number;
  noColor: boolean;
  verbose: boolean;
  executionBootstrap?: ExecutionBootstrapContext;
}

export async function runInteractiveSession(options: InteractiveSessionOptions): Promise<void> {
  configureInteractiveOutput({ noColor: options.noColor, cwd: options.cwd });
  ensureInteractiveTty();
  clearTerminalScreen();

  const logger = new InteractiveCodexLogger(options.verbose, options.noColor);
  try {
    printSection("Phase · Input");
    if (options.memoryContext?.trim()) {
      printInfo("loaded completed plans context (docs/plans/completed)");
    }

    const sessionModel = options.model;
    if (sessionModel) {
      printInfo(`selected model: ${sessionModel}`);
    } else {
      printInfo("selected model: codex default");
    }

    const codex = new CodexRunner(
      {
        command: "codex",
        model: sessionModel,
        reasoningEffort: options.reasoningEffort ?? "high",
        sandbox: options.sandbox ?? "danger-full-access",
        skipGitRepoCheck: !options.isGit
      },
      logger
    );

    const unfinished = await listUnfinishedPlans(options.cwd);
    const latest = unfinished[0];
    if (latest) {
      const action = await promptChoice({
        title: `Found unfinished plan: ${latest.relativePath}`,
        hint: "Choose an action",
        items: [
          {
            value: "continue",
            label: "Continue execution",
            description: "Run execution for this plan",
            recommended: true
          },
          {
            value: "delete_and_new",
            label: "Cancel and delete plan",
            description: "Delete unfinished plan and start a new one"
          },
          {
            value: "new",
            label: "Keep and start new",
            description: "Keep current plan file and create a new one"
          }
        ]
      });

      if (action === "continue") {
        printSection("Phase · Execute");
        clearPlanPreview();
        await executePlan(latest.path, options.cwd, {
          planPath: latest.path,
          baseBranch: options.baseBranch,
          model: sessionModel,
          reasoningEffort: options.reasoningEffort,
          sandbox: options.sandbox,
          memoryContext: options.memoryContext,
          maxTaskRetries: options.maxTaskRetries,
          maxReviewIterations: options.maxReviewIterations,
          maxExternalIterations: options.maxExternalIterations,
          reviewPatience: options.reviewPatience,
          waitOnLimitMs: options.waitOnLimitMs,
          noColor: options.noColor,
          verbose: options.verbose,
          sink: getInteractiveProgressSink(),
          bootstrap: options.executionBootstrap
        });
        return;
      }

      if (action === "delete_and_new") {
        const cleanup = await removePlanAndCommitDeletionIfTracked(options.cwd, latest.path, {
          isGit: options.isGit
        });
        printInfo(`deleted unfinished plan: ${cleanup.relativePath}`);
        if (cleanup.committed) {
          printInfo(`committed abandoned-plan removal: ${cleanup.relativePath}`);
        }
      }
    }

    const goal = await promptText(
      options.initialGoal?.trim()
        ? {
            title: "What should be done?",
            hint: `Requirement loaded from ${options.initialSourceLabel ?? "input"} (you can edit before planning)`,
            placeholder: "for example: refactor payment module",
            initialValue: options.initialGoal.trim()
          }
        : {
            title: "What should be done?",
            hint: "Describe the task in free text",
            placeholder: "for example: refactor payment module"
          }
    );
    const conversationHistory: ConversationTurn[] = [];
    pushConversationTurn(conversationHistory, "user", goal);

    printSection("Phase · Plan");
    printInfo("detecting validation commands");
    const validationDetection = await detectValidationCommands(options.cwd, {
      isGit: options.isGit
    });
    for (const diagnostic of validationDetection.diagnostics) {
      printWarn(diagnostic.message);
    }
    const validationCommands = validationDetection.commands;
    for (const command of validationCommands) {
      logger.debug(`validation command: ${command}`);
    }

    printInfo("checking ambiguities and collecting clarifications");
    const initialClarificationCycle = await runClarificationCycle({
      codex,
      goal,
      existingAnswers: [],
      conversationHistory,
      latestUserMessage: goal,
      memoryContext: options.memoryContext,
      maxTaskRetries: options.maxTaskRetries,
      waitOnLimitMs: options.waitOnLimitMs,
      logger,
      promptChoice,
      promptText,
      onWarning: (message) => printWarn(message)
    });
    let clarifications = initialClarificationCycle.allAnswers;
    if (initialClarificationCycle.softFallbackUsed) {
      printWarn("clarification loop stopped early; continuing with available context");
    }
    printInfo(`clarifications collected: ${clarifications.length}`);

    printInfo("analyzing codebase structure for plan generation");
    const projectContext = await buildProjectContextSnapshot(options.cwd);
    logger.debug(projectContext.summary);

    printInfo("generating draft plan");
    let draft = await generatePlanWithThinking(codex, {
      sourceText: buildSourceText(goal, clarifications, conversationHistory),
      sourceMode: "text",
      sourceLabel: "interactive-input",
      validationCommands,
      projectContext: projectContext.summary,
      memoryContext: options.memoryContext,
      maxRetries: options.maxTaskRetries
    }, logger);
    printInfo("running initial plan quality review against the codebase");
    draft = await reviewFirstDraft({
      codex,
      goal,
      draft,
      validationCommands,
      projectContext: projectContext.summary,
      maxTaskRetries: options.maxTaskRetries,
      cwd: options.cwd,
      logger
    });

    while (true) {
      printPlanPreview(draft.content);

      const feedback = await promptText({
        title: "Press Enter to run, or type what to change in the plan",
        hint: "Empty input = accept and execute",
        allowEmpty: true
      });

      if (feedback.trim() === "") {
        const planPath = await saveGeneratedPlan(options.cwd, draft.title, draft.content);
        printInfo(`generated plan: ${toDisplayPath(options.cwd, planPath)}`);

        const cleanup = await cleanupInteractivePreflight(options.cwd, {
          isGit: options.isGit
        });
        if (cleanup.committedDeletedPlans.length > 0) {
          printInfo(`cleaned abandoned plans: ${cleanup.committedDeletedPlans.length}`);
        }
        if (cleanup.relocatedArtifacts.length > 0) {
          printInfo(`relocated artifacts: ${cleanup.relocatedArtifacts.length}`);
        }

        printSection("Phase · Execute");
        clearPlanPreview();

        await executePlan(planPath, options.cwd, {
          planPath,
          baseBranch: options.baseBranch,
          model: sessionModel,
          reasoningEffort: options.reasoningEffort,
          sandbox: options.sandbox,
          memoryContext: options.memoryContext,
          maxTaskRetries: options.maxTaskRetries,
          maxReviewIterations: options.maxReviewIterations,
          maxExternalIterations: options.maxExternalIterations,
          reviewPatience: options.reviewPatience,
          waitOnLimitMs: options.waitOnLimitMs,
          noColor: options.noColor,
          verbose: options.verbose,
          sink: getInteractiveProgressSink(),
          bootstrap: options.executionBootstrap
        });
        return;
      }

      pushConversationTurn(conversationHistory, "user", feedback);
      printInfo("updating plan based on your feedback");
      const revisionClarificationCycle = await runClarificationCycle({
        codex,
        goal,
        existingAnswers: clarifications,
        conversationHistory,
        latestUserMessage: feedback,
        currentPlan: draft.content,
        memoryContext: options.memoryContext,
        maxTaskRetries: options.maxTaskRetries,
        waitOnLimitMs: options.waitOnLimitMs,
        logger,
        promptChoice,
        promptText,
        onWarning: (message) => printWarn(message)
      });
      clarifications = revisionClarificationCycle.allAnswers;
      if (revisionClarificationCycle.softFallbackUsed) {
        printWarn("clarification loop stopped early; applying plan update with current context");
      }
      printInfo(
        `clarifications added: ${revisionClarificationCycle.addedAnswers.length} (total: ${clarifications.length})`
      );

      const revisedDraft = await revisePlan({
        codex,
        goal,
        clarifications,
        validationCommands,
        previousPlan: draft.content,
        revisionFeedback: feedback,
        projectContext: projectContext.summary,
        memoryContext: options.memoryContext,
        conversationHistory,
        maxTaskRetries: options.maxTaskRetries,
        waitOnLimitMs: options.waitOnLimitMs,
        logger
      });
      printInfo("running quality review for revised plan");
      draft = await reviewRevisedDraft({
        codex,
        sourceText: buildSourceText(goal, clarifications, conversationHistory),
        draft: revisedDraft,
        validationCommands,
        projectContext: projectContext.summary,
        maxTaskRetries: options.maxTaskRetries,
        cwd: options.cwd,
        logger
      });
    }
  } finally {
    logger.stopThinking();
    shutdownInteractiveOutput();
  }
}

interface RevisePlanInput {
  codex: CodexRunner;
  goal: string;
  clarifications: ClarificationAnswer[];
  conversationHistory?: ConversationTurn[];
  validationCommands: string[];
  previousPlan: string;
  revisionFeedback: string;
  projectContext?: string;
  memoryContext?: string;
  maxTaskRetries: number;
  waitOnLimitMs: number;
  logger: InteractiveCodexLogger;
}

async function revisePlan(input: RevisePlanInput): Promise<GeneratedPlan> {
  const prompt = buildPlanRevisionPrompt({
    goal: input.goal,
    answers: input.clarifications,
    conversationHistory: formatConversationHistory(input.conversationHistory),
    validationCommands: input.validationCommands,
    previousPlan: input.previousPlan,
    revisionFeedback: input.revisionFeedback,
    projectContext: input.projectContext,
    memoryContext: input.memoryContext
  });

  let parseError = "";
  let previousOutput = "";
  const expectedValidationCommands = normalizeValidationCommands(input.validationCommands);

  for (let attempt = 1; attempt <= input.maxTaskRetries + 1; attempt += 1) {
    const promptToUse =
      attempt === 1
        ? prompt
        : [
            prompt,
            "",
            `Previous parse error: ${parseError}`,
            "Previous invalid plan:",
            previousOutput,
            "",
            "Return a full corrected markdown plan."
          ].join("\n");

    const result = await runCodexWithRetries({
      codex: input.codex,
      prompt: promptToUse,
      maxTaskRetries: input.maxTaskRetries,
      waitOnLimitMs: input.waitOnLimitMs,
      logger: input.logger,
      label: "plan revision"
    });

    const normalized = normalizeMarkdownPlan(result.output);
    previousOutput = normalized;

    try {
      const parsed = parsePlan(normalized, "<interactive-plan>");
      const commandMismatchReason = getValidationCommandMismatchReason(
        parsed.validationCommands,
        expectedValidationCommands
      );
      if (commandMismatchReason) {
        parseError =
          "Revised plan changed validation commands. " +
          `Keep them EXACTLY unchanged in content and order. ${commandMismatchReason}.`;
        if (attempt >= input.maxTaskRetries + 1) {
          throw new Error(parseError);
        }
        continue;
      }
      return {
        title: parsed.title,
        content: renderWithTrailingNewline(parsed)
      };
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
      if (attempt >= input.maxTaskRetries + 1) {
        throw new Error(`failed to revise plan: ${parseError}`);
      }
    }
  }

  throw new Error("failed to revise plan");
}

function buildSourceText(goal: string, clarifications: ClarificationAnswer[], conversationHistory: ConversationTurn[]): string {
  const history = formatConversationHistory(conversationHistory);
  const historySection = history ? `\n\nConversation history:\n${history}` : "";
  if (clarifications.length === 0) {
    return `${goal}${historySection}`;
  }

  const lines = clarifications.map((item, index) => `${index + 1}. ${item.question}\n   Answer: ${item.answer}`);
  return `${goal}${historySection}\n\nClarifications:\n${lines.join("\n")}`;
}

function pushConversationTurn(history: ConversationTurn[], role: ConversationTurn["role"], text: string): void {
  const normalized = text.trim();
  if (!normalized) {
    return;
  }
  history.push({ role, text: normalized });
}

function formatConversationHistory(history: ConversationTurn[] | undefined): string {
  if (!history || history.length === 0) {
    return "";
  }
  return history.map((turn, index) => `${index + 1}. ${turn.role}: ${turn.text}`).join("\n");
}

interface ReviewFirstDraftInput {
  codex: CodexRunner;
  goal: string;
  draft: GeneratedPlan;
  validationCommands: string[];
  projectContext: string;
  maxTaskRetries: number;
  cwd: string;
  logger: InteractiveCodexLogger;
}

async function reviewFirstDraft(input: ReviewFirstDraftInput): Promise<GeneratedPlan> {
  input.logger.startThinking("initial plan quality review");
  try {
    const reviewed = await reviewGeneratedPlan(input.codex, {
      sourceText: input.goal,
      sourceMode: "text",
      sourceLabel: "interactive-input",
      currentPlan: input.draft.content,
      projectContext: input.projectContext,
      validationCommands: input.validationCommands,
      maxRetries: input.maxTaskRetries,
      cwd: input.cwd
    });

    input.logger.debug(`initial plan review summary: ${reviewed.summary}`);
    if (reviewed.revised) {
      printInfo("initial review found gaps and corrected the plan before first preview");
    } else {
      printInfo("initial review: no significant gaps found");
    }

    return {
      title: reviewed.title,
      content: reviewed.content
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.logger.debug(`initial plan review failed: ${message}`);
    printWarn("initial quality review failed; cannot continue without a reviewed plan");
    throw new Error(`initial plan quality review failed: ${message}`);
  } finally {
    input.logger.stopThinking();
  }
}

interface ReviewRevisedDraftInput {
  codex: CodexRunner;
  sourceText: string;
  draft: GeneratedPlan;
  validationCommands: string[];
  projectContext: string;
  maxTaskRetries: number;
  cwd: string;
  logger: InteractiveCodexLogger;
}

async function reviewRevisedDraft(input: ReviewRevisedDraftInput): Promise<GeneratedPlan> {
  input.logger.startThinking("revised plan quality review");
  try {
    const reviewed = await reviewGeneratedPlan(input.codex, {
      sourceText: input.sourceText,
      sourceMode: "text",
      sourceLabel: "interactive-input",
      currentPlan: input.draft.content,
      projectContext: input.projectContext,
      validationCommands: input.validationCommands,
      maxRetries: input.maxTaskRetries,
      cwd: input.cwd
    });

    input.logger.debug(`revised plan review summary: ${reviewed.summary}`);
    if (reviewed.revised) {
      printInfo("revision review applied additional fixes before preview");
    } else {
      printInfo("revision review: no additional fixes needed");
    }

    return {
      title: reviewed.title,
      content: reviewed.content
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.logger.debug(`revised plan review failed: ${message}`);
    printWarn("revision quality review failed; cannot continue without a reviewed plan");
    throw new Error(`revised plan quality review failed: ${message}`);
  } finally {
    input.logger.stopThinking();
  }
}

interface RunCodexInput {
  codex: CodexRunner;
  prompt: string;
  maxTaskRetries: number;
  waitOnLimitMs: number;
  logger: InteractiveCodexLogger;
  label: string;
}

async function runCodexWithRetries(input: RunCodexInput): Promise<{ output: string }> {
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

function renderWithTrailingNewline(plan: ReturnType<typeof parsePlan>): string {
  const rendered = renderPlanMarkdown(plan);
  return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
}

class InteractiveCodexLogger {
  private readonly verbose: boolean;
  private readonly sessionId: string;
  private readonly compactToolState: ToolCompactFilterState;
  private activeCodexRequest?: {
    hasProgressBullets: boolean;
    allowFallback: boolean;
    fallbackLines: string[];
    fallbackFilterState: ToolCompactFilterState;
  };
  private thinkingLabel?: string;

  constructor(verbose: boolean, _noColor: boolean) {
    this.verbose = verbose;
    this.sessionId = randomUUID().slice(0, 8);
    this.compactToolState = createToolCompactFilterState();
  }

  async rawToolOutput(msg: string): Promise<void> {
    const lines = msg.split(/\r?\n/).filter((line) => line.length > 0);
    for (const line of lines) {
      if (shouldSuppressToolLine(line)) {
        continue;
      }

      if (this.verbose) {
        this.debug(line);
        continue;
      }

      if (this.activeCodexRequest) {
        const bulletHeading = extractToolProgressBullet(line);
        if (bulletHeading) {
          if (!this.activeCodexRequest.hasProgressBullets) {
            this.activeCodexRequest.hasProgressBullets = true;
            this.activeCodexRequest.fallbackLines = [];
          }
          printInfo(`codex: ${bulletHeading}`);
          continue;
        }

        if (this.activeCodexRequest.hasProgressBullets || !this.activeCodexRequest.allowFallback) {
          continue;
        }

        const fallbackLine = selectCompactToolLine(line, this.activeCodexRequest.fallbackFilterState);
        if (fallbackLine) {
          this.activeCodexRequest.fallbackLines.push(fallbackLine);
        }
        continue;
      }

      const compactLine = selectCompactToolLine(line, this.compactToolState);
      if (compactLine) {
        printInfo(`codex: ${compactLine}`);
      }
    }
  }

  async startCodexRequest(): Promise<void> {
    if (this.verbose) {
      return;
    }
    this.activeCodexRequest = {
      hasProgressBullets: false,
      allowFallback: false,
      fallbackLines: [],
      fallbackFilterState: createToolCompactFilterState()
    };
  }

  async finishCodexRequest(): Promise<void> {
    if (this.verbose) {
      this.activeCodexRequest = undefined;
      return;
    }

    const request = this.activeCodexRequest;
    this.activeCodexRequest = undefined;
    if (!request || request.hasProgressBullets || !request.allowFallback || request.fallbackLines.length === 0) {
      return;
    }

    for (const line of request.fallbackLines) {
      printInfo(`codex: ${line}`);
    }
  }

  startThinking(label: string): void {
    this.thinkingLabel = label;
    setThinkingIndicator(label);
  }

  stopThinking(): void {
    if (!this.thinkingLabel) {
      return;
    }
    this.thinkingLabel = undefined;
    setThinkingIndicator(undefined);
  }

  debug(msg: string): void {
    if (!this.verbose) {
      return;
    }
    printDebug(`[interactive:${this.sessionId}] ${msg}`);
  }
}

async function generatePlanWithThinking(
  codex: CodexRunner,
  input: Parameters<typeof generatePlanFromFreeform>[1],
  logger: InteractiveCodexLogger
): Promise<GeneratedPlan> {
  logger.startThinking("plan generation");
  try {
    return await generatePlanFromFreeform(codex, input);
  } finally {
    logger.stopThinking();
  }
}

function ensureInteractiveTty(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("interactive mode requires TTY; pass input explicitly: thred \"...\" or thred CONCEPT.md");
  }
}
