import type { ProgressEvent } from "../progress/events.js";

export type LogLevel = "PHASE" | "INFO" | "WARN" | "ERROR" | "OK" | "TOOL" | "DEBUG";

export interface TerminalCapabilities {
  isTTY: boolean;
  supportsUnicode: boolean;
  supportsColor: boolean;
  supportsTrueColor: boolean;
  columns: number;
}

export type ConsoleLogStyle = "legacy" | "compact";

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  white: "\x1b[97m",
  gray: "\x1b[90m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  orange: "\x1b[38;5;208m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m"
};

const ansiPattern = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const LEADING_BULLET_RE = /^[•·●◦▪▫]\s*/u;
const HEADER_SEPARATOR_RE = /^-{8,}$/;
const MARKDOWN_BOLD_RE = /^\*\*.+\*\*$/;
const TREE_DETAIL_RE = /^[\s]*[└├│]/u;
const SHELL_COMMAND_RE = /^\/bin\/(?:zsh|bash|sh)\s+-lc\s+(.+?)\s+in\s+.+$/;

export interface ToolCompactFilterState {
  headerSeparators: number;
  seen: Set<string>;
  consecutiveCommandSummaries: number;
}

export function createToolCompactFilterState(): ToolCompactFilterState {
  return {
    headerSeparators: 0,
    seen: new Set<string>(),
    consecutiveCommandSummaries: 0
  };
}

export function detectTerminalCapabilities(noColor = false): TerminalCapabilities {
  const isTTY = Boolean(process.stdout.isTTY);
  const env = process.env;
  const term = (env.TERM ?? "").toLowerCase();
  const colorTerm = (env.COLORTERM ?? "").toLowerCase();
  const lang = (env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? "").toLowerCase();
  const unicodeEnv = (env.WT_SESSION ?? env.TERM_PROGRAM ?? "").toLowerCase();
  const supportsUnicode = /utf-?8/.test(lang) || Boolean(unicodeEnv);
  const supportsTrueColor = colorTerm.includes("truecolor") || colorTerm.includes("24bit") || term.includes("direct");
  const supportsColor = isTTY && !noColor && !("NO_COLOR" in env) && term !== "dumb";
  const columns = typeof process.stdout.columns === "number" && process.stdout.columns > 0 ? process.stdout.columns : 100;
  return {
    isTTY,
    supportsUnicode,
    supportsColor,
    supportsTrueColor,
    columns
  };
}

export function formatConsoleLogLine(input: {
  time: Date;
  level: LogLevel;
  message: string;
  caps: TerminalCapabilities;
  event?: ProgressEvent;
  style?: ConsoleLogStyle;
}): string {
  if (input.style === "compact") {
    return formatCompactConsoleLogLine(input);
  }

  const timestamp = `[${formatShortTime(input.time)}]`;
  const label = `[${input.level}]`;
  if (!input.caps.supportsColor) {
    return `${timestamp} ${label} ${input.message}`;
  }

  const labelTone = toneForLevel(input.level);
  const icon = iconForLevel(input.level, input.caps.supportsUnicode);
  const coloredLabel = `${colorize(`${icon} ${label}`, labelTone)}`;
  const coloredTs = colorize(timestamp, "gray");
  const renderedMessage = renderStyledMessage(input.level, input.message, input.caps, input.event);
  return `${coloredTs} ${coloredLabel} ${renderedMessage}`;
}

function formatCompactConsoleLogLine(input: {
  time: Date;
  level: LogLevel;
  message: string;
  caps: TerminalCapabilities;
  event?: ProgressEvent;
}): string {
  const timestamp = `[${formatShortTime(input.time)}]`;
  const compactMessage = toCompactConsoleMessage(input.message, input.event);

  if (!input.caps.supportsColor) {
    return `${timestamp} > ${compactMessage}`;
  }

  const color = compactToneFor(input.level, input.event);
  return `${colorize(timestamp, "gray")} ${colorize(`> ${compactMessage}`, color)}`;
}

export function renderSection(title: string, caps: TerminalCapabilities): string {
  const normalized = title.trim();
  if (!caps.supportsColor || !caps.supportsUnicode) {
    return `\n[${normalized}]\n`;
  }

  const inner = clamp(caps.columns - 2, 28, 110);
  const rule = "─".repeat(inner);
  const heading = `${ansi.bold}${ansi.magenta}${normalized}${ansi.reset}`;
  return `\n${ansi.gray}${rule}${ansi.reset}\n${heading}\n${ansi.gray}${rule}${ansi.reset}\n`;
}

