import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Finding, ReviewRunSummary, ReviewSeveritySummary } from "../../types.js";
import { ensureDir, exists } from "../util/fs.js";

export interface ReviewLoopReport {
  name: string;
  iterations: number;
  stopReason: string;
  findings: ReviewSeveritySummary;
}

export interface ReviewReport {
  generatedAt: string;
  baseBranch: string;
  planPath: string;
  gate: "critical+high";
  status: ReviewRunSummary["status"];
  stopReason: string;
  loops: ReviewLoopReport[];
  findings: Finding[];
  mandatoryBacklog: Finding[];
}

export async function writeReviewReport(runDir: string, runId: string, report: ReviewReport): Promise<string> {
  await ensureDir(runDir);
  const reportPath = path.join(runDir, `${runId}.review.json`);
  const mandatoryBacklog = report.mandatoryBacklog.length > 0
    ? report.mandatoryBacklog
    : selectMandatoryBacklogFindings(report.findings);
  await writeFile(
    reportPath,
    `${JSON.stringify({ ...report, mandatoryBacklog }, null, 2)}\n`,
    "utf8"
  );
  return reportPath;
}

const AUTO_BACKLOG_START = "<!-- thred:auto-medium-low:start -->";
const AUTO_BACKLOG_END = "<!-- thred:auto-medium-low:end -->";
const RELEASE_STABILITY_BACKLOG_PATH = path.join("docs", "release", "stability-backlog.md");
const BACKLOG_LOCK_RETRY_MS = 50;
const BACKLOG_LOCK_TIMEOUT_MS = 5000;
const BACKLOG_STALE_LOCK_MS = 30000;
const BACKLOG_LOCK_SUFFIX = ".lock";

type BacklogEntryStatus = "open" | "resolved";

interface MandatoryBacklogEntry extends Finding {
  status: BacklogEntryStatus;
}

export async function writeMandatoryStabilityBacklog(
  cwd: string,
  input: {
    runId: string;
    findings: Finding[];
    generatedAt?: string;
    resolvedFindingIds?: string[];
    resolvedFindingKeys?: string[];
  }
): Promise<{ path: string; count: number; updated: boolean }> {
  const findings = selectMandatoryBacklogFindings(input.findings);
  const backlogPath = path.join(cwd, RELEASE_STABILITY_BACKLOG_PATH);
  return withBacklogLock(backlogPath, async () => {
    const backlogExists = await exists(backlogPath);
    if (!backlogExists && findings.length === 0) {
      return { path: backlogPath, count: 0, updated: false };
    }

    const baseContent = backlogExists
      ? await readFile(backlogPath, "utf8")
      : await readExistingBacklogOrDefault(backlogPath);
    const hasManagedBlock = baseContent.includes(AUTO_BACKLOG_START) && baseContent.includes(AUTO_BACKLOG_END);
    const existingEntries = parseManagedBacklogEntries(baseContent);
    const resolvedKeys = new Set(input.resolvedFindingKeys ?? []);
    const resolvedIds = new Set(input.resolvedFindingIds ?? []);
    const mergedEntries = mergeMandatoryBacklogEntries(existingEntries, findings, resolvedKeys, resolvedIds);
    const openCount = mergedEntries.filter((entry) => entry.status === "open").length;
    const section = mergedEntries.length > 0 ? renderMandatoryBacklogSection(mergedEntries) : "";
    const nextContent = mergedEntries.length > 0
      ? upsertManagedBacklogSection(baseContent, section, hasManagedBlock)
      : hasManagedBlock
        ? removeManagedBacklogSection(baseContent)
        : baseContent;

    if (nextContent === baseContent) {
      return { path: backlogPath, count: openCount, updated: false };
    }

    await ensureDir(path.dirname(backlogPath));
    await atomicWriteFile(backlogPath, `${nextContent.trimEnd()}\n`);
    return { path: backlogPath, count: openCount, updated: true };
  });
}

function selectMandatoryBacklogFindings(findings: Finding[]): Finding[] {
  return findings
    .filter((finding) => finding.severity === "medium" || finding.severity === "low")
    .sort((a, b) => {
      const severityRank = a.severity === b.severity ? 0 : a.severity === "medium" ? -1 : 1;
      if (severityRank !== 0) {
        return severityRank;
      }
      const id = a.id.localeCompare(b.id);
      if (id !== 0) {
        return id;
      }
      const file = a.file.localeCompare(b.file);
      if (file !== 0) {
        return file;
      }
      return a.line - b.line;
    });
}

