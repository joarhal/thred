import path from "node:path";

import type {
  Finding,
  Phase,
  ReviewRunSummary,
  ReviewSeveritySummary,
  RunOptions,
  RunState,
  RunStats
} from "../../types.js";
import { relocateKnownProjectArtifacts } from "../artifacts/manager.js";
import { CodexRunner } from "../codex/runner.js";
import {
  buildReviewFixPrompt,
  buildReviewPromptMultiAgentFocused,
  buildTaskPrompt,
  buildValidationFixPrompt
} from "../codex/prompts.js";
import { GitService } from "../git/service.js";
import { movePlanToCompletedLocal } from "../plan/completed.js";
import { markTaskDone, nextPendingTask, parsePlanFile } from "../plan/parser.js";
import { ProgressLogger } from "../progress/logger.js";
import {
  InvalidReviewStatusError,
  parseReviewResult
} from "../review/parse.js";
import { loadReviewPipelineConfig, type ResolvedReviewPassConfig } from "../review/pipeline-config.js";
import { runReview } from "../review/orchestrator.js";
import {
  type ReviewLoopReport,
  writeMandatoryStabilityBacklog,
  writeReviewReport as writeReviewArtifact
} from "../review/report.js";
import { RunStateStore } from "../state/store.js";
import type { RunStateStoreDiagnostic } from "../state/store.js";
import { toDisplayPath } from "../util/path-display.js";
import { runCommand } from "../util/process.js";
import { formatElapsed, sleep } from "../util/time.js";

interface RunnerDeps {
  options: RunOptions;
  cwd: string;
  runId: string;
  logger: ProgressLogger;
  stateStore: RunStateStore;
}

interface CompletedTaskContext {
  number: number;
  title: string;
  checklist: string[];
  summary: string;
}

interface ReviewLoopInput {
  passId: string;
  baseBranch: string;
  planPath: string;
  validationCommands: string[];
  focusSeverities: Finding["severity"][];
  agents?: string[];
  maxIterations: number;
  patience: number;
  initialFindings: Finding[];
}

interface ReviewLoopOutcome {
  report: ReviewLoopReport;
  findings: Finding[];
}

const REVIEW_PHASE_RESTART_LIMIT_ON_INVALID_STATUS = 2;

export class PipelineRunner {
  private readonly options: RunOptions;
  private readonly cwd: string;
  private readonly runId: string;
  private readonly logger: ProgressLogger;
  private readonly stateStore: RunStateStore;
  private readonly startedAt = Date.now();
  private git: GitService;
  private codex: CodexRunner;
  private state!: RunState;
  private completedTasks: CompletedTaskContext[] = [];
  private memoryIncidents: string[] = [];
  private finalizeExtraCommitPaths: string[] = [];

  constructor(deps: RunnerDeps) {
    this.options = deps.options;
    this.cwd = deps.cwd;
    this.runId = deps.runId;
    this.logger = deps.logger;
    this.stateStore = deps.stateStore;
    this.git = new GitService(this.cwd);
    this.codex = new CodexRunner(
      {
        command: "codex",
        model: this.options.model,
        reasoningEffort: this.options.reasoningEffort ?? "high",
        sandbox: this.options.sandbox ?? "danger-full-access",
        skipGitRepoCheck: !this.options.isGit
      },
      this.logger
    );
    this.attachRunStateDiagnostics();
  }

  async run(): Promise<void> {
    try {
      const preflightContext = await this.runPreflightPhase();
      await this.runTasksPhase();
      await this.runReviewPhase(preflightContext.baseBranch);
      await this.runMemoryPhaseStep();
      await this.runFinalizePhase(preflightContext.baseBranch, preflightContext.branch);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.fail(message);
      throw error;
    }
  }

  private async runPreflightPhase(): Promise<{ baseBranch: string; branch: string }> {
    await this.logger.phase("preflight");
    const context = await this.preflight();
    await this.logger.info(`vcs mode: ${this.options.isGit ? "git" : "local (no-git)"}`);
    await this.logger.info(
      `context: plan=${toDisplayPath(this.cwd, this.options.planPath)}, base=${context.baseBranch}, branch=${context.branch}, model=${this.options.model ?? "codex-default"}, sandbox=${this.options.sandbox ?? "danger-full-access"}`
    );
    await this.logger.info(
      `limits: taskRetries=${this.options.maxTaskRetries}, reviewDefaults={maxReviewIterations=${this.options.maxReviewIterations}, maxExternalIterations=${this.options.maxExternalIterations}, patience=${this.options.reviewPatience}}, waitOnLimit=${this.options.waitOnLimitMs}ms`
    );
    return context;
  }

