import path from "node:path";

import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, Static, render, useInput } from "ink";

import type { ProgressLogSink, ProgressStatusSnapshot } from "../progress/logger.js";
import type { ProgressEvent } from "../progress/events.js";
import {
  detectTerminalCapabilities,
  formatConsoleLogLine,
  formatShortDuration,
  formatShortTime,
  renderPlanPreview,
  renderSection,
  toCompactConsoleMessage,
  type LogLevel
} from "../ui/terminal.js";

export interface ChoiceItem {
  value: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

interface RuntimeEntry {
  id: number;
  kind: "section" | "log";
  title?: string;
  at: Date;
  level?: LogLevel;
  message?: string;
  event?: ProgressEvent;
}

interface SpinnerState {
  kind: "thinking" | "status";
  startedAt: number;
  label?: string;
  phase?: string;
  task?: string;
  stage?: string;
}

interface TextPromptState {
  kind: "text";
  title: string;
  hint?: string;
  placeholder?: string;
  initialValue?: string;
  allowEmpty?: boolean;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

interface ChoicePromptState {
  kind: "choice";
  title: string;
  hint?: string;
  items: ChoiceItem[];
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

type RuntimePromptState = TextPromptState | ChoicePromptState;

interface RuntimeState {
  entries: RuntimeEntry[];
  previewMarkdown?: string;
  spinner?: SpinnerState;
  prompt?: RuntimePromptState;
}

const MAX_LOG_ENTRIES = 500;

class InteractiveInkRuntime {
  private readonly noColor: boolean;
  private readonly cwd: string;
  private readonly listeners = new Set<() => void>();
  private state: RuntimeState = { entries: [] };
  private entryId = 0;
  private instance?: ReturnType<typeof render>;
  private progressSink?: ProgressLogSink;

  constructor(input: { noColor: boolean; cwd: string }) {
    this.noColor = input.noColor;
    this.cwd = input.cwd;
  }

  start(): void {
    if (this.instance) {
      return;
    }
    this.instance = render(<RuntimeRoot runtime={this} />);
  }

  stop(): void {
    const pending = this.state.prompt;
    if (pending) {
      pending.reject(new Error("interactive prompt cancelled"));
      this.state = { ...this.state, prompt: undefined };
    }
    this.instance?.unmount();
    this.instance = undefined;
  }

  getSnapshot(): RuntimeState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  addSection(title: string): void {
    this.pushEntry({ kind: "section", title, at: new Date() });
  }

  addLog(level: LogLevel, message: string, at = new Date()): void {
    this.pushEntry({ kind: "log", level, message, at });
  }

  addEvent(event: ProgressEvent): void {
    if (event.kind === "phase_start") {
      this.addSection(`Phase · ${capitalize(event.message)}`);
      return;
    }
    this.pushEntry({
      kind: "log",
      level: event.level,
      message: event.message,
      at: new Date(event.time),
      event
    });
  }

  setPreview(markdown: string): void {
    this.setState((prev) => ({
      ...prev,
      previewMarkdown: normalizePreviewMarkdown(markdown, this.cwd)
    }));
  }

  clearPreview(): void {
    this.setState((prev) => ({ ...prev, previewMarkdown: undefined }));
  }

  setThinking(label?: string): void {
    if (!label) {
      if (this.state.spinner?.kind !== "thinking") {
        return;
      }
      this.setState((prev) => ({ ...prev, spinner: undefined }));
      return;
    }

    this.setState((prev) => ({
      ...prev,
      spinner: {
        kind: "thinking",
        label,
        startedAt: Date.now()
      }
    }));
  }

  setProgressStatus(status: ProgressStatusSnapshot): void {
    this.setState((prev) => ({
      ...prev,
      spinner: {
        kind: "status",
        startedAt: status.startedAt,
        phase: status.phase,
        task: status.task,
        stage: status.stage
      }
    }));
  }

