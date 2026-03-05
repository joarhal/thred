export type Phase = "preflight" | "tasks" | "review" | "memory" | "finalize";
export type RunStatus = "running" | "failed" | "completed" | "interrupted";

export interface TaskItem {
  text: string;
  checked: boolean;
}

export interface PlanTask {
  number: number;
  title: string;
  items: TaskItem[];
}

export interface PlanDocument {
  title: string;
  overview?: string;
  validationCommands: string[];
  tasks: PlanTask[];
  path: string;
}

export interface Finding {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  line: number;
  summary: string;
  rationale: string;
  suggestedFix?: string;
}

export interface ReviewResult {
  overallStatus: "clean" | "issues_found";
  findings: Finding[];
}

export interface ReviewSeveritySummary {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export interface ReviewRunSummary {
  gate: "critical+high";
  status: "clean" | "warnings" | "failed";
  stopReason: string;
  findings: ReviewSeveritySummary;
}

export interface RunStats {
  commits: number;
  files: number;
  additions: number;
  deletions: number;
}

export interface RunState {
  runId: string;
  planPath: string;
  branch: string;
  phase: Phase;
  currentTask?: number;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  stats?: RunStats;
  review?: ReviewRunSummary;
}

export interface CodexConfig {
  command: string;
  model?: string;
  reasoningEffort: "low" | "medium" | "high" | "xhigh";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  skipGitRepoCheck?: boolean;
}

export interface RunOptions {
  planPath: string;
  isGit: boolean;
  baseBranch?: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  memoryContext?: string;
  maxTaskRetries: number;
  maxReviewIterations: number;
  maxExternalIterations: number;
  reviewPatience: number;
  waitOnLimitMs: number;
  noColor: boolean;
}