  private async runTasksPhase(): Promise<void> {
    await this.transitionToPhase("tasks");
    await this.runTaskLoop();
  }

  private async runReviewPhase(baseBranch: string): Promise<void> {
    await this.transitionToPhase("review");
    let restartCount = 0;
    while (true) {
      try {
        await this.runFinalReview(baseBranch);
        return;
      } catch (error) {
        if (!isInvalidReviewStatusError(error) || restartCount >= REVIEW_PHASE_RESTART_LIMIT_ON_INVALID_STATUS) {
          throw error;
        }

        restartCount += 1;
        await this.logger.warn(
          `review: invalid overallStatus in model output, restarting full review (${restartCount}/${REVIEW_PHASE_RESTART_LIMIT_ON_INVALID_STATUS})`
        );
      }
    }
  }

  private async runMemoryPhaseStep(): Promise<void> {
    await this.transitionToPhase("memory");
    await this.runMemoryPhase();
  }

  private async runFinalizePhase(baseBranch: string, branch: string): Promise<void> {
    await this.transitionToPhase("finalize");
    if (this.options.isGit) {
      const completedPlanPath = await this.git.movePlanToCompleted(this.options.planPath, this.finalizeExtraCommitPaths);
      const stats = await this.git.diffStats(baseBranch);
      const commits = await this.countCommits(baseBranch);

      await this.finishSuccess({
        commits,
        files: stats.files,
        additions: stats.additions,
        deletions: stats.deletions
      });

      await this.logger.success(
        `completed in ${formatElapsed(this.startedAt)} on ${branch} (${stats.files} files +${stats.additions}/-${stats.deletions}); plan moved to ${toDisplayPath(this.cwd, completedPlanPath)}`
      );
      return;
    }

    const completedPlanPath = await movePlanToCompletedLocal(this.cwd, this.options.planPath);
    await this.finishSuccess({
      commits: 0,
      files: 0,
      additions: 0,
      deletions: 0
    });
    await this.logger.success(
      `completed in ${formatElapsed(this.startedAt)} on ${branch}; plan moved to ${toDisplayPath(this.cwd, completedPlanPath)}`
    );
  }

  private async transitionToPhase(phase: Phase): Promise<void> {
    if (!this.state) {
      throw new Error(`cannot transition to ${phase} before preflight initializes run state`);
    }
    assertPhaseProgression(this.state.phase, phase);
    await this.logger.phase(phase);
    this.state.phase = phase;
    if (phase !== "tasks") {
      delete this.state.currentTask;
    }
    await this.stateStore.write(this.state);
  }

  private async preflight(): Promise<{ baseBranch: string; branch: string }> {
    const plan = await parsePlanFile(this.options.planPath);
    const isGit = this.options.isGit;
    let baseBranch = "local";
    let branch = "local";
    if (isGit) {
      await this.git.ensureRepoRoot();
      baseBranch = await this.git.detectBaseBranch(this.options.baseBranch);
      const checkpoint = await this.git.checkpointDirtyWorkspaceBeforeExecution(plan.path);
      if (checkpoint.committed) {
        await this.logger.info(
          `preflight: checkpoint commit created before execution (${checkpoint.dirtyCount} dirty paths)`
        );
      }
      branch = await this.git.ensureFeatureBranchForPlan(plan.path, baseBranch);
      await this.git.ensureCleanExceptPlan(this.options.planPath);
    }

    this.state = {
      runId: this.runId,
      planPath: plan.path,
      branch,
      phase: "preflight",
      status: "running",
      startedAt: new Date(this.startedAt).toISOString()
    };
    await this.stateStore.write(this.state);
    if (isGit) {
      await this.logger.debug(`base branch: ${baseBranch}`);
      await this.logger.debug(`working branch: ${branch}`);
    }

    return { baseBranch, branch };
  }

