import { randomUUID } from "node:crypto";
import path from "node:path";

import { ensureThredWorkspace, getArtifactsRunsDir } from "../artifacts/manager.js";
import type { RunOptions } from "../../types.js";
import { ensureGitWorkspaceReady, isInsideGitWorkTree } from "../git/bootstrap.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { type ProgressLogSink, ProgressLogger } from "../progress/logger.js";
import { RunStateStore } from "../state/store.js";
import { commandExists } from "../util/process.js";

export interface ExecutionBootstrapContext {
  cwd: string;
  isGit: boolean;
}

export interface PrepareExecutionBootstrapOptions {
  noGit?: boolean;
}

export interface ExecutePlanOptions extends Omit<RunOptions, "isGit"> {
  verbose: boolean;
  sink?: ProgressLogSink;
  bootstrap?: ExecutionBootstrapContext;
}

interface ExecutionRuntime {
  resolvedPlanPath: string;
  isGit: boolean;
  runId: string;
  logger: ProgressLogger;
  stateStore: RunStateStore;
}

export async function executePlan(planPathArg: string, cwd: string, options: ExecutePlanOptions): Promise<void> {
  const runtime = await bootstrapExecutionRun(planPathArg, cwd, options);

  const runOptions: RunOptions = {
    planPath: runtime.resolvedPlanPath,
    isGit: runtime.isGit,
    baseBranch: options.baseBranch,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    sandbox: options.sandbox,
    memoryContext: options.memoryContext,
    maxTaskRetries: options.maxTaskRetries,
    maxReviewIterations: options.maxReviewIterations,
    maxExternalIterations: options.maxExternalIterations,
    reviewPatience: options.reviewPatience,
    waitOnLimitMs: options.waitOnLimitMs,
    noColor: options.noColor
  };

  const runner = new PipelineRunner({
    options: runOptions,
    cwd,
    runId: runtime.runId,
    logger: runtime.logger,
    stateStore: runtime.stateStore
  });

  try {
    await runner.run();
  } finally {
    await runtime.logger.close();
  }
}

export async function prepareExecutionBootstrap(
  cwd: string,
  options: PrepareExecutionBootstrapOptions = {}
): Promise<ExecutionBootstrapContext> {
  if (!(await commandExists("codex"))) {
    throw new Error("codex not found in PATH");
  }

  const forceNoGit = options.noGit === true;
  const hasGitBinary = forceNoGit ? false : await commandExists("git");
  const inGitWorkTree = hasGitBinary ? await isInsideGitWorkTree(cwd) : false;
  const isGit = !forceNoGit && hasGitBinary && inGitWorkTree;

  if (isGit) {
    await ensureGitWorkspaceReady(cwd);
  }
  await ensureThredWorkspace(cwd, {
    updateGitignore: isGit
  });

  return {
    cwd: path.resolve(cwd),
    isGit
  };
}

async function bootstrapExecutionRun(
  planPathArg: string,
  cwd: string,
  options: ExecutePlanOptions
): Promise<ExecutionRuntime> {
  const bootstrap = options.bootstrap ?? (await prepareExecutionBootstrap(cwd));
  const resolvedCwd = path.resolve(cwd);
  if (path.resolve(bootstrap.cwd) !== resolvedCwd) {
    throw new Error(`invalid execution bootstrap context for cwd: expected ${resolvedCwd}, got ${bootstrap.cwd}`);
  }

  const resolvedPlanPath = path.resolve(cwd, planPathArg);
  const runId = buildRunId(resolvedPlanPath);
  const runDir = getArtifactsRunsDir(cwd);
  const logger = await ProgressLogger.create(runDir, runId, options.noColor, options.verbose, options.sink);
  let stateStore: RunStateStore;
  try {
    stateStore = await RunStateStore.create(runDir, runId);
  } catch (error) {
    await logger.close().catch(() => undefined);
    throw error;
  }

  return {
    resolvedPlanPath,
    isGit: bootstrap.isGit,
    runId,
    logger,
    stateStore
  };
}

function buildRunId(planPath: string): string {
  const stem = path.basename(planPath, path.extname(planPath)).toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `${new Date().toISOString().slice(0, 10)}-${stem}-${randomUUID().slice(0, 8)}`;
}