  clearProgressStatus(): void {
    if (this.state.spinner?.kind !== "status") {
      return;
    }
    this.setState((prev) => ({ ...prev, spinner: undefined }));
  }

  getProgressSink(): ProgressLogSink {
    if (this.progressSink) {
      return this.progressSink;
    }

    this.progressSink = {
      log: (entry) => {
        if (entry.level === "PHASE") {
          this.addSection(`Phase · ${capitalize(entry.message)}`);
          return;
        }
        this.addLog(entry.level, entry.message, entry.time);
      },
      onEvent: (event) => {
        this.addEvent(event);
      },
      setStatus: (status) => {
        this.setProgressStatus(status);
      },
      clearStatus: () => {
        this.clearProgressStatus();
      }
    };

    return this.progressSink;
  }

  async promptText(input: {
    title: string;
    hint?: string;
    placeholder?: string;
    initialValue?: string;
    allowEmpty?: boolean;
  }): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.setState((prev) => ({
        ...prev,
        prompt: {
          kind: "text",
          title: input.title,
          hint: input.hint,
          placeholder: input.placeholder,
          initialValue: input.initialValue,
          allowEmpty: input.allowEmpty,
          resolve,
          reject
        }
      }));
    });
  }

  async promptChoice(input: {
    title: string;
    hint?: string;
    items: ChoiceItem[];
  }): Promise<string> {
    if (input.items.length === 0) {
      throw new Error("interactive choice prompt requires at least one item");
    }
    return new Promise<string>((resolve, reject) => {
      this.setState((prev) => ({
        ...prev,
        prompt: {
          kind: "choice",
          title: input.title,
          hint: input.hint,
          items: input.items,
          resolve,
          reject
        }
      }));
    });
  }

  submitPrompt(value: string): void {
    const current = this.state.prompt;
    if (!current) {
      return;
    }
    this.setState((prev) => ({ ...prev, prompt: undefined }));
    current.resolve(value);
  }

  cancelPrompt(): void {
    const current = this.state.prompt;
    if (!current) {
      return;
    }
    this.setState((prev) => ({ ...prev, prompt: undefined }));
    current.reject(new Error("interactive prompt cancelled"));
  }

  private pushEntry(entry: Omit<RuntimeEntry, "id">): void {
    const next: RuntimeEntry = {
      id: this.entryId,
      ...entry
    };
    this.entryId += 1;

    this.setState((prev) => {
      const appended = [...prev.entries, next];
      const cropped = appended.length > MAX_LOG_ENTRIES ? appended.slice(appended.length - MAX_LOG_ENTRIES) : appended;
      return {
        ...prev,
        entries: cropped
      };
    });
  }