  private async runTaskLoop(): Promise<void> {
    this.runSmokeNoop();

    let plan = await parsePlanFile(this.options.planPath);
    await this.logger.info(
      `task queue: ${countPendingTasks(plan)}/${plan.tasks.length} pending, validations=${plan.validationCommands.length}`
    );
    let task = nextPendingTask(plan);

    while (task) {
      this.state.currentTask = task.number;
      await this.stateStore.write(this.state);

      await this.logger.info(`running Task ${task.number}: ${task.title}`);
      await this.logger.info(
        `task ${task.number}: checklist ${countPendingChecklistItems(task)}/${task.items.length} pending`
      );
      await this.executeTaskWithRetry(plan, task.number);

      await markTaskDone(plan.path, task.number);
      if (this.options.isGit) {
        const committed = await this.git.stageAllAndCommit(`feat(task ${task.number}): ${task.title}`);
        if (committed) {
          await this.logger.info(`task ${task.number}: committed task changes`);
        } else {
          await this.logger.warn(`task ${task.number}: no staged changes to commit`);
        }
      } else {
        await this.logger.info(`task ${task.number}: local mode, skipping git commit`);
      }

      plan = await parsePlanFile(this.options.planPath);
      task = nextPendingTask(plan);
    }
  }

  private runSmokeNoop(): void {
    // Explicit no-op hook used by smoke plans to validate pipeline wiring.
  }

  private async executeTaskWithRetry(plan: Awaited<ReturnType<typeof parsePlanFile>>, taskNumber: number): Promise<void> {
    const maxAttempts = this.options.maxTaskRetries + 1;
    let validationOutput = "";

    const task = plan.tasks.find((t) => t.number === taskNumber);
    if (!task) {
      throw new Error(`task ${taskNumber} not found`);
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const prompt =
        attempt === 1
          ? buildTaskPrompt(plan, task, this.options.memoryContext)
          : buildValidationFixPrompt(plan, task, validationOutput, this.options.memoryContext);
      const requestGoal =
        attempt === 1 ? "implement checklist items for this task" : "fix validation failures from previous attempt";
      await this.logger.info(`task ${taskNumber}: codex request ${attempt}/${maxAttempts} - ${requestGoal}`);

      const result = await this.runCodexWithLimitWait(prompt, `task ${taskNumber}: codex request ${attempt}/${maxAttempts}`);
      if (result.error) {
        if (attempt < maxAttempts) {
          this.recordMemoryIncident(`Task ${taskNumber}: codex request failed on attempt ${attempt}; retried`);
          await this.logger.warn(`task ${taskNumber}: codex failed, retrying (${attempt}/${maxAttempts - 1})`);
          continue;
        }
        throw result.error;
      }

      const taskOutcomeSummary = summarizeCodexOutput(result.output, 220);
      await this.logger.info(`task ${taskNumber}: codex: ${taskOutcomeSummary}`);
      await this.logger.info(`task ${taskNumber}: running validations (${plan.validationCommands.length} commands)`);
      const validation = await this.runValidationCommands(plan.validationCommands, `task ${taskNumber}`);
      if (validation.ok) {
        this.completedTasks.push({
          number: task.number,
          title: task.title,
          checklist: task.items.map((item) => item.text),
          summary: taskOutcomeSummary
        });
        await this.logger.success(`task ${taskNumber} validated`);
        return;
      }

      validationOutput = validation.output;
      if (attempt < maxAttempts) {
        this.recordMemoryIncident(
          `Task ${taskNumber}: validation failed at command ${validation.failedCommandIndex}/${plan.validationCommands.length}; retried`
        );
        await this.logger.warn(
          `task ${taskNumber}: validation failed at ${validation.failedCommandIndex}/${plan.validationCommands.length}, retrying`
        );
      }
    }

    throw new Error(`task ${taskNumber} failed after ${maxAttempts} attempts`);
  }

