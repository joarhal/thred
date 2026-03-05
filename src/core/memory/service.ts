import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { ensureDir, exists } from "../util/fs.js";

const MEMORY_DIR = ".thred";
const MEMORY_FILE = "MEMORY.md";
export const MEMORY_SOFT_LIMIT_CHARS = 8000;

const DEFAULT_MEMORY_CONTENT = [
  "# Thred Memory",
  "",
  "Persistent compact context carried between runs.",
  "",
  "## Notes"
].join("\n");

export interface MemorySnapshot {
  path: string;
  content: string;
  lineCount: number;
  charCount: number;
}

export async function loadMemorySnapshot(cwd: string): Promise<MemorySnapshot> {
  const memoryPath = path.join(cwd, MEMORY_DIR, MEMORY_FILE);

  if (!(await exists(memoryPath))) {
    await ensureDir(path.dirname(memoryPath));
    const initial = ensureTrailingNewline(DEFAULT_MEMORY_CONTENT);
    await writeFile(memoryPath, initial, "utf8");
  }

  const raw = await readFile(memoryPath, "utf8");
  const normalized = normalizeMemory(raw);
  const finalContent = ensureTrailingNewline(normalized);

  if (finalContent !== raw) {
    await writeFile(memoryPath, finalContent, "utf8");
  }

  return {
    path: memoryPath,
    content: finalContent,
    lineCount: countLines(finalContent),
    charCount: countChars(finalContent)
  };
}

export async function saveMemoryContent(cwd: string, content: string): Promise<MemorySnapshot> {
  const snapshot = await loadMemorySnapshot(cwd);
  const normalized = normalizeMemory(content);
  const finalContent = ensureTrailingNewline(normalized);

  if (finalContent !== snapshot.content) {
    await writeFile(snapshot.path, finalContent, "utf8");
  }
  return {
    path: snapshot.path,
    content: finalContent,
    lineCount: countLines(finalContent),
    charCount: countChars(finalContent)
  };
}

export function parseMemoryRewriteResponse(raw: string): string {
  const markdown = extractMarkdownBody(raw.trim());
  const normalized = normalizeMemory(markdown);
  if (!normalized.trim()) {
    throw new Error("memory output is empty");
  }
  return ensureTrailingNewline(normalized);
}

export function buildMemoryRewritePrompt(input: {
  memoryContent: string;
  memoryLineCount: number;
  memoryCharCount: number;
  softLimitChars: number;
  planTitle: string;
  planPath: string;
  completedTasks: Array<{
    number: number;
    title: string;
    checklist: string[];
    summary: string;
  }>;
  encounteredIssues: string[];
}): string {
  const tasks =
    input.completedTasks.length === 0
      ? "- (no completed tasks)"
      : input.completedTasks.map((task) => {
          const checklist =
            task.checklist.length === 0 ? "    - (no checklist items)" : task.checklist.map((item) => `    - ${item}`).join("\n");
          return [
            `- Task ${task.number}: ${task.title}`,
            "  Checklist:",
            checklist,
            `  Outcome summary: ${task.summary || "(empty)"}`
          ].join("\n");
        }).join("\n");

  const issues =
    input.encounteredIssues.length === 0
      ? "- none"
      : input.encounteredIssues.map((issue) => `- ${issue}`).join("\n");

  return [
    "You are maintaining a compact persistent MEMORY.md for future runs.",
    "Rewrite the full MEMORY.md (not a diff).",
    "Keep only durable, reusable information that helps future executions.",
    "",
    "Output markdown only, no code fences.",
    "",
    "Rules:",
    "- Keep title `# Thred Memory` and section `## Notes`.",
    "- Memory must be a concise summary, not a raw execution log dump.",
    "- Remove stale, redundant, or low-signal details.",
    `- Soft limit: target <= ${input.softLimitChars} characters by summarizing and dropping noise.`,
    "- Prefer constraints, gotchas, conventions, stable decisions, and recurring failure patterns.",
    "- Avoid temporary implementation trivia.",
    "- Preserve concise bullets and short sections.",
    "- Always summarize: completed tasks, notable implementation decisions, and issues encountered + resolutions.",
    "",
    `Plan title: ${input.planTitle}`,
    `Plan path: ${input.planPath}`,
    `Current MEMORY.md lines: ${input.memoryLineCount}`,
    `Current MEMORY.md chars: ${input.memoryCharCount}`,
    "",
    "Completed tasks this run:",
    tasks,
    "",
    "Encountered issues and edge-cases this run:",
    issues,
    "",
    "Current MEMORY.md:",
    input.memoryContent
  ].join("\n");
}

export function buildMemoryCompressionPrompt(input: {
  memoryContent: string;
  currentCharCount: number;
  softLimitChars: number;
}): string {
  return [
    "The MEMORY.md rewrite is too long.",
    "Rewrite MEMORY.md again, shorter and denser.",
    "Output markdown only, no code fences.",
    "",
    "Rules:",
    "- Keep title `# Thred Memory` and section `## Notes`.",
    "- Preserve only durable high-signal information.",
    "- Remove verbose narrative and duplicate bullets.",
    `- HARD target: <= ${input.softLimitChars} characters.`,
    "",
    `Current chars: ${input.currentCharCount}`,
    "",
    "Current MEMORY.md:",
    input.memoryContent
  ].join("\n");
}

function normalizeMemory(raw: string): string {
  const normalized = raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trimEnd();
  if (normalized === "") {
    return DEFAULT_MEMORY_CONTENT;
  }
  if (/^\s*#\s+Thred Memory/m.test(normalized)) {
    return normalized;
  }
  return `${DEFAULT_MEMORY_CONTENT}\n\n${normalized}`;
}

function ensureTrailingNewline(input: string): string {
  return input.endsWith("\n") ? input : `${input}\n`;
}

function countLines(content: string): number {
  const normalized = content.replace(/\r\n/g, "\n").trimEnd();
  if (normalized === "") {
    return 0;
  }
  return normalized.split("\n").length;
}

function countChars(content: string): number {
  return content.trimEnd().length;
}

function extractMarkdownBody(raw: string): string {
  const fenced = raw.match(/```(?:md|markdown)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const planStart = raw.search(/^#\s+Thred Memory/m);
  if (planStart >= 0) {
    return raw.slice(planStart).trim();
  }

  return raw.trim();
}
