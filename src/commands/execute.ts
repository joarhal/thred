import { randomUUID } from "node:crypto";
import { open, stat, unlink } from "node:fs/promises";
import path from "node:path";

import type { Command } from "commander";

import { ensureThredWorkspace, getArtifactsRunsDir, resetArtifacts } from "../core/artifacts/manager.js";
import { CodexRunner } from "../core/codex/runner.js";
import {
  executePlan,
  prepareExecutionBootstrap
} from "../core/execute/run-plan.js";
import { isInsideGitWorkTree } from "../core/git/bootstrap.js";
import { runInteractiveEntry } from "../core/interactive/entry.js";
import { resolveInput } from "../core/input/resolve.js";
import { loadCompletedPlansContext } from "../core/context/completed-plans.js";
import { generatePlanFromFreeform } from "../core/plan/generate.js";
import { buildProjectContextSnapshot } from "../core/plan/project-context.js";
import { reviewGeneratedPlan } from "../core/plan/review.js";
import { saveGeneratedPlan } from "../core/plan/save.js";
import { detectValidationCommands } from "../core/plan/validation-detect.js";
import { ProgressLogger } from "../core/progress/logger.js";
import {
  INHERIT_MODEL,
  LEGACY_SETTINGS_FILE,
  SETTINGS_FILE,
  loadThredSettings,
  normalizeReasoningEffort,
  saveThredSettings
} from "../core/settings/service.js";
import {
  buildDefaultReviewPipelineFile,
  writeReviewPipelineFile
} from "../core/review/pipeline-config.js";
import { ensureDir, exists } from "../core/util/fs.js";
import { commandExists } from "../core/util/process.js";
import { toDisplayPath } from "../core/util/path-display.js";
import { durationToMs } from "../core/util/time.js";
import type { CodexConfig } from "../types.js";

export interface ExecuteCommandArgs {
  baseBranch?: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  noGit?: boolean;
  nonInteractive?: boolean;
  waitOnLimit?: string;
  noColor?: boolean;
  verbose?: boolean;
}

export interface RunCommandArgs {
  baseBranch?: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  noGit?: boolean;
  waitOnLimit?: string;
  noColor?: boolean;
  verbose?: boolean;
}

interface SetupDefaults {
  maxReviewIterations: number;
  maxExternalIterations: number;
  reviewPatience: number;
}

interface RunSetupOptions {
  noGit?: boolean;
  writeReviewPipeline?: boolean;
}

interface EnsureFirstRunSetupOptions {
  noGit?: boolean;
}

const SETUP_DEFAULTS: SetupDefaults = {
  maxReviewIterations: 3,
  maxExternalIterations: 4,
  reviewPatience: 2
};
const DEFAULT_MAX_TASK_RETRIES = 1;
const SETUP_LOCK_FILE = "setup.lock";
const SETUP_LOCK_RETRY_MS = 50;
const SETUP_LOCK_TIMEOUT_MS = 5000;
const SETUP_STALE_LOCK_MS = 30000;

export function registerExecuteCommand(program: Command): void {
  registerExecuteTarget(program);
  registerNewCommand(program);
  registerSetupCommand(program);
}

function registerNewCommand(program: Command): void {
  registerExecuteTarget(program.command("new"), "Create and execute a new plan from free-form input");
}

function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Initialize .thred settings and review pipeline defaults (create-if-absent)")
    .action(async () => {
      const result = await runSetupCommand();
      process.stdout.write(`updated ${toDisplayPath(process.cwd(), result.settingsPath)}\n`);
    });
}

