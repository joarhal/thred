import path from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Finding, PlanDocument, PlanTask } from "../../types.js";
import { renderPromptTemplate } from "./prompt-templates.js";
import reviewFixTemplate from "./prompts/review-fix.md";
import reviewMultiAgentTemplate from "./prompts/review-multi-agent.md";
import taskTemplate from "./prompts/task.md";
import validationFixTemplate from "./prompts/validation-fix.md";

const REVIEW_SCHEMA =
  '{"overallStatus":"clean|issues_found","findings":[{"id":"...","severity":"critical|high|medium|low","file":"...","line":1,"summary":"...","rationale":"...","suggestedFix":"..."}]}';
type ReviewSeverity = "critical" | "high" | "medium" | "low";
const PROJECT_REVIEW_AGENTS_DIRNAME = "thred.review-agents";
const REVIEW_AGENT_PROMPTS_DIR = resolveReviewAgentPromptsDir();

interface ReviewAgentPrompt {
  name: string;
  prompt: string;
}

export function buildTaskPrompt(plan: PlanDocument, task: PlanTask, memoryContext?: string): string {
  const validationCommands = plan.validationCommands.map((cmd) => `- ${cmd}`).join("\n");
  const taskItems = task.items.filter((i) => !i.checked).map((i) => `- ${i.text}`).join("\n");
  const memorySection = memoryContext ? `\nSession memory:\n${memoryContext.trimEnd()}\n` : "\n";

  return renderPromptTemplate(taskTemplate, {
    planTitle: plan.title,
    taskNumber: String(task.number),
    taskTitle: task.title,
    taskItems,
    validationCommands,
    memorySection
  });
}

export function buildValidationFixPrompt(
  plan: PlanDocument,
  task: PlanTask,
  validationOutput: string,
  memoryContext?: string
): string {
  const validationCommands = plan.validationCommands.map((cmd) => `- ${cmd}`).join("\n");
  const memorySection = memoryContext ? `\nSession memory:\n${memoryContext.trimEnd()}\n` : "\n";
  return renderPromptTemplate(validationFixTemplate, {
    taskNumber: String(task.number),
    taskTitle: task.title,
    validationOutput,
    validationCommands,
    memorySection
  });
}

export function buildReviewPrompt(
  baseRef: string,
  planPath: string,
  options?: {
    isGit?: boolean;
  }
): string {
  return buildReviewPromptMultiAgent(baseRef, planPath, options);
}

export function buildReviewPromptMultiAgent(
  baseRef: string,
  planPath: string,
  options?: {
    isGit?: boolean;
  }
): string {
  return buildReviewPromptMultiAgentFocused(baseRef, planPath, ["critical", "high", "medium", "low"], options);
}

export function buildReviewPromptMultiAgentFocused(
  baseRef: string,
  planPath: string,
  severities: ReviewSeverity[] = ["critical", "high", "medium", "low"],
  options?: {
    isGit?: boolean;
    cwd?: string;
    agentNames?: string[];
  }
): string {
  const focusInstruction = buildSeverityFocusInstruction(severities);
  const gitContextSection = buildReviewGitContextInstruction(baseRef, options?.isGit ?? true);
  const reviewAgents = loadReviewAgentPrompts(options?.agentNames, options?.cwd);
  const reviewAgentsInstruction = reviewAgents
    .map((agent) => `- Agent ${agent.name}:\n${indentReviewAgentPrompt(agent.prompt)}`)
    .join("\n");

  return renderPromptTemplate(reviewMultiAgentTemplate, {
    agentCount: String(reviewAgents.length),
    baseRef,
    planPath,
    gitContextSection,
    reviewAgentsInstruction,
    focusInstruction,
    reviewSchema: REVIEW_SCHEMA
  });
}

export function buildReviewFixPrompt(findings: Finding[], validationCommands: string[]): string {
  return renderPromptTemplate(reviewFixTemplate, {
    findingsJson: JSON.stringify(findings, null, 2),
    validationCommands: validationCommands.map((cmd) => `- ${cmd}`).join("\n")
  });
}

function buildSeverityFocusInstruction(severities: ReviewSeverity[]): string {
  const unique = Array.from(new Set(severities));
  if (unique.length === 0 || unique.length === 4) {
    return "- Include findings across all severities when relevant.";
  }
  return `- Focus primarily on ${unique.join("+")} findings; do not report lower-severity noise.`;
}

function buildReviewGitContextInstruction(baseRef: string, isGit: boolean): string {
  if (!isGit) {
    return [
      "- Git is unavailable in this run. Do not run git commands.",
      "- Inspect the working tree files directly and infer changed areas from current project files and plan context."
    ].join("\n");
  }

  return [
    `- Run: git log ${baseRef}..HEAD --oneline`,
    `- Run: git diff ${baseRef}...HEAD`,
    `- Run: git diff --stat ${baseRef}...HEAD`
  ].join("\n");
}

function loadReviewAgentPrompts(requestedAgentNames?: string[], cwd?: string): ReviewAgentPrompt[] {
  const projectAgentsDir = cwd ? path.join(cwd, PROJECT_REVIEW_AGENTS_DIRNAME) : undefined;
  const mergedAgents = {
    ...readAgentPromptsFromDir(REVIEW_AGENT_PROMPTS_DIR),
    ...(projectAgentsDir ? readAgentPromptsFromDir(projectAgentsDir) : {})
  };

  const availableAgentIds = Object.keys(mergedAgents).sort((a, b) => a.localeCompare(b, "en"));
  if (availableAgentIds.length === 0) {
    throw new Error(
      `review prompt generation failed: no agent files found in built-in dir (${REVIEW_AGENT_PROMPTS_DIR}) or project dir (${projectAgentsDir ?? "n/a"})`
    );
  }

  const selectedAgentIds = requestedAgentNames?.length
    ? requestedAgentNames.map((name) => name.trim())
    : availableAgentIds;

  const selectedAgents: ReviewAgentPrompt[] = [];
  for (const agentId of selectedAgentIds) {
    const prompt = mergedAgents[agentId];
    if (!prompt) {
      throw new Error(
        `review prompt generation failed: unknown agent "${agentId}". Available agents: ${availableAgentIds.join(", ")}`
      );
    }
    selectedAgents.push({
      name: agentId.replace(/[-_]+/g, " "),
      prompt
    });
  }

  return selectedAgents;
}

function readAgentPromptsFromDir(dirPath: string): Record<string, string> {
  if (!existsSync(dirPath)) {
    return {};
  }

  const files = readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "en"));

  const agents: Record<string, string> = {};
  for (const fileName of files) {
    const agentId = fileName.replace(/\.md$/i, "");
    const prompt = normalizeReviewAgentDescription(readFileSync(path.join(dirPath, fileName), "utf8"));
    if (!prompt) {
      throw new Error(`review prompt generation failed: empty agent description in ${path.join(dirPath, fileName)}`);
    }
    agents[agentId] = prompt;
  }
  return agents;
}

function normalizeReviewAgentDescription(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function indentReviewAgentPrompt(prompt: string): string {
  return prompt
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function resolveReviewAgentPromptsDir(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates: string[] = [
    path.join(moduleDir, "prompts", "review-agents"),
    path.join(moduleDir, "..", "src", "core", "codex", "prompts", "review-agents")
  ];

  for (const dir of candidates) {
    if (existsSync(dir)) {
      return dir;
    }
  }

  return candidates[0] ?? path.join(moduleDir, "prompts", "review-agents");
}
