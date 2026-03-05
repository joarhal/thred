import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { ensureDir } from "../util/fs.js";
import { createEventFromLegacyLog, toLegacyLogEntry, type LegacyLogEntry, type ProgressEvent } from "./events.js";
import {
  clearCurrentTerminalLine,
  detectTerminalCapabilities,
  extractToolProgressBullet,
  formatConsoleLogLine,
  formatShortTime,
  formatShortDuration,
  shouldSuppressToolLine,
  summarizeToolOutput,
  truncateToWidth,
  type LogLevel,
  type TerminalCapabilities
} from "../ui/terminal.js";

interface PendingToolOutput {
  totalLines: number;
  totalChars: number;
  preview: string[];
}

interface CodexToolRequestState {
  hasProgressBullets: boolean;
}

export type ProgressDiagnosticLevel = "INFO" | "WARN" | "ERROR";

const STATUS_SPINNER_ASCII = ["|", "/", "-", "\\"];
const STATUS_SPINNER_UNICODE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STATUS_DELAY_MS = 200;
const STATUS_TICK_MS = 120;

export interface ProgressStatusSnapshot {
  phase: string;
  task: string;
  stage: string;
  event: string;
  startedAt: number;
}

export interface ProgressLogSink {
  log(entry: LegacyLogEntry): Promise<void> | void;
  onEvent?(event: ProgressEvent): Promise<void> | void;
  setStatus?(status: ProgressStatusSnapshot): Promise<void> | void;
  clearStatus?(): Promise<void> | void;
}

export class ProgressLogger {
  readonly logPath: string;
  readonly eventsPath: string;

  private readonly runId: string;
  private readonly verbose: boolean;
  private readonly caps: TerminalCapabilities;
  private readonly sink?: ProgressLogSink;
  private readonly statusEnabled: boolean;
  private readonly statusStartedAt: number;
  private statusDelayTimer?: NodeJS.Timeout;
  private statusTimer?: NodeJS.Timeout;
  private statusVisible: boolean;
  private statusHasSpacer: boolean;
  private spinnerTick: number;
  private hasPrintedLine: boolean;
  private statusPhase: string;
  private statusTask: string;
  private statusStage: string;
  private statusEvent: string;
  private pendingTool: PendingToolOutput;
  private activeCodexRequest?: CodexToolRequestState;
  private persistenceQueue: Promise<void>;

  constructor(logPath: string, eventsPath: string, runId: string, noColor: boolean, verbose: boolean, sink?: ProgressLogSink) {
    this.logPath = logPath;
    this.eventsPath = eventsPath;
    this.runId = runId;
    this.verbose = verbose;
    this.sink = sink;
    this.caps = detectTerminalCapabilities(noColor);
    this.statusEnabled = this.caps.isTTY && !sink;
    this.statusStartedAt = Date.now();
    this.statusVisible = false;
    this.statusHasSpacer = false;
    this.spinnerTick = 0;
    this.hasPrintedLine = false;
    this.statusPhase = "init";
    this.statusTask = "-";
    this.statusStage = "booping";
    this.statusEvent = "booting";
    this.pendingTool = {
      totalLines: 0,
      totalChars: 0,
      preview: []
    };
    this.persistenceQueue = Promise.resolve();
    this.startStatus();
  }

  static async create(
    runDir: string,
    runId: string,
    noColor: boolean,
    verbose: boolean,
    sink?: ProgressLogSink
  ): Promise<ProgressLogger> {
    await ensureDir(runDir);
    const logPath = path.join(runDir, `${runId}.log`);
    const eventsPath = path.join(runDir, `${runId}.events.jsonl`);
    await writeFile(logPath, "", "utf8");
    await writeFile(eventsPath, "", "utf8");
    return new ProgressLogger(logPath, eventsPath, runId, noColor, verbose, sink);
  }

  async info(msg: string): Promise<void> {
    await this.write("INFO", msg, true);
  }

  async debug(msg: string): Promise<void> {
    await this.write("DEBUG", msg, this.verbose);
  }

  async phase(phaseName: string): Promise<void> {
    await this.write("PHASE", phaseName, true);
  }

  async warn(msg: string): Promise<void> {
    await this.write("WARN", msg, true);
  }

  async error(msg: string): Promise<void> {
    await this.write("ERROR", msg, true);
  }

  async success(msg: string): Promise<void> {
    await this.write("OK", msg, true);
  }

  async diagnostic(level: ProgressDiagnosticLevel, message: string, verboseDetail?: string): Promise<void> {
    const payload = composeDiagnosticMessage(message, verboseDetail);
    if (level === "INFO") {
      await this.info(payload);
      return;
    }
    if (level === "WARN") {
      await this.warn(payload);
      return;
    }
    await this.error(payload);
  }