async function readExistingBacklogOrDefault(backlogPath: string): Promise<string> {
  if (await exists(backlogPath)) {
    return readFile(backlogPath, "utf8");
  }

  return [
    "# Stability Backlog",
    "",
    "## Triage Rules",
    "",
    "- `critical` / `high`: release blockers; must be fixed before release tagging.",
    "- `medium` / `low`: mandatory backlog; cannot be dropped, but can be scheduled after blocker closure."
  ].join("\n");
}

function renderMandatoryBacklogSection(entries: MandatoryBacklogEntry[]): string {
  const rows = entries.map((entry) => {
    const finding = entry;
    const fileLine = `${finding.file}:${finding.line}`;
    return `| ${escapeCell(finding.id)} | ${finding.severity} | \`${escapeCell(fileLine)}\` | ${escapeCell(finding.summary)} | ${escapeCell(finding.rationale)} | ${entry.status} |`;
  });

  return [
    "## Automated Mandatory Backlog (`medium` / `low`)",
    "",
    "Generated automatically from mandatory review findings.",
    "Entries are preserved until explicitly marked as resolved.",
    "",
    "| ID | Severity | File:Line | Summary | Rationale | Status |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows
  ].join("\n");
}

function parseManagedBacklogEntries(content: string): MandatoryBacklogEntry[] {
  const block = extractManagedBacklogBlock(content);
  if (!block) {
    return [];
  }

  const rows = block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"));

  const entries: MandatoryBacklogEntry[] = [];
  for (const row of rows) {
    const cells = splitMarkdownTableRow(row);
    if (cells.length < 5 || isTableHeaderOrSeparator(cells)) {
      continue;
    }

    const id = unescapeCell(cells[0] ?? "");
    const severity = unescapeCell(cells[1] ?? "");
    const fileLineCell = stripMarkdownCodeTicks(unescapeCell(cells[2] ?? ""));
    const fileLineMatch = fileLineCell.match(/^(.*):(\d+)$/);
    const summary = unescapeCell(cells[3] ?? "");
    const rationale = unescapeCell(cells[4] ?? "");
    const statusCell = unescapeCell(cells[5] ?? "").toLowerCase();

    if (!id || !fileLineMatch || (severity !== "medium" && severity !== "low")) {
      continue;
    }
    const parsedSeverity: "medium" | "low" = severity;

    const file = fileLineMatch[1]?.trim();
    const line = Number.parseInt(fileLineMatch[2] ?? "", 10);
    if (!file || Number.isNaN(line)) {
      continue;
    }

    entries.push({
      id,
      severity: parsedSeverity,
      file,
      line,
      summary,
      rationale,
      status: statusCell === "resolved" ? "resolved" : "open"
    });
  }

  return sortBacklogEntries(entries);
}

function mergeMandatoryBacklogEntries(
  existingEntries: MandatoryBacklogEntry[],
  currentFindings: Finding[],
  resolvedKeys: Set<string>,
  resolvedIds: Set<string>
): MandatoryBacklogEntry[] {
  const merged = new Map<string, MandatoryBacklogEntry>();
  for (const entry of existingEntries) {
    merged.set(findingIdentity(entry), entry);
  }

  for (const finding of currentFindings) {
    merged.set(findingIdentity(finding), { ...finding, status: "open" });
  }

  for (const [key, entry] of merged.entries()) {
    if (resolvedKeys.has(key) || resolvedIds.has(entry.id)) {
      merged.set(key, { ...entry, status: "resolved" });
    }
  }

  return sortBacklogEntries([...merged.values()]);
}

function sortBacklogEntries(entries: MandatoryBacklogEntry[]): MandatoryBacklogEntry[] {
  return [...entries].sort((a, b) => {
    const statusRank = statusPriority(a.status) - statusPriority(b.status);
    if (statusRank !== 0) {
      return statusRank;
    }

    const severityRank = a.severity === b.severity ? 0 : a.severity === "medium" ? -1 : 1;
    if (severityRank !== 0) {
      return severityRank;
    }
    const id = a.id.localeCompare(b.id);
    if (id !== 0) {
      return id;
    }
    const file = a.file.localeCompare(b.file);
    if (file !== 0) {
      return file;
    }
    return a.line - b.line;
  });
}

function statusPriority(status: BacklogEntryStatus): number {
  return status === "open" ? 0 : 1;
}

function findingIdentity(finding: Pick<Finding, "id" | "file" | "line">): string {
  return `${finding.id}::${finding.file}::${finding.line}`;
}

function extractManagedBacklogBlock(content: string): string | null {
  const match = content.match(new RegExp(
    `${escapeForRegExp(AUTO_BACKLOG_START)}\\n?([\\s\\S]*?)\\n?${escapeForRegExp(AUTO_BACKLOG_END)}`
  ));
  return match?.[1]?.trim() ?? null;
}

