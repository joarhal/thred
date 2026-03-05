import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  runCommand: vi.fn()
}));

vi.mock("../src/core/util/process.js", () => ({
  runCommand: mocked.runCommand
}));

import { CodexRunner, buildCodexExitErrorMessage } from "../src/core/codex/runner.js";

describe("codex runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.runCommand.mockResolvedValue({ code: 0, stdout: "ok", stderr: "" });
  });

  it("returns successful output and streams raw tool lines", async () => {
    const logger = {
      rawToolOutput: vi.fn(async () => {}),
      startCodexRequest: vi.fn(async () => {}),
      finishCodexRequest: vi.fn(async () => {})
    };
    mocked.runCommand.mockImplementation(async (_command: string, _args: string[], options?: {
      onStdoutLine?: (line: string) => Promise<void> | void;
      onStderrLine?: (line: string) => Promise<void> | void;
      timeoutMs?: number;
    }) => {
      await options?.onStdoutLine?.("stdout line");
      await options?.onStderrLine?.("stderr line");
      return { code: 0, stdout: "run output", stderr: "stderr output" };
    });

    const runner = new CodexRunner({
      command: "codex",
      model: "o3",
      reasoningEffort: "high",
      sandbox: "workspace-write"
    }, logger);

    const result = await runner.run("do work");

    expect(result.output).toBe("run output\nstderr output");
    expect(result.error).toBeUndefined();
    expect(result.isRateLimited).toBe(false);
    expect(logger.startCodexRequest).toHaveBeenCalledTimes(1);
    expect(logger.finishCodexRequest).toHaveBeenCalledTimes(1);
    expect(logger.rawToolOutput).toHaveBeenCalledWith("stdout line");
    expect(logger.rawToolOutput).toHaveBeenCalledWith("stderr line");
    expect(mocked.runCommand).toHaveBeenCalledWith(
      "codex",
      ["exec", "--sandbox", "workspace-write", "-c", "model_reasoning_effort=high", "-m", "o3", "do work"],
      expect.objectContaining({ timeoutMs: 45 * 60 * 1000 })
    );
  });

  it("returns timeout error when codex exits with code 124", async () => {
    const logger = { rawToolOutput: vi.fn(async () => {}) };
    mocked.runCommand.mockResolvedValue({
      code: 124,
      stdout: "",
      stderr: "command timed out"
    });

    const runner = new CodexRunner({
      command: "codex",
      reasoningEffort: "medium",
      sandbox: "danger-full-access"
    }, logger);

    const result = await runner.run("do work");

    expect(result.error?.message).toContain("codex request timed out after 2700000ms");
    expect(result.isRateLimited).toBe(false);
  });

  it("adds --skip-git-repo-check when configured", async () => {
    const logger = { rawToolOutput: vi.fn(async () => {}) };

    const runner = new CodexRunner({
      command: "codex",
      reasoningEffort: "medium",
      sandbox: "workspace-write",
      skipGitRepoCheck: true
    }, logger);

    await runner.run("do work");

    expect(mocked.runCommand).toHaveBeenCalledWith(
      "codex",
      [
        "exec",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        "-c",
        "model_reasoning_effort=medium",
        "do work"
      ],
      expect.any(Object)
    );
  });

  it("sets rate-limit flag when output contains quota text", async () => {
    const logger = { rawToolOutput: vi.fn(async () => {}) };
    mocked.runCommand.mockResolvedValue({
      code: 1,
      stdout: "quota exceeded",
      stderr: ""
    });

    const runner = new CodexRunner({
      command: "codex",
      reasoningEffort: "high",
      sandbox: "danger-full-access"
    }, logger);

    const result = await runner.run("do work");

    expect(result.isRateLimited).toBe(true);
    expect(result.error?.message).toBe("codex exited with code 1: quota exceeded");
  });

  it("maps non-zero exits through codex exit message builder", async () => {
    const logger = { rawToolOutput: vi.fn(async () => {}) };
    mocked.runCommand.mockResolvedValue({
      code: 2,
      stdout: "fatal: could not read from remote repository",
      stderr: ""
    });

    const runner = new CodexRunner({
      command: "codex",
      reasoningEffort: "high",
      sandbox: "danger-full-access"
    }, logger);

    const result = await runner.run("do work");

    expect(result.error?.message).toBe("codex exited with code 2: fatal: could not read from remote repository");
  });
});

describe("codex runner error messages", () => {
  it("returns generic message when output is empty", () => {
    const message = buildCodexExitErrorMessage(1, "   ");
    expect(message).toContain("codex exited with code 1");
    expect(message).toContain("git init");
    expect(message).toContain("git commit --allow-empty");
  });

  it("returns setup guidance when git repository is missing", () => {
    const message = buildCodexExitErrorMessage(1, "fatal: not a git repository (or any of the parent directories): .git");
    expect(message).toContain("workspace is not a git repository");
    expect(message).toContain("git init");
    expect(message).toContain("git commit --allow-empty");
  });

  it("returns authentication guidance for auth failures", () => {
    expect(buildCodexExitErrorMessage(1, "HTTP 401 unauthorized")).toContain("authentication failed");
  });

  it("extracts first useful error line and skips banner lines", () => {
    const output = [
      "OpenAI Codex v0.107.0 (research preview)",
      "mcp: context7 starting",
      "--------",
      "workdir: /tmp/demo",
      "fatal: could not read from remote repository"
    ].join("\n");
    expect(buildCodexExitErrorMessage(1, output)).toBe(
      "codex exited with code 1: fatal: could not read from remote repository"
    );
  });
});
