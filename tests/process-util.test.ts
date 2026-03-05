import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { commandExists, runCommand } from "../src/core/util/process.js";

describe("process utils", () => {
  it("returns timeout exit code when command exceeds timeoutMs", async () => {
    const result = await runCommand(process.execPath, ["-e", "setTimeout(() => {}, 2000)"], {
      timeoutMs: 100
    });

    expect(result.code).toBe(124);
    expect(result.stderr).toContain("command timed out after 100ms");
  });

  it("rejects when a stream callback throws", async () => {
    await expect(
      runCommand(process.execPath, ["-e", "console.log('hello')"], {
        onStdoutLine: () => {
          throw new Error("callback failed");
        }
      })
    ).rejects.toThrow("callback failed");
  });

  it("assembles lines across multiple chunks", async () => {
    const lines: string[] = [];

    const result = await runCommand(
      process.execPath,
      [
        "-e",
        "process.stdout.write('HEL'); setTimeout(() => { process.stdout.write('LO\\n'); }, 20);"
      ],
      {
        onStdoutLine: (line) => {
          lines.push(line);
        }
      }
    );

    expect(result.code).toBe(0);
    expect(lines).toEqual(["HELLO"]);
  });

  it("does not report timeout after process already exited", async () => {
    const result = await runCommand(process.execPath, ["-e", "console.log('done')"], {
      timeoutMs: 1_000,
      onStdoutLine: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_100));
      }
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("done");
    expect(result.stderr).not.toContain("command timed out");
  });

  it("returns command-not-found exit code when binary cannot be started", async () => {
    const result = await runCommand("thred-command-that-does-not-exist", ["--version"]);

    expect(result.code).toBe(127);
    expect(result.stderr).toContain("command not found");
  });

  it("returns command-not-executable exit code for non-executable files", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "thred-process-util-"));
    const scriptPath = path.join(tempDir, "no-exec.sh");
    await writeFile(scriptPath, "#!/bin/sh\necho hello\n", { mode: 0o644 });

    const result = await runCommand(scriptPath, []);
    expect(result.code).toBe(126);
    expect(result.stderr).toContain("not executable");
  });

  it("checks command availability via PATH", async () => {
    await expect(commandExists("git")).resolves.toBe(true);
    await expect(commandExists("thred-command-that-does-not-exist")).resolves.toBe(false);
  });
});