function upsertManagedBacklogSection(baseContent: string, section: string, hasManagedBlock: boolean): string {
  const managedBlock = `${AUTO_BACKLOG_START}\n${section}\n${AUTO_BACKLOG_END}`;
  const managedBlockPattern = new RegExp(
    `${escapeForRegExp(AUTO_BACKLOG_START)}[\\s\\S]*?${escapeForRegExp(AUTO_BACKLOG_END)}`,
    "g"
  );
  return hasManagedBlock
    ? baseContent.replace(managedBlockPattern, managedBlock)
    : `${baseContent.trimEnd()}\n\n${managedBlock}\n`;
}

function removeManagedBacklogSection(baseContent: string): string {
  const managedBlockPattern = new RegExp(
    `\\n*${escapeForRegExp(AUTO_BACKLOG_START)}[\\s\\S]*?${escapeForRegExp(AUTO_BACKLOG_END)}\\n*`,
    "g"
  );
  const withoutManagedBlock = baseContent.replace(managedBlockPattern, "\n\n");
  return withoutManagedBlock.replace(/\n{3,}/g, "\n\n").trimEnd();
}

function splitMarkdownTableRow(row: string): string[] {
  const cells: string[] = [];
  let current = "";
  const normalized = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const previous = index > 0 ? normalized[index - 1] : "";
    if (char === "|" && previous !== "\\") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function isTableHeaderOrSeparator(cells: string[]): boolean {
  const first = (cells[0] ?? "").trim().toLowerCase();
  if (first === "id" || first === "---") {
    return true;
  }
  return cells.every((cell) => /^:?-+:?$/.test(cell.replace(/\s+/g, "")));
}

function stripMarkdownCodeTicks(value: string): string {
  return value.replace(/^`/, "").replace(/`$/, "").trim();
}

function unescapeCell(value: string): string {
  return value.replace(/\\\|/g, "|").trim();
}

async function withBacklogLock<T>(backlogPath: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${backlogPath}${BACKLOG_LOCK_SUFFIX}`;
  const timeoutAt = Date.now() + BACKLOG_LOCK_TIMEOUT_MS;
  await ensureDir(path.dirname(lockPath));

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf8");
      await handle.close();
      break;
    } catch (error) {
      if (!isErrorWithCode(error) || error.code !== "EEXIST") {
        throw wrapReviewReportError(
          "mandatory backlog lock acquisition failed",
          `lockPath=${lockPath}; code=${extractErrorCode(error)}; hint=check lock file permissions`,
          error
        );
      }

      if (await isStaleLock(lockPath)) {
        await safeUnlink(lockPath);
        continue;
      }

      if (Date.now() >= timeoutAt) {
        throw new Error(
          withDiagnosticDetail(
            `Timed out waiting for mandatory backlog lock: ${lockPath}`,
            "hint=remove stale .lock file if no active thred process is writing backlog"
          )
        );
      }

      await sleep(BACKLOG_LOCK_RETRY_MS);
    }
  }

  try {
    return await operation();
  } finally {
    await safeUnlink(lockPath);
  }
}

async function isStaleLock(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs > BACKLOG_STALE_LOCK_MS;
  } catch (error) {
    if (isErrorWithCode(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function atomicWriteFile(targetPath: string, content: string): Promise<void> {
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, targetPath);
  } catch (error) {
    await safeUnlink(tempPath);
    throw wrapReviewReportError(
      "mandatory backlog atomic write failed",
      `targetPath=${targetPath}; tempPath=${tempPath}; code=${extractErrorCode(error)}; hint=check filesystem permissions`,
      error
    );
  }
}

async function safeUnlink(targetPath: string): Promise<void> {
  try {
    await unlink(targetPath);
  } catch (error) {
    if (isErrorWithCode(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function isErrorWithCode(error: unknown): error is { code?: string } {
  return typeof error === "object" && error !== null && "code" in error;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withDiagnosticDetail(summary: string, detail: string): string {
  const normalizedSummary = summary.trim();
  const normalizedDetail = detail.replace(/\s+/g, " ").trim();
  if (!normalizedDetail) {
    return normalizedSummary;
  }
  return `${normalizedSummary}\n${normalizedDetail}`;
}

function wrapReviewReportError(summary: string, detail: string, cause: unknown): Error {
  return new Error(withDiagnosticDetail(summary, detail), {
    cause: cause instanceof Error ? cause : new Error(String(cause))
  });
}

function extractErrorCode(error: unknown): string {
  if (!isErrorWithCode(error) || typeof error.code !== "string" || error.code.trim().length === 0) {
    return "UNKNOWN";
  }
  return error.code;
}
