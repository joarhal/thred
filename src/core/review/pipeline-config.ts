import path from "node:path";
import { open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import YAML from "yaml";

import type { Finding, RunOptions } from "../../types.js";
import { ensureDir, exists } from "../util/fs.js";
import { SETTINGS_PATH } from "../settings/service.js";

const REVIEW_PIPELINE_VERSION = 1;
const LEGACY_REVIEW_PIPELINE_CONFIG_PATH = path.join(".thred", "review-pipeline.json");
const SETTINGS_LOCK_SUFFIX = ".lock";
const SETTINGS_LOCK_RETRY_MS = 50;
const SETTINGS_LOCK_TIMEOUT_MS = 5000;
const SETTINGS_STALE_LOCK_MS = 30000;
const DEFAULT_FULL_REVIEW_AGENTS = ["implementation", "quality", "testing", "simplification", "documentation"];
const DEFAULT_STABILIZE_REVIEW_AGENTS = ["implementation", "quality", "testing", "simplification"];

type ReviewSeverity = Finding["severity"];
type ReviewPassKind = "scan" | "fix_loop";

export interface ReviewPassConfig {
  id: string;
  kind: ReviewPassKind;
  severities: ReviewSeverity[];
  agents?: string[];
}

export interface ReviewScanPassConfig extends ReviewPassConfig {
  kind: "scan";
}

export interface ReviewFixLoopPassConfig extends ReviewPassConfig {
  kind: "fix_loop";
  maxIterations: number;
  patience: number;
}

export type ResolvedReviewPassConfig = ReviewScanPassConfig | ReviewFixLoopPassConfig;

export interface ReviewPipelineConfig {
  source: "default" | "local";
  sourcePath?: string;
  passes: ResolvedReviewPassConfig[];
}

export interface ReviewScanPassFileConfig {
  kind: "scan";
  severities: ReviewSeverity[];
  agents?: string[];
}

export interface ReviewFixLoopPassFileConfig {
  kind: "fix_loop";
  severities: ReviewSeverity[];
  agents?: string[];
  maxIterations: number;
  patience?: number;
}

export type ReviewPassFileConfig = ReviewScanPassFileConfig | ReviewFixLoopPassFileConfig;
export type ReviewPipelinePasses = Record<string, ReviewPassFileConfig>;
type ResolvedReviewPassBodyConfig = Omit<ReviewScanPassConfig, "id"> | Omit<ReviewFixLoopPassConfig, "id">;

export interface ReviewPipelineFile {
  version: 1;
  passes: ReviewPipelinePasses;
}

interface RawReviewPassConfig {
  id?: unknown;
  kind?: unknown;
  severities?: unknown;
  agents?: unknown;
  maxIterations?: unknown;
  patience?: unknown;
}

interface RawReviewPipelineConfig {
  version?: unknown;
  passes?: unknown;
}

export async function loadReviewPipelineConfig(
  cwd: string,
  options: Pick<RunOptions, "maxReviewIterations" | "maxExternalIterations" | "reviewPatience">
): Promise<ReviewPipelineConfig> {
  const settingsPath = path.join(cwd, SETTINGS_PATH);
  if (await exists(settingsPath)) {
    const settings = await readSettingsDocument(settingsPath);
    if (!settings) {
      throw new Error(`thred settings is invalid (${settingsPath})`);
    }
    if (Object.hasOwn(settings, "reviewPipeline")) {
      const reviewPipeline = Reflect.get(settings, "reviewPipeline");
      if (reviewPipeline === undefined) {
        throw new Error(`reviewPipeline cannot be undefined in ${settingsPath}`);
      }
      return {
        source: "local",
        sourcePath: settingsPath,
        passes: validateReviewPipelineConfig(reviewPipeline, settingsPath)
      };
    }
  }

  const legacyPath = path.join(cwd, LEGACY_REVIEW_PIPELINE_CONFIG_PATH);
  if (await exists(legacyPath)) {
    return {
      source: "local",
      sourcePath: legacyPath,
      passes: await readAndValidateJsonConfig(legacyPath)
    };
  }

  return {
    source: "default",
    passes: validateReviewPipelineConfig(buildDefaultReviewPipelineFile(options), "built-in defaults")
  };
}

export function buildDefaultReviewPipelineFile(
  options: Pick<RunOptions, "maxReviewIterations" | "maxExternalIterations" | "reviewPatience">
): ReviewPipelineFile {
  return {
    version: REVIEW_PIPELINE_VERSION,
    passes: {
      baseline_scan: {
        kind: "scan",
        severities: ["critical", "high", "medium", "low"],
        agents: DEFAULT_FULL_REVIEW_AGENTS
      },
      stabilize: {
        kind: "fix_loop",
        severities: ["critical", "high", "medium", "low"],
        agents: DEFAULT_STABILIZE_REVIEW_AGENTS,
        maxIterations: options.maxExternalIterations,
        patience: options.reviewPatience
      },
      final_gate: {
        kind: "scan",
        severities: ["critical", "high", "medium", "low"],
        agents: DEFAULT_FULL_REVIEW_AGENTS
      }
    }
  };
}

export async function writeReviewPipelineFile(cwd: string, file: ReviewPipelineFile): Promise<string> {
  const settingsPath = path.join(cwd, SETTINGS_PATH);
  await withSettingsDocumentLock(settingsPath, async () => {
    await ensureDir(path.dirname(settingsPath));
    const existingSettings = await readSettingsDocument(settingsPath) ?? {};
    if (Object.hasOwn(existingSettings, "reviewPipeline")) {
      return;
    }
    const nextSettings = {
      ...existingSettings,
      reviewPipeline: file
    };
    await writeFile(settingsPath, formatYamlDocument(nextSettings), "utf8");
  });
  return settingsPath;
}

async function readAndValidateJsonConfig(configPath: string): Promise<ResolvedReviewPassConfig[]> {
  let parsed: unknown;
  try {
    const raw = await readFile(configPath, "utf8");
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`review pipeline config is invalid (${configPath}): ${message}`);
  }

  return validateReviewPipelineConfig(parsed, configPath);
}

