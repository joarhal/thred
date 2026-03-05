import { readFile } from "node:fs/promises";
import path from "node:path";

import { exists } from "../util/fs.js";

interface PackageJsonLike {
  scripts?: Record<string, unknown>;
}

export interface ValidationDetectionOptions {
  isGit?: boolean;
}

export interface ValidationDetectionDiagnostic {
  code:
    | "package_json_read_error"
    | "package_json_parse_error"
    | "package_json_invalid_shape"
    | "package_json_invalid_scripts";
  message: string;
  hint: string;
  verboseDetail: string;
}

export interface ValidationDetectionResult {
  commands: string[];
  diagnostics: ValidationDetectionDiagnostic[];
}

interface PackageJsonReadResult {
  parsed: PackageJsonLike | null;
  diagnostic: ValidationDetectionDiagnostic | null;
}

interface PackageScriptsResult {
  scripts: Record<string, unknown>;
  diagnostic: ValidationDetectionDiagnostic | null;
}

export async function detectValidationCommands(
  cwd: string,
  options: ValidationDetectionOptions = {}
): Promise<ValidationDetectionResult> {
  const packageJsonPath = path.join(cwd, "package.json");
  const selected: string[] = [];
  const diagnostics: ValidationDetectionDiagnostic[] = [];

  if (await exists(packageJsonPath)) {
    const packageJson = await readPackageJson(packageJsonPath);
    if (packageJson.diagnostic) {
      diagnostics.push(packageJson.diagnostic);
    }

    if (packageJson.parsed) {
      const scriptsResult = selectScripts(packageJson.parsed);
      if (scriptsResult.diagnostic) {
        diagnostics.push(scriptsResult.diagnostic);
      }

      const scripts = scriptsResult.scripts;
      if (typeof scripts.test === "string") {
        selected.push("npm test");
      }
      if (typeof scripts["test:coverage"] === "string") {
        selected.push("npm run test:coverage");
      }
      if (typeof scripts.build === "string") {
        selected.push("npm run build");
      }
      if (selected.length === 0 && typeof scripts.lint === "string") {
        selected.push("npm run lint");
      }
    }
  }

  if (selected.length === 0) {
    if (options.isGit ?? true) {
      selected.push("git status --short");
    } else {
      selected.push("true");
    }
  }

  return {
    commands: selected,
    diagnostics
  };
}

function selectScripts(packageJson: PackageJsonLike): PackageScriptsResult {
  if (!("scripts" in packageJson) || packageJson.scripts === undefined) {
    return {
      scripts: {},
      diagnostic: null
    };
  }
  if (!packageJson.scripts || typeof packageJson.scripts !== "object" || Array.isArray(packageJson.scripts)) {
    return {
      scripts: {},
      diagnostic: {
        code: "package_json_invalid_scripts",
        message: "validation detection: package.json scripts are invalid, using fallback commands",
        hint: "Set package.json scripts to an object map to restore npm command detection",
        verboseDetail: `packageJson.scripts type=${typeof packageJson.scripts}`
      }
    };
  }
  return {
    scripts: packageJson.scripts,
    diagnostic: null
  };
}

async function readPackageJson(packageJsonPath: string): Promise<PackageJsonReadResult> {
  let raw: string;
  try {
    raw = await readFile(packageJsonPath, "utf8");
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "UNKNOWN")
      : "UNKNOWN";
    return {
      parsed: null,
      diagnostic: {
        code: "package_json_read_error",
        message: "validation detection: cannot read package.json, using fallback commands",
        hint: "Ensure package.json exists and is readable",
        verboseDetail: `path=${packageJsonPath}; errorCode=${code}`
      }
    };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        parsed: null,
        diagnostic: {
          code: "package_json_invalid_shape",
          message: "validation detection: package.json root is invalid, using fallback commands",
          hint: "Ensure package.json root is a JSON object",
          verboseDetail: `path=${packageJsonPath}; rootType=${Array.isArray(parsed) ? "array" : typeof parsed}`
        }
      };
    }
    return {
      parsed: parsed as PackageJsonLike,
      diagnostic: null
    };
  } catch {
    return {
      parsed: null,
      diagnostic: {
        code: "package_json_parse_error",
        message: "validation detection: package.json JSON is invalid, using fallback commands",
        hint: "Fix package.json JSON syntax",
        verboseDetail: `path=${packageJsonPath}`
      }
    };
  }
}
