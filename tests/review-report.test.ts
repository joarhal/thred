import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { writeMandatoryStabilityBacklog, writeReviewReport } from "../src/core/review/report.js";

describe("review report", () => {
  it("writes review report artifact to run directory", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "thred-review-report-"));
    const reportPath = await writeReviewReport(runDir, "run-123", {
      generatedAt: "2026-03-03T00:00:00.000Z",
      baseBranch: "main",
      planPath: "/tmp/plan.md",
      gate: "critical+high",
      status: "warnings",
      stopReason: "max_iterations",
      loops: [
        {
          name: "external-loop",
          iterations: 4,
          stopReason: "max_iterations",
          findings: {
            total: 2,
            critical: 0,
            high: 0,
            medium: 1,
            low: 1
          }
        }
      ],
      findings: [
        {
          id: "f1",
          severity: "medium",
          file: "src/app.ts",
          line: 12,
          summary: "Issue summary",
          rationale: "Issue rationale"
        }
      ],
      mandatoryBacklog: []
    });

    expect(path.basename(reportPath)).toBe("run-123.review.json");
    const content = JSON.parse(await readFile(reportPath, "utf8")) as {
      gate: string;
      status: string;
      mandatoryBacklog: Array<{ severity: string }>;
    };
    expect(content.gate).toBe("critical+high");
    expect(content.status).toBe("warnings");
    expect(content.mandatoryBacklog).toHaveLength(1);
    expect(content.mandatoryBacklog[0]?.severity).toBe("medium");
  });

  it("serializes findings and keeps explicitly provided mandatory backlog", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "thred-review-report-serialization-"));
    const reportPath = await writeReviewReport(runDir, "run-124", {
      generatedAt: "2026-03-04T00:00:00.000Z",
      baseBranch: "main",
      planPath: "/tmp/release-plan.md",
      gate: "critical+high",
      status: "failed",
      stopReason: "gate_blocked",
      loops: [],
      findings: [
        {
          id: "f-critical",
          severity: "critical",
          file: "src/security.ts",
          line: 10,
          summary: "Critical finding",
          rationale: "Release blocking issue",
          suggestedFix: "Sanitize command input and add allow-list checks"
        },
        {
          id: "f-medium",
          severity: "medium",
          file: "src/ui.ts",
          line: 42,
          summary: "Medium finding",
          rationale: "Backlog item"
        }
      ],
      mandatoryBacklog: [
        {
          id: "f-explicit-low",
          severity: "low",
          file: "src/log.ts",
          line: 5,
          summary: "Low priority cleanup",
          rationale: "Explicitly tracked by caller"
        }
      ]
    });

    const content = JSON.parse(await readFile(reportPath, "utf8")) as {
      findings: Array<{ id: string; severity: string; suggestedFix?: string }>;
      mandatoryBacklog: Array<{ id: string; severity: string }>;
    };
    expect(content.findings).toHaveLength(2);
    expect(content.findings[0]?.id).toBe("f-critical");
    expect(content.findings[0]?.suggestedFix).toContain("Sanitize command input");
    expect(content.mandatoryBacklog).toHaveLength(1);
    expect(content.mandatoryBacklog[0]).toMatchObject({
      id: "f-explicit-low",
      severity: "low"
    });
  });

  it("writes mandatory medium/low findings into release stability backlog", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-review-backlog-"));
    const result = await writeMandatoryStabilityBacklog(cwd, {
      runId: "run-234",
      findings: [
        {
          id: "f-high",
          severity: "high",
          file: "src/high.ts",
          line: 5,
          summary: "High finding",
          rationale: "blocking"
        },
        {
          id: "f-medium",
          severity: "medium",
          file: "src/medium.ts",
          line: 8,
          summary: "Medium finding",
          rationale: "backlog"
        },
        {
          id: "f-low",
          severity: "low",
          file: "src/low.ts",
          line: 13,
          summary: "Low finding",
          rationale: "backlog"
        }
      ]
    });

    expect(result.count).toBe(2);
    const backlog = await readFile(result.path, "utf8");
    expect(backlog).toContain("Automated Mandatory Backlog");
    expect(backlog).toContain("Generated automatically from mandatory review findings.");
    expect(backlog).toContain("f-medium");
    expect(backlog).toContain("f-low");
    expect(backlog).not.toContain("f-high");
  });

  it("does not rewrite managed backlog when mandatory findings are unchanged", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-review-backlog-stable-"));
    const findings = [
      {
        id: "f-low",
        severity: "low",
        file: "src/low.ts",
        line: 13,
        summary: "Low finding",
        rationale: "backlog"
      },
      {
        id: "f-medium",
        severity: "medium",
        file: "src/medium.ts",
        line: 8,
        summary: "Medium finding",
        rationale: "backlog"
      }
    ] as const;

    const first = await writeMandatoryStabilityBacklog(cwd, {
      runId: "run-400",
      generatedAt: "2026-03-04T12:00:00.000Z",
      findings: [...findings]
    });
    const firstContent = await readFile(first.path, "utf8");

    const second = await writeMandatoryStabilityBacklog(cwd, {
      runId: "run-401",
      generatedAt: "2026-03-04T12:30:00.000Z",
      findings: [...findings].reverse()
    });
    const secondContent = await readFile(second.path, "utf8");

    expect(first.updated).toBe(true);
    expect(second.updated).toBe(false);
    expect(secondContent).toBe(firstContent);
    expect(secondContent).not.toContain("run-400");
    expect(secondContent).not.toContain("run-401");
  });

  it("preserves prior unresolved entries when current run emits a different subset", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-review-backlog-merge-"));
    await writeMandatoryStabilityBacklog(cwd, {
      runId: "run-500",
      findings: [
        {
          id: "f-existing",
          severity: "medium",
          file: "src/existing.ts",
          line: 12,
          summary: "Existing finding",
          rationale: "must persist"
        }
      ]
    });

    await writeMandatoryStabilityBacklog(cwd, {
      runId: "run-501",
      findings: [
        {
          id: "f-current",
          severity: "low",
          file: "src/current.ts",
          line: 14,
          summary: "Current finding",
          rationale: "new run"
        }
      ]
    });

    const backlog = await readFile(path.join(cwd, "docs/release/stability-backlog.md"), "utf8");
    expect(backlog).toContain("f-existing");
    expect(backlog).toContain("f-current");
    expect(backlog).toContain("| open |");
  });

  it("supports explicit resolution state updates", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-review-backlog-resolve-"));
    await writeMandatoryStabilityBacklog(cwd, {
      runId: "run-600",
      findings: [
        {
          id: "f-resolve",
          severity: "medium",
          file: "src/resolve.ts",
          line: 3,
          summary: "Resolvable finding",
          rationale: "can be resolved"
        }
      ]
    });

    const result = await writeMandatoryStabilityBacklog(cwd, {
      runId: "run-601",
      findings: [],
      resolvedFindingIds: ["f-resolve"]
    });

    expect(result.updated).toBe(true);
    expect(result.count).toBe(0);
    const backlog = await readFile(result.path, "utf8");
    expect(backlog).toContain("f-resolve");
    expect(backlog).toContain("| resolved |");
  });

  it("rewrites malformed managed backlog block from current mandatory findings", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-review-backlog-malformed-"));
    const backlogPath = path.join(cwd, "docs/release/stability-backlog.md");
    await mkdir(path.dirname(backlogPath), { recursive: true });
    await writeFile(
      backlogPath,
      [
        "# Stability Backlog",
        "",
        "<!-- thred:auto-medium-low:start -->",
        "## Automated Mandatory Backlog (`medium` / `low`)",
        "",
        "| ID | Severity | File:Line | Summary | Rationale | Status |",
        "| --- | --- | --- | --- | --- | --- |",
        "| broken | medium | no-colon | Missing line format | bad row | open |",
        "<!-- thred:auto-medium-low:end -->"
      ].join("\n"),
      "utf8"
    );

    const result = await writeMandatoryStabilityBacklog(cwd, {
      runId: "run-800",
      findings: [
        {
          id: "f-medium",
          severity: "medium",
          file: "src/fixed.ts",
          line: 9,
          summary: "Recovered from malformed block",
          rationale: "Writer should replace malformed rows with valid current entries"
        }
      ]
    });

    expect(result.updated).toBe(true);
    expect(result.count).toBe(1);
    const backlog = await readFile(result.path, "utf8");
    expect(backlog).toContain("f-medium");
    expect(backlog).toContain("src/fixed.ts:9");
    expect(backlog).not.toContain("| broken | medium | no-colon |");
  });

  it("serializes concurrent managed backlog writes without dropping findings", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-review-backlog-race-"));
    const [a, b] = await Promise.all([
      writeMandatoryStabilityBacklog(cwd, {
        runId: "run-700",
        findings: [
          {
            id: "f-a",
            severity: "medium",
            file: "src/a.ts",
            line: 1,
            summary: "A",
            rationale: "A rationale"
          }
        ]
      }),
      writeMandatoryStabilityBacklog(cwd, {
        runId: "run-701",
        findings: [
          {
            id: "f-b",
            severity: "low",
            file: "src/b.ts",
            line: 2,
            summary: "B",
            rationale: "B rationale"
          }
        ]
      })
    ]);

    const backlog = await readFile(a.path, "utf8");
    expect(backlog).toContain("f-a");
    expect(backlog).toContain("f-b");
    expect(path.normalize(a.path)).toBe(path.normalize(b.path));
  });

  it("preserves managed backlog block when there are no medium/low findings", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-review-backlog-clear-"));
    const initial = await writeMandatoryStabilityBacklog(cwd, {
      runId: "run-300",
      findings: [
        {
          id: "f-medium",
          severity: "medium",
          file: "src/medium.ts",
          line: 3,
          summary: "Medium finding",
          rationale: "backlog"
        }
      ]
    });

    expect(initial.updated).toBe(true);
    const cleared = await writeMandatoryStabilityBacklog(cwd, {
      runId: "run-301",
      findings: [
        {
          id: "f-high",
          severity: "high",
          file: "src/high.ts",
          line: 1,
          summary: "Blocking finding",
          rationale: "blocker"
        }
      ]
    });

    expect(cleared.count).toBe(1);
    expect(cleared.updated).toBe(false);
    const backlog = await readFile(cleared.path, "utf8");
    expect(backlog).toContain("thred:auto-medium-low:start");
    expect(backlog).toContain("f-medium");
    expect(backlog).toContain("# Stability Backlog");
  });
});
