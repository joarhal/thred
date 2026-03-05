import { spawn } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onStdoutLine?: (line: string) => Promise<void> | void;
  onStderrLine?: (line: string) => Promise<void> | void;
  timeoutMs?: number;
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    let settled = false;
    const resolveOnce = (result: CommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let forceKillHandle: NodeJS.Timeout | undefined;
    let stdoutRemainder = "";
    let stderrRemainder = "";
    let callbackError: Error | null = null;
    let callbackQueue = Promise.resolve();
    let processClosed = false;

    if (typeof options.timeoutMs === "number" && options.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (settled || processClosed) {
          return;
        }
        timedOut = true;
        stderr += `\ncommand timed out after ${options.timeoutMs}ms: ${command} ${args.join(" ")}\n`;
        child.kill("SIGTERM");
        forceKillHandle = setTimeout(() => {
          if (settled || processClosed) {
            return;
          }
          child.kill("SIGKILL");
        }, 5_000);
        forceKillHandle.unref?.();
      }, options.timeoutMs);
      timeoutHandle.unref?.();
    }

    stdoutStream?.setEncoding("utf8");
    stderrStream?.setEncoding("utf8");

    const clearTimers = (): void => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      if (forceKillHandle) {
        clearTimeout(forceKillHandle);
        forceKillHandle = undefined;
      }
    };

    const normalizeError = (error: unknown): Error => {
      return error instanceof Error ? error : new Error(String(error));
    };

    const handleCallbackError = (error: unknown): void => {
      if (callbackError) {
        return;
      }
      callbackError = normalizeError(error);
      clearTimers();
      rejectOnce(callbackError);
      child.kill("SIGTERM");
    };

    const queueCallback = (
      line: string,
      handler: ((line: string) => Promise<void> | void) | undefined
    ): void => {
      if (!handler || line.trim() === "") {
        return;
      }

      callbackQueue = callbackQueue
        .then(async () => {
          if (callbackError) {
            return;
          }
          await handler(line);
        })
        .catch((error: unknown) => {
          handleCallbackError(error);
        });
    };

    const emitChunkLines = (
      chunk: string,
      remainder: string,
      handler: ((line: string) => Promise<void> | void) | undefined
    ): string => {
      const merged = `${remainder}${chunk}`;
      const lines = merged.split("\n");
      const nextRemainder = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        queueCallback(line, handler);
      }

      return nextRemainder;
    };

    stdoutStream?.on("data", (chunk: string) => {
      stdout += chunk;
      stdoutRemainder = emitChunkLines(chunk, stdoutRemainder, options.onStdoutLine);
    });

    stderrStream?.on("data", (chunk: string) => {
      stderr += chunk;
      stderrRemainder = emitChunkLines(chunk, stderrRemainder, options.onStderrLine);
    });

    const flushRemainders = (): void => {
      const stdoutLine = stdoutRemainder.endsWith("\r")
        ? stdoutRemainder.slice(0, -1)
        : stdoutRemainder;
      const stderrLine = stderrRemainder.endsWith("\r")
        ? stderrRemainder.slice(0, -1)
        : stderrRemainder;

      stdoutRemainder = "";
      stderrRemainder = "";
      queueCallback(stdoutLine, options.onStdoutLine);
      queueCallback(stderrLine, options.onStderrLine);
    };

    child.on("error", (err) => {
      clearTimers();
      const commandString = [command, ...args].join(" ");
      const commandError = normalizeSpawnError(err, commandString);
      stderr += `${commandError.message}\n`;
      resolveOnce({ code: commandError.code, stdout, stderr });
    });

    child.on("close", (code) => {
      void (async () => {
        processClosed = true;
        clearTimers();
        flushRemainders();
        await callbackQueue;
        if (settled) {
          return;
        }

        if (callbackError) {
          rejectOnce(callbackError);
          return;
        }

        if (timedOut) {
          resolveOnce({ code: 124, stdout, stderr });
          return;
        }

        resolveOnce({ code: code ?? 1, stdout, stderr });
      })();
    });
  });
}
export async function commandExists(command: string): Promise<boolean> {
  const checker = process.platform === "win32" ? "where" : "which";
  try {
    const result = await runCommand(checker, [command]);
    return result.code === 0;
  } catch {
    return false;
  }
}

interface NormalizedSpawnError {
  code: number;
  message: string;
}

function normalizeSpawnError(error: unknown, commandString: string): NormalizedSpawnError {
  if (!error || typeof error !== "object") {
    return {
      code: 1,
      message: `failed to start command: ${commandString}`
    };
  }

  const nodeError = error as NodeJS.ErrnoException;
  if (nodeError.code === "ENOENT") {
    return {
      code: 127,
      message: `command not found: ${commandString}`
    };
  }

  if (nodeError.code === "EACCES") {
    return {
      code: 126,
      message: `command is not executable: ${commandString}`
    };
  }

  const details = nodeError.message?.trim() || String(error);
  return {
    code: 1,
    message: `failed to start command: ${commandString}${details ? ` (${details})` : ""}`
  };
}
