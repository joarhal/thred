import type { Finding, ReviewResult } from "../../types.js";

export const INVALID_REVIEW_STATUS_ERROR_CODE = "THRED_INVALID_REVIEW_STATUS";
export const NO_PAYLOAD_FOUND_ERROR_CODE = "THRED_REVIEW_NO_PAYLOAD_FOUND";
export const CONFLICTING_PAYLOADS_ERROR_CODE = "THRED_REVIEW_CONFLICTING_PAYLOADS";

export class InvalidReviewStatusError extends Error {
  readonly code = INVALID_REVIEW_STATUS_ERROR_CODE;
  readonly hint = "Return overallStatus as clean or issues_found";

  constructor() {
    super(
      withDiagnosticDetail(
        "invalid review output: overallStatus must be clean or issues_found",
        "hint=return one JSON object with overallStatus=clean|issues_found and findings=[]"
      )
    );
    this.name = "InvalidReviewStatusError";
  }
}

export class NoPayloadFoundError extends Error {
  readonly code = NO_PAYLOAD_FOUND_ERROR_CODE;
  readonly rawOutput: string;
  readonly candidates: string[];
  readonly hint = "Return exactly one JSON payload matching review schema";

  constructor(rawOutput: string, candidates: string[] = []) {
    super(
      withDiagnosticDetail(
        "invalid review output: no valid review payload found",
        `candidateCount=${candidates.length}; rawChars=${rawOutput.length}; hint=return strict JSON without extra wrappers`
      )
    );
    this.name = "NoPayloadFoundError";
    this.rawOutput = rawOutput;
    this.candidates = [...candidates];
  }
}

export class ConflictingPayloadsError extends Error {
  readonly code = CONFLICTING_PAYLOADS_ERROR_CODE;
  readonly payloads: string[];
  readonly statuses: ReviewResult["overallStatus"][];
  readonly hint = "Return a single final payload for the review result";

  constructor(payloads: string[], statuses: ReviewResult["overallStatus"][]) {
    super(
      withDiagnosticDetail(
        `invalid review output: conflicting review payload statuses (${statuses.join(", ")})`,
        `payloadCount=${payloads.length}; statuses=${statuses.join(",")}; hint=emit only one final review JSON object`
      )
    );
    this.name = "ConflictingPayloadsError";
    this.payloads = [...payloads];
    this.statuses = [...statuses];
  }
}

interface ValidReviewPayloadCandidate {
  raw: string;
  parsed: ReviewResult;
}

export function parseReviewResult(rawOutput: string): ReviewResult {
  const trimmed = rawOutput.trim();
  if (trimmed === "") {
    throw new NoPayloadFoundError(rawOutput);
  }

  const candidates = extractJsonPayloadCandidates(trimmed);
  if (candidates.length === 0) {
    throw new NoPayloadFoundError(rawOutput);
  }

  const validPayloads: ValidReviewPayloadCandidate[] = [];
  for (const candidate of candidates) {
    try {
      validPayloads.push({
        raw: candidate,
        parsed: parseReviewCandidate(candidate)
      });
    } catch {
      // Keep scanning: a valid payload must not be rejected due to neighboring invalid candidates.
    }
  }

  if (validPayloads.length === 0) {
    throw new NoPayloadFoundError(rawOutput, candidates);
  }

  if (validPayloads.length === 1) {
    const singlePayload = validPayloads[0];
    if (!singlePayload) {
      throw new NoPayloadFoundError(rawOutput, candidates);
    }
    return singlePayload.parsed;
  }

  const statuses = validPayloads.map((candidate) => candidate.parsed.overallStatus);
  const uniqueStatuses = [...new Set(statuses)];
  if (uniqueStatuses.length > 1) {
    throw new ConflictingPayloadsError(
      validPayloads.map((candidate) => candidate.raw),
      statuses
    );
  }

  // Multiple valid payloads with a consistent status are treated as iterative
  // drafts; the last one is considered final.
  const lastPayload = validPayloads[validPayloads.length - 1];
  if (!lastPayload) {
    throw new NoPayloadFoundError(rawOutput, candidates);
  }
  return lastPayload.parsed;
}

