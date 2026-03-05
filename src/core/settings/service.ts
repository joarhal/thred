import { open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

import { ensureDir, exists } from "../util/fs.js";

export const SETTINGS_DIR = ".thred";
export const SETTINGS_FILE = "settings.yaml";
export const LEGACY_SETTINGS_FILE = "settings.json";
export const SETTINGS_PATH = path.join(SETTINGS_DIR, SETTINGS_FILE);
const LEGACY_SETTINGS_PATH = path.join(SETTINGS_DIR, LEGACY_SETTINGS_FILE);
const SETTINGS_LOCK_SUFFIX = ".lock";
const SETTINGS_LOCK_RETRY_MS = 50;
const SETTINGS_LOCK_TIMEOUT_MS = 5000;
const SETTINGS_STALE_LOCK_MS = 30000;

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface ThredSettings {
  model: string;
  reasoningEffort: ReasoningEffort;
}

export interface SettingsSnapshot {
  path: string;
  settings: ThredSettings;
  created: boolean;
}

export const INHERIT_MODEL = "inherit";
export const DEFAULT_MODEL = INHERIT_MODEL;
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "high";

export async function loadThredSettings(cwd: string): Promise<SettingsSnapshot> {
  const settingsPath = path.join(cwd, SETTINGS_PATH);
  return withSettingsFileLock(settingsPath, async () => {
    await ensureDir(path.dirname(settingsPath));

    const defaults: ThredSettings = {
      model: DEFAULT_MODEL,
      reasoningEffort: DEFAULT_REASONING_EFFORT
    };

    const hasYamlSettings = await exists(settingsPath);
    const existingDocument = hasYamlSettings
      ? await readYamlObject(settingsPath)
      : await readLegacySettingsObject(cwd);
    const settings = normalizeSettings(existingDocument, defaults);
    await writeSettings(settingsPath, applySettingsToDocument(existingDocument ?? {}, settings));

    return {
      path: settingsPath,
      settings,
      created: !hasYamlSettings
    };
  });
}

export async function saveThredSettings(cwd: string, settings: ThredSettings): Promise<void> {
  const settingsPath = path.join(cwd, SETTINGS_PATH);
  await withSettingsFileLock(settingsPath, async () => {
    await ensureDir(path.dirname(settingsPath));
    const existingDocument = await readYamlObject(settingsPath) ?? await readLegacySettingsObject(cwd) ?? {};
    const normalized = normalizeSettings(settings, settings);
    await writeSettings(settingsPath, applySettingsToDocument(existingDocument, normalized));
  });
}

export function normalizeReasoningEffort(
  value: string | undefined,
  fallback: ReasoningEffort = DEFAULT_REASONING_EFFORT
): ReasoningEffort {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }
  return fallback;
}

function normalizeSettings(input: unknown, defaults: ThredSettings): ThredSettings {
  if (!input || typeof input !== "object") {
    return defaults;
  }

  const modelRaw = Reflect.get(input, "model");
  const reasoningRaw = Reflect.get(input, "reasoningEffort");
  const model = normalizeModelSetting(typeof modelRaw === "string" ? modelRaw : undefined, defaults.model);
  const reasoningEffort = normalizeReasoningEffort(
    typeof reasoningRaw === "string" ? reasoningRaw : undefined,
    defaults.reasoningEffort
  );

  return { model, reasoningEffort };
}

function normalizeModelSetting(value: string | undefined, fallback: string): string {
  if (!value || value.trim() === "") {
    return fallback;
  }
  if (value.trim().toLowerCase() === INHERIT_MODEL) {
    return INHERIT_MODEL;
  }
  return value.trim();
}

async function writeSettings(settingsPath: string, settings: Record<string, unknown>): Promise<void> {
  const normalized = normalizeDocumentOrder(settings);
  const formatted = formatYamlDocument(normalized);
  const currentContent = await readCurrentContent(settingsPath);
  if (currentContent === formatted) {
    return;
  }
  await writeFile(settingsPath, formatted, "utf8");
}

async function readYamlObject(settingsPath: string): Promise<Record<string, unknown> | null> {
  if (!(await exists(settingsPath))) {
    return null;
  }
  try {
    const parsed = YAML.parse(await readFile(settingsPath, "utf8")) as unknown;
    return normalizeObject(parsed);
  } catch {
    return null;
  }
}

async function readLegacySettingsObject(cwd: string): Promise<Record<string, unknown> | null> {
  const legacyPath = path.join(cwd, LEGACY_SETTINGS_PATH);
  if (!(await exists(legacyPath))) {
    return null;
  }

  try {
    const parsed = JSON.parse(await readFile(legacyPath, "utf8")) as unknown;
    return normalizeObject(parsed);
  } catch {
    return null;
  }
}

function normalizeObject(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  return { ...(input as Record<string, unknown>) };
}

function applySettingsToDocument(
  baseDocument: Record<string, unknown>,
  settings: ThredSettings
): Record<string, unknown> {
  const document = { ...baseDocument };
  delete document.model;
  delete document.reasoningEffort;
  return {
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    ...document
  };
}

function formatYamlDocument(document: Record<string, unknown>): string {
  return `${YAML.stringify(document, { indent: 2, lineWidth: 0, aliasDuplicateObjects: false }).trimEnd()}\n`;
}

async function readCurrentContent(settingsPath: string): Promise<string | null> {
  if (!(await exists(settingsPath))) {
    return null;
  }
  return readFile(settingsPath, "utf8");
}

function normalizeDocumentOrder(document: Record<string, unknown>): Record<string, unknown> {
  const preferredTopLevelKeys = ["model", "reasoningEffort", "reviewPipeline"];
  const sortedEntries = sortEntries(document, preferredTopLevelKeys);
  return Object.fromEntries(sortedEntries);
}

function sortEntries(
  input: Record<string, unknown>,
  preferredOrder: string[]
): Array<[string, unknown]> {
  const keys = Object.keys(input);
  const preferred = preferredOrder.filter((key) => keys.includes(key));
  const rest = keys
    .filter((key) => !preferred.includes(key))
    .sort((a, b) => a.localeCompare(b));
  const orderedKeys = [...preferred, ...rest];
  return orderedKeys.map((key) => [key, input[key]]);
}

async function withSettingsFileLock<T>(settingsPath: string, operation: () => Promise<T>): Promise<T> {
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
