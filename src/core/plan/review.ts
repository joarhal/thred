import path from "node:path";
import { readdir } from "node:fs/promises";

import { buildPlanReviewPrompt } from "../codex/prompts-plan.js";
import {
  getValidationCommandMismatchReason,
  normalizeMarkdownPlan,
  normalizeValidationCommands,
  parsePlan
} from "./parser.js";
import { exists } from "../util/fs.js";

export interface ReviewGeneratedPlanInput {
  sourceText: string;
  sourceMode: "file" | "text";
  sourceLabel: string;
  currentPlan: string;
  projectContext: string;
  validationCommands: string[];
  maxRetries: number;
  cwd: string;
}

export interface ReviewedPlanResult {
  content: string;
  title: string;
  revised: boolean;
  summary: string;
}

interface PlanReviewClient {
  run(prompt: string): Promise<{ output: string; error?: Error; isRateLimited: boolean }>;
}

interface PlanReviewResponse {
  status: "approved" | "needs_revision";
  summary: string;
  issues: string[];
  revisedPlanMarkdown: string;
}

const MIN_CODEBASE_PATH_REFERENCES = 2;
const SPARSE_REPO_MAX_FILES = 3;
const ANCHOR_SCAN_MAX_DEPTH = 5;
const ANCHOR_SCAN_MAX_FILES = 400;
const ANCHOR_SCAN_SKIP_DIRS = new Set([
  ".git",
  ".thred",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "test-results",
  "playwright-report",
  ".next",
  ".turbo",
  ".cache",
  "vendor"
]);
const ROOT_FILENAME_ALLOWLIST = new Set(["makefile", "dockerfile", "license", "readme"]);

export async function reviewGeneratedPlan(
  codex: PlanReviewClient,
  input: ReviewGeneratedPlanInput
): Promise<ReviewedPlanResult> {
  let plan = normalizeMarkdownPlan(input.currentPlan, "<reviewed-plan>");
  let priorFeedback = "";
  let revised = false;
  const maxAttempts = input.maxRetries + 1;
  const requiredAnchors = await computeRequiredAnchorCount(input.cwd);
  const expectedValidationCommands = normalizeValidationCommands(input.validationCommands);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const prompt = buildPlanReviewPrompt({
      sourceText: input.sourceText,
      sourceMode: input.sourceMode,
      sourceLabel: input.sourceLabel,
      currentPlan: plan,
      projectContext: input.projectContext,
      validationCommands: input.validationCommands,
      priorFeedback
    });

    const result = await codex.run(prompt);
    if (result.error) {
      if (attempt < maxAttempts) {
        continue;
      }
      throw result.error;
    }

    let review: PlanReviewResponse;
    try {
      review = parsePlanReviewResponse(result.output);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      priorFeedback = `Review output is invalid: ${message}. Return JSON strictly matching the schema.`;
      if (attempt < maxAttempts) {
        continue;
      }
      throw new Error(priorFeedback);
    }

    let candidate = plan;
    if (review.status === "needs_revision") {
      if (!review.revisedPlanMarkdown.trim()) {
        priorFeedback = "Review asked for revision but returned empty revisedPlanMarkdown.";
        continue;
      }
      candidate = normalizeMarkdownPlan(review.revisedPlanMarkdown, "<reviewed-plan>");
      revised = true;
    }

    let parsedCandidate: ReturnType<typeof parsePlan>;
    try {
      parsedCandidate = parsePlan(candidate, "<reviewed-plan>");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      priorFeedback =
        `Revised plan markdown is invalid: ${message}. ` +
        "Return a FULL corrected markdown plan in revisedPlanMarkdown and keep required sections, especially `## Validation Commands`.";
      if (attempt < maxAttempts) {
        continue;
      }
      throw new Error(priorFeedback);
    }

    const commandMismatchReason = getValidationCommandMismatchReason(
      parsedCandidate.validationCommands,
      expectedValidationCommands
    );
    if (commandMismatchReason) {
      priorFeedback =
        "Revised plan changed validation commands. " +
        `Keep them EXACTLY unchanged in content and order. ${commandMismatchReason}.`;
      plan = candidate;
      if (attempt < maxAttempts) {
        continue;
      }
      throw new Error(priorFeedback);
    }

    const anchorCount = await countExistingPathReferences(input.cwd, candidate);
    if (anchorCount < requiredAnchors) {
      priorFeedback =
        `Plan is not sufficiently anchored to codebase. ` +
        `Include at least ${requiredAnchors} concrete existing file paths. ` +
        `Current count: ${anchorCount}.`;
      plan = candidate;
      if (attempt < maxAttempts) {
        continue;
      }
      throw new Error(priorFeedback);
    }

    const summaryPrefix = review.status === "approved" ? "plan review approved" : "plan review revised";
    const summary = `${summaryPrefix}: ${review.summary.trim() || "no additional notes"}`;
    return {
      content: candidate.endsWith("\n") ? candidate : `${candidate}\n`,
      title: parsedCandidate.title,
      revised,
      summary
    };
  }

  throw new Error("failed to review generated plan");
}