function registerExecuteTarget(command: Command, description?: string): void {
  if (description) {
    command.description(description);
  }
  command
    .argument("[input]", "Path to free-form task file or inline task description")
    .option("--base-branch <name>", "Override base branch for diffs and branch creation")
    .option("--model <id>", "Override Codex model for this run")
    .option("--reasoning-effort <level>", "Codex reasoning effort")
    .option("--sandbox <mode>", "Codex sandbox", "danger-full-access")
    .option("--no-git", "Run fully local without any git operations", false)
    .option("--non-interactive", "Skip plan dialog and run direct generation+execution flow", false)
    .option("--wait-on-limit <duration>", "Wait duration for rate limits", "30m")
    .option("--no-color", "Disable colored output", false)
    .option("--verbose", "Show detailed progress and tool output", false)
    .action(async (input: string | undefined, args: ExecuteCommandArgs) => {
      await executeFromInput(input, args);
    });
}

export async function executeExistingPlan(planPath: string, args: RunCommandArgs): Promise<void> {
  const cwd = process.cwd();
  const maxTaskRetries = DEFAULT_MAX_TASK_RETRIES;
  const maxReviewIterations = SETUP_DEFAULTS.maxReviewIterations;
  const maxExternalIterations = SETUP_DEFAULTS.maxExternalIterations;
  const reviewPatience = SETUP_DEFAULTS.reviewPatience;
  const verbose = Boolean(args.verbose);
  const noColor = Boolean(args.noColor);
  const waitOnLimitMs = durationToMs(args.waitOnLimit ?? "30m");
  const executionBootstrap = await prepareExecutionBootstrap(cwd, { noGit: args.noGit });
  await ensureFirstRunSetup(cwd, { noGit: args.noGit });
  await resetArtifacts(cwd);
  const settingsSnapshot = await loadThredSettings(cwd);
  const completedPlansContext = await loadCompletedPlansContext(cwd);
  const reasoningEffort = normalizeReasoningEffort(args.reasoningEffort, settingsSnapshot.settings.reasoningEffort);

  if (args.reasoningEffort) {
    await saveThredSettings(cwd, {
      model: settingsSnapshot.settings.model,
      reasoningEffort
    });
  }

  const configuredModel = resolveEffectiveModel(args.model, settingsSnapshot.settings.model);

  await executePlan(planPath, cwd, {
    planPath,
    baseBranch: args.baseBranch,
    model: configuredModel,
    reasoningEffort,
    sandbox: args.sandbox,
    memoryContext: completedPlansContext.content,
    maxTaskRetries,
    maxReviewIterations,
    maxExternalIterations,
    reviewPatience,
    waitOnLimitMs,
    noColor,
    verbose,
    bootstrap: executionBootstrap
  });
}

