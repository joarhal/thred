import type { Phase } from "../../types.js";
import type { LogLevel } from "../ui/terminal.js";

export type ProgressPhase = Phase | "input" | "plan" | "unknown";

export type ProgressEventKind =
  | "phase_start"
  | "task_start"
  | "task_end"
  | "codex_request"
  | "codex_result"
  | "validation_start"
  | "validation_result"
  | "review_loop_start"
  | "review_loop_result"
  | "warning"
  | "error"
  | "summary"
  | "info"
  | "tool_output";

export type ProgressActor = "system" | "codex" | "validation" | "review" | "memory" | "git" | "tool";

export interface ProgressEvent {
  schemaVersion: 1;
  id: string;
  runId: string;
  time: string;
  level: LogLevel;
  phase: ProgressPhase;
  kind: ProgressEventKind;
  actor: ProgressActor;
  taskNumber?: number;
  attempt?: { current: number; total: number };
  goal?: string;
  message: string;
  metrics?: Record<string, number | string | boolean>;
}

export interface LegacyLogEntry {
  time: Date;
  level: LogLevel;
  message: string;
}

export function createEventFromLegacyLog(input: {
  runId: string;
  level: LogLevel;
  message: string;
  time?: Date;
}): ProgressEvent {
  const time = input.time ?? new Date();
  const normalized = input.message.replace(/\s+/g, " ").trim();
  const phase = inferPhase(input.level, normalized);
  const actor = inferActor(input.level, normalized);
  const kind = inferKind(input.level, normalized);
  const taskNumber = inferTaskNumber(normalized);
  const attempt = inferAttempt(normalized);
  const goal = inferGoal(kind, normalized);

  return {
    schemaVersion: 1,
    id: `${time.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    runId: input.runId,
    time: time.toISOString(),
    level: input.level,
    phase,
    kind,
    actor,
    taskNumber,
    attempt,
    goal,
    message: input.message
  };
}

export function toLegacyLogEntry(event: ProgressEvent): LegacyLogEntry {
  return {
    time: new Date(event.time),
    level: event.level,
    message: event.message
  };
}

function inferPhase(level: LogLevel, message: string): ProgressPhase {
  if (level === "PHASE") {
    return toKnownPhase(message);
  }
  const lower = message.toLowerCase();
  if (lower.startsWith("review")) return "review";
  if (lower.startsWith("memory")) return "memory";
  if (lower.startsWith("task ") || lower.includes("running task")) return "tasks";
  if (lower.startsWith("preflight")) return "preflight";
  if (lower.startsWith("final")) return "finalize";
  return "unknown";
}

function toKnownPhase(raw: string): ProgressPhase {
  const normalized = raw.toLowerCase();
  if (normalized === "input") return "input";
  if (normalized === "plan") return "plan";
  if (normalized === "preflight") return "preflight";
  if (normalized === "tasks") return "tasks";
  if (normalized === "review") return "review";
  if (normalized === "memory") return "memory";
  if (normalized === "finalize") return "finalize";
  return "unknown";
}

function inferActor(level: LogLevel, message: string): ProgressActor {
  if (level === "TOOL") return "tool";
  const lower = message.toLowerCase();
  if (lower.includes("codex")) return "codex";
  if (lower.includes("validate")) return "validation";
  if (lower.startsWith("review")) return "review";
  if (lower.startsWith("memory")) return "memory";
  if (lower.includes("git") || lower.includes("branch") || lower.includes("commit")) return "git";
  return "system";
}

function inferKind(level: LogLevel, message: string): ProgressEventKind {
  if (level === "PHASE") return "phase_start";
  if (level === "TOOL") return "tool_output";
  if (level === "WARN") return "warning";
  if (level === "ERROR") return "error";
  if (level === "OK") return "summary";

  const lower = message.toLowerCase();
  if (lower.startsWith("running task ")) return "task_start";
  if (/^task \d+: codex request \d+\/\d+ - /i.test(message)) return "codex_request";
  if (/\bcodex request\b/i.test(message)) return "codex_request";
  if (/^task \d+: codex:/i.test(message)) return "codex_result";
  if (/\bcodex:\s+/i.test(message)) return "codex_result";
  if (/^task \d+: running validations \(\d+ commands\)$/i.test(message)) return "validation_start";
  if (/:\s*running validations \(\d+ commands\)$/i.test(message)) return "validation_start";
  if (/^task \d+: validate \d+\/\d+ (passed|failed)/i.test(message)) return "validation_result";
  if (/:\s*validate \d+\/\d+ (passed|failed)/i.test(message)) return "validation_result";
  if (/^task \d+ validated$/i.test(message)) return "task_end";
  if (/^review\/[^:]+: iteration \d+\/\d+ - fix \d+ findings/i.test(message)) return "review_loop_start";
  if (/^review\/[^:]+: findings /i.test(message)) return "review_loop_result";
  return "info";
}

function inferTaskNumber(message: string): number | undefined {
  const running = message.match(/^running Task (\d+):/i);
  if (running?.[1]) {
    return Number(running[1]);
  }
  const scoped = message.match(/^task (\d+):/i);
  if (scoped?.[1]) {
    return Number(scoped[1]);
  }
  return undefined;
}

function inferAttempt(message: string): { current: number; total: number } | undefined {
  const match = message.match(/\b(\d+)\/(\d+)\b/);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  const current = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isFinite(current) || !Number.isFinite(total)) {
    return undefined;
  }
  return { current, total };
}

function inferGoal(kind: ProgressEventKind, message: string): string | undefined {
  if (kind === "task_start") {
    const running = message.match(/^running Task \d+:\s+(.+)$/i);
    return running?.[1]?.trim();
  }
  if (kind === "codex_request") {
    const req = message.match(/(?:^task \d+: |^review\/[^:]+:\s+)?codex request(?: \d+\/\d+)? - (.+)$/i);
    return req?.[1]?.trim();
  }
  if (kind === "codex_result") {
    const result = message.match(/\bcodex:\s+(.+)$/i);
    return result?.[1]?.trim();
  }
  if (kind === "validation_start") {
    return "run validation commands";
  }
  if (kind === "review_loop_start") {
    const review = message.match(/^review\/([^:]+): iteration (\d+)\/(\d+) - (.+)$/i);
    if (review?.[4]) {
      return review[4].trim();
    }
  }
  return undefined;
}
