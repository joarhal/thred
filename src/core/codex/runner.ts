import { runCommand } from "../util/process.js";

import type { CodexConfig } from "../../types.js";

export interface CodexSessionResult {
  output: string;
  error?: Error;
  isRateLimited: boolean;
}

interface CodexLogger {
  rawToolOutput(msg: string): Promise<void>;
  startCodexRequest?(): Promise<void> | void;
  finishCodexRequest?(): Promise<void> | void;
}

const DEFAULT_CODEX_REQUEST_TIMEOUT_MS = 45 * 60 * 1000;

export class CodexRunner {
  private readonly config: CodexConfig;
  private readonly logger: CodexLogger;

  constructor(config: CodexConfig, logger: CodexLogger) {
    this.config = config;
    this.logger = logger;
  }

  async run(prompt: string): Promise<CodexSessionResult> {
    const args = ["exec"];

    if (this.config.skipGitRepoCheck) {
      args.push("--skip-git-repo-check");
    }

    args.push(
      "--sandbox",
      this.config.sandbox,
      "-c",
      `model_reasoning_effort=${this.config.reasoningEffort}`
    );

    if (this.config.model) {
      args.push("-m", this.config.model);
    }

    args.push(prompt);

    const timeoutMs = resolveCodexRequestTimeoutMs();
    await this.logger.startCodexRequest?.();
    const result = await runCommand(this.config.command, args, {
      onStdoutLine: async (line) => this.logger.rawToolOutput(line),
      onStderrLine: async (line) => this.logger.rawToolOutput(line),
      timeoutMs
    }).finally(async () => {
      await this.logger.finishCodexRequest?.();
    });

    const output = `${result.stdout}\n${result.stderr}`.trim();
    const isRateLimited = /rate\s*limit|quota\s*exceeded/i.test(output);

    if (result.code !== 0) {
      const errorMessage =
        result.code === 124
          ? `codex request timed out after ${timeoutMs}ms`
          : buildCodexExitErrorMessage(result.code, output);
      return {
        output,
        isRateLimited,
        error: new Error(errorMessage)
      };
    }

    return {
      output,
      isRateLimited: false
    };
  }
}

function resolveCodexRequestTimeoutMs(): number {
  const raw = process.env.THRED_CODEX_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_CODEX_REQUEST_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_CODEX_REQUEST_TIMEOUT_MS;
  }
  return Math.floor(parsed);
}

export function buildCodexExitErrorMessage(code: number, output: string): string {
  const normalized = output.replace(/\r/g, "").trim();
  if (!normalized) {
    return [
      `codex exited with code ${code}.`,
      "Likely setup issue in an empty workspace.",
      "Ensure project is ready:",
      "  git init",
      "  git add .",
      '  git commit --allow-empty -m "chore: init project"',
      "Then retry (or run with --verbose to inspect codex output)."
    ].join("\n");
  }

  if (/not a git repository/i.test(normalized)) {
    return [
      `codex exited with code ${code}: workspace is not a git repository.`,
      "Run:",
      "  git init",
      "  git add .",
      '  git commit --allow-empty -m "chore: init project"',
      "and retry."
    ].join("\n");
  }

  if (/401|403|unauthorized|forbidden|authentication|api key/i.test(normalized)) {
    return `codex exited with code ${code}: authentication failed (check Codex/OpenAI credentials).`;
  }

  const hint = extractCodexFailureHint(normalized);
  if (!hint) {
    return `codex exited with code ${code}`;
  }
  return `codex exited with code ${code}: ${hint}`;
}

function extractCodexFailureHint(output: string): string | undefined {
  const lines = output
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !isCodexBannerLine(line));

  const first = lines[0];
  if (!first) {
    return undefined;
  }

  return first.length > 180 ? `${first.slice(0, 177)}...` : first;
}

function isCodexBannerLine(line: string): boolean {
  const normalized = line.toLowerCase();
  return (
    normalized.startsWith("openai codex ") ||
    normalized.startsWith("mcp: ") ||
    normalized.startsWith("workdir: ") ||
    normalized === "--------"
  );
}
