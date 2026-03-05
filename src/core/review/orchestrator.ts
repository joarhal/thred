import type { ReviewResult } from "../../types.js";
import { ConflictingPayloadsError, NoPayloadFoundError } from "./parse.js";

interface ReviewRunOutput {
  output: string;
  error?: Error;
}

interface ReviewOrchestratorInput {
  maxRetries: number;
  multiPrompt: string;
  runPrompt: (prompt: string) => Promise<ReviewRunOutput>;
  parse: (rawOutput: string) => ReviewResult;
  onWarn: (message: string) => Promise<void>;
}

type ReviewFailureKind = "parse" | "execution";

interface ReviewAttemptFailure {
  kind: ReviewFailureKind;
  error: Error;
}

interface ReviewAttemptSuccess {
  result: ReviewResult;
}

type ReviewAttemptResult = ReviewAttemptSuccess | ReviewAttemptFailure;

const REVIEW_ORCHESTRATOR_ERROR_CODE = "THRED_REVIEW_ORCHESTRATOR_FAILED";

export class ReviewOrchestratorError extends Error {
  readonly code = REVIEW_ORCHESTRATOR_ERROR_CODE;
  readonly modeLabel: string;
  readonly failureKind: ReviewFailureKind;
  readonly attempts: number;

  constructor(input: { modeLabel: string; failureKind: ReviewFailureKind; attempts: number; cause: Error }) {
    super(
      withDiagnosticDetail(
        `${input.modeLabel}: review ${input.failureKind} failed after ${input.attempts} attempt(s): ${input.cause.message}`,
        `kind=${input.failureKind}; attempts=${input.attempts}; code=${extractErrorCode(input.cause)}; ` +
          "hint=check codex output contract and run with --verbose for expanded trace"
      ),
      { cause: input.cause }
    );
    this.name = "ReviewOrchestratorError";
    this.modeLabel = input.modeLabel;
    this.failureKind = input.failureKind;
    this.attempts = input.attempts;
  }
}

export async function runReview(input: ReviewOrchestratorInput): Promise<ReviewResult> {
  const multi = await runReviewAttempts(
    input.maxRetries,
    input.multiPrompt,
    "multi-agent",
    input.runPrompt,
    input.parse,
    input.onWarn
  );

  if ("result" in multi) {
    return multi.result;
  }

  throw multi.error;
}

async function runReviewAttempts(
  maxRetries: number,
  prompt: string,
  modeLabel: string,
  runPrompt: (prompt: string) => Promise<ReviewRunOutput>,
  parse: (rawOutput: string) => ReviewResult,
  onWarn: (message: string) => Promise<void>
): Promise<ReviewAttemptResult> {
  const maxAttempts = maxRetries + 1;
  let lastParseError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const exec = await runPrompt(prompt);

    if (exec.error) {
      if (attempt <= maxRetries) {
        await onWarn(
          withDiagnosticDetail(
            `${modeLabel}: codex execution failed, retrying`,
            `attempt=${attempt}/${maxAttempts}; code=${extractErrorCode(exec.error)}; reason=${exec.error.message}`
          )
        );
        continue;
      }
      return {
        kind: "execution",
        error: new ReviewOrchestratorError({
          modeLabel,
          failureKind: "execution",
          attempts: maxAttempts,
          cause: exec.error
        })
      };
    }

    try {
      return { result: normalizeReviewResult(parse(exec.output)) };
    } catch (error) {
      const parseError = error instanceof Error ? error : new Error(String(error));
      lastParseError = parseError;

      if (attempt <= maxRetries) {
        await onWarn(describeParseRetry(modeLabel, parseError, attempt, maxAttempts));
        continue;
      }
      return {
        kind: "parse",
        error: new ReviewOrchestratorError({
          modeLabel,
          failureKind: "parse",
          attempts: maxAttempts,
          cause: parseError
        })
      };
    }
  }

  return {
    kind: "parse",
    error: lastParseError
      ? new ReviewOrchestratorError({
        modeLabel,
        failureKind: "parse",
        attempts: maxAttempts,
        cause: lastParseError
      })
      : new Error(`${modeLabel}: review output parse failed`)
  };
}

function describeParseRetry(modeLabel: string, error: Error, attempt: number, maxAttempts: number): string {
  if (error instanceof NoPayloadFoundError) {
    return withDiagnosticDetail(
      `${modeLabel}: review output has no valid payload, retrying`,
      `attempt=${attempt}/${maxAttempts}; code=${error.code}; candidateCount=${error.candidates.length}; rawChars=${error.rawOutput.length}`
    );
  }
  if (error instanceof ConflictingPayloadsError) {
    const uniqueStatuses = [...new Set(error.statuses)];
    return withDiagnosticDetail(
      `${modeLabel}: review output has conflicting payloads, retrying`,
      `attempt=${attempt}/${maxAttempts}; code=${error.code}; statuses=${uniqueStatuses.join(",")}; payloadCount=${error.payloads.length}`
    );
  }
  return withDiagnosticDetail(
    `${modeLabel}: review output parse failed, retrying`,
    `attempt=${attempt}/${maxAttempts}; code=${extractErrorCode(error)}; reason=${error.message}`
  );
}

function normalizeReviewResult(result: ReviewResult): ReviewResult {
  const rank: Record<ReviewResult["findings"][number]["severity"], number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3
  };

  const findings = [...result.findings].sort((left, right) => {
    const severityDelta = rank[left.severity] - rank[right.severity];
    if (severityDelta !== 0) {
      return severityDelta;
    }
    const fileDelta = left.file.localeCompare(right.file, "en");
    if (fileDelta !== 0) {
      return fileDelta;
    }
    if (left.line !== right.line) {
      return left.line - right.line;
    }
    return left.id.localeCompare(right.id, "en");
  });

  return {
    overallStatus: result.overallStatus,
    findings
  };
}

function withDiagnosticDetail(summary: string, detail: string): string {
  const normalizedSummary = summary.trim();
  const normalizedDetail = detail.replace(/\s+/g, " ").trim();
  if (!normalizedDetail) {
    return normalizedSummary;
  }
  return `${normalizedSummary}\n${normalizedDetail}`;
}

function extractErrorCode(error: Error): string {
  if (!("code" in error)) {
    return "UNKNOWN";
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.trim().length > 0 ? code : "UNKNOWN";
}
