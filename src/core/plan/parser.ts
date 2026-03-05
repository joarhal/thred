import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PlanDocument, PlanTask } from "../../types.js";
import { ensureDir, exists } from "../util/fs.js";

const taskHeaderRe = /^###\s+Task\s+(\d+):\s+(.+)$/;
const checkboxRe = /^-\s+\[([ xX])\]\s+(.+)$/;
const overviewHeaderRe = /^##\s+Overview\s*$/i;
const validationHeaderRe = /^##\s+Validation Commands\s*$/i;
const planTitleRe = /^Plan:\s+.+$/;

export async function parsePlanFile(planPath: string): Promise<PlanDocument> {
  const content = await readFile(planPath, "utf8");
  return parsePlan(content, planPath);
}

export function parsePlan(content: string, planPath: string): PlanDocument {
  const lines = content.split(/\r?\n/);

  let title = "";
  const overviewLines: string[] = [];
  let hasOverviewSection = false;
  let hasValidationSection = false;
  let inOverview = false;
  let inValidation = false;
  const validationCommands: string[] = [];
  const tasks: PlanTask[] = [];
  let currentTask: PlanTask | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (line.startsWith("# ") && title === "") {
      title = line.slice(2).trim();
      continue;
    }

    if (overviewHeaderRe.test(line)) {
      if (hasOverviewSection) {
        throw new Error(`invalid plan ${planPath}: overview section appears more than once`);
      }
      if (hasValidationSection || currentTask) {
        throw new Error(`invalid plan ${planPath}: overview section must appear before validation and tasks`);
      }
      hasOverviewSection = true;
      inOverview = true;
      inValidation = false;
      continue;
    }

    if (validationHeaderRe.test(line)) {
      if (!hasOverviewSection) {
        throw new Error(`invalid plan ${planPath}: validation commands section must appear after overview`);
      }
      if (hasValidationSection) {
        throw new Error(`invalid plan ${planPath}: validation commands section appears more than once`);
      }
      if (currentTask) {
        throw new Error(`invalid plan ${planPath}: validation commands section must appear before tasks`);
      }
      hasValidationSection = true;
      inValidation = true;
      inOverview = false;
      continue;
    }

    if (line.startsWith("## ") && !validationHeaderRe.test(line) && !overviewHeaderRe.test(line)) {
      throw new Error(`invalid plan ${planPath}: unsupported section header '${trimmed}'`);
    }

    const taskHeader = line.match(taskHeaderRe);
    if (taskHeader) {
      if (!hasValidationSection) {
        throw new Error(`invalid plan ${planPath}: task sections must appear after validation commands section`);
      }
      inValidation = false;
      inOverview = false;
      if (currentTask) {
        tasks.push(currentTask);
      }
      const numberRaw = taskHeader[1];
      const titleRaw = taskHeader[2];
      if (!numberRaw || !titleRaw) {
        continue;
      }
      currentTask = {
        number: Number(numberRaw),
        title: titleRaw.trim(),
        items: []
      };
      continue;
    }

    if (inOverview) {
      if (trimmed) {
        overviewLines.push(line);
      }
      continue;
    }

    if (inValidation) {
      if (!trimmed) {
        continue;
      }
      const m = line.match(/^\s*-\s+`(.+)`\s*$/) ?? line.match(/^\s*-\s+(.+)\s*$/);
      const cmd = m?.[1]?.trim();
      if (cmd) {
        validationCommands.push(cmd);
        continue;
      }
      throw new Error(`invalid plan ${planPath}: validation commands must be bullet items`);
    }

    if (currentTask) {
      if (!trimmed) {
        continue;
      }
      const cb = line.match(checkboxRe);
      if (cb) {
        const checkedRaw = cb[1];
        const textRaw = cb[2];
        if (!checkedRaw || !textRaw) {
          continue;
        }
        currentTask.items.push({
          checked: checkedRaw.toLowerCase() === "x",
          text: textRaw.trim()
        });
        continue;
      }

      if (/^\s*-\s+/.test(line)) {
        throw new Error(`invalid plan ${planPath}: Task ${currentTask.number} contains non-checkbox bullet '${trimmed}'`);
      }
      throw new Error(`invalid plan ${planPath}: Task ${currentTask.number} contains non-checklist content '${trimmed}'`);
    }

    if (trimmed) {
      throw new Error(`invalid plan ${planPath}: unexpected content outside plan sections '${trimmed}'`);
    }
  }

  if (currentTask) {
    tasks.push(currentTask);
  }

  const overview = overviewLines.length > 0 ? overviewLines.join("\n") : undefined;

  validateParsedPlan({
    title,
    hasOverviewSection,
    overview,
    hasValidationSection,
    validationCommands,
    tasks,
    planPath
  });

  return {
    title,
    overview,
    validationCommands,
    tasks,
    path: planPath
  };
}