export function renderPlanPreview(plan: string, caps: TerminalCapabilities): string {
  const trimmed = plan.trim();
  if (!caps.supportsColor || !caps.supportsUnicode) {
    return `\n--- Draft Plan ---\n${trimmed}\n--- End Draft ---\n\n`;
  }

  const inner = clamp(caps.columns - 4, 40, 116);
  const top = `${ansi.cyan}╭${"─".repeat(inner + 2)}╮${ansi.reset}`;
  const bottom = `${ansi.cyan}╰${"─".repeat(inner + 2)}╯${ansi.reset}`;
  const title = colorize(`${ansi.bold}Plan Preview${ansi.reset}`, "blue");
  const titleRow = boxRow(title, inner, caps);
  const spacer = boxRow("", inner, caps);

  const contentRows: string[] = [];
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const styled = stylePlanLine(rawLine, caps);
    for (const part of wrapAnsiAware(styled, inner)) {
      contentRows.push(boxRow(part, inner, caps));
    }
  }

  return `\n${top}\n${titleRow}\n${spacer}\n${contentRows.join("\n")}\n${bottom}\n\n`;
}

export function summarizeToolOutput(input: {
  totalLines: number;
  totalChars: number;
  preview: string[];
  denseLineThreshold?: number;
  denseCharThreshold?: number;
  previewLimit?: number;
}): { lines: string[] } {
  const denseLineThreshold = input.denseLineThreshold ?? 4;
  const denseCharThreshold = input.denseCharThreshold ?? 360;
  const previewLimit = clamp(input.previewLimit ?? 5, 1, 8);
  const preview = input.preview.slice(0, previewLimit);
  const dense = input.totalLines >= denseLineThreshold || input.totalChars >= denseCharThreshold;
  if (!dense) {
    return { lines: preview };
  }

  // In non-verbose mode we keep console output compact and gray by showing only
  // the preview lines; detailed tool output stays in --verbose and in run logs.
  return {
    lines: preview
  };
}

export function toToolOutputHeading(line: string): string {
  const visible = stripAnsi(line);
  const trimmed = visible.trimStart();
  if (!trimmed) {
    return line;
  }

  if (!LEADING_BULLET_RE.test(trimmed)) return line;
  const withoutBullet = trimmed.replace(LEADING_BULLET_RE, "").trim();
  return withoutBullet || line;
}

export function isToolActionLine(line: string): boolean {
  const visible = stripAnsi(line);
  const trimmed = visible.trimStart();
  return /^[•·●◦▪▫]\s+\S/u.test(trimmed);
}

export function extractToolProgressBullet(line: string): string | null {
  if (!isToolActionLine(line)) {
    return null;
  }
  const heading = toToolOutputHeading(line).trim();
  return heading.length > 0 ? heading : null;
}

export function selectCompactToolLine(line: string, state: ToolCompactFilterState): string | null {
  const visible = stripAnsi(line).trim();
  if (!visible) {
    return null;
  }

  if (shouldSuppressToolLine(visible)) {
    return null;
  }

  if (HEADER_SEPARATOR_RE.test(visible)) {
    state.consecutiveCommandSummaries = 0;
    state.headerSeparators += 1;
    if (state.headerSeparators <= 2) {
      return visible;
    }
    return null;
  }

  if (state.headerSeparators === 1) {
    state.consecutiveCommandSummaries = 0;
    return dedupeCompactLine(visible, state);
  }

  if (MARKDOWN_BOLD_RE.test(visible)) {
    state.consecutiveCommandSummaries = 0;
    return dedupeCompactLine(stripMarkdownBold(visible), state);
  }

  if (TREE_DETAIL_RE.test(visible)) {
    return null;
  }

  const actionHeading = toToolOutputHeading(visible);
  if (isToolActionLine(visible)) {
    state.consecutiveCommandSummaries = 0;
    return dedupeCompactLine(actionHeading, state);
  }

  const commandSummary = summarizeShellCommand(visible);
  if (commandSummary) {
    if (state.consecutiveCommandSummaries >= 2) {
      return null;
    }
    state.consecutiveCommandSummaries += 1;
    return dedupeCompactLine(commandSummary, state);
  }

  if (isNarrativeProgressLine(visible)) {
    state.consecutiveCommandSummaries = 0;
    return dedupeCompactLine(visible, state);
  }

  return null;
}