  private async runFinalReview(baseBranch: string): Promise<ReviewRunSummary> {
    this.finalizeExtraCommitPaths = [];
    const plan = await parsePlanFile(this.options.planPath);
    const reviewPipeline = await loadReviewPipelineConfig(this.cwd, {
      maxReviewIterations: this.options.maxReviewIterations,
      maxExternalIterations: this.options.maxExternalIterations,
      reviewPatience: this.options.reviewPatience
    });
    const loopReports: ReviewLoopReport[] = [];
    let latestFindings: Finding[] = [];

    const sourceLabel = reviewPipeline.sourcePath
      ? `${reviewPipeline.source} (${toDisplayPath(this.cwd, reviewPipeline.sourcePath)})`
      : reviewPipeline.source;
    await this.logger.info(`review pipeline: ${sourceLabel}, passes=${reviewPipeline.passes.length}`);

    for (const pass of reviewPipeline.passes) {
      if (pass.kind === "scan") {
        latestFindings = await this.runReviewScanPass(pass, baseBranch, plan.path, latestFindings);
        continue;
      }

      const loop = await this.runReviewFixLoop({
        passId: pass.id,
        baseBranch,
        planPath: plan.path,
        validationCommands: plan.validationCommands,
        focusSeverities: pass.severities,
        agents: pass.agents,
        maxIterations: pass.maxIterations,
        patience: pass.patience,
        initialFindings: latestFindings
      });
      latestFindings = loop.findings;
      loopReports.push(loop.report);
      await this.logger.info(
        `review/${pass.id}: stop=${loop.report.stopReason}, findings=${summarizeReviewFindings(latestFindings)}`
      );
    }

    const summary = countFindingsBySeverity(latestFindings);
    const blockingSeverities: Finding["severity"][] = ["critical", "high"];
    const hasBlockingFindings = latestFindings.some((finding) => blockingSeverities.includes(finding.severity));
    const reviewStatus: ReviewRunSummary["status"] =
      summary.total === 0 ? "clean" : hasBlockingFindings ? "failed" : "warnings";
    const finalLoopStopReason = loopReports.at(-1)?.stopReason ?? "pipeline_completed";
    const stopReason = `${finalLoopStopReason} (gate=critical+high)`;

    const reviewSummary: ReviewRunSummary = {
      gate: "critical+high",
      status: reviewStatus,
      stopReason,
      findings: summary
    };
    this.state.review = reviewSummary;
    await this.stateStore.write(this.state);

    await this.writeReviewReport({
      baseBranch,
      planPath: plan.path,
      gate: "critical+high",
      status: reviewStatus,
      stopReason,
      loops: loopReports,
      findings: latestFindings
    });
    await this.writeMandatoryBacklog(latestFindings);

    if (reviewStatus === "clean") {
      await this.logger.success("final review is clean");
      return reviewSummary;
    }

    if (!hasBlockingFindings) {
      await this.logger.warn(`review finished with non-blocking findings: ${summarizeReviewFindings(latestFindings)}`);
      for (const preview of previewFindings(latestFindings, 3)) {
        await this.logger.warn(`remaining finding: ${preview}`);
      }
      if (latestFindings.length > 3) {
        await this.logger.warn(`remaining findings: +${latestFindings.length - 3} more`);
      }
      return reviewSummary;
    }

    await this.logger.error(`final review still has blocking findings: ${summarizeReviewFindings(latestFindings)}`);
    for (const preview of previewFindings(latestFindings, 3)) {
      await this.logger.error(`remaining finding: ${preview}`);
    }
    if (latestFindings.length > 3) {
      await this.logger.error(`remaining findings: +${latestFindings.length - 3} more`);
    }
    throw new Error(buildReviewFailureMessage(latestFindings, blockingSeverities));
  }

  private async runReviewScanPass(
    pass: Extract<ResolvedReviewPassConfig, { kind: "scan" }>,
    baseBranch: string,
    planPath: string,
    previousFindings: Finding[]
  ): Promise<Finding[]> {
    await this.logger.info(
      `review/${pass.id}: scan (${pass.severities.join("+")})${formatAgentSetForLog(pass.agents)}`
    );
    const review = await this.reviewOnce(
      baseBranch,
      planPath,
      pass.severities,
      `review/${pass.id}: scan`,
      pass.agents
    );
    const findings = mergeFocusedReviewFindings(previousFindings, review.findings, pass.severities);
    await this.logger.info(`review/${pass.id}: findings=${summarizeReviewFindings(findings)}`);

    if (findings.length > 0) {
      for (const preview of previewFindings(findings, 3)) {
        await this.logger.warn(preview);
      }
      if (findings.length > 3) {
        await this.logger.warn(`+${findings.length - 3} more findings`);
      }
    }
    return findings;
  }

