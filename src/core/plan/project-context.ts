import { readdir } from "node:fs/promises";
import path from "node:path";

const MAX_SCAN_FILES = 800;
const MAX_SCAN_DEPTH = 5;
const MAX_SAMPLE_FILES = 120;
const MAX_TOP_ENTRIES = 24;
const MAX_GROUPED_AREAS = 8;
const MAX_GROUP_FILES = 8;
const ENTRYPOINT_CANDIDATES = [
  "src/main.tsx",
  "src/main.ts",
  "src/main.jsx",
  "src/main.js",
  "src/index.tsx",
  "src/index.ts",
  "src/index.jsx",
  "src/index.js",
  "main.tsx",
  "main.ts",
  "main.jsx",
  "main.js",
  "index.tsx",
  "index.ts",
  "index.jsx",
  "index.js",
  "app/layout.tsx",
  "app/page.tsx",
  "app/main.tsx"
];
const KEY_FILES = [
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
  "vite.config.js",
  "next.config.js",
  "next.config.mjs",
  "astro.config.mjs",
  "README.md",
  "AGENTS.md"
];
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".thred",
  "test-results",
  ".next",
  ".turbo",
  ".cache",
  "vendor"
]);

export interface ProjectContextSnapshot {
  summary: string;
}

export async function buildProjectContextSnapshot(cwd: string): Promise<ProjectContextSnapshot> {
  const topEntries = await readTopEntries(cwd);
  const allFiles = await walkFiles(cwd);
  const sampledFiles = allFiles.slice(0, MAX_SAMPLE_FILES);
  const keyFiles = KEY_FILES.filter((item) => allFiles.includes(item));
  const entrypoints = detectEntrypoints(allFiles);
  const grouped = groupByArea(sampledFiles);

  const lines = [
    `Repository context snapshot (${new Date().toISOString()})`,
    `Scanned files: ${allFiles.length} (sampled ${sampledFiles.length})`,
    "",
    `Top-level entries: ${topEntries.join(", ") || "(none)"}`,
    `Key config/docs files: ${keyFiles.join(", ") || "(none found)"}`,
    `Likely entrypoints: ${entrypoints.join(", ") || "(not detected)"}`,
    "",
    "Sample files by area:"
  ];

  for (const [area, files] of grouped) {
    lines.push(`- ${area}: ${files.join(", ")}`);
  }

  if (grouped.length === 0 && sampledFiles.length > 0) {
    lines.push(`- root: ${sampledFiles.slice(0, MAX_GROUP_FILES).join(", ")}`);
  }

  return { summary: lines.join("\n") };
}

async function readTopEntries(cwd: string): Promise<string[]> {
  const entries = await readdir(cwd, { withFileTypes: true });
  return entries
    .filter((entry) => !entry.name.startsWith(".") || entry.name === ".github")
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_TOP_ENTRIES)
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
}

async function walkFiles(cwd: string): Promise<string[]> {
  const out: string[] = [];

  async function scan(dirRel: string, depth: number): Promise<void> {
    if (out.length >= MAX_SCAN_FILES || depth > MAX_SCAN_DEPTH) {
      return;
    }

    const abs = path.join(cwd, dirRel);
    const entries = await readdir(abs, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (out.length >= MAX_SCAN_FILES) {
        return;
      }
      const rel = dirRel ? path.join(dirRel, entry.name) : entry.name;
      const normalized = rel.replace(/\\/g, "/");
      if (shouldSkip(normalized, entry.isDirectory())) {
        continue;
      }

      if (entry.isDirectory()) {
        await scan(rel, depth + 1);
        continue;
      }

      out.push(normalized);
    }
  }

  await scan("", 0);
  return out;
}

function shouldSkip(rel: string, isDir: boolean): boolean {
  const name = path.basename(rel);
  if (name.startsWith(".") && name !== ".github") {
    return true;
  }
  if (!isDir) {
    return false;
  }
  return IGNORED_DIRS.has(name);
}

function detectEntrypoints(files: string[]): string[] {
  const known = new Set(files);
  const out: string[] = [];

  for (const candidate of ENTRYPOINT_CANDIDATES) {
    if (known.has(candidate)) {
      out.push(candidate);
    }
  }

  for (const file of files) {
    if (out.length >= 8) {
      break;
    }
    if (/(^|\/)(main|index|app)\.(tsx?|jsx?|mjs|cjs)$/.test(file) && !out.includes(file)) {
      out.push(file);
    }
  }

  return out.slice(0, 8);
}

function groupByArea(files: string[]): Array<[string, string[]]> {
  const grouped = new Map<string, string[]>();

  for (const file of files) {
    const parts = file.split("/");
    const area = parts.length > 1 ? (parts[0] ?? "root") : "root";
    const bucket = grouped.get(area) ?? [];
    if (bucket.length < MAX_GROUP_FILES) {
      bucket.push(file);
    }
    grouped.set(area, bucket);
  }

  return Array.from(grouped.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, MAX_GROUPED_AREAS);
}
