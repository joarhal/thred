import { readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { RunState, ReviewRunSummary, RunStats } from "../../types.js";
import { ensureDir } from "../util/fs.js";

const RUN_STATE_WRITE_RETRY_DELAYS_MS = [40, 120, 250] as const;
const RUN_STATE_WRITE_MAX_ATTEMPTS = RUN_STATE_WRITE_RETRY_DELAYS_MS.length + 1;
const STALE_TMP_MAX_AGE_MS = 5 * 60 * 1000;
const RETRIABLE_WRITE_ERROR_CODES = new Set(["ENOENT", "EACCES", "EPERM"]);

interface RunStateStoreIo {
  ensureDir: (dirPath: string) => Promise<void>;
  readdir: (dirPath: string) => Promise<string[]>;
  rename: (oldPath: string, newPath: string) => Promise<void>;
  rm: (targetPath: string, options: { force: boolean }) => Promise<void>;
  sleep: (delayMs: number) => Promise<void>;
  stat: (targetPath: string) => Promise<{ isFile: () => boolean; mtimeMs: number }>;
  writeFile: (targetPath: string, payload: string, encoding: "utf8") => Promise<void>;
}

const DEFAULT_IO: RunStateStoreIo = {
  ensureDir,
  readdir,
  rename,
  rm: (targetPath, options) => rm(targetPath, options),
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  stat,
  writeFile: (targetPath, payload, encoding) => writeFile(targetPath, payload, encoding)
};

export interface RunStateStoreDiagnostic {
  code:
    | "run_state_retry"
    | "run_state_retry_exhausted"
    | "run_state_non_retriable_failure"
    | "run_state_recovered_after_retry"
    | "run_state_stale_tmp_removed";
  message: string;
  verboseDetail: string;
}

type RunStateStoreDiagnosticHandler = (diagnostic: RunStateStoreDiagnostic) => void | Promise<void>;

export interface RunStateStoreOptions {
  io?: Partial<RunStateStoreIo>;
  now?: () => number;
  onDiagnostic?: RunStateStoreDiagnosticHandler;
}

export class RunStateStore {
  readonly statePath: string;
  private readonly io: RunStateStoreIo;
  private readonly now: () => number;
  private onDiagnostic?: RunStateStoreDiagnosticHandler;

  constructor(statePath: string, options: RunStateStoreOptions = {}) {
    this.statePath = statePath;
    this.io = {
      ...DEFAULT_IO,
      ...options.io
    };
    this.now = options.now ?? Date.now;
    this.onDiagnostic = options.onDiagnostic;
  }

  static async create(runDir: string, runId: string): Promise<RunStateStore> {
    await ensureDir(runDir);
    return new RunStateStore(path.join(runDir, `${runId}.json`));
  }

  setDiagnosticHandler(onDiagnostic: RunStateStoreDiagnosticHandler | undefined): void {
    this.onDiagnostic = onDiagnostic;
  }

  async write(state: RunState): Promise<void> {
    const normalized = normalizeRunState(state);
    const payload = `${JSON.stringify(normalized, null, 2)}\n`;
    await this.writeAtomically(payload);
  }

  private async writeAtomically(payload: string): Promise<void> {
    const directory = path.dirname(this.statePath);
    const tempPath = `${this.statePath}.tmp`;

    for (let attempt = 0; attempt < RUN_STATE_WRITE_MAX_ATTEMPTS; attempt += 1) {
      await this.cleanupStaleTmpArtifacts(directory);
      let operation = "write temporary run state file";
      try {
        operation = "write temporary run state file";
        await this.io.writeFile(tempPath, payload, "utf8");
        operation = "promote temporary run state file";
        await this.io.rename(tempPath, this.statePath);
        if (attempt > 0) {
          await this.emitDiagnostic({
            code: "run_state_recovered_after_retry",
            message: "run state persistence recovered after retry",
            verboseDetail:
              `statePath=${this.statePath}; tempPath=${tempPath}; attempts=${attempt + 1}/${RUN_STATE_WRITE_MAX_ATTEMPTS}`
          });
        }
        return;
      } catch (error) {
        if (!isRetriableWriteError(error)) {
          await this.emitDiagnostic({
            code: "run_state_non_retriable_failure",
            message: "run state persistence failed with non-retriable error",
            verboseDetail:
              `operation=${operation}; statePath=${this.statePath}; tempPath=${tempPath}; ` +
              `attempt=${attempt + 1}/${RUN_STATE_WRITE_MAX_ATTEMPTS}; code=${getErrorCode(error)}`
          });
          throw buildRunStateWriteError({
            error,
            attempt: attempt + 1,
            operation,
            statePath: this.statePath,
            tempPath,
            maxAttempts: RUN_STATE_WRITE_MAX_ATTEMPTS,
            retryable: false
          });
        }
        await this.io.rm(tempPath, { force: true }).catch(() => undefined);
        await this.io.ensureDir(directory).catch(() => undefined);
        if (attempt >= RUN_STATE_WRITE_RETRY_DELAYS_MS.length) {
          await this.emitDiagnostic({
            code: "run_state_retry_exhausted",
            message: "run state persistence retries exhausted",
            verboseDetail:
              `operation=${operation}; statePath=${this.statePath}; tempPath=${tempPath}; ` +
              `attempt=${attempt + 1}/${RUN_STATE_WRITE_MAX_ATTEMPTS}; code=${getErrorCode(error)}`
          });
          throw buildRunStateWriteError({
            error,
            attempt: attempt + 1,
            operation,
            statePath: this.statePath,
            tempPath,
            maxAttempts: RUN_STATE_WRITE_MAX_ATTEMPTS,
            retryable: true
          });
        }
        const delayMs = RUN_STATE_WRITE_RETRY_DELAYS_MS[attempt] ?? 0;
        await this.emitDiagnostic({
          code: "run_state_retry",
          message: "run state persistence failed, retrying",
          verboseDetail:
            `operation=${operation}; statePath=${this.statePath}; tempPath=${tempPath}; ` +
            `attempt=${attempt + 1}/${RUN_STATE_WRITE_MAX_ATTEMPTS}; code=${getErrorCode(error)}; nextRetryInMs=${delayMs}`
        });
        await this.io.sleep(delayMs);
        continue;
      }
    }
  }

  private async emitDiagnostic(diagnostic: RunStateStoreDiagnostic): Promise<void> {
    if (!this.onDiagnostic) {
      return;
    }
    try {
      await this.onDiagnostic(diagnostic);
    } catch {
      return;
    }
  }

  private async cleanupStaleTmpArtifacts(directory: string): Promise<void> {
    let entries: string[] = [];
    try {
      entries = await this.io.readdir(directory);
    } catch {
      return;
    }

    const threshold = this.now() - STALE_TMP_MAX_AGE_MS;
    for (const entry of entries) {
      if (!entry.endsWith(".tmp")) {
        continue;
      }
      const tempPath = path.join(directory, entry);
      try {
        const details = await this.io.stat(tempPath);
        if (!details.isFile() || details.mtimeMs > threshold) {
          continue;
        }
        await this.io.rm(tempPath, { force: true });
        await this.emitDiagnostic({
          code: "run_state_stale_tmp_removed",
          message: "run state cleanup removed stale temporary artifact",
          verboseDetail: `path=${tempPath}; ageMs=${Math.max(0, this.now() - details.mtimeMs)}`
        });
      } catch {
        continue;
      }
    }
  }
}

function normalizeRunState(state: RunState): RunState {
  const normalized: RunState = {
    runId: state.runId,
    planPath: state.planPath,
    branch: state.branch,
    phase: state.phase,
    status: state.status,
    startedAt: state.startedAt
  };

  if (typeof state.currentTask === "number" && Number.isFinite(state.currentTask) && state.phase === "tasks") {
    normalized.currentTask = state.currentTask;
  }
  if (state.status !== "running" && state.finishedAt) {
    normalized.finishedAt = state.finishedAt;
  }
  if (state.status === "failed" && state.error) {
    normalized.error = state.error;
  }
  if (state.status === "completed" && state.stats) {
    normalized.stats = normalizeRunStats(state.stats);
  }
  if (state.review) {
    normalized.review = normalizeReviewSummary(state.review);
  }

  return normalized;
}

function normalizeRunStats(stats: RunStats): RunStats {
  return {
    commits: stats.commits,
    files: stats.files,
    additions: stats.additions,
    deletions: stats.deletions
  };
}

function normalizeReviewSummary(review: ReviewRunSummary): ReviewRunSummary {
  return {
    gate: review.gate,
    status: review.status,
    stopReason: review.stopReason,
    findings: {
      total: review.findings.total,
      critical: review.findings.critical,
      high: review.findings.high,
      medium: review.findings.medium,
      low: review.findings.low
    }
  };
}

interface RunStateWriteErrorContext {
  error: unknown;
  attempt: number;
  operation: string;
  statePath: string;
  tempPath: string;
  maxAttempts: number;
  retryable: boolean;
}

function buildRunStateWriteError(context: RunStateWriteErrorContext): Error {
  const cause = context.error instanceof Error ? context.error : new Error(String(context.error));
  const code = getErrorCode(context.error);
  const modeLabel = context.retryable ? "retries exhausted" : "non-retriable failure";
  const summary = `run state persistence failed (${modeLabel})`;
  const detail =
    `operation=${context.operation}; statePath=${context.statePath}; tempPath=${context.tempPath}; ` +
    `attempt=${context.attempt}/${context.maxAttempts}; code=${code}; ` +
    "hint=ensure .thred/artifacts/runs exists and is writable";

  const wrapped = new Error(`${summary}\n${detail}`, { cause });
  wrapped.name = "RunStateStoreWriteError";
  (wrapped as NodeJS.ErrnoException).code = code;
  return wrapped;
}

function getErrorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return "UNKNOWN";
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.trim().length > 0 ? code : "UNKNOWN";
}

function isRetriableWriteError(error: unknown): boolean {
  if (!(error && typeof error === "object" && "code" in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && RETRIABLE_WRITE_ERROR_CODES.has(code);
}