  private async runReviewFixLoop(input: ReviewLoopInput): Promise<ReviewLoopOutcome> {
    if (input.initialFindings.length === 0) {
      await this.logger.info(`review/${input.passId}: skipped (no findings from previous stage)`);
      return {
        report: {
          name: input.passId,
          iterations: 0,
          stopReason: "clean",
          findings: countFindingsBySeverity(input.initialFindings)
        },
        findings: input.initialFindings
      };
    }

    if (input.maxIterations <= 0) {
      await this.logger.info(`review/${input.passId}: skipped (max iterations is 0)`);
      return {
        report: {
          name: input.passId,
          iterations: 0,
          stopReason: "disabled",
          findings: countFindingsBySeverity(input.initialFindings)
        },
        findings: input.initialFindings
      };
    }

    let findings = input.initialFindings;
    let unchangedRounds = 0;
    let previousSignature = findingsSignature(filterFindingsBySeverities(findings, input.focusSeverities));

    for (let iteration = 1; iteration <= input.maxIterations; iteration += 1) {
      const scopedFindings = filterFindingsBySeverities(findings, input.focusSeverities);
      if (scopedFindings.length === 0) {
        await this.logger.info(`review/${input.passId}: loop finished (no target findings remain)`);
        return {
          report: {
            name: input.passId,
            iterations: iteration - 1,
            stopReason: "no_target_findings",
            findings: countFindingsBySeverity(findings)
          },
          findings
        };
      }

      await this.logger.info(
        `review/${input.passId}: iteration ${iteration}/${input.maxIterations} - fix ${scopedFindings.length} findings (${input.focusSeverities.join("+")})${formatAgentSetForLog(input.agents)}`
      );

      const fixPrompt = buildReviewFixPrompt(scopedFindings, input.validationCommands);
      const beforeSummary = summarizeReviewFindings(findings);
      const fixResult = await this.runCodexWithLimitWait(
        fixPrompt,
        `review/${input.passId}: codex fix request ${iteration}/${input.maxIterations}`
      );
      if (fixResult.error) {
        throw new Error(`review ${input.passId} fix failed: ${fixResult.error.message}`);
      }

      await this.logger.info(`review/${input.passId}: codex: ${summarizeCodexOutput(fixResult.output)}`);
      await this.logger.info(`review/${input.passId}: running validations (${input.validationCommands.length} commands)`);
      const validation = await this.runValidationCommands(input.validationCommands, `review/${input.passId}`);
      if (!validation.ok) {
        throw new Error(`review ${input.passId} fixes failed validation:\n${validation.output}`);
      }

      const committed = this.options.isGit
        ? await this.git.stageAllAndCommit(
          `fix(review): ${input.passId} iteration ${iteration} (${input.focusSeverities.join("+")})`
        )
        : false;
      if (this.options.isGit) {
        if (committed) {
          await this.logger.info(`review/${input.passId}: committed fix iteration ${iteration}`);
        } else {
          await this.logger.info(`review/${input.passId}: no code changes to commit`);
        }
      } else {
        await this.logger.info(`review/${input.passId}: local mode, skipping git commit`);
      }

      const review = await this.reviewOnce(
        input.baseBranch,
        input.planPath,
        input.focusSeverities,
        `review/${input.passId}: codex review request ${iteration}/${input.maxIterations}`,
        input.agents
      );
      findings = mergeFocusedReviewFindings(findings, review.findings, input.focusSeverities);
      const afterSummary = summarizeReviewFindings(findings);
      await this.logger.info(`review/${input.passId}: findings ${beforeSummary} -> ${afterSummary}`);

      const currentSignature = findingsSignature(filterFindingsBySeverities(findings, input.focusSeverities));
      if (input.patience > 0) {
        const isUnchanged = !committed && currentSignature === previousSignature;
        if (isUnchanged) {
          unchangedRounds += 1;
          await this.logger.warn(
            `review/${input.passId}: unchanged iteration (${unchangedRounds}/${input.patience})`
          );
          if (unchangedRounds >= input.patience) {
            await this.logger.warn(`review/${input.passId}: loop stopped by patience (stalemate)`);
            return {
              report: {
                name: input.passId,
                iterations: iteration,
                stopReason: "stalemate",
                findings: countFindingsBySeverity(findings)
              },
              findings
            };
          }
        } else {
          unchangedRounds = 0;
        }
      }

      previousSignature = currentSignature;
    }

    await this.logger.warn(`review/${input.passId}: max iterations reached, moving forward`);
    return {
      report: {
        name: input.passId,
        iterations: input.maxIterations,
        stopReason: "max_iterations",
        findings: countFindingsBySeverity(findings)
      },
      findings
    };
  }

  private async writeReviewReport(report: {
    baseBranch: string;
    planPath: string;
    gate: "critical+high";
    status: ReviewRunSummary["status"];
    stopReason: string;
    loops: ReviewLoopReport[];
    findings: Finding[];
  }): Promise<void> {
    const runDir = path.dirname(this.logger.logPath);
    const reportPath = await writeReviewArtifact(runDir, this.runId, {
      generatedAt: new Date().toISOString(),
      mandatoryBacklog: report.findings.filter(
        (finding) => finding.severity === "medium" || finding.severity === "low"
      ),
      ...report
    });
    await this.logger.info(`review: report saved -> ${toDisplayPath(this.cwd, reportPath)}`);
  }

