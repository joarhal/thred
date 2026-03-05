#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { registerExecuteCommand } from "./commands/execute.js";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("thred")
    .description("Codex-only autonomous execution from free-form task input")
    .version("0.1.0");

  registerExecuteCommand(program);
  return program;
}

export async function runCli(argv = process.argv): Promise<void> {
  const program = createProgram();
  await program.parseAsync(argv);
}

if (isCliEntrypoint()) {
  runCli().catch((error) => {
    const exitCode = resolveCliExitCode(error);
    const message = resolveCliErrorMessage(error);
    if (message) {
      process.stderr.write(`error: ${message}\n`);
    }
    process.exitCode = exitCode;
  });
}

export function isCliEntrypoint(
  argvEntry = process.argv[1],
  moduleUrl = import.meta.url
): boolean {
  if (!argvEntry) {
    return false;
  }

  return canonicalPath(argvEntry) === canonicalPath(fileURLToPath(moduleUrl));
}

function canonicalPath(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function resolveCliExitCode(error: unknown): number {
  if (isCommanderExit(error)) {
    return error.exitCode;
  }

  if (typeof (error as { exitCode?: unknown })?.exitCode === "number") {
    const exitCode = (error as { exitCode: number }).exitCode;
    if (Number.isInteger(exitCode) && exitCode >= 0) {
      return exitCode;
    }
  }

  return 1;
}

function resolveCliErrorMessage(error: unknown): string | undefined {
  if (isCommanderSignal(error, "commander.helpDisplayed") || isCommanderSignal(error, "commander.version")) {
    return undefined;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (error === null || error === undefined) {
    return "unknown error";
  }

  return String(error);
}

interface CommanderLikeError {
  code?: string;
  exitCode?: number;
}

function isCommanderSignal(error: unknown, code: string): boolean {
  const candidate = error as CommanderLikeError | null | undefined;
  return candidate?.code === code;
}

function isCommanderExit(error: unknown): error is Required<Pick<CommanderLikeError, "exitCode">> {
  const candidate = error as CommanderLikeError | null | undefined;
  return typeof candidate?.exitCode === "number";
}