function parsePlanReviewResponse(raw: string): PlanReviewResponse {
  const candidates = extractJsonPayloadCandidates(raw);
  if (candidates.length === 0) {
    throw new Error("plan review output does not contain JSON payload");
  }

  let firstError: Error | null = null;
  for (const candidate of candidates) {
    try {
      return parsePlanReviewCandidate(candidate);
    } catch (error) {
      if (firstError === null) {
        firstError = error instanceof Error ? error : new Error("invalid plan review output");
      }
    }
  }

  throw firstError ?? new Error("invalid plan review output");
}

function parsePlanReviewCandidate(jsonText: string): PlanReviewResponse {
  const parsed = JSON.parse(jsonText) as Partial<PlanReviewResponse>;

  if (parsed.status !== "approved" && parsed.status !== "needs_revision") {
    throw new Error("invalid plan review output: status must be approved|needs_revision");
  }
  if (typeof parsed.summary !== "string") {
    throw new Error("invalid plan review output: summary must be string");
  }
  if (!Array.isArray(parsed.issues) || parsed.issues.some((item) => typeof item !== "string")) {
    throw new Error("invalid plan review output: issues must be string array");
  }
  if (typeof parsed.revisedPlanMarkdown !== "string") {
    throw new Error("invalid plan review output: revisedPlanMarkdown must be string");
  }
  if (parsed.status === "approved" && parsed.revisedPlanMarkdown.trim() !== "") {
    throw new Error("invalid plan review output: approved status requires empty revisedPlanMarkdown");
  }

  const summary = parsed.summary.trim();
  if (!summary) {
    throw new Error("invalid plan review output: summary must not be empty");
  }
  const issues = parsed.issues.map((item) => item.trim()).filter(Boolean);
  const revisedPlanMarkdown = parsed.revisedPlanMarkdown;
  if (parsed.status === "approved" && issues.length > 0) {
    throw new Error("invalid plan review output: approved status requires empty issues");
  }

  return {
    status: parsed.status,
    summary,
    issues,
    revisedPlanMarkdown
  };
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

function findJsonObjectCandidates(input: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (!ch) {
      continue;
    }

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
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }

    if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(input.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

async function countExistingPathReferences(cwd: string, markdown: string): Promise<number> {
  const refs = extractPathReferences(markdown);
  let count = 0;

  for (const ref of refs) {
    const absolutePath = path.join(cwd, ref);
    if (await exists(absolutePath)) {
      count += 1;
    }
  }

  return count;
}

async function computeRequiredAnchorCount(cwd: string): Promise<number> {
  const repoFileCount = await countAnchorableRepoFiles(cwd);
  if (repoFileCount <= 0) {
    return 0;
  }
  if (repoFileCount <= SPARSE_REPO_MAX_FILES) {
    return 1;
  }
  return MIN_CODEBASE_PATH_REFERENCES;
}

async function countAnchorableRepoFiles(cwd: string): Promise<number> {
  let count = 0;

  async function scan(dirRel: string, depth: number): Promise<void> {
    if (depth > ANCHOR_SCAN_MAX_DEPTH || count > SPARSE_REPO_MAX_FILES || count >= ANCHOR_SCAN_MAX_FILES) {
      return;
    }

    const dirAbs = path.join(cwd, dirRel);
    const entries = await readdir(dirAbs, { withFileTypes: true });
    for (const entry of entries) {
      if (count > SPARSE_REPO_MAX_FILES || count >= ANCHOR_SCAN_MAX_FILES) {
        return;
      }

      const relPath = dirRel ? path.join(dirRel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (ANCHOR_SCAN_SKIP_DIRS.has(entry.name)) {
          continue;
        }
        await scan(relPath, depth + 1);
        continue;
      }

      if (entry.name.startsWith(".")) {
        continue;
      }
      count += 1;
    }
  }

  await scan("", 0);
  return count;
}

function extractPathReferences(markdown: string): string[] {
  const refs = new Set<string>();
  const backtickMatches = markdown.matchAll(/`([^`]+)`/g);

  for (const match of backtickMatches) {
    const value = normalizePathToken(match[1] ?? "");
    if (value) {
      refs.add(value);
    }
  }

  const inlineMatches = markdown.matchAll(/(?:^|[\s(])([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?:\.[A-Za-z0-9._-]+)?)/gm);
  for (const match of inlineMatches) {
    const value = normalizePathToken(match[1] ?? "");
    if (value) {
      refs.add(value);
    }
  }

  return Array.from(refs);
}

function normalizePathToken(input: string): string {
  const trimmed = input.trim().replace(/^["'`]+|["'`,.:;!?]+$/g, "");
  if (!trimmed || trimmed.includes(" ") || trimmed.startsWith("http")) {
    return "";
  }
  if (!trimmed.includes("/")) {
    return isLikelyRootFileToken(trimmed) ? trimmed : "";
  }
  if (trimmed.startsWith("../") || trimmed.startsWith("~/") || trimmed.startsWith("/")) {
    return "";
  }
  return trimmed.replace(/\\/g, "/");
}

function isLikelyRootFileToken(input: string): boolean {
  const normalized = input.trim();
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith(".")) {
    return normalized.length > 1;
  }
  if (/^[A-Za-z0-9._-]+\.[A-Za-z0-9_-]{1,12}$/.test(normalized)) {
    return true;
  }
  return ROOT_FILENAME_ALLOWLIST.has(normalized.toLowerCase());
}
