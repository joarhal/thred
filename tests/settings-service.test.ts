import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  loadThredSettings,
  normalizeReasoningEffort,
  saveThredSettings
} from "../src/core/settings/service.js";

describe("settings service", () => {
  it("creates default settings on first load", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-settings-"));
    const snapshot = await loadThredSettings(dir);

    expect(snapshot.created).toBe(true);
    expect(snapshot.settings.model).toBe(DEFAULT_MODEL);
    expect(snapshot.settings.reasoningEffort).toBe(DEFAULT_REASONING_EFFORT);
    expect(snapshot.path.endsWith(path.join(".thred", "settings.yaml"))).toBe(true);
  });

  it("normalizes invalid settings file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-settings-"));
    const settingsPath = path.join(dir, ".thred", "settings.yaml");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, YAML.stringify({ model: "", reasoningEffort: "turbo" }), "utf8");

    const snapshot = await loadThredSettings(dir);
    expect(snapshot.created).toBe(false);
    expect(snapshot.settings.model).toBe(DEFAULT_MODEL);
    expect(snapshot.settings.reasoningEffort).toBe(DEFAULT_REASONING_EFFORT);
  });

  it("migrates legacy .thred/settings.json to .thred/settings.yaml", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-settings-"));
    const legacyPath = path.join(dir, ".thred", "settings.json");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, JSON.stringify({ model: "gpt-5-codex", reasoningEffort: "medium" }), "utf8");

    const snapshot = await loadThredSettings(dir);
    expect(snapshot.settings.model).toBe("gpt-5-codex");
    expect(snapshot.settings.reasoningEffort).toBe("medium");
    expect(snapshot.path.endsWith(path.join(".thred", "settings.yaml"))).toBe(true);
  });

  it("saves explicit model and reasoning", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-settings-"));
    await saveThredSettings(dir, {
      model: "gpt-5-codex-mini",
      reasoningEffort: "medium"
    });

    const snapshot = await loadThredSettings(dir);
    expect(snapshot.settings.model).toBe("gpt-5-codex-mini");
    expect(snapshot.settings.reasoningEffort).toBe("medium");
  });

  it("preserves review pipeline pass order when rewriting settings", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-settings-"));
    const settingsPath = path.join(dir, ".thred", "settings.yaml");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(
      settingsPath,
      YAML.stringify({
        model: "inherit",
        reasoningEffort: "high",
        reviewPipeline: {
          version: 1,
          passes: {
            baseline_all_findings: {
              kind: "scan",
              severities: ["critical", "high", "medium", "low"]
            },
            stabilize_critical_high: {
              kind: "fix_loop",
              severities: ["critical", "high"],
              maxIterations: 3,
              patience: 0
            },
            final_all_findings_verification: {
              kind: "scan",
              severities: ["critical", "high", "medium", "low"]
            }
          }
        }
      }),
      "utf8"
    );

    await loadThredSettings(dir);

    const rewritten = YAML.parse(await readFile(settingsPath, "utf8")) as {
      reviewPipeline?: { passes?: Record<string, unknown> };
    };
    expect(Object.keys(rewritten.reviewPipeline?.passes ?? {})).toEqual([
      "baseline_all_findings",
      "stabilize_critical_high",
      "final_all_findings_verification"
    ]);
  });

  it("keeps fallback reasoning when value is invalid", () => {
    expect(normalizeReasoningEffort("bad", "high")).toBe("high");
    expect(normalizeReasoningEffort("xhigh", "high")).toBe("xhigh");
  });

  it("setup race: concurrent load/save operations keep settings.yaml valid and deterministic", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thred-settings-race-"));
    const settingsPath = path.join(dir, ".thred", "settings.yaml");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(
      settingsPath,
      YAML.stringify({
        model: "inherit",
        reasoningEffort: "high",
        reviewPipeline: {
          version: 1,
          passes: {
            baseline_all_findings: {
              kind: "scan",
              severities: ["critical", "high", "medium", "low"]
            }
          }
        }
      }),
      "utf8"
    );

    await Promise.all([
      loadThredSettings(dir),
      saveThredSettings(dir, { model: "gpt-5-codex-mini", reasoningEffort: "xhigh" }),
      loadThredSettings(dir),
      saveThredSettings(dir, { model: "gpt-5-codex-mini", reasoningEffort: "xhigh" }),
      loadThredSettings(dir)
    ]);

    const rewritten = YAML.parse(await readFile(settingsPath, "utf8")) as {
      model: string;
      reasoningEffort: string;
      reviewPipeline?: { passes?: Record<string, unknown> };
    };
    expect(rewritten.model).toBe("gpt-5-codex-mini");
    expect(rewritten.reasoningEffort).toBe("xhigh");
    expect(Object.keys(rewritten.reviewPipeline?.passes ?? {})).toEqual(["baseline_all_findings"]);
  });
});
