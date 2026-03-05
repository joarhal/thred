import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  render: vi.fn(),
  unmount: vi.fn(),
  clear: vi.fn(),
  lastRenderedElement: undefined as any,
  detectTerminalCapabilities: vi.fn(),
  formatConsoleLogLine: vi.fn(),
  renderSection: vi.fn(),
  renderPlanPreview: vi.fn()
}));

vi.mock("ink", () => {
  const passthrough = () => null;
  return {
    render: mocked.render,
    Box: passthrough,
    Text: passthrough,
    Static: passthrough,
    useInput: vi.fn()
  };
});

vi.mock("../src/core/ui/terminal.js", () => ({
  detectTerminalCapabilities: mocked.detectTerminalCapabilities,
  formatConsoleLogLine: mocked.formatConsoleLogLine,
  renderSection: mocked.renderSection,
  renderPlanPreview: mocked.renderPlanPreview,
  formatShortDuration: () => "1s",
  formatShortTime: () => "00:00:00"
}));

import {
  configureInteractiveOutput,
  getInteractiveProgressSink,
  printInfo,
  printSection,
  promptText,
  shutdownInteractiveOutput
} from "../src/core/interactive/ui.js";

describe("interactive ui runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.render.mockImplementation((node: unknown) => {
      mocked.lastRenderedElement = node;
      return {
        unmount: mocked.unmount,
        clear: mocked.clear
      };
    });
    mocked.formatConsoleLogLine.mockReturnValue("[00:00:00] [INFO] hello");
    mocked.renderSection.mockImplementation((title: string) => `[${title}]`);
    mocked.renderPlanPreview.mockReturnValue("[plan preview]");
  });

  it("falls back to plain terminal output when TTY is unavailable", () => {
    mocked.detectTerminalCapabilities.mockReturnValue({
      isTTY: false,
      supportsUnicode: false,
      supportsColor: false,
      supportsTrueColor: false,
      columns: 80
    });

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      configureInteractiveOutput({ noColor: true, cwd: "/tmp/repo" });
      expect(getInteractiveProgressSink()).toBeUndefined();

      printSection("Phase · Input");
      printInfo("hello");

      expect(mocked.renderSection).toHaveBeenCalledWith("Phase · Input", expect.any(Object));
      expect(mocked.formatConsoleLogLine).toHaveBeenCalled();
      expect(writeSpy).toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
      shutdownInteractiveOutput();
    }
  });

  it("cancels pending prompts on runtime shutdown", async () => {
    mocked.detectTerminalCapabilities.mockReturnValue({
      isTTY: true,
      supportsUnicode: true,
      supportsColor: true,
      supportsTrueColor: true,
      columns: 100
    });

    configureInteractiveOutput({ noColor: true, cwd: "/tmp/repo" });
    const pendingPrompt = promptText({ title: "Goal" });

    shutdownInteractiveOutput();
    await expect(pendingPrompt).rejects.toThrow("interactive prompt cancelled");
    expect(mocked.unmount).toHaveBeenCalledTimes(1);
  });

  it("routes sink log/event/status updates into runtime state", () => {
    mocked.detectTerminalCapabilities.mockReturnValue({
      isTTY: true,
      supportsUnicode: true,
      supportsColor: true,
      supportsTrueColor: true,
      columns: 100
    });

    configureInteractiveOutput({ noColor: true, cwd: "/tmp/repo" });

    const runtime = mocked.lastRenderedElement?.props?.runtime as
      | {
          getSnapshot: () => { entries: Array<{ kind: string; title?: string; message?: string }>; spinner?: { kind: string } };
        }
      | undefined;
    expect(runtime).toBeDefined();

    const sink = getInteractiveProgressSink();
    expect(sink).toBeDefined();

    const now = new Date("2026-03-04T09:00:00.000Z");
    sink?.log({ time: now, level: "PHASE", message: "tasks" });
    sink?.log({ time: now, level: "INFO", message: "running Task 1: Demo" });
    sink?.onEvent?.({
      schemaVersion: 1,
      id: "evt-1",
      runId: "run-1",
      time: now.toISOString(),
      level: "INFO",
      phase: "tasks",
      kind: "info",
      actor: "system",
      message: "event message"
    });
    sink?.setStatus?.({
      phase: "tasks",
      task: "Task 1",
      stage: "validation",
      event: "running",
      startedAt: now.getTime()
    });

    const snapshotAfterStatus = runtime?.getSnapshot();
    expect(snapshotAfterStatus?.entries.map((entry) => entry.title ?? entry.message)).toContain("Phase · Tasks");
    expect(snapshotAfterStatus?.entries.map((entry) => entry.title ?? entry.message)).toContain("running Task 1: Demo");
    expect(snapshotAfterStatus?.entries.map((entry) => entry.title ?? entry.message)).toContain("event message");
    expect(snapshotAfterStatus?.spinner?.kind).toBe("status");

    sink?.clearStatus?.();
    const snapshotAfterClear = runtime?.getSnapshot();
    expect(snapshotAfterClear?.spinner).toBeUndefined();

    shutdownInteractiveOutput();
  });
});