function parseReviewCandidate(jsonText: string): ReviewResult {
  const parsed = JSON.parse(jsonText) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("invalid review output: payload must be object");
  }
  const candidate = parsed as Partial<ReviewResult> & Record<string, unknown>;
  const hasOverallStatus = Object.prototype.hasOwnProperty.call(candidate, "overallStatus");
  const findingsInput = candidate.findings;
  const hasFindingsArray = Array.isArray(findingsInput);
  const overallStatus = candidate.overallStatus;

  if (overallStatus !== "clean" && overallStatus !== "issues_found") {
    if (hasOverallStatus && hasFindingsArray) {
      throw new InvalidReviewStatusError();
    }
    throw new Error("invalid review output: overallStatus must be clean or issues_found");
  }

  if (!hasFindingsArray) {
    throw new Error("invalid review output: findings must be array");
  }

  const findings = findingsInput.map(validateFinding);

  if (overallStatus === "clean" && findings.length > 0) {
    throw new Error("invalid review output: clean status with non-empty findings");
  }

  if (overallStatus === "issues_found" && findings.length === 0) {
    throw new Error("invalid review output: issues_found requires at least one finding");
  }

  return { overallStatus, findings };
}

function validateFinding(value: unknown): Finding {
  const input = value as Partial<Omit<Finding, "severity">> & { severity?: unknown };

  if (
    !isNonEmptyString(input.id)
    || !isNonEmptyString(input.file)
    || !isNonEmptyString(input.summary)
    || !isNonEmptyString(input.rationale)
  ) {
    throw new Error("invalid finding: required fields missing");
  }
  if (typeof input.line !== "number" || Number.isNaN(input.line) || input.line < 1) {
    throw new Error("invalid finding: line must be positive number");
  }
  const severity = normalizeSeverity(input.severity);
  if (!severity) {
    throw new Error("invalid finding: severity must be critical|high|medium|low");
  }
  if (input.suggestedFix !== undefined && typeof input.suggestedFix !== "string") {
    throw new Error("invalid finding: suggestedFix must be string when provided");
  }

  return {
    id: input.id,
    severity,
    file: input.file,
    line: input.line,
    summary: input.summary,
    rationale: input.rationale,
    suggestedFix: input.suggestedFix
  };
}

function normalizeSeverity(value: unknown): Finding["severity"] | null {
  if (value === "critical" || value === "high" || value === "medium" || value === "low") {
    return value;
  }
  if (value === "major") {
    return "high";
  }
  if (value === "minor") {
    return "medium";
  }
  return null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function extractJsonPayload(rawOutput: string): string {
  const candidates = extractJsonPayloadCandidates(rawOutput);
  if (candidates.length === 0) {
    throw new Error("review output does not contain JSON payload");
  }

  const preferred = candidates.find(isReviewPayload);
  if (preferred) {
    return preferred;
  }

  const first = candidates[0];
  if (!first) {
    throw new Error("review output does not contain JSON payload");
  }
  return first;
}

function extractJsonPayloadCandidates(rawOutput: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const addCandidate = (candidate: string): void => {
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed) || !isJsonObject(trimmed)) {
      return;
    }
    seen.add(trimmed);
    candidates.push(trimmed);
  };

  const fenceMatches = rawOutput.matchAll(/```json\s*([\s\S]*?)\s*```/gi);
  for (const match of fenceMatches) {
    if (match[1]) {
      addCandidate(match[1]);
    }
  }

  const lineCandidates = rawOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}"));
  for (const candidate of lineCandidates) {
    addCandidate(candidate);
  }

  for (const candidate of findJsonObjectCandidates(rawOutput)) {
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

function isReviewPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as Partial<ReviewResult>;
    return (
      (parsed.overallStatus === "clean" || parsed.overallStatus === "issues_found")
      && Array.isArray(parsed.findings)
    );
  } catch {
    return false;
  }
}

function findJsonObjectCandidates(input: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  const starts: number[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

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
      starts.push(i);
      depth += 1;
      continue;
    }

    if (ch === "}" && depth > 0) {
      const start = starts.pop();
      depth -= 1;
      if (start !== undefined) {
        candidates.push(input.slice(start, i + 1));
      }
    }
  }

  return candidates;
}

function withDiagnosticDetail(summary: string, detail: string): string {
  const normalizedSummary = summary.trim();
  const normalizedDetail = detail.replace(/\s+/g, " ").trim();
  if (!normalizedDetail) {
    return normalizedSummary;
  }
  return `${normalizedSummary}\n${normalizedDetail}`;
}
