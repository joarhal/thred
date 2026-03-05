import type { ExecutionBootstrapContext } from "../execute/run-plan.js";
import { runInteractiveSession } from "./session.js";

export interface InteractiveEntryOptions {
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

export async function runInteractiveEntry(cwd: string, options: InteractiveEntryOptions): Promise<void> {
  await runInteractiveSession({
    cwd,
    isGit: options.isGit,
    baseBranch: options.baseBranch,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    sandbox: options.sandbox,
    initialGoal: options.initialGoal,
    initialSourceLabel: options.initialSourceLabel,
    memoryContext: options.memoryContext,
    maxTaskRetries: options.maxTaskRetries,
    maxReviewIterations: options.maxReviewIterations,
    maxExternalIterations: options.maxExternalIterations,
    reviewPatience: options.reviewPatience,
    waitOnLimitMs: options.waitOnLimitMs,
    noColor: options.noColor,
    verbose: options.verbose,
    executionBootstrap: options.executionBootstrap
  });
}