export async function executeFromInput(input: string | undefined, args: ExecuteCommandArgs): Promise<void> {
  const cwd = process.cwd();
  const maxTaskRetries = DEFAULT_MAX_TASK_RETRIES;
  const maxReviewIterations = SETUP_DEFAULTS.maxReviewIterations;
  const maxExternalIterations = SETUP_DEFAULTS.maxExternalIterations;
  const reviewPatience = SETUP_DEFAULTS.reviewPatience;
  const verbose = Boolean(args.verbose);
  const noColor = Boolean(args.noColor);
  const waitOnLimitMs = durationToMs(args.waitOnLimit ?? "30m");
  const useInteractive = !Boolean(args.nonInteractive);

  if (!useInteractive && !input) {
    throw new Error("non-interactive mode requires input: pass text or a task file path");
  }

  if (useInteractive) {
    ensureInteractiveModeTty();
  }

  const resolvedInput = input ? await resolveInput(input, cwd) : undefined;

  if (!useInteractive && !resolvedInput) {
    throw new Error("non-interactive mode requires input: pass text or a task file path");
  }

  const executionBootstrap = await prepareExecutionBootstrap(cwd, { noGit: args.noGit });
  await ensureFirstRunSetup(cwd, { noGit: args.noGit });
  await resetArtifacts(cwd);
  const settingsSnapshot = await loadThredSettings(cwd);
  const completedPlansContext = await loadCompletedPlansContext(cwd);
  const reasoningEffort = normalizeReasoningEffort(args.reasoningEffort, settingsSnapshot.settings.reasoningEffort);

  if (args.reasoningEffort) {
    await saveThredSettings(cwd, {
      model: settingsSnapshot.settings.model,
      reasoningEffort
    });
  }

  const configuredModel = resolveEffectiveModel(args.model, settingsSnapshot.settings.model);

  if (useInteractive) {
    await runInteractiveEntry(cwd, {
      isGit: executionBootstrap.isGit,
      baseBranch: args.baseBranch,
      model: configuredModel,
      reasoningEffort,
      sandbox: args.sandbox,
      initialGoal: resolvedInput?.sourceText,
      initialSourceLabel: resolvedInput?.sourceLabel,
      memoryContext: completedPlansContext.content,
      maxTaskRetries,
      maxReviewIterations,
      maxExternalIterations,
      reviewPatience,
      waitOnLimitMs,
      noColor,
      verbose,
      executionBootstrap
    });
    return;
  }

  if (!resolvedInput) {
    throw new Error("non-interactive mode requires input: pass text or a task file path");
  }

  const generationRunId = buildGenerationRunId();
  const runDir = getArtifactsRunsDir(cwd);
  const logger = await ProgressLogger.create(runDir, generationRunId, noColor, verbose);

  try {
    await logger.phase("input");
    await logger.info(`resolved input mode: ${resolvedInput.mode}`);
    await logger.debug(`source label: ${resolvedInput.sourceLabel}`);

    await logger.phase("plan");
    await logger.info(
      `loaded completed plans context: ${completedPlansContext.planCount} plans, ${completedPlansContext.lineCount} lines`
    );
    await logger.info(
      configuredModel ? `using model: ${configuredModel}` : "using model: codex default (settings.model=inherit)"
    );
    await logger.info(`using reasoning effort: ${reasoningEffort}`);
    await logger.info("detecting validation commands");
    const validationDetection = await detectValidationCommands(cwd, {
      isGit: executionBootstrap.isGit
    });
    for (const diagnostic of validationDetection.diagnostics) {
      await logger.warn(diagnostic.message);
    }
    const validationCommands = validationDetection.commands;
    for (const command of validationCommands) {
      await logger.debug(`validation command: ${command}`);
    }
    await logger.info("collecting repository context snapshot for planning");
    const projectContext = await buildProjectContextSnapshot(cwd);
    await logger.debug(projectContext.summary);

    await logger.info("generating execution plan from free-form input");
    const codexConfig: CodexConfig = {
      command: "codex",
      model: configuredModel,
      reasoningEffort,
      sandbox: args.sandbox ?? "danger-full-access",
      skipGitRepoCheck: !executionBootstrap.isGit
    };
    const codex = new CodexRunner(codexConfig, logger);
    const generated = await generatePlanFromFreeform(codex, {
      sourceText: resolvedInput.sourceText,
      sourceMode: resolvedInput.mode,
      sourceLabel: resolvedInput.sourceLabel,
      validationCommands,
      projectContext: projectContext.summary,
      memoryContext: completedPlansContext.content,
      maxRetries: maxTaskRetries
    });
    await logger.info("reviewing generated plan against repository context");
    const reviewed = await reviewGeneratedPlan(codex, {
      sourceText: resolvedInput.sourceText,
      sourceMode: resolvedInput.mode,
      sourceLabel: resolvedInput.sourceLabel,
      currentPlan: generated.content,
      projectContext: projectContext.summary,
      validationCommands,
      maxRetries: maxTaskRetries,
      cwd
    });
    await logger.info(`plan quality review: ${reviewed.summary}`);
    if (reviewed.revised) {
      await logger.info("plan quality review updated the draft before first display");
    }

    const planPath = await saveGeneratedPlan(cwd, reviewed.title, reviewed.content);
    await logger.success(`generated plan: ${toDisplayPath(cwd, planPath)}`);
    await logger.info("starting plan execution");

    await executePlan(planPath, cwd, {
      planPath,
      baseBranch: args.baseBranch,
      model: configuredModel,
      reasoningEffort,
      sandbox: args.sandbox,
      memoryContext: completedPlansContext.content,
      maxTaskRetries,
      maxReviewIterations,
      maxExternalIterations,
      reviewPatience,
      waitOnLimitMs,
      noColor,
      verbose,
      bootstrap: executionBootstrap
    });
  } finally {
    await logger.close();
  }
}