  private async writeMandatoryBacklog(findings: Finding[]): Promise<void> {
    const result = await writeMandatoryStabilityBacklog(this.cwd, {
      runId: this.runId,
      findings
    });

    if (result.updated) {
      this.finalizeExtraCommitPaths = [result.path];
    } else {
      this.finalizeExtraCommitPaths = [];
    }

    if (result.count > 0) {
      if (!result.updated) {
        await this.logger.info(
          `review: mandatory medium/low backlog unchanged (${result.count} findings) -> ${toDisplayPath(this.cwd, result.path)}`
        );
        return;
      }
      await this.logger.warn(
        `review: mandatory medium/low backlog updated (${result.count} findings) -> ${toDisplayPath(this.cwd, result.path)}`
      );
      return;
    }

    if (result.updated) {
      await this.logger.info(`review: cleared mandatory medium/low backlog section -> ${toDisplayPath(this.cwd, result.path)}`);
      return;
    }

    await this.logger.info("review: no medium/low findings to write");
  }

  private async runMemoryPhase(): Promise<void> {
    await this.logger.info("memory phase skipped: using completed plans context instead of MEMORY.md");
  }

  private recordMemoryIncident(message: string): void {
    const normalized = message.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return;
    }
    if (this.memoryIncidents.includes(normalized)) {
      return;
    }
    this.memoryIncidents.push(normalized);
    if (this.memoryIncidents.length > 20) {
      this.memoryIncidents = this.memoryIncidents.slice(-20);
    }
  }

  private async reviewOnce(
    baseBranch: string,
    planPath: string,
    severities: Finding["severity"][] = ["critical", "high", "medium", "low"],
    progressLabel = "review: codex request",
    agentNames?: string[]
  ) {
    return runReview({
      maxRetries: this.options.maxTaskRetries,
      multiPrompt: buildReviewPromptMultiAgentFocused(baseBranch, planPath, severities, {
        isGit: this.options.isGit,
        cwd: this.cwd,
        agentNames
      }),
      runPrompt: async (prompt) => this.runCodexWithLimitWait(prompt, progressLabel),
      parse: parseReviewResult,
      onWarn: async (message) => this.logger.warn(message)
    });
  }

  private async runCodexWithLimitWait(prompt: string, progressLabel = "codex request") {
    while (true) {
      const startedAt = Date.now();
      const result = await this.codex.run(prompt);
      const elapsed = formatRunningDuration(Date.now() - startedAt);

      if (!result.isRateLimited) {
        await this.logger.debug(`${progressLabel}: completed in ${elapsed}`);
        return result;
      }

      await this.logger.warn(
        `${progressLabel}: rate limit detected after ${elapsed}, waiting ${this.options.waitOnLimitMs}ms before retry`
      );
      await sleep(this.options.waitOnLimitMs);
    }
  }

  private async runValidationCommands(
    commands: string[],
    scopeLabel: string
  ): Promise<{ ok: boolean; output: string; failedCommandIndex?: number; failedCommand?: string }> {
    let output = "";
    let failure: { index: number; command: string } | undefined;

    for (let index = 0; index < commands.length; index += 1) {
      const command = commands[index];
      if (!command) {
        continue;
      }
      await this.logger.info(`${scopeLabel}: validate ${index + 1}/${commands.length} -> ${command}`);
      await this.logger.debug(`validate: ${command}`);
      const commandStartedAt = Date.now();
      const shell = process.platform === "win32" ? "cmd" : "sh";
      const shellArgs = process.platform === "win32" ? ["/c", command] : ["-lc", command];
      const result = await runCommand(shell, shellArgs, {
        cwd: this.cwd,
        onStdoutLine: async (line) => this.logger.rawToolOutput(line),
        onStderrLine: async (line) => this.logger.rawToolOutput(line)
      });
      const commandElapsed = formatRunningDuration(Date.now() - commandStartedAt);

      output += `\n$ ${command}\n${result.stdout}\n${result.stderr}`;
      if (result.code !== 0) {
        await this.logger.warn(
          `${scopeLabel}: validate ${index + 1}/${commands.length} failed in ${commandElapsed} (exit ${result.code})`
        );
        failure = { index: index + 1, command };
        break;
      }
      await this.logger.info(`${scopeLabel}: validate ${index + 1}/${commands.length} passed in ${commandElapsed}`);
    }

    const relocated = await relocateKnownProjectArtifacts(this.cwd);
    for (const item of relocated) {
      await this.logger.debug(`artifact relocated: ${item.sourceRelativePath} -> ${item.targetRelativePath}`);
    }

    if (failure) {
      return {
        ok: false,
        output,
        failedCommandIndex: failure.index,
        failedCommand: failure.command
      };
    }

    return { ok: true, output };
  }

  private async countCommits(baseBranch: string): Promise<number> {
    const verify = await runCommand("git", ["rev-parse", "--verify", `${baseBranch}^{commit}`], { cwd: this.cwd });
    if (verify.code !== 0) {
      return 0;
    }

    const result = await runCommand("git", ["rev-list", "--count", `${baseBranch}..HEAD`], { cwd: this.cwd });
    if (result.code !== 0) {
      return 0;
    }
    const value = Number(result.stdout.trim());
    return Number.isNaN(value) ? 0 : value;
  }

  private async finishSuccess(stats: RunStats): Promise<void> {
    this.state.phase = "finalize";
    this.state.status = "completed";
    this.state.finishedAt = new Date().toISOString();
    this.state.stats = stats;
    delete this.state.currentTask;
    delete this.state.error;
    await this.stateStore.write(this.state);
  }

  private async fail(message: string): Promise<void> {
    if (!this.state) {
      this.state = {
        runId: this.runId,
        planPath: this.options.planPath,
        branch: "unknown",
        phase: "preflight",
        status: "failed",
        startedAt: new Date(this.startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        error: message
      };
      await this.stateStore.write(this.state);
      await this.logger.error(message);
      return;
    }
    this.state.status = "failed";
    this.state.finishedAt = new Date().toISOString();
    this.state.error = message;
    if (this.state.phase !== "tasks") {
      delete this.state.currentTask;
    }
    await this.stateStore.write(this.state);
    await this.logger.error(message);
  }

  private attachRunStateDiagnostics(): void {
    const storeWithDiagnostics = this.stateStore as unknown as {
      setDiagnosticHandler?: (handler: (diagnostic: RunStateStoreDiagnostic) => Promise<void>) => void;
    };
    storeWithDiagnostics.setDiagnosticHandler?.((diagnostic) => this.logRunStateDiagnostic(diagnostic));
  }

  private async logRunStateDiagnostic(diagnostic: RunStateStoreDiagnostic): Promise<void> {
    const level = mapRunStateDiagnosticLevel(diagnostic.code);
    const loggerWithDiagnostic = this.logger as unknown as {
      diagnostic?: (
        level: "INFO" | "WARN" | "ERROR",
        message: string,
        verboseDetail?: string
      ) => Promise<void>;
    };
    if (loggerWithDiagnostic.diagnostic) {
      await loggerWithDiagnostic.diagnostic(level, diagnostic.message, diagnostic.verboseDetail);
      return;
    }

    const payload = formatDiagnosticForOutput(diagnostic.message, diagnostic.verboseDetail);
    if (level === "INFO") {
      await this.logger.info(payload);
      return;
    }
    if (level === "WARN") {
      await this.logger.warn(payload);
      return;
    }
    await this.logger.error(payload);
  }
}