  private setState(next: RuntimeState | ((prev: RuntimeState) => RuntimeState)): void {
    this.state = typeof next === "function" ? next(this.state) : next;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

let interactiveNoColor = false;
let interactiveRuntime: InteractiveInkRuntime | undefined;

export function configureInteractiveOutput(input: { noColor: boolean; cwd?: string }): void {
  interactiveNoColor = input.noColor;
  interactiveRuntime?.stop();

  const caps = detectTerminalCapabilities(input.noColor);
  if (!caps.isTTY) {
    interactiveRuntime = undefined;
    return;
  }

  interactiveRuntime = new InteractiveInkRuntime({
    noColor: input.noColor,
    cwd: input.cwd ?? process.cwd()
  });
  interactiveRuntime.start();
}

export function shutdownInteractiveOutput(): void {
  interactiveRuntime?.stop();
  interactiveRuntime = undefined;
}

export async function promptText(input: {
  title: string;
  hint?: string;
  placeholder?: string;
  initialValue?: string;
  allowEmpty?: boolean;
}): Promise<string> {
  if (interactiveRuntime) {
    return interactiveRuntime.promptText(input);
  }

  return runPrompt<string>(({ resolve, reject }) => (
    <TextPrompt
      title={input.title}
      hint={input.hint}
      placeholder={input.placeholder}
      initialValue={input.initialValue ?? ""}
      allowEmpty={Boolean(input.allowEmpty)}
      onSubmit={resolve}
      onCancel={() => reject(new Error("interactive prompt cancelled"))}
    />
  ));
}

export async function promptChoice(input: {
  title: string;
  hint?: string;
  items: ChoiceItem[];
}): Promise<string> {
  if (interactiveRuntime) {
    return interactiveRuntime.promptChoice(input);
  }

  return runPrompt<string>(({ resolve, reject }) => (
    <ChoicePrompt
      title={input.title}
      hint={input.hint}
      items={input.items}
      onSelect={resolve}
      onCancel={() => reject(new Error("interactive prompt cancelled"))}
    />
  ));
}

export function printSection(title: string): void {
  if (interactiveRuntime) {
    interactiveRuntime.addSection(title);
    return;
  }

  const caps = detectTerminalCapabilities(interactiveNoColor);
  process.stdout.write(renderSection(title, caps));
}

export function printPlanPreview(plan: string): void {
  if (interactiveRuntime) {
    interactiveRuntime.setPreview(plan);
    return;
  }

  const caps = detectTerminalCapabilities(interactiveNoColor);
  process.stdout.write(renderPlanPreview(plan, caps));
}

export function clearPlanPreview(): void {
  interactiveRuntime?.clearPreview();
}

export function printInfo(msg: string): void {
  printLog("INFO", msg);
}

export function printDebug(msg: string): void {
  printLog("DEBUG", msg);
}

export function printWarn(msg: string): void {
  printLog("WARN", msg);
}

export function printError(msg: string): void {
  printLog("ERROR", msg);
}

export function clearTerminalScreen(): void {
  if (interactiveRuntime) {
    return;
  }

  // Clear full screen and move cursor to top-left.
  process.stdout.write("\x1b[2J\x1b[H");
}

export function setThinkingIndicator(label?: string): void {
  interactiveRuntime?.setThinking(label);
}

export function getInteractiveProgressSink(): ProgressLogSink | undefined {
  return interactiveRuntime?.getProgressSink();
}

function printLog(level: LogLevel, msg: string): void {
  if (interactiveRuntime) {
    interactiveRuntime.addLog(level, msg, new Date());
    return;
  }

  const caps = detectTerminalCapabilities(interactiveNoColor);
  const line = formatConsoleLogLine({
    time: new Date(),
    level,
    message: msg,
    caps
  });
  process.stdout.write(`${line}\n`);
}

function runPrompt<T>(
  factory: (helpers: { resolve: (value: T) => void; reject: (error: Error) => void }) => React.ReactElement
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const instance = render(
      factory({
        resolve: (value) => {
          if (done) {
            return;
          }
          done = true;
          instance.clear();
          instance.unmount();
          resolve(value);
        },
        reject: (error) => {
          if (done) {
            return;
          }
          done = true;
          instance.clear();
          instance.unmount();
          reject(error);
        }
      })
    );
  });
}

