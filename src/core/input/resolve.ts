import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface ResolvedInput {
  mode: "file" | "text";
  sourceText: string;
  sourceLabel: string;
  sourcePath?: string;
}

export async function resolveInput(rawInput: string, cwd: string): Promise<ResolvedInput> {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new Error("input is required");
  }

  const absPath = path.resolve(cwd, trimmed);

  try {
    const fileStat = await stat(absPath);
    if (!fileStat.isFile()) {
      throw new Error(`input path exists but is not a file: ${trimmed}`);
    }

    const sourceText = (await readFile(absPath, "utf8")).trim();
    if (!sourceText) {
      throw new Error(`input file is empty: ${trimmed}`);
    }

    return {
      mode: "file",
      sourceText,
      sourceLabel: path.basename(absPath),
      sourcePath: absPath
    };
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
    if (isPathLikeInput(trimmed)) {
      throw new Error(`input file not found: ${trimmed}`);
    }
  }

  return {
    mode: "text",
    sourceText: trimmed,
    sourceLabel: "inline-input"
  };
}

function isPathLikeInput(input: string): boolean {
  const normalized = input.trim();

  if (!normalized) {
    return false;
  }

  if (/^[A-Za-z]:[\\/]/.test(normalized)) {
    return true;
  }

  if (
    normalized.startsWith("/") ||
    normalized.startsWith("~/") ||
    normalized.startsWith("~\\") ||
    normalized.startsWith("./") ||
    normalized.startsWith("../") ||
    normalized.startsWith(".\\") ||
    normalized.startsWith("..\\")
  ) {
    return true;
  }

  if (/\s/.test(normalized)) {
    return false;
  }

  const basename = path.basename(normalized);
  return /\.[A-Za-z0-9_-]+$/.test(basename);
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  return "code" in error && error.code === "ENOENT";
}
