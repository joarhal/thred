import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearCurrentTerminalLine,
  createToolCompactFilterState,
  detectTerminalCapabilities,
  extractToolProgressBullet,
  formatConsoleLogLine,
  formatShortDuration,
  formatShortTime,
  selectCompactToolLine,
  renderPlanPreview,
  renderSection,
  isToolActionLine,
  shouldSuppressToolLine,
  toToolOutputHeading,
  stripAnsi,
  summarizeToolOutput,
  truncateToWidth,
  type TerminalCapabilities
} from "../src/core/ui/terminal.js";

function caps(input: Partial<TerminalCapabilities> = {}): TerminalCapabilities {
  return {
    isTTY: true,
    supportsUnicode: true,
    supportsColor: true,
    supportsTrueColor: true,
    columns: 100,
    ...input
  };
}

describe("terminal ui helpers", () => {
  const originalStdoutIsTTY = process.stdout.isTTY;
  const originalColumns = process.stdout.columns;

  afterEach(() => {
    process.stdout.isTTY = originalStdoutIsTTY;
    process.stdout.columns = originalColumns;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("detects terminal capabilities from tty and env", () => {
    process.stdout.isTTY = true;
    process.stdout.columns = 132;
    vi.stubEnv("TERM", "xterm-256color");
    vi.stubEnv("COLORTERM", "truecolor");
    vi.stubEnv("LANG", "en_US.UTF-8");
    const hadNoColor = Object.prototype.hasOwnProperty.call(process.env, "NO_COLOR");
    const previousNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;

    expect(detectTerminalCapabilities(false)).toEqual({
      isTTY: true,
      supportsUnicode: true,
      supportsColor: true,
      supportsTrueColor: true,
      columns: 132
    });

    vi.stubEnv("NO_COLOR", "1");
    expect(detectTerminalCapabilities(false).supportsColor).toBe(false);
    expect(detectTerminalCapabilities(true).supportsColor).toBe(false);

    if (hadNoColor) {
      process.env.NO_COLOR = previousNoColor;
    }
  });

  it("formats log lines with and without ANSI styling", () => {
    const plain = formatConsoleLogLine({
      time: new Date("2026-03-04T10:00:00.000Z"),
      level: "INFO",
      message: "running task 1/3",
      caps: caps({ supportsColor: false })
    });
    expect(plain).toContain("[INFO] running task 1/3");

    const color = formatConsoleLogLine({
      time: new Date("2026-03-04T10:00:00.000Z"),
      level: "INFO",
      message: "codex: done",
      caps: caps(),
      event: {
        schemaVersion: 1,
        id: "e-1",
        runId: "run-1",
        time: "2026-03-04T10:00:00.000Z",
        level: "INFO",
        phase: "tasks",
        kind: "codex_result",
        actor: "codex",
        message: "codex: done"
      }
    });
    expect(color).toContain("\x1b[");
    expect(stripAnsi(color)).toContain("[INFO] codex: done");

    const compact = formatConsoleLogLine({
      time: new Date("2026-03-04T10:00:00.000Z"),
      level: "INFO",
      message: "task 1: codex request 1/2 - implement checklist items for this task",
      caps: caps({ supportsColor: false }),
      event: {
        schemaVersion: 1,
        id: "e-2",
        runId: "run-1",
        time: "2026-03-04T10:00:00.000Z",
        level: "INFO",
        phase: "tasks",
        kind: "codex_request",
        actor: "codex",
        goal: "implement checklist items for this task",
        attempt: { current: 1, total: 2 },
        message: "task 1: codex request 1/2 - implement checklist items for this task"
      },
      style: "compact"
    });
    expect(compact).toContain("> implement checklist items for this task");
    expect(compact).not.toContain("[INFO]");
  });

  it("renders section and plan preview in plain and styled modes", () => {
    const plan = "# Plan: Demo\n\n## Validation Commands\n- npm test\n- [ ] item";

    const plainSection = renderSection("review", caps({ supportsUnicode: false, supportsColor: false }));
    expect(plainSection).toContain("[review]");

    const styledSection = renderSection("review", caps());
    expect(styledSection).toContain("─");

    const plainPreview = renderPlanPreview(plan, caps({ supportsUnicode: false, supportsColor: false }));
    expect(plainPreview).toContain("--- Draft Plan ---");

    const styledPreview = renderPlanPreview(plan, caps());
    expect(styledPreview).toContain("╭");
    expect(stripAnsi(styledPreview)).toContain("Plan Preview");
  });

  it("summarizes tool output and suppresses known noisy lines", () => {
    const compact = summarizeToolOutput({
      totalLines: 2,
      totalChars: 20,
      preview: ["a", "b"]
    });
    expect(compact.lines).toEqual(["a", "b"]);

    const dense = summarizeToolOutput({
      totalLines: 20,
      totalChars: 1000,
      preview: ["line1", "line2", "line3", "line4", "line5", "line6"],
      previewLimit: 3
    });
    expect(dense.lines).toEqual(["line1", "line2", "line3"]);

    expect(shouldSuppressToolLine("codex_core::skills::loader: failed to stat skills entry")).toBe(true);
    expect(shouldSuppressToolLine("rmcp::transport::worker: worker quit with fatal")).toBe(true);
    expect(shouldSuppressToolLine("└ List *.review.json")).toBe(false);
    expect(toToolOutputHeading("• Ran for f in $(ls -1t ...)")).toBe("Ran for f in $(ls -1t ...)");
    expect(toToolOutputHeading("• Explored")).toBe("Explored");
    expect(toToolOutputHeading("· Restructuring the loop")).toBe("Restructuring the loop");
    expect(toToolOutputHeading("● Deep analysis")).toBe("Deep analysis");
    expect(toToolOutputHeading("exec")).toBe("exec");
    expect(toToolOutputHeading('/bin/zsh -lc "rg --files" in /tmp')).toBe('/bin/zsh -lc "rg --files" in /tmp');
    expect(toToolOutputHeading("\u001b[35m• Ran rg --files\u001b[0m")).toBe("Ran rg --files");
    expect(isToolActionLine("• Explored")).toBe(true);
    expect(isToolActionLine("· Restructuring the loop")).toBe(true);
    expect(isToolActionLine("\u001b[35m• Ran rg --files\u001b[0m")).toBe(true);
    expect(isToolActionLine("exec")).toBe(false);
    expect(extractToolProgressBullet("● Checking current files")).toBe("Checking current files");
    expect(extractToolProgressBullet("exec")).toBeNull();
    expect(shouldSuppressToolLine("normal output")).toBe(false);

    const compactState = createToolCompactFilterState();
    expect(selectCompactToolLine("--------", compactState)).toBe("--------");
    expect(selectCompactToolLine("Workdir: /tmp", compactState)).toBe("Workdir: /tmp");
    expect(selectCompactToolLine("--------", compactState)).toBe("--------");
    expect(selectCompactToolLine("**Summarized step**", compactState)).toBe("Summarized step");
    expect(selectCompactToolLine("• Explored", compactState)).toBe("Explored");
    expect(selectCompactToolLine('/bin/zsh -lc "rg --files src" in /tmp succeeded in 20ms:', compactState)).toBe(
      "Ran rg --files src"
    );
    expect(
      selectCompactToolLine(
        "Restructuring the loop: next I run tighter question iterations and start a new round.",
        compactState
      )
    ).toContain("Restructuring the loop");
    expect(selectCompactToolLine("test('rgb() parse slash-alpha syntax', () => {", compactState)).toBeNull();
    expect(selectCompactToolLine("const source = '.a { color: var(--theme-bg-soft) }';", compactState)).toBeNull();
    expect(selectCompactToolLine("└ zsh: no matches found", compactState)).toBeNull();
  });

  it("handles truncation and duration/time formatting helpers", () => {
    expect(truncateToWidth("hello world", 5)).toBe("he...");
    expect(truncateToWidth("hello", 3)).toBe("...");
    expect(truncateToWidth("hello", 0)).toBe("");

    expect(formatShortTime(new Date("2026-03-04T01:02:03.000Z"))).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(formatShortDuration(59_999)).toBe("59s");
    expect(formatShortDuration(61_000)).toBe("1m01s");
  });

  it("clears current terminal line via stdout escape sequence", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    clearCurrentTerminalLine();
    expect(writeSpy).toHaveBeenCalledWith("\r\x1b[2K");
  });
});
