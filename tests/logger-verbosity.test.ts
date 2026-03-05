import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ProgressLogger } from "../src/core/progress/logger.js";

describe("progress logger verbosity", () => {
  it("hides non-action tool output from console when verbose is off", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-logger-"));
    const logger = await ProgressLogger.create(dir, "run-a", true, false);
    const output = await captureStdout(async () => {
      await logger.info("hello");
      await logger.rawToolOutput("tool details");
    });

    const logFile = await readFile(path.join(dir, "run-a.log"), "utf8");
    const eventsFile = await readFile(path.join(dir, "run-a.events.jsonl"), "utf8");
    const events = parseJsonLines(eventsFile);
    expect(output).toContain("> hello");
    expect(output).not.toContain("> tool details");
    expect(logFile).toContain("[TOOL] tool details");
    expect(events.some((event) => event.level === "INFO" && event.message === "hello")).toBe(true);
    expect(events.some((event) => event.level === "TOOL" && event.message === "tool details")).toBe(true);
  });

  it("prints only codex bullet headings during active codex request when verbose is off", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-logger-"));
    const logger = await ProgressLogger.create(dir, "run-a1", true, false);
    const output = await captureStdout(async () => {
      await logger.startCodexRequest();
      await logger.rawToolOutput(
        "• Ran for f in $(ls -1t ...)\n└ zsh: no matches found\n• Explored\nexec\n/bin/zsh -lc \"rg --files\" in /tmp"
      );
      await logger.finishCodexRequest();
    });

    expect(output).toContain("> Ran for f in $(ls -1t ...)");
    expect(output).toContain("> Explored");
    expect(output.match(/> Ran/g)?.length).toBe(1);
    expect(output).not.toContain("> exec");
    expect(output).not.toContain('> /bin/zsh -lc "rg --files" in /tmp');
    expect(output).not.toContain("└ zsh: no matches found");
  });

  it("in codex-request mode, prefers bullet progress and hides technical lines", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-logger-"));
    const logger = await ProgressLogger.create(dir, "run-a1b", true, false);
    const output = await captureStdout(async () => {
      await logger.startCodexRequest();
      await logger.rawToolOutput(
        "const sectionOpenCount = (html.match(/<section\\b/gi) || []).length;\n● Checking section structure and tokens\n/bin/zsh -lc 'rg --files' in /tmp succeeded in 50ms:"
      );
      await logger.finishCodexRequest();
    });

    expect(output).toContain("> Checking section structure and tokens");
    expect(output).not.toContain("sectionOpenCount");
    expect(output).not.toContain("> Ran rg --files");
  });

  it("in codex-request mode, suppresses non-bullet tool lines when bullets are absent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-logger-"));
    const logger = await ProgressLogger.create(dir, "run-a1c", true, false);
    const output = await captureStdout(async () => {
      await logger.phase("tasks");
      await logger.startCodexRequest();
      await logger.rawToolOutput("/bin/zsh -lc 'rg --files src' in /tmp succeeded in 20ms:");
      await logger.finishCodexRequest();
    });

    expect(output).not.toContain("> Ran rg --files src");
  });

  it("suppresses codex fallback lines outside tasks phase", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-logger-"));
    const logger = await ProgressLogger.create(dir, "run-a1d", true, false);
    const output = await captureStdout(async () => {
      await logger.phase("review");
      await logger.startCodexRequest();
      await logger.rawToolOutput("OpenAI Codex v0.107.0 (research preview)\n--------\nworkdir: /tmp");
      await logger.finishCodexRequest();
    });

    expect(output).not.toContain("OpenAI Codex");
    expect(output).not.toContain("workdir:");
  });

  it("suppresses narrative tool lines in compact mode outside active codex request", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-logger-"));
    const logger = await ProgressLogger.create(dir, "run-a2", true, false);
    const output = await captureStdout(async () => {
      await logger.rawToolOutput("Checking another release risk in the internal review gate and starting an extra round.");
    });

    expect(output).not.toContain("> Checking another release risk");
  });

  it("suppresses command summary lines in compact mode outside active codex request", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-logger-"));
    const logger = await ProgressLogger.create(dir, "run-a3", true, false);
    const output = await captureStdout(async () => {
      await logger.rawToolOutput(
        "/bin/zsh -lc 'sed -n 1,40p a.ts' in /tmp succeeded in 20ms:\n/bin/zsh -lc 'sed -n 41,80p a.ts' in /tmp succeeded in 20ms:\n/bin/zsh -lc 'sed -n 81,120p a.ts' in /tmp succeeded in 20ms:"
      );
    });

    const ranCount = output.match(/> Ran /g)?.length ?? 0;
    expect(ranCount).toBe(0);
  });

  it("prints tool output to console when verbose is on", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-logger-"));
    const logger = await ProgressLogger.create(dir, "run-b", true, true);
    const output = await captureStdout(async () => {
      await logger.rawToolOutput("tool details");
    });

    expect(output).toContain("[TOOL] tool details");
  });

  it("hides tool output in non-verbose mode", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-logger-"));
    const logger = await ProgressLogger.create(dir, "run-c", true, false);
    const output = await captureStdout(async () => {
      await logger.rawToolOutput("line-1\nline-2\nline-3\nline-4\nline-5\nline-6\nline-7\nline-8");
      await logger.info("after tools");
    });

    const logFile = await readFile(path.join(dir, "run-c.log"), "utf8");
    expect(output).not.toContain("> line-1");
    expect(output).not.toContain("> line-8");
    expect(output).toContain("> after tools");
    expect(logFile).toContain("[TOOL] line-1");
    expect(logFile).toContain("[TOOL] line-8");
  });

  it("suppresses known noisy codex/mcp errors from console in non-verbose mode", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-logger-"));
    const logger = await ProgressLogger.create(dir, "run-d", true, false);
    const noisy =
      '2026-03-03T18:51:06.664159Z ERROR codex_core::skills::loader: failed to stat skills entry /x (symlink): No such file or directory (os error 2)';
    const output = await captureStdout(async () => {
      await logger.rawToolOutput(noisy);
      await logger.info("after noisy");
    });

    const logFile = await readFile(path.join(dir, "run-d.log"), "utf8");
    expect(output).not.toContain("codex_core::skills::loader");
    expect(output).toContain("> after noisy");
    expect(logFile).toContain("codex_core::skills::loader");
  });

  it("suppresses known noisy codex/mcp errors from console in verbose mode", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-logger-"));
    const logger = await ProgressLogger.create(dir, "run-e", true, true);
    const noisy =
      '2026-03-03T18:52:05.411517Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed';
    const output = await captureStdout(async () => {
      await logger.rawToolOutput(`${noisy}\nnormal tool line`);
    });

    const logFile = await readFile(path.join(dir, "run-e.log"), "utf8");
    expect(output).toContain("[TOOL] normal tool line");
    expect(output).not.toContain("rmcp::transport::worker");
    expect(logFile).toContain("rmcp::transport::worker");
  });

  it("shows full tool output in verbose mode", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-logger-"));
    const logger = await ProgressLogger.create(dir, "run-f", true, true);
    const output = await captureStdout(async () => {
      await logger.rawToolOutput("• Ran for f in $(ls -1t ...)\n└ zsh: no matches found\n• Explored\n└ List *.review.json");
    });

    const logFile = await readFile(path.join(dir, "run-f.log"), "utf8");
    expect(output).toContain("[TOOL] • Ran for f in $(ls -1t ...)");
    expect(output).toContain("[TOOL] └ zsh: no matches found");
    expect(output).toContain("[TOOL] • Explored");
    expect(output).toContain("[TOOL] └ List *.review.json");
    expect(logFile).toContain("[TOOL] • Ran for f in $(ls -1t ...)");
    expect(logFile).toContain("[TOOL] └ zsh: no matches found");
  });

  it("recovers when run directory disappears during execution", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "thred-logger-"));
    const runDir = path.join(root, "runs");
    const logger = await ProgressLogger.create(runDir, "run-g", true, false);

    await rm(runDir, { recursive: true, force: true });
    await logger.info("still logging after run dir reset");
    await logger.rawToolOutput("tool line after reset");

    const logFile = await readFile(path.join(runDir, "run-g.log"), "utf8");
    const eventsFile = await readFile(path.join(runDir, "run-g.events.jsonl"), "utf8");
    expect(logFile).toContain("[INFO] still logging after run dir reset");
    expect(logFile).toContain("[TOOL] tool line after reset");
    expect(eventsFile).toContain('"message":"still logging after run dir reset"');
    expect(eventsFile).toContain('"message":"tool line after reset"');
  });

  it("maps generic info status to meaningful operation labels with booping fallback", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-logger-"));
    const statuses: Array<{ stage: string }> = [];
    const logger = await ProgressLogger.create(dir, "run-h", true, false, {
      log: () => undefined,
      setStatus: (status) => {
        statuses.push({ stage: status.stage });
      }
    });

    await logger.info("checking ambiguities and collecting clarifications");
    await logger.info("some totally opaque progress blurb");

    expect(statuses.at(-2)?.stage).toBe("clarification");
    expect(statuses.at(-1)?.stage).toBe("booping");
  });

  it("keeps run-state diagnostics concise in default output and stores verboseDetail in debug events", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-logger-"));
    const logger = await ProgressLogger.create(dir, "run-i", true, false);
    const output = await captureStdout(async () => {
      await logger.diagnostic(
        "WARN",
        "run state persistence failed, retrying",
        "operation=write temporary run state file; statePath=/tmp/run.json; code=EPERM; nextRetryInMs=40"
      );
    });

    expect(output).toContain("run state persistence failed, retrying");
    expect(output).not.toContain("statePath=/tmp/run.json");

    const eventsFile = await readFile(path.join(dir, "run-i.events.jsonl"), "utf8");
    const events = parseJsonLines(eventsFile);
    expect(events.some((event) => event.level === "WARN" && event.message === "run state persistence failed, retrying")).toBe(
      true
    );
    expect(
      events.some(
        (event) =>
          event.level === "DEBUG" &&
          event.message ===
            "warn detail: verboseDetail: operation=write temporary run state file; statePath=/tmp/run.json; code=EPERM; nextRetryInMs=40"
      )
    ).toBe(true);
  });

  it("shows run-state diagnostics with verboseDetail when verbose output is enabled", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-logger-"));
    const logger = await ProgressLogger.create(dir, "run-j", true, true);
    const output = await captureStdout(async () => {
      await logger.diagnostic(
        "INFO",
        "run state persistence recovered after retry",
        "statePath=/tmp/run.json; attempts=2/4"
      );
    });

    expect(output).toContain("run state persistence recovered after retry (verboseDetail: statePath=/tmp/run.json; attempts=2/4)");
  });

  it("keeps stale-tmp diagnostic detail hidden from default info output", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-logger-"));
    const logger = await ProgressLogger.create(dir, "run-k", true, false);
    const output = await captureStdout(async () => {
      await logger.diagnostic(
        "INFO",
        "run state cleanup removed stale temporary artifact",
        "path=/tmp/.thred/artifacts/runs/orphan.tmp; ageMs=600001"
      );
    });

    expect(output).toContain("run state cleanup removed stale temporary artifact");
    expect(output).not.toContain("orphan.tmp");
  });
});

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);

  process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
    chunks.push(String(chunk));
    const callback = args.find((arg) => typeof arg === "function");
    if (typeof callback === "function") {
      callback();
    }
    return true;
  }) as typeof process.stdout.write;

  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }

  return chunks.join("");
}

function parseJsonLines(content: string): Array<Record<string, unknown>> {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