export { ensureGitWorkspaceReady } from "../core/git/bootstrap.js";

export async function runSetupCommand(cwd = process.cwd(), options: RunSetupOptions = {}): Promise<{
  settingsPath: string;
}> {
  return withSetupLock(cwd, async () => {
    await ensureThredWorkspace(cwd, {
      updateGitignore: options.noGit ? false : await canUpdateGitignore(cwd)
    });
    const settingsSnapshot = await loadThredSettings(cwd);
    if (options.writeReviewPipeline ?? true) {
      await writeReviewPipelineFile(cwd, buildDefaultReviewPipelineFile(SETUP_DEFAULTS));
    }

    return {
      settingsPath: settingsSnapshot.path
    };
  });
}

export async function ensureFirstRunSetup(cwd = process.cwd(), options: EnsureFirstRunSetupOptions = {}): Promise<void> {
  const settingsPath = path.join(cwd, ".thred", SETTINGS_FILE);
  const legacySettingsPath = path.join(cwd, ".thred", LEGACY_SETTINGS_FILE);
  if (await exists(settingsPath) || await exists(legacySettingsPath)) {
    return;
  }
  await runSetupCommand(cwd, {
    noGit: options.noGit
  });
}

function buildGenerationRunId(): string {
  return `${new Date().toISOString().slice(0, 10)}-plan-generation-${randomUUID().slice(0, 8)}`;
}

function resolveConfiguredModel(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized || normalized.toLowerCase() === INHERIT_MODEL) {
    return undefined;
  }
  return normalized;
}

function resolveEffectiveModel(modelOverride: string | undefined, settingsModel: string | undefined): string | undefined {
  if (modelOverride !== undefined) {
    return resolveConfiguredModel(modelOverride);
  }
  return resolveConfiguredModel(settingsModel);
}

function ensureInteractiveModeTty(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("interactive mode requires TTY; pass input explicitly: thred \"...\" or thred CONCEPT.md");
  }
}

async function canUpdateGitignore(cwd: string): Promise<boolean> {
  if (!(await commandExists("git"))) {
    return false;
  }
  return isInsideGitWorkTree(cwd);
}

async function withSetupLock<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = path.join(cwd, ".thred", SETUP_LOCK_FILE);
  const timeoutAt = Date.now() + SETUP_LOCK_TIMEOUT_MS;
  let lockAcquired = false;
  await ensureDir(path.dirname(lockPath));

  while (!lockAcquired) {
    try {
      const handle = await open(lockPath, "wx");
      lockAcquired = true;
      try {
        await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!isErrorWithCode(error) || error.code !== "EEXIST") {
        throw error;
      }

      if (await isStaleLock(lockPath, SETUP_STALE_LOCK_MS)) {
        await safeUnlink(lockPath);
        continue;
      }

      if (Date.now() >= timeoutAt) {
        throw new Error(`Timed out waiting for setup lock: ${lockPath}`);
      }

      await sleep(SETUP_LOCK_RETRY_MS);
    }
  }

  try {
    return await operation();
  } finally {
    if (lockAcquired) {
      await safeUnlink(lockPath);
    }
  }
}

async function isStaleLock(lockPath: string, maxAgeMs: number): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs > maxAgeMs;
  } catch (error) {
    if (isErrorWithCode(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function safeUnlink(targetPath: string): Promise<void> {
  try {
    await unlink(targetPath);
  } catch (error) {
    if (isErrorWithCode(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function isErrorWithCode(error: unknown): error is { code?: string } {
  return typeof error === "object" && error !== null && "code" in error;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