async function readSettingsDocument(settingsPath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(settingsPath, "utf8");
    const parsed = YAML.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return { ...(parsed as Record<string, unknown>) };
  } catch {
    return null;
  }
}

function formatYamlDocument(document: Record<string, unknown>): string {
  return `${YAML.stringify(document, { indent: 2, lineWidth: 0, aliasDuplicateObjects: false }).trimEnd()}\n`;
}

function validateReviewPipelineConfig(input: unknown, configPath: string): ResolvedReviewPassConfig[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`review pipeline config must be an object: ${configPath}`);
  }

  const raw = input as RawReviewPipelineConfig;
  if (raw.version !== undefined && raw.version !== REVIEW_PIPELINE_VERSION) {
    throw new Error(`review pipeline config version must be ${REVIEW_PIPELINE_VERSION}: ${configPath}`);
  }

  if (Array.isArray(raw.passes)) {
    return validateLegacyPassArray(raw.passes, configPath);
  }

  if (!raw.passes || typeof raw.passes !== "object" || Array.isArray(raw.passes)) {
    throw new Error(`review pipeline config must include non-empty passes mapping: ${configPath}`);
  }

  return validatePassMap(raw.passes as Record<string, unknown>, configPath);
}

function validatePassMap(passesMap: Record<string, unknown>, configPath: string): ResolvedReviewPassConfig[] {
  const entries = Object.entries(passesMap);
  if (entries.length === 0) {
    throw new Error(`review pipeline config must include non-empty passes mapping: ${configPath}`);
  }

  const seenIds = new Set<string>();
  const passes: ResolvedReviewPassConfig[] = [];
  for (const [index, [passId, passInput]] of entries.entries()) {
    const id = validatePassId(passId, index, configPath, "mapping key");
    if (seenIds.has(id)) {
      throw new Error(`review pipeline config has duplicate pass id "${id}": ${configPath}`);
    }
    seenIds.add(id);

    const body = validateReviewPassBody(passInput, index, configPath);
    passes.push(attachPassId(id, body));
  }

  return passes;
}

function validateLegacyPassArray(entries: unknown[], configPath: string): ResolvedReviewPassConfig[] {
  if (entries.length === 0) {
    throw new Error(`review pipeline config must include non-empty passes mapping: ${configPath}`);
  }

  const seenIds = new Set<string>();
  const passes: ResolvedReviewPassConfig[] = [];
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`review pipeline pass #${index + 1} must be object: ${configPath}`);
    }
    const raw = entry as RawReviewPassConfig;
    const id = validatePassId(raw.id, index, configPath, "legacy id");
    if (seenIds.has(id)) {
      throw new Error(`review pipeline config has duplicate pass id "${id}": ${configPath}`);
    }
    seenIds.add(id);

    const body = validateReviewPassBody(raw, index, configPath);
    passes.push(attachPassId(id, body));
  }

  return passes;
}

