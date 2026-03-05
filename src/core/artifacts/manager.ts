import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { ensureDir, exists } from "../util/fs.js";

const THRED_DIR = ".thred";
const ARTIFACTS_DIR = path.join(THRED_DIR, "artifacts");
const LEGACY_THRED_IGNORE_LINE = ".thred/";
const THRED_RUNTIME_IGNORE_LINES = [".thred/artifacts/", ".thred/runs/"] as const;
const KNOWN_PROJECT_ARTIFACT_DIRS = ["test-results", "playwright-report"];

export interface RelocatedArtifact {
  sourceRelativePath: string;
  targetRelativePath: string;
}

export interface ThredWorkspaceOptions {
  updateGitignore?: boolean;
}

export async function ensureThredWorkspace(cwd: string, options: ThredWorkspaceOptions = {}): Promise<void> {
  await ensureDir(path.join(cwd, ARTIFACTS_DIR));
  if (options.updateGitignore ?? true) {
    await ensureGitignoreHasThred(cwd);
  }
}

export async function resetArtifacts(cwd: string): Promise<void> {
  const artifactsAbs = path.join(cwd, ARTIFACTS_DIR);
  await removeDirectoryContents(artifactsAbs);
  await ensureDir(artifactsAbs);
}

export async function relocateKnownProjectArtifacts(cwd: string): Promise<RelocatedArtifact[]> {
  const artifactsAbs = path.join(cwd, ARTIFACTS_DIR);
  await ensureDir(artifactsAbs);

  const moved: RelocatedArtifact[] = [];

  for (const relDir of KNOWN_PROJECT_ARTIFACT_DIRS) {
    const sourceAbs = path.join(cwd, relDir);
    if (!(await exists(sourceAbs))) {
      continue;
    }

    const targetRel = await resolveRelocationTarget(cwd, relDir);
    const targetAbs = path.join(cwd, targetRel);
    await ensureDir(path.dirname(targetAbs));

    await rename(sourceAbs, targetAbs);
    moved.push({
      sourceRelativePath: relDir,
      targetRelativePath: targetRel.replace(/\\/g, "/")
    });
  }

  return moved;
}

export function getArtifactsRunsDir(cwd: string): string {
  return path.join(cwd, ARTIFACTS_DIR, "runs");
}

async function ensureGitignoreHasThred(cwd: string): Promise<void> {
  const gitignorePath = path.join(cwd, ".gitignore");
  let content = "";
  if (await exists(gitignorePath)) {
    content = await readFile(gitignorePath, "utf8");
  }

  const originalLines = content === "" ? [] : content.split(/\r?\n/);
  const filteredLines = originalLines.filter((line) => line.trim() !== LEGACY_THRED_IGNORE_LINE);
  const existing = new Set(filteredLines.map((line) => line.trim()));
  for (const line of THRED_RUNTIME_IGNORE_LINES) {
    if (!existing.has(line)) {
      filteredLines.push(line);
    }
  }

  const nextContent = `${filteredLines.join("\n").replace(/\n+$/u, "")}\n`;
  if (nextContent === content) {
    return;
  }

  await writeFile(gitignorePath, nextContent, "utf8");
}

async function removeDirectoryContents(dirPath: string): Promise<void> {
  if (!(await exists(dirPath))) {
    return;
  }

  const entries = await readdir(dirPath);
  for (const entry of entries) {
    const target = path.join(dirPath, entry);
    await rm(target, { recursive: true, force: true });
  }
}

async function resolveRelocationTarget(cwd: string, relDir: string): Promise<string> {
  const directTargetRel = path.join(ARTIFACTS_DIR, relDir);
  if (!(await exists(path.join(cwd, directTargetRel)))) {
    return directTargetRel;
  }

  for (let index = 1; index <= 9_999; index += 1) {
    const suffixedRel = path.join(ARTIFACTS_DIR, `${relDir}-${String(index).padStart(3, "0")}`);
    if (!(await exists(path.join(cwd, suffixedRel)))) {
      return suffixedRel;
    }
  }

  throw new Error(`unable to relocate artifact directory: exhausted target names for ${relDir}`);
}