  async rawToolOutput(msg: string): Promise<void> {
    const lines = msg.split(/\r?\n/).filter((line) => line.length > 0);
    if (lines.length === 0) {
      return;
    }

    const prepared = lines.map((line) => {
      const rawEvent = createEventFromLegacyLog({
        runId: this.runId,
        level: "TOOL",
        message: line,
        time: new Date()
      });
      return {
        rawEvent,
        visible: !shouldSuppressToolLine(line)
      };
    });

    for (const item of prepared) {
      await this.persistEvent(item.rawEvent);
    }

    if (this.verbose) {
      const verboseEvents = prepared.filter((item) => item.visible).map((item) => item.rawEvent);
      await this.renderToolEvents(verboseEvents);
      return;
    }

    if (this.activeCodexRequest) {
      const immediateEvents: ProgressEvent[] = [];
      for (const item of prepared) {
        if (!item.visible) {
          continue;
        }

        const bulletHeading = extractToolProgressBullet(item.rawEvent.message);
        if (bulletHeading) {
          if (!this.activeCodexRequest.hasProgressBullets) {
            this.activeCodexRequest.hasProgressBullets = true;
          }
          immediateEvents.push({ ...item.rawEvent, message: bulletHeading, actor: "codex", kind: "info" });
          continue;
        }
      }

      await this.renderToolEvents(immediateEvents);
      return;
    }
  }

  async startCodexRequest(): Promise<void> {
    if (this.verbose) {
      return;
    }
    this.activeCodexRequest = {
      hasProgressBullets: false
    };
  }

  async finishCodexRequest(): Promise<void> {
    if (this.verbose) {
      this.activeCodexRequest = undefined;
      return;
    }

    const request = this.activeCodexRequest;
    this.activeCodexRequest = undefined;
    if (!request || request.hasProgressBullets) {
      return;
    }
  }

  async close(): Promise<void> {
    await this.finishCodexRequest();
    await this.flushPendingToolSummary();
    this.stopStatus();
    if (this.sink?.clearStatus) {
      await this.sink.clearStatus();
    }
  }

  private async write(level: LogLevel, msg: string, printToConsole: boolean): Promise<void> {
    const prepared = this.prepareMessageForOutput(level, msg);
    const event = createEventFromLegacyLog({
      runId: this.runId,
      level,
      message: prepared.visibleMessage,
      time: new Date()
    });
    await this.persistEvent(event);
    if (prepared.hiddenDetailMessage) {
      await this.persistEvent(
        createEventFromLegacyLog({
          runId: this.runId,
          level: "DEBUG",
          message: prepared.hiddenDetailMessage,
          time: new Date()
        })
      );
    }
    this.updateStatusState(event);

    if (!printToConsole) {
      return;
    }

    await this.flushPendingToolSummary();
    if (this.sink) {
      await this.dispatchToSink(event);
      return;
    }

    this.pauseStatusLine();
    if (this.shouldAnimateCodexSummary(event)) {
      await this.renderAnimatedCodexSummary(event);
    } else {
      const entry = toLegacyLogEntry(event);
      const line = formatConsoleLogLine({
        time: entry.time,
        level: entry.level,
        message: entry.message,
        caps: this.caps,
        event,
        style: this.verbose ? "legacy" : "compact"
      });
      process.stdout.write(this.renderConsoleLine(entry.level, line));
    }
    this.resumeStatusLine();
  }

  private prepareMessageForOutput(level: LogLevel, message: string): {
    visibleMessage: string;
    hiddenDetailMessage?: string;
  } {
    const normalized = message.replace(/\r\n/g, "\n");
    const [summary, ...detailLines] = normalized.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!summary) {
      return {
        visibleMessage: normalized.trim()
      };
    }

    if (detailLines.length === 0) {
      return {
        visibleMessage: summary
      };
    }

    const detail = detailLines.join(" | ");
    if (this.verbose) {
      return {
        visibleMessage: `${summary} (${detail})`
      };
    }

