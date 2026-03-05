import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { RunStateStore, type RunStateStoreDiagnostic } from "../src/core/state/store.js";
import type { RunState } from "../src/types.js";

const BASE_STATE: RunState = {
  runId: "run-state",
  planPath: "/repo/docs/plans/demo.md",
  branch: "feat/demo",
  phase: "tasks",
  currentTask: 2,
  status: "running",
  startedAt: "2026-03-04T11:00:00.000Z"
};

describe("run state store failure/recovery", () => {
  it("writes normalized payload on successful write path", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "thred-run-state-"));
    const store = new RunStateStore(path.join(runDir, "run-state.json"));

    await store.write({
      ...BASE_STATE,
      phase: "review",
      currentTask: 999,
      finishedAt: "2026-03-04T11:10:00.000Z"
    });

    const raw = await readFile(store.statePath, "utf8");
    const parsed = JSON.parse(raw) as RunState;

    expect(parsed.currentTask).toBeUndefined();
    expect(parsed.finishedAt).toBeUndefined();
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("recovers from missing state directory with default io retry path", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "thred-run-state-"));
    const diagnostics: RunStateStoreDiagnostic[] = [];
    const statePath = path.join(rootDir, "missing", "run-state.json");
    const store = new RunStateStore(statePath, {
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      }
    });

    await store.write(BASE_STATE);

    const raw = await readFile(statePath, "utf8");
    expect(JSON.parse(raw).runId).toBe(BASE_STATE.runId);
    expect(diagnostics.map((item) => item.code)).toEqual(["run_state_retry", "run_state_recovered_after_retry"]);
  });

  it("retries ENOENT once with fixed delay and recovers", async () => {
    const writeFileCalls: string[] = [];
    const sleepCalls: number[] = [];
    const diagnostics: RunStateStoreDiagnostic[] = [];
    const writeFileMock = vi
      .fn<(targetPath: string, payload: string, encoding: "utf8") => Promise<void>>()
      .mockImplementationOnce(async () => {
        throw createErrno("ENOENT");
      })
      .mockImplementation(async (targetPath) => {
        writeFileCalls.push(targetPath);
      });

    const store = new RunStateStore("/virtual/.thred/artifacts/runs/run-1.json", {
      io: {
        ensureDir: vi.fn(async () => undefined),
        readdir: vi.fn(async () => []),
        rename: vi.fn(async () => undefined),
        rm: vi.fn(async () => undefined),
        sleep: vi.fn(async (delayMs: number) => {
          sleepCalls.push(delayMs);
        }),
        stat: vi.fn(async () => ({ isFile: () => true, mtimeMs: Date.now() })),
        writeFile: writeFileMock
      },
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      }
    });

    await store.write(BASE_STATE);

    expect(writeFileMock).toHaveBeenCalledTimes(2);
    expect(writeFileCalls).toHaveLength(1);
    expect(sleepCalls).toEqual([40]);
    expect(diagnostics.map((item) => item.code)).toEqual(["run_state_retry", "run_state_recovered_after_retry"]);
    expect(diagnostics[0]).toEqual(
      expect.objectContaining({
        message: "run state persistence failed, retrying",
        verboseDetail: expect.stringContaining("nextRetryInMs=40")
      })
    );
    expect(diagnostics[1]).toEqual(
      expect.objectContaining({
        message: "run state persistence recovered after retry",
        verboseDetail: expect.stringContaining("attempts=2/4")
      })
    );
  });

  it("retries EACCES with fixed delay and then succeeds", async () => {
    const sleepCalls: number[] = [];
    const diagnostics: RunStateStoreDiagnostic[] = [];
    const writeFileMock = vi
      .fn<(targetPath: string, payload: string, encoding: "utf8") => Promise<void>>()
      .mockImplementationOnce(async () => {
        throw createErrno("EACCES");
      })
      .mockImplementation(async () => undefined);

    const store = new RunStateStore("/virtual/.thred/artifacts/runs/run-2.json", {
      io: {
        ensureDir: vi.fn(async () => undefined),
        readdir: vi.fn(async () => []),
        rename: vi.fn(async () => undefined),
        rm: vi.fn(async () => undefined),
        sleep: vi.fn(async (delayMs: number) => {
          sleepCalls.push(delayMs);
        }),
        stat: vi.fn(async () => ({ isFile: () => true, mtimeMs: Date.now() })),
        writeFile: writeFileMock
      },
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      }
    });

    await store.write(BASE_STATE);

    expect(writeFileMock).toHaveBeenCalledTimes(2);
    expect(sleepCalls).toEqual([40]);
    expect(diagnostics.map((item) => item.code)).toEqual(["run_state_retry", "run_state_recovered_after_retry"]);
  });

  it("retries EPERM with fixed delay and then succeeds", async () => {
    const sleepCalls: number[] = [];
    const diagnostics: RunStateStoreDiagnostic[] = [];
    const writeFileMock = vi
      .fn<(targetPath: string, payload: string, encoding: "utf8") => Promise<void>>()
      .mockImplementationOnce(async () => {
        throw createErrno("EPERM");
      })
      .mockImplementation(async () => undefined);

    const store = new RunStateStore("/virtual/.thred/artifacts/runs/run-3.json", {
      io: {
        ensureDir: vi.fn(async () => undefined),
        readdir: vi.fn(async () => []),
        rename: vi.fn(async () => undefined),
        rm: vi.fn(async () => undefined),
        sleep: vi.fn(async (delayMs: number) => {
          sleepCalls.push(delayMs);
        }),
        stat: vi.fn(async () => ({ isFile: () => true, mtimeMs: Date.now() })),
        writeFile: writeFileMock
      },
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      }
    });

    await store.write(BASE_STATE);

    expect(writeFileMock).toHaveBeenCalledTimes(2);
    expect(sleepCalls).toEqual([40]);
    expect(diagnostics.map((item) => item.code)).toEqual(["run_state_retry", "run_state_recovered_after_retry"]);
  });

  it("uses deterministic max-attempt limit for persistent retriable failures", async () => {
    const sleepCalls: number[] = [];
    const diagnostics: RunStateStoreDiagnostic[] = [];
    const writeFileMock = vi.fn<(targetPath: string, payload: string, encoding: "utf8") => Promise<void>>(
      async () => {
        throw createErrno("EPERM");
      }
    );

    const store = new RunStateStore("/virtual/.thred/artifacts/runs/run-4.json", {
      io: {
        ensureDir: vi.fn(async () => undefined),
        readdir: vi.fn(async () => []),
        rename: vi.fn(async () => undefined),
        rm: vi.fn(async () => undefined),
        sleep: vi.fn(async (delayMs: number) => {
          sleepCalls.push(delayMs);
        }),
        stat: vi.fn(async () => ({ isFile: () => true, mtimeMs: Date.now() })),
        writeFile: writeFileMock
      },
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      }
    });

    await expect(store.write(BASE_STATE)).rejects.toMatchObject({
      name: "RunStateStoreWriteError",
      code: "EPERM",
      message: expect.stringContaining("run state persistence failed (retries exhausted)")
    });
    expect(writeFileMock).toHaveBeenCalledTimes(4);
    expect(sleepCalls).toEqual([40, 120, 250]);
    expect(diagnostics.map((item) => item.code)).toEqual([
      "run_state_retry",
      "run_state_retry",
      "run_state_retry",
      "run_state_retry_exhausted"
    ]);
    expect(diagnostics.at(-1)).toEqual(
      expect.objectContaining({
        message: "run state persistence retries exhausted",
        verboseDetail: expect.stringContaining("attempt=4/4")
      })
    );
    expect(diagnostics.at(-1)?.code).toBe("run_state_retry_exhausted");
  });

  it("cleans stale .tmp artifacts in runs directory without breaking state consistency", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "thred-run-state-"));
    const staleTmp = path.join(runDir, "orphan-stale.tmp");
    const freshTmp = path.join(runDir, "orphan-fresh.tmp");
    await writeFile(staleTmp, "stale", "utf8");
    await writeFile(freshTmp, "fresh", "utf8");

    const now = Date.now();
    const staleTime = new Date(now - 10 * 60 * 1000);
    const freshTime = new Date(now - 30 * 1000);
    await utimes(staleTmp, staleTime, staleTime);
    await utimes(freshTmp, freshTime, freshTime);

    const diagnostics: RunStateStoreDiagnostic[] = [];
    const store = new RunStateStore(path.join(runDir, "run-5.json"), {
      now: () => now,
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      }
    });
    await store.write(BASE_STATE);

    await expect(readFile(staleTmp, "utf8")).rejects.toBeDefined();
    await expect(readFile(freshTmp, "utf8")).resolves.toBe("fresh");
    const state = JSON.parse(await readFile(store.statePath, "utf8")) as RunState;
    expect(state.runId).toBe(BASE_STATE.runId);
    expect(diagnostics.some((item) => item.code === "run_state_stale_tmp_removed")).toBe(true);
    expect(diagnostics.find((item) => item.code === "run_state_stale_tmp_removed")).toEqual(
      expect.objectContaining({
        message: "run state cleanup removed stale temporary artifact",
        verboseDetail: expect.stringContaining(`path=${staleTmp}`)
      })
    );
  });

  it("rethrows non-retriable write errors without retrying", async () => {
    const sleepMock = vi.fn(async () => undefined);
    const diagnostics: RunStateStoreDiagnostic[] = [];
    const writeFileMock = vi.fn<(targetPath: string, payload: string, encoding: "utf8") => Promise<void>>(
      async () => {
        throw createErrno("EROFS");
      }
    );

    const store = new RunStateStore("/virtual/.thred/artifacts/runs/run-6.json", {
      io: {
        ensureDir: vi.fn(async () => undefined),
        readdir: vi.fn(async () => []),
        rename: vi.fn(async () => undefined),
        rm: vi.fn(async () => undefined),
        sleep: sleepMock,
        stat: vi.fn(async () => ({ isFile: () => true, mtimeMs: Date.now() })),
        writeFile: writeFileMock
      },
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      }
    });

    await expect(store.write(BASE_STATE)).rejects.toMatchObject({
      name: "RunStateStoreWriteError",
      code: "EROFS",
      message: expect.stringContaining("run state persistence failed (non-retriable failure)")
    });
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).not.toHaveBeenCalled();
    expect(diagnostics.at(-1)).toEqual(
      expect.objectContaining({
        message: "run state persistence failed with non-retriable error",
        verboseDetail: expect.stringContaining("operation=write temporary run state file")
      })
    );
    expect(diagnostics.at(-1)?.code).toBe("run_state_non_retriable_failure");
  });

  it("does not fail state write when diagnostics handler throws", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "thred-run-state-"));
    const writeFileMock = vi
      .fn<(targetPath: string, payload: string, encoding: "utf8") => Promise<void>>()
      .mockImplementationOnce(async () => {
        throw createErrno("ENOENT");
      })
      .mockImplementation(async (targetPath, payload, encoding) => {
        await writeFile(targetPath, payload, encoding);
      });

    const store = new RunStateStore(path.join(runDir, "run-state.json"), {
      io: {
        ensureDir: vi.fn(async () => undefined),
        readdir: vi.fn(async () => []),
        rename: vi.fn(async (oldPath, newPath) => {
          const payload = await readFile(oldPath, "utf8");
          await writeFile(newPath, payload, "utf8");
        }),
        rm: vi.fn(async () => undefined),
        sleep: vi.fn(async () => undefined),
        stat: vi.fn(async () => ({ isFile: () => true, mtimeMs: Date.now() })),
        writeFile: writeFileMock
      },
      onDiagnostic: () => {
        throw new Error("diagnostics sink down");
      }
    });

    await expect(store.write(BASE_STATE)).resolves.toBeUndefined();
    const raw = await readFile(store.statePath, "utf8");
    const parsed = JSON.parse(raw) as RunState;
    expect(parsed.runId).toBe(BASE_STATE.runId);
    expect(writeFileMock).toHaveBeenCalledTimes(2);
  });

  it("allows attaching diagnostics handler after store construction", async () => {
    const diagnostics: RunStateStoreDiagnostic[] = [];
    const writeFileMock = vi
      .fn<(targetPath: string, payload: string, encoding: "utf8") => Promise<void>>()
      .mockImplementationOnce(async () => {
        throw createErrno("ENOENT");
      })
      .mockImplementation(async () => undefined);

    const store = new RunStateStore("/virtual/.thred/artifacts/runs/run-7.json", {
      io: {
        ensureDir: vi.fn(async () => undefined),
        readdir: vi.fn(async () => []),
        rename: vi.fn(async () => undefined),
        rm: vi.fn(async () => undefined),
        sleep: vi.fn(async () => undefined),
        stat: vi.fn(async () => ({ isFile: () => true, mtimeMs: Date.now() })),
        writeFile: writeFileMock
      }
    });
    store.setDiagnosticHandler((diagnostic) => {
      diagnostics.push(diagnostic);
    });

    await store.write(BASE_STATE);

    expect(diagnostics.map((item) => item.code)).toEqual(["run_state_retry", "run_state_recovered_after_retry"]);
  });
});

function createErrno(code: string): NodeJS.ErrnoException {
  const error = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}