function validateReviewPassBody(
  input: unknown,
  index: number,
  configPath: string
): ResolvedReviewPassBodyConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`review pipeline pass #${index + 1} must be object: ${configPath}`);
  }

  const raw = input as RawReviewPassConfig;
  const kind = validatePassKind(raw.kind, index, configPath);
  const severities = validatePassSeverities(raw.severities, index, configPath);
  const agents = validatePassAgents(raw.agents, index, configPath);

  if (kind === "scan") {
    return {
      kind,
      severities,
      agents
    };
  }

  const maxIterations = validateNonNegativeInt(raw.maxIterations, "maxIterations", index, configPath);
  const patience = raw.patience === undefined
    ? 0
    : validateNonNegativeInt(raw.patience, "patience", index, configPath);

  return {
    kind,
    severities,
    agents,
    maxIterations,
    patience
  };
}

function attachPassId(id: string, body: ResolvedReviewPassBodyConfig): ResolvedReviewPassConfig {
  if (body.kind === "scan") {
    return {
      id,
      kind: "scan",
      severities: body.severities,
      agents: body.agents
    };
  }

  return {
    id,
    kind: "fix_loop",
    severities: body.severities,
    agents: body.agents,
    maxIterations: body.maxIterations,
    patience: body.patience
  };
}

function validatePassId(value: unknown, index: number, configPath: string, source: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`review pipeline pass #${index + 1} ${source} must be non-empty string: ${configPath}`);
  }
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(normalized)) {
    throw new Error(
      `review pipeline pass #${index + 1} id "${normalized}" must match [a-zA-Z0-9_-]+: ${configPath}`
    );
  }
  return normalized;
}

function validatePassKind(value: unknown, index: number, configPath: string): ReviewPassKind {
  if (value === "scan") {
    return "scan";
  }
  if (value === "fix_loop" || value === "fix-loop") {
    return "fix_loop";
  }
  throw new Error(`review pipeline pass #${index + 1} kind must be scan|fix_loop|fix-loop: ${configPath}`);
}

function validatePassSeverities(value: unknown, index: number, configPath: string): ReviewSeverity[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`review pipeline pass #${index + 1} severities must be non-empty array: ${configPath}`);
  }

  const parsed: ReviewSeverity[] = [];
  for (const severity of value) {
    const normalized = normalizeSeverityAlias(severity);
    if (!normalized) {
      throw new Error(
        `review pipeline pass #${index + 1} severity must be critical|high|medium|low: ${configPath}`
      );
    }
    if (!parsed.includes(normalized)) {
      parsed.push(normalized);
    }
  }
  return parsed;
}

function normalizeSeverityAlias(value: unknown): ReviewSeverity | null {
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

function validatePassAgents(value: unknown, index: number, configPath: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`review pipeline pass #${index + 1} agents must be non-empty array when set: ${configPath}`);
  }

  const parsed: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") {
      throw new Error(`review pipeline pass #${index + 1} agents must contain non-empty strings: ${configPath}`);
    }
    const normalized = item.trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(normalized)) {
      throw new Error(
        `review pipeline pass #${index + 1} agent "${normalized}" must match [a-zA-Z0-9_-]+: ${configPath}`
      );
    }
    if (!parsed.includes(normalized)) {
      parsed.push(normalized);
    }
  }
  return parsed;
}

function validateNonNegativeInt(value: unknown, field: string, index: number, configPath: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `review pipeline pass #${index + 1} ${field} must be non-negative integer: ${configPath}`
    );
  }
  return value;
}

async function withSettingsDocumentLock<T>(settingsPath: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${settingsPath}${SETTINGS_LOCK_SUFFIX}`;
  const timeoutAt = Date.now() + SETTINGS_LOCK_TIMEOUT_MS;
  let lockAcquired = false;
  await ensureDir(path.dirname(settingsPath));

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

      if (await isStaleLock(lockPath)) {
        await safeUnlink(lockPath);
        continue;
      }

      if (Date.now() >= timeoutAt) {
        throw new Error(`Timed out waiting for settings lock: ${lockPath}`);
      }

      await sleep(SETTINGS_LOCK_RETRY_MS);
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

async function isStaleLock(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs > SETTINGS_STALE_LOCK_MS;
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
