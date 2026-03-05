import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

import { describe, expect, it } from "vitest";

import { ensureFirstRunSetup, runSetupCommand } from "../src/commands/execute.js";
import { runCommand } from "../src/core/util/process.js";

describe("setup command", () => {
  it("preserves existing settings and review pipeline defaults in create-if-absent mode", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-setup-command-"));
    await mkdir(path.join(cwd, ".thred"), { recursive: true });
    await writeFile(
      path.join(cwd, ".thred", "settings.yaml"),
      YAML.stringify({
        model: "gpt-5",
        reasoningEffort: "low",
        reviewPipeline: {
          version: 1,
          passes: {
            custom: { kind: "scan", severities: ["critical"] }
          }
        }
      }),
      "utf8"
    );
    await writeFile(path.join(cwd, ".gitignore"), "node_modules/\n.thred/\n", "utf8");

    const result = await runSetupCommand(cwd);

    const settings = YAML.parse(await readFile(result.settingsPath, "utf8")) as {
      model: string;
      reasoningEffort: string;
      reviewPipeline?: { version: number; passes: Record<string, unknown> };
    };
    expect(settings).toEqual({
      model: "gpt-5",
      reasoningEffort: "low",
      reviewPipeline: {
        version: 1,
        passes: {
          custom: { kind: "scan", severities: ["critical"] }
        }
      }
    });

    const gitignore = await readFile(path.join(cwd, ".gitignore"), "utf8");
    const lines = gitignore.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    expect(lines).toContain("node_modules/");
    expect(lines).toContain(".thred/");
    expect(lines).not.toContain(".thred/artifacts/");
    expect(lines).not.toContain(".thred/runs/");
  });

  it("is idempotent in non-git workspace and does not create .gitignore", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-setup-command-"));

    await runSetupCommand(cwd);
    await runSetupCommand(cwd);

    await expect(readFile(path.join(cwd, ".gitignore"), "utf8")).rejects.toThrow();

    const settings = YAML.parse(await readFile(path.join(cwd, ".thred", "settings.yaml"), "utf8")) as {
      reviewPipeline?: { passes?: Record<string, unknown> };
    };
    expect(Object.keys(settings.reviewPipeline?.passes ?? {})).not.toHaveLength(0);
  });

  it("setup race: concurrent runSetupCommand keeps user settings and initializes review pipeline once", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-setup-race-command-"));
    await mkdir(path.join(cwd, ".thred"), { recursive: true });
    await writeFile(
      path.join(cwd, ".thred", "settings.yaml"),
      YAML.stringify({
        model: "gpt-5-codex-mini",
        reasoningEffort: "medium"
      }),
      "utf8"
    );

    await Promise.all([
      runSetupCommand(cwd, { noGit: true }),
      runSetupCommand(cwd, { noGit: true }),
      runSetupCommand(cwd, { noGit: true }),
      runSetupCommand(cwd, { noGit: true }),
      runSetupCommand(cwd, { noGit: true })
    ]);

    const settings = YAML.parse(await readFile(path.join(cwd, ".thred", "settings.yaml"), "utf8")) as {
      model: string;
      reasoningEffort: string;
      reviewPipeline?: { version: number; passes: Record<string, unknown> };
    };
    expect(settings.model).toBe("gpt-5-codex-mini");
    expect(settings.reasoningEffort).toBe("medium");
    expect(settings.reviewPipeline?.version).toBe(1);
    expect(Object.keys(settings.reviewPipeline?.passes ?? {})).toHaveLength(3);
  });

  it("updates gitignore runtime rules when run inside git workspace", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-setup-command-"));
    await git(cwd, ["init"]);
    await writeFile(path.join(cwd, ".gitignore"), "node_modules/\n.thred/\n", "utf8");

    await runSetupCommand(cwd);
    await runSetupCommand(cwd);

    const gitignore = await readFile(path.join(cwd, ".gitignore"), "utf8");
    const lines = gitignore.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    expect(lines).toContain("node_modules/");
    expect(lines).toContain(".thred/artifacts/");
    expect(lines).toContain(".thred/runs/");
    expect(lines).not.toContain(".thred/");
    expect(lines.filter((line) => line === ".thred/artifacts/")).toHaveLength(1);
    expect(lines.filter((line) => line === ".thred/runs/")).toHaveLength(1);
  });

  it("runs full setup automatically on first run when .thred is missing", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-first-run-"));

    await ensureFirstRunSetup(cwd);
    const settingsRaw = await readFile(path.join(cwd, ".thred", "settings.yaml"), "utf8");

    const settings = YAML.parse(settingsRaw) as {
      model: string;
      reasoningEffort: string;
      reviewPipeline?: { version: number; passes: Record<string, unknown> };
    };
    expect(settings.model).toBe("inherit");
    expect(settings.reasoningEffort).toBe("high");
    expect(settings.reviewPipeline?.version).toBe(1);
    expect(Object.keys(settings.reviewPipeline?.passes ?? {})).toHaveLength(3);
    const passes = (settings.reviewPipeline?.passes ?? {}) as Record<string, { agents?: string[] }>;
    expect(passes.stabilize?.agents).toEqual(["implementation", "quality", "testing", "simplification"]);
    expect(passes.baseline_scan?.agents).toContain("documentation");
    expect(passes.final_gate?.agents).toContain("documentation");
    expect(settingsRaw).not.toMatch(/[&*]a\d+\b/);
  });

  it("runs implicit first-run setup when .thred exists but settings are missing", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-first-run-existing-dir-"));
    await mkdir(path.join(cwd, ".thred"), { recursive: true });

    await ensureFirstRunSetup(cwd);

    const settings = YAML.parse(await readFile(path.join(cwd, ".thred", "settings.yaml"), "utf8")) as {
      model: string;
      reasoningEffort: string;
      reviewPipeline?: { version: number; passes: Record<string, unknown> };
    };
    expect(settings.model).toBe("inherit");
    expect(settings.reasoningEffort).toBe("high");
    expect(settings.reviewPipeline?.version).toBe(1);
    expect(Object.keys(settings.reviewPipeline?.passes ?? {})).toHaveLength(3);
  });

  it("setup race: concurrent ensureFirstRunSetup creates one valid settings file", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-first-run-race-"));

    await Promise.all([
      ensureFirstRunSetup(cwd, { noGit: true }),
      ensureFirstRunSetup(cwd, { noGit: true }),
      ensureFirstRunSetup(cwd, { noGit: true }),
      ensureFirstRunSetup(cwd, { noGit: true }),
      ensureFirstRunSetup(cwd, { noGit: true })
    ]);

    const settings = YAML.parse(await readFile(path.join(cwd, ".thred", "settings.yaml"), "utf8")) as {
      model: string;
      reasoningEffort: string;
      reviewPipeline?: { version: number; passes: Record<string, unknown> };
    };
    expect(settings.model).toBe("inherit");
    expect(settings.reasoningEffort).toBe("high");
    expect(settings.reviewPipeline?.version).toBe(1);
    expect(Object.keys(settings.reviewPipeline?.passes ?? {})).toHaveLength(3);
    await expect(readFile(path.join(cwd, ".thred", "setup.lock"), "utf8")).rejects.toThrow();
  });

  it("no-ops implicit first-run setup when settings.yaml already exists", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-first-run-existing-settings-"));
    await git(cwd, ["init"]);
    await mkdir(path.join(cwd, ".thred"), { recursive: true });
    const settingsPath = path.join(cwd, ".thred", "settings.yaml");
    const initialSettings = YAML.stringify({
      model: "gpt-5",
      reasoningEffort: "low"
    });
    await writeFile(settingsPath, initialSettings, "utf8");
    await writeFile(path.join(cwd, ".gitignore"), "node_modules/\n", "utf8");

    await ensureFirstRunSetup(cwd);

    expect(await readFile(settingsPath, "utf8")).toBe(initialSettings);
    expect(await readFile(path.join(cwd, ".gitignore"), "utf8")).toBe("node_modules/\n");
  });

  it("no-ops implicit first-run setup when only legacy settings.json exists", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-first-run-legacy-settings-"));
    await git(cwd, ["init"]);
    await mkdir(path.join(cwd, ".thred"), { recursive: true });
    const legacySettingsPath = path.join(cwd, ".thred", "settings.json");
    const initialLegacySettings = JSON.stringify({ model: "gpt-5", reasoningEffort: "low" }, null, 2);
    await writeFile(legacySettingsPath, initialLegacySettings, "utf8");
    await writeFile(path.join(cwd, ".gitignore"), "node_modules/\n", "utf8");

    await ensureFirstRunSetup(cwd);

    expect(await readFile(legacySettingsPath, "utf8")).toBe(initialLegacySettings);
    await expect(readFile(path.join(cwd, ".thred", "settings.yaml"), "utf8")).rejects.toThrow();
    expect(await readFile(path.join(cwd, ".gitignore"), "utf8")).toBe("node_modules/\n");
  });

  it("does not modify .gitignore during implicit first-run setup in --no-git mode", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-first-run-no-git-"));
    await git(cwd, ["init"]);
    await writeFile(path.join(cwd, ".gitignore"), "node_modules/\n", "utf8");

    await ensureFirstRunSetup(cwd, { noGit: true });

    const gitignore = await readFile(path.join(cwd, ".gitignore"), "utf8");
    expect(gitignore).toBe("node_modules/\n");

    const settings = YAML.parse(await readFile(path.join(cwd, ".thred", "settings.yaml"), "utf8")) as {
      model: string;
      reasoningEffort: string;
      reviewPipeline?: { version: number; passes: Record<string, unknown> };
    };
    expect(settings.model).toBe("inherit");
    expect(settings.reasoningEffort).toBe("high");
    expect(settings.reviewPipeline?.version).toBe(1);
    expect(Object.keys(settings.reviewPipeline?.passes ?? {})).toHaveLength(3);
  });
});

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runCommand("git", args, { cwd });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}