function RuntimeRoot(input: { runtime: InteractiveInkRuntime }): React.ReactElement {
  const state = useRuntimeState(input.runtime);
  const columns = typeof process.stdout.columns === "number" && process.stdout.columns > 0 ? process.stdout.columns : 100;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!state.spinner) {
      return;
    }

    const id = setInterval(() => {
      setTick((prev) => prev + 1);
    }, 120);

    return () => {
      clearInterval(id);
    };
  }, [state.spinner?.kind, state.spinner?.startedAt]);

  const spinnerLine = useMemo(() => {
    if (!state.spinner) {
      return "";
    }
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const frame = frames[tick % frames.length] ?? "⠋";
    const elapsed = formatShortDuration(Date.now() - state.spinner.startedAt);

    if (state.spinner.kind === "thinking") {
      const label = conciseSpinnerLabel(state.spinner.label);
      return `${frame} · ${label} · ${elapsed}`;
    }

    const label = conciseSpinnerLabel(state.spinner.stage ?? state.spinner.phase ?? state.spinner.task);
    return `${frame} · ${label} · ${elapsed}`;
  }, [state.spinner, tick]);

  return (
    <Box flexDirection="column" width="100%">
      <Static items={state.entries}>
        {(entry) => {
          if (entry.kind === "section") {
            return <SectionLine key={entry.id} title={entry.title ?? ""} columns={columns} noColor={interactiveNoColor} />;
          }

          return (
            <LogLine
              key={entry.id}
              at={entry.at}
              level={entry.level ?? "INFO"}
              message={entry.message ?? ""}
              event={entry.event}
              noColor={interactiveNoColor}
            />
          );
        }}
      </Static>

      {state.previewMarkdown ? (
        <Box marginTop={1} width="100%">
          <PlanPreviewBox markdown={state.previewMarkdown} noColor={interactiveNoColor} />
        </Box>
      ) : null}

      {state.prompt?.kind === "text" ? (
        <Box marginTop={1} width="100%">
          <TextPrompt
            title={state.prompt.title}
            hint={state.prompt.hint}
            placeholder={state.prompt.placeholder}
            initialValue={state.prompt.initialValue ?? ""}
            allowEmpty={Boolean(state.prompt.allowEmpty)}
            onSubmit={(value) => input.runtime.submitPrompt(value)}
            onCancel={() => input.runtime.cancelPrompt()}
          />
        </Box>
      ) : null}

      {state.prompt?.kind === "choice" ? (
        <Box marginTop={1} width="100%">
          <ChoicePrompt
            title={state.prompt.title}
            hint={state.prompt.hint}
            items={state.prompt.items}
            onSelect={(value) => input.runtime.submitPrompt(value)}
            onCancel={() => input.runtime.cancelPrompt()}
          />
        </Box>
      ) : null}

      {!state.prompt && state.spinner ? (
        <Box marginTop={1} width="100%">
          <Text color={interactiveNoColor ? undefined : "magenta"}>{spinnerLine}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function SectionLine(input: { title: string; columns: number; noColor: boolean }): React.ReactElement {
  const width = Math.max(30, Math.min(110, input.columns - 2));
  const rule = "─".repeat(width);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={input.noColor ? undefined : "gray"}>{rule}</Text>
      <Text color={input.noColor ? undefined : "magentaBright"} bold>
        {input.title}
      </Text>
      <Text color={input.noColor ? undefined : "gray"}>{rule}</Text>
    </Box>
  );
}

function LogLine(input: {
  at: Date;
  level: LogLevel;
  message: string;
  noColor: boolean;
  event?: ProgressEvent;
}): React.ReactElement {
  const compactMessage = toCompactConsoleMessage(input.message, input.event);
  const messageColor = input.noColor ? undefined : colorForCompactLine(input.level, input.message, input.event);

  return (
    <Text>
      <Text color={input.noColor ? undefined : "gray"}>[{formatShortTime(input.at)}]</Text>
      <Text> </Text>
      <Text color={messageColor}>{`> ${compactMessage}`}</Text>
    </Text>
  );
}

function PlanPreviewBox(input: { markdown: string; noColor: boolean }): React.ReactElement {
  const lines = useMemo(() => parsePreviewMarkdown(input.markdown), [input.markdown]);

  return (
    <Box borderStyle="round" borderColor={input.noColor ? undefined : "cyan"} paddingX={1} flexDirection="column">
      <Text color={input.noColor ? undefined : "blueBright"} bold>
        Plan Preview
      </Text>
      <Box marginTop={1} flexDirection="column">
        {lines.map((line, index) => (
          <PlanPreviewLine key={`${index}-${line.kind}-${line.text}`} line={line} noColor={input.noColor} />
        ))}
      </Box>
    </Box>
  );
}

type PreviewLine =
  | { kind: "blank"; text: "" }
  | { kind: "h1" | "h2" | "h3" | "text" | "bullet"; text: string }
  | { kind: "check"; text: string; done: boolean };

function PlanPreviewLine(input: { line: PreviewLine; noColor: boolean }): React.ReactElement {
  const { line, noColor } = input;

  if (line.kind === "blank") {
    return <Text> </Text>;
  }

  if (line.kind === "h1") {
    return (
      <Text color={noColor ? undefined : "cyanBright"} bold>
        {renderInlineMarkdown(line.text, noColor)}
      </Text>
    );
  }

  if (line.kind === "h2") {
    return (
      <Text color={noColor ? undefined : "yellowBright"} bold>
        {renderInlineMarkdown(line.text, noColor)}
      </Text>
    );
  }

  if (line.kind === "h3") {
    return (
      <Text color={noColor ? undefined : "greenBright"} bold>
        {renderInlineMarkdown(line.text, noColor)}
      </Text>
    );
  }

  if (line.kind === "check") {
    const marker = line.done ? "☑" : "☐";
    return (
      <Text>
        <Text color={noColor ? undefined : line.done ? "green" : "blue"}>{`${marker} `}</Text>
        {renderInlineMarkdown(line.text, noColor)}
      </Text>
    );
  }

  if (line.kind === "bullet") {
    return (
      <Text>
        <Text color={noColor ? undefined : "blue"}>• </Text>
        {renderInlineMarkdown(line.text, noColor)}
      </Text>
    );
  }

  return <Text>{renderInlineMarkdown(line.text, noColor)}</Text>;
}

function renderInlineMarkdown(text: string, noColor: boolean): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const pattern = /(`[^`]+`)|(\[[^\]]+\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match) {
    if (match.index > lastIndex) {
      out.push(text.slice(lastIndex, match.index));
    }

    const raw = match[0];
    const codeToken = match[1];
    const linkToken = match[2];
    if (codeToken) {
      out.push(
        <Text key={`code-${match.index}`} color={noColor ? undefined : "cyan"}>
          {codeToken.slice(1, -1)}
        </Text>
      );
    } else if (linkToken) {
      const link = raw.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const label = link?.[1] ?? raw;
      const target = link?.[2];
      out.push(
        <Text key={`link-label-${match.index}`} color={noColor ? undefined : "blueBright"}>
          {label}
        </Text>
      );
      if (target) {
        out.push(
          <Text key={`link-target-${match.index}`} color={noColor ? undefined : "gray"}>
            {` (${target})`}
          </Text>
        );
      }
    }

    lastIndex = pattern.lastIndex;
    match = pattern.exec(text);
  }

  if (lastIndex < text.length) {
    out.push(text.slice(lastIndex));
  }

  return out;
}

function parsePreviewMarkdown(markdown: string): PreviewLine[] {
  const lines = markdown.split(/\r?\n/);
  const parsed: PreviewLine[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      parsed.push({ kind: "blank", text: "" });
      continue;
    }

    const h1 = line.match(/^#\s+(.+)$/);
    if (h1?.[1]) {
      parsed.push({ kind: "h1", text: h1[1].trim() });
      continue;
    }

    const h2 = line.match(/^##\s+(.+)$/);
    if (h2?.[1]) {
      parsed.push({ kind: "h2", text: h2[1].trim() });
      continue;
    }

    const h3 = line.match(/^###\s+(.+)$/);
    if (h3?.[1]) {
      parsed.push({ kind: "h3", text: h3[1].trim() });
      continue;
    }

    const check = line.match(/^- \[([ xX])\]\s+(.+)$/);
    if (check?.[2]) {
      const done = (check[1] ?? "").toLowerCase() === "x";
      parsed.push({ kind: "check", text: check[2].trim(), done });
      continue;
    }

    const bullet = line.match(/^-\s+(.+)$/);
    if (bullet?.[1]) {
      parsed.push({ kind: "bullet", text: bullet[1].trim() });
      continue;
    }

    parsed.push({ kind: "text", text: line });
  }

  return parsed;
}

function useRuntimeState(runtime: InteractiveInkRuntime): RuntimeState {
  const [state, setState] = useState<RuntimeState>(runtime.getSnapshot());

  useEffect(() => {
    return runtime.subscribe(() => {
      setState(runtime.getSnapshot());
    });
  }, [runtime]);

  return state;
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

function conciseSpinnerLabel(value: string | undefined): string {
  const normalized = (value ?? "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (!normalized) {
    return "booping";
  }
  if (
    normalized === "info" ||
    normalized === "phase" ||
    normalized === "starting" ||
    normalized === "working" ||
    normalized === "unknown" ||
    normalized.includes("wait")
  ) {
    return "booping";
  }
  if (normalized.includes("clarification")) {
    return "clarification";
  }
  if (normalized.includes("plan generation")) {
    return "plan";
  }
  if (normalized.includes("review")) {
    return "review";
  }
  if (normalized.includes("validate")) {
    return "validation";
  }
  if (normalized.includes("memory")) {
    return "memory";
  }
  if (normalized.includes("codex")) {
    return "codex";
  }
  return "booping";
}

function colorForCompactLine(
  level: LogLevel,
  message: string,
  event: ProgressEvent | undefined
): "white" | "yellow" | "red" | "#ff9d00" {
  if (level === "ERROR") {
    return "red";
  }
  if (level === "WARN") {
    return "#ff9d00";
  }
  if (event?.actor === "codex" || /\bcodex\b/i.test(message)) {
    return "yellow";
  }
  return "white";
}

function normalizePreviewMarkdown(markdown: string, cwd: string): string {
  const normalizedCwd = path.resolve(cwd);
  let next = markdown;

  next = next.replace(/\[([^\]]+)\]\((\/[^)\s]+)\)/g, (_m, rawLabel: string, rawTarget: string) => {
    const targetAbs = path.resolve(rawTarget);
    const rel = toDisplayPath(normalizedCwd, targetAbs);
    const label = normalizeLinkLabel(rawLabel, rel);
    return `[${label}](${rel})`;
  });

  return next.replaceAll(`${normalizedCwd}/`, "");
}

function normalizeLinkLabel(label: string, relPath: string): string {
  const clean = label.trim();
  if (clean.startsWith("/") || clean.includes("/.")) {
    return `\`${relPath}\``;
  }
  if (clean.length > 72) {
    return `${clean.slice(0, 69)}...`;
  }
  return clean;
}