export function renderPlanMarkdown(plan: PlanDocument): string {
  const lines: string[] = [];
  lines.push(`# ${plan.title}`);
  lines.push("");

  lines.push("## Overview");
  if (plan.overview?.trim()) {
    lines.push(plan.overview.trimEnd());
  }
  lines.push("");

  lines.push("## Validation Commands");
  for (const command of plan.validationCommands) {
    lines.push(`- \`${command}\``);
  }
  lines.push("");

  for (const task of plan.tasks) {
    lines.push(`### Task ${task.number}: ${task.title}`);
    for (const item of task.items) {
      lines.push(`- [${item.checked ? "x" : " "}] ${item.text}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function normalizeMarkdownPlan(raw: string, planPath = "<normalized-plan>"): string {
  const trimmed = raw.trim();
  const markdownBody = extractMarkdownBody(trimmed);
  const planBlock = extractLastPlanBlock(markdownBody);
  const stripped = stripTrailingModelUsageFooter(planBlock);
  const renumbered = renumberTaskHeaders(stripped).trim();
  try {
    const parsed = parsePlan(renumbered, planPath);
    return renderPlanMarkdown(parsed).trim();
  } catch {
    return renumbered;
  }
}

export function normalizeValidationCommands(commands: string[]): string[] {
  return commands.map((command) => command.trim()).filter(Boolean);
}

export function getValidationCommandMismatchReason(actual: string[], expected: string[]): string | null {
  const normalizedActual = normalizeValidationCommands(actual);
  const normalizedExpected = normalizeValidationCommands(expected);

  if (normalizedActual.length !== normalizedExpected.length) {
    return `Expected ${normalizedExpected.length} command(s), got ${normalizedActual.length}`;
  }

  for (let index = 0; index < normalizedExpected.length; index += 1) {
    const expectedCommand = normalizedExpected[index];
    const actualCommand = normalizedActual[index];
    if (actualCommand !== expectedCommand) {
      return `Command ${index + 1} must be '${expectedCommand}', got '${actualCommand ?? ""}'`;
    }
  }

  return null;
}

function validateParsedPlan(input: {
  title: string;
  hasOverviewSection: boolean;
  overview?: string;
  hasValidationSection: boolean;
  validationCommands: string[];
  tasks: PlanTask[];
  planPath: string;
}): void {
  if (!input.title) {
    throw new Error(`invalid plan ${input.planPath}: missing top-level title (# ...)`);
  }
  if (!planTitleRe.test(input.title)) {
    throw new Error(`invalid plan ${input.planPath}: title must start with 'Plan:'`);
  }
  if (!input.hasOverviewSection) {
    throw new Error(`invalid plan ${input.planPath}: missing overview section`);
  }
  if (!input.overview?.trim()) {
    throw new Error(`invalid plan ${input.planPath}: overview section must not be empty`);
  }
  if (!input.hasValidationSection) {
    throw new Error(`invalid plan ${input.planPath}: missing validation commands section`);
  }
  if (input.validationCommands.length === 0) {
    throw new Error(`invalid plan ${input.planPath}: validation commands section must include at least one command`);
  }
  if (input.tasks.length === 0) {
    throw new Error(`invalid plan ${input.planPath}: no task sections found`);
  }

  let expected = 1;
  for (const task of input.tasks) {
    if (task.number !== expected) {
      throw new Error(`invalid plan ${input.planPath}: expected Task ${expected}, got Task ${task.number}`);
    }
    if (task.items.length === 0) {
      throw new Error(`invalid plan ${input.planPath}: Task ${task.number} has no checklist items`);
    }
    expected += 1;
  }
}

function extractMarkdownBody(input: string): string {
  const fenceRe = /```(?:md|markdown)?\n([\s\S]*?)```/gi;
  let chosen = "";
  let match: RegExpExecArray | null = null;

  while ((match = fenceRe.exec(input))) {
    const candidate = match[1]?.trim();
    if (candidate && /^#\s+Plan:/m.test(candidate)) {
      chosen = candidate;
    }
  }

  return chosen || input;
}

function extractLastPlanBlock(input: string): string {
  const lines = input.split(/\r?\n/);
  let lastPlanStart = -1;

  for (let i = 0; i < lines.length; i += 1) {
    if (/^#\s+Plan:\s+.+/.test(lines[i] ?? "")) {
      lastPlanStart = i;
    }
  }

  if (lastPlanStart < 0) {
    return input;
  }

  return lines.slice(lastPlanStart).join("\n");
}

function renumberTaskHeaders(input: string): string {
  const lines = input.split(/\r?\n/);
  let taskNumber = 1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const header = line.match(/^###\s+Task\s+\d+:\s+(.+)$/);
    if (!header || !header[1]) {
      continue;
    }
    lines[i] = `### Task ${taskNumber}: ${header[1]}`;
    taskNumber += 1;
  }

  return lines.join("\n");
}

function stripTrailingModelUsageFooter(input: string): string {
  const lines = input.split(/\r?\n/);
  let index = lines.length - 1;
  while (index >= 0 && (lines[index]?.trim() ?? "") === "") {
    index -= 1;
  }
  if (index < 0) {
    return input;
  }

  if (!isModelUsageFooterLine(lines[index]?.trim() ?? "")) {
    return input;
  }

  while (index >= 0) {
    const trimmed = lines[index]?.trim() ?? "";
    if (trimmed === "" || isModelUsageFooterLine(trimmed)) {
      index -= 1;
      continue;
    }
    break;
  }

  return lines.slice(0, Math.max(0, index + 1)).join("\n");
}

function isModelUsageFooterLine(line: string): boolean {
  if (!line) {
    return false;
  }
  if (/^[\d,\s]+$/.test(line)) {
    return true;
  }
  return (
    /^tokens?\s+used\b/i.test(line) ||
    /^(input|output|total|prompt|completion|reasoning|cached?)\s+tokens?\b/i.test(line) ||
    /^(tokens?|usage)\s*[:=]/i.test(line)
  );
}

export function nextPendingTask(plan: PlanDocument): PlanTask | undefined {
  return plan.tasks.find((task) => task.items.some((item) => !item.checked));
}

export async function markTaskDone(planPath: string, taskNumber: number): Promise<void> {
  const content = await readFile(planPath, "utf8");
  const lines = content.split(/\r?\n/);

  let inTarget = false;
  let foundTask = false;
  const updated = lines.map((line) => {
    const header = line.match(taskHeaderRe);
    if (header) {
      inTarget = Number(header[1]) === taskNumber;
      if (inTarget) {
        foundTask = true;
      }
      return line;
    }

    if (inTarget) {
      return line.replace(/^-\s+\[ \]\s+/, "- [x] ");
    }

    return line;
  });

  if (!foundTask) {
    throw new Error(`Task ${taskNumber} not found in ${planPath}`);
  }

  const nextContent = `${updated.join("\n")}\n`;
  await writeFile(planPath, nextContent, "utf8");
}

export async function movePlanToCompleted(planPath: string): Promise<string> {
  const dir = path.dirname(planPath);
  const completedDir = path.join(dir, "completed");
  await ensureDir(completedDir);
  const targetPath = path.join(completedDir, path.basename(planPath));

  if (!(await exists(planPath)) && (await exists(targetPath))) {
    return targetPath;
  }

  await rename(planPath, targetPath);
  return targetPath;
}

export function branchNameFromPlanPath(planPath: string): string {
  const base = path.basename(planPath, path.extname(planPath));
  const withoutDate = base.replace(/^[\d-]+/, "").replace(/^-+/, "");
  return withoutDate || base;
}