export function shouldSuppressToolLine(line: string): boolean {
  const normalized = line.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (normalized.includes("codex_core::skills::loader: failed to stat skills entry")) {
    return true;
  }

  if (normalized.includes("rmcp::transport::worker: worker quit with fatal")) {
    return true;
  }

  return false;
}

function dedupeCompactLine(line: string, state: ToolCompactFilterState): string | null {
  const key = line.replace(/\s+/g, " ").trim();
  if (!key) {
    return null;
  }
  if (state.seen.has(key)) {
    return null;
  }
  state.seen.add(key);
  return key;
}

function stripMarkdownBold(value: string): string {
  return value.replace(/\*\*(.*?)\*\*/g, "$1").trim();
}

function summarizeShellCommand(line: string): string | null {
  if (line === "exec" || line === "codex") {
    return null;
  }

  const match = line.match(SHELL_COMMAND_RE);
  if (!match) {
    return null;
  }

  const raw = match[1]?.trim();
  if (!raw) {
    return null;
  }

  const unwrapped =
    (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
      ? raw.slice(1, -1)
      : raw;
  return `Ran ${unwrapped}`;
}

function isNarrativeProgressLine(line: string): boolean {
  if (line.length < 28) {
    return false;
  }

  const words = line.trim().split(/\s+/);
  if (words.length < 5) {
    return false;
  }

  if (/^(?:[#>*`~|]|[-+*]\s|\d+\.\s)/.test(line)) {
    return false;
  }

  if (/^(?:\/|\\|\.{1,2}\/)/.test(line)) {
    return false;
  }

  if (line.includes(" in /") || line.includes("succeeded in ") || line.includes(" failed in ")) {
    return false;
  }

  if (/[{}[\]<>`]|=>|:=|==|===|&&|\|\||::|;\s*$/.test(line)) {
    return false;
  }

  if (/\b[A-Za-z_]\w*\s*\([^)]*\)\s*=>/.test(line)) {
    return false;
  }

  const symbolCount = (line.match(/[^\p{L}\p{N}\s.,!?'"():-]/gu) ?? []).length;
  const density = symbolCount / Math.max(1, line.length);
  if (density > 0.12) {
    return false;
  }

  const slashCount = (line.match(/\//g) ?? []).length;
  if (slashCount >= 3) {
    return false;
  }

  if (/^[\w.-]+$/.test(line)) {
    return false;
  }

  return /\p{L}/u.test(line);
}

export function truncateToWidth(text: string, width: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (width <= 0) {
    return "";
  }
  if (visibleLength(clean) <= width) {
    return clean;
  }
  if (width <= 3) {
    return ".".repeat(width);
  }
  return `${clean.slice(0, width - 3)}...`;
}

export function formatShortTime(input: Date): string {
  const hh = String(input.getHours()).padStart(2, "0");
  const mm = String(input.getMinutes()).padStart(2, "0");
  const ss = String(input.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function formatShortDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes > 0) {
    return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

export function clearCurrentTerminalLine(): void {
  process.stdout.write("\r\x1b[2K");
}

export function stripAnsi(value: string): string {
  return value.replace(ansiPattern, "");
}

function boxRow(content: string, inner: number, caps: TerminalCapabilities): string {
  const clipped = wrapAnsiAware(content, inner)[0] ?? "";
  const pad = Math.max(0, inner - visibleLength(clipped));
  return `${ansi.cyan}│${ansi.reset} ${clipped}${" ".repeat(pad)} ${ansi.cyan}│${ansi.reset}`;
}

function wrapAnsiAware(input: string, width: number): string[] {
  if (width <= 0) {
    return [""];
  }
  const stripped = stripAnsi(input);
  if (stripped.length <= width) {
    return [input];
  }

  const words = stripped.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [stripped.slice(0, width)];
  }

  const out: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= width) {
      line = candidate;
      continue;
    }
    if (line) {
      out.push(line);
    }
    line = word.length <= width ? word : `${word.slice(0, Math.max(0, width - 3))}...`;
  }
  if (line) {
    out.push(line);
  }
  return out;
}

function stylePlanLine(line: string, caps: TerminalCapabilities): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("# ")) {
    return `${ansi.bold}${ansi.cyan}${line}${ansi.reset}`;
  }
  if (trimmed.startsWith("## ")) {
    return `${ansi.bold}${ansi.yellow}${line}${ansi.reset}`;
  }
  if (trimmed.startsWith("### ")) {
    return `${ansi.bold}${ansi.green}${line}${ansi.reset}`;
  }
  if (/^- \[x\]\s+/i.test(trimmed)) {
    return `${ansi.green}${line.replace(/^- \[x\]\s+/i, "- [x] ")}${ansi.reset}`;
  }
  if (/^- \[\s\]\s+/.test(trimmed)) {
    return `${ansi.blue}${line}${ansi.reset}`;
  }
  return line;
}

function toneForLevel(level: LogLevel): "gray" | "cyan" | "green" | "yellow" | "orange" | "red" | "magenta" {
  if (level === "PHASE") {
    return "magenta";
  }
  if (level === "WARN") {
    return "orange";
  }
  if (level === "ERROR") {
    return "red";
  }
  if (level === "OK") {
    return "green";
  }
  if (level === "TOOL" || level === "DEBUG") {
    return "gray";
  }
  return "cyan";
}

function compactToneFor(
  level: LogLevel,
  event?: ProgressEvent
): "white" | "yellow" | "orange" | "red" {
  if (level === "ERROR") {
    return "red";
  }
  if (level === "WARN") {
    return "orange";
  }
  if (event?.actor === "codex") {
    return "yellow";
  }
  return "white";
}

export function toCompactConsoleMessage(message: string, event?: ProgressEvent): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "-";
  }

  if (event?.kind === "codex_request" && event.goal?.trim()) {
    return event.goal.trim();
  }
  if (event?.kind === "codex_result" && event.goal?.trim()) {
    return event.goal.trim();
  }
  if (event?.kind === "task_start" && event.goal?.trim()) {
    return event.goal.trim();
  }

  const strippedTask = normalized.match(/^task\s+\d+:\s+(.+)$/i)?.[1];
  if (strippedTask) {
    return strippedTask.trim();
  }

  const strippedReview = normalized.match(/^review\/[^:]+:\s+(.+)$/i)?.[1];
  if (strippedReview) {
    return strippedReview.trim();
  }

  const strippedCodex = normalized.match(/^\w[^:]*:\s+codex:\s+(.+)$/i)?.[1] ?? normalized.match(/^codex:\s+(.+)$/i)?.[1];
  if (strippedCodex) {
    return strippedCodex.trim();
  }

  return normalized;
}

function iconForLevel(level: LogLevel, unicode: boolean): string {
  if (!unicode) {
    return level === "ERROR" ? "!" : "*";
  }
  if (level === "PHASE") {
    return "◈";
  }
  if (level === "WARN") {
    return "▲";
  }
  if (level === "ERROR") {
    return "✖";
  }
  if (level === "OK") {
    return "✓";
  }
  if (level === "TOOL") {
    return "⋯";
  }
  if (level === "DEBUG") {
    return "·";
  }
  return "●";
}

function renderStyledMessage(level: LogLevel, message: string, caps: TerminalCapabilities, event?: ProgressEvent): string {
  if (level === "TOOL") {
    return colorize(message, "gray");
  }
  if (!caps.supportsColor) {
    return message;
  }
  if (level !== "INFO") {
    return message;
  }
  if (event?.actor === "codex" || /\bcodex\b/i.test(message)) {
    return colorize(message, "magenta");
  }
  if (event?.actor === "validation") {
    return colorize(message, "yellow");
  }
  if (event?.actor === "review") {
    return colorize(message, "blue");
  }
  if (event?.actor === "memory") {
    return colorize(message, "green");
  }
  return styleInfoMessage(message, caps);
}

function styleInfoMessage(message: string, caps: TerminalCapabilities): string {
  const arrow = caps.supportsUnicode ? "→" : "->";
  const withPrefix = message.replace(/^([a-z][\w/-]*:)\s/i, (_, prefix: string) => {
    return `${colorize(prefix, "magenta")} `;
  });
  const withPairs = withPrefix.replace(
    /\b([a-z][a-z0-9_-]*)=([^,\s)]+)/gi,
    (_match, key: string, value: string) => `${colorize(key, "blue")}=${colorize(value, "cyan")}`
  );
  const withRatios = withPairs.replace(
    /\b(\d+\/\d+)\b/g,
    (_match, ratio: string) => colorize(ratio, "green")
  );
  return withRatios.replace(/\s->\s/g, ` ${colorize(arrow, "gray")} `);
}

function colorize(
  value: string,
  tone: "white" | "gray" | "cyan" | "green" | "yellow" | "orange" | "red" | "magenta" | "blue"
): string {
  const code = ansi[tone];
  return `${code}${value}${ansi.reset}`;
}

function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}