function isInvalidReviewStatusError(error: unknown): boolean {
  return error instanceof InvalidReviewStatusError;
}

export function summarizeCodexOutput(output: string, maxLength = 140): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const firstLine = lines[0];
  if (!firstLine) {
    return "empty response";
  }

  const operationLine = lines.find((line) => /^operation\s*:\s*/i.test(line));
  if (operationLine) {
    const title = operationLine.replace(/^operation\s*:\s*/i, "").trim();
    if (title) {
      return truncateText(`OPERATION: ${title}`, maxLength);
    }
  }

  return truncateText(firstLine, maxLength);
}

export function summarizeReviewFindings(findings: Finding[]): string {
  const counts = countFindingsBySeverity(findings);
  return `total=${counts.total} (critical=${counts.critical}, high=${counts.high}, medium=${counts.medium}, low=${counts.low})`;
}

export function previewFindings(findings: Finding[], limit: number): string[] {
  return findings.slice(0, Math.max(0, limit)).map((finding) => {
    const shortSummary = truncateText(finding.summary.replace(/\s+/g, " ").trim(), 100);
    return `[${finding.severity}] ${finding.file}:${finding.line} ${shortSummary}`;
  });
}

export function buildReviewFailureMessage(
  findings: Finding[],
  previewLimitOrGate: number | Finding["severity"][] = 3,
  explicitPreviewLimit = 3
): string {
  const gate = Array.isArray(previewLimitOrGate) ? previewLimitOrGate : undefined;
  const previewLimit = Array.isArray(previewLimitOrGate) ? explicitPreviewLimit : previewLimitOrGate;
  const scopedFindings = gate ? filterFindingsBySeverities(findings, gate) : findings;
  const summary = summarizeReviewFindings(scopedFindings);
  const previews = previewFindings(scopedFindings, previewLimit);
  if (previews.length === 0) {
    return `final review still has findings: ${summary}`;
  }
  return `final review still has findings: ${summary}; top findings: ${previews.join(" | ")}`;
}