function toDisplayPath(cwd: string, targetAbsPath: string): string {
  const relative = path.relative(cwd, targetAbsPath);
  if (!relative || relative === ".") {
    return ".";
  }
  if (relative.startsWith("..")) {
    return path.basename(targetAbsPath);
  }
  return relative;
}

function capitalize(input: string): string {
  const normalized = input.trim();
  if (!normalized) {
    return normalized;
  }
  return `${normalized[0]?.toUpperCase() ?? ""}${normalized.slice(1)}`;
}

function TextPrompt(input: {
  title: string;
  hint?: string;
  placeholder?: string;
  initialValue: string;
  allowEmpty: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [value, setValue] = useState(input.initialValue);
  const [cursor, setCursor] = useState(input.initialValue.length);
  const maxVisibleLines = 5;

  useInput((rawInput, key) => {
    if (key.escape) {
      input.onCancel();
      return;
    }

    if (key.return) {
      if (key.shift) {
        const next = insertAt(value, cursor, "\n");
        setValue(next);
        setCursor(cursor + 1);
        return;
      }

      const nextValue = input.allowEmpty ? value : value.trim();
      const normalizedSubmit = input.allowEmpty && nextValue.trim().length === 0 ? "" : nextValue;

      if (!input.allowEmpty && normalizedSubmit.length === 0) {
        return;
      }

      input.onSubmit(normalizedSubmit);
      return;
    }

    const sequence = parseControlSequence(rawInput);
    if (sequence === "shift_enter") {
      const next = insertAt(value, cursor, "\n");
      setValue(next);
      setCursor(cursor + 1);
      return;
    }
    if (sequence === "left") {
      setCursor((prev) => Math.max(0, prev - 1));
      return;
    }
    if (sequence === "right") {
      setCursor((prev) => Math.min(value.length, prev + 1));
      return;
    }
    if (sequence === "up") {
      setCursor(moveCursorVertical(value, cursor, -1));
      return;
    }
    if (sequence === "down") {
      setCursor(moveCursorVertical(value, cursor, 1));
      return;
    }

    if (key.leftArrow) {
      setCursor((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor((prev) => Math.min(value.length, prev + 1));
      return;
    }
    if (key.upArrow) {
      setCursor(moveCursorVertical(value, cursor, -1));
      return;
    }
    if (key.downArrow) {
      setCursor(moveCursorVertical(value, cursor, 1));
      return;
    }

    if (key.backspace || key.delete) {
      if (cursor === 0) {
        return;
      }
      const next = removeAt(value, cursor - 1, cursor);
      setValue(next);
      setCursor(cursor - 1);
      return;
    }

    if (key.ctrl && rawInput === "d") {
      if (cursor >= value.length) {
        return;
      }
      const next = removeAt(value, cursor, cursor + 1);
      setValue(next);
      return;
    }

    if (key.tab) {
      const next = insertAt(value, cursor, "\t");
      setValue(next);
      setCursor(cursor + 1);
      return;
    }

    if (isControlOnlyInput(rawInput) || key.ctrl || key.meta || !rawInput) {
      return;
    }

    const normalized = normalizePrintableInput(rawInput);
    if (!normalized) {
      return;
    }
    const next = insertAt(value, cursor, normalized);
    setValue(next);
    setCursor(cursor + normalized.length);
  });

  const lines = value === "" ? [""] : value.split("\n");
  const cursorLine = findLineColumnAt(value, cursor).line;
  const startLine = Math.max(0, Math.min(cursorLine, lines.length - 1) - (maxVisibleLines - 1));
  const visibleLines = lines.slice(startLine, startLine + maxVisibleLines);
  const cursorInViewLine = cursorLine - startLine;
  const cursorColumn = findLineColumnAt(value, cursor).column;
  const lineAtCursor = visibleLines[cursorInViewLine] ?? "";
  const lineWithCursor = `${lineAtCursor.slice(0, cursorColumn)}█${lineAtCursor.slice(cursorColumn)}`;
  const renderedLines = visibleLines.map((line, index) => (index === cursorInViewLine ? lineWithCursor : line));
  const renderedValue = visibleLines
    .map((_, index) => renderedLines[index] ?? "")
    .join("\n");
  const showPlaceholder = value.length === 0 && Boolean(input.placeholder);
  const boxHeight = Math.max(1, Math.min(maxVisibleLines, lines.length));

  return (
    <Box flexDirection="column" width="100%">
      <Text color="cyan">[PLAN] {input.title}</Text>
      {input.hint ? <Text color="gray">{input.hint}</Text> : null}
      <Box marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1} minHeight={boxHeight + 2} width="100%">
        {showPlaceholder ? <Text color="gray">{input.placeholder}</Text> : <Text>{renderedValue}</Text>}
      </Box>
      <Text color="gray">Shift+Enter: newline, Enter: submit, Esc: cancel</Text>
    </Box>
  );
}

type ControlSequence = "left" | "right" | "up" | "down" | "shift_enter" | "other";

function parseControlSequence(rawInput: string): ControlSequence | null {
  if (!rawInput) {
    return null;
  }

  const noEsc = rawInput.startsWith("\x1b") ? rawInput.slice(1) : rawInput;
  const seq = noEsc.trim();

  if (seq === "[A") return "up";
  if (seq === "[B") return "down";
  if (seq === "[C") return "right";
  if (seq === "[D") return "left";
  if (seq === "[27;2;13~" || seq === "[13;2u") return "shift_enter";
  if (seq.startsWith("[") && /[~uABCD]$/.test(seq)) return "other";
  return null;
}

function isControlOnlyInput(rawInput: string | undefined): boolean {
  if (!rawInput) {
    return true;
  }

  if (rawInput === "\x00") {
    return true;
  }

  const seq = parseControlSequence(rawInput);
  return seq === "other";
}

function normalizePrintableInput(rawInput: string): string {
  return rawInput.replace(/\r/g, "").replace(/\x1b/g, "");
}

function insertAt(value: string, index: number, chunk: string): string {
  return `${value.slice(0, index)}${chunk}${value.slice(index)}`;
}

function removeAt(value: string, from: number, to: number): string {
  return `${value.slice(0, from)}${value.slice(to)}`;
}

function findLineColumnAt(value: string, index: number): { line: number; column: number } {
  const bounded = Math.max(0, Math.min(index, value.length));
  const before = value.slice(0, bounded);
  const parts = before.split("\n");
  return {
    line: parts.length - 1,
    column: parts.at(-1)?.length ?? 0
  };
}

function moveCursorVertical(value: string, index: number, direction: -1 | 1): number {
  const lines = value.split("\n");
  const { line, column } = findLineColumnAt(value, index);
  const targetLine = line + direction;

  if (targetLine < 0) {
    return 0;
  }
  if (targetLine >= lines.length) {
    return value.length;
  }

  let absolute = 0;
  for (let i = 0; i < targetLine; i += 1) {
    absolute += (lines[i]?.length ?? 0) + 1;
  }

  const targetColumn = Math.min(column, lines[targetLine]?.length ?? 0);
  return absolute + targetColumn;
}

function ChoicePrompt(input: {
  title: string;
  hint?: string;
  items: ChoiceItem[];
  onSelect: (value: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const defaultSelectedIndex = useMemo(() => {
    const recommended = input.items.findIndex((item) => item.recommended);
    return recommended >= 0 ? recommended : 0;
  }, [input.items]);
  const [selectedIndex, setSelectedIndex] = useState(defaultSelectedIndex);

  useEffect(() => {
    setSelectedIndex(defaultSelectedIndex);
  }, [defaultSelectedIndex]);

  useInput((rawInput, key) => {
    if (key.escape) {
      input.onCancel();
      return;
    }

    if (key.return) {
      const selected = input.items[selectedIndex];
      if (!selected) {
        return;
      }
      input.onSelect(selected.value);
      return;
    }

    const shortcutIndex = parseChoiceShortcut(rawInput);
    if (shortcutIndex !== null) {
      const target = input.items[shortcutIndex];
      if (!target) {
        return;
      }
      setSelectedIndex(shortcutIndex);
      input.onSelect(target.value);
      return;
    }

    const sequence = parseControlSequence(rawInput);
    if (sequence === "up") {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
      return;
    }
    if (sequence === "down") {
      setSelectedIndex((prev) => Math.min(input.items.length - 1, prev + 1));
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(input.items.length - 1, prev + 1));
    }
  });

  return (
    <Box flexDirection="column">
      <Text color="cyan">[PLAN] {input.title}</Text>
      {input.hint ? <Text color="gray">{input.hint}</Text> : null}
      {input.items.length === 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">No options available.</Text>
          <Text color="gray">Press Esc to cancel.</Text>
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        {input.items.map((item, index) => {
          const selected = index === selectedIndex;
          const label = `${item.label}${item.recommended ? " (recommended)" : ""}${item.description ? ` — ${item.description}` : ""}`;
          return (
            <Text key={`${item.value}-${index}`} color={selected ? "cyan" : undefined}>
              {selected ? "> " : "  "}
              {label}
            </Text>
          );
        })}
      </Box>
      <Text color="gray">Arrows/1-9 + Enter: choose, Esc: cancel</Text>
    </Box>
  );
}

function parseChoiceShortcut(rawInput: string): number | null {
  if (!rawInput || !/^[1-9]$/.test(rawInput)) {
    return null;
  }
  return Number(rawInput) - 1;
}