    return {
      visibleMessage: summary,
      hiddenDetailMessage: `${level.toLowerCase()} detail: ${detail}`
    };
  }

  private async persistEvent(event: ProgressEvent): Promise<void> {
    const entry = toLegacyLogEntry(event);
    await this.enqueuePersistence(async () => {
      await this.appendWithRecovery(this.logPath, `[${entry.time.toISOString()}] [${entry.level}] ${entry.message}\n`);
      await this.appendWithRecovery(this.eventsPath, `${JSON.stringify(event)}\n`);
    });
  }

  private async renderToolEvents(events: ProgressEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    if (this.sink) {
      for (const event of events) {
        await this.dispatchToSink(event);
      }
      return;
    }

    this.pauseStatusLine();
    for (const event of events) {
      const entry = toLegacyLogEntry(event);
      process.stdout.write(
        `${formatConsoleLogLine({
          time: entry.time,
          level: entry.level,
          message: entry.message,
          caps: this.caps,
          event,
          style: this.verbose ? "legacy" : "compact"
        })}\n`
      );
    }
    this.resumeStatusLine();
  }

  private async enqueuePersistence(operation: () => Promise<void>): Promise<void> {
    const queued = this.persistenceQueue.then(operation, operation);
    this.persistenceQueue = queued.catch(() => undefined);
    await queued;
  }

  private async appendWithRecovery(targetPath: string, content: string): Promise<void> {
    try {
      await appendFile(targetPath, content, "utf8");
      return;
    } catch (error) {
      if (!isEnoent(error)) {
        throw error;
      }
    }

    await ensureDir(path.dirname(targetPath));
    await appendFile(targetPath, content, "utf8");
  }

  private async dispatchToSink(event: ProgressEvent): Promise<void> {
    if (!this.sink) {
      return;
    }
    if (this.sink.onEvent) {
      await this.sink.onEvent(event);
      return;
    }
    await this.sink.log(toLegacyLogEntry(event));
  }

  private renderConsoleLine(level: LogLevel, line: string): string {
    if (level === "PHASE" && this.hasPrintedLine) {
      return `\n${line}\n`;
    }
    this.hasPrintedLine = true;
    return `${line}\n`;
  }

  private async flushPendingToolSummary(): Promise<void> {
    if (this.verbose || this.pendingTool.totalLines === 0) {
      return;
    }

    const summary = summarizeToolOutput({
      totalLines: this.pendingTool.totalLines,
      totalChars: this.pendingTool.totalChars,
      preview: this.pendingTool.preview
    });

    const now = new Date();
    if (this.sink) {
      for (const line of summary.lines) {
        await this.sink.log({ time: now, level: "TOOL", message: line });
      }
      this.pendingTool = {
        totalLines: 0,
        totalChars: 0,
        preview: []
      };
      return;
    }

    this.pauseStatusLine();
    for (const line of summary.lines) {
      process.stdout.write(
        `${formatConsoleLogLine({
          time: now,
          level: "TOOL",
          message: line,
          caps: this.caps,
          style: this.verbose ? "legacy" : "compact"
        })}\n`
      );
    }
    this.resumeStatusLine();
    this.pendingTool = {
      totalLines: 0,
      totalChars: 0,
      preview: []
    };
  }

  private updateStatusState(event: ProgressEvent): void {
    if (event.level === "TOOL" || event.level === "DEBUG") {
      return;
    }

    const normalized = event.message.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return;
    }
    this.statusEvent = truncateToWidth(normalized, 88);

    if (event.level === "PHASE") {
      this.statusPhase = event.phase === "unknown" ? normalized : event.phase;
      this.statusStage = "booping";
      this.statusTask = normalized === "tasks" ? this.statusTask : "-";
    } else {
      if (event.taskNumber) {
        this.statusTask = `#${event.taskNumber}`;
      }
      if (event.attempt) {
        this.statusStage = `${event.kind.replaceAll("_", " ")} ${event.attempt.current}/${event.attempt.total}`;
      } else if (event.level === "INFO" && event.kind === "info") {
        this.statusStage = inferMeaningfulInfoStage(event);
      } else {
        this.statusStage = event.kind.replaceAll("_", " ");
      }
      if (event.level === "WARN") {
        this.statusStage = "attention";
      } else if (event.level === "ERROR") {
        this.statusStage = "error";
      } else if (event.level === "OK") {
        this.statusStage = "completed";
      }
    }

    void this.sink?.setStatus?.({
      phase: this.statusPhase,
      task: this.statusTask,
      stage: this.statusStage,
      event: this.statusEvent,
      startedAt: this.statusStartedAt
    });
  }

  private shouldAnimateCodexSummary(event: ProgressEvent): boolean {
    return this.verbose && event.level === "INFO" && event.actor === "codex";
  }

  private async renderAnimatedCodexSummary(event: ProgressEvent): Promise<void> {
    const entry = toLegacyLogEntry(event);
    if (!this.caps.supportsColor || !this.caps.isTTY) {
      const fallback = formatConsoleLogLine({
        time: entry.time,
        level: entry.level,
        message: entry.message,
        caps: this.caps,
        event,
        style: this.verbose ? "legacy" : "compact"
      });
      process.stdout.write(this.renderConsoleLine("INFO", fallback));
      return;
    }

    const prefixMatch = entry.message.match(/^(.*?\bcodex:\s*)(.*)$/i);
    const before = prefixMatch?.[1] ?? "codex: ";
    const after = prefixMatch?.[2] ?? entry.message;
    const ts = `\x1b[90m[${formatShortTime(entry.time)}]\x1b[0m`;
    const label = `\x1b[36m● [INFO]\x1b[0m`;
    const beforeStyled = `\x1b[35m${before}\x1b[0m`;
    const frames = ["\x1b[95m", "\x1b[96m", "\x1b[94m"];

    for (const tone of frames) {
      clearCurrentTerminalLine();
      process.stdout.write(`${ts} ${label} ${beforeStyled}${tone}${after}\x1b[0m`);
      await wait(45);
    }

    clearCurrentTerminalLine();
    process.stdout.write(`${ts} ${label} ${beforeStyled}\x1b[96m${after}\x1b[0m\n`);
  }

  private startStatus(): void {
    if (!this.statusEnabled) {
      return;
    }
    this.statusDelayTimer = setTimeout(() => {
      this.statusVisible = true;
      this.ensureStatusSpacer();
      this.renderStatusLine();
      this.statusTimer = setInterval(() => {
        this.renderStatusLine();
      }, STATUS_TICK_MS);
      this.statusTimer.unref?.();
    }, STATUS_DELAY_MS);
    this.statusDelayTimer.unref?.();
  }

  private stopStatus(): void {
    if (this.statusDelayTimer) {
      clearTimeout(this.statusDelayTimer);
      this.statusDelayTimer = undefined;
    }
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = undefined;
    }
    if (this.statusVisible) {
      clearCurrentTerminalLine();
      this.statusVisible = false;
    }
    if (this.statusHasSpacer) {
      process.stdout.write("\x1b[1A");
      clearCurrentTerminalLine();
      this.statusHasSpacer = false;
    }
  }

  private pauseStatusLine(): void {
    if (!this.statusVisible) {
      return;
    }
    clearCurrentTerminalLine();
    if (this.statusHasSpacer) {
      process.stdout.write("\x1b[1A");
      clearCurrentTerminalLine();
      this.statusHasSpacer = false;
    }
  }

  private resumeStatusLine(): void {
    if (!this.statusVisible) {
      return;
    }
    this.ensureStatusSpacer();
    this.renderStatusLine();
  }

  private ensureStatusSpacer(): void {
    if (this.statusHasSpacer) {
      return;
    }
    process.stdout.write("\n");
    this.statusHasSpacer = true;
  }

  private renderStatusLine(): void {
    if (!this.statusVisible) {
      return;
    }

    clearCurrentTerminalLine();
    const frames = this.caps.supportsUnicode ? STATUS_SPINNER_UNICODE : STATUS_SPINNER_ASCII;
    const frame = frames[this.spinnerTick % frames.length] ?? "|";
    this.spinnerTick += 1;

    const elapsed = formatShortDuration(Date.now() - this.statusStartedAt);
    const phase = compactLabel(this.statusPhase, 16);
    const task = compactLabel(this.statusTask, 8);
    const stage = compactLabel(this.statusStage, 18);
    const composed = `${frame} ${phase} · task ${task} · ${stage} · ${elapsed}`;

    const width = Math.max(40, this.caps.columns - 1);
    const line = truncateToWidth(composed, width);
    if (this.caps.supportsColor) {
      process.stdout.write(`\x1b[35m${line}\x1b[0m`);
      return;
    }
    process.stdout.write(line);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function inferMeaningfulInfoStage(event: ProgressEvent): string {
  const normalized = event.message.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) {
    return "booping";
  }

  if (event.actor === "validation" || normalized.includes("validation") || normalized.includes("validate")) {
    return "validation";
  }
  if (event.actor === "review" || normalized.includes("review")) {
    return "review";
  }
  if (event.actor === "memory" || normalized.includes("memory")) {
    return "memory";
  }
  if (event.actor === "codex" || normalized.includes("codex")) {
    return "codex";
  }
  if (normalized.includes("clarification") || normalized.includes("ambiguities")) {
    return "clarification";
  }
  if (
    normalized.includes("plan generation") ||
    normalized.includes("generating draft plan") ||
    normalized.includes("generating execution plan")
  ) {
    return "plan generation";
  }
  if (normalized.includes("repository context") || normalized.includes("codebase structure")) {
    return "analysis";
  }
  if (normalized.startsWith("running task ") || normalized.startsWith("task ")) {
    return "task progress";
  }

  return "booping";
}

function compactLabel(value: string, maxLen: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "-";
  }
  if (normalized.length <= maxLen) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLen - 1))}…`;
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

function composeDiagnosticMessage(message: string, verboseDetail?: string): string {
  const summary = message.replace(/\s+/g, " ").trim();
  if (!verboseDetail) {
    return summary;
  }
  const detail = verboseDetail.replace(/\s+/g, " ").trim();
  if (!detail) {
    return summary;
  }
  if (!summary) {
    return `verboseDetail: ${detail}`;
  }
  return `${summary}\nverboseDetail: ${detail}`;
}