function countFindingsBySeverity(findings: Finding[]): ReviewSeveritySummary {
  let critical = 0;
  let high = 0;
  let medium = 0;
  let low = 0;

  for (const finding of findings) {
    if (finding.severity === "critical") {
      critical += 1;
      continue;
    }
    if (finding.severity === "high") {
      high += 1;
      continue;
    }
    if (finding.severity === "medium") {
      medium += 1;
      continue;
    }
    low += 1;
  }

  return {
    total: findings.length,
    critical,
    high,
    medium,
    low
  };
}

function filterFindingsBySeverities(findings: Finding[], severities: Finding["severity"][]): Finding[] {
  if (severities.length === 0) {
    return findings;
  }
  const allowed = new Set<Finding["severity"]>(severities);
  return findings.filter((finding) => allowed.has(finding.severity));
}

function mergeFocusedReviewFindings(
  previousFindings: Finding[],
  reviewedFindings: Finding[],
  focusSeverities: Finding["severity"][]
): Finding[] {
  const focused = new Set<Finding["severity"]>(focusSeverities);
  const preservedUnfocused = previousFindings.filter((finding) => !focused.has(finding.severity));
  return dedupeFindings([...preservedUnfocused, ...reviewedFindings]);
}

function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const deduped: Finding[] = [];

  for (const finding of findings) {
    const key = [
      finding.id,
      finding.severity,
      finding.file,
      String(finding.line),
      finding.summary.trim(),
      finding.rationale.trim(),
      finding.suggestedFix ?? ""
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(finding);
  }

  return deduped;
}

function findingsSignature(findings: Finding[]): string {
  return findings
    .map((finding) => `${finding.severity}:${finding.file}:${finding.line}:${finding.summary.trim()}`)
    .sort()
    .join("|");
}

function truncateText(input: string, maxLength: number): string {
  if (input.length <= maxLength) {
    return input;
  }
  return `${input.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatRunningDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes > 0) {
    return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

function formatAgentSetForLog(agents?: string[]): string {
  if (!agents || agents.length === 0) {
    return "";
  }
  return `, agents=${agents.join(",")}`;
}

const PHASE_SEQUENCE: Phase[] = ["preflight", "tasks", "review", "memory", "finalize"];

function assertPhaseProgression(current: Phase, next: Phase): void {
  const currentIndex = PHASE_SEQUENCE.indexOf(current);
  const nextIndex = PHASE_SEQUENCE.indexOf(next);
  if (currentIndex < 0 || nextIndex < 0) {
    throw new Error(`invalid phase transition: ${current} -> ${next}`);
  }
  if (nextIndex <= currentIndex) {
    throw new Error(`phase regression detected: ${current} -> ${next}`);
  }
  if (nextIndex !== currentIndex + 1) {
    throw new Error(`phase transition skipped invariant: ${current} -> ${next}`);
  }
}

function countPendingTasks(plan: Awaited<ReturnType<typeof parsePlanFile>>): number {
  return plan.tasks.filter((task) => task.items.some((item) => !item.checked)).length;
}

function countPendingChecklistItems(task: { items: Array<{ checked: boolean }> }): number {
  return task.items.filter((item) => !item.checked).length;
}

function mapRunStateDiagnosticLevel(code: RunStateStoreDiagnostic["code"]): "INFO" | "WARN" | "ERROR" {
  if (code === "run_state_recovered_after_retry" || code === "run_state_stale_tmp_removed") {
    return "INFO";
  }
  if (code === "run_state_retry") {
    return "WARN";
  }
  if (code === "run_state_retry_exhausted" || code === "run_state_non_retriable_failure") {
    return "ERROR";
  }
  return "WARN";
}

function formatDiagnosticForOutput(message: string, verboseDetail: string): string {
  const summary = message.replace(/\s+/g, " ").trim();
  const detail = verboseDetail.replace(/\s+/g, " ").trim();
  if (!detail) {
    return summary;
  }
  if (!summary) {
    return `verboseDetail: ${detail}`;
  }
  return `${summary}\nverboseDetail: ${detail}`;
}
